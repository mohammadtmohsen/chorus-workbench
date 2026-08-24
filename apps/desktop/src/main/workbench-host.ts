import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { z } from 'zod'
import { hashBytes, publishServer, sweepQuarantine } from './workbench-extract.js'

/** `reap.ts`'s shape: the process table is read off the main thread. */
const runCommand = promisify(execFile)

/**
 * The one shared remote extension host — preflight §4.1a, §4.2's
 * `workbench-host.ts` row, and §5.4's three lifetimes.
 *
 * One server serves every open project. That is upstream's own design rather
 * than a Chorus invention: the REH holds its connections in maps keyed by
 * reconnection token and forks an extension host per connection, so several
 * workspaces at once is what it is built for — and it is the arrangement with the
 * lower marginal cost per project, one connection and one forked host rather than
 * a second server, a second watcher set and a second host. **R7 still decides
 * whether that passes**; the topology is chosen on architecture and licence and
 * the number is still owed.
 *
 * **The refcount is over open projects, never over visible views.** With a
 * four-pane cap and no cap on open projects, a count over mounted surfaces
 * reaches zero while projects are still open, and the observable result is that
 * switching to a fifth project kills the build running in the first one's
 * terminal. This is `CLAUDE.md`'s terminal rule with a server in place of a PTY:
 * unmounting a view calls neither `acquire` nor `release`.
 *
 * **What the lease cannot do, stated because it is the load-bearing unknown.** It
 * keeps a *process* running; it does not hold a socket open, because the client
 * connections belong to the surface's `WebContents` and go when it does. So if
 * server-side retention does not hold, refcounting alone cannot preserve the
 * promise that an inactive project keeps its terminals — that is a Phase 1 exit
 * decision and it is not settled here.
 */

const ArtifactSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

/**
 * The manifest of §3.5, and the two regexes are the check that catches the
 * `34.1.3` corruption — a `config.vscode.commit` reading `"1.124.2"`, a version
 * string where a SHA belongs. Anything that reads such a field must reject a
 * value that is not 40 hex characters, or it silently pins a server to a string
 * that can never match.
 */
export const WorkbenchManifest = z.object({
  client: z.object({
    package: z.string().min(1),
    version: z.string().min(1),
    vscodeVersion: z.string().min(1),
    vscodeCommit: z.string().regex(/^[0-9a-f]{40}$/),
    quality: z.string().min(1),
  }),
  server: z.object({
    vendor: z.string().min(1),
    release: z.string().min(1),
    upstreamTag: z.string().min(1),
    upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
    artifacts: z.record(z.string(), ArtifactSchema),
  }),
})
export type WorkbenchManifest = z.infer<typeof WorkbenchManifest>

export interface LoadedManifest {
  readonly manifest: WorkbenchManifest
  /** Of the exact bytes read, not of a re-serialisation. The receipt records this. */
  readonly sha256: string
}

/**
 * The one equality that makes client and server a single fact.
 *
 * §2.4 is blunt about why this and not the handshake is the real gate: VSCodium's
 * shipped `commit` is a sha1 of its own version string, so a VSCodium server can
 * never satisfy the server-side check unpatched at *any* version — and the patch
 * that fixes a correct pairing would equally make an incorrect one connect. The
 * server-side check is a second line of defence that has been deliberately
 * satisfied; this is the first.
 */
export function assertMatchedPair(manifest: WorkbenchManifest): void {
  if (manifest.client.vscodeCommit !== manifest.server.upstreamCommit) {
    throw new Error(
      `The workbench manifest is not a matched pair: client ${manifest.client.package}@${manifest.client.version} is VS Code ${manifest.client.vscodeCommit}, ${manifest.server.vendor} ${manifest.server.release} is ${manifest.server.upstreamCommit}. Refusing to patch product.json.`
    )
  }
}

