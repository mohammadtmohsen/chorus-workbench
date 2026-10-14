import {
  ipcMain,
  screen,
  type BrowserWindow,
  type WebContents,
  type WindowOpenHandlerResponse,
} from 'electron'
import {
  TOAST_WINDOW_BOUNDS_CHANNEL,
  TOAST_WINDOW_INTERACTION_CHANNEL,
  TOAST_WINDOW_NAME,
  ToastWindowBoundsRequest,
  ToastWindowInteractionRequest,
} from '../shared/toast-window-ipc.js'
import type { WorkbenchRect } from '../shared/workbench-ipc.js'
import { currentScale, onScaleChange } from './scale.js'
import { isShellSender, registerShellChildWindow } from './shell-windows.js'

type ToastWindow = {
  readonly parent: BrowserWindow
  child: BrowserWindow | null
  rect: WorkbenchRect | null
  regions: readonly WorkbenchRect[]
  shape: string | null
  interactive: boolean | null
  dragging: boolean
}

const windows = new Map<WebContents, ToastWindow>()
let pointerTimer: ReturnType<typeof setInterval> | null = null

function interact(record: ToastWindow, interactive: boolean): void {
  const child = record.child
  if (child === null || child.isDestroyed() || process.platform !== 'darwin') return
  if (record.interactive === interactive) return
  record.interactive = interactive
  child.setIgnoreMouseEvents(!interactive)
}

function updateInteraction(record: ToastWindow): void {
  const child = record.child
  if (
    process.platform !== 'darwin' ||
    child === null ||
    child.isDestroyed() ||
    !child.isVisible() ||
    record.rect === null
  ) {
    return
  }
  const bounds = child.getBounds()
  const cursor = screen.getCursorScreenPoint()
  const scale = currentScale()
  const x = (cursor.x - bounds.x) / scale
  const y = (cursor.y - bounds.y) / scale
  interact(
    record,
    record.dragging ||
      (cursor.x >= bounds.x &&
        cursor.x < bounds.x + bounds.width &&
        cursor.y >= bounds.y &&
        cursor.y < bounds.y + bounds.height &&
        record.regions.some(
          (region) =>
            x >= region.x &&
            x < region.x + region.width &&
            y >= region.y &&
            y < region.y + region.height
        ))
  )
}

function trackPointer(): void {
  const visible =
    process.platform === 'darwin' &&
    [...windows.values()].some(
      ({ child, rect }) =>
        rect !== null && child !== null && !child.isDestroyed() && child.isVisible()
    )
  if (!visible) {
    if (pointerTimer !== null) clearInterval(pointerTimer)
    pointerTimer = null
    return
  }
  if (pointerTimer !== null) return
  pointerTimer = setInterval(() => {
    for (const record of windows.values()) updateInteraction(record)
  }, 16)
  pointerTimer.unref()
}

function place(record: ToastWindow): void {
  const { parent, child, rect } = record
  if (child === null || child.isDestroyed()) return
  if (parent.isDestroyed() || !parent.isVisible() || parent.isMinimized() || rect === null) {
    child.hide()
    record.dragging = false
    trackPointer()
    return
  }
  const content = parent.getContentBounds()
  const scale = currentScale()
  const x = Math.min(Math.max(0, Math.round(rect.x * scale)), content.width)
  const y = Math.min(Math.max(0, Math.round(rect.y * scale)), content.height)
  const width = Math.min(Math.ceil(rect.width * scale), content.width - x)
  const height = Math.min(Math.ceil(rect.height * scale), content.height - y)
  if (width <= 0 || height <= 0) {
    child.hide()
    record.dragging = false
    trackPointer()
    return
  }
  const bounds = { x: content.x + x, y: content.y + y, width, height }
  const previous = child.getBounds()
  if (
    previous.x !== bounds.x ||
    previous.y !== bounds.y ||
    previous.width !== width ||
    previous.height !== height
  ) {
    child.setBounds(bounds)
  }
  const regions = record.regions
    .map((region) => {
      const left = Math.max(0, Math.floor(region.x * scale))
      const top = Math.max(0, Math.floor(region.y * scale))
      return {
        x: left,
        y: top,
        width: Math.max(0, Math.min(width, Math.ceil((region.x + region.width) * scale)) - left),
        height: Math.max(0, Math.min(height, Math.ceil((region.y + region.height) * scale)) - top),
      }
    })
    .filter((region) => region.width > 0 && region.height > 0)
  if (regions.length === 0) {
    child.hide()
    record.dragging = false
    trackPointer()
    return
  }
  if (process.platform !== 'darwin') {
    const shape = JSON.stringify(regions)
    if (shape !== record.shape) {
      child.setShape(regions)
      record.shape = shape
    }
  }
  if (!child.isVisible()) child.showInactive()
  updateInteraction(record)
  trackPointer()
}

