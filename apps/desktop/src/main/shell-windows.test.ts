import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  focusedShellWindow,
  isShellSender,
  registerShellWindow,
  shellWindows,
} from './shell-windows.js'

const focus = vi.hoisted<{ current: unknown }>(() => ({ current: null }))

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => focus.current },
}))

interface FakeWindow {
  readonly window: BrowserWindow
  readonly contents: WebContents
  readonly mainFrame: WebFrameMain
  readonly destroy: () => void
}

function fakeWindow(): FakeWindow {
  const listeners = new Map<string, () => void>()
  let destroyed = false
  const mainFrame = {}
  const contents = {
    mainFrame,
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      listeners.set(`contents:${event}`, listener)
    },
  }
  const window = {
    webContents: contents,
    isDestroyed: () => destroyed,
    once: (event: string, listener: () => void) => {
      listeners.set(`window:${event}`, listener)
    },
  }
  return {
    window: window as unknown as BrowserWindow,
    contents: contents as unknown as WebContents,
    mainFrame: mainFrame as unknown as WebFrameMain,
    destroy: () => {
      destroyed = true
      listeners.get('contents:destroyed')?.()
      listeners.get('window:closed')?.()
    },
  }
}

describe('the Chorus window registry', () => {
  it('refuses a website or popup that no Chorus window registered', () => {
    const popup = fakeWindow()
    expect(isShellSender({ sender: popup.contents, senderFrame: popup.mainFrame })).toBe(false)
    expect(shellWindows()).not.toContain(popup.window)
  })

  it('accepts only the main frame of a registered window', () => {
    const shell = fakeWindow()
    registerShellWindow(shell.window)
    expect(isShellSender({ sender: shell.contents, senderFrame: shell.mainFrame })).toBe(true)
    const subframe = {} as unknown as WebFrameMain
    expect(isShellSender({ sender: shell.contents, senderFrame: subframe })).toBe(false)
    expect(isShellSender({ sender: shell.contents, senderFrame: null })).toBe(false)
    expect(shellWindows()).toContain(shell.window)
  })

  it('forgets a window once it is destroyed', () => {
    const shell = fakeWindow()
    registerShellWindow(shell.window)
    shell.destroy()
    expect(shellWindows()).not.toContain(shell.window)
    expect(isShellSender({ sender: shell.contents, senderFrame: shell.mainFrame })).toBe(false)
  })

  it('reports no focused shell while a website popup has focus', () => {
    const shell = fakeWindow()
    const popup = fakeWindow()
    registerShellWindow(shell.window)
    focus.current = popup.window
    expect(focusedShellWindow()).toBeNull()
    focus.current = shell.window
    expect(focusedShellWindow()).toBe(shell.window)
    focus.current = null
  })
})
