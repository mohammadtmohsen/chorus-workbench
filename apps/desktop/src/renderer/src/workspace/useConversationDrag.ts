import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { MAX_PANES, type SplitDirection } from './layout.js'

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
 * four-way ceiling, no cross-window ghost. A conversation can go to a slot in a
 * group, or to a new group beside it, and there is nowhere else in the app for
 * it to land.
 *
 * No `useShellOverlay` here, and that is a judgement rather than an oversight.
 * Every drop target is inside the Chorus column, which never overlaps the
 * workbench — so nothing is occluded, and blanking the editor for the length of
 * every tab drag would cost more than it bought.
 */

/**
 * Where a drop would land, and it is the outer drag's shape one level in.
 *
 * `group` joins that group's strip at a slot; `split` makes a new group on the
 * named side. `preview` is the rectangle to shade — computed here rather than in
 * the view so the highlight and the action can never disagree about which half
 * of a group is about to become a new one.
 */
export type ConversationDropTarget =
  | { readonly kind: 'group'; readonly groupId: string; readonly slot: number }
  | {
      readonly kind: 'split'
      readonly groupId: string
      readonly direction: SplitDirection
    }

export interface ConversationDragState {
  readonly conversationId: string
  /** The group it started in, so a drop back into it is a reorder. */
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

/**
 * The same bands the pane drag uses: a quarter of the side, never more than
 * 120px.
 *
 * Copied deliberately rather than invented. "Exactly the same as project level"
 * is a claim about where the zones *are* as much as about what they do, and a
 * conversation column that split at a third when a pane split at a quarter would
 * feel like a different gesture wearing the same clothes.
 */
const BAND_FRACTION = 0.25
const BAND_MAX_PX = 120

export interface ConversationDrag {
  readonly drag: ConversationDragState | null
  readonly onPointerDown: (
    groupId: string,
    conversationId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  /** True once, if the pointer-up that just happened ended a drag rather than a click. */
  readonly consumeSuppressedClick: () => boolean
}

export function useConversationDrag(options: {
  readonly groupCount: number
  readonly onPlace: (conversationId: string, targetGroupId: string, slot: number) => void
  readonly onSplit: (
    conversationId: string,
    targetGroupId: string,
    direction: SplitDirection
  ) => void
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
    conversationId: string,
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
      const target = targetAt(moved.clientX, moved.clientY, {
        conversationId,
        fromGroupId: groupId,
        groupCount: latest.current.groupCount,
      })
      const next = {
        conversationId,
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
      if (finished.target.kind === 'split') {
        latest.current.onSplit(conversationId, finished.target.groupId, finished.target.direction)
      } else latest.current.onPlace(conversationId, finished.target.groupId, finished.target.slot)
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
function targetAt(
  x: number,
  y: number,
  context: {
    readonly conversationId: string
    readonly fromGroupId: string
    readonly groupCount: number
  }
): ConversationDropTarget | null {
  const under = document.elementFromPoint(x, y)
  const column = under?.closest<HTMLElement>('.conversation-column')
  const groupId = column?.dataset['group']
  if (column === null || column === undefined || groupId === undefined) return null

  const rect = column.getBoundingClientRect()

  /*
   * The four edges first, and the deepest one wins — the same resolution the
   * pane drag uses, and the reason a corner is not ambiguous: two bands overlap
   * there, and whichever the pointer is further into is the one meant.
   */
  const room =
    context.groupCount < MAX_PANES ||
    /*
     * A group about to be emptied by the move frees its own slot, so the
     * ceiling does not stop it. Same arithmetic `splitTab` does with
     * `sourceDisappears`, and without it the last split into a full tree would
     * be refused for making room it was also about to create.
     */
    sourceWouldVanish(context.fromGroupId)
  if (room) {
    const horizontal = Math.min(rect.width * BAND_FRACTION, BAND_MAX_PX)
    const vertical = Math.min(rect.height * BAND_FRACTION, BAND_MAX_PX)
    const candidates: { direction: SplitDirection; penetration: number }[] = [
      { direction: 'left', penetration: (horizontal - (x - rect.left)) / horizontal },
      { direction: 'right', penetration: (horizontal - (rect.right - x)) / horizontal },
      { direction: 'up', penetration: (vertical - (y - rect.top)) / vertical },
      { direction: 'down', penetration: (vertical - (rect.bottom - y)) / vertical },
    ]
    const winner = candidates
      .filter(({ penetration }) => penetration > 0)
      .sort((a, b) => b.penetration - a.penetration)[0]
    if (winner !== undefined) {
      /*
       * A group with one tab cannot split *itself* — the move would empty it and
       * it would collapse straight back, so the gesture is a no-op with a
       * re-render. Refused here as well as in the store, because a highlighted
       * zone that does nothing is worse than no zone.
       */
      if (groupId !== context.fromGroupId || !sourceWouldVanish(context.fromGroupId)) {
        return { kind: 'split', groupId, direction: winner.direction }
      }
    }
  }

  /*
   * Otherwise a slot in this group's strip, from the midpoint of each tab. A
   * group with no strip — one conversation, one group — still accepts a drop; it
   * lands at the end, which is the only slot it has.
   */
  const tabs = [...column.querySelectorAll<HTMLElement>('[data-conversation-tab]')]
  let slot = tabs.length
  for (const [index, tab] of tabs.entries()) {
    const box = tab.getBoundingClientRect()
    if (x < box.left + box.width / 2) {
      slot = index
      break
    }
  }
  return { kind: 'group', groupId, slot }
}

/** Whether the group the drag started in would be left with nothing. */
function sourceWouldVanish(fromGroupId: string): boolean {
  return (
    document.querySelectorAll(
      `.conversation-column[data-group="${fromGroupId}"] [data-conversation-tab]`
    ).length <= 1
  )
}
