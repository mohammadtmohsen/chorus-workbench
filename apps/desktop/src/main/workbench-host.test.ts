import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest'
import type * as HostModule from './workbench-host.js'

/**
 * The host's shutdown, and only that — E4.
 *
 * Two consecutive gate runs measured Electron exiting `code=0` with the remote
 * extension host still alive fifteen seconds later. The mechanism was not subtle
 * once the launcher was read: `bin/codium-server` is a bash script whose last line
 * runs `"$ROOT/node" "$ROOT/out/server-main.js" "$@"` **without `exec`**, so
 * Chorus's child was a shell, `child.kill()` killed the shell, and the 257 MB Node
 * process it had started carried on holding the port.
 *
 * Everything here is about the properties that were missing rather than about the
 * happy path: a shutdown that is **shared** by three callers, **waits** rather than
 * signalling and returning, reaches the **whole tree**, **forces** after a bounded
 * grace, keeps the token until the tree is **dead**, cannot be outrun by a start
 * that is still **in flight**, and fails **closed** when the server dies on its own.
 *
 * The kernel is faked at `process.kill`, because the questions are all about who
 * gets signalled and in what order — a real child would make this a test about
 * process scheduling. A negative pid is a process **group**, which is the whole
 * reason the server is spawned detached, so the fake keys on `Math.abs`.
 */

const scratch = mkdtempSync(join(tmpdir(), 'chorus-workbench-host-'))
const APP_PATH = join(scratch, 'app')
const USER_DATA = join(scratch, 'user-data')
const SERVER_DIR = join(scratch, 'server')
const COMMIT = '987c9597516278c9fcf10d963a0592ce1384ab93'
const PLATFORM_KEY = `${process.platform}-${process.arch}`
const ARCHIVE = 'fake!'

mkdirSync(join(APP_PATH, 'build'), { recursive: true })
mkdirSync(join(scratch, 'cache'), { recursive: true })
writeFileSync(join(scratch, 'cache', 'server.tar.gz'), ARCHIVE)
// The launcher's two real files, because `start` refuses to spawn without them —
// which is the check that turns an artifact whose layout changed into a named
// error instead of an unreadable spawn failure.
mkdirSync(join(SERVER_DIR, 'out'), { recursive: true })
writeFileSync(join(SERVER_DIR, process.platform === 'win32' ? 'node.exe' : 'node'), '')
writeFileSync(join(SERVER_DIR, 'out', 'server-main.js'), '')
writeFileSync(
  join(APP_PATH, 'build', 'workbench-runtime.json'),
  JSON.stringify({
    client: {
      package: '@codingame/monaco-vscode-api',
      version: '33.0.9',
      vscodeVersion: '1.121.0',
      vscodeCommit: COMMIT,
      quality: 'stable',
    },
    server: {
      vendor: 'VSCodium',
      release: '1.121.03429',
      upstreamTag: '1.121.0',
      upstreamCommit: COMMIT,
      artifacts: {
        [PLATFORM_KEY]: { name: 'server.tar.gz', size: ARCHIVE.length, sha256: 'a'.repeat(64) },
      },
    },
  })
)
process.env['CHORUS_WORKBENCH_CACHE'] = join(scratch, 'cache')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => APP_PATH,
    getPath: (name: string) => (name === 'userData' ? USER_DATA : join(scratch, 'app-data')),
  },
}))

/** The 76 MB download, the checksum and the 257 MB extraction are not the subject. */
vi.mock('./workbench-extract.js', () => ({
  hashBytes: () => 'b'.repeat(64),
  publishServer: () => Promise.resolve(SERVER_DIR),
  sweepQuarantine: () => undefined,
}))

