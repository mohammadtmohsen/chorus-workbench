import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The host-lifecycle gate — Phase 1 exit item E4.
 *
 * The containment gate proved two workbenches can coexist. This one asks the
 * question that comes after: when Chorus goes, does the remote extension host go
 * with it? It did not. Two consecutive containment runs measured Electron exiting
 * **`code=0`** with the server still alive fifteen seconds later, and the
 * mechanism turned out to be two separate faults stacked: `bin/codium-server` is a
 * bash script that runs `"$ROOT/node" out/server-main.js "$@"` **without `exec`**,
 * so Chorus's child was a shell and killing it orphaned the real server — and
 * Electron's default handling of `SIGTERM` is to terminate, so `before-quit` never
 * ran and nothing was asked to stop in the first place.
 *
 * **Three ways of stopping the app, one shutdown path.** A harness that sends
 * `SIGTERM`, a shell that sends `SIGINT`, and a person closing the window are
 * asking for the same thing, and the way one of them ends up being the path nobody
 * tested is by giving them separate implementations. So each mode is driven here,
 * and each is held to the same three claims: Electron exits, **no descendant of
 * this run survives fifteen seconds**, and the connection token is gone.
 *
 * **One signal, deliberately.** A *second* termination signal arriving mid-cleanup
 * is a forced quit rather than a second polite request: it was observed ending the
 * process with `signal=SIGTERM`, and its recovery is the next launch's reaper —
 * the last section here — rather than anything shutdown could have done. That is
 * `BOARD.md` C-055, a documented boundary rather than a defect, so it is not
 * asserted against. Repeated **in-app** quits are a different question and are
 * proved in `quit-gate.test.ts`, where the re-entry can be arranged exactly.
 *
 * Fifteen seconds because the distinction that matters is between a **leak** and a
 * **slow shutdown** — `stopWorkbenchHost` sends `SIGTERM` first, and a server
 * closing its connections has not leaked, it is going. A single sample taken
 * half a second after exit cannot tell those apart, and reporting the first as the
 * second is how this item was raised on invalid evidence once already.
 *
 * Run: `node e2e/workbench-shutdown.mjs` from `apps/desktop`, after a build.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
/** Electron's own binary. Never `npx`, which would make every claim here npm's. */
const ELECTRON = createRequire(import.meta.url)('electron')

const results = []
function record(claim, ok, observed) {
  results.push({ claim, ok, observed })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${claim}\n        ${observed}\n`)
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
      last = error.message
    }
    await wait(300)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`)
}

function readPort(text) {
  return /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)?.[1] ?? null
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await response.json()).filter((t) => t.type === 'page')
}

/** One CDP socket, enough to open a project and nothing else. */
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
  return { evaluate, close: () => socket.close() }
}

/**
 * Every process this run owns, by a marker no other run can carry: its own
 * `mkdtemp` directory name. Never by executable name — killing a process because
 * it looks like a code server is how you kill somebody's editor.
 */
function descendants(marker) {
  const listing = execFileSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid))
}

/**
 * The server processes for one profile — matched on the argument only this
 * profile passes, which is the same rule the reaper itself uses.
 *
 * Distinct from `descendants`, which matches anything under the run directory and
 * so includes extension hosts and file watchers. "How many servers are there?" is
 * a different question from "what is still running?", and the immediate-open case
 * below turns on the first one.
 */
