import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The single-surface gate — the product-matched architecture, measured.
 *
 * **What the product actually does**, and it is not what C-054 was observed under:
 * several projects may stay open with their agents and terminals running, but only
 * the **active** project's workbench is mounted and visible. Switching is
 * A → B → A, and two project workbenches never coexist visually. Every C-054
 * sighting came from a scenario with **two surfaces mounted at once**, which this
 * design does not do — so the ten-run evidence may describe a configuration the
 * product will never be in.
 *
 * **The independent variable is the surface count, so the surface count is
 * measured rather than arranged.** A gate that opened one surface at a time and
 * assumed the property held would pass whether or not it did, which is the shape
 * of defect this project has now found six times. So every step boundary asserts
 * the live count, and — the part that matters — **every wait samples it too**, so a
 * second surface existing for part of a file open cannot slip between checks.
 *
 * **What makes that assertion able to fail**, stated because "it passed" is worth
 * nothing otherwise: the count is the number of live CDP page targets whose URL is
 * the workbench document. It is an independent observation of the renderer
 * processes, not a tally of what this script asked for, and the containment gate
 * routinely waits for it to read **2** — so a counter that cannot return 2 is not
 * what is being used here. If `closeWorkbench` failed to destroy a `WebContents`,
 * the post-destroy assertion reads 1 and fails; if a second surface appeared
 * mid-open, the in-wait sample reads 2 and fails.
 *
 * **Ten independent app sessions, each its own process and its own disposable
 * files. Stop at the first failure** — this gate does not run to completion, so
 * an early failure is reported with its evidence rather than buried in nine more
 * runs.
 *
 * Run: `node e2e/workbench-single-surface.mjs` from `apps/desktop`, after a build.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ELECTRON = createRequire(import.meta.url)('electron')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** One open's budget, and the same 60 s the ten-run batch used, so the two compare. */
const OPEN_BUDGET_MS = 60_000

class Failure extends Error {
  constructor(step, detail) {
    super(`${step}: ${detail}`)
    this.step = step
    this.detail = detail
  }
}

async function until(what, predicate, timeoutMs) {
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
  throw new Failure(
    what,
    `timed out after ${String(timeoutMs)}ms (last: ${String(last).slice(0, 200)})`
  )
}

const readDebugPort = (text) => /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)?.[1] ?? null

async function pageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await response.json()).filter((t) => t.type === 'page')
}

/** Live workbench documents. The independent measure the whole gate turns on. */
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
  return { send, evaluate, close: () => socket.close() }
}

const KEY_P = { key: 'p', code: 'KeyP', vk: 80 }
const KEY_A = { key: 'a', code: 'KeyA', vk: 65 }
const KEY_ENTER = { key: 'Enter', code: 'Enter', vk: 13 }
const ACCEL = process.platform === 'darwin' ? 4 : 2

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

const quickInput = async (surface) =>
  JSON.parse(
    await surface.evaluate(`JSON.stringify({
      open: (() => {
        const w = document.querySelector('.quick-input-widget')
        return w !== null && getComputedStyle(w).display !== 'none'
      })(),
      value: document.querySelector('.quick-input-widget .quick-input-box input')?.value ?? null,
      rows: [...document.querySelectorAll('.quick-input-list .monaco-list-row')].slice(0, 8).map(r => ({
        label: r.querySelector('.label-name')?.textContent ?? '',
        focused: r.classList.contains('focused'),
      })),
    })`)
  )

/**
 * Everything the picker can say about itself, and it exists to separate three
 * defects the old instrument reported as one timeout string:
 *
 *  - **no rows offered** — the list is empty;
 *  - **rows offered, none focused** — items exist and focus never moved to one;
 *  - **the wrong rows offered** — a row is focused and it is not the file asked for.
 *
 * Each field is chosen so it can **disagree** with another, because a snapshot
 * whose fields cannot contradict each other records a mood rather than a state:
 *
 *  - `inputValue` against `rows` — the right query with an empty list is a search
 *    that returned nothing; a wrong or empty value is keystrokes that never landed.
 *  - `rows` against `focusedRow` — a populated list with no focus is a different
 *    failure from an empty one, and the two were previously indistinguishable.
 *  - `focusedRow` against `ariaActiveDescendant` — the DOM's `.focused` class and
 *    the value VS Code advertises to assistive technology are maintained
 *    separately, so a disagreement says the widget's own idea of focus is not what
 *    is rendered.
 *  - `rows` against `message` and `progress` — empty with a progress bar is still
 *    searching; empty with "no matching results" is a search that finished with
 *    nothing.
 *  - `visibility` and `activeElement` against all of it — a hidden document or
 *    focus parked elsewhere would explain input never arriving, without the picker
 *    itself being at fault.
 */
