import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  session,
  type OpenDialogOptions,
  type Session,
  type WebContents,
} from 'electron'
import {
  WORKBENCH_CONNECTION_CHANNEL,
  WORKBENCH_SHELL_CHANNELS,
  WORKBENCH_SHELL_CONTRACT,
  WORKBENCH_USER_SETTINGS_READ_CHANNEL,
  WORKBENCH_USER_SETTINGS_WRITE_CHANNEL,
  type WorkbenchConnection,
  type WorkbenchRect,
  type WorkbenchShellResponse,
  type WorkbenchTarget,
} from '../shared/workbench-ipc.js'
import { applyWorkbenchContentSecurityPolicy, lockDownNavigation } from './security.js'
import {
  acquireWorkbenchRuntime,
  releaseWorkbenchRuntime,
  type WorkbenchRuntime,
} from './workbench-host.js'
import {
  readWorkbenchUserSettings,
  writeWorkbenchUserSettings,
} from './workbench-user-settings.js'

/**
 * The isolated workbench surfaces of preflight §4.1a.
 *
 * The shape is forced rather than chosen. A workbench has to be told things the
 * shell must never hold, and main can only address a context individually if it
 * *owns* that context — which an `<iframe>` the shell created is not. Two
 * independent defects killed the frame proposal: `frame-ancestors 'self'` and
 * "separate origin" cannot both be true, and delivering a secret to a subframe
 * needs `nodeIntegrationInSubFrames`, which is documented as loading *all* your
 * preloads into *every* iframe — extension webviews included. So the shell stops
 * being the workbench's parent and becomes a requester of a surface, holding an
 * opaque view id whose every operation main validates.
 *
 * The cost is real and accepted: nothing about this view is in the shell's DOM,
 * so layout is a two-process problem and bounds lag the shell's own reflow.
 */

/**
 * One partition for every workbench view, not one each.
 *
 * A partition is named by a string, so all surfaces naming this share one session
 * object: one `webRequest` filter, one CSP, one pair of permission handlers,
 * installed once and provably applied to every view. Per-view partitions would
 * multiply every control by the number of open projects and turn "is this one
 * configured?" into a runtime question — the dead-control failure again, once per
 * project. The isolation Chorus needs is between the workbench and the shell,
 * which one shared workbench partition gives; isolation *between* surfaces comes
 * from each being its own top-level `WebContents` in its own process.
 *
 * No `persist:` prefix, so the session is in-memory. The workbench's durable
 * state belongs to Chorus, not to a Chromium profile, and an in-memory session is
 * one fewer place for a connection cookie to survive a quit. Whether a
 * REH-backed workbench tolerates this is untested — it is unverified here because
 * this slice has no server to set a cookie.
 */
export const WORKBENCH_PARTITION = 'chorus-workbench'

interface Surface {
  readonly id: string
  /** Canonical, and never the string the renderer proposed. See `approveProjectRoot`. */
  readonly projectRoot: string
  /**
   * The shared server's authority, token, commit and quality — the one thing in
   * this process that crosses into a renderer, and it goes to this surface only.
   */
  readonly runtime: WorkbenchRuntime
  readonly view: WebContentsView
  /**
   * The shell `WebContents` that asked for this surface, and the only one that
   * may move or close it.
   *
   * A view id is opaque but it is not a secret — it crosses the IPC boundary,
   * lands in the shell's React state and would land in a log line the first time
   * anyone debugs the layout. Authorising on the id alone therefore authorises
   * on a value the design already assumes can leak, which is the shape of the
   * bug §4.1b rule 4 names for the *pull* channel and which the shell-facing
   * channels had left open: any window could resize or destroy another window's
   * workbench by naming it. The owner is taken from `event.sender` and never
   * from the request, because a request argument is a claim rather than a fact.
   */
  readonly owner: WebContents
}

