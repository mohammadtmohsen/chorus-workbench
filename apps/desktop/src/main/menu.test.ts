import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuRoutes } from './menu.js'

interface MenuContents {
  readonly reload: ReturnType<typeof vi.fn>
  readonly toggleDevTools: ReturnType<typeof vi.fn>
  readonly devToolsWebContents: MenuContents | null
}

const harness = vi.hoisted(() => ({
  focused: null as MenuContents | null,
  pages: [] as MenuContents[],
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  MenuItem: class {
    readonly label: string
    constructor(options: { readonly role: string }) {
      this.label =
        options.role === 'reload'
          ? 'Reload'
          : options.role === 'windowMenu'
            ? 'Window'
            : 'Toggle Developer Tools'
    }
  },
  webContents: {
    getFocusedWebContents: () => harness.focused,
    getAllWebContents: () => harness.pages,
  },
}))
vi.mock('./scale.js', () => ({ stepScale: vi.fn() }))

const { menuTemplate } = await import('./menu.js')
const { stepScale } = await import('./scale.js')
const routes: MenuRoutes = {
  zoom: vi.fn(() => false),
  reload: vi.fn(() => false),
  devtools: vi.fn(() => false),
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.focused = null
  harness.pages = []
})

function view(routed: MenuRoutes = routes, platform = 'darwin'): MenuItemConstructorOptions[] {
  const found = menuTemplate(routed, platform).find((item) => item.label === 'View')
  return (found?.submenu ?? []) as MenuItemConstructorOptions[]
}

function accelerators(): string[] {
  return view()
    .map((item) => item.accelerator)
    .filter((a): a is string => a !== undefined)
}

describe('menuTemplate', () => {
  it('binds zoom in, zoom out and actual size', () => {
    expect(accelerators()).toContain('CommandOrControl+Plus')
    expect(accelerators()).toContain('CommandOrControl+-')
    expect(accelerators()).toContain('CommandOrControl+0')
  })

  it('also binds ⌘= , since ⌘+ needs Shift on most layouts', () => {
    const equals = view().find((item) => item.accelerator === 'CommandOrControl+=')
    expect(equals).toBeDefined()
    // Hidden: a visible duplicate would read as two different commands.
    expect(equals?.visible).toBe(false)
  })

  it('steps in the direction the item says', () => {
    const click = (label: string, accelerator: string): void => {
      const item = view().find((i) => i.label === label && i.accelerator === accelerator)
      item?.click?.(undefined as never, undefined, undefined as never)
    }
    click('Zoom In', 'CommandOrControl+Plus')
    expect(stepScale).toHaveBeenLastCalledWith(1)
    click('Zoom Out', 'CommandOrControl+-')
    expect(stepScale).toHaveBeenLastCalledWith(-1)
    click('Actual Size', 'CommandOrControl+0')
    expect(stepScale).toHaveBeenLastCalledWith(0)
  })

  it('keeps the edit menu, or the app loses copy and paste', () => {
    // Replacing Electron's default menu means inheriting what it gave for free.
    expect(menuTemplate(routes, 'darwin').map((item) => item.role)).toContain('editMenu')
  })

  it('routes zoom to a web page before stepping the shell scale', () => {
    const zoom = vi.fn(() => true)
    const item = view({ ...routes, zoom }).find(
      (entry) => entry.accelerator === 'CommandOrControl+Plus'
    )
    item?.click?.(undefined as never, undefined, undefined as never)
    expect(zoom).toHaveBeenCalledWith(1)
    expect(stepScale).not.toHaveBeenCalled()
  })

  it('routes reload and DevTools before falling back', () => {
    const reload = vi.fn(() => true)
    const devtools = vi.fn(() => true)
    const focused: MenuContents = {
      reload: vi.fn(),
      toggleDevTools: vi.fn(),
      devToolsWebContents: null,
    }
    harness.focused = focused
    for (const item of view({ ...routes, reload, devtools })) {
      if (item.accelerator === 'CmdOrCtrl+R' || item.accelerator === 'Alt+Command+I') {
        item.click?.(undefined as never, undefined, undefined as never)
      }
    }
    expect(reload).toHaveBeenCalledOnce()
    expect(devtools).toHaveBeenCalledOnce()
    expect(focused.reload).not.toHaveBeenCalled()
    expect(focused.toggleDevTools).not.toHaveBeenCalled()
  })

  it('falls back to focused contents rather than the shell window', () => {
    const focused: MenuContents = {
      reload: vi.fn(),
      toggleDevTools: vi.fn(),
      devToolsWebContents: null,
    }
    harness.focused = focused
    for (const item of view()) {
      if (item.accelerator === 'CmdOrCtrl+R' || item.accelerator === 'Alt+Command+I') {
        item.click?.(undefined as never, undefined, undefined as never)
      }
    }
    expect(focused.reload).toHaveBeenCalledOnce()
    expect(focused.toggleDevTools).toHaveBeenCalledOnce()
  })

  it('targets inspected contents when their DevTools has focus', () => {
    const tools: MenuContents = {
      reload: vi.fn(),
      toggleDevTools: vi.fn(),
      devToolsWebContents: null,
    }
    const inspected: MenuContents = {
      reload: vi.fn(),
      toggleDevTools: vi.fn(),
      devToolsWebContents: tools,
    }
    harness.focused = tools
    harness.pages = [tools, inspected]
    for (const item of view()) {
      if (item.accelerator === 'CmdOrCtrl+R' || item.accelerator === 'Alt+Command+I') {
        item.click?.(undefined as never, undefined, undefined as never)
      }
    }
    expect(inspected.reload).toHaveBeenCalledOnce()
    expect(inspected.toggleDevTools).toHaveBeenCalledOnce()
    expect(tools.reload).not.toHaveBeenCalled()
  })

  it('keeps the native window menu on macOS and leaves Ctrl+W unregistered elsewhere', () => {
    expect(menuTemplate(routes, 'darwin').at(-1)).toEqual({ role: 'windowMenu' })
    for (const platform of ['win32', 'linux']) {
      const menu = menuTemplate(routes, platform).at(-1)
      expect(menu?.submenu).toEqual([
        { role: 'minimize' },
        { role: 'close', registerAccelerator: false },
      ])
      expect(view(routes, platform).some((item) => item.accelerator === 'Ctrl+Shift+I')).toBe(true)
    }
    const keys = view().map((item) => item.accelerator)
    expect(keys).not.toContain('CommandOrControl+T')
    expect(keys).not.toContain('CommandOrControl+W')
    expect(keys).not.toContain('CommandOrControl+Shift+T')
  })
})
