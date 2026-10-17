import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { clearTimeout } from 'node:timers'
import { launch, wait } from './harness.mjs'
import {
  EventStore,
  LOCAL_HOST,
  openSqlite,
  ProjectStore,
} from '../../../packages/event-store/dist/index.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at < 0 ? fallback : args[at + 1]
}

const OUT = option('out', null)
if (OUT === null) throw new Error('--out <directory> is required')
const PROJECTS = Number(option('projects', '3'))
const WEB_TABS = Number(option('webtabs', '3'))
const SAMPLES = Number(option('samples', '30'))
const MODES = option('modes', 'latency').split(',')
const HOLD_MS = Number(option('hold-ms', '600000'))
const IDLE_MS = Number(option('idle-ms', '300000'))
const IDLE_SAMPLES = Number(option('idle-samples', '2'))
const CYCLES = Number(option('cycles', '10'))
const TRACE_SWITCHES = Number(option('trace-switches', '6'))
const RUNTIME_ARCHIVE = 'vscodium-reh-darwin-arm64-1.121.03429.tar.gz'
const CONVERSATIONS = Number(option('conversations', '0'))
const TURNS = Number(option('turns', '200'))
const MESSAGE_CHARS = Number(option('message-chars', '1500'))
const LONG_USER_EVERY = Number(option('long-user-every', '0'))
const TURNS_BY_PROJECT = option('turns-by-project', '')
  .split(',')
  .filter((value) => value !== '')
  .map(Number)
const LAST_REPLY_CHARS = Number(option('last-reply-chars', '0'))
const AB_VARIANTS = JSON.parse(
  option(
    'ab-variants',
    JSON.stringify({
      A: '',
      C: '.score-content .entry { contain: layout style; }',
      V: '.score-content .entry { content-visibility: auto; contain-intrinsic-size: auto 160px; }',
    })
  )
)
const AB_ORDER = option('ab-order', 'A,C,V,V,C,A').split(',')
const AB_SWITCHES = Number(option('ab-switches', '6'))
const AB_SCROLL_STEPS = Number(option('ab-scroll-steps', '0'))

function agentText(turn, chars = MESSAGE_CHARS) {
  const parts = [`## Step ${String(turn)}`, '', 'Here is what changed and why:', '']
  for (let i = 0; i < 4; i++)
    parts.push(
      `- item ${String(i)} touches \`src/module-${String(i)}.ts\` and keeps the **contract** intact`
    )
  parts.push('', '```ts')
  for (let i = 0; i < 12; i++)
    parts.push(
      `export function step${String(turn)}_${String(i)}(value: number): number { return value * ${String(i + 1)} }`
    )
  parts.push('```', '')
  let text = parts.join('\n')
  while (text.length < chars)
    text += `\nFollow-up note ${String(text.length)}: the reduction keeps ordering stable across replays.`
  return text.slice(0, chars)
}

mkdirSync(OUT, { recursive: true })
const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}`
  console.log(text)
  writeFileSync(join(OUT, 'driver.log'), `${text}\n`, { flag: 'a' })
}
const epoch = () => performance.timeOrigin + performance.now()
const save = (name, value) => {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 1)}\n`)
}

function prepareFixture() {
  const fixture = join(OUT, 'fixture')
  const repos = []
  for (let i = 1; i <= PROJECTS; i++) {
    const root = join(fixture, 'repos', `perf-project-${String(i)}`)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'README.md'), `# perf-project-${String(i)}\n`)
    for (let f = 0; f < 40; f++) {
      const body = Array.from(
        { length: 60 },
        (_, line) => `export const value${String(f)}_${String(line)} = ${String(line * i)}\n`
      ).join('')
      writeFileSync(join(root, 'src', `module-${String(f)}.ts`), body)
    }
    if (!existsSync(join(root, '.git'))) {
      spawnSync('git', ['init', '-q'], { cwd: root })
      spawnSync('git', ['add', '.'], { cwd: root })
      spawnSync(
        'git',
        ['-c', 'user.email=perf@local', '-c', 'user.name=perf', 'commit', '-qm', 'fixture'],
        {
          cwd: root,
        }
      )
    }
    repos.push(realpathSync(root))
  }
  return repos
}

function prepareProfile(label, repos) {
  const profile = join(OUT, 'profiles', label)
  mkdirSync(profile, { recursive: true })
  const db = openSqlite({ path: join(profile, 'chorus.v2.db') })
  const { store } = EventStore.open(db, () => join(profile, 'unused-snapshot.db'))
  const projects = new ProjectStore(db)
  const created = repos.map((root, index) =>
    projects.create({
      name: `perf-project-${String(index + 1)}`,
      host: LOCAL_HOST,
      root,
      canonicalRoot: root,
      workspaceFile: null,
      now: Date.now() + index,
    })
  )
  const conversations = []
  for (const project of created) {
    for (let c = 0; c < CONVERSATIONS; c++) {
      const conversationId = randomUUID()
      const title = `${project.name} conversation ${String(c + 1)}`
      const inputs = [
        {
          conversationId,
          actor: 'user',
          payload: { type: 'conversation.created', projectId: project.id, title },
        },
      ]
      const turns = TURNS_BY_PROJECT[created.indexOf(project)] ?? TURNS
      for (let turn = 0; turn < turns; turn++) {
        const turnRef = `turn-${String(turn)}`
        inputs.push({
          conversationId,
          actor: 'user',
          payload: {
            type: 'user.message',
            text:
              LONG_USER_EVERY > 0 && turn % LONG_USER_EVERY === 0
                ? `Long note ${String(turn)}: ${'please keep the existing behaviour for this pasted passage. '.repeat(25)}`
                : `Please do step ${String(turn)} of the plan and explain the result.`,
          },
        })
        inputs.push({ conversationId, actor: 'claude', payload: { type: 'turn.started', turnRef } })
        inputs.push({
          conversationId,
          actor: 'claude',
          payload: {
            type: 'agent.message.completed',
            itemRef: `item-${String(turn)}`,
            text: agentText(
              turn,
              turn === turns - 1 && LAST_REPLY_CHARS > 0 ? LAST_REPLY_CHARS : MESSAGE_CHARS
            ),
          },
        })
        inputs.push({
          conversationId,
          actor: 'claude',
          payload: { type: 'turn.completed', turnRef, status: 'completed' },
        })
      }
      store.appendMany(inputs)
      conversations.push({
        conversationId,
        projectId: project.id,
        title,
        events: inputs.length,
        chars: TURNS * MESSAGE_CHARS,
      })
    }
  }
  const traffic = db
    .prepare(
      'SELECT id, traffic_origin, traffic_port, traffic_access, traffic_env_var FROM projects'
    )
    .all()
  db.close()
  const forwarding = traffic.filter(
    (row) =>
      row.traffic_origin !== null || row.traffic_port !== null || row.traffic_env_var !== null
  )
  if (forwarding.length > 0)
    throw new Error(`fixture has traffic forwarding: ${JSON.stringify(forwarding)}`)
  const cache = join(OUT, 'runtime-cache')
  mkdirSync(cache, { recursive: true })
  if (!existsSync(join(cache, RUNTIME_ARCHIVE))) {
    copyFileSync(
      join(homedir(), 'Library/Application Support/chorus-workbench-runtime', RUNTIME_ARCHIVE),
      join(cache, RUNTIME_ARCHIVE)
    )
  }
  return {
    profile,
    cache,
    projects: created.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    conversations,
    traffic,
  }
}