const PICKER_SNAPSHOT = `(() => {
  const widget = document.querySelector('.quick-input-widget')
  const input = document.querySelector('.quick-input-widget .quick-input-box input')
  const active = document.activeElement
  const rows = [...document.querySelectorAll('.quick-input-list .monaco-list-row')]
  return JSON.stringify({
    at: Date.now(),
    widgetPresent: widget !== null,
    widgetDisplay: widget === null ? null : getComputedStyle(widget).display,
    inputValue: input === null ? null : input.value,
    inputFocused: input !== null && active === input,
    activeElement: (active?.tagName ?? '?') + '.' + (active?.className ?? '').split(' ').slice(0, 2).join('.'),
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    rowCount: rows.length,
    rows: rows.slice(0, 10).map(r => ({
      label: r.querySelector('.label-name')?.textContent ?? '',
      description: r.querySelector('.label-description')?.textContent ?? '',
      focused: r.classList.contains('focused'),
      id: r.getAttribute('id'),
    })),
    focusedRow: rows.map(r => r.classList.contains('focused') ? (r.querySelector('.label-name')?.textContent ?? '') : null).find(l => l !== null) ?? null,
    /* What the widget tells assistive technology is focused — maintained apart
       from the CSS class, so the two can disagree and that disagreement is a fact. */
    ariaActiveDescendant: input === null ? null : input.getAttribute('aria-activedescendant'),
    ariaExpanded: input === null ? null : input.getAttribute('aria-expanded'),
    /* "No matching results" and friends: an empty list that has finished. */
    message: document.querySelector('.quick-input-message')?.textContent ?? null,
    /* An active progress bar inside the widget: an empty list still filling. */
    progress: [...document.querySelectorAll('.quick-input-widget .monaco-progress-container')]
      .filter(p => p.classList.contains('active')).length,
    countBadge: document.querySelector('.quick-input-count')?.textContent ?? null,
    notifications: [...document.querySelectorAll('.notifications-toasts .notification-list-item-message')]
      .map(n => n.textContent).join(' // ').slice(0, 240),
  })
})()`

const pickerSnapshot = async (surface) => {
  try {
    return JSON.parse(await surface.evaluate(PICKER_SNAPSHOT))
  } catch (error) {
    return { snapshotError: error.message }
  }
}

/** Names the defect the snapshot describes, so the three cases stay apart. */
function classifyPicker(snapshot, wanted) {
  if (snapshot.snapshotError !== undefined) return 'snapshot failed'
  if (snapshot.widgetPresent !== true || snapshot.widgetDisplay === 'none') {
    return 'the quick input was not open'
  }
  if (snapshot.inputValue !== wanted) return 'the query was not in the box'
  if (snapshot.rowCount === 0) {
    if (snapshot.progress > 0) return 'no rows offered — still searching'
    if (snapshot.message !== null) return `no rows offered — search finished: ${snapshot.message}`
    return 'no rows offered — no progress and no message'
  }
  if (snapshot.focusedRow === null)
    return `rows offered (${String(snapshot.rowCount)}) but none focused`
  if (snapshot.focusedRow !== wanted) {
    return `the wrong row was focused: ${snapshot.focusedRow}`
  }
  return 'the row was focused after all — the wait and the snapshot disagree'
}

const editorState = async (surface) =>
  JSON.parse(
    await surface.evaluate(`JSON.stringify({
      tab: document.querySelector('.tabs-container .tab.active .label-name')?.textContent ?? null,
      lineNumbers: document.querySelectorAll('.margin-view-overlays .line-numbers').length,
      textLength: [...document.querySelectorAll('.view-line')].map(l => l.textContent).join('').length,
    })`)
  )

async function main() {
  const results = []
  // How many fresh sessions this invocation runs. Codex's sequence is one
  // diagnostic session first, then the rest only if it passes.
  const total = Number.parseInt(process.env['CHORUS_GATE_SESSIONS'] ?? '10', 10)
  for (let session = 1; session <= total; session += 1) {
    const outcome = await runSession(session)
    results.push(outcome)
    process.stdout.write(`\n── session ${String(session)}: ${outcome.ok ? 'PASS' : 'FAIL'}\n`)
    for (const line of outcome.log) process.stdout.write(`     ${line}\n`)
    if (!outcome.ok) {
      // Stop at the first failure, deliberately: nine more sessions would bury the
      // evidence rather than add to it.
      process.stdout.write(`\nFIRST FAILURE — step: ${outcome.failure.step}\n`)
      process.stdout.write(`  ${outcome.failure.detail}\n`)
      process.stdout.write(`\n${String(session - 1)}/${String(total)} sessions passed before it.\n`)
      process.exitCode = 1
      return
    }
  }
  process.stdout.write(
    `\n${String(total)}/${String(total)} sessions passed, one workbench surface at every measured moment.\n`
  )
}

