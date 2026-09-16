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
  const spare = (): BrowserWindow => new BrowserWindow({ width: 1_000, height: 720 })

  let target = spare()
  let relay = mode === 'source-closes' ? spare() : null

  const liveTarget = (): BrowserWindow => {
    if (target.isDestroyed()) target = spare()
    return target
  }
  const liveRelay = (): BrowserWindow => {
    if (relay === null || relay.isDestroyed()) relay = spare()
    return relay
  }

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

      if (current.isDestroyed()) current = main
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

      const origin = current
      try {
        if (mode === 'both-open') {
          const to = current === main ? liveTarget() : main
          detached = await moveView(current, to, view)
          current = to
        } else if (step === 0) {
          const to = liveRelay()
          detached = await moveView(current, to, view)
          current = to
        } else {
          const held = liveRelay()
          held.contentView.removeChildView(view)
          await pause(SETTLE_MS)
          detached = await evaluate(view, SAMPLE)
          held.close()
          await pause(SETTLE_MS)
          afterClose = await evaluate(view, SAMPLE)
          place(liveTarget(), view)
          current = target
        }
      } catch (error: unknown) {
        report('[reparent-check] move failed, returning the view:', String(error))
        const home = origin.isDestroyed() ? main : origin
        if (!home.isDestroyed() && !view.webContents.isDestroyed()) place(home, view)
        current = home
        return
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

  const guarded = (): Promise<void> =>
    press().catch((error: unknown) => {
      report('[reparent-check] press failed:', String(error))
    })

  const registered = globalShortcut.register(SHORTCUT, () => {
    void guarded()
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
    await guarded()
    await guarded()
  })()
}