const byId = new Map<string, Surface>()
/**
 * Keyed by the `WebContents` itself, which is what makes §4.1b rule 4 cheap.
 * `IpcMainEvent.senderFrame` may be null once a frame has navigated or been
 * destroyed, so validation keys on the sender's `WebContents` — the object the
 * map already uses — and treats an unknown sender as a refusal, never as a
 * default.
 */
const byContents = new Map<WebContents, Surface>()
/**
 * Every shell whose lifecycle is being watched, with the surfaces it owns.
 *
 * A surface is destroyed today by the renderer's own unmount — which is exactly
 * the path a reload does not take. `location.reload()`, a dev-server full
 * reload or a crash-recovery load replaces the document without running a single
 * React cleanup, so the ids the shell was holding are gone while the
 * `WebContentsView`s they named are still parented, still painting, and now
 * unreachable by anything but a quit. Main owns these views, so main has to be
 * the one that notices.
 */
const byOwner = new Map<WebContents, Set<string>>()

/**
 * Every capability main has minted, and it is the whole of what `workbench:open`
 * will accept.
 *
 * Keyed by an unguessable id, valued by the canonical root **and the owner**. A
 * grant is not consumed on redemption: `StrictMode` mounts, unmounts and mounts
 * again, the probe reopens a pane it closed, and a single-use token would make
 * both of those a second trip through the chooser for an authorisation the person
 * already gave. What bounds it instead is the owner's document — `releaseOwner`
 * drops these alongside the surfaces, so a grant cannot outlive the window that
 * asked for it, and a reload starts from nothing.
 */
interface ProjectGrant {
  readonly projectRoot: string
  readonly owner: WebContents
}
const grants = new Map<string, ProjectGrant>()

let configuredSession: Session | null = null

/**
 * The workbench session, with its controls installed before anything loads into
 * it.
 *
 * A `WebContentsView` gets no session automatically: absent both `session` and
 * `partition` in its `webPreferences` it uses the default one, and that would be
 * a silent security regression rather than a missed opportunity — the shell's
 * `default-src 'none'` is exactly what a workbench cannot run under, which is how
 * a relax-the-shell change gets proposed. The symmetric mistake is this one
 * uninstalled: a new partition inherits no CSP and no permission handler at all.
 */
export function workbenchSession(isDev: boolean, remoteAuthority: string | null): Session {
  if (configuredSession !== null) return configuredSession
  const created = session.fromPartition(WORKBENCH_PARTITION)
  /*
   * Built once, with the real authority already in it — which is why the session
   * is created on the first *open* rather than at boot. The port is ephemeral and
   * only exists once the child has reported it, so a session built earlier could
   * only have carried a wildcard. One shared server means one authority for the
   * app's whole life, so "once" is not a limitation here.
   */
  applyWorkbenchContentSecurityPolicy(created, isDev, remoteAuthority)
  configuredSession = created
  return created
}

/**
 * The workbench's entry document, as one value: what to load, and the exact URL
 * the navigation lock will admit.
 *
 * Two expressions of one address is how an allowlist quietly stops matching the
 * thing it is supposed to admit, so `href` is derived from `file` rather than
 * written beside it. `loadFile` produces exactly `pathToFileURL(file).href`,
 * which is why the pair is safe to derive rather than assert.
 */
interface WorkbenchEntry {
  readonly href: string
  readonly file: string | null
}

function workbenchEntry(devServerUrl: string | undefined): WorkbenchEntry {
  if (devServerUrl === undefined) {
    const file = join(__dirname, '../renderer/workbench.html')
    return { href: pathToFileURL(file).href, file }
  }
  return { href: `${devServerUrl}/workbench.html`, file: null }
}

