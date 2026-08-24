import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The owner-lifecycle gate — Phase 1 exit item E3.
 *
 * `watchOwner` tears a shell's surfaces down and revokes its grants when the
 * document that owns them goes away, and until now every part of that was proved
 * against a **fake `WebContents`**: the listener wiring, the same-document
 * control, the per-owner isolation. The one link none of it touched is the first
 * one — that Electron actually emits `did-start-navigation` for a real shell
 * reload. That was read out of Electron's typings ("emitted when any frame
 * (including main) starts navigating") and never observed. The containment gate
 * reloads a *surface*, not the shell, so it does not close the gap either.
 *
 * **What this gate can and cannot see.** Main's listener is not observable from
 * CDP, so the event is proved by its consequences: a surface that is gone and a
 * grant that is refused, in a document that provably replaced itself. If Electron
 * does not emit the event, both of those records fail — which is what makes them
 * a test of the *event* rather than of the handler that the unit tests already
 * cover.
 *
 * **Everything here is built so that "nothing happened" cannot pass for a
 * result**, because a reload probe is the exact shape that goes green on nothing
 * being measured:
 *
 * - **The reload is proved before anything is concluded from it.** A marker is
 *   written onto `window` first; if it is still there afterwards, the document
 *   never went and every later observation is about a page that did not reload.
 * - **The bridge is proved to come back.** "It came back" is otherwise a claim
 *   about a screenshot. A shell that reloaded into a broken document would
 *   satisfy "no surfaces" and "grant refused" for entirely the wrong reason.
 * - **Both effects are armed first.** A surface is open and the grant is proved
 *   redeemable *before* the reload, so "gone" and "refused" are transitions
 *   rather than the initial state.
 * - **The same-document control comes first**, while the surface is up: a
 *   `pushState` must destroy nothing and revoke nothing. Drop `isSameDocument`
 *   from the check and this is the record that turns red.
 * - **"Nothing changed" is sampled repeatedly, never once.** A single reading
 *   taken before a teardown would have landed cannot tell "it survived" from
 *   "it had not happened yet".
 *
 * **A reload is not a teardown**, and one record exists to keep it that way. The
 * per-project REH lease is refcounted over *projects*, and `destroySurface`'s own
 * comment is explicit that releasing it does not stop the server —
 * `stopWorkbenchHost` on quit is the only unconditional kill. So the server
 * processes are asserted to be **the same pids, still alive** after the shell
 * reloads. That catches a future "fix" that tears the host down with the surface,
 * and it is also what stops "no surfaces" being satisfied by the app having died.
 *
 * Run: `node e2e/workbench-owner-lifecycle.mjs` from `apps/desktop`, after a
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

/**
 * Records, then stops if it did not hold.
 *
 * Every step here arms the next one, so a run that carried on past a failure
 * would report a list of consequences of the first one and bury it.
 */
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

/**
 * Samples for a while and hands back every reading.
 *
 * The shape "nothing changed" needs: one reading proves only that the change had
 * not arrived by the time it was taken, which is how a control that cannot fail
 * gets written.
 */
async function readings(ms, sample) {
  const taken = []
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    taken.push(await sample())
    await wait(250)
  }
  return taken
}

function readPort(text) {
  return /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)?.[1] ?? null
}

async function pageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await response.json()).filter((t) => t.type === 'page')
}

/** Live workbench documents, which is the independent measure of "a surface exists". */
async function surfaces(port) {
  return (await pageTargets(port)).filter((t) => t.url.includes('workbench.html'))
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
      }, 60_000)
    })
  /*
   * `Runtime.enable` is never sent. It breaks renderers created after it, and the
   * surface below is created by an evaluate on this very connection.
   */
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

/** Everything under this run's own directory — extension hosts and watchers included. */
function descendants(marker) {
  const listing = execFileSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid))
}

/** The server processes for one profile, matched the way the reaper matches them. */
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

/** Waits for the shell's own document, which is every page that is not a surface. */
async function shellWindow(port) {
  return until('the shell window', async () => {
    const found = (await pageTargets(port)).find((t) => !t.url.includes('workbench.html'))
    return found ?? false
  })
}

async function connectShell(port) {
  const shell = await attach(await shellWindow(port))
  await until(
    'the shell bridge',
    async () => (await shell.evaluate('typeof window.chorus')) === 'object'
  )
  return shell
}

