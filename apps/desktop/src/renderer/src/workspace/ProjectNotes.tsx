import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NoteEditor, type NoteEditorHandle } from '../NoteEditor.js'
import { NoteGrips } from '../NoteGrips.js'
import { useNoteSize, type NoteSize } from '../noteSize.js'
import { primaryShift } from '../shortcuts.js'

/**
 * A project's scratchpad — the row, not the editor.
 *
 * `NoteEditor` is the note itself and is shared with the global one. What is
 * here is everything only true of *this* one: it is docked at the top of the
 * project's own column, and ⌘⇧N reaches the one in the focused pane.
 *
 * **No icon beside it**, and removing it was what fixed the box shifting when it
 * opened. Closed, the box began after the icon — the column's padding, plus the
 * icon, plus the gap between them — while open it was positioned at a number
 * that matched neither. With nothing to leave room for, both are the padding.
 *
 * **Docked in the Chorus column, never floating over the editor.** A floating
 * card was the first idea and it cannot work here: each project's editor is a
 * `WebContentsView` composited over the window, so anything the renderer draws
 * across that boundary is painted underneath and disappears rather than
 * overlapping. Everything Chorus draws stays on Chorus's side — which is also
 * why this shell, unlike the global note's, calls no overlay hook. It never
 * crosses that edge.
 *
 * **One line at rest, and that is the feature rather than the compromise.** A
 * note you have to open is a note you forget you wrote, so the first line is
 * always on screen and readable without a click. Opening it covers the
 * conversations rather than pushing them down — it leaves the flow, so the tree
 * below keeps its place and its scroll while the note is over it.
 */
export interface ProjectNotesProps {
  readonly projectId: string
  /**
   * Whether this pad's pane has focus — which decides whose note ⌘⇧N means.
   *
   * There is one of these per pane, so it is the only thing that can answer
   * that question. See the effect that reads it.
   */
  readonly active: boolean
  readonly conversationId: string | null
  /** What the registry holds. Null for a project that has never had a note. */
  readonly notes: string | null
  /**
   * How big it was dragged, as fractions of the window. Null on either axis is a
   * note nobody has resized — as wide as its column and as tall as it needs.
   */
  readonly size: NoteSize
  readonly onSave: (projectId: string, notes: string) => void
  readonly onSaveSize: (projectId: string, size: NoteSize) => void
  readonly onSendSelection: (conversationId: string, text: string) => void
}

export function ProjectNotes(props: ProjectNotesProps): React.JSX.Element {
  const { t } = useTranslation()
  const [focused, setFocused] = useState(false)
  const [empty, setEmpty] = useState(true)
  const handle = useRef<NoteEditorHandle | null>(null)
  const host = useRef<HTMLDivElement | null>(null)

  /*
   * Held in a ref because the editor's own save is debounced and can land after
   * this component has been handed a different project — the caller keys it by
   * project, so that is a remount rather than a prop change, but a debounce
   * already in flight belongs to the project it was typed in.
   */
  const save = useRef(props.onSave)
  const saveSize = useRef(props.onSaveSize)
  const projectId = useRef(props.projectId)
  save.current = props.onSave
  saveSize.current = props.onSaveSize
  projectId.current = props.projectId

  const resize = useNoteSize({
    stored: props.size,
    host,
    onSave: (size) => {
      saveSize.current(projectId.current, size)
    },
  })
  /* A handle with the keyboard keeps the box open, or the gesture would take its
     own target off screen. See `NoteResize.holding`. */
  const open = focused || resize.holding

  /*
   * The project note's chord — ⌘⇧N to the global note's ⌘N, and it moves the
   * caret in and out rather than opening anything.
   *
   * **Gated on `active`, because there is one of these per pane.** Four panes
   * are four mounted pads, and four document listeners would every one answer
   * the same keystroke: each would take the caret in turn and the last to run
   * would keep it, so the chord would land in a pane nobody was looking at.
   * Whose note it means is a question only the pane's own focus can answer.
   */
  useEffect(() => {
    if (!props.active) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!primaryShift(event) || event.key.toLowerCase() !== 'n') return
      const note = handle.current
      if (note === null) return
      event.preventDefault()
      note.toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [props.active])

  return (
    <div
      ref={host}
      className="project-notes"
      data-focused={open}
      data-filled={!empty}
      /* Whether a width has been dragged — see `NoteResize.sized`. */
      data-sized={resize.sized}
      style={resize.style}
    >
      <NoteEditor
        notes={props.notes}
        conversationId={props.conversationId}
        placeholder={t('project.notesPlaceholder')}
        label={t('project.notes')}
        handle={handle}
        grips={<NoteGrips resize={resize} />}
        onSave={(notes) => {
          save.current(projectId.current, notes)
        }}
        onSendSelection={props.onSendSelection}
        onFocusedChange={setFocused}
        onEmptyChange={setEmpty}
      />
    </div>
  )
}
