import type { PointerEvent as ReactPointerEvent } from 'react'
import { useWorkspaceActions } from './hooks.js'

/**
 * The divider between the workbench and Chorus.
 *
 * **Measured from the right edge of the pane**, not from a start offset plus a
 * delta. The workbench on the other side is a `WebContentsView` composited by
 * the window, and it resizes by main mirroring a rectangle this renderer
 * reports — so a drag is two processes agreeing frame by frame. Deriving the
 * width from the pointer's absolute position means a frame that arrives late
 * lands in the right place anyway, where an accumulated delta would drift.
 *
 * Pointer capture rather than window listeners, so a fast drag that leaves the
 * element keeps resizing; and the width is committed on release for the same
 * reason the sidebar's is — the snapshot is rewritten whole, and writing it per
 * frame would be a file write per pixel.
 */
export function ChorusSash({
  projectId,
  onCommit,
}: {
  /** Whose divider this is. One number for the whole app moved every pane at once. */
  readonly projectId: string
  readonly onCommit: () => void
}): React.JSX.Element {
  const { setChorusWidth } = useWorkspaceActions()

  const resize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    /*
     * The element is captured in a local, not read from the event later.
     *
     * React nulls `currentTarget` the moment the handler returns, so a closure
     * that reaches for it during `pointermove` — or worse, during cleanup —
     * finds `null`. The listeners attached fine and were then never removed,
     * which is a leak per drag.
     */
    const sash = event.currentTarget
    const pane = sash.closest('[data-pane-content]')
    const chorus = pane?.querySelector('.workspace-pane-chorus')
    // `closest` returns `Element | null` and never `undefined`, so only `chorus`
    // — which is `undefined` when the optional chain above short-circuits —
    // needs both arms.
    if (pane === null || chorus === null || chorus === undefined) return

    const right = pane.getBoundingClientRect().right
    const startWidth = chorus.getBoundingClientRect().width
    /*
     * **Where in the sash you grabbed, preserved.** Without this the divider
     * jumps to sit exactly under the pointer on mousedown — a few pixels, but
     * it is the whole difference between dragging a handle and the handle
     * teleporting. The offset is then held for the life of the drag, so the
     * width still comes from the pointer's absolute position and cannot drift
     * the way an accumulated delta would.
     */
    const grab = right - event.clientX - startWidth

    sash.setPointerCapture(event.pointerId)

    const move = (moved: PointerEvent): void => {
      setChorusWidth(projectId, right - moved.clientX - grab)
    }
    const stop = (): void => {
      sash.removeEventListener('pointermove', move)
      sash.removeEventListener('pointerup', stop)
      sash.removeEventListener('pointercancel', stop)
      sash.releasePointerCapture(event.pointerId)
      onCommit()
    }
    sash.addEventListener('pointermove', move)
    sash.addEventListener('pointerup', stop)
    // A capture lost to a system gesture fires this and never `pointerup`.
    sash.addEventListener('pointercancel', stop)
  }

  return (
    <div
      className="chorus-sash"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={resize}
      onKeyDown={(event) => {
        // Same keys the pane sashes use, so one gesture works everywhere.
        const step = event.shiftKey ? 40 : 8
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const pane = event.currentTarget.closest('[data-pane-content]')
        const chorus = pane?.querySelector('.workspace-pane-chorus')
        if (chorus === null || chorus === undefined) return
        const current = chorus.getBoundingClientRect().width
        setChorusWidth(projectId, event.key === 'ArrowLeft' ? current + step : current - step)
      }}
      onKeyUp={onCommit}
    />
  )
}
