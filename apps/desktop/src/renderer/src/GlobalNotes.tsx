import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NoteEditor, type NoteEditorHandle } from './NoteEditor.js'
import { NoteGrips } from './NoteGrips.js'
import { useNoteSize, type NoteSize } from './noteSize.js'
import { primaryOnly } from './shortcuts.js'
import { useFocusedConversationId } from './workspace/hooks.js'
import { useShellOverlay } from './workspace/overlay.js'

/**
 * The note that belongs to no project — the box, not the editor.
 *
 * `NoteEditor` is the note itself and is shared with a project's. What is here
 * is everything that is only true of *this* one: it is fixed to the window's
 * top-right corner on the version's line, and ⌘N reaches it. How it is resized
 * is shared too, in `useNoteSize`; only the element the size lands on is this
 * file's, and for this note that is the fixed root below.
 *
 * **One element, and no button to open it.** A note you have to open is a note
 * you forget you wrote, so the first line is always on screen. Focusing grows it
 * to fit, up to half the window or to whatever height it was dragged to;
 * leaving it collapses it back to one line.
 *
 * **Growing over the app is only possible because of `useShellOverlay`.** Each
 * project's editor is a `WebContentsView` the OS composites above the DOM, so
 * nothing the renderer draws can be in front of it. Hiding the views is the only
 * lever, and main hands back a still of each so the region does not go black. At
 * rest nothing is hidden, because nothing overlaps.
 */
export interface GlobalNotesProps {
  readonly notes: string | null
  /** Fractions of the window. The width is already defaulted by the caller. */
  readonly size: NoteSize
  readonly onSave: (notes: string) => void
  readonly onSaveSize: (size: NoteSize) => void
  readonly onSendSelection: (conversationId: string, text: string) => void
}

export function GlobalNotes(props: GlobalNotesProps): React.JSX.Element {
  const { t } = useTranslation()
  /*
   * Where a selection would be sent, subscribed here rather than passed in.
   * `ProjectNotes` takes it as a prop because its caller already derived it on
   * the way to rendering that project's column. Nothing above this knows, and
   * asking `App` to would subscribe the whole shell to a value only this reads.
   */
  const conversationId = useFocusedConversationId()

  const [focused, setFocused] = useState(false)
  const [empty, setEmpty] = useState(true)

  const host = useRef<HTMLDivElement | null>(null)
  const handle = useRef<NoteEditorHandle | null>(null)

  const resize = useNoteSize({ stored: props.size, host, onSave: props.onSaveSize })
  /* A handle with the keyboard keeps the box open, or the gesture would take its
     own target off screen. See `NoteResize.holding`. */
  const open = focused || resize.holding

  /* Only while it is grown. At rest this is one line inside the masthead's own
     row and overlaps no editor. The editor's own surfaces call this too. */
  useShellOverlay(open)

  /*
   * The note's own chord. It moves the caret in and out — there is nothing to
   * open, so the caret is the only thing there is to toggle.
   *
   * Bubble phase, so a field that wants the key first still gets it; a capture
   * listener would take the chord out of the workbench's own keybindings, which
   * is exactly the mistake `shortcuts.ts` was written to stop.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!primaryOnly(event) || event.key.toLowerCase() !== 'n') return
      const note = handle.current
      if (note === null) return
      event.preventDefault()
      note.toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div
      ref={host}
      className="global-note"
      data-focused={open}
      /* Whether there is anything written, so the resting line can say so. */
      data-filled={!empty}
      /* Whether a width has been dragged — see `NoteResize.sized`. */
      data-sized={resize.sized}
      style={resize.style}
    >
      <NoteEditor
        notes={props.notes}
        conversationId={conversationId}
        placeholder={t('app.notePlaceholder')}
        label={t('app.note')}
        handle={handle}
        grips={<NoteGrips resize={resize} />}
        onSave={props.onSave}
        onSendSelection={props.onSendSelection}
        onFocusedChange={setFocused}
        onEmptyChange={setEmpty}
      />
    </div>
  )
}
