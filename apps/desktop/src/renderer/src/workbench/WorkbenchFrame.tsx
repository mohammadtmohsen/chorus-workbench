import { useEffect, useRef, useState } from 'react'
import type { WorkbenchRect } from '../../../shared/workbench-ipc.js'

/**
 * The shell's handle on one surface — and it contains nothing.
 *
 * The workbench is composited by the window, not by this subtree: the element
 * below is a placeholder whose only job is to have a rectangle, which main mirrors
 * onto a `WebContentsView` sitting over it. That is the cost preflight §4.1a
 * accepted when it chose the view over a frame, and it is why every layout bug
 * here is a two-process bug.
 *
 * This file imports nothing but React and a type on purpose. The outer bundle
 * must never pull in a `@codingame/*` module — R1's 0.5 MB threshold is a leak
 * detector for exactly that, not a budget. An `import type` is erased before the
 * bundler sees it, so it costs nothing and is not the thing that rule guards.
 *
 * It never sees a descriptor. It holds an opaque view id, which is useless if it
 * leaks because every operation it names is mediated by main and validated
 * against the project main opened it for.
 *
 * What it opens with is a **grant**, not a path: main mints one from the native
 * chooser and binds it to this window, so a root this component invented — or one
 * a compromised renderer named — is not something `workbench:open` has a shape
 * for. `projectRoot` is here to be *displayed*, and nothing else reads it.
 */
export function WorkbenchFrame({
  grant,
  projectRoot,
  onFailed,
}: {
  readonly grant: string
  /** For the placeholder's label and its test hook. Never sent to main. */
  readonly projectRoot: string
  readonly onFailed: (message: string) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [viewId, setViewId] = useState<string | null>(null)

  useEffect(() => {
    /*
     * `StrictMode` mounts, unmounts and mounts again in development, and the open
     * is asynchronous — so the cleanup can run before the id exists. Without the
     * flag the second mount's surface is the only one anybody closes and the
     * first leaks a whole `WebContents`, which is invisible until R11 counts
     * processes.
     */
    let live = true
    let opened: string | null = null

    /*
     * A close that fails has already got what it wanted, and the refusal is
     * deliberately unreadable.
     *
     * `closeSurface` throws for an id it does not hold, and it says the same
     * thing for "already gone" as for "not yours" — on purpose, so that nothing
     * here can learn whether an id exists. That makes the two cases
     * indistinguishable to this caller, and the only one it can actually reach is
     * the first: main tears a shell's surfaces down itself on reload and on
     * window destruction, which races the unmount that would close them from
     * here. Left unhandled, that race is an unhandled promise rejection every
     * time a shell reloads with a workbench open. It is not reported either —
     * `onFailed` is about a surface that would not open, and this one is closed.
     */
    const closeQuietly = (id: string): void => {
      window.chorus.closeWorkbench({ viewId: id }).catch(() => {
        /* the surface is gone, which is what the call was for */
      })
    }

    window.chorus
      .openWorkbench({ grant })
      .then(({ viewId: id }) => {
        opened = id
        if (!live) {
          closeQuietly(id)
          return
        }
        setViewId(id)
      })
      .catch((error: unknown) => {
        if (live) onFailed(error instanceof Error ? error.message : String(error))
      })

    return () => {
      live = false
      if (opened !== null) closeQuietly(opened)
    }
  }, [grant, onFailed])

  useEffect(() => {
    const element = host.current
    if (viewId === null || element === null) return undefined

    /*
     * The same race `closeQuietly` loses, and deliberately **not** the same
     * answer to it.
     *
     * `setSurfaceBounds` goes through `ownedSurface`, so it refuses an id main no
     * longer holds with the identical unreadable message — and a report in flight
     * when main tears the shell's surfaces down loses that race exactly as a
     * close does. Left as a bare `void` that is an unhandled rejection every time
     * a shell reloads with a workbench open, which is what this fixes.
     *
     * What it must not become is a second silent swallow. A close that fails has
     * already got what it wanted; a bounds call that fails has not. On a frame
     * that is still mounted the refusal means the surface is gone while this
     * component believes it is there — the view will never be moved again, and
     * the symptom is an overlay that quietly stops tracking rather than an error
     * anybody sees. So the **lifecycle** decides and never the error, because the
     * two cases are indistinguishable by message on purpose: after cleanup, the
     * losing report is expected and says nothing; before it, the same string is a
     * defect and goes to `onFailed` like any other.
     */
    let live = true

    /*
     * The rectangle is **measured every frame**, not subscribed to, and that is
     * the whole of E1.
     *
     * What stood here was a `ResizeObserver` on this element plus a `resize`
     * listener on the window — two subscriptions that between them cover *size*
     * and nothing else. An element moves without changing size constantly: a
     * sibling pane closing, a rail or a panel opening, an ancestor scrolling, a
     * tab strip reflowing, an animated layout settling. None of those is a resize
     * of anything either observer watched, so the view went on painting at its
     * old x/y over new content until something happened to resize it — not a
     * frame of lag, a permanently misplaced overlay.
     *
     * The answer is deliberately **not a third subscription**. Enumerating the
     * causes of movement fails silently by construction: the one case nobody
     * thought of produces no event, and a missing event looks exactly like a
     * stationary element. Measuring cannot miss a cause, because it never asks
     * what moved the element. The `IntersectionObserver` inset trick would be
     * cheaper at idle and buys the same silence at a higher price — its root
     * margins are subtle enough that arithmetic which is slightly wrong yields an
     * observer that quietly never fires.
     *
     * The cost is one `getBoundingClientRect` per frame per mounted surface, read
     * inside `requestAnimationFrame` — before style and layout, so it forces the
     * layout that frame was going to perform anyway, and nothing is written back,
     * which is what would make it thrash. The expensive part is the IPC, and that
     * is sent **only when the rectangle differs from the one last sent**, so an
     * idle workbench sends nothing at all after its opening report.
     *
     * Bounds are read in CSS pixels and sent as device-independent pixels, which
     * are the same number only while the zoom factor is 1. Chorus has a zoom
     * (⌘+ / ⌘−) and this still does not compensate for it, so a zoomed shell will
     * mispose the view. That half is untouched here on purpose: it is a unit
     * conversion, not a tracking failure, and it is recorded as such.
     */
    let last: WorkbenchRect | null = null

    const report = (): void => {
      const rect = element.getBoundingClientRect()
      const next: WorkbenchRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      if (
        last !== null &&
        last.x === next.x &&
        last.y === next.y &&
        last.width === next.width &&
        last.height === next.height
      ) {
        return
      }
      last = next
      window.chorus.setWorkbenchBounds({ viewId, rect: next }).catch((error: unknown) => {
        if (live) onFailed(error instanceof Error ? error.message : String(error))
      })
    }

    /*
     * Reports first and schedules second, so the opening report is synchronous
     * with the effect rather than a frame late — the surface must be positioned
     * before it is first composited, not after one frame in the wrong place.
     */
    let frame = 0
    const tick = (): void => {
      report()
      frame = window.requestAnimationFrame(tick)
    }
    tick()

    return () => {
      /*
       * First, and before the loop is cancelled: everything after this line is
       * the frame no longer being on screen, so a report that has already left is
       * one this component can no longer act on. Cancelling stops new reports; it
       * does nothing about the one already in flight, which is the only one that
       * can lose the race.
       */
      live = false
      window.cancelAnimationFrame(frame)
    }
  }, [viewId, onFailed])

  return <div className="workbench-surface" ref={host} data-workbench-surface={projectRoot} />
}