export function loadManifest(path: string): LoadedManifest {
  const bytes = readFileSync(path)
  const manifest = WorkbenchManifest.parse(JSON.parse(bytes.toString('utf8')))
  assertMatchedPair(manifest)
  return { manifest, sha256: hashBytes(bytes) }
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function manifestPath(): string {
  return join(app.getAppPath(), 'build', 'workbench-runtime.json')
}

/**
 * Where the downloaded tarball is kept, and it is deliberately **not** under
 * `userData`.
 *
 * It is a re-fetchable, checksum-addressed artifact rather than anything of the
 * person's, and `userData` is redirected per-profile — by `CHORUS_USER_DATA`, and
 * by the containment gate, which points it at a temporary directory it deletes.
 * Keyed off `appData` instead, a second profile and every gate run reuse one
 * 76 MB download. Overridable in development so a checkout that has already
 * fetched the artifact does not fetch it again; ignored when packaged, because
 * the argument is about a harness.
 */
function cacheDir(): string {
  const override = process.env['CHORUS_WORKBENCH_CACHE']
  if (!app.isPackaged && override !== undefined && override !== '') return override
  return join(app.getPath('appData'), 'chorus-workbench-runtime')
}

/** `<userData>/workbench`, per §3.5 — every temporary and quarantine sibling lives here. */
function extractionRoot(): string {
  return join(app.getPath('userData'), 'workbench')
}

/** Chorus's own server data, and the path `reap.ts` would match on: no other server has it. */
function serverDataDir(): string {
  return join(app.getPath('userData'), 'workbench-server')
}

async function download(
  url: string,
  into: string,
  expectedSize: number,
  signal: AbortSignal
): Promise<void> {
  mkdirSync(join(into, '..'), { recursive: true })
  const partial = `${into}.part`
  /*
   * The signal reaches `fetch`, because this is the step that can stall for as
   * long as the network cares to. Without it, quitting Chorus mid-download meant
   * waiting for a 76 MB transfer to finish or time out on its own — and once
   * `SIGTERM` stopped being handled by Electron's default termination, that was
   * an app that appeared to hang on quit.
   */
  const response = await fetch(url, { signal })
  if (!response.ok || response.body === null) {
    throw new Error(
      `Could not fetch the workbench server: ${String(response.status)} ${response.statusText}`
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== expectedSize) {
    throw new Error(
      `The workbench server download is ${String(bytes.length)} B where the manifest says ${String(expectedSize)} B`
    )
  }
  writeFileSync(partial, bytes)
  // Renamed only once whole, so an interrupted download cannot be found by name
  // and mistaken for a complete one. The checksum would catch it either way; this
  // keeps the failure from costing an extraction first.
  renameSync(partial, into)
}

export interface WorkbenchRuntime {
  readonly remoteAuthority: string
  readonly connectionToken: string
  readonly commit: string
  readonly quality: string
}

interface RunningHost {
  readonly child: ChildProcess
  readonly runtime: WorkbenchRuntime
  /** Kept until the server stops, because the server reads it per connection. */
  readonly tokenFile: string
}

let host: RunningHost | null = null
let starting: Promise<WorkbenchRuntime> | null = null
/** The lease, by project. Never by view, never by connection. */
const leases = new Set<string>()

/**
 * Every server process this main has spawned and not yet seen exit — and it is a
 * set rather than a single reference because that is what makes "no orphan" a
 * property instead of a race analysis.
 *
 * A child exists from the moment `spawn` returns, which is well before it becomes
 * `host`: it has to report a port first, and that wait can time out, throw, or be
 * overtaken by a shutdown. Tracking only the *successful* one leaves three ways to
 * strand a 257 MB server — a start that failed after spawning, a start still in
 * flight when the app quits, and a start that completes after shutdown has already
 * decided there was nothing to stop. Shutdown kills whatever is in here, so all
 * three collapse into one case.
 */
const spawned = new Set<ChildProcess>()

/**
 * Set once shutdown has begun, and never cleared: an app that is quitting does not
 * start a remote extension host, whatever arrives on the IPC channel afterwards.
 */
let shuttingDown = false
/**
 * What a shutdown actually achieved, rather than what it attempted.
 *
 * `survivors` exists because the alternative is a function that always reports
 * success: a caller that logs "stopped 1" when a group is still running has been
 * told something false by a design that made it impossible to tell the truth.
 */
export interface ShutdownResult {
  readonly stopped: number
  readonly survivors: readonly number[]
}

/** Memoised, so quit, `SIGTERM` and `SIGINT` are one shutdown rather than three. */
let stopping: Promise<ShutdownResult> | null = null
/**
 * The in-flight start's cancellation, held here because shutdown has to reach it.
 *
 * A promise can be awaited but not stopped, and awaiting was the whole defect: a
 * shutdown that arrived during a 76 MB download waited for the download.
 */
let startAbort: AbortController | null = null

/**
 * Why the server is gone, when it went without being asked — and the reason this
 * is a dead end rather than a restart.
 *
 * Re-spawning would hand the next project a **new port**, and the workbench
 * session's CSP is built once with the first authority baked into it
 * (`workbench-surface.ts`'s `workbenchSession`). A second server would therefore
 * be refused by a `connect-src` that names the first one, and the surface would
 * open, connect to nothing, and render an empty tree — the same indistinguishable
 * failure the connection-token bug produced. Surface recreation and a dynamic CSP
 * authority have to be designed together; until they are, this fails closed and
 * says so.
 */
let hostFailure: string | null = null

/**
 * The port, read back out of the child's own stdout — never chosen, never
 * scanned, never assumed.
 *
 * This is `CLAUDE.md`'s e2e-harness rule one level out: attaching to a stale REH
 * from a previous run, possibly at a *different commit*, presents as a workbench
 * that works and is wrong, which is exactly what attaching to whatever owned port
 * 9800 produced. Never attach to a port Chorus did not open.
 *
 * **The line is not the one preflight §5.4 predicted, and that is a correction
 * worth carrying.** §5.4 says to parse `Web UI available at
 * http://localhost:<port>?tkn=<token>`. That line belongs to the `reh-web`
 * artifact, which bundles a web workbench; the plain `reh` — the one §2.1
 * correctly chose, because Chorus supplies its own workbench — never prints it.
 * Observed on `vscodium-reh-darwin-arm64-1.121.03429`, the whole of what it says
 * is:
 *
 *     Server bound to 127.0.0.1:50751 (IPv4)
 *     Extension host agent listening on 50751
 *
 * A reader waiting for the predicted line would have hung forever on a server
 * that had started perfectly. Both forms are accepted so a future artifact that
 * prints the other still works.
 */
export function readServerPort(text: string): number | null {
  const listening = /Extension host agent listening on (\d+)/.exec(text)?.[1]
  if (listening !== undefined) return Number.parseInt(listening, 10)
  const bound = /Server bound to \S+?:(\d+)/.exec(text)?.[1]
  if (bound !== undefined) return Number.parseInt(bound, 10)
  const web = /Web UI available at https?:\/\/[^:]+:(\d+)/.exec(text)?.[1]
  return web === undefined ? null : Number.parseInt(web, 10)
}

/** `tkn=` never reaches a log, even though this artifact turns out not to print one. */
export function redactToken(line: string): string {
  return line.replace(/([?&]tkn=)[^&\s]+/g, '$1REDACTED')
}

/**
 * The server's own Node and its entry script — **never the shipped launcher**,
 * and the reason is the leak rather than tidiness.
 *
 * `bin/codium-server` is a bash script, and its last line is
 * `"$ROOT/node" ${INSPECT:-} "$ROOT/out/server-main.js" "$@"` — **without `exec`**.
 * So bash stays alive as the server's parent, Chorus's child is the *wrapper*, and
 * `child.kill()` kills a shell while the 257 MB Node process it started carries on
 * holding the port. That is exactly what was measured: of the two PIDs matching a
 * run's `--server-data-dir`, the wrapper died and the node process survived a clean
 * `code=0` app exit.
 *
 * On Windows the same file is `bin/codium-server.cmd`, and Node's own
 * documentation is explicit that `.cmd` cannot be executed by `spawn` without a
 * shell — so the previous code selected a path that could not run at all. The two
 * problems have one answer: skip the launcher and run what the launcher runs. That
 * is shell-free on every platform, needs no quoting, and makes Chorus's direct
 * child the actual server.
 *
 * **The Windows half is inferred from the artifact layout and has not been
 * observed**: no `win32-x64` tarball has been downloaded, so `node.exe` at the
 * tree root is upstream's convention rather than something seen here. Both paths
 * are checked before spawning, so an artifact that disagrees fails with the name
 * of the missing file rather than as a spawn error nobody can read.
 */
export function serverLauncher(dir: string): { readonly node: string; readonly script: string } {
  return {
    node: join(dir, process.platform === 'win32' ? 'node.exe' : 'node'),
    script: join(dir, 'out', 'server-main.js'),
  }
}

/** How long a `SIGTERM`ed tree gets before it is killed outright. */
const TERM_GRACE_MS = 5_000
/** And how long the force-kill itself gets before we stop waiting for the kernel. */
const KILL_GRACE_MS = 2_000
/**
 * How long shutdown will wait for a start that is still in flight, and it is
 * short on purpose.
 *
 * Awaiting the start *unboundedly* is what the first version did, and it made the
 * app hang on a stalled download — for as long as the network took, or sixty
 * seconds on the port wait. That became a new failure the moment `SIGTERM` was
 * handled rather than left to Electron's default termination: quitting Chorus
 * could simply stop responding. The start is **cancelled** rather than waited out,
 * and this budget is only how long its unwinding is given before shutdown stops
 * caring and kills whatever is in `spawned` anyway.
 */
const START_ABORT_MS = 2_000

/**
 * Signals the server **and everything it forked**, which is the whole point of
 * spawning it detached.
 *
 * The REH forks an extension host per connection and a file watcher, and those are
 * children of the server rather than of Chorus — so signalling one PID leaves a
 * fan of processes that nothing will ever reap. `detached: true` on POSIX puts the
 * server in its own process group, and a negative PID signals that group, so one
 * call reaches the tree.
 *
 * The negative PID is why `detached` and this function must stay in step: with a
 * non-detached child, `-pid` would name **Chorus's own group** and the app would
 * signal itself. The guard is that this is the only place a negative pid is used
 * and it is written beside the spawn that earns it.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    /*
     * Windows has no process groups to signal. `taskkill /T` walks the tree and
     * `/F` is unconditional — there is no graceful equivalent, so the two phases
     * below collapse into one here. Unproven, like the rest of the Windows path.
     */
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already gone, or never started: both are the state we wanted */
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already empty, which is success. Any other failure is
    // not actionable here either — the caller's job is to observe, not to insist.
    try {
      child.kill(signal)
    } catch {
      /* the direct child is gone too */
    }
  }
}