/**
 * Redeems a grant and reports what happened in one value, because the interesting
 * case is the refusal and a thrown error cannot be recorded.
 */
async function tryOpen(shell, grant) {
  return JSON.parse(
    await shell.evaluate(`window.chorus
      .openWorkbench({ grant: ${JSON.stringify(grant)} })
      .then((r) => JSON.stringify({ ok: true, viewId: r.viewId }))
      .catch((e) => JSON.stringify({ ok: false, message: String(e && e.message ? e.message : e) }))`)
  )
}

async function run() {
  const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
  const dataPath = join(tmpdir(), `chorus-owner-lifecycle-${stamp}`)
  const projectRoot = join(dataPath, 'project')
  mkdirSync(projectRoot, { recursive: true })
  // A disposable fixture, never the checkout: this launches a live editor with
  // auto-save on, and a harness may not write to the repository it is checking.
  writeFileSync(join(projectRoot, 'notes.md'), `# owner-lifecycle fixture ${stamp}\n`)

  const marker = basename(dataPath)
  const root = realpathSync(projectRoot)

  /*
   * Exactly two answers, because exactly two mints happen: one before the reload
   * and one after it. A spare would hide a mint nobody meant to make — and the
   * cost of that precision is that an unexpected third would fall through to the
   * real native dialog and hang, which is a loud failure rather than a quiet pass.
   */
  const env = {
    ...process.env,
    CHORUS_USER_DATA: dataPath,
    CHORUS_WORKBENCH_E2E_ROOTS: [root, root].join(delimiter),
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
  process.stdout.write(`\n── electron pid ${String(child.pid)} · ${marker}\n`)

  try {
    const port = await until('a debugging port', () => readPort(output), 60_000)
    let shell = await connectShell(port)

    // ── arming ────────────────────────────────────────────────────────────────
    const { chosen } = await shell.evaluate('window.chorus.chooseWorkbenchProject()')
    must(
      'the chooser mints a grant for this document',
      chosen !== null && typeof chosen.grant === 'string',
      chosen === null ? 'the chooser minted nothing' : `root=${chosen.projectRoot}`
    )
    const grant = chosen.grant

    /*
     * The same-document control, half one — and it is free, because the successful
     * open *is* the proof. A `pushState` is a route change: the shell is still
     * running and its grants are still the person's. Drop `isSameDocument` from
     * `watchOwner` and this grant is revoked before it is ever redeemed.
     */
    await shell.evaluate(`history.pushState({}, '', '#owner-lifecycle-1'), true`)
    await wait(500)
    const armed = await tryOpen(shell, grant)
    must(
      'a same-document navigation does not revoke the grant',
      armed.ok === true,
      armed.ok === true ? `viewId=${armed.viewId}` : `refused: ${armed.message}`
    )

    const opened = await until(
      'the surface to appear',
      async () => {
        const found = await surfaces(port)
        return found.length === 1 ? found : false
      },
      120_000
    )
    must(
      'exactly one surface is open before anything is navigated',
      opened.length === 1,
      `surfaces=${String(opened.length)}`
    )

    const servers = await until(
      'the remote extension host to be running',
      () => {
        const found = serverProcesses(dataPath)
        return found.length > 0 ? found : false
      },
      120_000
    )
    must(
      'the remote extension host is running before the reload',
      servers.length > 0,
      `servers=[${servers.join(',')}]`
    )

    /*
     * The same-document control, half two: the *surface* survives a route change.
     * Sampled over two seconds rather than read once, because a teardown that had
     * simply not landed yet would satisfy a single reading.
     */
    await shell.evaluate(`history.pushState({}, '', '#owner-lifecycle-2'), true`)
    const held = await readings(2_000, async () => (await surfaces(port)).length)
    must(
      'a same-document navigation destroys no surface',
      held.length > 0 && held.every((n) => n === 1),
      `surface counts over 2s: [${held.join(',')}]`
    )

    // ── the reload ────────────────────────────────────────────────────────────
    /*
     * The marker is what makes everything below a statement about a reload. Without
     * it, "the surface is gone" and "the grant is refused" would be equally true of
     * a page that never navigated and an app that had crashed.
     */
    await shell.evaluate(`window.__chorusOwnerLifecycle = ${JSON.stringify(stamp)}, true`)
    const beforeMarker = await shell.evaluate('window.__chorusOwnerLifecycle ?? null')
    must(
      'the marker is in place on the document about to be reloaded',
      beforeMarker === stamp,
      `marker=${String(beforeMarker)}`
    )

    // Deferred a tick so the evaluate returns before its execution context goes.
    await shell.evaluate('setTimeout(() => { location.reload() }, 0); true')

    shell.close()
    shell = await until(
      'the shell to come back with a working bridge',
      async () => connectShell(port).catch(() => false),
      60_000
    )

    const afterMarker = await shell.evaluate('window.__chorusOwnerLifecycle ?? null')
    const navType = await shell.evaluate(
      `performance.getEntriesByType('navigation')[0]?.type ?? 'unknown'`
    )
    must(
      'the shell document was replaced, and the one that replaced it works',
      afterMarker === null,
      `marker after=${String(afterMarker)} navigation.type=${String(navType)} bridge=object`
    )

    /*
     * E3's first claim. A count taken from live CDP targets rather than from
     * anything main says about itself — main is the thing under test.
     */
    const gone = await until(
      'the surfaces to be destroyed',
      async () => {
        const found = await surfaces(port)
        return found.length === 0 ? { count: 0 } : false
      },
      20_000
    ).catch(async () => ({ count: (await surfaces(port)).length }))
    must(
      'every surface the reloaded document owned is destroyed',
      gone.count === 0,
      gone.count === 0 ? 'surfaces=0' : `surfaces=${String(gone.count)} after 20s`
    )

    /*
     * E3's second claim, and the reason it is sharp: a reload does **not** replace
     * the `WebContents`. The caller main compares against is the same object it
     * was, so `held?.owner !== caller` cannot be what refuses this — the only way
     * to reach that message is for the grant to have been deleted. The message is
     * asserted rather than the mere rejection, because a rejection on its own could
     * come from anything, including a channel that no longer exists.
     */
    const stale = await tryOpen(shell, grant)
    const expected = `No workbench project grant "${grant}" belongs to this window`
    must(
      'a grant minted by the previous document is refused after the reload',
      stale.ok === false && stale.message.includes(expected),
      stale.ok === true
        ? `ACCEPTED, viewId=${stale.viewId}`
        : `refused: ${stale.message.slice(0, 160)}`
    )

    /*
     * A reload is not a teardown. Pid identity rather than a count, because a
     * count would be satisfied by a *different* server that something restarted.
     */
    const survived = await readings(3_000, () => servers.filter((pid) => alive(pid)))
    must(
      'the remote extension host survives the shell reload, same pids',
      survived.length > 0 && survived.every((sample) => sample.length === servers.length),
      `expected [${servers.join(',')}] · alive counts over 3s: [${survived.map((s) => s.length).join(',')}]`
    )

    // ── recovery ──────────────────────────────────────────────────────────────
    /*
     * The revocation has to be a revocation and not a wedge. A fresh mint from the
     * new document opens a surface, which is also the only thing that proves the
     * shell is usable rather than merely responding.
     */
    const second = await shell.evaluate('window.chorus.chooseWorkbenchProject()')
    must(
      'the reloaded document can mint a grant of its own',
      second.chosen !== null,
      second.chosen === null ? 'the chooser minted nothing' : `root=${second.chosen.projectRoot}`
    )
    const reopened = await tryOpen(shell, second.chosen.grant)
    must(
      'a grant minted by the new document opens a surface',
      reopened.ok === true,
      reopened.ok === true ? `viewId=${reopened.viewId}` : `refused: ${reopened.message}`
    )
    const back = await until(
      'the replacement surface',
      async () => {
        const found = await surfaces(port)
        return found.length === 1 ? found : false
      },
      120_000
    )
    must(
      'exactly one surface is open again',
      back.length === 1,
      `surfaces=${String(back.length)} url=${back[0]?.url ?? 'none'}`
    )

    shell.close()
  } finally {
    child.kill('SIGKILL')
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
    `\nthe owner-lifecycle gate could not complete: ${error.stack ?? error.message}\n`
  )
  process.exitCode = 1
})