/**
 * What the person picked, canonicalised — and this is now the *only* place a
 * string becomes a project root.
 *
 * It used to be handed the renderer's own string, which is where the defect
 * lived: canonicalisation makes a path well-formed, not permitted, so "absolute,
 * exists, is a directory" admitted every directory on the disk to anything that
 * could reach the channel. The caller here is main's own chooser, so the question
 * this answers is no longer "may the renderer open this?" but "which tree did the
 * person actually pick?" — and that still has to be settled, because in step 2
 * the answer becomes the REH's `--folder`, i.e. the root a server process is
 * pointed at:
 *
 *  - **Absolute.** A relative path is resolved against *main's* current working
 *    directory, which is whatever launched the app — Finder gives `/`. The root
 *    would then be a directory nobody named.
 *  - **Canonical.** `realpathSync` resolves every symlink, every `..` and the
 *    trailing slash. Without it a symlink is a second name for a tree, so the
 *    same project can be opened twice under two spellings — and a later
 *    per-project refcount, cache key or storage path keyed on the string would
 *    count them as two, which is the shared-REH lease of §5.4 pointed at the
 *    wrong number.
 *  - **A directory that exists.** `realpathSync` already refuses a path that
 *    does not, and the `stat` refuses a file. A surface rooted at a file would
 *    fail later, further in, in the workbench's own startup.
 *
 * What bounds *which* directories are openable is not here and cannot be: it is
 * the chooser above it, one dialog per root, and the grant that dialog mints. A
 * further product rule — a durable set of projects the person has adopted — is
 * ProjectService's, which is why the second arm of `WorkbenchTarget` exists.
 */
export function approveProjectRoot(proposed: string): string {
  if (!isAbsolute(proposed)) {
    throw new Error(`A workbench project root must be an absolute path: ${proposed}`)
  }

  let canonical: string
  try {
    canonical = realpathSync(proposed)
  } catch {
    // Deliberately not the OS error: it distinguishes "no such directory" from
    // "no permission to look", which answers a question the renderer did not
    // earn the right to ask.
    throw new Error(`No such workbench project root: ${proposed}`)
  }

  if (!statSync(canonical).isDirectory()) {
    throw new Error(`A workbench project root must be a directory: ${proposed}`)
  }
  return canonical
}

/**
 * The containment gate's substitute for a hand on the mouse, and it substitutes
 * for exactly that and nothing else.
 *
 * A native dialog is drawn by the OS, so CDP cannot click it: driving the gate
 * through the chooser is not "hard", it is unreachable. The alternative shapes
 * are worse — a test-only IPC channel that takes a path is the defect back under
 * another name, and an unauthenticated debug mint is that with a nicer comment.
 * What this reads instead is the **process environment**, which no renderer can
 * write and no compromised surface can influence. So it replaces the person's
 * click, never main's decision: the roots still go through `approveProjectRoot`,
 * still become grants bound to one `WebContents`, and a forged path on
 * `workbench:open` is refused on precisely the same path it would be in a
 * shipped app. Off entirely when packaged, because the argument above is about
 * a harness and none of it applies to a user's machine.
 */
/**
 * Whether this process is the containment gate's isolated profile rather than
 * somebody's Chorus — and **both** halves have to be true.
 *
 * `app.isPackaged` is the one a packaged build cannot lie about: the environment
 * belongs to whoever launched the app, so a user tricked into exporting
 * `CHORUS_WORKBENCH_E2E_ROOTS` would otherwise be a user whose workbench silently
 * stopped asking about trust. The environment variable is the one a *developer's*
 * ordinary `pnpm dev` cannot trip over, since nothing sets it but the gate. Either
 * alone is a hole in the other's direction, which is why this is `&&` and why the
 * test for it asserts the packaged case rather than the happy one.
 */
function isE2eProfile(): boolean {
  return !app.isPackaged && (process.env['CHORUS_WORKBENCH_E2E_ROOTS'] ?? '') !== ''
}

let seededRoots: string[] | null = null
function nextSeededRoot(): string | null {
  seededRoots ??= isE2eProfile()
    ? (process.env['CHORUS_WORKBENCH_E2E_ROOTS'] ?? '')
        .split(delimiter)
        .filter((part) => part.length > 0)
    : []
  return seededRoots.shift() ?? null
}