/**
 * Whether **any** process in the server's group is still alive.
 *
 * Signal 0 asks the kernel and sends nothing, and asking it of a negative pid asks
 * about the whole group — so this answers "is the tree dead?" rather than "is the
 * process I spawned dead?", which is the question that matters and the one a
 * single `exitCode` check gets wrong.
 */
function treeAlive(child: ChildProcess): boolean {
  const pid = child.pid
  if (pid === undefined) return false
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForTreeToDie(child: ChildProcess, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!treeAlive(child)) return true
    await new Promise((settle) => setTimeout(settle, 100))
  }
  return !treeAlive(child)
}

/**
 * Ends one server's whole tree: ask, wait, force, wait — then stop tracking it.
 *
 * Shared by shutdown and by the **unexpected-exit** path, and that second caller
 * is why it exists. The exit listener used to drop the child from `spawned` the
 * moment the root process died, which reads as "cleaned up" and is not: the root
 * is the server, and the extension hosts and file watchers it forked are its
 * children. A server that crashes therefore left exactly the fan of processes this
 * whole item is about, arriving by a different route from the one that was fixed.
 * The root being gone says nothing about the group, so the group is what gets
 * asked.
 */
async function reapTree(child: ChildProcess): Promise<boolean> {
  if (treeAlive(child)) {
    signalTree(child, 'SIGTERM')
    if (!(await waitForTreeToDie(child, TERM_GRACE_MS))) {
      signalTree(child, 'SIGKILL')
      await waitForTreeToDie(child, KILL_GRACE_MS)
    }
  }
  /*
   * **The answer is read, and a survivor is kept.**
   *
   * This used to delete the child unconditionally and return nothing, so every
   * caller could say "reaped" and none of them could be wrong — a measurement that
   * cannot fail, which is the same shape as signalling an `npx` wrapper and
   * reporting on the app, or supplying a port by hand and reporting on a start.
   * A process group can outlive `SIGKILL`: uninterruptible sleep in a syscall, a
   * stuck filesystem, a zombie whose parent never reaps it. Dropping it from
   * `spawned` at that point loses the only handle anything has on it, and the next
   * shutdown would not know to try again.
   */
  const dead = !treeAlive(child)
  if (dead) spawned.delete(child)
  return dead
}

