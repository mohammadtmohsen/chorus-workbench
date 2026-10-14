import { BrowserWindow, type WebContents, type WebFrameMain } from 'electron'

const shells = new Map<WebContents, BrowserWindow>()
const children = new Map<BrowserWindow, BrowserWindow>()

export function registerShellChildWindow(child: BrowserWindow, parent: BrowserWindow): void {
  if (shells.get(parent.webContents) !== parent) throw new Error('Unknown child window owner')
  children.set(child, parent)
  child.once('closed', () => {
    children.delete(child)
  })
}

export function registerShellWindow(window: BrowserWindow): void {
  const contents = window.webContents
  shells.set(contents, window)
  const forget = (): void => {
    if (shells.get(contents) === window) shells.delete(contents)
  }
  contents.once('destroyed', forget)
  window.once('closed', forget)
}

export function shellWindows(): BrowserWindow[] {
  const live: BrowserWindow[] = []
  for (const [contents, window] of shells) {
    if (!window.isDestroyed() && !contents.isDestroyed()) live.push(window)
  }
  return live
}

export function focusedShellWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused === null || focused.isDestroyed()) return null
  const owner = children.get(focused) ?? focused
  if (owner.isDestroyed()) return null
  return shells.get(owner.webContents) === owner ? owner : null
}

export function isShellSender(event: {
  readonly sender: WebContents
  readonly senderFrame: WebFrameMain | null
}): boolean {
  const window = shells.get(event.sender)
  if (window === undefined || window.isDestroyed() || event.sender.isDestroyed()) return false
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame
}
