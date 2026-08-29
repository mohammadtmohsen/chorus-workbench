import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The settings-persistence gate — Phase 1 exit item E5, `BOARD.md` C-053.
 *
 * The workbench partition is in-memory, so every preference died with the app. A
 * person who turned `files.autoSave` off got it back on the next launch, and an
 * editor that forgets your settings each time you quit is not a replacement for
 * the one you already use.
 *
 * **`files.autoSave` is the setting under test, and not by accident.** Chorus
 * keeps Code-OSS's own `afterDelay` at 1,000 ms rather than second-guessing it —
 * a decision that only holds if a person who wants it off can turn it off and
 * have it stay off. It is also the default that wrote `CHORUS-ALIVE` into a real
 * `package.json` earlier in this project, so it is the setting where "a user
 * override beats Chorus's own default" actually matters.
 *
 * **The proof is behaviour, never a file.** A `settings.json` on disk containing
 * `"off"` proves the write and says nothing whatsoever about the read: it is
 * equally consistent with a workbench that seeded the file and then ignored it.
 * So every claim here is made by typing into an editor and watching the disk:
 * with auto-save on the bytes change within seconds, with it off they do not and
 * the tab stays dirty. The settings file is read at the end of a phase as
 * *corroboration*, and each record says which of the two it is.
 *
 * **Three phases, and the third is the falsifier.**
 *
 * 1. Profile P, first run — prove auto-save is **on** by default, turn it off
 *    through the command palette, prove it is now off.
 * 2. Profile P, second run — same profile, nothing set: prove it is **still
 *    off**, then turn it back on and watch the same buffered text save. That last
 *    step is what stops "the file did not change" being satisfied by a broken
 *    editor, a dead extension host or a harness typing into nothing.
 * 3. Profile Q, clean — prove a profile that never stored anything still gets
 *    Code-OSS's `afterDelay`. Without it this gate passes if the value were
 *    hardcoded, or if the default had been `off` all along.
 *
 * **"It did not save" is sampled, never read once.** A single read taken before
 * the delay elapsed cannot tell "auto-save is off" from "auto-save has not fired
 * yet", and that is the assertion this whole item turns on.
 *
 * Run: `node e2e/workbench-settings-persistence.mjs` from `apps/desktop`, after a
 * build.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
/** Electron's own binary. Never `npx`, which would make every claim here npm's. */
const ELECTRON = createRequire(import.meta.url)('electron')

class Failure extends Error {}