/**
 * The person's answer, or null if they closed the dialog.
 *
 * Attached to the owner's own window rather than to the focused one: the owner is
 * who the grant will be bound to, and a sheet over a different window would be an
 * authorisation for a window the person was not looking at. No `buttonLabel` —
 * main has no translator, and the OS's own verb is a better string than a
 * hardcoded English one this file could not localise anyway.
 */
async function pickDirectory(owner: WebContents): Promise<string | null> {
  const seeded = nextSeededRoot()
  if (seeded !== null) return seeded

  const options: OpenDialogOptions = { properties: ['openDirectory'] }
  const window = BrowserWindow.fromWebContents(owner)
  const result = await (window === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(window, options))
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/**
 * The mint, and the only one: a capability exists because a person picked a
 * folder in a dialog main put in front of them.
 *
 * Not exported, deliberately. An exported `mintFor(owner, path)` would be a way
 * to turn a path into an authorisation, and the next caller that wanted one would
 * find it — the point of a capability is that there is no such function.
 */
async function mintProjectGrant(
  owner: WebContents
): Promise<WorkbenchShellResponse<'workbench:chooseProject'>> {
  const picked = await pickDirectory(owner)
  if (picked === null) return { chosen: null }

  const projectRoot = approveProjectRoot(picked)
  const grant = randomUUID()
  grants.set(grant, { projectRoot, owner })
  // Watched from the mint rather than from the first `openSurface`: a grant must
  // not outlive the document it was minted for, and a shell can reload between
  // choosing a folder and opening it.
  watchOwner(owner)
  return { chosen: { grant, projectRoot } }
}

/**
 * The root `caller` is entitled to open, or a refusal.
 *
 * A forged path fails here for the reason that matters: it is not a capability
 * at all, so there is nothing to look up, and no amount of the path being real
 * changes that. A capability minted for another window fails on the owner check,
 * which is the same rule `ownedSurface` applies one object further along — and
 * for the same reason, since a grant reaches the shell's React state and would
 * reach the first log line anyone adds while debugging this.
 */
function redeem(caller: WebContents, target: WorkbenchTarget): string {
  if ('projectId' in target) {
    /*
     * Fail-closed and on purpose. ProjectService owns the id → root table and
     * does not exist yet, so there is nothing to resolve an id against; the arm
     * is admitted by the schema so that the channel's shape is settled while it
     * is cheap, and refused here so that "settled" never means "open".
     */
    throw new Error(`No workbench project "${target.projectId}" is known to this window`)
  }
  const held = grants.get(target.grant)
  if (held?.owner !== caller) {
    throw new Error(`No workbench project grant "${target.grant}" belongs to this window`)
  }
  return held.projectRoot
}

/** Everything a surface is told about itself. One project, one view, one server. */
function describe(surface: Surface): WorkbenchConnection {
  return {
    projectRoot: surface.projectRoot,
    remoteAuthority: surface.runtime.remoteAuthority,
    connectionToken: surface.runtime.connectionToken,
    commit: surface.runtime.commit,
    quality: surface.runtime.quality,
    /*
     * Spread in or not present at all, rather than set to a value meaning "no".
     *
     * A descriptor that ships to a person carries no trust field, so there is no
     * way to write the disabled state by accident — no ternary to invert, no
     * boolean to misread, and a renderer that never heard of the field enforces
     * trust. The condition is main's own, taken from the process environment and
     * from `isPackaged`, and never from anything the shell or the surface says.
     */
    ...(isE2eProfile() ? { workspaceTrust: 'waived' as const } : {}),
  }
}

/**
 * Watches one shell, once, for the two ways it can leave without telling us.
 *
 * `did-start-navigation` covers the reload: Electron's own typings describe it as
 * "emitted when any frame (including main) starts navigating", so a document
 * replacing itself arrives here before its successor exists. `isSameDocument` is
 * checked because a `pushState` or a fragment is the shell still running, and
 * closing four workbenches because a route changed would be a far worse bug than
 * the one being fixed. `destroyed` covers the window closing.
 *
 * Registered per owner rather than per surface, because these listeners outlive
 * any one view and Electron's emitter has no dedupe of its own.
 */
function watchOwner(owner: WebContents): Set<string> {
  const existing = byOwner.get(owner)
  if (existing !== undefined) return existing

  const owned = new Set<string>()
  byOwner.set(owner, owned)

  owner.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    releaseOwner(owner)
  })
  owner.on('destroyed', () => {
    releaseOwner(owner)
    byOwner.delete(owner)
  })
  return owned
}