/** One simulated process group: alive until signalled, and stubborn if asked to be. */
interface FakeGroup {
  alive: boolean
  /** Models a server that will not stop on `SIGTERM`, so the force path is reachable. */
  ignoresTerm: boolean
  /**
   * And one that survives `SIGKILL` too — uninterruptible sleep in a syscall, a
   * stuck filesystem, a zombie nobody reaps. Rare, and the only way to exercise a
   * reap that has to admit it failed.
   */
  ignoresKill?: boolean
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: string | null = null
  readonly kill = vi.fn()
  constructor(readonly pid: number) {
    super()
  }
}

const groups = new Map<number, FakeGroup>()
const children: FakeChild[] = []
let nextPid = 4000

/*
 * Both named imports the module under test uses, written out rather than spread
 * over the real module — a spread of `importActual` is an `any` the linter is
 * right about, and listing them makes it visible that `execFileSync` exists here
 * only for the Windows `taskkill` path, which never runs on this platform.
 */
/** What a faked `ps -Awwo pid=,ppid=,command=` returns, per test. */
let processTable = ''
/** And whether it fails outright, which is a different fact from returning nothing. */
let psFails = false

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  /*
   * `execFile` is consumed through `promisify`, and Node's real one carries a
   * `promisify.custom` implementation that resolves to `{ stdout, stderr }`. A
   * plain callback mock does not, so `promisify` would resolve with the bare
   * stdout string and the destructure in the reaper would silently read
   * `undefined` — a mock that is wrong in exactly the direction that makes a test
   * pass for the wrong reason.
   */
  const execFile = (): never => {
    throw new Error('execFile should be reached through promisify in this module')
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: () =>
      psFails
        ? Promise.reject(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve({ stdout: processTable, stderr: '' }),
  })
  return {
    execFile,
    spawn: () => {
      const child = new FakeChild((nextPid += 7))
      groups.set(child.pid, { alive: true, ignoresTerm: false })
      children.push(child)
      return child
    },
    execFileSync: () => '',
  }
})

/**
 * The kernel, faked — `process.kill` and nothing else.
 *
 * Signal 0 asks and sends nothing, which is how liveness is checked; a negative pid
 * names the group. `ESRCH` for a group that has gone is the real behaviour and the
 * one the production code catches, so the fake throws rather than returning false.
 */
const realKill = process.kill.bind(process)
/** The spy is returned rather than read back off `process`, which lint reads as an unbound method. */
function installFakeKernel(): MockInstance<(pid: number, signal?: string | number) => boolean> {
  return vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    const key = Math.abs(pid)
    const group = groups.get(key)
    if (group?.alive !== true) {
      throw Object.assign(new Error('ESRCH: no such process'), { code: 'ESRCH' })
    }
    if (signal === 0) return true
    if (signal === 'SIGTERM' && group.ignoresTerm) return true
    if (signal === 'SIGKILL' && group.ignoresKill === true) return true
    group.alive = false
    const child = children.find((c) => c.pid === key)
    if (child !== undefined) {
      child.exitCode = signal === 'SIGKILL' ? null : 0
      child.signalCode = String(signal)
      child.emit('exit', child.exitCode, child.signalCode)
    }
    return true
  })
}

const TOKEN_FILE = join(USER_DATA, 'workbench-server', 'connection-token')

/**
 * A fresh module per test, rather than a reset hook exported from production.
 *
 * The state that matters here is module-level and deliberately one-way —
 * `shuttingDown` never clears, and `hostFailure` never clears — because that is
 * exactly what "fails closed" means. A `__resetForTests` export would put a door
 * in that wall for the convenience of the tests, which is the shape of thing that
 * gets called from somewhere else eighteen months later. Resetting the registry
 * costs nothing and leaves the module with no test-only surface at all.
 */
let host: typeof HostModule

/** Drives the polling waits without spending their real budget. */
const settle = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

let killed: MockInstance<(pid: number, signal?: string | number) => boolean>

