import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The two-surface coexistence gate — preflight §2.5 steps 1 and 3.
 *
 * The plan's product shape is project tabs: several workbenches alive at once.
 * Nobody has demonstrated that. The maintainer's own sandbox demo runs **one**
 * instance and reinitialises it, and the closest thing to a claim is an argument
 * from realms rather than a result. So this is a falsification experiment, and a
 * failure here is a useful outcome — the whole point is that it can say no.
 *
 * **Everything is driven through commands and observable state.** An earlier
 * version measured a rectangle in the explorer's virtualised list and clicked it,
 * which is a coordinate that is stale by the time it is used: rows shifted under
 * it as the remote extension host answered and the click opened an unrelated file,
 * then a folder. That is not a weaker test of the same thing, it is a test of the
 * harness's timing — so the file open is now quick open, addressed by the file's
 * own relative path, and every step waits on a state the workbench reports about
 * itself: the text in the quick input box, the label of the focused row, the name
 * of the active tab, the width of a part. Nothing here reads a `getBoundingClientRect`.
 *
 * What it asks, in the order the answers are cheap:
 *
 *  1. Do two surfaces render their own workbench in their own document, with the
 *     shell's `ChorusApi` in neither?
 *  2. Does each read **its own** real project from the one shared server?
 *  3. **Does destroying one leave the other working?** This is the crux, and
 *     "working" means the survivor still opens a file over the server, still
 *     takes a keystroke, and still runs a command — with the server's process
 *     still alive on the port it discovered.
 *
 * Run: `node e2e/workbench-containment.mjs` from `apps/desktop`, after a build.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')

/**
 * Electron's own binary, and **never `npx electron`** — which is the correction
 * that invalidated a whole finding.
 *
 * `spawn('npx', …)` returns a handle on the **wrapper**, so `child.pid` is npm's
 * process and `child.kill('SIGTERM')` signals npm. Whether Electron ever received
 * the signal, and what it did about it, are simply not observable from there. On
 * that footing this gate reported "the server is still running after the app went"
 * and that sentence described the *wrapper* going — the app's own shutdown had not
 * been exercised at all, and an orphan finding was raised on it. Evidence gathered
 * through a wrapper describes the wrapper.
 *
 * The `electron` package's main export is the path to the executable when it is
 * required from Node rather than from Electron, which is how `child.pid` becomes
 * the main process and `exit` becomes the app's own.
 */
const ELECTRON = createRequire(import.meta.url)('electron')

/**
 * One stamp for the whole run, so every path and every marker this gate writes
 * can be traced back to it — and so that nothing a previous run left behind can
 * satisfy an assertion in this one.
 */
const STAMP = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Two disposable fixture projects in a temporary directory — and **never the
 * Chorus checkout**, which is the correction this whole section exists for.
 *
 * The gate types a marker into an open buffer to prove the surviving editor still
 * takes a keystroke, and the workbench auto-saves. Pointed at the repository, that
 * combination edited `apps/desktop/package.json` on disk: line 1 became
 * `CHORUS-ALIVE{`. The auto-save is **expected behaviour** — it is Code-OSS's own
 * web default and Chorus keeps it deliberately — so the fault was never the
 * saving, it was a test that pointed a live editor at the source tree it was
 * testing from. A harness may not write to the repository it is checking, and the
 * fix is to give it something of its own to write to.
 *
 * Two roots rather than one, because preflight §4.1a's point stands: two surfaces
 * on a single root share every watcher and every piece of workspace storage, so
 * the second project would look nearly free for a reason that vanishes the moment
 * the roots differ. The trees are deliberately *different* trees, so "each surface
 * lists its own project" is a claim a shared view could not satisfy.
 *
 * Being written here rather than found is a gain, not a compromise: the gate knows
 * the exact bytes, so "the editor shows what is on disk" is an equality rather than
 * a substring search for something that looked distinctive.
 */
const PROJECTS = join(tmpdir(), `chorus-workbench-projects-${STAMP}`)

function writeProject(name, id) {
  const root = join(PROJECTS, name)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, `${name}-manifest.yaml`),
    `project: ${name}\nid: ${id}\ncreated-by: chorus-workbench-containment-gate\n`
  )
  writeFileSync(
    join(root, `${name}-notes.md`),
    `# ${name}\n\nfixture-id: ${id}\n\nThis file exists to be opened and edited by the gate.\n`
  )
  writeFileSync(join(root, 'src', `${name}-service.ts`), `export const ${name}Id = '${id}'\n`)
  // Canonical, for the same reason main canonicalises what the chooser answered:
  // on macOS `tmpdir()` is itself behind a symlink (`/var` → `/private/var`), so
  // an uncanonicalised root would fail the descriptor comparison on a difference
  // that has nothing to do with isolation.
  return realpathSync(root)
}

const ALPHA_ID = `alpha-${STAMP}`
const BETA_ID = `beta-${STAMP}`
const ROOT_A = writeProject('alpha', ALPHA_ID)
const ROOT_B = writeProject('beta', BETA_ID)

/**
 * One known file per root, named by its exact relative path.
 *
 * **Unique**, because quick open scores fuzzily and returns everything that
 * matches, so a name that occurs twice turns "the focused row is the file I asked
 * for" into a question about ranking. **Distinctive**, because the marker is the
 * evidence that the *bytes* came off the disk — and the marker is this run's own
 * id, so a file left by an earlier run cannot satisfy it. No marker contains a
 * space: VS Code renders runs of whitespace as `&nbsp;`, so a marker with
 * indentation in it would compare against a character that is not in the file.
 */
const FIXTURES = {
  [ROOT_A]: { path: 'alpha-manifest.yaml', marker: ALPHA_ID },
  [ROOT_B]: { path: 'beta-manifest.yaml', marker: BETA_ID },
}

/**
 * What the survivor opens after its sibling is destroyed, and what it then edits.
 *
 * A second file rather than the one already on screen: reopening the same editor
 * would be answered from the model already in memory, which is exactly the state a
 * dead server would also produce. A file this surface has never read can only come
 * over the connection.
 */
const EDIT_TARGET = { path: 'beta-notes.md', marker: BETA_ID }
/** Unique to this run, so a stale file on disk cannot make the save look real. */
const TYPED = `CHORUS-ALIVE-${STAMP}`

const results = []
function record(claim, ok, observed) {
  results.push({ claim, ok, observed })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${claim}\n        ${observed}\n`)
}

/**
 * PID, port, exit status and the server's own log — printed whatever happens.
 *
 * `run` and `dataDir` are here so that two runs can be told apart by something
 * other than trust. Output that differs only in random ports and PIDs cannot be
 * called identical and cannot be called distinct either; a run id, a data
 * directory and the app's own PID are what make "these were two runs, and the
 * first was dead before the second began" a checkable statement.
 */
const evidence = {
  run: null,
  dataDir: null,
  electronPid: null,
  electronExit: null,
  reload: null,
  serverPids: [],
  port: null,
  portFromLog: null,
  exit: null,
  logTail: '',
  appTail: '',
  orphansKilled: [],
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * Port zero, and the child tells us which one it got.
 *
 * Repeated from `harness.mjs` rather than imported, because that helper connects
 * to the *first* page target and returns a session — and this gate needs the port
 * itself, to enumerate every target as surfaces appear and disappear. The
 * discipline is the one thing that must not be repeated wrongly: a fixed port
 * attaches to whatever stray Electron is already listening, and every assertion
 * then describes a real DOM belonging to a different build.
 */
function readPort(text) {
  return /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text)?.[1] ?? null
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await response.json()).filter((t) => t.type === 'page')
}

/** One CDP socket onto one page target. No `Runtime.enable`: see harness.mjs. */
async function attach(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => socket.addEventListener('open', r, { once: true }))
  let id = 0
  const send = (method, params = {}) =>
    new Promise((resolvePromise, reject) => {
      const mine = ++id
      const onMessage = (message) => {
        const reply = JSON.parse(message.data)
        if (reply.id !== mine) return
        socket.removeEventListener('message', onMessage)
        if (reply.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(reply.error).slice(0, 300)}`))
          return
        }
        resolvePromise(reply.result)
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id: mine, method, params }))
      setTimeout(() => {
        reject(new Error(`timed out: ${method}`))
      }, 180_000)
    })

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(
        `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
      )
    }
    return result.result?.value
  }

  return { url: target.url, send, evaluate, close: () => socket.close() }
}

async function until(what, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last !== false && last !== null && last !== undefined) return last
    } catch (error) {
      last = error.message
    }
    await wait(400)
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`)
}