function startPages() {
  const pages = {
    light: '<p>light page</p>',
    medium: Array.from({ length: 1500 }, (_, i) => `<div class="row">row ${String(i)}</div>`).join(
      ''
    ),
    heavy: Array.from(
      { length: 8000 },
      (_, i) =>
        `<section class="card"><h3>card ${String(i)}</h3><p>${'lorem ipsum '.repeat(6)}</p></section>`
    ).join(''),
  }
  const style =
    '<style>body{font:14px system-ui;margin:0;padding:16px}.card{display:grid;grid-template-columns:1fr 2fr;gap:8px;border:1px solid #ccc;margin:4px;padding:4px;box-shadow:0 1px 3px #0003}.row:nth-child(odd){background:#eef}</style>'
  const server = createServer((request, response) => {
    const name = (request.url ?? '/').replace(/^\//, '').split('?')[0]
    const body = pages[name]
    if (body === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><title>perf-page-${name}</title>${style}<h1>perf-page-${name}</h1>${body}`
    )
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, base: `http://127.0.0.1:${String(port)}`, names: Object.keys(pages) })
    })
  })
}

function cdp(url) {
  const socket = new WebSocket(url)
  let id = 0
  const listeners = new Set()
  socket.addEventListener('message', (message) => {
    const data = JSON.parse(message.data)
    for (const listener of listeners) listener(data)
  })
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      const timer = setTimeout(() => {
        listeners.delete(onReply)
        reject(new Error(`timed out: ${method}`))
      }, 180_000)
      const onReply = (data) => {
        if (data.id !== mine) return
        clearTimeout(timer)
        listeners.delete(onReply)
        if (data.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(data.error)}`))
        else resolve(data.result)
      }
      listeners.add(onReply)
      socket.send(JSON.stringify({ id: mine, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
    }
    return result.result.value
  }
  const on = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return { opened, send, evaluate, on, close: () => socket.close() }
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
  return response.json()
}

const SHELL_PROBE = `(() => {
  if (window.__perf !== undefined) return true
  const perf = { events: [], loaf: [], clicks: [] }
  window.__perf = perf
  const tag = (node) => {
    const el = node && node.closest ? node.closest('[data-workspace-tab],[data-web-tab],[data-rail-project]') : null
    if (el === null) return null
    return el.getAttribute('data-workspace-tab') ?? el.getAttribute('data-web-tab') ?? el.getAttribute('data-rail-project')
  }
  const events = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      perf.events.push({ name: e.name, start: performance.timeOrigin + e.startTime, processingStart: performance.timeOrigin + e.processingStart, processingEnd: performance.timeOrigin + e.processingEnd, duration: e.duration, target: tag(e.target) })
    }
  })
  events.observe({ type: 'event', durationThreshold: 16, buffered: false })
  const frames = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      perf.loaf.push({ start: performance.timeOrigin + e.startTime, duration: e.duration, blocking: e.blockingDuration, renderStart: e.renderStart > 0 ? performance.timeOrigin + e.renderStart : null, styleAndLayoutStart: e.styleAndLayoutStart > 0 ? performance.timeOrigin + e.styleAndLayoutStart : null, scripts: e.scripts.map((s) => ({ invoker: s.invoker, source: s.sourceURL, fn: s.sourceFunctionName, duration: s.duration, forcedStyleAndLayout: s.forcedStyleAndLayoutDuration })) })
    }
  })
  frames.observe({ type: 'long-animation-frame', buffered: false })
  const onClick = (event) => {
    const handler = performance.timeOrigin + performance.now()
    const target = tag(event.target)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      perf.clicks.push({ target, dispatch: performance.timeOrigin + event.timeStamp, handler, painted: performance.timeOrigin + performance.now(), visibility: document.visibilityState })
    }))
  }
  document.addEventListener('click', onClick, true)
  window.__perfDrain = () => {
    perf.events.length = 0
    perf.loaf.length = 0
    perf.clicks.length = 0
    return true
  }
  window.__perfStop = () => {
    events.disconnect()
    frames.disconnect()
    document.removeEventListener('click', onClick, true)
    delete window.__perf
    delete window.__perfDrain
    delete window.__perfStop
    return true
  }
  return true
})()`

const TARGET_PROBE = `(() => {
  if (window.__perfTarget !== undefined) return true
  const probe = { visibility: [], frames: [], armedAt: null }
  window.__perfTarget = probe
  document.addEventListener('visibilitychange', () => {
    probe.visibility.push({ state: document.visibilityState, at: performance.timeOrigin + performance.now() })
  })
  window.__perfArm = (ms) => {
    const frames = []
    probe.frames = frames
    probe.armedAt = performance.timeOrigin + performance.now()
    const end = performance.now() + ms
    const tick = (ts) => {
      frames.push(performance.timeOrigin + ts)
      if (performance.now() < end) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return probe.armedAt
  }
  return true
})()`

async function clockOffset(app) {
  const readings = []
  for (let i = 0; i < 5; i++) {
    const before = epoch()
    const page = await app.evaluate('performance.timeOrigin + performance.now()')
    const after = epoch()
    readings.push({ rtt: after - before, offset: page - (before + after) / 2 })
  }
  readings.sort((a, b) => a.rtt - b.rtt)
  return readings[0]
}

async function center(app, selector) {
  const rect = await app.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })()`)
  return rect
}

async function click(app, selector) {
  const point = await center(app, selector)
  if (point === null) throw new Error(`no element for ${selector}`)
  const sent = epoch()
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  return { sent, acked: epoch(), point }
}

async function workbenchTargets(app) {
  const list = await targets(app.debugPort)
  return list.filter((t) => t.type === 'page' && /workbench/i.test(t.url))
}

async function attachProbe(target) {
  const session = cdp(target.webSocketDebuggerUrl)
  await session.opened
  await session.evaluate(TARGET_PROBE)
  return session
}

async function describeTarget(session) {
  return session.evaluate(
    `({ title: document.title, visibility: document.visibilityState, hasFocus: document.hasFocus(), url: location.href, timeOrigin: performance.timeOrigin, navigation: performance.getEntriesByType('navigation')[0]?.type ?? null, folder: document.querySelector('.explorer-folders-view .monaco-list-row .label-name')?.textContent ?? null })`
  )
}

