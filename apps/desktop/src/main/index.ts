import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session } from 'electron'
import { IdeBridge } from './ide-bridge.js'
import {
  attachIdeBridge,
  forwardEventsToRenderer,
  forwardIdeContextToRenderer,
  forwardContextUsageToRenderer,
  forwardTasksToRenderer,
  forwardActivityToRenderer,
  forwardDiagnosticsToRenderer,
  forwardTerminalToRenderer,
  forwardLimitsToRenderer,
  forwardWorkbenchContextToRenderer,
  registerIpcHandlers,
} from './ipc.js'
import { createLogger } from './logging.js'
import { createQuitGate } from './quit-gate.js'
import { installMenu } from './menu.js'
import { readSettings } from './settings.js'
import { applyTheme } from './theme.js'
import { applyScale, currentScale } from './scale.js'
import { reapOrphanedAgents } from './reap.js'
import { ChorusRuntime } from './runtime.js'
import { applyContentSecurityPolicy, lockDownNavigation } from './security.js'
import { reapedOrphanedServers, stopWorkbenchHost } from './workbench-host.js'
import { closeAllSurfaces, registerWorkbenchHandlers } from './workbench-surface.js'
import { adoptShellPath } from './which.js'

const devServerUrl = process.env['ELECTRON_RENDERER_URL']

/** The shell's one document, named once so the load and the allowlist agree. */
const SHELL_ENTRY_FILE = join(__dirname, '../renderer/index.html')

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_280,
    height: 860,
    /*
     * Down to phone width: the layout reflows there, and the old floor of 940 —
     * tablet width — was stopping a window that renders perfectly well at 360.
     *
     * 360 rather than 380 because 375 is an iPhone and 360 an Android, and a
     * minimum that lands between the two common phone widths excludes both.
     */
    minWidth: 360,
    minHeight: 420,
    show: false,
    /*
     * macOS only, and the guard is load-bearing rather than tidy.
     *
     * `hiddenInset` hides the frame and draws the traffic lights over the top
     * of the page, which is why `.masthead` is exactly 31px tall and carries
     * 88px of left padding — that inset is the traffic lights' room, and the
     * masthead is the window's drag region because there is no title bar to
     * drag. On Windows Electron falls back to a standard frame, so unguarded
     * the user got the OS title bar *plus* the 31px masthead *plus* 88px of
     * empty space where no traffic lights are.
     *
     * A custom Windows frame is deliberately not hidden inside this change: it
     * would also need accessible minimize, maximize, restore and close
     * controls, and that is a feature rather than a platform guard.
     */
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Non-negotiable (plan §4.4). Relaxing any of these turns an injection in
      // agent output into remote code execution.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  /*
   * One value decides both what loads and what is allowed to load.
   *
   * The allowlist is exact rather than a `file://` prefix, so it has to name the
   * shell's entry document precisely — and deriving it from the same constant the
   * load below uses is what stops the two drifting into a window that navigates
   * nowhere, or one that navigates anywhere.
   */
  const entry = devServerUrl ?? pathToFileURL(SHELL_ENTRY_FILE).href
  lockDownNavigation(window.webContents, [entry])

  // Avoids a white flash before the renderer has painted.
  window.once('ready-to-show', () => {
    window.show()
  })

  /*
   * Reapplied per navigation, not once per window: Electron resets the factor on
   * every load, so a reload mid-session would silently drop back to 100% while
   * the app still believed it was zoomed.
   */
  window.webContents.on('did-finish-load', () => {
    applyScale(currentScale())
  })

  if (devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(SHELL_ENTRY_FILE)
  }

  return window
}

let runtime: ChorusRuntime | null = null
let ideBridge: IdeBridge | null = null
/**
 * Held at module scope so shutdown can say what it failed to stop.
 *
 * `before-quit` runs outside `whenReady`'s closure, so without this the workbench
 * host's shutdown result — specifically the pids of any process group that
 * outlived `SIGKILL` — had nowhere to go, and a function that reports survivors to
 * nobody is a function that may as well claim success.
 */