async function runSession(session) {
  const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`
  const dataPath = join(tmpdir(), `chorus-single-${stamp}`)
  const projects = join(tmpdir(), `chorus-single-projects-${stamp}`)
  mkdirSync(dataPath, { recursive: true })

  /** Unique per session, and each opened exactly once. */
  const A_FILES = ['a-first.md', 'a-second.txt']
  const A_LATER = 'a-later.md'
  const B_FILES = ['b-first.md', 'b-second.txt']
  const write = (root, name, body) => writeFileSync(join(root, name), body)
  const rootA = join(projects, 'project-a')
  const rootB = join(projects, 'project-b')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
  for (const name of [...A_FILES, A_LATER])
    write(rootA, name, `# ${name} ${stamp}\n\nproject A fixture.\n`)
  for (const name of B_FILES) write(rootB, name, `# ${name} ${stamp}\n\nproject B fixture.\n`)
  const canonicalA = realpathSync(rootA)
  const canonicalB = realpathSync(rootB)

  const env = {
    ...process.env,
    CHORUS_USER_DATA: dataPath,
    // Three answers, because the session opens A, then B, then A again — and the
    // chooser is answered in order.
    CHORUS_WORKBENCH_E2E_ROOTS: [canonicalA, canonicalB, canonicalA].join(delimiter),
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

  const log = [`process ${String(child.pid)} · ${basename(dataPath)}`]
  const marker = `${basename(dataPath)}/workbench-server`

  try {
    const port = await until('a debugging port', () => readDebugPort(output), 60_000)

    /** Asserts the live surface count, and says what it saw when it is wrong. */
    const expectSurfaces = async (expected, where) => {
      const live = await surfaces(port)
      if (live.length !== expected) {
        throw new Failure(
          where,
          `expected ${String(expected)} workbench surface(s), found ${String(live.length)}: [${live.map((t) => t.url.slice(-40)).join(', ')}]`
        )
      }
      return live
    }

    const shellTarget = await until(
      'the shell window',
      async () => (await pageTargets(port)).find((t) => !t.url.includes('workbench.html')) ?? false,
      90_000
    )
    const shell = await attach(shellTarget)
    await until(
      'the shell bridge',
      async () => (await shell.evaluate('typeof window.chorus')) === 'object',
      90_000
    )
    await expectSurfaces(0, 'before any project is opened')

    /** Opens the next seeded project into the single surface slot. */
    const openSurface = async (label, expectedRoot) => {
      const { chosen } = await shell.evaluate('window.chorus.chooseWorkbenchProject()')
      if (chosen === null) throw new Failure(label, 'the chooser minted nothing')
      const { viewId } = await shell.evaluate(
        `window.chorus.openWorkbench({ grant: ${JSON.stringify(chosen.grant)} })`
      )
      await shell.evaluate(
        `window.chorus.setWorkbenchBounds({ viewId: ${JSON.stringify(viewId)}, rect: { x: 20, y: 40, width: 1180, height: 700 } })`
      )
      const live = await until(
        `${label}: the surface to appear`,
        async () => {
          const found = await surfaces(port)
          return found.length === 1 ? found : false
        },
        90_000
      )
      const session_ = await attach(live[0])
      await until(
        `${label}: a rendered workbench`,
        () => session_.evaluate(`document.querySelector('.monaco-workbench') !== null`),
        90_000
      )
      const root = await session_.evaluate(
        'window.chorusWorkbench.connection().then(c => c.projectRoot)'
      )
      if (root !== expectedRoot) {
        throw new Failure(label, `surface reports ${String(root)}, expected ${expectedRoot}`)
      }
      // One surface, and it is the right one — "exactly one" is not satisfied by
      // the wrong project being mounted.
      await expectSurfaces(1, `${label}: after mounting`)
      log.push(`${label} mounted, 1 surface, root ok`)
      return { viewId, session: session_ }
    }

    const destroySurface = async (label, viewId, session_) => {
      await shell.evaluate(`window.chorus.closeWorkbench({ viewId: ${JSON.stringify(viewId)} })`)
      await until(
        `${label}: the surface to go`,
        async () => (await surfaces(port)).length === 0,
        60_000
      )
      session_.close()
      await expectSurfaces(0, `${label}: after destroying`)
      log.push(`${label} destroyed, 0 surfaces`)
    }

    /**
     * One file, opened once — and the surface count is sampled on **every poll**,
     * not only at the boundaries. A second surface existing for part of an open is
     * exactly what a boundary-only check would miss.
     */
    const openFile = async (label, session_, relPath) => {
      await session_.send('Page.bringToFront').catch(() => undefined)
      await press(session_, KEY_P, { modifiers: ACCEL })
      await until(
        `${label}/${relPath}: quick input`,
        async () => (await quickInput(session_)).open,
        30_000
      )
      await press(session_, KEY_A, { modifiers: ACCEL, commands: ['selectAll'] })
      await session_.send('Input.insertText', { text: relPath })
      await until(
        `${label}/${relPath}: the query in the box`,
        async () => (await quickInput(session_)).value === relPath,
        30_000
      )
      /*
       * The picker wait, with its state captured **on the timeout path** — which is
       * the only moment it is worth anything. The previous version reported every
       * picker failure as the same string, so "no rows offered", "rows offered but
       * none focused" and "the wrong row focused" were indistinguishable, and the
       * one C-056 sighting this gate produced was thinner than it needed to be.
       *
       * A short timeline as well as a final snapshot, because a list that appeared
       * and then emptied is a different fact from one that never filled, and a
       * single snapshot at the end cannot tell them apart.
       */
      const trail = []
      await until(
        `${label}/${relPath}: the focused row`,
        async () => {
          const seen = await pickerSnapshot(session_)
          trail.push(seen)
          if (trail.length > 24) trail.splice(1, 1)
          return seen.focusedRow === relPath ? true : false
        },
        OPEN_BUDGET_MS
      ).catch((error) => {
        const last = trail[trail.length - 1] ?? {}
        const started = trail[0]?.at ?? 0
        const timeline = trail
          .map(
            (s) =>
              `+${String((s.at ?? 0) - started)}ms rows=${String(s.rowCount)} focused=${JSON.stringify(s.focusedRow)} progress=${String(s.progress)} msg=${JSON.stringify(s.message)}`
          )
          .join('\n        ')
        throw new Failure(
          `${label}/${relPath}: the focused row`,
          [
            `${error.detail ?? error.message}`,
            `classification: ${classifyPicker(last, relPath)}`,
            `final snapshot: ${JSON.stringify(last)}`,
            `timeline (${String(trail.length)} samples):\n        ${timeline}`,
          ].join('\n        ')
        )
      })
      const startedAt = Date.now()
      await press(session_, KEY_ENTER)
      const state = await until(
        `${label}/${relPath}: the model to resolve`,
        async () => {
          // The surface count, inside the wait. This is the assertion that makes
          // "one surface at every moment" a measurement rather than an arrangement.
          await expectSurfaces(1, `${label}/${relPath}: while the model resolves`)
          const now = await editorState(session_)
          return now.tab === relPath && now.lineNumbers > 0 && now.textLength > 0 ? now : false
        },
        OPEN_BUDGET_MS
      )
      log.push(
        `${label} opened ${relPath} in ${String(Date.now() - startedAt)}ms, ${String(state.lineNumbers)} lines`
      )
    }

    // ── A → destroy → B → destroy → A, one surface throughout ────────────────
    const a1 = await openSurface('A', canonicalA)
    for (const name of A_FILES) await openFile('A', a1.session, name)
    await destroySurface('A', a1.viewId, a1.session)

    const b1 = await openSurface('B', canonicalB)
    for (const name of B_FILES) await openFile('B', b1.session, name)
    await destroySurface('B', b1.viewId, b1.session)

    const a2 = await openSurface('A again', canonicalA)
    // Previously unopened, so it cannot be answered from a model already in memory.
    await openFile('A again', a2.session, A_LATER)
    await destroySurface('A again', a2.viewId, a2.session)

    return { ok: true, session, log }
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure('unexpected', error.message)
    const serverLog = join(dataPath, 'logs', 'workbench-server.log')
    if (existsSync(serverLog)) {
      log.push(
        `server log tail: ${readFileSync(serverLog, 'utf8').split('\n').filter(Boolean).slice(-6).join(' | ')}`
      )
    }
    log.push(`app output tail: ${output.split('\n').filter(Boolean).slice(-4).join(' | ')}`)
    return { ok: false, session, log, failure }
  } finally {
    child.kill('SIGTERM')
    await until('electron to exit', async () => child.exitCode !== null, 20_000).catch(
      () => undefined
    )
    child.kill('SIGKILL')
    await wait(500)
    try {
      const listing = execFileSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
      for (const line of listing.split('\n')) {
        if (!line.includes(marker)) continue
        const pid = Number.parseInt(line.trim(), 10)
        if (Number.isInteger(pid)) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* nothing to sweep */
    }
    rmSync(dataPath, { recursive: true, force: true })
    rmSync(projects, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`\nthe gate could not complete: ${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