onScaleChange((scale) => {
  for (const record of windows.values()) {
    const child = record.child
    if (child !== null && !child.isDestroyed()) child.webContents.setZoomFactor(scale)
    place(record)
  }
})

export function registerToastWindow(parent: BrowserWindow): () => WindowOpenHandlerResponse {
  const contents = parent.webContents
  const record: ToastWindow = {
    parent,
    child: null,
    rect: null,
    regions: [],
    shape: null,
    interactive: null,
    dragging: false,
  }
  windows.set(contents, record)
  const update = (): void => {
    place(record)
  }
  const release = (): void => {
    if (windows.get(contents) !== record) return
    windows.delete(contents)
    const child = record.child
    record.child = null
    trackPointer()
    if (child !== null && !child.isDestroyed()) child.close()
  }
  parent.on('move', update)
  parent.on('resize', update)
  parent.on('show', update)
  parent.on('hide', update)
  parent.on('minimize', update)
  parent.on('restore', update)
  parent.once('closed', release)
  contents.once('destroyed', release)
  contents.on('did-create-window', (child, details) => {
    if (details.url !== 'about:blank' || details.frameName !== TOAST_WINDOW_NAME) return
    const previous = record.child
    record.child = child
    record.shape = null
    record.interactive = null
    record.dragging = false
    if (previous !== null && !previous.isDestroyed()) previous.close()
    registerShellChildWindow(child, parent)
    child.setMenu(null)
    child.webContents.setZoomFactor(currentScale())
    interact(record, false)
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    child.webContents.on('will-frame-navigate', (event) => {
      event.preventDefault()
    })
    child.webContents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    child.webContents.on('content-bounds-updated', (event) => {
      event.preventDefault()
    })
    child.webContents.on('did-finish-load', () => {
      if (child.isDestroyed()) return
      child.webContents.setZoomFactor(currentScale())
      place(record)
    })
    child.once('closed', () => {
      if (record.child !== child) return
      record.child = null
      record.rect = null
      record.dragging = false
      trackPointer()
    })
  })
  return () => {
    record.rect = null
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        parent,
        modal: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        show: false,
        width: 400,
        height: 1,
        hasShadow: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        acceptFirstMouse: true,
      },
    }
  }
}

export function registerToastWindowHandlers(): void {
  ipcMain.handle(TOAST_WINDOW_BOUNDS_CHANNEL, (event, raw: unknown) => {
    if (!isShellSender(event)) throw new Error('Toast bounds require a Chorus window')
    const record = windows.get(event.sender)
    if (record === undefined) throw new Error('Unknown notification owner')
    const request = ToastWindowBoundsRequest.parse(raw)
    record.rect = request.rect
    record.regions = request.regions
    place(record)
    const child = record.child
    const focused =
      request.restoreFocus &&
      child !== null &&
      !child.isDestroyed() &&
      child.isVisible() &&
      record.parent.isFocused() &&
      record.parent.webContents.isFocused()
    if (focused) child.focus()
    return { ok: true, focused } as const
  })
  ipcMain.handle(TOAST_WINDOW_INTERACTION_CHANNEL, (event, raw: unknown) => {
    if (!isShellSender(event)) throw new Error('Toast interaction requires a Chorus window')
    const record = windows.get(event.sender)
    if (record === undefined) throw new Error('Unknown notification owner')
    const request = ToastWindowInteractionRequest.parse(raw)
    record.dragging = request.interactive
    updateInteraction(record)
    return { ok: true } as const
  })
}