/** The state a surface has to be in before anything is asked of it. */
const READY = `(() => {
  const failure = document.querySelector('.workbench-failure')
  if (failure !== null) return { failed: failure.textContent.slice(0, 400) }
  const workbench = document.querySelector('.monaco-workbench')
  if (workbench === null) return false
  return {
    tagged: document.querySelectorAll('[data-vscode]').length,
    workbench: true,
    parts: [...document.querySelectorAll('.monaco-workbench .part')].map(p => p.className.split(' ')[1] ?? '').filter(Boolean),
  }
})()`

/**
 * Says which surface the input is for, before sending any.
 *
 * With two `WebContentsView`s over one window, synthesized input was reaching one
 * of them and not the other — the gate's second surface would answer every query
 * about its DOM and then ignore every keystroke, intermittently. A real user's
 * click is hit-tested by the window and routed to the view under the cursor; CDP
 * has no cursor, so it has to name the target instead. This is the harness
 * supplying what the OS supplies, not a workaround for the app.
 *
 * **It is not proof that a person's clicks route correctly** — that is a
 * different mechanism and it is on the review gate, not on this file.
 */
const focus = async (surface) => {
  await surface.send('Page.bringToFront').catch(() => undefined)
}

/** One key, down and up. `rawKeyDown` because nothing here types a character. */
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
const KEY_ENTER = { key: 'Enter', code: 'Enter', vk: 13 }
/** ⌘ on macOS, ⌃ everywhere else — the modifier bitmask CDP wants. */
const ACCEL = process.platform === 'darwin' ? 4 : 2

/** Every row the quick input is offering, and which one Enter would take. */
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

/**
 * What a surface looks like when it will not answer, and it has to be captured
 * rather than reasoned about.
 *
 * "The keystroke did nothing" has at least four causes that are invisible from
 * the failing assertion and completely different from each other: a **modal
 * dialog** owning the workbench (Workspace Trust's startup prompt is one, and it
 * blocks both keybindings and unload), a **hidden or frozen page**, whose timers
 * and input handling stop while `Runtime.evaluate` keeps working, **input landing
 * in the other view**, and **Restricted Mode** refusing the command itself. Each
 * of those is a different finding about a different piece of code, so the gate
 * records which one it met instead of leaving a reader to guess from a timeout.
 */
const diagnose = async (surface) =>
  surface
    .evaluate(
      `JSON.stringify({
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      activeElement: (document.activeElement?.tagName ?? '?') + '.' + (document.activeElement?.className ?? '').split(' ').slice(0, 2).join('.'),
      dialogs: [...document.querySelectorAll('.monaco-dialog-box, .dialog-shadow, .monaco-dialog-modal-block')].length,
      dialogText: (document.querySelector('.monaco-dialog-box')?.textContent ?? '').slice(0, 200),
      toasts: [...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map(n => n.textContent).join(' // ').slice(0, 240),
      statusbar: (document.querySelector('.statusbar')?.textContent ?? '').slice(0, 160),
      quickInputPresent: document.querySelector('.quick-input-widget') !== null,
      banner: (document.querySelector('.part.banner')?.textContent ?? '').slice(0, 160),
    })`
    )
    .catch((error) => `could not be diagnosed: ${error.message}`)

/**
 * Opens the quick input, puts exactly `query` in it, and takes the focused row
 * once it is the one that was asked for.
 *
 * Three waits, and each replaces something that used to be assumed. **The widget
 * is open** before anything is typed, because `Input.insertText` goes to whatever
 * has focus and an early one lands in the editor — as a silent edit to a real
 * file, not as an error. **The box holds the query**, which is the one observation
 * that distinguishes "the search found nothing" from "the keystrokes went
 * somewhere else"; a select-all precedes it so that whatever the widget
 * remembered is replaced rather than prepended to. **The focused row is the
 * intended one**, because Enter takes the focus and quick open scores fuzzily —
 * checking after the fact would mean reporting on whichever file happened to rank
 * first.
 *
 * `commands: ['selectAll']` rather than a bare ⌘A: a synthesized key event does
 * not run the browser's editing commands unless it names them.
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

  /*
   * The long one, and it is the reloaded surface that sets it. A surface that
   * has just replaced its document has to re-handshake with the server and bring
   * its extension host back up before the remote file search answers at all —
   * observed at ninety seconds once, on a build where every run either side of it
   * passed. A wait that is too short reports a slow reconnection as a broken
   * search, which is the one substitution this gate exists to avoid.
   */
  const state = await until(
    `${what}: the focused row to be the one asked for`,
    async () => {
      const seen = await quickInput(surface)
      const focused = seen.rows.find((row) => row.focused)
      return focused !== undefined && matches(focused) ? seen : false
    },
    120_000
  )
  await press(surface, KEY_ENTER)
  return state
}

/**
 * ── C-054 instrumentation: passive, failure-oriented, opt-in ────────────────
 *
 * Enabled by `CHORUS_GATE_TRACE=<dir>`; unset, the gate behaves exactly as it did.
 * The scenario is **unchanged** — the same actions in the same order — and the
 * only difference is that the wait for a file to open samples a wider snapshot on
 * each poll it was already doing, and writes what it saw.
 *
 * **The thing it has to be able to say.** The sighting was an editor that opened
 * the *right tab* onto a document with no content on screen, while quick open
 * found every file by path and the server showed both connections up. So "did the
 * file open" cannot fail here — it opened. What is needed is a signal derived from
 * the **model** rather than from the tab, and one that can disagree with the tab.
 *
 * Two are recorded, and they fail in different places:
 *
 *  - **`lineNumbers`** — `.margin-view-overlays .line-numbers` are rendered one per
 *    model line. This is the discriminator: `tab` present with `lineNumbers: 0`
 *    means **no resolved model within the window this gate waited**, where
 *    `lineNumbers: 3` with empty `.view-line` text would mean a model that
 *    resolved and a view that did not paint it. Different layers.
 *  - **`explorerRows`** — the explorer lists through the `vscode-remote` **file
 *    system provider**, which is a different channel from quick open's search
 *    (that one goes through the extension host). Rows present means the provider
 *    is registered and answering `readdir`; rows absent alongside a working quick
 *    open would point at the provider rather than at the connection.
 *
 * **`progress` is recorded and is not a discriminator — that claim was withdrawn.**
 * It was described here as "the closest observable to a request still pending",
 * separating *stuck waiting* from *finished with nothing*. Run 4 killed that: the
 * indicator was empty in the failing opens **and** in the healthy one in the same
 * run. It is kept only so a future reader can see it says nothing, and its earlier
 * apparent significance came from a **global** selector matching unrelated
 * workbench activity during startup.
 *
 * **And no wait here proves non-resolution.** A finite budget supports exactly one
 * statement — *not resolved within that budget*. One open in the ten-run batch
 * resolved at 52,999 ms, which is why "never" is the wrong word and does not
 * appear below.
 *
 * **What this cannot reach, stated because Codex asked for it by name.** The live
 * `ITextModel`, the FS provider's pending-request queue and the remote agent's
 * connection object are all inside the workbench's module graph, and nothing puts
 * them on `window`. Reaching them needs a hook in `entry.ts`, which is a
 * production change and is out of scope for a diagnostic pass.
 *
 * **Nothing here reads the model's own URI, and an earlier version of this comment
 * said it did.** It claimed the URI came from the tab's `title`. It does not and
 * never did: `title` was `null` on every sample of all ten runs. What is available
 * are **rendered resource proxies** — the labels the workbench draws for a person,
 * `aria-label` and the breadcrumb trail — which name a resource without being one.
 * Content state comes from the two DOM signals above, provider readiness from the
 * explorer, and connection state from the status bar's remote indicator plus the
 * server's own log. Every one of those is a **proxy**, and the report says so.
 */