/**
 * A backstop for servers left behind by a **force-quit** — the case no handler can
 * cover, and one this change made more likely rather than less.
 *
 * Every ordered shutdown now stops the tree, but `SIGKILL` and a hard power-off run
 * no handler at all, and the server is spawned **detached** so that shutdown can
 * signal its process group. Detaching makes it a session leader, which is exactly
 * what stops it dying with its parent — the property that makes the ordered path
 * work makes the disordered one worse. So the next launch has to clean up.
 *
 * **Identified by this profile's own `--server-data-dir`, never by executable
 * name.** Matching on `node`, or on `server-main.js`, would put Chorus in the
 * business of killing processes because they look like a code server — including
 * somebody's own editor, or a second Chorus profile's live server. The data
 * directory is a path only this profile passes.
 *
 * **And only when reparented to init.** A candidate whose parent is still alive
 * belongs to a running Chorus — a second window, a second profile sharing this one
 * by accident — and killing it would take down a live session. PPID 1 is a fact
 * about the process as it is now, where a recorded pid file goes stale the instant
 * the app it described crashed. This is `reap.ts`'s rule, applied to a second kind
 * of child.
 *
 * The whole **group** is killed, because the orphan leads one.
 */
/**
 * The reap, run **once** and awaited by anything that would start a server.
 *
 * `index.ts` kicks this off at `whenReady` so the wait is normally already over,
 * but starting it there is not the same as depending on it: the call was
 * fire-and-forget, and opening a project is a renderer request that can arrive in
 * the same tick the window finishes loading. A new server would then be spawned
 * **while the orphan still owned this profile's server-data directory and token
 * file** — two servers, one data directory, and the newer one writing a token the
 * older one is still reading.
 *
 * Memoised rather than re-run per start, because the answer cannot change: after
 * the first pass there are no orphans of a *previous* launch left to find.
 */
let reapBarrier: Promise<ReapResult> | null = null

export function reapedOrphanedServers(
  platform: NodeJS.Platform = process.platform
): Promise<ReapResult> {
  reapBarrier ??= reapOrphanedWorkbenchServers(platform)
  return reapBarrier
}

export interface ReapResult {
  /** Confirmed dead — signalled **and** observed to have gone, never merely asked. */
  readonly killed: number
  /** Every candidate carrying this profile's marker, killed or deliberately left. */
  readonly inspected: number
  /**
   * Still alive when the sweep gave up, and the reason this field exists.
   *
   * `killed` used to be `signalled.length`: the count of `SIGKILL`s **sent**. A
   * signal is a request, and a process group can refuse one — uninterruptible
   * sleep in a syscall, a stuck NFS mount, a zombie whose parent never reaps it. So
   * the old result reported success for having asked, which is the same defect as
   * a shutdown that signalled an `npx` wrapper and reported on the app, and the
   * same one `reapTree` had on the other side of this module. A reaper that cannot
   * fail is a reaper that tells you nothing.
   *
   * Anything in here **owns this profile's server-data directory and token file**,
   * so `start` refuses to spawn beside it.
   */
  readonly survivors: readonly number[]
  /**
   * Why the sweep did not run, or `null` when it did — and the two reasons are
   * kept apart because a caller has to treat them oppositely.
   *
   * This was a boolean, and that made "the platform has no strategy" and "the
   * process table could not be read" the same value. `start` then read an empty
   * `survivors` from a sweep that had **never happened** and spawned anyway: the
   * unanswered question treated as a clean answer, which is the fail-open shape
   * this module keeps producing. `'unsupported-platform'` is a decision already
   * taken and is allowed through; `'sweep-failed'` means Chorus does not know what
   * is running on this profile, and not knowing is a refusal.
   */
  readonly skipped: 'unsupported-platform' | 'sweep-failed' | null
}

/** Signal 0 asks the kernel and sends nothing. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function reapOrphanedWorkbenchServers(
  platform: NodeJS.Platform = process.platform
): Promise<ReapResult> {
  /*
   * Off on Windows, visibly rather than by accident — the same decision `reap.ts`
   * records for agents, for the same reasons. There is no PPID-1 reparenting
   * convention to identify an orphan by, `SIGKILL` is not a Windows signal, and a
   * command-line match without the parent check is precisely the "kill it because
   * it looks like a code server" mistake. Reporting `skipped` is at least true;
   * a confident `killed: 0` would be indistinguishable in the log from a clean
   * machine.
   */
  if (platform === 'win32')
    return { killed: 0, inspected: 0, survivors: [], skipped: 'unsupported-platform' }

  const marker = `--server-data-dir ${join(serverDataDir(), 'server')}`
  let listing: string
  try {
    // Asynchronous, because this runs at boot and walking the whole process table
    // is not something to do on the main thread while a window is being built.
    ;({ stdout: listing } = await runCommand('ps', ['-Awwo', 'pid=,ppid=,command='], {
      timeout: 5_000,
    }))
  } catch {
    // The process table could not be read. That is not "nothing is running" — it
    // is "Chorus cannot tell", and the difference is the whole of this field.
    return { killed: 0, inspected: 0, survivors: [], skipped: 'sweep-failed' }
  }

  const candidates: { pid: number; orphaned: boolean }[] = []
  for (const line of listing.split('\n')) {
    // A substring match rather than a pattern: the data directory is a real path
    // and `pgrep -f` would read its punctuation as a regular expression.
    if (!line.includes(marker)) continue
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number)
    if (pid === undefined || !Number.isInteger(pid) || pid === process.pid) continue
    candidates.push({ pid, orphaned: ppid === 1 })
  }

  const signalled: number[] = []
  for (const { pid, orphaned } of candidates) {
    if (!orphaned) continue
    try {
      process.kill(-pid, 'SIGKILL')
      signalled.push(pid)
    } catch {
      /* gone between the listing and the signal, which is the state we wanted */
    }
  }
  /*
   * **The token a force-quit left behind, and only once nothing is using it.**
   *
   * The killing above leaves `<server-data>/connection-token` on disk: it is
   * removed by paths that hang off a *running* child, and the orphan's child
   * belonged to a process that is gone. Nothing came back for it — it sat there
   * until some later server happened to overwrite the same path, which is a
   * credential outliving every process that could have used it.
   *
   * The condition is what makes it safe. A candidate whose parent is alive belongs
   * to a **running** Chorus on this profile, and that server reads this file on
   * every connection — deleting it would refuse its handshakes silently, which is
   * §5.3's failure inflicted on somebody else's session. So: nothing alive for this
   * profile, or the file stays.
   */
  /*
   * Waited for, because a process that has just been `SIGKILL`ed still answers.
   *
   * The kernel tears a process down asynchronously and leaves a zombie until its
   * parent reaps it, so `kill(pid, 0)` sampled in the statement after the signal
   * reports the orphan alive — and the token then stayed on disk on exactly the
   * run that had just cleaned up. Caught end to end by the relaunch gate while the
   * unit test passed, because the fake kernel kills synchronously and nothing in
   * it can be a zombie. It is the same error this work keeps finding in its own
   * measurements: reading the answer before the thing has happened.
   */
  const settleBy = Date.now() + 3_000
  // Only the ones **we signalled**. A candidate with a live parent belongs to a
  // running session and is supposed to still be there — waiting on it would be
  // waiting for something that must not happen, for the full budget, every time.
  while (signalled.some((pid) => processAlive(pid)) && Date.now() < settleBy) {
    await new Promise((settle) => setTimeout(settle, 100))
  }

  /*
   * Counted from what the kernel says now, not from what was asked for. `killed`
   * is the signalled set that actually went; `survivors` is everything carrying
   * this profile's marker that is still there — the orphan that ignored `SIGKILL`
   * and the live session's server alike, because for the purpose of "may a new
   * server start here?" they are the same fact.
   */
  const survivors = candidates.map(({ pid }) => pid).filter((pid) => processAlive(pid))
  const killed = signalled.filter((pid) => !processAlive(pid)).length

  if (survivors.length === 0) rmSync(join(serverDataDir(), 'connection-token'), { force: true })

  /*
   * `inspected` counts **every** candidate carrying this profile's marker, not just
   * the ones killed — so `inspected > killed` is visible and means "some of these
   * belong to a live session and were deliberately left". Counting only the
   * orphans would make the two numbers agree by construction, which is a log line
   * that cannot report anything.
   */
  return { killed, inspected: candidates.length, survivors, skipped: null }
}