function serverProcesses(dataPath) {
  const marker = `--server-data-dir ${join(dataPath, 'workbench-server', 'server')}`
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

/**
 * One app, one project open, stopped the way `mode` says — and the project is what
 * makes the run meaningful, because the server is spawned on the first open rather
 * than at boot.
 */
async function runMode(mode) {
  const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
  const dataPath = join(tmpdir(), `chorus-shutdown-${mode}-${stamp}`)
  const projectRoot = join(dataPath, 'project')
  mkdirSync(projectRoot, { recursive: true })
  // A disposable fixture, never the checkout: this launches a live editor, and a
  // harness may not write to the repository it is checking.
  writeFileSync(join(projectRoot, 'notes.md'), `# shutdown fixture ${stamp}\n`)

  const marker = basename(dataPath)
  const tokenFile = join(dataPath, 'workbench-server', 'connection-token')

  const env = {
    ...process.env,
    CHORUS_USER_DATA: dataPath,
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

  process.stdout.write(`\n── ${mode} · electron pid ${String(child.pid)} · ${marker}\n`)

  try {
    const port = await until('a debugging port', () => readPort(output), 60_000)
    const shellTarget = await until('the shell window', async () => {
      const found = (await targets(port)).find((t) => !t.url.includes('workbench.html'))
      return found ?? false
    })
    const shell = await attach(shellTarget)
    await until(
      'the shell bridge',
      async () => (await shell.evaluate('typeof window.chorus')) === 'object'
    )

    // The chooser is seeded, so this is the person picking a folder — the server is
    // spawned by the open, which is the only thing this gate needs from the UI.
    const { chosen } = await shell.evaluate('window.chorus.chooseWorkbenchProject()')
    if (chosen === null) throw new Error('the chooser minted nothing')
    await shell.evaluate(`window.chorus.openWorkbench({ grant: ${JSON.stringify(chosen.grant)} })`)

    const servers = await until(
      'the remote extension host to be running',
      () => {
        const found = descendants(marker)
        return found.length > 0 ? found : false
      },
      120_000
    )
    record(
      `${mode}: the server is running before the app is stopped`,
      servers.length > 0 && existsSync(tokenFile),
      `descendants=[${servers.join(',')}] token=${String(existsSync(tokenFile))}`
    )

    if (mode === 'window-close') {
      // The ordinary path: the last window closes, `window-all-closed` quits the
      // app, and `before-quit` runs the shutdown. Deferred a tick so the evaluate
      // returns before its execution context goes away.
      await shell.evaluate('setTimeout(() => { window.close() }, 0); true')
    } else {
      child.kill(mode)
    }

    const exited = await until(
      'electron to exit',
      () => (child.exitCode !== null || child.signalCode !== null ? true : false),
      30_000
    ).catch(() => false)
    record(
      `${mode}: electron exits`,
      exited === true,
      exited === true
        ? `code=${String(child.exitCode)} signal=${String(child.signalCode)}`
        : 'still running after 30s'
    )

    /*
     * The claim E4 exists for. Polled rather than sampled, because a server that
     * takes a moment to close its connections after `SIGTERM` has not leaked — and
     * the whole reason this item was once raised on bad evidence is that a single
     * read cannot tell the difference.
     */
    const deadline = Date.now() + 15_000
    let survivors = servers.filter((pid) => alive(pid))
    while (survivors.length > 0 && Date.now() < deadline) {
      await wait(500)
      survivors = servers.filter((pid) => alive(pid))
    }
    const elapsed = Date.now() - (deadline - 15_000)
    const stragglers = descendants(marker).filter((pid) => alive(pid))
    record(
      `${mode}: no identified descendant survives 15s`,
      survivors.length === 0 && stragglers.length === 0,
      survivors.length === 0 && stragglers.length === 0
        ? `all ${String(servers.length)} gone in ${String(elapsed)}ms`
        : `LEAKED survivors=[${survivors.join(',')}] stragglers=[${stragglers.join(',')}]`
    )

    /*
     * Main's own account when this fails, because "the token is still there" has
     * two completely different causes and the file cannot tell them apart: nothing
     * ran the removal, or the removal ran and **declined** because shutdown
     * believed a process group had survived. The second is a claim main now makes
     * out loud, so it is worth reading rather than inferring.
     */
    const chorusLog = join(dataPath, 'logs', 'chorus.log')
    const mainSaid = existsSync(chorusLog)
      ? readFileSync(chorusLog, 'utf8')
          .split('\n')
          .filter((line) => line.includes('survived shutdown') || line.includes('workbench'))
          .slice(-6)
          .join('\n          ')
      : 'no chorus.log'
    record(
      `${mode}: the connection token is removed`,
      !existsSync(tokenFile),
      existsSync(tokenFile) ? `still on disk: ${tokenFile}\n          ${mainSaid}` : 'gone'
    )
  } finally {
    child.kill('SIGKILL')
    await wait(300)
    for (const pid of descendants(marker).filter((p) => alive(p))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(dataPath, { recursive: true, force: true })
  }
}

/**
 * The case no handler can cover: `SIGKILL`, then the next launch cleaning up.
 *
 * Everything above tests an *ordered* exit. This one removes the order — nothing
 * runs, nothing is signalled, and the server is left exactly as a force-quit or a
 * power cut would leave it. It is also the only place the reaper's premise is
 * actually checked rather than reasoned about: that a real orphan is reparented to
 * **PPID 1** and shows up in real `ps` output carrying this profile's own
 * `--server-data-dir`. Both of those are inferences until something observes them,
 * and inferences of exactly this shape — the `npx` wrapper, the `.cmd` launcher —
 * are what this work keeps being caught by.
 *
 * The first claim is the premise and it is allowed to fail informatively: if a
 * `SIGKILL`ed Chorus takes its detached server with it after all, the reaper is
 * unnecessary and that is worth knowing rather than asserting past.
 */
async function runKillAndRelaunch() {
  const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
  const dataPath = join(tmpdir(), `chorus-shutdown-sigkill-${stamp}`)
  const projectRoot = join(dataPath, 'project')
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(join(projectRoot, 'notes.md'), `# sigkill fixture ${stamp}\n`)

  const marker = basename(dataPath)
  const tokenFile = join(dataPath, 'workbench-server', 'connection-token')
  const env = {
    ...process.env,
    CHORUS_USER_DATA: dataPath,
    // Two answers, because this run opens a project twice — once before the
    // force-quit and once immediately after the relaunch.
    CHORUS_WORKBENCH_E2E_ROOTS: [realpathSync(projectRoot), realpathSync(projectRoot)].join(
      delimiter
    ),
    CHORUS_WORKBENCH_CACHE: resolve(APP, '../../.workbench-cache'),
  }
  delete env.ELECTRON_RUN_AS_NODE

  /** One launch, one project opened, and the server left running. */
  const launch = async () => {
    const child = spawn(ELECTRON, ['.', '--remote-debugging-port=0'], {
      cwd: APP,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let output = ''
    child.stdout.on('data', (d) => (output += d.toString()))
    child.stderr.on('data', (d) => (output += d.toString()))
    const port = await until('a debugging port', () => readPort(output), 60_000)
    const shellTarget = await until('the shell window', async () => {
      const found = (await targets(port)).find((t) => !t.url.includes('workbench.html'))
      return found ?? false
    })
    const shell = await attach(shellTarget)
    await until(
      'the shell bridge',
      async () => (await shell.evaluate('typeof window.chorus')) === 'object'
    )
    return { child, shell }
  }

  process.stdout.write(`\n── SIGKILL-then-relaunch · ${marker}\n`)
  try {
    const first = await launch()
    process.stdout.write(`        first electron pid ${String(first.child.pid)}\n`)
    const { chosen } = await first.shell.evaluate('window.chorus.chooseWorkbenchProject()')
    if (chosen === null) throw new Error('the chooser minted nothing')
    await first.shell.evaluate(
      `window.chorus.openWorkbench({ grant: ${JSON.stringify(chosen.grant)} })`
    )
    const servers = await until(
      'the remote extension host to be running',
      () => {
        const found = descendants(marker)
        return found.length > 0 ? found : false
      },
      120_000
    )

    // No handler runs. This is the case the ordered shutdown cannot reach.
    first.child.kill('SIGKILL')
    await until(
      'the first electron to die',
      () => (first.child.exitCode !== null || first.child.signalCode !== null ? true : false),
      15_000
    ).catch(() => false)
    await wait(3_000)

    const orphans = servers.filter((pid) => alive(pid))
    record(
      'SIGKILL: the detached server survives, which is why a reaper is needed',
      orphans.length > 0,
      orphans.length > 0
        ? `orphaned=[${orphans.join(',')}]`
        : 'nothing survived — the reaper would be unnecessary'
    )

    // The premise the reaper rests on, observed rather than assumed.
    const reparented = orphans.filter((pid) => {
      try {
        return (
          Number(
            execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
          ) === 1
        )
      } catch {
        return false
      }
    })
    record(
      'SIGKILL: the orphan is reparented to init, which is how the reaper identifies it',
      orphans.length > 0 && reparented.length === orphans.length,
      `ppid==1 for [${reparented.join(',')}] of [${orphans.join(',')}]`
    )

    // The credential the force-quit abandoned is still there: nothing removes one
    // except a path hanging off a running child, and that child's process is gone.
    record(
      'SIGKILL: the token is left on disk by the force-quit',
      existsSync(tokenFile),
      existsSync(tokenFile) ? tokenFile : 'already gone — nothing left to clean up'
    )

    const second = await launch()
    process.stdout.write(`        second electron pid ${String(second.child.pid)}\n`)

    // Bounded: the reaper runs at `whenReady`, so this is a wait on a boot step
    // rather than on anything a person does.
    const deadline = Date.now() + 20_000
    let left = orphans.filter((pid) => alive(pid))
    while (left.length > 0 && Date.now() < deadline) {
      await wait(500)
      left = orphans.filter((pid) => alive(pid))
    }
    record(
      'SIGKILL: the next launch reaps what the force-quit left behind',
      left.length === 0,
      left.length === 0
        ? `all ${String(orphans.length)} reaped at startup`
        : `still alive after 20s: [${left.join(',')}]`
    )

    /*
     * Checked **before** a project is opened, and that ordering is the whole
     * assertion: opening one writes a fresh token to the same path, so a check
     * afterwards would pass whether or not the stale one was ever removed. This is
     * the shape of pass-for-the-wrong-reason that keeps turning up here.
     */
    const tokenDeadline = Date.now() + 10_000
    while (existsSync(tokenFile) && Date.now() < tokenDeadline) await wait(250)
    record(
      'SIGKILL: the next launch removes the stale token, before any project opens',
      !existsSync(tokenFile),
      existsSync(tokenFile) ? `still on disk: ${tokenFile}` : 'gone'
    )

    /*
     * **Opened immediately**, which is the case a relaunch on its own cannot test.
     *
     * The reaper is started at `whenReady` and awaited in `start`; kicking it off
     * without awaiting it looks identical from a gate that only relaunches, because
     * a `ps` sweep finishes long before anyone gets round to opening anything. A
     * project opened in the same breath as the window is what makes the difference
     * observable: without the barrier a new server comes up **beside** the orphan,
     * both owning this profile's server-data directory and token file.
     */
    const { chosen: again } = await second.shell.evaluate('window.chorus.chooseWorkbenchProject()')
    if (again === null) throw new Error('the chooser minted nothing on relaunch')
    await second.shell.evaluate(
      `window.chorus.openWorkbench({ grant: ${JSON.stringify(again.grant)} })`
    )
    const fresh = await until(
      'the relaunched app to start its own server',
      () => {
        const found = serverProcesses(dataPath).filter((pid) => alive(pid))
        return found.length > 0 ? found : false
      },
      120_000
    )
    record(
      'SIGKILL: opening a project immediately leaves exactly one server, and not the orphan',
      fresh.length === 1 && !orphans.includes(fresh[0]),
      `live servers=[${fresh.join(',')}] orphans=[${orphans.join(',')}]`
    )

    second.child.kill('SIGKILL')
  } finally {
    await wait(500)
    for (const pid of descendants(marker).filter((p) => alive(p))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(dataPath, { recursive: true, force: true })
  }
}

async function main() {
  for (const mode of ['window-close', 'SIGTERM', 'SIGINT']) await runMode(mode)
  await runKillAndRelaunch()

  const failed = results.filter((r) => !r.ok)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} claims held.\n`)
  if (failed.length > 0) {
    process.stdout.write(
      `first failed invariant: ${failed[0].claim}\n        ${failed[0].observed}\n`
    )
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`\nthe shutdown gate could not complete: ${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