const TRACE_DIR = process.env['CHORUS_GATE_TRACE'] ?? null
let traceSeq = 0

const SNAPSHOT = `(() => {
  const text = (node) => (node === null ? null : node.textContent)
  const editor = document.querySelector('.monaco-editor')
  const tab = document.querySelector('.tabs-container .tab.active')
  const placeholder = document.querySelector('[class*="placeholder"]')
  /* Where a match came from, so a reader can check the claim rather than trust it. */
  const locate = (el) => {
    const parts = []
    let node = el
    for (let depth = 0; node !== null && depth < 6; depth += 1) {
      const raw = typeof node.className === 'string' ? node.className.trim() : ''
      const cls = raw === '' ? '' : '.' + raw.split(/\\s+/).slice(0, 3).join('.')
      parts.unshift(node.tagName.toLowerCase() + cls)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const activeProgress = [...document.querySelectorAll('.monaco-progress-container')]
    .filter((el) => el.classList.contains('active'))
  const editorPart = document.querySelector('.part.editor')
  return JSON.stringify({
    tab: text(tab?.querySelector('.label-name') ?? null),
    /*
     * **A resource proxy, not the model URI.** These are labels the workbench
     * renders for a person; nothing here reads the model's own \`uri\`, which is
     * inside the module graph and needs a hook that is not authorised. The
     * previous probe read the tab's \`title\`, which this build never sets — it
     * returned null on every sample of every run — so the two better labels are
     * captured beside it rather than instead of it, and the name says what they
     * are.
     */
    resourceProxy: {
      tabAriaLabel: tab?.getAttribute('aria-label') ?? null,
      breadcrumbs: [...document.querySelectorAll('.monaco-breadcrumbs .monaco-breadcrumb-item')]
        .map((el) => (el.textContent ?? '').trim())
        .filter((part) => part !== '')
        .join(' / ') || null,
      tabTitle: tab?.getAttribute('title') ?? null,
    },
    tabClass: tab?.className ?? null,
    /* One element per model line. Zero with a tab present means no model resolved
       within the window this gate waited — not that none ever would. */
    lineNumbers: document.querySelectorAll('.margin-view-overlays .line-numbers').length,
    viewLines: document.querySelectorAll('.view-line').length,
    textLength: [...document.querySelectorAll('.view-line')].map(l => l.textContent).join('').length,
    firstLine: text(document.querySelector('.view-line')),
    editorPresent: editor !== null,
    /*
     * **Recorded, and it distinguishes nothing — the claim it was added for was
     * withdrawn.**
     *
     * The first version selected an active \`monaco-progress-container\`
     * **globally**, which matches the explorer filling in and the extension host
     * coming up. It was active in the first sample of every healthy open, and that
     * was read as a signature of a pending file request. It was not: run 4 showed
     * the indicator empty in the failing opens *and* in the healthy open in the
     * same run.
     *
     * So progress does **not** separate "a request is pending" from "a request
     * finished with nothing", and nothing downstream should treat it as if it
     * does. Both scopes are kept, with the DOM location of each match, so the next
     * reader can confirm that for themselves rather than take this comment on
     * trust — which is how the original claim survived as long as it did.
     */
    progress: {
      inEditor: activeProgress
        .filter((el) => editorPart !== null && editorPart.contains(el))
        .map((el) => ({ className: el.className, where: locate(el) })),
      anywhere: activeProgress.map((el) => ({ className: el.className, where: locate(el) })),
    },
    placeholder: placeholder === null ? null : (placeholder.className + ' :: ' + (placeholder.textContent ?? '')).slice(0, 200),
    /* The FS provider answering readdir, which quick open's search does not need. */
    explorerRows: document.querySelectorAll('.explorer-folders-view .monaco-list-row').length,
    statusbar: (text(document.querySelector('.statusbar')) ?? '').slice(0, 240),
    toasts: [...document.querySelectorAll('.notifications-toasts .notification-list-item-message')]
      .map(n => n.textContent).join(' // ').slice(0, 300),
    failureElement: text(document.querySelector('.workbench-failure')),
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  })
})()`

const snapshot = async (surface) => {
  try {
    return JSON.parse(await surface.evaluate(SNAPSHOT))
  } catch (error) {
    return { snapshotError: error.message }
  }
}

/** One trace per file-open attempt, written whether it succeeded or not. */
function writeTrace(name, payload) {
  if (TRACE_DIR === null) return
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
    traceSeq += 1
    writeFileSync(
      join(TRACE_DIR, `${String(traceSeq).padStart(2, '0')}-${name}.json`),
      JSON.stringify(payload, null, 2)
    )
  } catch {
    /* a trace that cannot be written must not fail the run it is describing */
  }
}

/** What the editor area says about itself. No coordinates, no rectangles. */
const editorState = async (surface) =>
  JSON.parse(
    await surface.evaluate(`JSON.stringify({
      tab: document.querySelector('.tabs-container .tab.active .label-name')?.textContent ?? null,
      dirty: (document.querySelector('.tabs-container .tab.active')?.className ?? '').includes('dirty'),
      text: [...document.querySelectorAll('.view-line')].map(l => l.textContent).join('\\n'),
    })`)
  )

/**
 * Opens one real file by its relative path and answers with what the editor then
 * holds — or with a diagnosis, never with a bare timeout.
 *
 * A step that gives up without saying what it was looking at costs an afternoon.
 * The rows the quick input was offering are the whole difference between "the
 * remote file search is not wired up" and "it offered the file and Enter did not
 * take it", and those are completely different findings about completely
 * different code.
 */
async function openByPath(surface, file, what) {
  const name = basename(file.path)
  try {
    await pickInQuickInput(surface, file.path, (row) => row.label === name, what)
  } catch (error) {
    const seen = await quickInput(surface).catch(() => ({ rows: [] }))
    return {
      failure: `${error.message} · offered: ${seen.rows.map((r) => `${r.label}${r.focused ? '*' : ''}`).join(',') || 'nothing'}\n        surface: ${await diagnose(surface)}`,
    }
  }
  /*
   * The decision is unchanged — the same tab name and the same non-empty text —
   * and the timeline is gathered from the poll that was already happening. What it
   * adds is the ability to say *where* an open stopped: the first sample at which
   * the tab appeared, the first at which the model had lines, and the first at
   * which those lines had text. A run where the second does not arrive **inside
   * this budget** is a model that had not resolved by then; one where the third
   * does not is a model that had. Neither says what would have happened later —
   * the budget is 60 s and one observed open took 53 s.
   */
  const startedAt = Date.now()
  const timeline = []
  let firstTab = null
  let firstLines = null

  const settle = await until(
    `${what}: ${file.path} to become the active editor`,
    async () => {
      const state = TRACE_DIR === null ? await editorState(surface) : await snapshot(surface)
      if (TRACE_DIR !== null) {
        const at = Date.now() - startedAt
        timeline.push({ at, ...state })
        if (firstTab === null && state.tab === name) firstTab = at
        if (firstLines === null && (state.lineNumbers ?? 0) > 0) firstLines = at
        const text = state.textLength ?? 0
        if (state.tab !== name || text === 0) return false
        // The marker assertions downstream read `.text`, so the full joined text is
        // fetched once, on the way out, rather than on every poll.
        const full = await surface.evaluate(
          `[...document.querySelectorAll('.view-line')].map(l => l.textContent).join('\\n')`
        )
        return { ...state, text: full }
      }
      return state.tab === name && state.text.trim() !== '' ? state : false
    },
    60_000
  ).catch(async (error) => ({
    failure: `${error.message} · activeTab=${(await editorState(surface).catch(() => ({}))).tab ?? '?'}`,
  }))

  writeTrace(`${what.replace(/[^a-z0-9]+/gi, '-')}-${name}`, {
    file: file.path,
    surface: what,
    outcome: settle.failure === undefined ? 'opened' : 'failed',
    /*
     * The three timings Codex asked for, decomposed. `tabAt` without `linesAt` is
     * the sighting: a tab that opened onto a model that had not resolved when the
     * budget ran out. `null` here means *not observed within 60 s* and nothing
     * more — it is not evidence that it would never have arrived.
     */
    tabAt: firstTab,
    linesAt: firstLines,
    contentAt: settle.failure === undefined ? Date.now() - startedAt : null,
    totalMs: Date.now() - startedAt,
    failure: settle.failure ?? null,
    timeline,
  })

  return settle
}

