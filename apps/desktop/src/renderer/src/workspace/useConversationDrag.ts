import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { SplitDirection } from './layout.js'

/**
 * Dragging a conversation inside its project's column.
 *
 * **Its own drag, deliberately not `useTabDrag`.** That one moves *projects*
 * between panes, and the two look alike enough that sharing it was the obvious
 * thing — which is exactly how the outer drag ended up carrying a conversation
 * id through a module keyed by projects, silently, until a split produced a pane
 * whose tab named a project that did not exist. The two gestures answer
 * different questions at different levels, so they get different code and
 * neither can be handed the other's id.
 *
 * It is also much smaller, because it has less to do: no pane tree, no
 * four-way ceiling, no cross-window ghost.
 *
 * No `useShellOverlay` here, and that is a judgement rather than an oversight.
 * Every drop target is inside the Chorus column, which never overlaps the
 * workbench — so nothing is occluded, and blanking the editor for the length of
 * every tab drag would cost more than it bought.
 */

export interface ConversationDropTarget {
  readonly groupId: string
  readonly direction: SplitDirection
}

export interface ConversationDragState {
  readonly tabId: string
  readonly fromGroupId: string
  /** For the ghost — a drag with nothing following the pointer reads as a stuck tab. */
  readonly title: string
  readonly x: number
  readonly y: number
  readonly target: ConversationDropTarget | null
}

/**
 * Far enough that a click is not a drag.
 *
 * A tab's click switches conversations, so a two-pixel wobble while pressing it
 * must not tear the transcript out of its group. Past this the click is also
 * suppressed — see `consumeSuppressedClick`.
 */
const THRESHOLD_PX = 5

export interface ConversationDrag {
  readonly drag: ConversationDragState | null
  readonly onPointerDown: (
    groupId: string,
    tabId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  /** True once, if the pointer-up that just happened ended a drag rather than a click. */
  readonly consumeSuppressedClick: () => boolean
}

export function useConversationDrag(options: {
  readonly onMove: (boxId: string, targetGroupId: string, direction: SplitDirection) => void
}): ConversationDrag {
  const [drag, setDrag] = useState<ConversationDragState | null>(null)
  /*
   * Held in a ref as well as in state. The move handler needs the latest target
   * to apply on pointer-up, and reading it out of `drag` would read whatever the
   * closure captured when the listener was attached.
   */
  const live = useRef<ConversationDragState | null>(null)
  const suppressClick = useRef(false)
  const latest = useRef(options)
  latest.current = options

  const onPointerDown = (
    groupId: string,
    tabId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>
  ): void => {
    if (event.button !== 0) return
    /*
     * The element is captured in a local, not read from the event later. React
     * nulls `currentTarget` the moment the handler returns, so a closure that
     * reaches for it during `pointermove` finds `null` — the listeners attach
     * fine and are then never removed, which is a leak per drag. The same trap
     * the two sashes carry a comment about.
     */
    const tab = event.currentTarget
    const originX = event.clientX
    const originY = event.clientY
    let started = false

    /*
     * **Captured now, not at the threshold**, and that was the bug behind "the
     * tab is not draggable until I let go".
     *
     * `move` is attached to the tab, so without capture it only fires while the
     * pointer is *over* the tab — press and move away in one quick gesture and
     * the threshold is never crossed, because nothing reaches the listener to
     * measure it. The drag then appeared to do nothing until `pointerup`, which
     * did reach it. Both sashes in `Workspace.tsx` capture on pointer-down for
     * exactly this reason; this one did not.
     *
     * Capturing before the threshold is decided is safe: a press that never
     * moves far enough releases the capture in `stop` and the click goes through
     * untouched.
     */
    tab.setPointerCapture(event.pointerId)

    const move = (moved: PointerEvent): void => {
      if (!started) {
        const far =
          Math.abs(moved.clientX - originX) > THRESHOLD_PX ||
          Math.abs(moved.clientY - originY) > THRESHOLD_PX
        if (!far) return
        started = true
      }
      const target = targetAt(moved.clientX, moved.clientY, groupId)
      const next = {
        tabId,
        fromGroupId: groupId,
        title,
        x: moved.clientX,
        y: moved.clientY,
        target,
      }
      live.current = next
      setDrag(next)
    }

    const stop = (): void => {
      tab.removeEventListener('pointermove', move)
      tab.removeEventListener('pointerup', stop)
      tab.removeEventListener('pointercancel', stop)
      if (tab.hasPointerCapture(event.pointerId)) tab.releasePointerCapture(event.pointerId)

      const finished = live.current
      live.current = null
      setDrag(null)
      if (!started) return
      /*
       * A drag that moved suppresses the click the browser fires next, or
       * letting go over the tab's own strip would both reorder it and switch to
       * it. The flag is consumed by the click handler rather than cleared on a
       * timer, so it cannot leak into a later, unrelated click.
       */
      suppressClick.current = true
      if (finished?.target == null) return
      latest.current.onMove(groupId, finished.target.groupId, finished.target.direction)
    }

    tab.addEventListener('pointermove', move)
    tab.addEventListener('pointerup', stop)
    // A capture lost to a system gesture fires this and never `pointerup`.
    tab.addEventListener('pointercancel', stop)
  }

  return {
    drag,
    onPointerDown,
    consumeSuppressedClick: () => {
      const suppressed = suppressClick.current
      suppressClick.current = false
      return suppressed
    },
  }
}

/**
 * What is under the pointer, read from the DOM rather than from measurements
 * taken at drag start.
 *
 * The columns move *during* this drag — a split changes the row, and so does the
 * outer sash — so a rectangle cached on pointer-down describes where things used
 * to be. `elementFromPoint` cannot go stale, and at pointer-move rates the cost
 * is not measurable against the layout the browser is doing anyway.
 */
function targetAt(x: number, y: number, fromGroupId: string): ConversationDropTarget | null {
  const under = document.elementFromPoint(x, y)
  const column = under?.closest<HTMLElement>('.conversation-column')
  const groupId = column?.dataset['group']
  if (column === null || column === undefined || groupId === undefined) return null

  if (groupId === fromGroupId) return null

  const rect = column.getBoundingClientRect()

  const edges: { direction: SplitDirection; distance: number }[] = [
    { direction: 'left', distance: (x - rect.left) / rect.width },
    { direction: 'right', distance: (rect.right - x) / rect.width },
    { direction: 'up', distance: (y - rect.top) / rect.height },
    { direction: 'down', distance: (rect.bottom - y) / rect.height },
  ]
  const nearest = edges.reduce((best, edge) => (edge.distance < best.distance ? edge : best))
  return { groupId, direction: nearest.direction }
}
