import { useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { NOTE_SIZE } from '../../shared/workspace-layout.js'

/**
 * How big a note has been dragged, as fractions of the window.
 *
 * Null on an axis means nobody has dragged it, and that is a value rather than a
 * gap: it is what leaves the stylesheet's own ceiling in charge. A number here
 * replaces that ceiling outright.
 */
export interface NoteSize {
  readonly width: number | null
  readonly height: number | null
}

/** Which edges a handle moves. The corner is the one that moves both. */
export type NoteAxis = 'width' | 'height' | 'both'

/** Everything a handle needs, so the markup for one is four attributes. */
export interface NoteGripProps {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  readonly onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  readonly onKeyUp: () => void
  readonly onFocus: () => void
  readonly onBlur: () => void
  readonly onDoubleClick: () => void
}

export interface NoteResize {
  /** The two custom properties, ready for the shell's own root element. */
  readonly style: CSSProperties
  /**
   * Whether a handle has the keyboard, which counts as still being in the note.
   *
   * The caller ORs this into its own focused flag. Focusing a handle blurs the
   * editor, and a note that collapsed at that moment would take the handle off
   * screen with it — leaving the keyboard nowhere and the gesture impossible to
   * finish.
   */
  readonly holding: boolean
  /**
   * Whether a width has been dragged at all.
   *
   * The stylesheet cannot ask this of `--note-w` on its own: a custom property
   * is either a length or absent, and "absent" only reaches CSS as a fallback
   * inside the one declaration that reads it. The collapsed row needs the answer
   * somewhere else entirely — it is pinned to its right edge once a width exists
   * and left alone before that, which is a second declaration and therefore a
   * second question.
   */
  readonly sized: boolean
  readonly grip: (axis: NoteAxis) => NoteGripProps
}

export interface NoteSizeOptions {
  /** What the registry holds. Both axes may be null. */
  readonly stored: NoteSize
  /**
   * The shell's own root.
   *
   * The box is found under it by class rather than handed in as a ref, because
   * the box belongs to `NoteEditor` — the same bargain `fit` already made for
   * the measuring span. Handing those elements out would make that component's
   * internals part of its contract for the sake of two rectangles.
   */
  readonly host: RefObject<HTMLElement | null>
  /** Called once when a gesture ends, never per frame. */
  readonly onSave: (size: NoteSize) => void
  /**
   * Which edge does not move, and therefore which edge is dragged.
   *
   * **`right` is the default because it was the only case.** Both notes are
   * pinned by their top and their right edge, so a width is the distance back
   * from a right edge that stays put — which is what the arithmetic below says
   * and what put the handle on the left.
   *
   * The kept-notes panel is the third caller and it is pinned by its left: it
   * opens to the right of a list that must not move. Left as it was, dragging
   * its handle would have widened it away from the pointer.
   *
   * Defaulted rather than required, so adding it cannot change either note that
   * already works.
   */
  readonly anchor?: 'left' | 'right'
}

/** The step the pane sashes use, so one gesture behaves the same everywhere. */
const NUDGE = { small: 8, large: 40 } as const

/**
 * Resizing, for both notes and from one place.
 *
 * The maths is the same for either note because both are pinned by their top
 * and their right edge: what a drag moves is the left edge and the bottom one,
 * so a width is the distance back from a right edge that does not move, and a
 * height is the distance down from a top that does not either. Nothing here
 * knows which note it is serving.
 *
 * **Fractions of the window on both axes, including for a project's note**, and
 * `NOTE_SIZE` carries the argument: the column that note floats over is itself
 * dragged, so a fraction of it would resize the note whenever the panes moved.
 */
export function useNoteSize(options: NoteSizeOptions): NoteResize {
  const [size, setSize] = useState<NoteSize>(() => clampSize(options.stored))
  const [holding, setHolding] = useState(false)

  /*
   * Read by the drag's own listeners, which are plain DOM ones and close over
   * the render they were attached in. Committing from there would store the size
   * the note had when the drag started.
   */
  const latest = useRef(size)
  latest.current = size

  const apply = (next: NoteSize): void => {
    /*
     * Written here as well as during render: `pointerup` and the last
     * `pointermove` can land in the same task, and the re-render that would have
     * updated this ref has not happened by then.
     */
    latest.current = next
    setSize(next)
  }

  const commit = (): void => {
    options.onSave(latest.current)
  }

  /** The box, and what it is worth in fractions right now. */
  const measure = (): { readonly box: DOMRect; readonly chrome: number } | null => {
    const box = options.host.current?.querySelector('.note-body')
    if (box === null || box === undefined) return null
    const editor = options.host.current?.querySelector('.note-editor')
    /*
     * The toolbar and the paddings, measured rather than written down.
     *
     * What a height sets is the *editor's* ceiling — see the stylesheet, where
     * `--note-h` replaces the `max-height` a grown note otherwise takes. The box
     * is that plus the bar under it, so without this the pointer would run ahead
     * of the edge it is dragging by the height of the bar.
     */
    const rect = box.getBoundingClientRect()
    const chrome = editor === null || editor === undefined ? 0 : rect.height - editor.clientHeight
    return { box: rect, chrome }
  }

  const start =
    (axis: NoteAxis) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      const measured = measure()
      if (measured === null) return
      /*
       * The element in a local, never read from the event later: React nulls
       * `currentTarget` when the handler returns, so a listener removed during
       * cleanup would find null and leak itself. `ChorusSash` hit this first.
       */
      const grip = event.currentTarget
      const { box, chrome } = measured
      // Where in the box you grabbed, held for the life of the drag, so the edge
      // does not jump under the pointer on press.
      const grabX = event.clientX - box.left
      const grabY = event.clientY - box.bottom

      grip.setPointerCapture(event.pointerId)

      const move = (moved: PointerEvent): void => {
        const wide = axis !== 'height'
        const tall = axis !== 'width'
        /*
         * Both forms answer `box.width` at the moment of the press — that is the
         * check worth keeping in mind. `- grabX` removes where in the handle it
         * was grabbed, so the edge does not jump; the rest is the distance from
         * whichever edge is standing still.
         */
        const from = moved.clientX - grabX
        apply({
          width: wide
            ? clamp(
                (options.anchor === 'left' ? from - box.left + box.width : box.right - from) /
                  window.innerWidth,
                NOTE_SIZE.width
              )
            : latest.current.width,
          height: tall
            ? clamp(
                (moved.clientY - grabY - box.top - chrome) / window.innerHeight,
                NOTE_SIZE.height
              )
            : latest.current.height,
        })
      }
      const stop = (): void => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', stop)
        grip.removeEventListener('pointercancel', stop)
        grip.releasePointerCapture(event.pointerId)
        commit()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', stop)
      // A capture lost to a system gesture fires this and never `pointerup`.
      grip.addEventListener('pointercancel', stop)
    }

  /**
   * As wide as the longest line, and as tall as it wants to be.
   *
   * The width is measured rather than guessed: the box's width minus the
   * editor's content width is its padding, its border and whatever the scrollbar
   * is taking today, and a constant would be right until one of the three
   * changed in CSS and wrong silently after.
   *
   * The height goes back to null instead of to a number, which is the honest
   * opposite of a dragged one — "as tall as it needs to be" is a rule, not a
   * measurement, and the stylesheet is where that rule lives.
   */
  const fit = (axis: NoteAxis) => (): void => {
    const host = options.host.current
    const mirror = host?.querySelector('.note-measure')
    const content = host?.querySelector('.ProseMirror')
    if (host === null) return
    if (mirror === null || mirror === undefined) return
    if (content === null || content === undefined) return
    const measured = measure()
    if (measured === null) return
    const chrome = measured.box.width - content.clientWidth
    const wanted = mirror.getBoundingClientRect().width + chrome
    apply({
      width:
        axis === 'height'
          ? latest.current.width
          : clamp(wanted / window.innerWidth, NOTE_SIZE.width),
      height: axis === 'width' ? latest.current.height : null,
    })
    commit()
  }

  const nudge =
    (axis: NoteAxis) =>
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      if (horizontal && axis === 'height') return
      if (vertical && axis === 'width') return
      if (!horizontal && !vertical) return
      const measured = measure()
      if (measured === null) return
      event.preventDefault()
      const by = event.shiftKey ? NUDGE.large : NUDGE.small
      if (horizontal) {
        const from = latest.current.width ?? measured.box.width / window.innerWidth
        /* Away from the anchored edge widens it, which is the same gesture as the
           drag: left for a box pinned on the right, right for one pinned left. */
        const outward = options.anchor === 'left' ? 'ArrowRight' : 'ArrowLeft'
        const step = (event.key === outward ? by : -by) / window.innerWidth
        apply({ ...latest.current, width: clamp(from + step, NOTE_SIZE.width) })
        return
      }
      const from =
        latest.current.height ?? (measured.box.height - measured.chrome) / window.innerHeight
      const step = (event.key === 'ArrowDown' ? by : -by) / window.innerHeight
      apply({ ...latest.current, height: clamp(from + step, NOTE_SIZE.height) })
    }

  return {
    style: {
      '--note-w': size.width === null ? undefined : `${(size.width * 100).toFixed(3)}vw`,
      '--note-h': size.height === null ? undefined : `${(size.height * 100).toFixed(3)}vh`,
      // The cast `TerminalPanel` already makes: a custom property is a valid
      // inline style and is not something `CSSProperties` can describe.
    } as CSSProperties,
    holding,
    sized: size.width !== null,
    grip: (axis: NoteAxis) => ({
      onPointerDown: start(axis),
      /*
       * **The press must not move focus, or the note closes under the pointer.**
       * A grown note is grown because the editor has the caret; taking it away
       * collapses the box, which takes the handle being held with it. The
       * toolbar's buttons cancel their own `mousedown` for exactly this, and the
       * pointer events a drag is built from are unaffected by it.
       */
      onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
        event.preventDefault()
      },
      onKeyDown: nudge(axis),
      onKeyUp: commit,
      onFocus: () => {
        setHolding(true)
      },
      onBlur: () => {
        setHolding(false)
      },
      onDoubleClick: fit(axis),
    }),
  }
}

function clamp(value: number, bounds: { readonly min: number; readonly max: number }): number {
  if (!Number.isFinite(value)) return bounds.min
  return Math.min(bounds.max, Math.max(bounds.min, value))
}

/**
 * A stored size, bounded — and null kept as null.
 *
 * A value from an older build, a wider display or an edited database can be
 * outside what the handles allow. Clamping on the way in means the note opens
 * somewhere it can be dragged back from, which an unbounded stored width is
 * exactly how to lose.
 */
function clampSize(stored: NoteSize): NoteSize {
  return {
    width: stored.width === null ? null : clamp(stored.width, NOTE_SIZE.width),
    height: stored.height === null ? null : clamp(stored.height, NOTE_SIZE.height),
  }
}