function summary(values) {
  const sorted = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  if (sorted.length === 0) return { n: 0 }
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length
  const sd = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length)
  return {
    n: sorted.length,
    min: round(sorted[0]),
    median: round(q(0.5)),
    p95: round(q(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(mean),
    sd: round(sd),
  }
}
const round = (v) => Math.round(v * 10) / 10

function processTree(rootPid) {
  const listing = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], {
    encoding: 'utf8',
  })
  const rows = listing
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpuTime: m[4],
      command: m[5],
    }))
  const byParent = new Map()
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const found = []
  const queue = rows.filter((r) => r.pid === rootPid)
  const seen = new Set()
  while (queue.length > 0) {
    const row = queue.shift()
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    found.push(row)
    for (const child of byParent.get(row.pid) ?? []) queue.push(child)
  }
  return found.map((row) => ({ ...row, kind: processKind(row.command) }))
}

function processKind(command) {
  const type = /--type=([a-z-]+)/.exec(command)?.[1]
  const sub = /--utility-sub-type=([\w.]+)/.exec(command)?.[1]
  if (type === 'renderer') return 'renderer'
  if (type === 'gpu-process') return 'gpu'
  if (type === 'utility') return `utility:${sub ?? '?'}`
  if (
    /server-main|out\/server-main|bootstrap-fork|extensionHost|--type=extensionHost/.test(command)
  ) {
    return /extensionHost|bootstrap-fork/.test(command) ? 'reh-child' : 'reh'
  }
  if (/\/node(\s|$)/.test(command) || /node_modules\/\.bin\/|\bnode\b/.test(command.split(' ')[0]))
    return 'node'
  if (/Electron\.app\/Contents\/MacOS\/Electron/.test(command)) return 'main'
  return 'other'
}

function footprintOf(pid) {
  const result = spawnSync('footprint', ['-p', String(pid)], { encoding: 'utf8' })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match =
    /phys_footprint:\s*([\d.]+)\s*([KMG]B)/i.exec(text) ??
    /Footprint:\s*([\d.]+)\s*([KMG]B)/i.exec(text)
  if (match === null) return { mb: null, raw: text.split('\n').slice(0, 6).join(' | ') }
  const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2].toUpperCase()]
  return { mb: Number(match[1]) * scale }
}

function memorySnapshot(rootPid, label) {
  const tree = processTree(rootPid)
  const rows = tree.map((row) => ({ ...row, footprint: footprintOf(row.pid) }))
  const byKind = {}
  for (const row of rows) {
    const entry = (byKind[row.kind] ??= { count: 0, footprintMb: 0, footprintMissing: 0 })
    entry.count += 1
    if (row.footprint.mb === null) entry.footprintMissing += 1
    else entry.footprintMb = round(entry.footprintMb + row.footprint.mb)
  }
  return { label, at: new Date().toISOString(), processes: rows, byKind }
}

function vmStat() {
  return execFileSync('vm_stat', { encoding: 'utf8' })
}

function electronPid(rootPid) {
  return (
    processTree(rootPid).find((row) =>
      /Electron\.app\/Contents\/MacOS\/Electron(\s|$)/.test(row.command)
    )?.pid ?? null
  )
}