/**
 * Every process this run's remote extension host owns, found by a marker no other
 * run can carry.
 *
 * The server's argv holds `--server-data-dir <userData>/workbench-server/server`,
 * and `userData` is this run's own `mkdtemp` directory — so matching on that name
 * cannot pick up a server left behind by an earlier run, which is the same rule
 * `--remote-debugging-port=0` exists for one level out. `-ww` because macOS `ps`
 * truncates a command line to the terminal width otherwise, and every
 * distinguishing argument here is at the end of a very long one.
 */
function serverPids(marker) {
  const listing = execFileSync('ps', ['-Awwo', 'pid=,command='], { encoding: 'utf8' })
  return listing
    .split('\n')
    .filter((line) => line.includes(marker))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid))
}

/** Signal 0 asks the kernel whether the process is there, and sends nothing. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main() {
  const dataPath = join(tmpdir(), `chorus-workbench-gate-${Date.now()}`)
  mkdirSync(dataPath, { recursive: true })
  /*
   * Two markers, because the two questions are different.
   *
   * `SERVER` matches the one process Chorus spawned — its argv carries
   * `--server-data-dir <userData>/workbench-server/server` — which is the PID the
   * liveness claim is about. `RUN` matches everything under this run's temporary
   * directory, which is a wider net: the server forks an extension host per
   * connection and a file watcher, and those name the extraction directory rather
   * than the server-data one. Killing only the parent is why ninety-three of them
   * were found alive from earlier runs.
   */
  const SERVER = `${basename(dataPath)}/workbench-server`
  const RUN = basename(dataPath)
  const serverLog = join(dataPath, 'logs', 'workbench-server.log')
  evidence.run = RUN
  evidence.dataDir = dataPath
  // Said at the start as well as at the end, so a run that dies mid-way is still
  // identifiable in whatever output it managed to produce.
  process.stdout.write(`run ${RUN}\n        data dir ${dataPath}\n`)

  /*
   * The two roots the chooser will answer with, in order.
   *
   * `workbench:open` takes a capability main minted from the native folder
   * chooser, and a native dialog is drawn by the OS — CDP cannot click it. So the
   * gate seeds the *answers*, through the environment, which is the one input a
   * renderer cannot reach: main still canonicalises them, still binds each grant
   * to the window that asked, and still refuses a path. What is replaced is the
   * hand on the mouse, not the authorisation.
   *
   * **The same variable waives Workspace Trust**, and only in a build that is not
   * packaged — both conditions, checked in main. It is here because the trust
   * prompt is *modal*: it takes DOM focus, and while it is up `⌘P` opens nothing,
   * a command runs nothing and Electron silently cancels `location.reload()`. It
   * was observed doing exactly that, and *intermittently* — one run had surface A
   * finish its file open before the dialog arrived and the next had it caught —
   * which is the worst property a gate can have, because it makes a real result
   * and a timing accident look the same. Production is untouched: a shipped
   * descriptor carries no trust field at all.
   */
  const env = {
    ...process.env,
    CHORUS_USER_DATA: dataPath,
    CHORUS_WORKBENCH_E2E_ROOTS: [ROOT_A, ROOT_B].join(delimiter),
    /*
     * The download cache, pointed at the checkout's own.
     *
     * `CHORUS_USER_DATA` above is a temporary directory this gate deletes, so
     * without this every run would refetch 76 MB and re-verify it. What it does
     * **not** do is skip a check: the archive is still hashed against the
     * committed manifest before a single entry is extracted, and the extraction
     * still lands in a fresh `userData`, so the transactional path runs in full
     * on every run. Development only — `workbench-host.ts` ignores it when the
     * app is packaged.
     */
    CHORUS_WORKBENCH_CACHE: resolve(APP, '../../.workbench-cache'),
  }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=0'], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  // Electron's own PID, because the binary is spawned directly. Under `npx` this
  // was npm's, and every statement about the app's shutdown was really about npm.
  evidence.electronPid = child.pid
  process.stdout.write(`        electron pid ${String(child.pid)}\n`)

  let output = ''
  child.stdout.on('data', (d) => (output += d.toString()))
  child.stderr.on('data', (d) => (output += d.toString()))

  const port = await until('a debugging port', () => readPort(output), 60_000)

  try {
    const shellTarget = await until('the shell window', async () => {
      const found = (await targets(port)).find((t) => !t.url.includes('workbench.html'))
      return found ?? false
    })
    const shell = await attach(shellTarget)

    /*
     * Waited for, not assumed — and this was a real false failure, not a
     * precaution.
     *
     * The claim below was computed from two `evaluate`s and its *message* from two
     * more, so on a slow start the assertion read `window.chorus` before the
     * preload had run and the message read it after: a FAIL whose own evidence
     * line said PASS. Since the workbench stage the shell takes longer to come up,
     * which is what turned an unlikely race into a regular one. A gate that can
     * report a passing system as broken is worse than one that is merely slow.
     */
    await until(
      'the shell bridge',
      async () => (await shell.evaluate('typeof window.chorus')) === 'object'
    )

    record(
      'the shell holds ChorusApi and no workbench bridge',
      (await shell.evaluate('typeof window.chorus')) === 'object' &&
        (await shell.evaluate('typeof window.chorusWorkbench')) === 'undefined',
      `window.chorus=${await shell.evaluate('typeof window.chorus')} window.chorusWorkbench=${await shell.evaluate('typeof window.chorusWorkbench')}`
    )

    /*
     * A path is refused by the real IPC, asserted before anything is opened.
     *
     * The unit tests prove this against fakes; this proves it in the app, over
     * the actual channel, from the actual shell — which is the difference between
     * "the schema says so" and "the running boundary does". `ROOT_A` is a real,
     * absolute, canonical directory that main is about to open on a grant, so the
     * only thing separating this call from the one below it is authorisation.
     */
    const forged = await shell.evaluate(
      `window.chorus.openWorkbench({ projectRoot: ${JSON.stringify(ROOT_A)} }).then(() => 'OPENED', e => 'refused: ' + e.message)`
    )
    record(
      'a raw path on workbench:open is refused, however real the directory is',
      typeof forged === 'string' && forged.startsWith('refused:'),
      forged.slice(0, 160)
    )

    const open = async (x) => {
      // The chooser is the mint: nothing here names a directory, and the grant
      // it returns is what the surface is opened with.
      const { chosen } = await shell.evaluate('window.chorus.chooseWorkbenchProject()')
      if (chosen === null) throw new Error('the chooser minted nothing')
      return { grant: chosen.grant, viewId: await redeem(chosen.grant, x) }
    }

    /**
     * Redeems a grant into a placed surface — separately, because the recovery
     * proof redeems the **same grant a second time**.
     *
     * That is main's documented rule rather than a liberty taken here: a grant is
     * not consumed on redemption, because `StrictMode` mounts twice and a probe
     * reopens a pane it closed, and a single-use token would send the person back
     * through a dialog for an authorisation they had already given. What bounds it
     * is the owner's document, not the number of uses.
     */
    const redeem = async (grant, x) => {
      const { viewId } = await shell.evaluate(
        `window.chorus.openWorkbench({ grant: ${JSON.stringify(grant)} })`
      )
      // A real rectangle, because a zero-sized view lays the workbench out at
      // 0×0 and "did not render" would then be a fact about the bounds.
      await shell.evaluate(
        `window.chorus.setWorkbenchBounds({ viewId: ${JSON.stringify(viewId)}, rect: { x: ${x}, y: 40, width: 620, height: 700 } })`
      )
      return viewId
    }

    const openedA = await open(20)
    const openedB = await open(660)
    const viewA = openedA.viewId
    let viewB = openedB.viewId

    const surfaceTargets = await until('two workbench documents', async () => {
      const found = (await targets(port)).filter((t) => t.url.includes('workbench.html'))
      return found.length === 2 ? found : false
    })

    const surfaces = []
    for (const target of surfaceTargets) surfaces.push(await attach(target))

    const states = []
    for (const surface of surfaces) {
      const state = await until(`a rendered workbench in ${surface.url}`, () =>
        surface.evaluate(READY)
      )
      if (state.failed !== undefined) throw new Error(`a surface reported: ${state.failed}`)
      states.push(state)
    }
    record(
      'two surfaces each render a workbench in their own document',
      states.every((s) => s.workbench === true && s.tagged > 0),
      states
        .map((s, i) => `#${i + 1} [data-vscode]=${s.tagged} parts=${s.parts.join(',')}`)
        .join(' | ')
    )

    // The assertion that proves the shell's preload did not follow the view.
    const bridges = []
    for (const surface of surfaces) {
      bridges.push({
        chorus: await surface.evaluate('typeof window.chorus'),
        keys: await surface.evaluate('Object.keys(window.chorusWorkbench ?? {}).sort().join(",")'),
        vscodeWindow: await surface.evaluate('typeof window.vscodeWindow'),
      })
    }
    record(
      'no surface holds ChorusApi, and its bridge is one method',
      bridges.every((b) => b.chorus === 'undefined' && b.keys === 'connection'),
      bridges.map((b) => `chorus=${b.chorus} chorusWorkbench=[${b.keys}]`).join(' | ')
    )
    record(
      'no surface sets window.vscodeWindow (parent-DOM integration is prohibited)',
      bridges.every((b) => b.vscodeWindow === 'undefined'),
      bridges.map((b) => `vscodeWindow=${b.vscodeWindow}`).join(' | ')
    )

    /*
     * Each surface's own descriptor, asked adversarially: both are open, so a
     * lookup keyed on "most recently opened" fails exactly here. The authority
     * comes back too, because the port in it is the thing this gate must never
     * hardcode — it was chosen by the kernel, printed by the server and parsed by
     * main, and it is about to be the subject of a claim.
     */
    const descriptors = []
    for (const surface of surfaces) {
      descriptors.push(
        JSON.parse(
          await surface.evaluate(
            `window.chorusWorkbench.connection().then(c => JSON.stringify({ projectRoot: c.projectRoot, remoteAuthority: c.remoteAuthority }))`
          )
        )
      )
    }
    const roots = descriptors.map((d) => d.projectRoot)
    record(
      'each surface pulls its own project root while the other is open',
      new Set(roots).size === 2 && roots.includes(ROOT_A) && roots.includes(ROOT_B),
      roots.join(' | ')
    )

    const authorities = new Set(descriptors.map((d) => d.remoteAuthority))
    evidence.port = descriptors[0]?.remoteAuthority?.split(':').at(-1) ?? null
    record(
      'both surfaces name one shared server, on a port nothing here chose',
      authorities.size === 1 && /^127\.0\.0\.1:\d+$/.test(descriptors[0]?.remoteAuthority ?? ''),
      [...authorities].join(' | ')
    )

    /*
     * And that port is the one the server itself printed. Read out of the log
     * main keeps of the child's own stdout, so the two halves of the claim come
     * from opposite ends: the workbench says which port it is talking to, and the
     * server says which port it bound.
     */
    const logNow = existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : ''
    evidence.portFromLog =
      /Extension host agent listening on (\d+)/.exec(logNow)?.[1] ??
      /Server bound to \S+?:(\d+)/.exec(logNow)?.[1] ??
      null
    record(
      'the port the surfaces use is the port the server reported binding',
      evidence.portFromLog !== null && evidence.portFromLog === evidence.port,
      `surface=${String(evidence.port)} server=${String(evidence.portFromLog)}`
    )

    /*
     * The server's log holds no token, checked against the real one.
     *
     * The gate can read the token — it is in the descriptor, because the surface
     * needs it — which makes this the only place the redaction can be tested
     * against the actual secret rather than against a pattern. It is never printed
     * from here, in the evidence line or anywhere else: the claim is a boolean.
     */
    const token = await surfaces[0].evaluate(
      'window.chorusWorkbench.connection().then(c => c.connectionToken)'
    )
    record(
      "the server's log does not contain the connection token",
      typeof token === 'string' && token.length > 0 && !logNow.includes(token),
      `log=${logNow.length}B token-present=${typeof token === 'string' ? String(logNow.includes(token)) : 'no token'}`
    )

    const indexOf = (root) => roots.indexOf(root)
    const a = surfaces[indexOf(ROOT_A)]
    /*
     * `let`, because B is closed and reopened below and the second document is a
     * different `WebContents` with a different CDP target. Its id is kept so the
     * recovery proof can assert it really is a *new* document rather than the same
     * one still answering — which is exactly the confusion the vetoed reload
     * produced, where a claim about a reloaded surface passed on a surface that
     * had never reloaded.
     */
    let b = surfaces[indexOf(ROOT_B)]
    const bTargetId = surfaceTargets[indexOf(ROOT_B)].id

    /*
     * ── The files, and the claim the whole REH stage exists for ─────────────
     *
     * The previous slice's explorer was an in-memory provider seeded from the
     * project-root *string*: evidence about isolation between surfaces and about
     * nothing else, since not one byte had been read from disk. Opening a real
     * file by its real path and finding the bytes that are on disk is the claim
     * that slice could not make at all — and taking the same claim in both
     * surfaces, on two different files, is what makes it about two trees rather
     * than one.
     */
    const shownA = await openByPath(a, FIXTURES[ROOT_A], 'surface A')
    record(
      `surface A opened ${FIXTURES[ROOT_A].path} by path and shows the bytes on disk`,
      shownA.failure === undefined && shownA.text.includes(FIXTURES[ROOT_A].marker),
      shownA.failure ?? `tab=${shownA.tab} · ${shownA.text.replace(/\n/g, '⏎').slice(0, 140)}`
    )

    const shownB = await openByPath(b, FIXTURES[ROOT_B], 'surface B')
    record(
      `surface B opened ${FIXTURES[ROOT_B].path} by path, from its own tree`,
      shownB.failure === undefined &&
        shownB.text.includes(FIXTURES[ROOT_B].marker) &&
        !shownB.text.includes(FIXTURES[ROOT_A].marker),
      shownB.failure ?? `tab=${shownB.tab} · ${shownB.text.replace(/\n/g, '⏎').slice(0, 140)}`
    )

    /*
     * §4.1b rule 3 — a buffer does not survive a reload, so the pull has to
     * answer one. Before the crux and on a clean surface, gated on a marker only
     * the old document can still have: `location.reload()` returns before the
     * document goes away, so the first poll would otherwise see the *old* DOM,
     * call it ready, and every measurement after it would describe a document
     * that was still loading.
     */
    /*
     * The epoch, and a probe on the way out — because "it did not reload" is a
     * symptom with three completely different causes and reporting the symptom is
     * what cost this gate two rounds.
     *
     * The listeners go on last, in the bubble phase, so VS Code's own
     * `beforeunload` handlers have already run by the time they see the event.
     * That ordering is the measurement: `defaultPrevented` or a `returnValue`
     * means *something in the workbench vetoed the unload*, which Electron then
     * honours by cancelling the navigation silently — no dialog, no error, and an
     * epoch marker that survives. `pagehide` firing means the document really is
     * going. Neither firing at all means the navigation never got as far as unload,
     * which points at the navigation lock rather than at the lifecycle service.
     */
    await b.evaluate(`(() => {
      window.__gateEpoch = 1
      window.__gateUnload = { beforeunload: 0, vetoed: false, pagehide: 0 }
      window.addEventListener('beforeunload', (event) => {
        window.__gateUnload.beforeunload += 1
        const returned = event.returnValue
        window.__gateUnload.vetoed =
          event.defaultPrevented || (returned !== '' && returned !== undefined && returned !== null)
      })
      window.addEventListener('pagehide', () => { window.__gateUnload.pagehide += 1 })
      return true
    })()`)
    /*
     * `location.reload()`, not `Page.reload`. The debugger's version was observed
     * to do nothing at all here — the epoch marker survived ninety seconds — and
     * the case §4.1b rule 3 is written for is the document reloading itself, so
     * the page's own API is both the working lever and the honest one. Deferred a
     * tick so the evaluate returns before its execution context is torn down.
     */
    await b.evaluate('setTimeout(() => { window.location.reload() }, 0); true')
    const replaced = await until(
      'the reloaded document to replace the old one',
      async () => ((await b.evaluate('window.__gateEpoch')) === undefined ? true : false),
      30_000
    ).catch(() => false)

    /*
     * A classification, not a symptom. Three outcomes, and only one of them is a
     * defect:
     *
     *  - **allowed** — the document was replaced, which is what §4.1b rule 3 is
     *    about and what this claim used to assert.
     *  - **vetoed** — a `beforeunload` handler cancelled it. That is a *protection*
     *    rather than a fault: it is the same mechanism that stops a reload
     *    discarding an unsaved editor, and defeating it to make a gate green would
     *    be removing a safeguard to measure past it.
     *  - **refused** — unload was never reached, so something upstream of the
     *    document stopped the navigation. That one would be ours, and the
     *    navigation lock is the first place to look.
     */
    const unload = replaced
      ? { beforeunload: 0, vetoed: false, pagehide: 0 }
      : JSON.parse(await b.evaluate('JSON.stringify(window.__gateUnload ?? null)'))
    evidence.reload = replaced
      ? 'allowed — the document was replaced'
      : unload === null
        ? 'unknown — the probe did not survive to be read'
        : unload.vetoed
          ? `deliberately vetoed — beforeunload fired ${String(unload.beforeunload)}× and cancelled the unload`
          : unload.beforeunload > 0
            ? `refused after unload began — beforeunload fired ${String(unload.beforeunload)}×, uncancelled, pagehide ${String(unload.pagehide)}×`
            : 'refused before unload — beforeunload never fired, so the navigation was stopped upstream of the document'

    /*
     * Passes on **allowed** and on **vetoed**, fails only on **refused**.
     *
     * That is not a loosened assertion, it is the claim being stated correctly for
     * the first time. What §4.1b rule 3 needs is that a surface which replaces its
     * document is answered again; what it does not need is that every reload must
     * succeed. A workbench that refuses to discard an editor is behaving, and a
     * gate that treated that as a failure would be arguing for the safeguard's
     * removal. A navigation stopped *before* unload is the case that is ours.
     */
    record(
      'a reload is either allowed or deliberately vetoed, never silently refused',
      replaced === true || unload?.vetoed === true,
      evidence.reload
    )

    const before = await b.evaluate(
      `({ tagged: document.querySelectorAll('[data-vscode]').length })`
    )

    // ── The crux ───────────────────────────────────────────────────────────
    const pidsBefore = serverPids(SERVER)
    evidence.serverPids = pidsBefore
    await shell.evaluate(`window.chorus.closeWorkbench({ viewId: ${JSON.stringify(viewA)} })`)

    const gone = await until('surface A to leave the target list', async () => {
      const remaining = (await targets(port)).filter((t) => t.url.includes('workbench.html'))
      return remaining.length === 1 ? remaining : false
    })
    record(
      'destroying a surface actually removes its WebContents',
      gone.length === 1,
      `workbench documents remaining: ${gone.length}`
    )

    /*
     * The server is still there, by PID rather than by inference.
     *
     * §5.4's lease is over open *projects*, and closing one of two must not stop
     * the process — the observable version of "switching project does not kill the
     * build running in the other one". Asked of the kernel, because a workbench
     * that still renders is not evidence that a process still exists.
     */
    const pidsAfter = serverPids(SERVER)
    record(
      'the spawned remote extension host is still alive after one surface closes',
      pidsBefore.length > 0 && pidsBefore.every((pid) => alive(pid)),
      `pids before=[${pidsBefore.join(',')}] still-alive=[${pidsBefore.filter((p) => alive(p)).join(',')}] now-matching=${pidsAfter.length}`
    )

    const after = await b.evaluate(
      `({
        tagged: document.querySelectorAll('[data-vscode]').length,
        workbench: document.querySelector('.monaco-workbench') !== null,
      })`
    )
    /*
     * `>=`, not `===`, and the difference is the claim rather than a loosening.
     *
     * The hazard this step exists for is the library's documented teardown,
     * `document.querySelectorAll('[data-vscode]').forEach(el => el.remove())`,
     * reaching a *sibling* workbench — so what must not happen is the count going
     * **down**. Equality tested something else: that nothing changed at all. It
     * failed on an observed `before=14 after=15`, because a live workbench keeps
     * appending style elements as it draws, and a survivor that is still
     * rendering is the opposite of the failure being looked for.
     */
    record(
      "the survivor's [data-vscode] head elements were not removed with its sibling",
      after.workbench === true && after.tagged >= before.tagged && after.tagged > 0,
      `before=${before.tagged} after=${after.tagged} workbench=${after.workbench}`
    )

    /*
     * And the survivor still holds the same server. The descriptor is main's
     * answer, so this is also the check that closing A did not release the lease
     * out from under B and start a second server on a second port.
     */
    const authorityAfter = await b.evaluate(
      'window.chorusWorkbench.connection().then(c => c.remoteAuthority)'
    )
    record(
      'the surviving surface still names the same discovered port',
      authorityAfter === descriptors[0]?.remoteAuthority,
      `before=${String(descriptors[0]?.remoteAuthority)} after=${String(authorityAfter)}`
    )

    /*
     * ── Still working, not just still drawn ────────────────────────────────
     *
     * Three things in order, and each is weaker on its own: a file it has never
     * read (so the connection is still serving), a keystroke into that buffer (so
     * the editor is still live), and a command (so the workbench's own machinery
     * still runs). Nothing here clicks: quick open leaves focus in the editor, so
     * the keystroke goes where a person's would.
     */
    const editPath = join(ROOT_B, EDIT_TARGET.path)
    const originalBytes = readFileSync(editPath, 'utf8')
    const reopened = await openByPath(b, EDIT_TARGET, 'surface B after the close')
    record(
      `the survivor opens a file it had not read (${EDIT_TARGET.path}) over the same server`,
      reopened.failure === undefined && reopened.text.includes(EDIT_TARGET.marker),
      reopened.failure ?? `tab=${reopened.tab} · ${reopened.text.replace(/\n/g, '⏎').slice(0, 140)}`
    )

    /*
     * ── One keystroke, four claims, and the whole write path rather than a
     *    moment inside it ────────────────────────────────────────────────────
     *
     * This began as one assertion — type, then check the tab is dirty — and it
     * failed for a reason worth keeping: the workbench had already **saved**. VS
     * Code's web build defaults `files.autoSave` to `afterDelay` at 1,000 ms, and
     * Chorus keeps that native behaviour deliberately, so "dirty" is a state that
     * exists for about a second and then correctly stops existing. An assertion
     * that only ever looked for it was asking the system to be mid-flight when it
     * was measured.
     *
     * Asking instead for the *end* of the flight is strictly stronger. Dirty is an
     * intermediate state; **bytes on disk are the outcome**, and they are the thing
     * a person actually cares about. So: the editor took it, the file changed, the
     * editor went clean, and what landed is what was typed. Together those exercise
     * the editor, the working-copy service, the save, and the round trip out
     * through the remote extension host to a real filesystem — none of which the
     * dirty check touched.
     */
    await b.send('Input.insertText', { text: TYPED })
    const typed = await until(
      'the typed text to appear in the surviving editor',
      async () => {
        const state = await editorState(b)
        return state.text.includes(TYPED) ? state : false
      },
      20_000
    ).catch((error) => ({ failure: error.message }))
    record(
      'the surviving editor still accepts a keystroke after its sibling is destroyed',
      typed.failure === undefined,
      typed.failure ?? typed.text.replace(/\n/g, '⏎').slice(0, 120)
    )

    /*
     * The disk, read by this process rather than reported by the workbench.
     *
     * Bounded at 20 s against a 1,000 ms auto-save delay — generous, because what
     * is being timed is the delay plus a write back through the server, and a
     * bound that is tight enough to be interesting is a bound that flakes. A
     * failure here would be the one that matters: an edit that never reaches the
     * filesystem is an edit the person has lost.
     */
    const saved = await until(
      'the fixture file on disk to receive the typed marker',
      () => {
        const now = readFileSync(editPath, 'utf8')
        return now.includes(TYPED) ? now : false
      },
      20_000
    ).catch((error) => ({ failure: error.message }))
    record(
      'the edit reaches the fixture file on disk, through the remote extension host',
      typeof saved === 'string',
      typeof saved === 'string'
        ? `${editPath} changed from ${String(originalBytes.length)}B to ${String(saved.length)}B`
        : String(saved.failure)
    )

    /*
     * Clean *after* the save, which is the assertion the dirty check should always
     * have been. Waited for separately from the disk read, because the working-copy
     * service clearing the marker and the bytes landing are two different events
     * and reading both from one snapshot is what went wrong the first time.
     */
    const clean = await until(
      'the editor to go clean once the change is saved',
      async () => ((await editorState(b)).dirty === false ? true : false),
      20_000
    ).catch((error) => error.message)
    record(
      'the editor reports no unsaved change once auto-save has written it',
      clean === true,
      clean === true ? 'the active tab carries no dirty marker' : String(clean)
    )

    /*
     * And what landed is what was typed — not merely *something*. The marker
     * carries this run's own stamp, so a file left by an earlier run cannot satisfy
     * it, and the original content is asserted to still be there because a save
     * that truncated the file would otherwise read as a pass.
     */
    const bytesMatch =
      typeof saved === 'string' && saved === `${TYPED}${originalBytes}` ? true : false
    record(
      'the saved bytes are exactly the marker followed by the original content',
      bytesMatch,
      bytesMatch
        ? `${String(saved.length)}B = ${String(TYPED.length)}B marker + ${String(originalBytes.length)}B original`
        : `expected ${JSON.stringify(`${TYPED}${originalBytes}`.slice(0, 90))} · got ${JSON.stringify(String(typeof saved === 'string' ? saved : saved.failure).slice(0, 90))}`
    )

    /*
     * One command, run from the palette and judged by what it did.
     *
     * The row is matched before Enter and the *effect* is what is asserted after
     * it, which is the difference between "a widget opened" and "the workbench
     * executed something". A part's width is the cheapest state that only a
     * running command service can change; the title has moved between VS Code
     * versions ("Side Bar" became "Primary Side Bar"), so the row is matched on
     * what it means rather than on a string that drifts.
     */
    const sidebarWidth = async () =>
      b.evaluate(`document.querySelector('.part.sidebar')?.clientWidth ?? 0`)
    const widthBefore = await sidebarWidth()
    let command = null
    try {
      await pickInQuickInput(
        b,
        '>toggle side bar visibility',
        (row) => /toggle (primary )?side ?bar visibility/i.test(row.label),
        'surface B'
      )
      command = await until(
        'the side bar to answer the command',
        async () => ((await sidebarWidth()) === 0 ? true : false),
        20_000
      )
    } catch (error) {
      const seen = await quickInput(b).catch(() => ({ rows: [] }))
      command = `${error.message} · offered: ${seen.rows.map((r) => `${r.label}${r.focused ? '*' : ''}`).join(' / ') || 'nothing'}`
    }
    record(
      'the surviving workbench still runs a command from the palette',
      command === true && widthBefore > 0,
      `sidebar ${widthBefore}px → ${await sidebarWidth()}px${command === true ? '' : ` · ${String(command)}`}`
    )

    /*
     * ── §4.1b rule 3, proved by recovery rather than by defeating a safeguard ──
     *
     * The rule is that a surface which has lost its document is answered again,
     * and the obvious way to reach that state — asking the document to reload
     * itself — is **vetoed by the workbench**, measured above: `beforeunload`
     * fires, cancels, and Electron honours it with no dialog and no error. That is
     * the same machinery that stops a reload throwing away an unsaved editor. It
     * would have been easy to get past (clear the buffer first, or reload through
     * the debugger) and every one of those routes is a way of measuring a system
     * with its safeguard removed.
     *
     * So the surface is **closed and reopened** instead, which reaches the state
     * the rule is about — a new document, on the same project, that must be told
     * what it is — and reaches it the way the product will: a tab closed and
     * reopened. The grant is redeemed a **second time**, which is main's own
     * documented rule (a capability is bounded by its owner's document, not by a
     * use count) and is the thing a reload would otherwise have to re-prove.
     */
    /*
     * **Run here, and the position is the claim's precondition.**
     *
     * Closing a surface runs the document's own unload path, so a close attempted
     * while the buffer was dirty would meet the very veto classified above — and
     * the proof would then be measuring the veto rather than recovery. The edit
     * above is saved and the editor is clean before this line is reached, which is
     * what makes a close here a close rather than a negotiation.
     */
    await shell.evaluate(`window.chorus.closeWorkbench({ viewId: ${JSON.stringify(viewB)} })`)
    /*
     * **Zero**, because A is already gone. This wait carried a `=== 1` from when
     * the recovery proof ran before the crux and closing B still left A behind;
     * moved after it, the same number quietly meant "B is still here" and the step
     * timed out on a surface that had closed immediately. A count is only a claim
     * alongside what else is open.
     */
    await until('surface B to leave the target list', async () => {
      const remaining = (await targets(port)).filter((t) => t.url.includes('workbench.html'))
      return remaining.length === 0 ? true : false
    })
    b.close()

    viewB = await redeem(openedB.grant, 660)
    const reopenedTarget = await until('surface B to come back as a new document', async () => {
      const found = (await targets(port)).filter(
        (t) => t.url.includes('workbench.html') && t.id !== bTargetId
      )
      return found.length === 1 ? found[0] : false
    })
    b = await attach(reopenedTarget)

    const recovered = await until(
      'the reopened surface to say something about itself',
      async () => {
        const state = await b.evaluate(`(async () => {
          const failure = document.querySelector('.workbench-failure')
          const answered = typeof window.chorusWorkbench === 'object'
            ? await Promise.race([
                window.chorusWorkbench.connection().then(c => c.projectRoot, e => 'threw: ' + e.message),
                new Promise(r => setTimeout(() => r(null), 3000)),
              ])
            : 'no bridge'
          return {
            bridge: typeof window.chorusWorkbench,
            answered,
            workbench: document.querySelector('.monaco-workbench') !== null,
            failure: failure === null ? null : failure.textContent.slice(0, 300),
          }
        })()`)
        /*
         * Waits for the **workbench**, not for whichever signal arrives first.
         *
         * This predicate was inherited from the old reload claim, where it read
         * `workbench || failure || answered !== null` — and `answered` is the
         * quickest of the three by a wide margin, because main pushes the
         * descriptor on `did-finish-load` while the workbench's own module graph is
         * still evaluating. So the wait returned on the descriptor and the
         * assertion then read `workbench=false` off a surface that was three
         * seconds from rendering, reporting a recovery that was working as broken.
         * A failure element still short-circuits, since that is a document that
         * will never render.
         */
        return state.workbench === true || state.failure !== null ? state : false
      },
      60_000
    ).catch((error) => ({ answered: null, workbench: false, failure: error.message }))

    record(
      'a closed surface reopens on the same project and is answered again',
      recovered.answered === ROOT_B && recovered.workbench === true,
      `newTarget=${reopenedTarget.id !== bTargetId} bridge=${recovered.bridge ?? '?'} connection()=${String(recovered.answered)} workbench=${String(recovered.workbench)}${recovered.failure === null || recovered.failure === undefined ? '' : ` failure=${recovered.failure.replace(/\n/g, ' ⏎ ')}`}`
    )

    // And it can still read the project through the server — a document that is
    // answered but cannot open a file has recovered its descriptor and nothing else.
    const afterRecovery = await openByPath(b, FIXTURES[ROOT_B], 'surface B after reopening')
    record(
      'the reopened surface reads its project through the same server',
      afterRecovery.failure === undefined && afterRecovery.text.includes(FIXTURES[ROOT_B].marker),
      afterRecovery.failure ??
        `tab=${afterRecovery.tab} · ${afterRecovery.text.replace(/\n/g, '⏎').slice(0, 120)}`
    )

    await shell.evaluate(`window.chorus.closeWorkbench({ viewId: ${JSON.stringify(viewB)} })`)
  } finally {
    /*
     * `SIGTERM` to **Electron**, and then its own `exit` — which is the whole of
     * what the previous version could not do.
     *
     * Signalling `npx` and then asking what happened to the app's children was a
     * question about npm. With the binary spawned directly this handle is the main
     * process: the signal reaches it, `exit` is its exit, and only after that has
     * resolved does "are the server's processes still here?" mean anything at all.
     * Waited for rather than slept through, and the wait's own outcome is recorded
     * — an app that does not exit on `SIGTERM` is itself a finding.
     */
    child.kill('SIGTERM')
    const exited = await until(
      'electron to exit after SIGTERM',
      async () => (child.exitCode !== null || child.signalCode !== null ? true : false),
      20_000
    ).catch(() => false)
    evidence.electronExit =
      exited === true
        ? `code=${String(child.exitCode)} signal=${String(child.signalCode)}`
        : 'did not exit within 20s of SIGTERM — SIGKILLed'
    child.kill('SIGKILL')
    await wait(1_000)

    const log = existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : ''
    evidence.logTail = log.split('\n').filter(Boolean).slice(-25).join('\n        ')
    /*
     * Main's own output, because some of its refusals are deliberately silent
     * everywhere else. `lockDownNavigation` answers a navigation it does not like
     * with a bare `event.preventDefault()` — no log line, no error in the page —
     * so from the renderer a refused navigation and a navigation that never
     * started are the same absence. Anything main *does* say is here.
     */
    evidence.appTail = output.split('\n').filter(Boolean).slice(-20).join('\n        ')

    /*
     * The exit status, asked of the kernel rather than of a log — and now asked
     * of a machine where **Electron itself** has been signalled and has gone.
     *
     * The server is main's child, not this process's, so there is no `exitCode` to
     * read and nothing writes one down; whether the PIDs recorded while the app
     * was running are still there once the app is not is the only honest answer
     * available. `alive` uses signal 0, which asks and sends nothing. The previous
     * version of this measurement was taken after signalling an `npx` wrapper, so
     * it described a shutdown that had never been asked for.
     */
    /*
     * Polled for fifteen seconds rather than sampled once, because a single read
     * a second after the app went cannot tell a **leak** from a **slow shutdown**
     * — and reporting the first as the second is the mistake this whole
     * measurement is being rebuilt to avoid. `stopWorkbenchHost` sends `SIGTERM`;
     * a server that takes a few seconds to close its connections and unlink its
     * socket has not leaked, it has been asked to go and is going.
     */
    const settleStart = Date.now()
    let survivors = evidence.serverPids.filter((pid) => alive(pid))
    while (survivors.length > 0 && Date.now() - settleStart < 15_000) {
      await wait(500)
      survivors = evidence.serverPids.filter((pid) => alive(pid))
    }
    const settleMs = Date.now() - settleStart
    evidence.exit =
      evidence.serverPids.length === 0
        ? 'no server pid was ever recorded'
        : survivors.length === 0
          ? `all ${evidence.serverPids.length} exited within ${String(settleMs)}ms of electron (${evidence.electronExit})`
          : `LEAKED: ${survivors.join(',')} still alive ${String(settleMs)}ms after electron exited (${evidence.electronExit})`

    /*
     * The gate kills what it started, and records what it had to kill.
     *
     * Whether this set is ever non-empty is now a *product* question rather than a
     * harness artefact: with Electron signalled directly, anything still here has
     * outlived a real shutdown. It is swept either way, because a machine that
     * accumulates a 257 MB server per run is not one anybody can go on testing on.
     */
    const orphans = serverPids(RUN).filter((pid) => alive(pid))
    for (const pid of orphans) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone between the listing and the signal */
      }
    }
    evidence.orphansKilled = orphans

    /*
     * The logs, kept before the profile is deleted — otherwise the one artefact
     * that would explain a failure goes with the temporary directory that held it.
     * Written whether or not the run failed, because a passing run is the control
     * a failing one is read against.
     */
    if (TRACE_DIR !== null) {
      try {
        mkdirSync(TRACE_DIR, { recursive: true })
        const chorusLog = join(dataPath, 'logs', 'chorus.log')
        if (existsSync(chorusLog)) {
          writeFileSync(join(TRACE_DIR, 'chorus.log'), readFileSync(chorusLog, 'utf8'))
        }
        if (existsSync(serverLog)) {
          writeFileSync(join(TRACE_DIR, 'workbench-server.log'), readFileSync(serverLog, 'utf8'))
        }
        writeFileSync(join(TRACE_DIR, 'app-output.log'), output)
        writeFileSync(
          join(TRACE_DIR, 'run.json'),
          JSON.stringify(
            {
              ...evidence,
              claims: results.map((r) => ({ ok: r.ok, claim: r.claim, observed: r.observed })),
            },
            null,
            2
          )
        )
      } catch {
        /* the trace is evidence, not the subject; a failure to write it is not a failure */
      }
    }

    rmSync(dataPath, { recursive: true, force: true })
    // The fixture projects go too. They are the gate's own, they live in `tmpdir`
    // and nothing outside this run ever reads them — which is the whole reason the
    // editor is pointed at them rather than at the checkout.
    rmSync(PROJECTS, { recursive: true, force: true })

    /*
     * Printed from the `finally`, so that the run that could not complete is the
     * one that still reports its evidence. A gate that throws is exactly when the
     * PID, the port and the server's own last lines are worth the most, and a
     * print after the `try` would be the print that never happens.
     */
    process.stdout.write(
      `\nevidence\n` +
        `        run: ${String(evidence.run)}\n` +
        `        data dir: ${String(evidence.dataDir)}\n` +
        `        electron pid: ${String(evidence.electronPid)} · exit: ${String(evidence.electronExit)}\n` +
        `        reload: ${String(evidence.reload)}\n` +
        `        REH pids: ${evidence.serverPids.join(',') || 'none found'}\n` +
        `        port (from the surface descriptor): ${String(evidence.port)}\n` +
        `        port (from the server's own log): ${String(evidence.portFromLog)}\n` +
        `        exit: ${evidence.exit ?? 'no exit line — the server outlived the app'}\n` +
        `        orphans killed by the gate: ${evidence.orphansKilled.join(',') || 'none'}\n` +
        `        server log tail:\n        ${evidence.logTail}\n` +
        `        app output tail:\n        ${evidence.appTail}\n`
    )
  }

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
  process.stderr.write(`\nthe gate could not complete: ${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
