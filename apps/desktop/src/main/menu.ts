import {
  Menu,
  MenuItem,
  webContents,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { stepScale } from './scale.js'

/**
 * The application menu.
 *
 * Chorus ran on Electron's default menu until zoom needed an owner. A menu
 * accelerator is handled before the page ever sees the keystroke, so ⌘+ and ⌘−
 * could not be implemented in the renderer: the default View menu would have
 * taken them first, zoomed the window itself, and remembered nothing.
 *
 * Replacing the menu means also *keeping* what the default one gave for free.
 * The role-based items below are not filler — without `editMenu` there is no ⌘C
 * in the app at all.
 */

export interface MenuRoutes {
  readonly zoom: (direction: -1 | 0 | 1) => boolean
  readonly reload: () => boolean
  readonly devtools: () => boolean
}

function focusedTarget(): WebContents | null {
  const focused = webContents.getFocusedWebContents()
  if (focused === null) return null
  return (
    webContents.getAllWebContents().find((page) => page.devToolsWebContents === focused) ?? focused
  )
}

export function menuTemplate(routes: MenuRoutes, platform: string): MenuItemConstructorOptions[] {
  const zoom = (direction: -1 | 0 | 1) => (): void => {
    if (!routes.zoom(direction)) stepScale(direction)
  }

  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Actual Size', accelerator: 'CommandOrControl+0', click: zoom(0) },
        { label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: zoom(1) },
        /*
         * The same command under a second accelerator, hidden.
         *
         * ⌘+ requires Shift on most layouts, so the key people actually press is
         * ⌘=. A menu item carries one accelerator, and a visible duplicate would
         * read as two different commands.
         */
        { label: 'Zoom In', accelerator: 'CommandOrControl+=', click: zoom(1), visible: false },
        { label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: zoom(-1) },
        { type: 'separator' },
        {
          label: new MenuItem({ role: 'reload' }).label,
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (!routes.reload()) focusedTarget()?.reload()
          },
        },
        {
          label: new MenuItem({ role: 'toggleDevTools' }).label,
          accelerator: platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            if (!routes.devtools()) focusedTarget()?.toggleDevTools()
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    platform === 'darwin'
      ? { role: 'windowMenu' }
      : {
          label: new MenuItem({ role: 'windowMenu' }).label,
          submenu: [{ role: 'minimize' }, { role: 'close', registerAccelerator: false }],
        },
  ]
}

export function installMenu(routes: MenuRoutes, platform: string): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(routes, platform)))
}