beforeEach(async () => {
  vi.useFakeTimers()
  killed = installFakeKernel()
  groups.clear()
  children.length = 0
  rmSync(TOKEN_FILE, { force: true })
  processTable = ''
  psFails = false
  vi.resetModules()
  host = await import('./workbench-host.js')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  process.kill = realKill
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Starts a server and reports its port, leaving it running. */
async function startServer(): Promise<FakeChild> {
  const started = host.acquireWorkbenchRuntime('/project')
  const child = await spawnedChild()
  child.stdout.emit('data', Buffer.from('Extension host agent listening on 51515\n'))
  await started
  return child
}

/** The spawn happens behind two awaits, so it is polled for rather than assumed. */
async function spawnedChild(): Promise<FakeChild> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (children.length > 0) return children[children.length - 1]!
    await vi.advanceTimersByTimeAsync(1)
  }
  throw new Error('the workbench host never spawned a server')
}

describe('stopping the workbench host', () => {
  it('signals the process group, not just the process it spawned', async () => {
    const child = await startServer()
    const stopped = host.stopWorkbenchHost()
    await settle(100)
    await stopped

    // The negative pid is the claim: the server forks an extension host per
    // connection and a file watcher, and those are its children rather than ours.
    expect(killed).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(groups.get(child.pid)?.alive).toBe(false)
    expect(host.workbenchHostState().spawned).toBe(0)
  })

  it('is one shutdown however many callers ask for it', async () => {
    await startServer()
    const first = host.stopWorkbenchHost()
    const second = host.stopWorkbenchHost()
    // Same promise, not merely two that resolve: quit, SIGTERM and SIGINT can
    // arrive together, and two shutdowns racing over one tree is how a force-kill
    // lands on a pid that has already been reused.
    expect(second).toBe(first)
    await settle(100)
    await first

    const terms = killed.mock.calls.filter(([, signal]) => signal === 'SIGTERM').length
    expect(terms).toBe(1)
  })

  it('forces the tree down after the grace period when SIGTERM is ignored', async () => {
    const child = await startServer()
    const group = groups.get(child.pid)
    if (group !== undefined) group.ignoresTerm = true

    const stopped = host.stopWorkbenchHost()
    await settle(1_000)
    // Still alive a second in: the grace is real, so an extension host gets a
    // chance to flush before it is killed outright.
    expect(groups.get(child.pid)?.alive).toBe(true)

    await settle(6_000)
    await stopped
    expect(killed).toHaveBeenCalledWith(-child.pid, 'SIGKILL')
    expect(groups.get(child.pid)?.alive).toBe(false)
  })

  it('keeps the connection token until the tree is confirmed dead', async () => {
    const child = await startServer()
    expect(existsSync(TOKEN_FILE)).toBe(true)
    const group = groups.get(child.pid)
    if (group !== undefined) group.ignoresTerm = true

    const stopped = host.stopWorkbenchHost()
    await settle(1_000)
    /*
     * The claim. `SIGTERM` is a request, and between the request and the exit the
     * server is still accepting sockets — it reads this file on **every**
     * connection, not once at startup. Deleting it beside the signal made every
     * handshake in that window fail with nothing on screen to say why.
     */
    expect(existsSync(TOKEN_FILE)).toBe(true)

    await settle(6_000)
    await stopped
    expect(existsSync(TOKEN_FILE)).toBe(false)
  })

  it('waits for a start that is still in flight rather than leaving its child behind', async () => {
    // Deliberately never reports a port: the shutdown arrives mid-start, which is
    // the race a shutdown that sampled `host` and found `null` would have lost.
    // The rejection is handled at the point it is created, not after the shutdown
    // is awaited: attaching later leaves a tick in which Node calls it unhandled.
    const started = host.acquireWorkbenchRuntime('/project').catch((error: unknown) => error)
    const child = await spawnedChild()
    expect(groups.get(child.pid)?.alive).toBe(true)

    const stopped = host.stopWorkbenchHost()
    /*
     * **No port is supplied**, and that omission is the test.
     *
     * The first version of this case emitted the listening line here, so the start
     * completed on its own and shutdown never had to cancel anything — it passed
     * while proving nothing about the case it was named for. Left to itself this
     * start waits 60 s for a port that is never coming; the shutdown below is given
     * three seconds, so if it ever waits the start out rather than cancelling it,
     * this fails.
     */
    await settle(3_000)
    await stopped
    await started

    expect(groups.get(child.pid)?.alive).toBe(false)
    expect(host.workbenchHostState().spawned).toBe(0)
  })

  it('refuses to open a project once shutdown has begun', async () => {
    await startServer()
    const stopped = host.stopWorkbenchHost()
    await settle(100)
    await stopped

    // One-way door: the IPC channel is still live while windows are closing, so an
    // `openWorkbench` can arrive after this point and must not spawn a server.
    await expect(host.acquireWorkbenchRuntime('/late')).rejects.toThrow(/shutting down/i)
    expect(children).toHaveLength(1)
  })
})