const results = []
function record(claim, ok, observed) {
  results.push({ claim, ok, observed })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${claim}\n        ${observed}\n`)
}

/** Records, then stops — each phase arms the next, so carrying on buries the cause. */
function must(claim, ok, observed) {
  record(claim, ok, observed)
  if (!ok) throw new Failure(`${claim} — ${observed}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last !== false && last !== null && last !== undefined) return last
    } catch (error) {
      if (error instanceof Failure) throw error
      last = error.message
    }
    await wait(300)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`)
}

function readPort(text) {
  return /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)?.[1] ?? null
}

async function pageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await response.json()).filter((t) => t.type === 'page')
}

async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))
  let id = 0
  const send = (method, params = {}) =>
    new Promise((settle, reject) => {
      const mine = ++id
      const onMessage = (message) => {
        const reply = JSON.parse(message.data)
        if (reply.id !== mine) return
        socket.removeEventListener('message', onMessage)
        if (reply.error !== undefined) reject(new Error(JSON.stringify(reply.error).slice(0, 200)))
        else settle(reply.result)
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id: mine, method, params }))
      setTimeout(() => {
        reject(new Error(`timed out: ${method}`))
      }, 120_000)
    })
  // `Runtime.enable` is never sent: it breaks renderers created after it, and the
  // surface is created by an evaluate on this very connection.
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result?.value
  }
  return { send, evaluate, close: () => socket.close() }
}

function descendants(marker) {
  const listing = execFileSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── driving the workbench ────────────────────────────────────────────────────

/**
 * Raises the **window** and then the view, in that order, and the order is the
 * fix rather than a flourish.
 *
 * A surface is a `WebContentsView` inside a `BrowserWindow`. Bringing the view to
 * the front does nothing for a window that is behind another application, and a
 * document in a window nobody can see reports `visibilityState: 'hidden'` — at
 * which point its timers and input handling stop while `Runtime.evaluate` keeps
 * answering perfectly. That is how phase 2 once failed: quick open offered
 * `nothing`, which reads exactly like a broken remote file search and was in fact
 * a window that had opened behind the terminal.
 */
const focus = async (surface) => {
  await surface.shell?.send('Page.bringToFront').catch(() => undefined)
  await surface.send('Page.bringToFront').catch(() => undefined)
}

async function press(surface, key, { modifiers = 0, commands } = {}) {
  const base = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.vk,
    nativeVirtualKeyCode: key.vk,
    modifiers,
  }
  await surface.send('Input.dispatchKeyEvent', {
    ...base,
    type: 'rawKeyDown',
    ...(commands === undefined ? {} : { commands }),
  })
  await surface.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

const KEY_P = { key: 'p', code: 'KeyP', vk: 80 }
const KEY_A = { key: 'a', code: 'KeyA', vk: 65 }
const KEY_Z = { key: 'z', code: 'KeyZ', vk: 90 }
const KEY_ENTER = { key: 'Enter', code: 'Enter', vk: 13 }
/** ⌘ on macOS, ⌃ everywhere else — the modifier bitmask CDP wants. */
const ACCEL = process.platform === 'darwin' ? 4 : 2

const QUICK_INPUT = `JSON.stringify({
  open: (() => {
    const widget = document.querySelector('.quick-input-widget')
    return widget !== null && getComputedStyle(widget).display !== 'none'
  })(),
  value: document.querySelector('.quick-input-widget .quick-input-box input')?.value ?? null,
  rows: [...document.querySelectorAll('.quick-input-list .monaco-list-row')].slice(0, 12).map(row => ({
    label: row.querySelector('.label-name')?.textContent ?? '',
    description: row.querySelector('.label-description')?.textContent ?? '',
    focused: row.classList.contains('focused'),
  })),
})`

const quickInput = async (surface) => JSON.parse(await surface.evaluate(QUICK_INPUT))

const diagnose = async (surface) =>
  surface
    .evaluate(
      `JSON.stringify({
      visibility: document.visibilityState,
      activeElement: (document.activeElement?.tagName ?? '?') + '.' + (document.activeElement?.className ?? '').split(' ').slice(0, 2).join('.'),
      dialogs: [...document.querySelectorAll('.monaco-dialog-box')].length,
      dialogText: (document.querySelector('.monaco-dialog-box')?.textContent ?? '').slice(0, 200),
      toasts: [...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map(n => n.textContent).join(' // ').slice(0, 240),
      statusbar: (document.querySelector('.statusbar')?.textContent ?? '').slice(0, 120),
    })`
    )
    .catch((error) => `could not be diagnosed: ${error.message}`)

/**
 * Opens the quick input, puts exactly `query` in it, and takes the focused row
 * once it is the one asked for — lifted from the containment gate because the
 * three waits it makes are each replacing something that used to be assumed.
 *
 * `commands: ['selectAll']` rather than a bare ⌘A: a synthesized key event does
 * not run the browser's editing commands unless it names them. And the widget is
 * proved open before anything is typed, because `Input.insertText` goes to
 * whatever has focus — an early one lands in the editor as a silent edit to a
 * real file rather than as an error.
 */
async function pickInQuickInput(surface, query, matches, what) {
  await focus(surface)
  await press(surface, KEY_P, { modifiers: ACCEL })
  await until(
    `${what}: the quick input to open`,
    async () => (await quickInput(surface)).open,
    30_000
  )

  await press(surface, KEY_A, { modifiers: ACCEL, commands: ['selectAll'] })
  await surface.send('Input.insertText', { text: query })
  await until(
    `${what}: "${query}" to be the text in the quick input box`,
    async () => (await quickInput(surface)).value === query,
    30_000
  )

  const state = await until(
    `${what}: the focused row to be the one asked for`,
    async () => {
      const seen = await quickInput(surface)
      const focused = seen.rows.find((row) => row.focused)
      return focused !== undefined && matches(focused) ? seen : false
    },
    90_000
  )
  await press(surface, KEY_ENTER)
  return state
}

/**
 * `dirty` is read from three places, because the first one was believed and was
 * wrong.
 *
 * The containment gate reads the `dirty` class on the active tab, and only ever
 * asserts it is **false** — which it is when the tab element is missing, when the
 * class moved, and when the editor really is clean. Used here to assert the
 * *true* side it reported `false` for an editor holding text that provably was
 * not on disk, so the class alone is not a witness for "there is an unsaved
 * change". The tab's own class list is captured beside two independent signals so
 * a reader can see which of them moved rather than take this comment on trust.
 */
const editorState = async (surface) =>
  JSON.parse(
    await surface.evaluate(`(() => {
      const tab = document.querySelector('.tabs-container .tab.active')
      return JSON.stringify({
        tab: tab?.querySelector('.label-name')?.textContent ?? null,
        dirty: (tab?.className ?? '').includes('dirty'),
        tabClass: tab?.className ?? null,
        /* VS Code puts a filled circle where the close button is while unsaved. */
        dirtyAction: tab?.querySelector('.codicon-circle-filled') !== null,
        /* And a bullet in the window title, which is not a tab-strip concern at all. */
        dirtyTitle: document.title.includes('●'),
        text: [...document.querySelectorAll('.view-line')].map(l => l.textContent).join('\\n'),
      })
    })()`)
  )

async function openFile(surface, relativePath, what) {
  const name = basename(relativePath)
  try {
    await pickInQuickInput(surface, relativePath, (row) => row.label === name, what)
  } catch (error) {
    const seen = await quickInput(surface).catch(() => ({ rows: [] }))
    throw new Failure(
      `${what}: ${error.message} · offered: ${seen.rows.map((r) => `${r.label}${r.focused ? '*' : ''}`).join(',') || 'nothing'} · ${await diagnose(surface)}`
    )
  }
  return until(
    `${what}: ${relativePath} to become the active editor with content`,
    async () => {
      const state = await editorState(surface)
      return state.tab === name && state.text.length > 0 ? state : false
    },
    90_000
  )
}

/**
 * Runs a command from the palette. `>` is quick open's command prefix, so this is
 * the same widget a person uses and not a back door into the command service.
 */
async function runCommand(surface, title, what) {
  const state = await pickInQuickInput(
    surface,
    `>${title}`,
    (row) => row.label.includes(title),
    what
  ).catch(async (error) => {
    const seen = await quickInput(surface).catch(() => ({ rows: [] }))
    throw new Failure(
      `${what}: ${error.message} · offered: ${seen.rows.map((r) => r.label).join(' | ') || 'nothing'}`
    )
  })
  return state.rows.find((row) => row.focused)?.label ?? '?'
}

/**
 * Asks Code-OSS itself whether the open model is a dirty working copy.
 *
 * DOM decorations are implementation details, and the configured window title
 * does not include `${dirty}`. The built-in developer command reads
 * `IWorkingCopyService` directly and prefixes dirty entries with `●`, so its
 * Window output is the boundary that distinguishes a missing dirty model from a
 * dirty model whose decorations are missing.
 */
async function workingCopyLog(surface, what) {
  await runCommand(surface, 'Log Working Copies', what)
  return until(
    `${what}: the working-copy report to appear in the Window output`,
    async () => {
      const output = await surface.evaluate(
        `document.querySelector('.part.panel')?.innerText ?? ''`
      )
      return output.includes('[Working Copies]') ? output : false
    },
    20_000
  )
}

// ── the measurement ──────────────────────────────────────────────────────────

const FIXTURE = 'notes.md'
const AUTO_SAVE_MS = 1_000
/**
 * Eight seconds against a one-second delay, sampled throughout.
 *
 * Generous because what is being timed is the delay plus a write back through
 * the remote extension host, and a bound tight enough to be interesting is a
 * bound that flakes. Sampled because a single read at the end proves only the
 * state at the end: it is the *series* that separates "auto-save is off" from
 * "auto-save had not fired when I looked".
 */
const SETTLE_MS = 8_000

/**
 * Types `marker` into the open editor and watches the file for `SETTLE_MS`.
 *
 * Answers with the whole series — when the marker first appeared on disk, if it
 * ever did, and what the tab's dirty flag was doing — so both the "it saved" and
 * the "it did not" claims are made from the same observation rather than from two
 * different ones written to suit.
 */
async function typeAndWatch(surface, filePath, marker) {
  const before = readFileSync(filePath, 'utf8')
  await focus(surface)
  await surface.send('Input.insertText', { text: marker })

  const accepted = await until(
    'the typed marker to appear in the editor',
    async () => {
      const state = await editorState(surface)
      return state.text.includes(marker) ? state : false
    },
    20_000
  )

  const samples = []
  let sawOnDisk = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < SETTLE_MS) {
    const now = readFileSync(filePath, 'utf8')
    const onDisk = now.includes(marker)
    if (onDisk && sawOnDisk === null) sawOnDisk = Date.now() - startedAt
    samples.push(onDisk ? '1' : '0')
    await wait(400)
  }

  const finalState = await editorState(surface)
  return {
    accepted: accepted.text.includes(marker),
    before,
    sawOnDisk,
    samples: samples.join(''),
    /*
     * **Evidence, not a pass condition.** The claim is "the editor holds text that
     * the file on disk does not", and this gate measures both halves of that
     * directly — the editor's own lines and this process's own read. An unsaved
     * change is what the workbench's dirty indicator is *for*, so it is captured;
     * it is not what the assertion turns on, because a marker painted somewhere
     * other than where this selector looks would then fail a claim about
     * persistence for a reason that is about a CSS class.
     */
    dirty: finalState.dirty,
    dirtyAction: finalState.dirtyAction,
    dirtyTitle: finalState.dirtyTitle,
    tabClass: finalState.tabClass,
    after: readFileSync(filePath, 'utf8'),
  }
}

/** The three dirty signals in one string, for a record a reader can act on. */
const dirtyEvidence = (seen) =>
  `dirty[class=${String(seen.dirty)} action=${String(seen.dirtyAction)} title=${String(seen.dirtyTitle)}]`

// ── one app ──────────────────────────────────────────────────────────────────

/**
 * Launches Chorus on `dataPath`, opens `projectRoot` through the probe's own
 * button, and hands back the surface.
 *
 * Through the probe rather than by calling `openWorkbench` from the shell,
 * because the frame is what reports the surface's bounds — a view with no bounds
 * has no laid-out editor to type into, and this gate types.
 */
async function launch(dataPath, projectRoot, label) {
  const marker = basename(dataPath)
  const env = {
    ...process.env,
    CHORUS_USER_DATA: dataPath,
    // One answer, because one project is opened per launch.
    CHORUS_WORKBENCH_E2E_ROOTS: realpathSync(projectRoot),
    CHORUS_WORKBENCH_CACHE: resolve(APP, '../../.workbench-cache'),
  }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=0'], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d.toString()))
  child.stderr.on('data', (d) => (output += d.toString()))
  process.stdout.write(`\n── ${label} · electron pid ${String(child.pid)} · ${marker}\n`)

  const port = await until('a debugging port', () => readPort(output), 60_000)
  const shellTarget = await until('the shell window', async () => {
    const found = (await pageTargets(port)).find((t) => !t.url.includes('workbench.html'))
    return found ?? false
  })
  const shell = await attach(shellTarget)
  await until(
    'the shell bridge',
    async () => (await shell.evaluate('typeof window.chorus')) === 'object'
  )

  /*
   * ⌃⌥W opens the probe; its own button is what mints the grant and mounts the
   * frame. `event.code`, because with Alt held macOS reports `key` as '∑'.
   *
   * **Dispatched on every poll, not once before the wait.** `window.chorus`
   * existing is the *preload* being ready, which is earlier than React having
   * mounted the probe's `keydown` listener — a single keystroke sent in that
   * window lands on nothing and the wait then times out against a shell that is
   * working perfectly. Observed: two runs passed and the third timed out here.
   * The shortcut toggles, so re-sending has to be paired with the check for the
   * panel being *open* rather than counted.
   */
  await until(
    'the workbench probe',
    async () =>
      shell.evaluate(`(() => {
        if (document.querySelector('.workbench-probe') !== null) return true
        window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, altKey: true, code: 'KeyW', bubbles: true }))
        return document.querySelector('.workbench-probe') !== null
      })()`),
    60_000
  )
  await shell.evaluate(
    `document.querySelector('.workbench-probe-pane .workbench-probe-pane-bar button').click(), true`
  )

  const surfaceTarget = await until(
    'a workbench surface',
    async () => {
      const found = (await pageTargets(port)).find((t) => t.url.includes('workbench.html'))
      return found ?? false
    },
    120_000
  )
  const surface = await attach(surfaceTarget)
  // So `focus` can raise the window this view lives in, not just the view.
  surface.shell = shell
  await until(
    'the workbench to paint',
    async () => surface.evaluate(`document.querySelectorAll('.monaco-workbench .part').length > 0`),
    180_000
  )

  /*
   * **Painted is not visible**, and this gate needs the second one.
   *
   * Everything below drives the workbench with real key events, and a hidden
   * document does not process them — while `Runtime.evaluate` goes on answering,
   * so the failure arrives as an empty quick input rather than as anything
   * naming focus. Asserted here, once, with the window actively raised on every
   * poll: if it cannot be made visible the run says so at the top instead of
   * reporting a broken file search forty seconds later.
   */
  await until(
    'the surface to be visible and not merely painted',
    async () => {
      await focus(surface)
      return (await surface.evaluate('document.visibilityState')) === 'visible'
    },
    60_000
  )
  return { child, shell, surface, port, marker }
}

/** Closes the window, then proves the app and its descendants actually went. */
async function quit(app, label) {
  const before = descendants(app.marker)
  await app.shell.evaluate('setTimeout(() => { window.close() }, 0); true').catch(() => undefined)
  const exited = await until(
    'electron to exit',
    () => (app.child.exitCode !== null || app.child.signalCode !== null ? true : false),
    45_000
  ).catch(() => false)

  const deadline = Date.now() + 15_000
  let survivors = before.filter((pid) => alive(pid))
  while (survivors.length > 0 && Date.now() < deadline) {
    await wait(500)
    survivors = before.filter((pid) => alive(pid))
  }

  must(
    `${label}: the app fully quits and takes its processes with it`,
    exited === true && survivors.length === 0,
    exited === true
      ? `code=${String(app.child.exitCode)} signal=${String(app.child.signalCode)} · ${String(before.length)} descendants, survivors=[${survivors.join(',')}]`
      : 'still running after 45s'
  )
}

function cleanUp(app) {
  app.shell.close()
  app.surface.close()
  app.child.kill('SIGKILL')
}

// ── the phases ───────────────────────────────────────────────────────────────

async function run() {
  const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
  const base = join(tmpdir(), `chorus-settings-${stamp}`)
  const projectRoot = join(base, 'project')
  const profileP = join(base, 'profile-p')
  const profileQ = join(base, 'profile-q')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(profileP, { recursive: true })
  mkdirSync(profileQ, { recursive: true })

  const filePath = join(projectRoot, FIXTURE)
  // A disposable fixture, never the checkout. This gate exists because auto-save
  // is real, and pointing a live editor at the repository is how it once wrote
  // into a tracked `package.json`.
  const baseline = () => {
    writeFileSync(filePath, `# settings fixture ${stamp}\n\n`)
  }

  const settingsFile = (profile) => join(profile, 'workbench', 'user-data', 'User', 'settings.json')

  let app = null
  try {
    // ── Phase 1 · profile P, first run ──────────────────────────────────────
    baseline()
    app = await launch(profileP, projectRoot, 'phase 1 · profile P, first run')
    await openFile(app.surface, FIXTURE, 'phase 1')

    /*
     * The control, and it comes first because everything after it is a
     * transition. It also proves the harness itself: that typing reaches the
     * editor, that the editor reaches the remote extension host, and that this
     * process can see the result on disk.
     */
    const onByDefault = await typeAndWatch(app.surface, filePath, `DEFAULT-${stamp}`)
    must(
      'phase 1: a profile with no stored settings auto-saves — Code-OSS default in force',
      onByDefault.accepted && onByDefault.sawOnDisk !== null,
      `typed=${String(onByDefault.accepted)} onDisk after ${String(onByDefault.sawOnDisk)}ms (delay is ${String(AUTO_SAVE_MS)}ms) · samples ${onByDefault.samples}`
    )

    must(
      'phase 1: the profile still has no stored settings file at this point',
      !existsSync(settingsFile(profileP)),
      `${settingsFile(profileP)} — absent`
    )

    const label = await runCommand(app.surface, 'Toggle Auto Save', 'phase 1')
    process.stdout.write(`        ran command: ${label}\n`)

    const offNow = await typeAndWatch(app.surface, filePath, `OFF-${stamp}`)
    must(
      'phase 1: after the toggle the same editing no longer reaches disk',
      offNow.accepted && offNow.sawOnDisk === null,
      `typed=${String(offNow.accepted)} onDisk=${offNow.sawOnDisk === null ? 'never' : `${String(offNow.sawOnDisk)}ms`} · samples ${offNow.samples} · ${dirtyEvidence(offNow)} · tab=${String(offNow.tabClass)}`
    )

    const workingCopies = await workingCopyLog(app.surface, 'phase 1')
    process.stdout.write(`        working copies:\n${workingCopies}\n`)

    if (process.env.CHORUS_C059_DIAGNOSTIC === '1') {
      await quit(app, 'C-059 diagnostic')
      cleanUp(app)
      app = null
      return
    }

    /*
     * Corroboration, and labelled as such. That the file exists proves the write
     * happened; it is the phases either side of the quit that prove the read.
     */
    const stored = existsSync(settingsFile(profileP))
      ? readFileSync(settingsFile(profileP), 'utf8')
      : null
    record(
      'phase 1: the profile now holds a settings file (corroboration — not the claim)',
      stored !== null && stored.includes('autoSave'),
      stored === null ? 'no file' : stored.replace(/\s+/g, ' ').slice(0, 160)
    )

    /*
     * Reverted before the quit, deliberately. A dirty editor at shutdown is a
     * different question — VS Code's lifecycle may want to ask about it — and this
     * gate is not measuring that. Leaving it dirty would make a hung quit look
     * like a persistence failure.
     */
    /*
     * The buffer is put back with undo, **best effort and asserted on nothing**.
     *
     * It began as `File: Revert File` waited on until the marker left the buffer,
     * and that timed out — the command ran and the text stayed, because this build
     * does not consider the editor dirty at all. All three indicators say so:
     * no `dirty` class on the active tab, no filled-circle close action, no bullet
     * in the window title. Reverting a file the workbench believes is unmodified
     * is a no-op, so the step was measuring the missing indicator rather than the
     * setting.
     *
     * It is kept only to leave the editor tidy before the window closes, and the
     * quit below is asserted on its own terms — if an unsaved change ever did veto
     * shutdown, that record is where it would show up. **The missing dirty
     * indicator is a real finding and it is not E5's**; it is recorded on the
     * board rather than chased here.
     */
    await press(app.surface, KEY_Z, { modifiers: ACCEL, commands: ['undo'] })
    await wait(1_000)
    const afterUndo = await editorState(app.surface)
    process.stdout.write(
      `        undo before quit: marker still in buffer = ${String(afterUndo.text.includes(`OFF-${stamp}`))}\n`
    )

    await quit(app, 'phase 1')
    cleanUp(app)
    app = null

    // ── Phase 2 · profile P, second run ─────────────────────────────────────
    baseline()
    app = await launch(profileP, projectRoot, 'phase 2 · profile P, relaunched')
    await openFile(app.surface, FIXTURE, 'phase 2')

    /*
     * **The claim E5 exists for.** Nothing has been set in this run: if the
     * preference did not survive, this profile is now at `afterDelay` and the
     * marker lands on disk exactly as it did in phase 1's control.
     */
    const survived = await typeAndWatch(app.surface, filePath, `SURVIVED-${stamp}`)
    must(
      'phase 2: the setting survived the quit — the relaunched workbench does not auto-save',
      survived.accepted && survived.sawOnDisk === null,
      `typed=${String(survived.accepted)} onDisk=${survived.sawOnDisk === null ? 'never' : `${String(survived.sawOnDisk)}ms`} · samples ${survived.samples} · ${dirtyEvidence(survived)}`
    )

    /*
     * And the control that makes the claim above mean something. The same
     * buffered text, still unsaved, is written the moment auto-save is turned back
     * on — so "the file did not change" was the setting and not a broken editor,
     * a dead extension host, or a harness typing into nothing.
     */
    await runCommand(app.surface, 'Toggle Auto Save', 'phase 2')
    const savedAfterToggle = await until(
      'the buffered text to reach disk once auto-save is on again',
      () => (readFileSync(filePath, 'utf8').includes(`SURVIVED-${stamp}`) ? true : false),
      20_000
    ).catch((error) => error.message)
    must(
      'phase 2: turning it back on writes the very text that would not save — the editor was live',
      savedAfterToggle === true,
      savedAfterToggle === true
        ? 'the unsaved buffer reached disk within 20s of the toggle'
        : String(savedAfterToggle)
    )

    await quit(app, 'phase 2')
    cleanUp(app)
    app = null

    // ── Phase 3 · profile Q, clean ──────────────────────────────────────────
    baseline()
    app = await launch(profileQ, projectRoot, 'phase 3 · profile Q, clean')
    await openFile(app.surface, FIXTURE, 'phase 3')

    must(
      'phase 3: the clean profile holds no settings file of its own',
      !existsSync(settingsFile(profileQ)),
      `${settingsFile(profileQ)} — absent`
    )

    /*
     * The falsifier. Everything above is also true of a build with `off`
     * hardcoded, or of one where the default was `off` all along. A different
     * profile, on the same machine, at the same moment, must still get Code-OSS's
     * `afterDelay`.
     */
    const cleanDefault = await typeAndWatch(app.surface, filePath, `CLEAN-${stamp}`)
    must(
      'phase 3: a different clean profile still gets the Code-OSS default and auto-saves',
      cleanDefault.accepted && cleanDefault.sawOnDisk !== null,
      `typed=${String(cleanDefault.accepted)} onDisk after ${cleanDefault.sawOnDisk === null ? 'never' : `${String(cleanDefault.sawOnDisk)}ms`} · samples ${cleanDefault.samples}`
    )

    must(
      'phase 3: profile P is untouched by profile Q, and still says off',
      existsSync(settingsFile(profileP)) &&
        readFileSync(settingsFile(profileP), 'utf8').includes('off'),
      existsSync(settingsFile(profileP))
        ? readFileSync(settingsFile(profileP), 'utf8').replace(/\s+/g, ' ').slice(0, 160)
        : 'profile P lost its settings file'
    )

    await quit(app, 'phase 3')
    cleanUp(app)
    app = null
  } finally {
    if (app !== null) cleanUp(app)
    await wait(500)
    for (const profile of [profileP, profileQ]) {
      for (const pid of descendants(basename(profile)).filter((p) => alive(p))) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

async function main() {
  let stopped = null
  try {
    await run()
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    stopped = error.message
  }

  const failed = results.filter((r) => !r.ok)
  process.stdout.write(
    `\n${String(results.length - failed.length)}/${String(results.length)} claims held.\n`
  )
  if (stopped !== null) process.stdout.write(`stopped at: ${stopped}\n`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(
    `\nthe settings-persistence gate could not complete: ${error.stack ?? error.message}\n`
  )
  process.exitCode = 1
})
