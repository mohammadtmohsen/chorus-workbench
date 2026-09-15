import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'
import { WorkbenchProbe } from './workbench/WorkbenchProbe.js'
import './i18n/index.js'
/*
 * The emulator's own stylesheet, before ours.
 *
 * xterm ships the rules that make its rows and cursor lay out at all; loading it
 * first is what lets `styles.css` override the parts that are ours — the surface
 * it sits on and the space around it.
 */
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root container')

const DETACHED_HASH = '#detached='
const role: WindowRole = window.location.hash.startsWith(DETACHED_HASH)
  ? {
      kind: 'detached',
      projectId: decodeURIComponent(window.location.hash.slice(DETACHED_HASH.length)),
    }
  : { kind: 'main' }

createRoot(container).render(
  <StrictMode>
    <App role={role} />
    {/*
     * Beside `App`, not inside it. `App` returns early for a restoring shell and
     * for one with no sessions, and the containment probe has to be reachable in
     * both — a gate you can only get to once the app is fully up is a gate that
     * cannot report on a broken one.
     */}
    <WorkbenchProbe />
  </StrictMode>
)