describe('a tree that will not die', () => {
  it('reports the survivor instead of claiming it stopped, and keeps the token', async () => {
    const child = await startServer()
    const group = groups.get(child.pid)
    if (group !== undefined) {
      group.ignoresTerm = true
      group.ignoresKill = true
    }

    const stopped = host.stopWorkbenchHost()
    await settle(10_000)
    const result = await stopped

    /*
     * The point of this case. `reapTree` used to delete the child and return
     * nothing, so every caller could say "reaped" and none of them could be
     * wrong — the same shape as signalling an `npx` wrapper and reporting on the
     * app. A survivor has to survive the *report* as well as the signal.
     */
    expect(result.survivors).toEqual([child.pid])
    expect(result.stopped).toBe(0)
    // Kept, not dropped: losing it here loses the only handle anything has on a
    // process group that is still running.
    expect(host.workbenchHostState().spawned).toBe(1)
    // And the token stays, because a group that outlived SIGKILL may still be
    // serving — and it reads that file on every connection.
    expect(existsSync(TOKEN_FILE)).toBe(true)
  })
})

describe('an extraction whose launcher is not there', () => {
  it('refuses by name and leaves no credential behind', async () => {
    const nodePath = join(SERVER_DIR, process.platform === 'win32' ? 'node.exe' : 'node')
    rmSync(nodePath, { force: true })
    try {
      await expect(host.acquireWorkbenchRuntime('/project')).rejects.toThrow(/is missing .*node/)
      /*
       * The ordering claim. Written before this check, the token was created and
       * then abandoned: every path that removes one hangs off a child, and here no
       * child is ever spawned. Nothing would have come back for it.
       */
      expect(existsSync(TOKEN_FILE)).toBe(false)
      expect(children).toHaveLength(0)
    } finally {
      writeFileSync(nodePath, '')
    }
  })
})

describe('the token a force-quit left behind', () => {
  it('is removed once the orphans are dead and nothing else is serving', async () => {
    mkdirSync(join(USER_DATA, 'workbench-server'), { recursive: true })
    writeFileSync(TOKEN_FILE, 'left-by-a-force-quit', { mode: 0o600 })
    const serverData = join(USER_DATA, 'workbench-server', 'server')
    processTable = `  901     1 /x/node /x/out/server-main.js --server-data-dir ${serverData} --log info`
    groups.set(901, { alive: true, ignoresTerm: false })

    await host.reapOrphanedWorkbenchServers('darwin')

    // Nothing is left that could be reading it, so a credential for a dead server
    // stops sitting on disk until some later server happens to overwrite it.
    expect(existsSync(TOKEN_FILE)).toBe(false)
  })

  it('is left alone while another Chorus on this profile is still serving', async () => {
    mkdirSync(join(USER_DATA, 'workbench-server'), { recursive: true })
    writeFileSync(TOKEN_FILE, 'in-use-by-a-live-session', { mode: 0o600 })
    const serverData = join(USER_DATA, 'workbench-server', 'server')
    // Parent 455: a **running** Chorus, not an orphan. Its server reads this file
    // on every connection, so removing it would refuse that session's handshakes
    // silently — §5.3's failure inflicted on somebody else.
    processTable = `  902   455 /x/node /x/out/server-main.js --server-data-dir ${serverData} --log info`
    groups.set(902, { alive: true, ignoresTerm: false })

    const result = await host.reapOrphanedWorkbenchServers('darwin')

    expect(result.killed).toBe(0)
    expect(existsSync(TOKEN_FILE)).toBe(true)
  })
})