/** Every surface this shell owns, torn down without asking it — and every grant. */
function releaseOwner(owner: WebContents): void {
  for (const id of [...(byOwner.get(owner) ?? [])]) destroySurface(id)
  /*
   * The grants go with them. A capability is an authorisation the person gave to
   * one document; the document that replaces it after a reload is not that
   * document, and letting it inherit the set would make "the user picked this"
   * survive an event the user never saw.
   */
  for (const [grant, held] of [...grants]) if (held.owner === owner) grants.delete(grant)
}

export async function openSurface(
  owner: WebContents,
  target: WorkbenchTarget,
  devServerUrl: string | undefined
): Promise<string> {
  const projectRoot = redeem(owner, target)

  /*
   * The lease is taken **before** the view exists, and the await is why this
   * function became asynchronous.
   *
   * `acquire` on project open, `release` on project close, and unmounting a
   * surface calls neither — §5.4. The first caller pays for the download, the
   * checksum, the transactional extraction and the spawn; every caller after it
   * gets the same descriptor for the same shared server. Doing this after the
   * view were created would mean a workbench document existing with nothing to
   * connect to, which is the state its own error path cannot distinguish from a
   * server that died.
   */
  const runtime = await acquireWorkbenchRuntime(projectRoot)

  /*
   * The parent window is *derived from* the owner rather than passed beside it,
   * so the view cannot be parented to one window while being owned by another —
   * a pairing nothing downstream would ever check.
   *
   * Re-read after the await: a window can close while a 76 MB artifact is being
   * fetched, and parenting a view to a destroyed window is a crash rather than a
   * refusal.
   */
  const parent = BrowserWindow.fromWebContents(owner)
  if (parent === null || owner.isDestroyed()) {
    releaseWorkbenchRuntime(projectRoot)
    throw new Error('A workbench surface needs a window to attach to')
  }

  const id = randomUUID()

  /*
   * Its own `webPreferences` literal, and never a spread of the window's.
   *
   * The sandbox flags below are identical to the shell's, which is exactly what
   * makes the spread tempting — and `preload` would come along with it, handing
   * this document the whole `ChorusApi`. Written out, the preload is a decision
   * on its own line rather than a passenger.
   */
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/workbench.js'),
      session: workbenchSession(devServerUrl !== undefined, runtime.remoteAuthority),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      /*
       * Off, and it is the property that makes this surface possible at all.
       * On, "all your preloads will load for every iframe" — and the workbench's
       * iframes are extension webviews. Off, the bridge exists in this document
       * and in none of the content it hosts.
       */
      nodeIntegrationInSubFrames: false,
    },
  })

  const surface: Surface = { id, projectRoot, runtime, view, owner }
  byId.set(id, surface)
  byContents.set(view.webContents, surface)
  watchOwner(owner).add(id)

  const entry = workbenchEntry(devServerUrl)

  // Not inherited: `lockDownNavigation` binds listeners to one `webContents`, and
  // the window's is a different object. One entry, exactly — this document may
  // reload itself and may go nowhere else, least of all onto the shell's own
  // `index.html`, which a `file://` prefix rule admitted.
  lockDownNavigation(view.webContents, [entry.href])

  /*
   * Zero-sized until the shell reports where its placeholder is. A view added at
   * its default bounds paints over the whole window for one frame, which reads as
   * the workbench having stolen the app.
   */
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  parent.contentView.addChildView(view)

  /*
   * Pushed on the view's own load, not on its creation. Electron makes no promise
   * that `send` queues for a document that does not exist yet, and designing on
   * the assumption that it does is the unread-shape failure CLAUDE.md warns
   * about. The preload's buffer is what covers the remaining window between the
   * document existing and the entry module subscribing.
   */
  view.webContents.on('did-finish-load', () => {
    view.webContents.send(WORKBENCH_CONNECTION_CHANNEL, describe(surface))
  })

  if (entry.file !== null) void view.webContents.loadFile(entry.file)
  else void view.webContents.loadURL(entry.href)

  return id
}

