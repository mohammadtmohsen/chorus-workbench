import { useEffect } from 'react'
import { createSignal, useSignal } from './signal.js'

/**
 * Hides the native workbench views while a shell overlay is on screen, and
 * paints a still of each one in its place.
 *
 * A `WebContentsView` is composited by the OS **above** the renderer's DOM, so
 * there is no z-index, no portal and no stacking context that puts a dialog in
 * front of it. The End Session confirmation was drawn cut in half at the
 * workbench's left edge, and the session hover card vanished entirely. Neither
 * is a CSS bug and neither has a CSS fix — hiding the view is the only lever.
 *
 * Hiding alone was the first attempt and it is not enough: the editor region
 * went empty for the life of the overlay, which a modal survives and a *hover
 * card* does not. Blanking the editor every time a pointer crosses the rail is
 * worse than the occlusion it fixed. So main captures each surface in the same
 * step that hides it, and the frames paint the still into the placeholder the
 * view was sitting over. The editor looks unchanged; it is frozen, which is
 * undetectable across a hover and obvious across nothing else anyone does.
 *
 * `setVisible` rather than a zero rectangle throughout: the surface keeps its
 * bounds, nothing inside the workbench re-lays-out, and it is never told
 * anything happened — reflowing an editor twice per hover card would be visible
 * and would lose scroll position.
 *
 * **The count is the point.** Overlays nest — a menu opens a dialog, a dialog
 * opens a preview — and with a boolean the inner one's unmount would un-hide the
 * views while the outer one is still up. Only the last one out restores them.
 */
let depth = 0

/**
 * The still to paint per surface, by view id.
 *
 * A signal rather than store state or a prop: the value is keyed by a view id,
 * which only `WorkbenchFrame` knows, and it is transient by definition — a
 * `WorkspaceSnapshot` field holding a screenshot would be written to disk. Only
 * mounted frames subscribe, so a hover re-renders four placeholders and nothing
 * else.
 */
const stills = createSignal<Readonly<Record<string, string>>>({})

/**
 * Kept across opens on purpose.
 *
 * The capture is a round trip through main and takes tens of milliseconds, so
 * there is a gap between the views going down and the fresh still arriving. With
 * nothing to paint, that gap is the empty rectangle this whole mechanism exists
 * to avoid — visible as a flicker on every hover. Painting the *previous* still
 * immediately covers it: it is a frame or two of a slightly stale editor, under
 * an overlay, for as long as the round trip takes. Only the first overlay after
 * launch has nothing to show.
 */
let lastStills: Readonly<Record<string, string>> = {}

function hide(): void {
  stills.set(lastStills)
  /*
   * Optional, deliberately. `window.chorus` is declared non-nullable because one
   * `Window` interface covers both documents (see `env.d.ts`), but it is absent
   * in a jsdom test and in the workbench's own document — and a dialog must not
   * fail to open because of that. Fired and forgotten rather than awaited for
   * the same reason: the overlay is already on screen.
   */
  // Disabled rather than removed: the rule is reading the *declaration*, which
  // says `window.chorus` is always there, and the paragraph above is the reason
  // that declaration is a convenience rather than the truth. Deleting the `?.`
  // to satisfy the type would make a dialog throw in both the places it is
  // actually absent.
  void window.chorus
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ?.setWorkbenchVisible({ visible: false })
    .then((result) => {
      /*
       * Discarded if the overlay has already closed. The round trip can outlive
       * a fast hover, and applying its result then would paint a still over the
       * live views that nothing would ever clear.
       */
      if (depth === 0) return
      const next = Object.fromEntries(result.stills.map((shot) => [shot.viewId, shot.dataUrl]))
      lastStills = next
      stills.set(next)
    })
    .catch(() => {
      /* no still; the region is empty for the life of this overlay */
    })
}

function show(): void {
  stills.set({})
  // Same reason as `hide()` above: the optional chain is load-bearing wherever
  // `window.chorus` is not injected.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  void window.chorus?.setWorkbenchVisible({ visible: true }).catch(() => {
    /* nothing to undo; the views are already being asked to come back */
  })
}

/**
 * Call from any component that draws over the workbench region.
 *
 * `active` is for overlays that mount before they are shown; pass `false` and
 * nothing is hidden. Mount-gated overlays (`{open && <Dialog />}`) can omit it.
 */
export function useShellOverlay(active = true): void {
  useEffect(() => {
    if (!active) return undefined
    depth += 1
    if (depth === 1) hide()
    return () => {
      depth -= 1
      if (depth === 0) show()
    }
  }, [active])
}

/** What one surface should paint in place of itself, or null for the real view. */
export function useWorkbenchStill(viewId: string | null): string | null {
  const current = useSignal(stills)
  if (viewId === null) return null
  return current[viewId] ?? null
}