describe('a sweep that could not run', () => {
  it('refuses to start a server rather than treating an unread table as an empty one', async () => {
    /*
     * `ps` failing is not "nothing is running" — it is "Chorus cannot tell", and
     * the old boolean `skipped` made those the same value. `start` then read an
     * empty `survivors` from a sweep that had never happened and spawned anyway.
     * That is the fail-open shape this module has now produced five times, one
     * level up each time.
     */
    psFails = true
    mkdirSync(join(USER_DATA, 'workbench-server'), { recursive: true })
    writeFileSync(TOKEN_FILE, 'from-an-earlier-session', { mode: 0o600 })

    const outcome = await host.acquireWorkbenchRuntime('/project').catch((e: unknown) => e)

    expect(String(outcome)).toMatch(/could not check for a workbench server/i)
    expect(children).toHaveLength(0)
    // And nothing was written on the way to refusing.
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe('from-an-earlier-session')
  })

  it('reports why it did not run, so the two reasons stay distinguishable', async () => {
    psFails = true
    await expect(host.reapOrphanedWorkbenchServers('darwin')).resolves.toMatchObject({
      skipped: 'sweep-failed',
    })
    psFails = false
    // Windows is *deliberately* absent rather than broken, and stays allowed
    // through — as unverified as everything else about that platform.
    await expect(host.reapOrphanedWorkbenchServers('win32')).resolves.toMatchObject({
      skipped: 'unsupported-platform',
    })
  })
})

describe('an orphan that will not die', () => {
  /**
   * The case a synchronous fake kernel cannot produce, and the reason the fake has
   * an `ignoresKill` group at all.
   *
   * A `SIGKILL` is a request the kernel almost always grants — but not to a
   * process wedged in an uninterruptible syscall, on a stuck mount, or already a
   * zombie its parent will never reap. "Almost always" is exactly the gap a reaper
   * that counts *signals sent* hides, so the fake has to be able to say no.
   */
  const wedgeOrphan = (pid: number): void => {
    const serverData = join(USER_DATA, 'workbench-server', 'server')
    processTable = `  ${String(pid)}     1 /x/node /x/out/server-main.js --server-data-dir ${serverData} --log info`
    groups.set(pid, { alive: true, ignoresTerm: true, ignoresKill: true })
  }

  it('is reported as a survivor rather than counted as killed', async () => {
    mkdirSync(join(USER_DATA, 'workbench-server'), { recursive: true })
    writeFileSync(TOKEN_FILE, 'still-in-use-by-the-orphan', { mode: 0o600 })
    wedgeOrphan(901)

    const reaping = host.reapOrphanedWorkbenchServers('darwin')
    await settle(4_000)
    const result = await reaping

    // Signalled, and it did not go. `killed` used to be the number of `SIGKILL`s
    // sent, which would have read 1 here — success for having asked.
    expect(killed).toHaveBeenCalledWith(-901, 'SIGKILL')
    expect(result.killed).toBe(0)
    expect(result.survivors).toEqual([901])
    expect(result.inspected).toBe(1)
    // And the token stays: something carrying this profile's marker is still
    // running, and it reads that file on every connection.
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe('still-in-use-by-the-orphan')
  })

  it('stops a new server being spawned beside it, before any token is written', async () => {
    mkdirSync(join(USER_DATA, 'workbench-server'), { recursive: true })
    writeFileSync(TOKEN_FILE, 'still-in-use-by-the-orphan', { mode: 0o600 })
    wedgeOrphan(902)

    const started = host.acquireWorkbenchRuntime('/project').catch((error: unknown) => error)
    await settle(4_000)
    const outcome = await started

    /*
     * The barrier's whole point, and what was missing: awaiting a sweep that
     * resolves successfully is not a barrier if the answer is thrown away. Two
     * servers on one `--server-data-dir` means one extensions lock and one token
     * file between them, with the newer one overwriting a credential the older is
     * still reading.
     */
    expect(String(outcome)).toMatch(/still running \(pid 902\).*before opening a project/s)
    expect(children).toHaveLength(0)
    // Refused **before** the credential exists, so a refused start leaves the
    // profile exactly as it found it.
    expect(readFileSync(TOKEN_FILE, 'utf8')).toBe('still-in-use-by-the-orphan')
  })

  it('shares one memoised sweep, which is what makes a failed sweep fail closed', async () => {
    // `start` awaits the same promise `index.ts` kicked off. If they were separate
    // sweeps, a rejection logged at boot would leave the open path having never
    // checked — so identity here is the fail-closed property, not an optimisation.
    processTable = ''
    const first = host.reapedOrphanedServers('darwin')
    const second = host.reapedOrphanedServers('darwin')
    expect(second).toBe(first)
    await settle(100)
    await first
  })
})