/**
 * Tears one surface down, with no question of who asked.
 *
 * The unchecked half, used by the owner's own lifecycle and by shutdown. Every
 * path a *renderer* can reach goes through `ownedSurface` first.
 */
function destroySurface(viewId: string): void {
  const surface = byId.get(viewId)
  if (surface === undefined) return
  byId.delete(viewId)
  byContents.delete(surface.view.webContents)
  byOwner.get(surface.owner)?.delete(viewId)

  const parent = BrowserWindow.getAllWindows().find((window) =>
    window.contentView.children.includes(surface.view)
  )
  parent?.contentView.removeChildView(surface.view)

  // `close()` rather than `destroy()`: it runs the document's own unload path, so
  // whatever the workbench wants to do on the way out still happens. Whether the
  // process actually exits afterwards is R11's subject and is not asserted here.
  if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close()

  /*
   * The lease goes only when the last surface on that root goes — and the
   * distinction §5.4 draws, between closing a project and unmounting its view,
   * **cannot be exercised yet and is not being claimed here.**
   *
   * The probe has one surface per project and its close button *is* a project
   * close, so today the two coincide. What must not happen is a later tab strip
   * unmounting a background pane and finding that it released a lease: the
   * refcount is written over projects for exactly that reason, and this is where
   * it will have to stop being called from. Releasing does not stop the server in
   * any case — `stopWorkbenchHost` on quit is the only unconditional kill — so
   * the shape is right before it is load-bearing rather than after.
   */
  const stillOpen = [...byId.values()].some((other) => other.projectRoot === surface.projectRoot)
  if (!stillOpen) releaseWorkbenchRuntime(surface.projectRoot)
}

/**
 * The surface `caller` is entitled to name, or a refusal.
 *
 * One message for "there is no such surface" and for "that one is not yours",
 * deliberately: two messages would answer whether a given id exists, which is
 * the only thing a caller guessing ids could learn from here.
 */
function ownedSurface(caller: WebContents, viewId: string): Surface {
  const surface = byId.get(viewId)
  if (surface?.owner !== caller) {
    throw new Error(`No workbench surface "${viewId}" belongs to this window`)
  }
  return surface
}

export function closeSurface(caller: WebContents, viewId: string): void {
  ownedSurface(caller, viewId)
  destroySurface(viewId)
}

export function setSurfaceBounds(caller: WebContents, viewId: string, rect: WorkbenchRect): void {
  ownedSurface(caller, viewId).view.setBounds(rect)
}

/** Every open surface, for shutdown. */
export function closeAllSurfaces(): void {
  for (const id of [...byId.keys()]) destroySurface(id)
}

/**
 * Registers both halves of the surface IPC.
 *
 * Not folded into `registerIpcHandlers`: that registrar discards `event` by
 * design, and every channel here has to be answered from `event.sender`. The
 * request/response validation is the same discipline, deliberately repeated
 * rather than shared through a weaker registrar.
 */