async function start(): Promise<WorkbenchRuntime> {
  /*
   * The start is **cancellable**, not merely awaitable — which is the difference
   * between a shutdown that is bounded and one that hopes.
   *
   * Everything above the spawn can block for a long time on someone else's
   * schedule: a 76 MB download on a bad connection, a checksum over it, a 257 MB
   * extraction. Shutdown used to `await starting` with no bound, so quitting
   * during any of that waited for it to finish. Aborting is what turns those into
   * steps that stop when asked.
   */
  const abort = new AbortController()
  startAbort = abort
  const abortedError = (): Error => new Error('The workbench server start was cancelled.')
  /*
   * Read through a call rather than as `abort.signal.aborted`, and the reason is a
   * checker artefact worth naming: TypeScript narrows the property of a freshly
   * constructed controller to `false`, so every check against it reads as dead code
   * and the linter says so. The value plainly does change — that is what an
   * `AbortController` is — so the fix is to stop the narrowing rather than to
   * silence the rule.
   */
  const cancelled = (): boolean => abort.signal.aborted

  const { manifest, sha256: manifestSha256 } = loadManifest(manifestPath())
  const key = platformKey()
  const artifact = manifest.server.artifacts[key]
  if (artifact === undefined) {
    /*
     * A missing manifest entry is an unsupported target, stated in the manifest
     * rather than discovered here — which is where `win32-arm64` lives, since
     * VSCodium has never published one, in the current release or in any of the
     * last thirty.
     */
    throw new Error(`No ${manifest.server.vendor} server is published for ${key}`)
  }

  const archive = join(cacheDir(), artifact.name)
  if (!existsSync(archive) || statSync(archive).size !== artifact.size) {
    await download(
      `https://github.com/VSCodium/vscodium/releases/download/${manifest.server.release}/${artifact.name}`,
      archive,
      artifact.size,
      abort.signal
    )
  }
  if (cancelled()) throw abortedError()

  const root = extractionRoot()
  const dir = await publishServer({
    root,
    finalName: `${manifest.server.release}-${key}`,
    archive,
    expectedSha256: artifact.sha256,
    clientCommit: manifest.client.vscodeCommit,
    receipt: {
      artifact: artifact.name,
      manifestSha256,
      vendor: manifest.server.vendor,
      release: manifest.server.release,
      upstreamTag: manifest.server.upstreamTag,
      upstreamCommit: manifest.server.upstreamCommit,
    },
  })

  // Checked either side of the slow steps rather than only at the top: an abort
  // that arrives during a 257 MB extraction should not be discovered after a spawn.
  if (cancelled()) throw abortedError()

  // After the new tree is serving its first spawn, not before it: a sweep is
  // restartable and costs disk, where doing it first would delay every open.
  try {
    sweepQuarantine(root, readdirSync(root))
  } catch {
    /* garbage nothing reads; a failed sweep is not a failed open */
  }

  const data = serverDataDir()
  mkdirSync(data, { recursive: true })
  // 0700, because §5.3's own advice for the token file is to put it in one.
  chmodSync(data, 0o700)

  /*
   * Generated per launch, and by Chorus rather than by the server.
   *
   * Left to itself the server generates a UUID **once**, writes it to
   * `<user-data-dir>/token` and reuses it on every subsequent launch — a
   * long-lived secret on disk, which is not what "a random connection token per
   * launch" means. The charset is `[0-9A-Za-z_-]+`, which a UUID satisfies and
   * plain base64 does not: `+`, `/` and `=` are all rejected and the server exits
   * at startup rather than failing at connection time.
   *
   * Passed as a **file**, never on the argv. An inline token is visible in `ps`
   * to every user on the machine for the process's whole life — CVE-2024-26165 —
   * and Microsoft's own CLI now refuses the inline form outright.
   */
  /*
   * The launcher is validated **before** the token is written, and the ordering is
   * the fix rather than tidiness.
   *
   * Written first, a throw here — a Windows artifact whose layout is not the one
   * inferred, an extraction that lost a file — left a live connection token on
   * disk with no process that would ever remove it, because every path that does
   * remove one hangs off a child that in this case was never spawned. Nothing
   * comes back for it until some later server happens to overwrite the same path.
   * Checking first means the credential does not exist until there is something to
   * use it.
   */
  /*
   * The barrier, awaited here rather than trusted to have finished — and **its
   * answer is read**, which is the half that was missing.
   *
   * Awaiting a promise that resolves successfully while an orphan is still running
   * is a barrier in name only: the sweep sends `SIGKILL`, waits three seconds, and
   * a group that ignored the signal is still sitting on this profile's
   * `--server-data-dir`. Spawning beside it means two servers with one data
   * directory, one extensions lock and one token file, the newer one overwriting a
   * credential the older one is still reading — and neither of them wrong from its
   * own point of view.
   *
   * So the survivors are re-checked **now** rather than trusted from the sweep:
   * one may have been reaped by init in the meantime, and a refusal that outlives
   * its reason is its own kind of wrong. Refusing happens **before the token is
   * written and before anything is spawned**, so a refused start leaves the
   * profile exactly as it found it.
   */
  const reaped = await reapedOrphanedServers()
  if (cancelled()) throw abortedError()
  /*
   * **A sweep that did not run is a refusal, not a clean bill of health.**
   *
   * `skipped` used to be a boolean and this code read only `survivors`, so a `ps`
   * that failed produced an empty list and a server was spawned having checked
   * nothing — the same fail-open shape as counting signals sent, one level up. If
   * Chorus cannot read the process table it cannot know whether a previous
   * session's server still owns this profile's data directory, and the honest
   * answer to "may I start one?" is no.
   *
   * Windows is exempt because the sweep is *deliberately* absent there rather than
   * broken — see the reaper's own note — and that exemption is as unverified as
   * everything else about Windows.
   */
  if (reaped.skipped === 'sweep-failed') {
    throw new Error(
      'Chorus could not check for a workbench server left by an earlier session, so it will not start one. Restart Chorus and try again.'
    )
  }
  const stillOwning = reaped.survivors.filter((pid) => processAlive(pid))
  if (stillOwning.length > 0) {
    throw new Error(
      `A workbench server from an earlier session is still running (pid ${stillOwning.join(', ')}) and owns this profile's data directory. Quit that process, or restart Chorus, before opening a project.`
    )
  }

  const { node, script } = serverLauncher(dir)
  for (const required of [node, script]) {
    if (!existsSync(required)) {
      throw new Error(`The workbench server is missing ${required}; the extraction is unusable.`)
    }
  }

  const connectionToken = randomUUID()
  const tokenFile = join(data, 'connection-token')
  writeFileSync(tokenFile, connectionToken, { mode: 0o600 })
  const child = spawn(
    node,
    [
      script,
      '--host',
      '127.0.0.1',
      // Zero, and the child tells us which one it got.
      '--port',
      '0',
      '--connection-token-file',
      tokenFile,
      '--server-data-dir',
      join(data, 'server'),
      '--extensions-dir',
      join(data, 'extensions'),
      '--user-data-dir',
      join(data, 'data'),
      '--accept-server-license-terms',
      '--telemetry-level',
      'off',
      // Never `trace`: full request URLs, token included, are logged at that level.
      '--log',
      'info',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      /*
       * Its own process group, so shutdown can signal the tree rather than the
       * root of it — see `signalTree`. Never `unref`ed: detaching is about
       * *addressing* the group, not about letting it outlive us, and unreferencing
       * would do exactly the harm this change exists to undo.
       */
      detached: process.platform !== 'win32',
      windowsHide: true,
    }
  )
  spawned.add(child)

  /*
   * The one listener that outlives startup, and it answers a defect the old code
   * could not: `host` was never cleared when the server died on its own.
   *
   * The exit handler inside the port race below is scoped to the race — after it
   * resolves, nothing was watching. So a server that crashed, was OOM-killed, or
   * was stopped from a terminal left `host` holding a runtime whose port belonged
   * to nothing, and every later `acquireWorkbenchRuntime` handed that dead
   * authority to a new surface. The workbench then opened, failed to connect, and
   * rendered an empty tree — indistinguishable from an empty project.
   *
   * It fails **closed**: no re-spawn, and the next open is refused with a reason.
   * A new server means a new port, and the workbench session's CSP was built with
   * the first authority in it, so a silent restart would trade a legible error for
   * a surface that connects to nothing.
   */
  child.on('exit', (code, signal) => {
    const wasHost = host?.child === child
    if (wasHost) {
      host = null
      hostFailure = `The workbench server stopped unexpectedly (code ${String(code)}, signal ${String(signal)}). Restart Chorus to open a project again.`
    }
    /*
     * **The group, not just the process that exited.** Dropping the child from
     * `spawned` here is what the first version did, and it reads as cleanup while
     * leaving the extension hosts and file watchers the server forked still
     * running — the original leak arriving by a different route. `reapTree` is what
     * removes it from `spawned`, once there is nothing left in its group.
     *
     * The token goes with it: the process that needed it is gone, and on every
     * exit — expected or not, before startup finished or long after — a per-launch
     * credential for a server that no longer exists is one file too many.
     */
    void reapTree(child).finally(() => {
      rmSync(tokenFile, { force: true })
    })
  })

  /*
   * `error` as well as `exit`, because they are different failures and only one of
   * them was handled. `spawn` reports ENOENT, EACCES and EAGAIN here and **never
   * emits `exit`** — so a server binary that is present but not executable used to
   * leave the port wait running for its full sixty seconds before failing with
   * "did not report a port", which describes the symptom of a permissions error
   * rather than the error. An unhandled `error` on a `ChildProcess` is also a
   * throw at the top level, which in main is a crash.
   */
  let spawnError: Error | null = null
  child.on('error', (error: Error) => {
    spawnError = error
  })

  /*
   * The server's own output, kept — and it is not a debugging leftover.
   *
   * Everything interesting about a remote extension host happens *after* the
   * port is up: a refused handshake, a rejected token, an extension host that
   * forked and died. None of that reaches Chorus's UI, and once the port has been
   * parsed there is nothing else reading this pipe, so without a sink the process
   * runs blind and a workbench that fails to connect looks identical to one whose
   * project is empty. Redacted on the way in rather than at the call site, so a
   * `tkn=` cannot arrive here by a route nobody thought about.
   */
  const logFile = join(app.getPath('userData'), 'logs', 'workbench-server.log')
  mkdirSync(join(app.getPath('userData'), 'logs'), { recursive: true })
  const record = (chunk: Buffer): void => {
    try {
      appendFileSync(logFile, redactToken(chunk.toString()))
    } catch {
      /* a log that cannot be written must not take the server down with it */
    }
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)

  let output = ''
  /*
   * Wrapped, because a start that fails **after** the spawn used to leave the
   * server running. The port wait can time out at sixty seconds on a machine under
   * load, and the old code let that rejection propagate with the child still
   * holding its port — an orphan created by the very path that reports failure.
   */
  const port = await awaitPort(
    child,
    (chunk) => (output += chunk),
    abort.signal,
    () => spawnError
  ).catch(async (error: unknown) => {
    await reapTree(child)
    rmSync(tokenFile, { force: true })
    throw error
  })

  /*
   * The window between the port being read and `host` being assigned, which was
   * open and is now closed.
   *
   * `awaitPort` resolves on a line of stdout; the process can die in the next
   * millisecond — a token the server rejects, an extensions directory it cannot
   * lock. The exit listener fires, finds `host` still `null`, and correctly
   * concludes this is not the running host; then the line below assigned that dead
   * child to `host` anyway. The result was the exact failure the listener exists to
   * prevent, reached by winning a race instead of by nobody watching.
   */
  if (child.exitCode !== null || child.signalCode !== null) {
    await reapTree(child)
    rmSync(tokenFile, { force: true })
    throw new Error(
      `The workbench server exited immediately after reporting its port:\n${redactToken(output)}`
    )
  }

  /*
   * And a shutdown that began while this start was in flight wins. `stopWorkbenchHost`
   * waits for `starting` before it decides what to kill, so this cannot strand a
   * child — but it can still hand a *runtime* to a caller after the app has decided
   * to quit, which would open a surface onto a server that is about to be signalled.
   * Refusing here keeps "shutting down" a one-way door.
   */
  if (shuttingDown || cancelled()) {
    await reapTree(child)
    rmSync(tokenFile, { force: true })
    throw new Error('Chorus is shutting down; the workbench server was not started.')
  }

  const runtime: WorkbenchRuntime = {
    remoteAuthority: `127.0.0.1:${String(port)}`,
    connectionToken,
    commit: manifest.client.vscodeCommit,
    quality: manifest.client.quality,
  }
  host = { child, runtime, tokenFile }
  return runtime
}