describe('a start that never finishes', () => {
  it('is cancelled by shutdown rather than waited out', async () => {
    // Never reports a port. Left alone this start blocks for its full 60 s wait,
    // which — now that `SIGTERM` is handled here instead of terminating the
    // process outright — would be 60 s of a Chorus that looks hung on quit.
    const started = host.acquireWorkbenchRuntime('/project').catch((error: unknown) => error)
    const child = await spawnedChild()

    const stopped = host.stopWorkbenchHost()
    let settled = false
    void stopped.then(() => (settled = true))

    await settle(3_000)
    expect(settled).toBe(true)
    await stopped

    expect(String(await started)).toMatch(/cancelled|shutting down/i)
    expect(groups.get(child.pid)?.alive).toBe(false)
    expect(host.workbenchHostState().spawned).toBe(0)
  })
})

describe('a spawn that fails outright', () => {
  it('reports the spawn error rather than waiting out the port timeout', async () => {
    const started = host.acquireWorkbenchRuntime('/project').catch((error: unknown) => error)
    const child = await spawnedChild()

    /*
     * ENOENT, EACCES and EAGAIN arrive on `error` and are followed by **no**
     * `exit`, so before this arm existed a server binary that was present but not
     * executable sat in the port wait for a full minute and then reported "did not
     * report a port" — the symptom rather than the cause. An unhandled `error` on a
     * `ChildProcess` is also a top-level throw, which in main is a crash.
     */
    child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    await settle(200)

    expect(String(await started)).toMatch(/EACCES/)
    // Nothing left running and no credential left on disk for a server that never
    // started.
    expect(host.workbenchHostState().spawned).toBe(0)
    expect(existsSync(TOKEN_FILE)).toBe(false)
  })
})

describe('a server that dies between reporting its port and being recorded', () => {
  it('is not installed as the running host', async () => {
    const started = host.acquireWorkbenchRuntime('/project').catch((error: unknown) => error)
    const child = await spawnedChild()

    /*
     * The window this closes. `awaitPort` resolves on a line of stdout and the
     * assignment happens a microtask later, so a server that dies in between — a
     * token it rejects, an extensions directory it cannot lock — used to be
     * recorded as `host` **after** the exit listener had already decided it was not
     * the running host. Every later open then received that dead port.
     */
    child.stdout.emit('data', Buffer.from('Extension host agent listening on 51515\n'))
    child.exitCode = 1
    child.emit('exit', 1, null)
    await settle(200)

    expect(String(await started)).toMatch(/exited immediately after reporting its port/)
    expect(host.workbenchHostState().running).toBe(false)
    expect(host.workbenchHostState().spawned).toBe(0)
  })
})