export function registerWorkbenchHandlers(devServerUrl: string | undefined): void {
  for (const channel of WORKBENCH_SHELL_CHANNELS) {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      /*
       * A surface may not drive surfaces.
       *
       * Its preload exposes no way to try, so this cannot be reached today — it
       * is here because "the renderer has no method for it" is a property of one
       * file, and the sender check is a property of the boundary.
       */
      if (byContents.has(event.sender)) {
        throw new Error(`"${channel}" is not available to a workbench surface`)
      }

      const schema = WORKBENCH_SHELL_CONTRACT[channel]
      const parsedRequest = schema.request.safeParse(rawRequest)
      if (!parsedRequest.success) {
        throw new Error(`Invalid request on "${channel}": ${parsedRequest.error.message}`)
      }

      /*
       * Awaited before validation, and two arms need it now rather than one: a
       * native dialog is asynchronous, and so is opening a surface, which since
       * step 2 has to acquire the shared server's lease first — a download, a
       * checksum, an extraction and a spawn on the very first call. Validating
       * `result` without awaiting would hand the response schema a `Promise` and
       * fail at the boundary rather than at the thing that was slow.
       */
      const result = await (async (): Promise<unknown> => {
        switch (channel) {
          /*
           * `event.sender` on every arm, and never a window named in the payload.
           *
           * It is who the grant is minted for on `chooseProject`, the owner on
           * `open`, and the credential on the other two — the same object every
           * time, which is what makes ownership decidable at all rather than a
           * second thing to keep in step.
           */
          case 'workbench:chooseProject':
            return mintProjectGrant(event.sender)
          case 'workbench:open': {
            const target = parsedRequest.data as WorkbenchTarget
            return { viewId: await openSurface(event.sender, target, devServerUrl) }
          }
          case 'workbench:setBounds': {
            const { viewId, rect } = parsedRequest.data as { viewId: string; rect: WorkbenchRect }
            setSurfaceBounds(event.sender, viewId, rect)
            return { ok: true }
          }
          case 'workbench:close': {
            const { viewId } = parsedRequest.data as { viewId: string }
            closeSurface(event.sender, viewId)
            return { ok: true }
          }
        }
      })()

      const parsedResponse = schema.response.safeParse(result)
      if (!parsedResponse.success) {
        throw new Error(`Invalid response on "${channel}": ${parsedResponse.error.message}`)
      }
      return parsedResponse.data
    })
  }

  /*
   * The pull half, and the whole of its authorisation is the sender.
   *
   * The request carries no arguments on purpose: a project id in the payload
   * would be a claim the sender is not entitled to make, and a lookup keyed on
   * "the most recently opened project" would pass every friendly version of the
   * cross-view test.
   */
  ipcMain.handle(WORKBENCH_CONNECTION_CHANNEL, (event) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) throw new Error('unknown workbench surface')
    return describe(surface)
  })

  /*
   * E5's two channels, and they are the mirror image of the four above: those
   * refuse a *surface*, and these refuse everything else.
   *
   * The shell has no business reading the workbench's settings file — its preload
   * exposes no method for it, and this is the boundary saying so rather than one
   * file's export list. `byContents` is the same membership test used to answer
   * `connection`, so "is this a surface I own?" has one implementation.
   *
   * Neither handler is told a path. The read takes no argument at all and the
   * write takes a string, so the only thing a compromised surface can do here is
   * overwrite its own profile's settings file with text — which is exactly what
   * the person using the workbench can do anyway, through the settings editor.
   */
  ipcMain.handle(WORKBENCH_USER_SETTINGS_READ_CHANNEL, (event) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    return readWorkbenchUserSettings(app.getPath('userData'))
  })

  ipcMain.handle(WORKBENCH_USER_SETTINGS_WRITE_CHANNEL, (event, text: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof text !== 'string') throw new Error('Workbench settings must be text')
    writeWorkbenchUserSettings(app.getPath('userData'), text)
  })
}