/**
 * The port race — and every listener it adds, it removes.
 *
 * The `data` handlers were left attached after the promise settled, so for the
 * life of the server every line it printed was still being appended to a string
 * nobody would read again: a slow leak whose size is however chatty the extension
 * hosts are. `off` in one `settle` closure is also what makes the four ways out of
 * here symmetrical — port, exit, spawn error, cancellation — rather than three
 * that clean up and one that does not.
 */
function awaitPort(
  child: ChildProcess,
  append: (chunk: string) => string,
  signal: AbortSignal,
  spawnError: () => Error | null
): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    let seen = ''
    const settle = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      settle()
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new Error(`The workbench server did not report a port:\n${redactToken(seen)}`))
    }, 60_000)
    const onData = (chunk: Buffer): void => {
      seen = append(chunk.toString())
      const found = readServerPort(seen)
      if (found === null) return
      settle()
      resolvePort(found)
    }
    const onExit = (code: number | null): void => {
      // A malformed or conflicting token argument is fatal rather than a
      // warning: the server warns and exits 1, so a bad token file shows up
      // exactly here, as a child that never opened a port. `spawnError` is
      // preferred when there is one, because ENOENT explains an exit that
      // "exited with null" does not.
      const failure = spawnError()
      fail(
        failure ??
          new Error(`The workbench server exited with ${String(code)}:\n${redactToken(seen)}`)
      )
    }
    const onError = (error: Error): void => {
      /*
       * `spawn` reports ENOENT, EACCES and EAGAIN here and emits **no** `exit`, so
       * without this arm a server binary that is present but not executable waited
       * out the full sixty seconds and then reported "did not report a port" — the
       * symptom rather than the cause. It is also the arm that keeps an unhandled
       * `error` on a `ChildProcess` from becoming a main-process crash.
       */
      fail(error)
    }
    const onAbort = (): void => {
      fail(new Error('The workbench server start was cancelled.'))
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', onExit)
    child.on('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * The lease. Acquired on project **open**, released on project **close**, and
 * unmounting a surface calls neither.
 *
 * Resolved and verified when a project is opened rather than at app boot, which
 * is `terminal.ts`'s discipline for the native module one level out: an app that
 * will not start because a 76 MB artifact is missing is worse than a project that
 * will not open.
 */
export async function acquireWorkbenchRuntime(projectRoot: string): Promise<WorkbenchRuntime> {
  /*
   * Two refusals before anything is leased, and both are one-way doors.
   *
   * A quitting app does not start a server: the IPC channel is still live while
   * windows are closing, so an `openWorkbench` can arrive after shutdown has begun
   * and would otherwise spawn the orphan the whole change exists to prevent.
   *
   * And a server that died on its own is not replaced. Re-spawning would mean a new
   * port behind a CSP built for the old one, so the surface would open and connect
   * to nothing — a legible refusal now beats an empty tree with no cause on screen.
   */
  if (shuttingDown) throw new Error('Chorus is shutting down; no workbench project can open.')
  if (hostFailure !== null) throw new Error(hostFailure)

  leases.add(projectRoot)
  if (host !== null) return host.runtime
  // One start, however many projects arrive while it is in flight.
  starting ??= start().finally(() => {
    starting = null
  })
  try {
    return await starting
  } catch (error) {
    leases.delete(projectRoot)
    throw error
  }
}

export function releaseWorkbenchRuntime(projectRoot: string): void {
  leases.delete(projectRoot)
  /*
   * Deliberately does **not** stop the server at zero.
   *
   * Closing the last project leaves the process running until quit, because the
   * cost of keeping it is one idle Node process and the cost of getting this
   * wrong is a killed build. `stopAll` on `will-quit` stays the only
   * unconditional kill, exactly as §5.4 specifies.
   */
}

/**
 * `stopAll()` — §5.4, and now one shutdown rather than three.
 *
 * **Asynchronous**, because the only honest version of "the server is stopped" is
 * one that waited to see it. **Idempotent**, because normal quit, `SIGTERM` and
 * `SIGINT` all arrive here and two of them can arrive together — a memoised
 * promise makes the second caller wait for the first shutdown instead of starting
 * a second one against a tree that is already dying. **Shared**, because three
 * shutdown paths are three chances for one of them to be the wrong one.
 *
 * It was none of those. It sent `SIGTERM` to a bash wrapper, unlinked the token in
 * the next statement and returned — so the app exited while the real server was
 * still alive, holding its port, its extensions directory and a 257 MB tree. Two
 * consecutive gate runs measured exactly that: Electron exiting `code=0` with the
 * node process still alive fifteen seconds later.
 */
export function stopWorkbenchHost(): Promise<ShutdownResult> {
  stopping ??= shutdown()
  return stopping
}

async function shutdown(): Promise<ShutdownResult> {
  shuttingDown = true

  /*
   * **Cancel the start, then give it a bounded moment to unwind — never wait it
   * out.**
   *
   * The first version awaited `starting` with no bound, reasoning that a spawn
   * must not land after shutdown had decided there was nothing to kill. The
   * reasoning was right and the implementation made the app hang: a stalled
   * download or the sixty-second port wait became the time Chorus took to quit,
   * and once `SIGTERM` was handled here rather than by Electron's default
   * termination, that was a quit that appeared to do nothing.
   *
   * Two things make the bound safe rather than a gamble. The abort actually stops
   * the start at its next step, so the wait is normally over immediately. And the
   * guarantee never depended on the wait anyway: every child is in `spawned` from
   * the moment `spawn` returns, and a start that completes after this point finds
   * `shuttingDown` set and reaps its own child. The wait is a courtesy that lets
   * the start clean up its own mess first; it is not what makes the mess
   * impossible.
   */
  startAbort?.abort()
  const inFlight = starting
  if (inFlight !== null) {
    await Promise.race([
      inFlight.catch(() => undefined),
      new Promise((settle) => setTimeout(settle, START_ABORT_MS)),
    ])
  }

  const running = host
  host = null

  /*
   * Everything spawned, not just the one that became `host` — the set is what
   * makes this exhaustive rather than a list of the cases somebody thought of.
   * In parallel, because three trees taking their grace period one after another
   * is three times the delay for no gain.
   */
  const outcomes = await Promise.all(
    [...spawned].map(async (child) => ({ child, dead: await reapTree(child) }))
  )
  const survivors = outcomes
    .filter((outcome) => !outcome.dead)
    .map((outcome) => outcome.child.pid)
    .filter((pid): pid is number => pid !== undefined)

  /*
   * **The token goes last, and only now that the tree is gone.**
   *
   * Preflight §5.3 said to delete it "as soon as the server reports ready", on the
   * reasoning that it is read once at startup. It is not: the server reads it again
   * on **every** connection, so deleting it early made every handshake fail with
   * `Unable to read the connection token file` — and silently, because a refused
   * handshake registers no `vscode-remote` provider and therefore raises no error.
   * "The folder looks empty" and "the server refused us" are the same picture.
   *
   * The same mistake one step along the timeline is deleting it beside the signal:
   * `SIGTERM` is a request, and between the request and the exit the server is
   * still accepting sockets. So the unlink waits for the tree to be *dead*. What
   * remains protecting the secret is what was always doing the work — per-launch,
   * never on the argv (CVE-2024-26165), `0600` inside a `0700` directory.
   */
  /*
   * And the token only if nothing survived. A group that outlived `SIGKILL` may
   * still be serving, and it reads this file on every connection — so removing it
   * while a survivor holds the port is the §5.3 mistake once more, applied to the
   * case where the kill did not work rather than to the case where it had not
   * happened yet.
   */
  if (running !== null && survivors.length === 0) rmSync(running.tokenFile, { force: true })
  return { stopped: outcomes.length - survivors.length, survivors }
}

/** For the tests and for a future `describe`: the observed state, not the intended one. */
export function workbenchHostState(): {
  readonly running: boolean
  readonly leases: number
  /** Non-null once the server has gone without being asked. Never cleared. */
  readonly failure: string | null
  /** Spawned and not yet seen to exit — zero is the property shutdown promises. */
  readonly spawned: number
} {
  return {
    running: host !== null,
    leases: leases.size,
    failure: hostFailure,
    spawned: spawned.size,
  }
}
