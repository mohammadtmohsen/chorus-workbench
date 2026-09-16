import { app, BrowserWindow, globalShortcut, WebContentsView } from 'electron'

export type ReparentMode = 'both-open' | 'source-closes'

export function isReparentMode(value: string | undefined): value is ReparentMode {
  return value === 'both-open' || value === 'source-closes'
}

const SHORTCUT = 'CommandOrControl+Alt+Shift+M'
const READ_TIMEOUT_MS = 2_000
const SETTLE_MS = 500
const SURFACE_POLL_MS = 1_000
const SURFACE_WAIT_MS = 90_000
const WORKBENCH_WARMUP_MS = 5_000

const ARM = `(() => {
  if (globalThis.__reparentProbe === undefined) {
    const probe = { events: [], frames: 0 }
    globalThis.__reparentProbe = probe
    document.addEventListener('visibilitychange', () => {
      probe.events.push(document.visibilityState)
    })
    const tick = () => {
      probe.frames += 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  return 'armed'
})()`

const SAMPLE = `(() => {
  const probe = globalThis.__reparentProbe
  if (probe === undefined) return document.visibilityState + ' unarmed'
  return document.visibilityState + ' frames=' + probe.frames + ' events=[' + probe.events.join(',') + ']'
})()`

function report(...parts: readonly (string | number | boolean)[]): void {
  process.stdout.write(`${parts.join(' ')}\n`)
}

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function read(view: WebContentsView, code: string): Promise<string> {
  try {
    const value: unknown = await view.webContents.executeJavaScript(code)
    return typeof value === 'string' ? value : 'unreadable'
  } catch (error: unknown) {
    return `error:${String(error)}`
  }
}

function evaluate(view: WebContentsView, code: string): Promise<string> {
  if (view.webContents.isDestroyed()) return Promise.resolve('destroyed')
  return Promise.race([read(view, code), pause(READ_TIMEOUT_MS).then(() => 'timeout')])
}

function place(to: BrowserWindow, view: WebContentsView): void {
  const { width, height } = to.getContentBounds()
  view.setBounds({ x: 0, y: 0, width, height })
  to.contentView.addChildView(view)
}

async function moveView(
  from: BrowserWindow,
  to: BrowserWindow,
  view: WebContentsView
): Promise<string> {
  from.contentView.removeChildView(view)
  await pause(SETTLE_MS)
  const detached = await evaluate(view, SAMPLE)
  place(to, view)
  return detached
}

function surfaceViews(window: BrowserWindow): WebContentsView[] {
  return window.contentView.children.filter(
    (child): child is WebContentsView => child instanceof WebContentsView
  )
}

export function runReparentCheck(main: BrowserWindow, mode: ReparentMode): void {
  const target = new BrowserWindow({ width: 1_000, height: 720 })
  const relay = mode === 'source-closes' ? new BrowserWindow({ width: 1_000, height: 720 }) : null

  let current = main
  let step = 0
  let chosen: WebContentsView | null = null
  let running = false

  app.on('will-quit', () => {
    globalShortcut.unregister(SHORTCUT)
  })

  async function press(): Promise<void> {
    if (running) {
      report('[reparent-check] busy, press ignored')
      return
    }
    running = true
    try {
      if (step === 2) {
        report('[reparent-check] done')
        return
      }

      const candidates = surfaceViews(current)
      const view = chosen ?? candidates[0]
      if (view === undefined) {
        report('[reparent-check] no workbench view')
        return
      }
      if (chosen === null) {
        report(
          '[reparent-check] candidates',
          candidates.length,
          'chose webContents',
          view.webContents.id
        )
        chosen = view
      }

      await evaluate(view, ARM)
      const before = await evaluate(view, SAMPLE)
      let detached: string
      let afterClose = 'n/a'

      if (mode === 'both-open') {
        const to = current === main ? target : main
        detached = await moveView(current, to, view)
        current = to
      } else if (step === 0) {
        const spare = relay
        if (spare === null) return
        detached = await moveView(current, spare, view)
        current = spare
      } else {
        const spare = relay
        if (spare === null) return
        spare.contentView.removeChildView(view)
        await pause(SETTLE_MS)
        detached = await evaluate(view, SAMPLE)
        spare.close()
        await pause(SETTLE_MS)
        afterClose = await evaluate(view, SAMPLE)
        place(target, view)
        current = target
      }

      await pause(SETTLE_MS)
      const after = await evaluate(view, SAMPLE)

      step += 1
      report(
        '[reparent-check]',
        mode,
        step,
        `destroyed=${String(view.webContents.isDestroyed())}`,
        `before=${before}`,
        `detached=${detached}`,
        `afterClose=${afterClose}`,
        `after=${after}`
      )
    } finally {
      running = false
    }
  }

  const registered = globalShortcut.register(SHORTCUT, () => {
    void press()
  })
  report('[reparent-check]', registered ? 'armed' : 'shortcut unavailable', mode, SHORTCUT)

  void (async () => {
    const deadline = Date.now() + SURFACE_WAIT_MS
    while (surfaceViews(main).length === 0 && Date.now() < deadline) await pause(SURFACE_POLL_MS)
    if (surfaceViews(main).length === 0) {
      report('[reparent-check] no workbench view appeared within', SURFACE_WAIT_MS, 'ms')
      return
    }
    await pause(WORKBENCH_WARMUP_MS)
    report('[reparent-check] auto run starting')
    await press()
    await press()
  })()
}
