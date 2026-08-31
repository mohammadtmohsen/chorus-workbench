import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  WebContentsView,
  app,
  clipboard,
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
  WORKBENCH_CONTEXT_CHANNEL,
  WORKBENCH_EDIT_CHANNEL,
  WORKBENCH_SNAPSHOT_CHANNEL,
  WORKBENCH_SNAPSHOT_RESULT_CHANNEL,
  WORKBENCH_EDIT_RESULT_CHANNEL,
  WorkbenchContext,
  WORKBENCH_CLIPBOARD_READ_CHANNEL,
  WORKBENCH_SECRET_DELETE_CHANNEL,
  WORKBENCH_SECRET_READ_CHANNEL,
  WORKBENCH_SECRET_WRITE_CHANNEL,
  WORKBENCH_STORAGE_CHANGED_CHANNEL,
  WORKBENCH_STORAGE_READ_CHANNEL,
  WORKBENCH_STORAGE_WRITE_CHANNEL,
  WORKBENCH_URL_CHANNEL,
  WORKBENCH_USER_SETTINGS_READ_CHANNEL,
  WORKBENCH_USER_SETTINGS_WRITE_CHANNEL,
  type WorkbenchConnection,
  type WorkbenchEditRequest,
  type WorkbenchEditResult,
  type WorkbenchSnapshotResult,
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
  deleteWorkbenchSecret,
  readWorkbenchSecret,
  writeWorkbenchSecret,
} from './workbench-secrets.js'
import { applyWorkbenchStorageDelta, readWorkbenchStorage } from './workbench-storage.js'
import { readWorkbenchUserSettings, writeWorkbenchUserSettings } from './workbench-user-settings.js'

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
export function workbenchSession(
  isDev: boolean,
  remoteAuthority: string | null,
  /**
   * The server's identity, because its resource path is prefixed with it.
   *
   * Carried here for the same reason the authority is: the policy and the server
   * must not be able to drift, and there is exactly one place either value is
   * known.
   */
  product: { readonly quality: string; readonly commit: string } | null
): Session {
  if (configuredSession !== null) return configuredSession
  const created = session.fromPartition(WORKBENCH_PARTITION)
  /*
   * Built once, with the real authority already in it — which is why the session
   * is created on the first *open* rather than at boot. The port is ephemeral and
   * only exists once the child has reported it, so a session built earlier could
   * only have carried a wildcard. One shared server means one authority for the
   * app's whole life, so "once" is not a limitation here.
   */
  applyWorkbenchContentSecurityPolicy(created, isDev, remoteAuthority, product)
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
 * Two independent reasons a surface can be invisible, and they must not clobber
 * each other.
 *
 * They arrive from different places and mean different things. An **overlay** is
 * window-wide and momentary — a dialog is up, so every surface in this window
 * steps aside until it closes. The **Editor switch** is per project and
 * durable — this one editor is off, and it stays off across a hover card, a
 * dialog, a relaunch.
 *
 * A single boolean could not hold both, and the bug was exactly that: the switch
 * hid one view, then the next hover card opened and closed and its restore said
 * "show everything this window owns", which turned the editor back on. Worse, it
 * came back at *stale bounds* — the region had left the layout, so nothing had
 * moved the view — and it was composited over the Chorus column that had grown
 * into its place. The chat was not hidden; it was behind the editor.
 *
 * So each reason gets its own set and a surface is visible only when it is in
 * neither. Neither caller has to know the other exists.
 */
/**
 * Keyed by **project root**, not by view id, and that is what makes it hold.
 *
 * One project is not guaranteed to be one surface. `StrictMode` mounts,
 * unmounts and mounts again while the open is in flight — the `live` flag in
 * `WorkbenchFrame` exists because that can leak a whole `WebContents` nobody
 * tracks any more — and a leaked surface sits at the same bounds painting the
 * same project. By id, hiding "the" surface leaves the other one on screen,
 * which is precisely the symptom this fixes: the region left the layout, Chorus
 * grew into it, and an editor that should have gone dark was still composited
 * over the top.
 *
 * By root it also survives a surface being *created* while the switch is off. A
 * new view for a hidden project is hidden the moment it is parented, rather than
 * flashing on until the shell gets around to telling it.
 */
const editorHidden = new Set<string>()
const overlayHidden = new Set<WebContents>()

/**
 * An overlay hide expires unless the shell keeps saying it is still up.
 *
 * **Because the shell's own bookkeeping cannot be trusted, and must not have to
 * be.** `overlay.ts` counts overlays in a module-level integer, incremented by an
 * effect and decremented by its cleanup; one cleanup that never runs leaves every
 * editor in the window hidden for the rest of the session, and there is no path
 * back — no timeout, no reconcile, nothing a person can press. It was reached by
 * hovering the rail's usage meter, whose restore hangs on a `pointerleave` that
 * browsers routinely skip when the pointer leaves fast or the window blurs. The
 * editor went black about a minute after launch and stayed black.
 *
 * Making the counter more careful was the alternative and it is not a fix: the
 * count is only ever as reliable as its least careful caller, including callers
 * nobody has written yet. A deadline is indifferent to who was careless.
 *
 * **Generous on purpose.** This is a safety net, not a scheduler: the cost of
 * firing late is a few extra seconds of a frozen-looking editor under a dialog,
 * and the cost of firing early is a dialog cut in half by a view that came back
 * underneath it. Only the second is a bug, so the interval is far longer than any
 * heartbeat gap a busy renderer could produce.
 */
const OVERLAY_HIDE_TTL_MS = 10_000
const overlayDeadlines = new Map<WebContents, ReturnType<typeof setTimeout>>()

function armOverlayExpiry(caller: WebContents): void {
  clearOverlayExpiry(caller)
  overlayDeadlines.set(
    caller,
    setTimeout(() => {
      overlayDeadlines.delete(caller)
      if (!overlayHidden.delete(caller)) return
      /*
       * Restores only what this caller hid. `editorHidden` is a different reason
       * with a different lifetime — a project whose Editor switch is off must
       * stay off through this, which is the same clobbering `applyVisibility`
       * exists to prevent.
       */
      for (const id of byOwner.get(caller) ?? []) {
        const surface = byId.get(id)
        if (surface !== undefined) applyVisibility(surface)
      }
    }, OVERLAY_HIDE_TTL_MS)
  )
}

function clearOverlayExpiry(caller: WebContents): void {
  const timer = overlayDeadlines.get(caller)
  if (timer === undefined) return
  clearTimeout(timer)
  overlayDeadlines.delete(caller)
}

function applyVisibility(surface: Surface): void {
  surface.view.setVisible(
    !editorHidden.has(surface.projectRoot) && !overlayHidden.has(surface.owner)
  )
}

/**
 * Hide or show surfaces — one, or every one this window owns.
 *
 * **Scoped to the caller's own surfaces**, by the same `byOwner` set that tears
 * them down on reload: a window may not blank another window's workbench, for
 * the same reason it may not resize or close one. Naming a surface it does not
 * own is indistinguishable from naming one that does not exist — both are an
 * empty list and a silent success, because a view id reaches the shell's React
 * state and is therefore not a secret to authorise on.
 *
 * `setVisible` and not bounds: the surface keeps its rectangle, so nothing has
 * to be restored afterwards and the workbench inside is never told its window
 * changed size. An overlay that opens and closes leaves no trace in the editor's
 * own layout — and neither does the Editor switch.
 */
async function setSurfacesVisible(
  caller: WebContents,
  visible: boolean,
  only?: string,
  heartbeat = false
): Promise<{ viewId: string; dataUrl: string }[]> {
  const owned = [...(byOwner.get(caller) ?? [])]

  /*
   * The id names a surface only so main can read its project off it — **and only
   * if the caller owns it**. Resolving the root before that check would let a
   * window name someone else's surface and learn, by the effect, which project
   * it holds. Same rule `ownedSurface` applies to bounds and close: a view id is
   * not a secret, so it may never be the thing that authorises.
   */
  const root =
    only !== undefined && owned.includes(only) ? (byId.get(only)?.projectRoot ?? null) : null
  const ids = only === undefined ? owned : owned.filter((id) => byId.get(id)?.projectRoot === root)

  /*
   * Which reason is being set is decided by whether a surface was named, and
   * that is the whole of the distinction: the shell's overlay code names none
   * because it does not know which surfaces its dialog covers, and the Editor
   * switch always names one because it must not touch the three beside it.
   */
  const mark = (): void => {
    if (only === undefined) {
      if (visible) {
        overlayHidden.delete(caller)
        clearOverlayExpiry(caller)
      } else {
        overlayHidden.add(caller)
        // Every hide renews the deadline, so an overlay that keeps saying it is
        // up keeps the views down and one that stops saying so releases them.
        armOverlayExpiry(caller)
      }
      return
    }
    if (root === null) return
    if (visible) editorHidden.delete(root)
    else editorHidden.add(root)
  }

  if (visible) {
    mark()
    for (const id of owned) {
      const surface = byId.get(id)
      if (surface !== undefined) applyVisibility(surface)
    }
    return []
  }

  /*
   * Captured while still up, then hidden — the order is the whole point.
   *
   * A hidden view has no compositor surface to read, so capturing after the hide
   * yields either the last frame, a blank, or nothing depending on the platform.
   * Doing both here rather than in two channels also means the shell cannot get
   * them out of order: there is no window in which a caller has hidden the views
   * but not yet been handed what to draw instead.
   *
   * Only for the overlay, which is the caller that has somewhere to paint one.
   * The Editor switch removes the region from the layout entirely, so there is
   * no rectangle left to hold a still and capturing one would be pure cost.
   *
   * A capture that fails is not a failure of the hide. The still is a courtesy;
   * losing one costs an empty rectangle for the life of one overlay, and taking
   * the dialog down with it would cost the whole interaction. A surface already
   * dark for the other reason is skipped — it would capture a blank.
   */
  /*
   * A heartbeat does the marking and nothing else.
   *
   * It must still reach `mark()` — that is the whole renewal, and returning above
   * it would leave the deadline running down while the shell believed it was
   * saying "still up", so the watchdog would fire *during* a legitimate dialog
   * and restore the views underneath it. What it skips is the capture: the shell
   * already holds its stills, and re-encoding a JPEG per surface every few
   * seconds for a hover that is not moving is the one way this safety net could
   * cost more than the bug it prevents.
   *
   * Visibility is re-applied anyway, so a surface created since the last hide is
   * caught by the next beat rather than sitting bright under the overlay.
   */
  if (heartbeat) {
    mark()
    for (const id of owned) {
      const surface = byId.get(id)
      if (surface !== undefined) applyVisibility(surface)
    }
    return []
  }

  const stills: { viewId: string; dataUrl: string }[] = []
  if (only === undefined) {
    for (const id of ids) {
      const surface = byId.get(id)
      if (surface === undefined || editorHidden.has(surface.projectRoot)) continue
      try {
        const image = await surface.view.webContents.capturePage()
        if (!image.isEmpty()) {
          stills.push({
            viewId: id,
            dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`,
          })
        }
      } catch {
        /* no still for this one; the region will simply be empty */
      }
    }
  }

  /*
   * Marked and applied after the await. Captures take tens of milliseconds and a
   * pane can close inside that, so `owned` may name a surface that is gone —
   * `byId.get` returning undefined is how that is handled rather than a held
   * reference that outlives it.
   */
  mark()
  for (const id of owned) {
    const surface = byId.get(id)
    if (surface !== undefined) applyVisibility(surface)
  }
  return stills
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
     * **Authorised by adoption rather than by this document**, and that is a
     * deliberate widening rather than a hole.
     *
     * A grant answers "did somebody just pick this folder, in this window". An id
     * answers "is this one of the projects the person has adopted", which is a set
     * bounded by every dialog they ever accepted and is exactly what Phase 1's E2
     * asked for. The renderer still cannot name a *path*: an id it invents
     * resolves to nothing, which is what `resolveProjectRoot` refuses. Requiring
     * a per-window grant on top would mean re-choosing every project on every
     * launch, which is the product failure E2 was filed about.
     *
     * Still fail-closed when nothing was injected. A build that forgot to wire the
     * registry must refuse rather than fall through to the grant branch, where
     * `target.grant` is not even present.
     */
    if (resolveProjectRoot === null) {
      throw new Error(`No project registry is wired, so "${target.projectId}" cannot be opened`)
    }
    return resolveProjectRoot(target.projectId)
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

/**
 * Which surface sent someone to a browser, and when.
 *
 * **The callback cannot address itself, so this is the address.** An OAuth
 * return arrives as `chorus://<extension>/…` with no project in it, and one REH
 * serves up to five surfaces. Delivering to all of them would hand one project's
 * access token to every open workbench, which is a credential leak dressed up as
 * a convenience; delivering to the focused one guesses, and the person is by
 * definition in a browser at that moment, so "focused" means whatever they
 * clicked on the way back.
 *
 * The surface that opened the browser is the only claimant with evidence behind
 * it, and `lockDownNavigation`'s external hook is where that evidence exists.
 */
let awaitingCallback: { viewId: string; at: number } | null = null

/**
 * How long an opened browser stays a plausible origin for a callback.
 *
 * Long enough for a real login — a password manager, a 2FA prompt, an account
 * chooser, a consent screen — and short enough that a `chorus://` URL arriving
 * an hour later, from a link in a mail or from another application, is not
 * silently handed to whichever project happened to open a browser that morning.
 */
const CALLBACK_ORIGIN_TTL_MS = 5 * 60 * 1000

/**
 * Hands an incoming `chorus://` URL to the surface that started the flow.
 *
 * **Dropped rather than guessed when there is no claimant.** A callback with no
 * recent external open is either stale or was not started here, and there is no
 * safe default: every fallback available — the focused surface, the first, all
 * of them — routes somebody's credential to a project that did not ask for it.
 * Doing nothing leaves the extension waiting, which is the visible failure the
 * person can act on, rather than the invisible one they cannot.
 */
export function deliverUrl(url: string): boolean {
  const pending = awaitingCallback
  if (pending === null || Date.now() - pending.at > CALLBACK_ORIGIN_TTL_MS) return false
  const surface = byId.get(pending.viewId)
  if (surface === undefined || surface.view.webContents.isDestroyed()) {
    awaitingCallback = null
    return false
  }
  /*
   * Consumed on delivery. A callback is answered once; leaving the claim standing
   * would let a second, unrelated `chorus://` URL inside the same five minutes
   * ride in on the first one's evidence.
   */
  awaitingCallback = null
  surface.view.webContents.send(WORKBENCH_URL_CHANNEL, url)
  return true
}

/** Every surface this shell owns, torn down without asking it — and every grant. */
function releaseOwner(owner: WebContents): void {
  for (const id of [...(byOwner.get(owner) ?? [])]) destroySurface(id)
  /* The overlay flag is keyed by the document, and this one is gone. */
  overlayHidden.delete(owner)
  /*
   * And its deadline with it. Deleting the flag without cancelling the timer
   * leaves a `setTimeout` holding a destroyed `WebContents` that fires up to
   * `OVERLAY_HIDE_TTL_MS` later and calls `applyVisibility` on surfaces this
   * function has just torn down — `Object has been destroyed`, out of a timer,
   * where there is no caller to blame and nothing to catch it.
   */
  clearOverlayExpiry(owner)
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
      session: workbenchSession(devServerUrl !== undefined, runtime.remoteAuthority, runtime),
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
  lockDownNavigation(view.webContents, [entry.href], () => {
    awaitingCallback = { viewId: id, at: Date.now() }
  })

  /*
   * Zero-sized until the shell reports where its placeholder is. A view added at
   * its default bounds paints over the whole window for one frame, which reads as
   * the workbench having stolen the app.
   */
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  parent.contentView.addChildView(view)
  /*
   * Applied before the shell says anything, because a project whose Editor
   * switch is off must not flash on while the frame's effect is still queued.
   * The set is keyed by root, so a second surface for the same project — the
   * `StrictMode` remount this file already guards against — inherits the state
   * rather than arriving visible.
   */
  applyVisibility(surface)

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
  /*
   * Only when this was the project's *last* surface. Two panes on one project
   * share a root, and telling the shell the editor is gone while another is
   * still showing it would drop a context that is still true.
   */
  if (![...byId.values()].some((other) => other.projectRoot === surface.projectRoot)) {
    onSurfaceGone?.(surface.projectRoot)
  }
  /*
   * `editorHidden` is **not** pruned here, and that is deliberate: it is keyed by
   * project root, and a project whose editor is off should still be off when its
   * pane is reopened. It is bounded by the number of projects, and the shell
   * re-asserts the switch from `WorkbenchFrame`'s own effect on every mount.
   */

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
/**
 * Turns an adopted project id into its root, or throws.
 *
 * Injected rather than imported. `project-service.ts` already imports
 * `approveProjectRoot` from this file, so importing the service back would close
 * a cycle — and a function is the whole of what this file needs, so taking the
 * service would be taking a registry in order to call one method on it.
 */
let resolveProjectRoot: ((projectId: string) => string) | null = null

export function registerWorkbenchHandlers(
  devServerUrl: string | undefined,
  resolveRoot?: (projectId: string) => string
): void {
  resolveProjectRoot = resolveRoot ?? null
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
          case 'workbench:setVisible': {
            const { visible, viewId, heartbeat } = parsedRequest.data as {
              visible: boolean
              viewId?: string
              heartbeat?: boolean
            }
            return {
              ok: true,
              stills: await setSurfacesVisible(event.sender, visible, viewId, heartbeat ?? false),
            }
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

  /*
   * The storage pair, on the same authorisation as the settings pair: the sender
   * must be a live surface, and `byContents` is the one membership test.
   *
   * **These two do take an argument, and it is not a path.** The scope key names
   * one of the storage service's scopes, and main cannot derive which is meant —
   * unlike the settings file, there are several and one of them is per workspace.
   * It is used only as a property name inside a single JSON file, so a surface
   * running third-party extension code cannot steer it at the filesystem; the
   * shape of that file is the mitigation, not a filter here.
   *
   * A non-string scope is refused rather than coerced: `String(x)` on an object
   * would put `[object Object]` in the file as a real scope that a later honest
   * caller could collide with.
   */
  ipcMain.handle(WORKBENCH_STORAGE_READ_CHANNEL, (event, scope: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof scope !== 'string' || scope === '') throw new Error('Storage scope must be text')
    return readWorkbenchStorage(app.getPath('userData'), scope)
  })

  ipcMain.handle(
    WORKBENCH_STORAGE_WRITE_CHANNEL,
    (event, scope: unknown, insert: unknown, remove: unknown) => {
      if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
      if (typeof scope !== 'string' || scope === '') throw new Error('Storage scope must be text')
      if (typeof insert !== 'object' || insert === null || Array.isArray(insert)) {
        throw new Error('Storage insert must be an object')
      }
      if (!Array.isArray(remove)) throw new Error('Storage remove must be an array')

      const inserted: Record<string, string> = {}
      for (const [key, value] of Object.entries(insert as Record<string, unknown>)) {
        if (typeof value !== 'string') throw new Error('Storage values must be text')
        inserted[key] = value
      }
      const removed = remove.filter((key): key is string => typeof key === 'string')

      applyWorkbenchStorageDelta(app.getPath('userData'), scope, inserted, removed)

      /*
       * Then tell every *other* surface, because they hold their own cache of
       * the shared scopes and would otherwise drift from the file until relaunch.
       *
       * Not the sender: it already applied this delta locally, and echoing it
       * back would fire `onDidChangeItemsExternal` for a change that was not
       * external — which is how a service concludes it has been raced and
       * re-reads state it already has.
       *
       * Every other surface rather than only those on the same scope: main does
       * not track which scopes a surface holds, and a surface that does not know
       * the scope ignores it. Broadcasting a name is cheaper than maintaining a
       * registry that can go stale.
       */
      for (const [id, surface] of byId) {
        if (surface.view.webContents === event.sender) continue
        if (surface.view.webContents.isDestroyed()) continue
        void id
        surface.view.webContents.send(WORKBENCH_STORAGE_CHANGED_CHANNEL, scope, inserted, removed)
      }
    }
  )

  /*
   * Credentials, on the same authorisation as everything else here and with one
   * extra property: **main never returns a secret it cannot decrypt, and never
   * stores one it cannot encrypt.** Both degrade to "no secret", which is the
   * state a fresh profile is in and which every caller already handles by asking
   * the person to sign in.
   *
   * The key is a string from the surface, exactly as with storage scopes, and it
   * is a property name in a JSON object rather than a path — the same mitigation,
   * for the same reason, in a file where the stakes are higher.
   */
  ipcMain.handle(WORKBENCH_SECRET_READ_CHANNEL, (event, key: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof key !== 'string' || key === '') throw new Error('Secret key must be text')
    return readWorkbenchSecret(app.getPath('userData'), key)
  })

  ipcMain.handle(WORKBENCH_SECRET_WRITE_CHANNEL, (event, key: unknown, value: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof key !== 'string' || key === '') throw new Error('Secret key must be text')
    if (typeof value !== 'string') throw new Error('Secret must be text')
    writeWorkbenchSecret(app.getPath('userData'), key, value)
  })

  ipcMain.handle(WORKBENCH_SECRET_DELETE_CHANNEL, (event, key: unknown) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    if (typeof key !== 'string' || key === '') throw new Error('Secret key must be text')
    deleteWorkbenchSecret(app.getPath('userData'), key)
  })

  /*
   * The system clipboard, read on a surface's behalf.
   *
   * The workbench partition denies every browser permission, `clipboard-read`
   * among them — deliberately, since that grant would reach every iframe and
   * extension webview in the partition. The terminal's paste is the one thing
   * that needed it: `⌘V` there is a command calling `IClipboardService.readText`,
   * not a native paste event, and the browser implementation swallows the
   * refusal and returns `''`.
   *
   * So the capability lives here instead, where it is one channel with one
   * sender check rather than a session-wide grant. **Read only and no argument**:
   * a surface cannot say what to read and cannot write, which is the same shape
   * as the user-settings channels and for the same reason.
   *
   * The sender check is the boundary. `byContents` holds only live surfaces this
   * process opened, so a `WebContents` that is not one of them — an extension
   * webview's own frame, anything else in the session — is refused rather than
   * defaulted, exactly as every other channel here treats an unknown sender.
   */
  ipcMain.handle(WORKBENCH_CLIPBOARD_READ_CHANNEL, (event) => {
    if (!byContents.has(event.sender)) throw new Error('unknown workbench surface')
    return clipboard.readText()
  })

  /*
   * What the editor is looking at — Phase 6 slice 6a.
   *
   * `on` rather than `handle`, matching the preload's `send`: this fires on
   * cursor movement, and a reply would put a round trip inside every keystroke
   * for a value the next movement supersedes.
   *
   * **The project comes from `byContents`, never from the message.** The surface
   * reports a relative path and a position and nothing else; main attaches the
   * root it opened that surface for. That is the same rule `redeem` applies in
   * the other direction, and it is what stops a compromised surface — which runs
   * third-party extension code by design — attributing its cursor to a project
   * it was not opened for.
   *
   * **A bad frame is dropped, not thrown.** There is no reply for a throw to
   * reach, and an unparsed report is corrected by the next one; the failure this
   * must not have is a malformed payload reaching a listener.
   */
  ipcMain.on(WORKBENCH_CONTEXT_CHANNEL, (event, raw: unknown) => {
    const surface = byContents.get(event.sender)
    if (surface === undefined) return
    const parsed = WorkbenchContext.safeParse(raw)
    if (!parsed.success) return
    onContext?.({ projectRoot: surface.projectRoot, context: parsed.data })
  })

  /*
   * The other half of `requestWorkbenchEdit` — Phase 6d.
   *
   * The sender is checked the same way everything else from a surface is: an
   * unknown `WebContents` is a refusal, never a default. That matters more here
   * than for context, because a forged reply would settle a real request with a
   * result the agent then believes.
   *
   * An id nobody is waiting for is dropped silently. It is what a late reply
   * after a timeout looks like, and there is nothing to do about it — the
   * request has already been answered.
   */
  ipcMain.on(WORKBENCH_SNAPSHOT_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as WorkbenchSnapshotResult
    if (typeof result.requestId !== 'string') return
    pendingSnapshots.get(result.requestId)?.(result)
  })

  ipcMain.on(WORKBENCH_EDIT_RESULT_CHANNEL, (event, raw: unknown) => {
    if (byContents.get(event.sender) === undefined) return
    if (typeof raw !== 'object' || raw === null) return
    const result = raw as WorkbenchEditResult
    if (typeof result.requestId !== 'string') return
    pendingEdits.get(result.requestId)?.(result)
  })
}

/**
 * Where a surface's editor state goes, injected rather than imported.
 *
 * The same shape as `resolveProjectRoot`: this file already sits below
 * `project-service.ts`, and reaching up to a consumer from here would close a
 * cycle. It also keeps this module's job unchanged — it owns surfaces, not what
 * anybody does with what they report.
 *
 * Held, never logged. `CLAUDE.md`'s rule is that a cursor position read back a
 * week later is worse than none, so there is no event type for this and there
 * must not be one.
 */
let onContext:
  ((report: { readonly projectRoot: string; readonly context: WorkbenchContext }) => void) | null =
  null

/**
 * Told when a project's last surface goes, so a held context can be dropped.
 *
 * Without it "the workbench wins once it has ever reported" outlives the
 * workbench: close the editor and the shell keeps preferring a context from a
 * surface that no longer exists, while the external bridge — which may now be
 * the only editor there is — stays suppressed behind it.
 */
let onSurfaceGone: ((projectRoot: string) => void) | null = null

export function setWorkbenchSurfaceGoneSink(sink: ((projectRoot: string) => void) | null): void {
  onSurfaceGone = sink
}

export function setWorkbenchContextSink(
  sink:
    ((report: { readonly projectRoot: string; readonly context: WorkbenchContext }) => void) | null
): void {
  onContext = sink
}

/**
 * Edits in flight, by request id — Phase 6d.
 *
 * A map rather than a single pending promise, because two agents in one project
 * can both be mid-edit and a turn can issue several. The id is what makes the
 * replies distinguishable; without it the second result would settle the first
 * request and one edit would be reported with another's outcome.
 */
const pendingEdits = new Map<string, (result: WorkbenchEditResult) => void>()

/**
 * How long a surface has to answer before the edit is called a failure.
 *
 * Generous, because the far side may be resolving a model for a file that is not
 * open, and mean because an edit nobody answers must not hang a turn for ever.
 */
const EDIT_TIMEOUT_MS = 15_000

/** Snapshot requests in flight, by id. Same correlation as the edits below. */
const pendingSnapshots = new Map<string, (result: WorkbenchSnapshotResult) => void>()

/**
 * Asks the surface showing this project what its editor is showing.
 *
 * `null` for "this project has no surface", which is what tells `ide:snapshot`
 * to fall back to the external bridge — distinct from a surface that answered
 * with no file open, which is a real answer and must not be retried elsewhere.
 */
export async function requestWorkbenchSnapshot(
  projectRoot: string
): Promise<WorkbenchSnapshotResult['snapshot'] | undefined> {
  const surface = [...byId.values()].find((s) => s.projectRoot === projectRoot)
  if (surface === undefined || surface.view.webContents.isDestroyed()) return undefined

  const requestId = randomUUID()
  return new Promise((resolve) => {
    const settle = (result: WorkbenchSnapshotResult): void => {
      if (!pendingSnapshots.delete(requestId)) return
      clearTimeout(timer)
      resolve(result.snapshot)
    }
    /*
     * Shorter than an edit's budget on purpose: this one sits between pressing
     * Send and the message going, so a surface that is wedged must cost a moment
     * and not the turn. Timing out answers `null`, and the message is sent
     * without editor context rather than not at all.
     */
    const timer = setTimeout(() => {
      settle({ requestId, snapshot: null })
    }, 2_000)
    pendingSnapshots.set(requestId, settle)
    surface.view.webContents.send(WORKBENCH_SNAPSHOT_CHANNEL, { requestId })
  })
}

/**
 * Asks the surface showing this project to apply an edit, and waits.
 *
 * **Refuses rather than opening one.** If the project has no surface — the
 * Editor switch is off, or the project is not on screen — there is no model to
 * edit and no undo stack to join, and silently writing the file instead would
 * be exactly the behaviour Phase 6d exists to replace. The caller is told, and
 * can fall back to a filesystem write with the person's approval if that is
 * what it wants.
 */
export async function requestWorkbenchEdit(
  projectRoot: string,
  edit: Omit<WorkbenchEditRequest, 'requestId'>
): Promise<WorkbenchEditResult> {
  const surface = [...byId.values()].find((s) => s.projectRoot === projectRoot)
  const requestId = randomUUID()
  if (surface === undefined || surface.view.webContents.isDestroyed()) {
    return {
      requestId,
      ok: false,
      refusal: 'no-editor',
      message: 'This project has no editor open, so there is no model to edit.',
      version: null,
    }
  }

  return new Promise<WorkbenchEditResult>((resolve) => {
    const settle = (result: WorkbenchEditResult): void => {
      if (!pendingEdits.delete(requestId)) return
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({
        requestId,
        ok: false,
        refusal: 'failed',
        message: `The editor did not answer within ${String(EDIT_TIMEOUT_MS / 1000)}s.`,
        version: null,
      })
    }, EDIT_TIMEOUT_MS)
    pendingEdits.set(requestId, settle)
    surface.view.webContents.send(WORKBENCH_EDIT_CHANNEL, { ...edit, requestId })
  })
}