describe('reaping servers left by a force-quit', () => {
  it('kills the group of an orphan carrying this profile own server-data-dir', async () => {
    const serverData = join(USER_DATA, 'workbench-server', 'server')
    // Three candidates and only one is reapable: the orphan. The second belongs to
    // a **live** Chorus — killing it would take down somebody's running session —
    // and the third is another profile's server, which is what identifying by
    // executable name rather than by data directory would have swept up.
    processTable = [
      `  901     1 /x/node /x/out/server-main.js --server-data-dir ${serverData} --log info`,
      `  902   455 /x/node /x/out/server-main.js --server-data-dir ${serverData} --log info`,
      '  903     1 /x/node /x/out/server-main.js --server-data-dir /somebody/else/server --log info',
    ].join('\n')
    groups.set(901, { alive: true, ignoresTerm: false })
    groups.set(902, { alive: true, ignoresTerm: false })
    groups.set(903, { alive: true, ignoresTerm: false })

    const result = await host.reapOrphanedWorkbenchServers('darwin')

    expect(result).toMatchObject({ killed: 1, inspected: 2, skipped: null })
    // The group, because the orphan leads one — its extension hosts are the point.
    expect(killed).toHaveBeenCalledWith(-901, 'SIGKILL')
    expect(killed).not.toHaveBeenCalledWith(-902, 'SIGKILL')
    expect(killed).not.toHaveBeenCalledWith(-903, 'SIGKILL')
  })

  it('reports itself skipped on Windows rather than a confident zero', async () => {
    // A silent `killed: 0` is indistinguishable in the log from a clean machine,
    // which is the arrangement `reap.ts` calls the worst one available.
    await expect(host.reapOrphanedWorkbenchServers('win32')).resolves.toEqual({
      killed: 0,
      inspected: 0,
      survivors: [],
      skipped: 'unsupported-platform',
    })
  })
})

describe('a server that goes without being asked', () => {
  it('clears the host and refuses the next open instead of handing out a dead port', async () => {
    const child = await startServer()
    expect(host.workbenchHostState().running).toBe(true)

    // Crashed, OOM-killed, or stopped from a terminal — the observable is the same.
    child.exitCode = 1
    child.emit('exit', 1, null)

    expect(host.workbenchHostState().running).toBe(false)
    expect(host.workbenchHostState().failure).toMatch(/stopped unexpectedly/)

    /*
     * **Fails closed rather than restarting**, and the reason is the CSP: the
     * workbench session is built once with the first server's authority in it, so a
     * replacement on a new port would be refused by `connect-src` and the surface
     * would open, connect to nothing and render an empty tree. A refusal names the
     * problem; a silent restart hides it behind a symptom that looks like an empty
     * project.
     */
    await expect(host.acquireWorkbenchRuntime('/again')).rejects.toThrow(/Restart Chorus/)
    expect(children).toHaveLength(1)
  })

  it('reaps the descendants the dead root left behind', async () => {
    const child = await startServer()

    /*
     * The root exits **while its group is still alive** — which is the ordinary
     * shape of a server crash, because the extension hosts and file watchers it
     * forked are separate processes that outlive it. The first version of the exit
     * handler dropped the child from `spawned` here and called that cleanup, so a
     * crashed server left exactly the fan of processes this whole item is about.
     */
    // Alive *before* the root exits, which is what makes the exit a case of "the
    // root died and its group did not". Asserted here rather than after, because
    // the reap starts synchronously inside the exit handler — a check after the
    // emit would be reading the state the fix had already produced.
    expect(groups.get(child.pid)?.alive).toBe(true)
    child.exitCode = 1
    child.emit('exit', 1, null)

    await settle(1_000)
    expect(killed).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(groups.get(child.pid)?.alive).toBe(false)
    expect(host.workbenchHostState().spawned).toBe(0)
    // And the credential goes with the process that needed it.
    expect(existsSync(TOKEN_FILE)).toBe(false)
  })
})