let mainLog: ReturnType<typeof createLogger> | null = null

void app.whenReady().then(async () => {
  applyContentSecurityPolicy(session.defaultSession, devServerUrl !== undefined)

  // Before anything is spawned: launched from Finder we get `/usr/bin:/bin:…`,
  // and the agent CLIs are not there — nor, for a shebang script, is the `node`
  // that runs one. Awaited, so no session can start on the bare PATH.
  await adoptShellPath()

  /*
   * Backstop for agents orphaned by a previous crash.
   *
   * Measured: stdio-connected children already exit when Electron dies, so this
   * normally finds nothing. It stays because that cleanup is incidental rather
   * than guaranteed — see reap.ts.
   */
  const log = createLogger(app.getPath('userData'))
  mainLog = log
  log.info('starting', { version: app.getVersion(), electron: process.versions.electron })

  void reapOrphanedAgents().then(({ killed, inspected, skipped }) => {
    // Said once at startup rather than never: the backstop being unavailable is
    // a fact about this platform, and a silent `killed: 0` reads as a clean
    // machine. See `reap.ts` for why Windows has no strategy yet.
    if (skipped) log.info('orphan backstop unavailable on this platform')
    else if (killed > 0) log.warn('reaped orphaned agents', { killed, inspected })
  })

  /*
   * And the same backstop for the workbench server, which needs it more than the
   * agents do.
   *
   * An agent is a stdio-connected child that dies when its pipes close; the remote
   * extension host is spawned **detached**, so that shutdown can signal its whole
   * process group, and that same property is what lets it survive a `SIGKILL` or a
   * power cut with no handler to catch either. Every ordered exit now stops it —
   * this is for the disordered ones.
   *
   * Identified by this profile's own `--server-data-dir` and by having been
   * reparented to init, never by executable name: see the function's own note for
   * why that distinction is the whole safety argument.
   *
   * **Started here and awaited in `start`.** This call is only to get it going
   * early; it is not what makes it safe. Opening a project is a renderer request
   * that can arrive in the same tick this window finishes loading, so the
   * guarantee has to live where the server is spawned — `start` awaits the same
   * memoised promise, and a `void` here would otherwise let a new host come up
   * beside an orphan that still owns this profile's data directory and token.
   */
  void reapedOrphanedServers()
    .then(({ killed, inspected, survivors, skipped }) => {
      if (skipped === 'unsupported-platform') {
        log.info('workbench server backstop unavailable on this platform')
      } else if (skipped === 'sweep-failed') {
        // Distinct from the line above on purpose: this one means projects will be
        // refused until the app is restarted, which is a thing a person can act on.
        log.error('the workbench server backstop could not read the process table')
      } else if (killed > 0) {
        log.warn('reaped orphaned workbench servers', { killed, inspected })
      }
      /*
       * Survivors are the interesting line, not the kills. A server carrying this
       * profile's data directory that is still alive after the sweep is why the
       * next project open will be refused, and without this the person sees only
       * the refusal — at the point they tried to open something, with no record of
       * what was found at boot.
       */
      if (survivors.length > 0) {
        log.warn('a workbench server from an earlier session is still running', {
          survivors,
          inspected,
        })
      }
    })
    .catch((error: unknown) => {
      /*
       * A sweep that threw is logged and **left rejected**, which is the
       * fail-closed half. `start` awaits this same memoised promise, so the
       * rejection reaches the project open as a refusal rather than being
       * swallowed here into an app that spawns a server having never checked. An
       * unhandled rejection would also be a main-process crash on some Electron
       * configurations — this catch exists so the promise has a handler, not so
       * the failure has no consequence.
       */
      log.error('the workbench server backstop failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })

  // A local binding as well as the module one: the workbench resolver below is a
  // closure, and the module `runtime` is nullable for the whole life of the app,
  // so narrowing it here would not survive into the callback.
  const opened = ChorusRuntime.open(app.getPath('userData'), log)
  runtime = opened
  registerIpcHandlers(runtime)
  /*
   * Separate from `registerIpcHandlers` because these handlers need `event`.
   * Registered even though no surface exists yet: opening one is a renderer
   * request, and a channel that is not registered fails at `invoke` with a
   * message about the channel rather than about the workbench.
   */
  registerWorkbenchHandlers(devServerUrl, (projectId) => opened.projects.resolveRoot(projectId))
  /*
   * Phase 6 slice 6c. Beside the other forwarders and taking no bridge: the
   * embedded workbench reports through main's own surface channel, so unlike
   * `forwardIdeContextToRenderer` there is no external process to be attached
   * first — this works whether or not VS Code is installed.
   */
  forwardWorkbenchContextToRenderer(runtime)
  forwardLimitsToRenderer(runtime)
  forwardContextUsageToRenderer(runtime)
  forwardTasksToRenderer(runtime)
  forwardActivityToRenderer(runtime)
  forwardTerminalToRenderer(runtime)
  // Takes no runtime: the watches are keyed by the conversations that ask for
  // one, not by what the runtime happens to have open.
  // Owns ⌘+ / ⌘− / ⌘0; a menu accelerator is handled before the page sees it.
  installMenu()
  forwardEventsToRenderer(runtime)

  /*
   * The VS Code bridge. Chorus listens and the extension dials in, so this has
   * to be up before any window connects — but a failure here must not stop the
   * app: editor context is additive, and Chorus without it is exactly the app
   * it was before.
   */
  const started = runtime
  try {
    const bridge = await IdeBridge.start({
      runtimeDir: tmpdir(),
      pid: process.pid,
      chorusVersion: app.getVersion(),
      log,
    })
    ideBridge = bridge
    attachIdeBridge(bridge)
    forwardIdeContextToRenderer(started, bridge)
    forwardDiagnosticsToRenderer(started, bridge)
    const syncRoots = (): void => {
      bridge.setRoots(started.openConversations().map((c) => c.cwd))
    }
    syncRoots()
    // Resynced from the event stream rather than from each call site, so a
    // conversation that starts, closes, restarts or moves cannot be the one
    // that was forgotten. `setRoots` ignores an unchanged set.
    started.subscribe(syncRoots)
  } catch (error) {
    log.error('ide bridge failed to start', error)
  }

  /*
   * Before the window, not after — otherwise the app paints in the OS
   * appearance and snaps to the chosen one, a flash on every launch for anyone
   * whose choice differs from their system.
   */
  applyTheme(readSettings(app.getPath('userData')).theme)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/*
 * A different data directory, when asked for — and for a dev build, always.
 *
 * The end-to-end tests drive the real app, and a real app writes real files —
 * the log, the database, what was open last time. Without this they would read
 * and overwrite whatever the person running them had open, which is both a
 * broken test and a rude one. Set before anything reads a path, because Electron
 * caches them.
 */
const overrideUserData = process.env['CHORUS_USER_DATA']

/*
 * And a dev build never shares a directory with an installed one.
 *
 * Until this line, `pnpm dev` and `/Applications/Chorus.app` both resolved
 * `userData` from the package name and so opened the *same* `chorus.db`. That
 * is fine exactly as long as the two builds agree on the schema, and the whole
 * point of a dev build is that it does not: a branch adding `repo.changed.byUser`
 * to `ChorusEventPayload` wrote twelve of them into the shared log, and the
 * installed 0.19.7 — which has never heard of that type — then failed to
 * discriminate the union on read and put a raw Zod issue array in the
 * transcript where the conversation should be.
 *
 * Read-back is fail-hard by design (`toStoredEvent` parses every row against
 * the current union), so this is not a cosmetic collision: one unrecognised
 * event takes down the read that contains it. And the log is append-only, so
 * the damage is permanent for the older build — there is no cleanup, only
 * prevention, which is why the fix is a separate directory rather than a
 * tolerant parser.
 *
 * `isPackaged` rather than a flag in the dev script, so it cannot be forgotten
 * by anyone running electron-vite directly. An explicit `CHORUS_USER_DATA`
 * still wins, because e2e is unpackaged too and already passes its own path.
 */
const devUserData = app.isPackaged ? null : `${app.getPath('userData')}-dev`

const dataDir =
  overrideUserData !== undefined && overrideUserData !== '' ? overrideUserData : devUserData

if (dataDir !== null) {
  // Electron creates `userData` lazily, but the logger and the store both write
  // into it before anything else does; e2e only ever passed an existing mkdtemp
  // path, so the create-it case was never exercised.
  mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
  /*
   * And the session directory with it, which is a separate path and was not.
   *
   * `sessionData` is where Chromium keeps its HTTP cache, and it stopped
   * defaulting to `userData` in Electron 20. So overriding `userData` alone gave
   * every e2e launch a private database and a *shared* cache — and a shared
   * cache of `file://` documents means a run can be served the `index.html` a
   * previous run loaded, pointing at a hashed bundle that no longer exists.
   *
   * Measured, not inferred, and it defeated a mutation test before it was found:
   * `readTheme` was deliberately broken, the break was confirmed present in
   * `out/renderer/assets/index-WAOOPaQa.js`, the spec passed anyway, and the page
   * asked for its own script URL answered `index-DaglO1ZH.js` — the previous
   * build, already deleted from disk.
   *
   * This is C-014 one layer down. That entry guards `out/` being stale relative
   * to `src/`; nothing guarded the renderer being stale relative to `out/`, and
   * the failure mode is the one C-014 calls the worst possible outcome — a spec
   * reporting on code that is not under review.
   *
   * What the evidence covers: three full-suite runs, two with this line and one
   * with it reverted, produced the same eight failures in the same order — so
   * **no observed regression from this change**, which is a narrower claim than
   * safe. The suite is red either way, for reasons belonging to the control-rail
   * redesign; the matrix and the per-failure triage are in that plan's STATUS §10.
   */
  app.setPath('sessionData', dataDir)
}

app.on('window-all-closed', () => {
  // Chorus supervises agent child processes; on macOS the app staying resident
  // with no window would leave them running invisibly.
  app.quit()
})

/**
 * The shutdown itself. The *decision* about when a quit may proceed lives in
 * `quit-gate.ts`, because that decision was wrong in a way reading it did not
 * reveal and `index.ts` cannot be unit tested.
 */
async function shutDownEverything(): Promise<void> {
  const closing = runtime
  const bridge = ideBridge
  runtime = null
  ideBridge = null
  // Synchronous and first: a watch holds no resource worth draining, and one
  // still firing during shutdown would push at windows that are going away.
  // Same reasoning one level out: a surface left attached to a window that is
  // going away is a `WebContents` nothing will ever close.
  closeAllSurfaces()
  /*
   * And one level out again — `stopAll()` from preflight §5.4, the only
   * unconditional kill in the workbench's lifecycle. Closing the last project
   * deliberately does *not* stop the server, so without this a remote extension
   * host outlives the app holding a port, a project root and a lock on its own
   * extensions directory.
   *
   * **Started here and awaited below**, which is the shape the first version got
   * wrong in both directions. It was synchronous, so it returned before the server
   * had gone and the app exited out from under a process that was still alive —
   * measured, twice. Simply awaiting it here instead would be the other mistake:
   * the signal would not go out until the database had finished closing.
   * Signalling first and collecting the result last gives the tree the whole of
   * the rest of shutdown to die in, which is usually longer than it needs. It is
   * also what makes a shutdown cut short by a forced quit (C-055) still have asked
   * the server to go before it was interrupted.
   *
   * Called even when there is no runtime — a quit before `whenReady` finished has
   * nothing to close but may still have a host starting, and `stopWorkbenchHost`
   * is the thing that cancels it.
   */
  const workbenchStopped = stopWorkbenchHost()

  /*
   * Every step is allowed to fail and **none of them silently**.
   *
   * These were four bare `.catch(() => undefined)`s, which is how a shutdown that
   * went wrong let Chorus exit with nothing written down anywhere: no survivor
   * result, no log line, no trace. That is not a check that could not fail — it is
   * a failure that could not be *seen*, and it was sitting inside the machinery
   * built to expose exactly this class of lifecycle bug.
   *
   * Each failure is caught **here**, where there is enough context to say which
   * step it was, and the step then resolves. That is also what makes the quit
   * gate's own reporting fire exactly once: anything handled here never reaches
   * it, and anything that escapes here reaches it and nothing else. The two paths
   * are disjoint by construction rather than by being careful.
   */
  const step = async (work: Promise<unknown> | undefined, what: string): Promise<void> => {
    try {
      await work
    } catch (error) {
      mainLog?.error(what, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // The bridge closes first: it unlinks its socket and descriptor, and anything
  // waiting on a snapshot is settled rather than left hanging behind the
  // runtime's own shutdown.
  await step(Promise.resolve(bridge?.close()), 'the ide bridge did not close cleanly')
  await step(Promise.resolve(closing?.close()), 'the event store did not close cleanly')

  const result = await workbenchStopped.catch((error: unknown) => {
    /*
     * Logged **before** the `null`, which is the whole of this correction. The
     * `null` is how the caller below knows there is no survivor list to report;
     * without this line it was also how a failed workbench shutdown became
     * indistinguishable from a clean one that had nothing to say.
     */
    mainLog?.error('the workbench server shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  })
  // Said out loud, because "the server did not stop" is the one shutdown outcome
  // a person can act on — and the one the previous design could not express.
  if (result !== null && result.survivors.length > 0) {
    mainLog?.warn('workbench server survived shutdown', { survivors: result.survivors })
  }
}

const quitGate = createQuitGate(
  shutDownEverything,
  () => {
    app.quit()
  },
  (error: unknown) => {
    /*
     * Only reached by something `shutDownEverything` did not handle itself, since
     * every step in there catches and resolves. So this is the unexpected-throw
     * arm rather than a second chance at the same failure — which is what keeps a
     * cleanup failure reported once rather than twice.
     */
    mainLog?.error('shutdown threw before it could finish', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
)

// Close sessions and the database before exit, so agent child processes are not
// orphaned and WAL is checkpointed cleanly.
app.on('before-quit', (event) => {
  quitGate.onBeforeQuit(event)
})

/*
 * `SIGTERM` and `SIGINT` join the **same** shutdown rather than getting their own.
 *
 * Electron's default handling of both is to terminate, so `before-quit` never ran
 * and none of the work above happened: no watch teardown, no surface teardown, no
 * database close, and — the one that was measured — no workbench-server shutdown,
 * leaving a 257 MB Node process holding a port after a `code=0` exit. A CI harness
 * that stops the app with `SIGTERM`, a shell `⌃C`, and `⌘Q` are three ways of
 * asking for the same thing, and answering them differently is how one of them
 * ends up being the path nobody tested.
 *
 * `app.quit()` rather than a bespoke sequence, so there is exactly one shutdown to
 * get right. It goes through `before-quit`, whose re-entrancy `quit-gate.ts` owns,
 * and `stopWorkbenchHost` is memoised for the same reason: two signals in quick
 * succession must not start two shutdowns.
 *
 * **What this does not cover, and it was measured rather than assumed.** One
 * signal shuts down cleanly. A *second* one arriving mid-cleanup was observed to
 * end the process with `signal=SIGTERM`, and nothing here prevented it. That is a
 * forced-quit boundary rather than a second graceful request, and its recovery is
 * the next launch's reaper — `BOARD.md` C-055.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.quit()
  })
}