function raiseWindow(rootPid) {
  const pid = electronPid(rootPid)
  if (pid === null) return { raised: false, reason: 'no Electron process under this launch' }
  spawnSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of (first process whose unix id is ${String(pid)}) to true`,
  ])
  const front = spawnSync(
    'osascript',
    [
      '-e',
      'tell application "System Events" to get unix id of (first process whose frontmost is true)',
    ],
    { encoding: 'utf8' }
  )
  const frontPid = Number(String(front.stdout).trim())
  return { raised: frontPid === pid, pid, frontPid }
}

function cpuSeconds(rootPid) {
  const toSeconds = (text) => {
    const parts = text.split(':').map(Number)
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1]
  }
  return Object.fromEntries(
    processTree(rootPid).map((row) => [
      row.pid,
      { kind: row.kind, seconds: toSeconds(row.cpuTime) },
    ])
  )
}

function cpuDelta(before, after, wallSeconds) {
  return Object.entries(after)
    .map(([pid, row]) => ({
      pid: Number(pid),
      kind: row.kind,
      percentOfCore: round(
        ((row.seconds - (before[pid]?.seconds ?? row.seconds)) / wallSeconds) * 100
      ),
    }))
    .sort((a, b) => b.percentOfCore - a.percentOfCore)
}

const rejectedGeometry = (output) =>
  (output.match(/Invalid request on "browser:geometry"/g) ?? []).length

async function readTraceStream(browser, handle, path) {
  const chunks = []
  for (;;) {
    const { data, eof, base64Encoded } = await browser.send('IO.read', {
      handle,
      size: 4 * 1024 * 1024,
    })
    chunks.push(base64Encoded ? Buffer.from(data, 'base64').toString('utf8') : data)
    if (eof) break
  }
  await browser.send('IO.close', { handle })
  writeFileSync(path, chunks.join(''))
}

async function main() {
  const meta = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
    electron: JSON.parse(
      readFileSync(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8')
    ).version,
    rendererEntry:
      /src="\.\/assets\/([^"]+)"/.exec(
        readFileSync(new URL('../out/renderer/index.html', import.meta.url), 'utf8')
      )?.[1] ?? null,
    rendererMode: readFileSync(new URL('../out/.renderer-mode', import.meta.url), 'utf8').trim(),
    argv: process.argv.slice(2),
    options: {
      PROJECTS,
      WEB_TABS,
      SAMPLES,
      MODES,
      IDLE_MS,
      IDLE_SAMPLES,
      CYCLES,
      TRACE_SWITCHES,
      CONVERSATIONS,
      TURNS,
      MESSAGE_CHARS,
      LONG_USER_EVERY,
      TURNS_BY_PROJECT,
      LAST_REPLY_CHARS,
      AB_VARIANTS,
      AB_ORDER,
      AB_SWITCHES,
      AB_SCROLL_STEPS,
      keepBanner: args.includes('--keep-banner'),
      warmup: { projectSwitches: 6, webSwitches: 6, settleMs: 5_000 },
    },
    startedAt: new Date().toISOString(),
  }
  const repos = prepareFixture()
  const fixture = prepareProfile(option('label', 'baseline'), repos)
  meta.fixture = fixture
  const pages = await startPages()
  meta.pages = pages.base
  save('meta.json', meta)
  log(`profile ${fixture.profile}; projects ${fixture.projects.map((p) => p.name).join(', ')}`)

  const app = await launch({
    userData: fixture.profile,
    keepData: true,
    env: { CHORUS_PROFILE_READONLY: '1', CHORUS_WORKBENCH_CACHE: fixture.cache },
  })
  const result = { meta, samples: {}, initial: [], notes: [] }
  const sessions = new Map()
  try {
    await app.until(`document.querySelector('[data-rail-project]') !== null`, { timeout: 120_000 })
    meta.pid = app.pid
    meta.debugPort = app.debugPort
    meta.loadedRenderer = await app.evaluate(
      `[...document.scripts].map((s) => s.src.split('/').pop()).filter(Boolean)`
    )
    meta.window = await app.evaluate(
      `({ inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], dpr: devicePixelRatio, visibility: document.visibilityState, focus: document.hasFocus() })`
    )
    save('meta.json', meta)
    if (!meta.loadedRenderer.includes(meta.rendererEntry)) {
      throw new Error(
        `loaded renderer ${JSON.stringify(meta.loadedRenderer)} is not ${meta.rendererEntry}`
      )
    }
    await wait(1_000)
    meta.banner = await app.evaluate(`(() => {
      const text = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /CHORUS_PROFILE_READONLY/.test(e.textContent ?? ''))?.textContent ?? null
      return { text }
    })()`)
    const dismissBanner = () =>
      app.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Dismiss this message' || x.title === 'Dismiss this message')
        if (b === undefined) return false
        b.click()
        return true
      })()`)
    if (!args.includes('--keep-banner') && meta.banner.text !== null) {
      meta.banner.dismissed = await dismissBanner()
      await wait(500)
    }
    meta.raised = raiseWindow(app.pid)
    await wait(1_000)
    meta.shellAfterRaise = await app.evaluate(
      `({ visibility: document.visibilityState, focus: document.hasFocus() })`
    )
    save('meta.json', meta)
    log(
      `banner ${JSON.stringify(meta.banner)} raised ${JSON.stringify(meta.raised)} shell ${JSON.stringify(meta.shellAfterRaise)}`
    )
    await app.evaluate(SHELL_PROBE)
    result.clock = await clockOffset(app)
    log(`clock offset ${JSON.stringify(result.clock)}`)

    for (const project of fixture.projects) {
      const before = (await workbenchTargets(app)).map((t) => t.id)
      const action = await click(app, `[data-rail-project="${project.id}"]`)
      let target = null
      const deadline = Date.now() + 180_000
      while (target === null && Date.now() < deadline) {
        const now = await workbenchTargets(app)
        target = now.find((t) => !before.includes(t.id)) ?? null
        if (target === null) await wait(100)
      }
      if (target === null) throw new Error(`no workbench target for ${project.name}`)
      const appeared = epoch()
      const session = await attachProbe(target)
      let ready = null
      while (Date.now() < deadline) {
        const state = await session
          .evaluate(
            `document.querySelector('.monaco-workbench') !== null && document.querySelector('.explorer-folders-view .monaco-list-row') !== null`
          )
          .catch(() => false)
        if (state) {
          ready = epoch()
          break
        }
        await wait(100)
      }
      sessions.set(project.id, { session, target })
      const described = await describeTarget(session)
      result.initial.push({
        project: project.name,
        targetId: target.id,
        described,
        sendToTargetMs: round(appeared - action.sent),
        sendToExplorerMs: ready === null ? null : round(ready - action.sent),
      })
      log(`initial ${project.name}: ${JSON.stringify(result.initial.at(-1))}`)
    }

    for (const conversation of fixture.conversations) {
      await app.evaluate(
        `(() => { document.querySelector('[data-rail-history]').click(); return true })()`
      )
      await app.until(
        `document.querySelector('[data-history-conversation="${conversation.conversationId}"]') !== null`,
        { timeout: 60_000 }
      )
      const opened = epoch()
      await app.evaluate(
        `(() => { document.querySelector('[data-history-conversation="${conversation.conversationId}"]').click(); return true })()`
      )
      await app.until(
        `document.querySelector('[data-conversation="${conversation.conversationId}"] .entry') !== null`,
        { timeout: 120_000 }
      )
      conversation.openMs = round(epoch() - opened)
      conversation.entries = await app.evaluate(
        `document.querySelectorAll('[data-conversation="${conversation.conversationId}"] .entry').length`
      )
      log(
        `opened ${conversation.title} in ${String(conversation.openMs)}ms with ${String(conversation.entries)} entries`
      )
      await app.evaluate(
        `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`
      )
      await wait(500)
    }
    meta.layoutAfterConversations = await app.evaluate(
      `[...document.querySelectorAll('[data-conversation]')].map((e) => e.getAttribute('data-conversation'))`
    )
    save('meta.json', meta)
    const addTab = '[aria-label="New web tab"]'
    const webTabIds = () =>
      app.evaluate(
        `[...document.querySelectorAll('[data-web-tab]')].map((e) => e.getAttribute('data-web-tab'))`
      )
    const openWebTab = async (url) => {
      const before = await webTabIds()
      await click(app, addTab)
      let id = null
      for (let tries = 0; tries < 100 && id === null; tries++) {
        id = (await webTabIds()).find((x) => !before.includes(x)) ?? null
        if (id === null) await wait(100)
      }
      if (id === null) throw new Error('no new web tab appeared')
      await wait(1_500)
      await app.evaluate(`(() => {
        const input = document.querySelector('#web-tab-stage .browser-address-input')
        input.focus()
        input.select()
        return true
      })()`)
      await app.send('Input.insertText', { text: url })
      await app.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
        unmodifiedText: '\r',
      })
      await app.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      })
      let page = null
      for (let tries = 0; tries < 150 && page === null; tries++) {
        page =
          (await targets(app.debugPort)).find((t) => t.type === 'page' && t.url === url) ?? null
        if (page === null && tries === 30) {
          await app.evaluate(
            `(document.querySelector('#web-tab-stage form.browser-address')?.requestSubmit(), true)`
          )
        }
        if (page === null) await wait(100)
      }
      if (page === null) throw new Error(`page ${url} never loaded`)
      return { id, page }
    }
    const webTabs = []
    for (let i = 0; i < WEB_TABS; i++) {
      const name = pages.names[i % pages.names.length]
      const url = `${pages.base}/${name}`
      const { id, page } = await openWebTab(url)
      const session = await attachProbe(page)
      const attachedDocument = await describeTarget(session)
      webTabs.push({ id, name, url, target: page, session, attachedDocument })
      log(`web tab ${name} -> ${id}`)
    }
    meta.webTabs = webTabs.map(({ id, name, url, target, attachedDocument }) => ({
      id,
      name,
      url,
      targetId: target.id,
      attachedDocument,
    }))
    save('meta.json', meta)

    const showProjects = async () => {
      const showing = await app.evaluate(`document.querySelector('#web-tab-stage') !== null`)
      if (!showing) return
      const first = fixture.projects[0]
      await click(app, `[data-rail-project="${first.id}"]`)
      await wait(800)
    }

    const sample = async (kind, from, to, selector, probeSession, extra = {}) => {
      let visibility = await app.evaluate('document.visibilityState')
      extra = { ...extra, raisedForSample: visibility !== 'visible' }
      if (visibility !== 'visible') {
        raiseWindow(app.pid)
        await wait(800)
        visibility = await app.evaluate('document.visibilityState')
      }
      if (visibility !== 'visible')
        return { kind, from, to, rejected: 'shell not visible', visibility }
      const before = await describeTarget(probeSession)
      await probeSession.evaluate(TARGET_PROBE)
      await probeSession.evaluate('(window.__perfTarget.visibility.length = 0, true)')
      await probeSession.evaluate('window.__perfArm(1500)')
      await app.evaluate(SHELL_PROBE)
      await app.evaluate('window.__perfDrain()')
      await app.evaluate(`(performance.mark('perf-measured'), true)`)
      const expected =
        /data-rail-project="([^"]+)"/.exec(selector)?.[1] ??
        /#web-tab-(.+)$/.exec(selector)?.[1] ??
        null
      const action = await click(app, selector)
      let clickRecord = null
      for (let tries = 0; tries < 400 && clickRecord === null; tries++) {
        clickRecord = await app.evaluate(`window.__perf.clicks[0] ?? null`)
        if (clickRecord === null) await wait(5)
      }
      await wait(1_600)
      const events = await app.evaluate(`window.__perf.events.slice()`)
      const loaf = await app.evaluate(`window.__perf.loaf.slice()`)
      const clicks = await app.evaluate('window.__perf.clicks.length')
      await app.evaluate('window.__perfDrain()')
      const target = await probeSession.evaluate('window.__perfTarget')
      if (clickRecord === null)
        return { kind, from, to, ...extra, rejected: 'missing click record' }
      if (clickRecord.target !== expected || clicks !== 1)
        return {
          kind,
          from,
          to,
          ...extra,
          rejected: 'wrong click record',
          clickRecord,
          expected,
          clicks,
        }
      const after = await describeTarget(probeSession)
      const offset = result.clock.offset
      const sentPage = action.sent + offset
      const clickEvent = events.find((e) => e.name === 'click') ?? null
      const pointer = events.find((e) => e.name === 'pointerdown' || e.name === 'mousedown') ?? null
      const framesAfter = target.frames.filter((t) => t >= sentPage)
      const gaps = target.frames.slice(1).map((t, i) => t - target.frames[i])
      return {
        kind,
        from,
        to,
        ...extra,
        visibility,
        targetBefore: before,
        targetAfter: after,
        targetVisibilityChanges: target.visibility.filter((v) => v.at >= sentPage - 5),
        sendToDispatchMs: clickRecord === null ? null : round(clickRecord.dispatch - sentPage),
        dispatchToHandlerMs:
          clickRecord === null ? null : round(clickRecord.handler - clickRecord.dispatch),
        handlerToDoubleRafMs:
          clickRecord === null ? null : round(clickRecord.painted - clickRecord.handler),
        sendToDoubleRafMs: clickRecord === null ? null : round(clickRecord.painted - sentPage),
        cdpAckMs: round(action.acked - action.sent),
        eventTiming: { click: clickEvent, pointer },
        loaf: loaf.filter((l) => l.start + l.duration >= sentPage - 5),
        loafSumMs: round(
          loaf
            .filter((l) => l.start + l.duration >= sentPage - 5)
            .reduce((sum, l) => sum + l.duration, 0)
        ),
        targetRafProxy: {
          definition: 'rAF armed in the target before the click; not native presentation',
          armedBeforeSend: target.armedAt !== null && target.armedAt <= sentPage,
          count: target.frames.length,
          firstAfterSendMs: framesAfter.length === 0 ? null : round(framesAfter[0] - sentPage),
          maxGapMs: gaps.length === 0 ? null : round(Math.max(...gaps)),
        },
      }
    }

    const projectSwitches = async (label, count) => {
      await showProjects()
      const list = []
      const ids = fixture.projects.map((p) => p.id)
      for (let i = 0; i < count; i++) {
        const pair = Math.floor(i / 2) % (ids.length - 1)
        const a = ids[0]
        const b = ids[pair + 1]
        const to = i % 2 === 0 ? b : a
        const from = i % 2 === 0 ? a : b
        const current = await app.evaluate(
          `document.querySelector('[data-rail-project][data-placement="active"]')?.getAttribute('data-rail-project') ?? null`
        )
        if (current !== from)
          await click(app, `[data-rail-project="${from}"]`).then(() => wait(1_000))
        const entry = await sample(
          'project',
          from,
          to,
          `[data-rail-project="${to}"]`,
          sessions.get(to).session
        )
        entry.correctTarget =
          entry.targetAfter?.visibility === 'visible' &&
          (await app.evaluate(
            `document.querySelector('[data-rail-project][data-placement="active"]')?.getAttribute('data-rail-project') ?? null`
          )) === to
        list.push(entry)
        if ((i + 1) % 10 === 0) log(`${label} project ${String(i + 1)}/${String(count)}`)
      }
      return list
    }

    const webSwitches = async (label, count) => {
      const list = []
      for (let i = 0; i < count; i++) {
        const pair = Math.floor(i / 2) % (webTabs.length - 1)
        const a = webTabs[0]
        const b = webTabs[pair + 1]
        const to = i % 2 === 0 ? b : a
        const from = i % 2 === 0 ? a : b
        const active = await app.evaluate(
          `document.querySelector('[data-web-tab][data-active="true"]')?.getAttribute('data-web-tab') ?? null`
        )
        const showing = await app.evaluate(`document.querySelector('#web-tab-stage') !== null`)
        if (!showing || active !== from.id)
          await click(app, `#web-tab-${from.id}`).then(() => wait(1_000))
        const entry = await sample('web', from.name, to.name, `#web-tab-${to.id}`, to.session)
        entry.correctTarget =
          entry.targetAfter?.visibility === 'visible' && entry.targetAfter?.url === to.url
        list.push(entry)
        if ((i + 1) % 10 === 0) log(`${label} web ${String(i + 1)}/${String(count)}`)
      }
      return list
    }

    const report = (all) => {
      const entries = all.filter((e) => e.rejected === undefined)
      return {
        sendToDispatch: summary(entries.map((e) => e.sendToDispatchMs)),
        dispatchToHandler: summary(entries.map((e) => e.dispatchToHandlerMs)),
        handlerToDoubleRaf: summary(entries.map((e) => e.handlerToDoubleRafMs)),
        sendToDoubleRaf: summary(entries.map((e) => e.sendToDoubleRafMs)),
        eventTimingClick: summary(entries.map((e) => e.eventTiming.click?.duration)),
        targetRafProxyFirstAfterSend: summary(
          entries.map((e) => e.targetRafProxy.firstAfterSendMs)
        ),
        targetRafProxyMaxGap: summary(entries.map((e) => e.targetRafProxy.maxGapMs)),
        longestLoaf: summary(entries.map((e) => Math.max(0, ...e.loaf.map((l) => l.duration)))),
        loafSum: summary(entries.map((e) => e.loafSumMs)),
        accepted: entries.length,
        correct: entries.filter((e) => e.correctTarget).length,
        rejected: all.length - entries.length,
        rejectedReasons: all.filter((e) => e.rejected !== undefined).map((e) => e.rejected),
      }
    }

    await wait(5_000)
    if (MODES.includes('geometry')) {
      await click(app, `#web-tab-${webTabs[0].id}`)
      await wait(2_000)
      const phase = async (label) => {
        const rect = await app.evaluate(
          `(() => { const r = document.querySelector('#web-tab-stage .web-stage-body')?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null })()`
        )
        const shell = await app.evaluate('document.visibilityState')
        const rejectedBefore = rejectedGeometry(app.output())
        const cpuBefore = cpuSeconds(app.pid)
        const started = Date.now()
        await wait(10_000)
        const seconds = (Date.now() - started) / 1000
        const rejected = rejectedGeometry(app.output()) - rejectedBefore
        const cpu = cpuDelta(cpuBefore, cpuSeconds(app.pid), seconds)
        const page = await describeTarget(webTabs[0].session)
        return {
          label,
          rect,
          shell,
          seconds: round(seconds),
          rejected,
          rejectedPerSecond: round(rejected / seconds),
          page,
          cpuTop: cpu.slice(0, 8),
          cpuTotalPercent: round(cpu.reduce((s, r) => s + r.percentOfCore, 0)),
        }
      }
      const before = await phase(
        meta.banner.dismissed === true ? 'banner-dismissed-at-start' : 'banner-present'
      )
      const dismissed = await dismissBanner()
      await wait(1_500)
      const after = await phase(dismissed ? 'banner-dismissed' : 'no-banner-to-dismiss')
      result.geometry = { before, after }
      save('result.json', result)
      log(
        `geometry ${JSON.stringify({ before: { ...before, cpuTop: before.cpuTop.slice(0, 3) }, after: { ...after, cpuTop: after.cpuTop.slice(0, 3) } })}`
      )
    }
    if (MODES.includes('latency')) {
      await projectSwitches('warmup', 6)
      const first = await projectSwitches('batch1', SAMPLES / 2)
      const second = await projectSwitches('batch2', SAMPLES / 2)
      result.samples.project = [...first, ...second]
      save('result.json', result)
      await webSwitches('warmup', 6)
      const webFirst = await webSwitches('batch1', SAMPLES / 2)
      const webSecond = await webSwitches('batch2', SAMPLES / 2)
      result.samples.web = [...webFirst, ...webSecond]
      result.report = {
        project: report(result.samples.project),
        projectBatches: [report(first), report(second)],
        web: report(result.samples.web),
        webBatches: [report(webFirst), report(webSecond)],
      }
      save('result.json', result)
      log(
        `latency report ${JSON.stringify(result.report.project)} | web ${JSON.stringify(result.report.web)}`
      )
    }

    if (MODES.includes('trace')) {
      const version = await (
        await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/version`)
      ).json()
      const browser = cdp(version.webSocketDebuggerUrl)
      await browser.opened
      const categories = [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'toplevel',
        'blink.user_timing',
        'input',
        'latencyInfo',
        'benchmark',
        'viz',
        'gpu',
        'ipc',
        'mojom',
        'electron',
        'v8.execute',
        'renderer.scheduler',
        'disabled-by-default-v8.cpu_profiler',
        '__metadata',
      ]
      const done = new Promise((resolve) => {
        browser.on((data) => {
          if (data.method === 'Tracing.tracingComplete') resolve(data.params)
        })
      })
      await browser.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        traceConfig: { includedCategories: categories, recordMode: 'recordAsMuchAsPossible' },
      })
      await wait(500)
      const marks = []
      const traced = []
      await showProjects()
      for (const entry of await projectSwitches('trace', TRACE_SWITCHES)) {
        traced.push(entry)
      }
      for (const entry of await webSwitches('trace', TRACE_SWITCHES)) {
        traced.push(entry)
      }
      await wait(500)
      await browser.send('Tracing.end')
      const complete = await done
      await readTraceStream(browser, complete.stream, join(OUT, 'trace.json'))
      browser.close()
      result.trace = { samples: traced, dataLoss: complete.dataLossOccurred, marks }
      save('result.json', result)
      log(`trace written, dataLoss=${String(complete.dataLossOccurred)}`)
    }

    for (const state of MODES.includes('idletrace')
      ? option('idle-states', 'projects').split(',')
      : []) {
      if (state === 'web') await click(app, `#web-tab-${webTabs[0].id}`)
      else await showProjects()
      await wait(3_000)
      const version = await (
        await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/version`)
      ).json()
      const browser = cdp(version.webSocketDebuggerUrl)
      await browser.opened
      const done = new Promise((resolve) => {
        browser.on((data) => {
          if (data.method === 'Tracing.tracingComplete') resolve(data.params)
        })
      })
      const cpuBefore = cpuSeconds(app.pid)
      const started = Date.now()
      await browser.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        traceConfig: {
          includedCategories: [
            'devtools.timeline',
            'disabled-by-default-devtools.timeline.frame',
            'toplevel',
            'viz',
            'gpu',
            'disabled-by-default-v8.cpu_profiler',
            '__metadata',
          ],
          recordMode: 'recordAsMuchAsPossible',
        },
      })
      await wait(5_000)
      await browser.send('Tracing.end')
      const complete = await done
      const cpu = cpuDelta(cpuBefore, cpuSeconds(app.pid), (Date.now() - started) / 1000)
      await readTraceStream(browser, complete.stream, join(OUT, `idle-trace-${state}.json`))
      browser.close()
      result.idleTrace ??= {}
      result.idleTrace[state] = {
        seconds: round((Date.now() - started) / 1000),
        cpu,
        shell: await app.evaluate('document.visibilityState'),
        workbenchVisibility: await Promise.all(
          [...sessions.values()].map(({ session }) => describeTarget(session))
        ),
      }
      save('result.json', result)
      log(`idle trace ${state} written; top cpu ${JSON.stringify(cpu.slice(0, 6))}`)
    }

    if (MODES.includes('idle')) {
      const list = []
      for (let i = 0; i < IDLE_SAMPLES; i++) {
        await showProjects()
        const ids = fixture.projects.map((p) => p.id)
        const to = ids[1 + (i % (ids.length - 1))]
        const from = ids[0]
        await click(app, `[data-rail-project="${from}"]`)
        const vmBefore = vmStat()
        log(`idle ${String(IDLE_MS)}ms before switch ${String(i + 1)}`)
        await wait(IDLE_MS)
        const entry = await sample(
          'project-after-idle',
          from,
          to,
          `[data-rail-project="${to}"]`,
          sessions.get(to).session,
          { idleMs: IDLE_MS }
        )
        entry.vmBefore = vmBefore
        entry.vmAfter = vmStat()
        list.push(entry)
      }
      result.samples.idle = list
      result.report = { ...(result.report ?? {}), idle: report(list) }
      save('result.json', result)
    }

    const applyVariant = (label) =>
      app.evaluate(`(() => {
        let sheet = document.getElementById('perf-ab')
        if (sheet === null) {
          sheet = document.createElement('style')
          sheet.id = 'perf-ab'
          document.head.append(sheet)
        }
        sheet.textContent = ${JSON.stringify(AB_VARIANTS[label] ?? '')}
        const entry = document.querySelector('.score-content .entry')
        const styles = entry === null ? null : getComputedStyle(entry)
        return { label: ${JSON.stringify(label)}, contain: styles?.contain ?? null, contentVisibility: styles?.contentVisibility ?? null }
      })()`)

    const lightTrace = async () => {
      const version = await (
        await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/version`)
      ).json()
      const browser = cdp(version.webSocketDebuggerUrl)
      await browser.opened
      const done = new Promise((resolve) => {
        browser.on((data) => {
          if (data.method === 'Tracing.tracingComplete') resolve(data.params)
        })
      })
      await browser.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        traceConfig: {
          includedCategories: [
            'devtools.timeline',
            'disabled-by-default-devtools.timeline',
            'toplevel',
            'blink.user_timing',
            '__metadata',
          ],
          recordMode: 'recordAsMuchAsPossible',
        },
      })
      return async (file) => {
        await browser.send('Tracing.end')
        const complete = await done
        await readTraceStream(browser, complete.stream, join(OUT, file))
        browser.close()
        return complete.dataLossOccurred
      }
    }

    if (MODES.includes('abcss')) {
      result.ab = { blocks: [] }
      await applyVariant('A')
      await projectSwitches('ab-warmup', 6)
      for (const [index, label] of AB_ORDER.entries()) {
        const applied = await applyVariant(label)
        await wait(1_500)
        const stop = args.includes('--ab-trace') ? await lightTrace() : null
        const samples = await projectSwitches(`ab-${String(index)}-${label}`, AB_SWITCHES)
        const dataLoss = stop === null ? null : await stop(`ab-${String(index)}-${label}.json`)
        result.ab.blocks.push({ index, label, applied, dataLoss, samples, report: report(samples) })
        save('result.json', result)
        log(
          `ab block ${String(index)} ${label} ${JSON.stringify(applied)} loafSum ${JSON.stringify(report(samples).loafSum)}`
        )
      }
      await applyVariant('A')
    }

    if (MODES.includes('abcheck')) {
      const ids = fixture.projects.map((p) => p.id)
      const snapshot = (index) =>
        app.evaluate(`(() => {
          const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
          const pane = panes[${String(index)}]
          if (pane === undefined) return null
          const score = pane.querySelector('.score')
          const top = score.getBoundingClientRect().top
          const rows = [...score.querySelectorAll('.score-content .entry')]
          const first = rows.find((row) => row.getBoundingClientRect().bottom > top + 1) ?? null
          return {
            conversation: pane.getAttribute('data-conversation'),
            scrollTop: Math.round(score.scrollTop),
            scrollHeight: score.scrollHeight,
            gap: Math.round(score.scrollHeight - score.scrollTop - score.clientHeight),
            topEntry: first === null ? null : first.getAttribute('data-event-id'),
            topOffset: first === null ? null : Math.round(top - first.getBoundingClientRect().top),
          }
        })()`)
      const byConversation = (conversation) =>
        app.evaluate(`(() => {
          const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
          return panes.findIndex((pane) => pane.getAttribute('data-conversation') === ${JSON.stringify(conversation)})
        })()`)
      const checks = []
      for (const label of Object.keys(AB_VARIANTS)) {
        const raised = raiseWindow(app.pid)
        await wait(500)
        const shellVisibility = await app.evaluate('document.visibilityState')
        await showProjects()
        await click(app, `[data-rail-project="${ids[0]}"]`)
        await wait(2_000)
        const applied = await applyVariant(label)
        await wait(1_000)
        await app.evaluate(`(() => {
          const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
          const reader = panes[0].querySelector('.score')
          reader.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
          reader.scrollTop = Math.round((reader.scrollHeight - reader.clientHeight) * 0.45)
          const pinned = panes[1]?.querySelector('.score')
          if (pinned) {
            pinned.scrollTop = pinned.scrollHeight
            pinned.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
          }
          return true
        })()`)
        if (AB_SCROLL_STEPS > 0) {
          const target = await app.evaluate(`(() => {
            const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
            const reader = panes[0].querySelector('.score')
            const goal = reader.scrollTop
            reader.scrollTop = reader.scrollHeight
            return goal
          })()`)
          for (let step = AB_SCROLL_STEPS; step >= 0; step--) {
            await app.evaluate(`(() => {
              const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
              const reader = panes[0].querySelector('.score')
              const end = reader.scrollHeight - reader.clientHeight
              reader.scrollTop = ${String(target)} + (end - ${String(target)}) * ${String(step)} / ${String(AB_SCROLL_STEPS)}
              return true
            })()`)
            await wait(120)
          }
          await app.evaluate(`(() => {
            const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
            panes[0].querySelector('.score').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
            return true
          })()`)
        }
        await wait(1_200)
        const reader = await snapshot(0)
        const pinned = await snapshot(1)
        await click(app, `[data-rail-project="${ids[1]}"]`)
        await wait(2_000)
        const raisedForReturn = raiseWindow(app.pid)
        await wait(500)
        await click(app, `[data-rail-project="${ids[0]}"]`)
        const restoreVisibility = []
        for (let tick = 0; tick < 14; tick++) {
          restoreVisibility.push(await app.evaluate('document.visibilityState'))
          await wait(250)
        }
        const readerAfter = await snapshot(await byConversation(reader.conversation))
        const pinnedAfter = await snapshot(await byConversation(pinned.conversation))
        const viewport = await app.evaluate('({ width: innerWidth, height: innerHeight })')
        await app.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height - 140,
          deviceScaleFactor: 0,
          mobile: false,
        })
        await wait(1_500)
        const pinnedResized = await snapshot(await byConversation(pinned.conversation))
        const readerResized = await snapshot(await byConversation(reader.conversation))
        await app.send('Emulation.clearDeviceMetricsOverride')
        await wait(1_000)
        const findCopy = await app.evaluate(`(() => {
          const panes = [...document.querySelectorAll('[data-conversation]')].filter((pane) => pane.querySelector('.score') !== null)
          const pane = panes[2] ?? panes[0]
          const score = pane.querySelector('.score')
          score.scrollTop = score.scrollHeight
          const firstRow = score.querySelector('.score-content .entry')
          const paragraph = [...(firstRow?.querySelectorAll('p') ?? [])].find((p) => p.textContent.trim().length > 30)
          const needle = (paragraph?.textContent ?? '').trim().slice(0, 40)
          window.getSelection().removeAllRanges()
          const found = needle.length > 0 && window.find(needle, false, false, true)
          const selection = window.getSelection()
          const inFirstRow = selection.rangeCount > 0 && firstRow.contains(selection.anchorNode)
          const content = score.querySelector('.score-content')
          const range = document.createRange()
          range.selectNodeContents(content)
          selection.removeAllRanges()
          selection.addRange(range)
          const copied = selection.toString().length
          selection.removeAllRanges()
          return { needle, found, inFirstRow, copied, textContent: content.textContent.length }
        })()`)
        const longText = await app.evaluate(`(() => {
          const clamps = [...document.querySelectorAll('.clamp[role="button"]')]
          const target = clamps[0]
          if (target === undefined) return { clampable: 0 }
          const before = target.getAttribute('data-open')
          target.click()
          return new Promise((resolve) => setTimeout(() => {
            const body = target.querySelector('.clamp-body')
            resolve({ clampable: clamps.length, before, after: target.getAttribute('data-open'), expanded: target.getAttribute('aria-expanded'), bodyHeight: Math.round(body.getBoundingClientRect().height), scrollHeight: body.scrollHeight })
          }, 300))
        })()`)
        checks.push({
          label,
          raised,
          shellVisibility,
          raisedForReturn,
          restoreVisibility,
          finalVisibility: await app.evaluate('document.visibilityState'),
          applied,
          reader,
          readerAfter,
          pinned,
          pinnedAfter,
          pinnedResized,
          readerResized,
          findCopy,
          longText,
        })
        result.abChecks = checks
        log(`ab check ${label} ${JSON.stringify(checks.at(-1))}`)
        save('result.json', { ...result, abChecks: checks })
      }
      result.abChecks = checks
      await applyVariant('A')
      save('result.json', result)
    }

    if (MODES.includes('memoryswitch')) {
      await showProjects()
      await app.evaluate('window.__perfStop?.() ?? true')
      const ids = fixture.projects.map((p) => p.id)
      const live = async (name) => {
        const proto = await app.send('Runtime.evaluate', {
          expression: `${name}.prototype`,
          returnByValue: false,
        })
        const found = await app.send('Runtime.queryObjects', {
          prototypeObjectId: proto.result.objectId,
        })
        const length = await app.send('Runtime.callFunctionOn', {
          objectId: found.objects.objectId,
          functionDeclaration: 'function () { return this.length }',
          returnByValue: true,
        })
        await app.send('Runtime.releaseObject', { objectId: found.objects.objectId })
        await app.send('Runtime.releaseObject', { objectId: proto.result.objectId })
        return length.result.value
      }
      const settle = async (label) => {
        await click(app, `[data-rail-project="${ids[0]}"]`)
        await wait(2_000)
        await app.send('HeapProfiler.collectGarbage')
        await wait(500)
        await app.send('HeapProfiler.collectGarbage')
        const heap = await app.send('Runtime.getHeapUsage')
        return {
          label,
          resizeObservers: await live('ResizeObserver'),
          mutationObservers: await live('MutationObserver'),
          clampNodes: await app.evaluate(`document.querySelectorAll('.clamp').length`),
          entries: await app.evaluate(`document.querySelectorAll('.entry').length`),
          heapUsedMiB: round(heap.usedSize / 1048576),
          targets: (await targets(app.debugPort)).length,
          processes: processTree(app.pid).length,
        }
      }
      const rows = [await settle('warm')]
      for (let cycle = 1; cycle <= CYCLES; cycle++) {
        for (const id of [...ids.slice(1), ids[0]]) {
          await click(app, `[data-rail-project="${id}"]`)
          await wait(700)
        }
        if (cycle % 2 === 0) rows.push(await settle(`cycle-${String(cycle)}`))
      }
      result.memorySwitch = rows
      save('result.json', result)
      log(`memory switch ${JSON.stringify(rows)}`)
    }

    if (MODES.includes('memory')) {
      await app.evaluate('window.__perfStop?.() ?? true')
      const snapshots = []
      const counts = async (label) => {
        const list = await targets(app.debugPort)
        const heap = await app.send('Runtime.getHeapUsage').catch(() => null)
        return {
          label,
          targets: list.map((t) => ({
            type: t.type,
            url: t.url.slice(0, 120),
            title: t.title.slice(0, 80),
          })),
          targetCount: list.length,
          shellHeap: heap,
        }
      }
      await showProjects()
      await app.send('HeapProfiler.collectGarbage')
      await wait(3_000)
      snapshots.push({ ...memorySnapshot(app.pid, 'warm'), ...(await counts('warm')) })
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const ids = fixture.projects.map((p) => p.id)
        for (let i = 0; i < 6; i++) {
          await click(app, `[data-rail-project="${ids[i % ids.length]}"]`)
          await wait(400)
        }
        const before = (await targets(app.debugPort)).map((t) => t.id)
        const { id } = await openWebTab(`${pages.base}/medium?cycle=${String(cycle)}`)
        await wait(1_000)
        await click(app, `#web-tab-${webTabs[0].id}`)
        await wait(400)
        await click(app, `#web-tab-${id}`)
        await wait(400)
        await app.evaluate(
          `document.querySelector('[data-web-tab="${id}"] [aria-label^="Close "]')?.click() ?? null`
        )
        await wait(3_000)
        const after = (await targets(app.debugPort)).map((t) => t.id)
        if ((cycle + 1) % 2 === 0 || cycle === CYCLES - 1) {
          await app.send('HeapProfiler.collectGarbage')
          await wait(2_000)
          snapshots.push({
            ...memorySnapshot(app.pid, `cycle-${String(cycle + 1)}`),
            ...(await counts(`cycle-${String(cycle + 1)}`)),
            newTargetsThisCycle: after.filter((x) => !before.includes(x)).length,
          })
          log(`memory cycle ${String(cycle + 1)} targets ${String(after.length)}`)
        }
      }
      result.memory = snapshots
      save('result.json', result)
    }

    if (MODES.includes('hold')) {
      writeFileSync(
        join(OUT, 'holding.json'),
        JSON.stringify({
          pid: app.pid,
          debugPort: app.debugPort,
          projects: fixture.projects,
          webTabs: meta.webTabs ?? [],
        })
      )
      log(`holding for ${String(HOLD_MS)}ms; touch ${join(OUT, 'release')} to finish`)
      const end = Date.now() + HOLD_MS
      while (Date.now() < end && !existsSync(join(OUT, 'release'))) await wait(500)
    }
  } catch (error) {
    result.error = String(error?.stack ?? error)
    log(`error ${result.error}`)
    writeFileSync(join(OUT, 'app-output.log'), app.output())
    throw error
  } finally {
    save('result.json', result)
    writeFileSync(join(OUT, 'app-output.log'), app.output())
    for (const { session } of sessions.values()) session.close()
    await app.stop()
    pages.server.close()
    log('stopped')
  }
}

await main()
