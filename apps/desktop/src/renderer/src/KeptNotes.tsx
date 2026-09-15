import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { firstLine, reordered } from './kept-notes.js'
import { NoteEditor, type NoteEditorHandle } from './NoteEditor.js'
import { NoteGrips } from './NoteGrips.js'
import { useNoteSize } from './noteSize.js'
import { useFocusedConversationId } from './workspace/hooks.js'
import { useShellOverlay } from './workspace/overlay.js'

/**
 * The notes you keep — a collection, reached from the masthead.
 *
 * **A third caller of `NoteEditor`, and deliberately nothing more.** The global
 * note is the one that belongs to no project and a project's belongs to that
 * project; both are single documents with a single first line. This is the case
 * neither could serve: several notes, each its own document. What the editor is
 * remains the editor's, so the bar, images, the drag grip, the box and the
 * selection offer all arrive here without a line being written for them.
 *
 * **Portalled to the body, which is forced rather than chosen.** The button
 * lives in `.masthead`, and that row is 31px tall inside a `.stage` that clips
 * its overflow — the same wall `.global-note` hit and answered by leaving the
 * header. A menu drawn as a child of the button would be cut off at the row's
 * edge. `ProjectPreviewCard` is the pattern followed here, down to measuring the
 * card before placing it.
 *
 * **The list is placed from the button and from nothing else**, which is the one
 * rule that keeps it still. It was placed by aligning the *card's* right edge to
 * the button, so that a panel opening on the left would push the card leftwards
 * and leave the list where it was — correct arithmetic for a button on the right
 * of the window, and this button is on the left. The card was 706px wide with a
 * note open, its left edge landed off the window, the clamp pinned it at the
 * margin, and the list jumped the width of the panel.
 *
 * So the panel opens to the **right** of the list, the placement depends only on
 * the button and the list's own measured width, and `shownId` is deliberately
 * absent from the effect's dependencies — that absence is the guarantee, not an
 * oversight.
 *
 * **The panel takes the room that is left**, between a floor and its usual width.
 * A fixed 460 beside a list that will not move is a panel that hangs off a narrow
 * window, and moving the list back to prevent that is the bug all over again.
 */
export function KeptNotes(props: {
  readonly onSendSelection: (conversationId: string, text: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  /*
   * Where a selection would be sent, subscribed here rather than passed in —
   * `GlobalNotes` makes the same call for the same reason: nothing above this
   * knows, and asking `App` to would subscribe the shell to a value only this
   * reads.
   */
  const conversationId = useFocusedConversationId()

  const [open, setOpen] = useState(false)
  const [held, setHeld] = useState(false)
  const [rows, setRows] = useState<readonly KeptRow[]>([])
  /** What the pointer is over, which only matters while nothing is pinned. */
  const [preview, setPreview] = useState<string | null>(null)
  /** What a click held still. Outranks the pointer entirely — see `shown`. */
  const [pinned, setPinned] = useState<string | null>(null)
  /** The row whose delete has been asked for once. There is no undo. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** The row being dragged, and where it would land — the row it is over and
      which half of it, which is the difference between above and below. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ readonly id: string; readonly below: boolean } | null>(
    null
  )
  const [placed, setPlaced] = useState<Placement | null>(null)

  const button = useRef<HTMLButtonElement | null>(null)
  /* Measured rather than assumed, so the width the list is placed against is the
     width it actually has and no constant here has to agree with the stylesheet. */
  const list = useRef<HTMLUListElement | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  /**
   * One size for every note in the list, rather than one per note.
   *
   * **The hook's own state is what shares it.** This component is mounted for as
   * long as the window is, so the size survives closing the menu and switching
   * rows without being stored anywhere — and a size per note would make the
   * card's shape depend on which row the pointer is resting on.
   *
   * `anchor: 'left'` because this panel is pinned by its left edge, against both
   * other notes which are pinned by their right. Without it the handle would
   * widen the note away from the pointer dragging it.
   *
   * **Nothing is written down**, so it resets when the app does. Persisting it
   * means a settings field and its schema, which is a separate change.
   */
  const resize = useNoteSize({
    stored: { width: null, height: null },
    host: panel,
    anchor: 'left',
    onSave: NOTHING,
  })
  const handle = useRef<NoteEditorHandle | null>(null)

  /* The menu and the panel cover a project's editor, which is a native view the
     OS composites above the DOM — without this they are painted underneath and
     simply are not there. */
  useShellOverlay(open)

  const shownId = pinned ?? preview
  const shown = rows.find((row) => row.id === shownId) ?? null

  const load = async (): Promise<void> => {
    const answer = await window.chorus.listKeptNotes({})
    setRows(answer.notes.map((note) => ({ id: note.id, notes: note.notes })))
  }

  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)

  const keepOpen = (): void => {
    if (closing.current !== null) clearTimeout(closing.current)
    closing.current = null
  }

  const show = (): void => {
    keepOpen()
    if (open) return
    setPlaced(null)
    setOpen(true)
    void load()
  }

  const close = (): void => {
    keepOpen()
    setOpen(false)
    setHeld(false)
    setPreview(null)
    setPinned(null)
    setConfirming(null)
  }

  const closeSoon = (): void => {
    if (held) return
    keepOpen()
    closing.current = setTimeout(close, HOVER_GRACE_MS)
  }

  /*
   * Escape closes the whole menu, not just the note in it.
   *
   * The note has its own Escape — `NoteEditor` takes it to put the caret back —
   * and that one fires first because it is the editor's own `handleKeyDown`
   * rather than a document listener. So pressing it once leaves the text and
   * pressing it again leaves the menu, which is the order somebody expects.
   */
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /*
   * A click anywhere else puts it away.
   *
   * The button is excluded as well, or its own click would close the menu on the
   * way down and the toggle would reopen it — a button that appears to do
   * nothing. Capture phase, so a drag starting elsewhere dismisses on the way
   * down rather than after it has finished somewhere unrelated.
   *
   * **The list and the panel, never the card.** The card is a flex row with
   * `align-items: flex-start`, so its box is as tall as the panel while the list
   * fills only the top of it — and the empty gutter under the list is still the
   * card. `Node.contains` answers true for the node itself, so a press on that
   * gutter targeted `.kept-notes`, took the early return, and the menu stayed
   * open however far from a note it was clicked.
   */
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (list.current?.contains(target) === true) return
      if (panel.current?.contains(target) === true) return
      if (button.current?.contains(target) === true) return
      close()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open])

  /*
   * Measured once it is real, then held — `ProjectPreviewCard`'s argument, and
   * the same hidden frame rather than being seen in the wrong place first.
   *
   * Re-run when the shown note changes, because opening a panel changes the
   * card's width and the right edge is what stays still.
   */
  useLayoutEffect(() => {
    if (!open || list.current === null || button.current === null) return
    const anchor = button.current.getBoundingClientRect()
    const width = list.current.getBoundingClientRect().width
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN))
    /* Whatever is left of the window once the list has its place. The floor is
       what stops a narrow window producing a panel too thin to write in; the
       ceiling is the width it wants when there is room for it. */
    const room = window.innerWidth - (left + width + PANEL_GAP) - MARGIN
    setPlaced({
      left: Math.round(left),
      top: Math.round(anchor.bottom + MARGIN),
      panel: Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, room))),
    })
  }, [open, rows.length])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="kept-notes-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('app.keptNotes')}
        title={t('app.keptNotes')}
        onPointerEnter={show}
        onPointerLeave={closeSoon}
        onClick={() => {
          if (open && held) {
            close()
            return
          }
          setHeld(true)
          show()
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3h8l5 5v13H6zM14 3v5h5M9 12h7M9 16h5" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            className="kept-notes"
            style={{
              left: placed?.left ?? 0,
              top: placed?.top ?? 0,
              /* Set here rather than in the stylesheet because the placement
                 arithmetic subtracts it. Two declarations of one number is one
                 that drifts, and the symptom would be a panel a few pixels off
                 the window's edge. */
              gap: PANEL_GAP,
              visibility: placed === null ? 'hidden' : 'visible',
            }}
            /* The pointer leaving the whole card is what drops a preview, rather
               than leaving a row — otherwise the panel would close on the way to
               itself, since reaching it means leaving the row that opened it. */
            onPointerLeave={() => {
              if (pinned === null) setPreview(null)
              setConfirming(null)
              closeSoon()
            }}
            onPointerEnter={keepOpen}
          >
            <ul
              className="kept-note-list"
              role="menu"
              ref={list}
              onPointerDown={() => {
                setHeld(true)
              }}
            >
              {rows.length === 0 && <li className="kept-note-none">{t('app.keptNoteEmpty')}</li>}
              {rows.map((row) => {
                const label = firstLine(row.notes)
                return (
                  <li key={row.id}>
                    <div
                      className="kept-note-row"
                      role="menuitem"
                      tabIndex={0}
                      draggable
                      data-shown={row.id === shownId}
                      data-pinned={row.id === pinned}
                      data-dragging={row.id === dragging}
                      /* Which edge the line is drawn on, and nothing at all when
                         this is not the row being dropped onto. */
                      data-drop={
                        dropAt?.id === row.id ? (dropAt.below ? 'below' : 'above') : undefined
                      }
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        /* Payload nothing here reads, and it is not optional:
                           a drag with no data attached is refused outright by
                           some engines and starts in none of them reliably. */
                        event.dataTransfer.setData('text/plain', row.id)
                        setDragging(row.id)
                      }}
                      onDragOver={(event) => {
                        if (dragging === null || dragging === row.id) return
                        /* Without this the drop is refused before anything of
                           ours runs — the default for a dragover is "you cannot
                           drop here". */
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        const box = event.currentTarget.getBoundingClientRect()
                        setDropAt({
                          id: row.id,
                          below: event.clientY > box.top + box.height / 2,
                        })
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        const from = dragging
                        const at = dropAt
                        setDragging(null)
                        setDropAt(null)
                        if (from === null || at === null) return
                        const order = reordered(
                          rows.map((row) => row.id),
                          from,
                          at.id,
                          at.below
                        )
                        /* Drawn immediately and sent afterwards. The store is
                           being told what the list already shows rather than
                           asked what it should show — a re-read here would
                           replace the arrangement with an identical copy of it,
                           one round trip later and visibly. */
                        setRows(order.flatMap((id) => rows.filter((row) => row.id === id)))
                        void window.chorus.reorderKeptNotes({ ids: order })
                      }}
                      /* A drag that ends anywhere else — off the list, on the
                         panel, outside the window — still has to put the row
                         back to looking like a row. */
                      onDragEnd={() => {
                        setDragging(null)
                        setDropAt(null)
                      }}
                      onPointerEnter={() => {
                        /* Once something is pinned the pointer stops choosing,
                           or resting the mouse anywhere near the list would
                           replace the note being typed in. And a drag chooses
                           nothing at all: opening a note under the row being
                           carried would resize the card mid-gesture. */
                        if (dragging !== null) return
                        if (pinned === null) setPreview(row.id)
                        setConfirming(null)
                      }}
                      onClick={() => {
                        setPinned(row.id)
                        setPreview(row.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        setPinned(row.id)
                        setPreview(row.id)
                      }}
                    >
                      <span className="kept-note-label">
                        {label === '' ? t('app.keptNoteUntitled') : label}
                      </span>
                      <button
                        type="button"
                        className="kept-note-delete"
                        data-confirming={confirming === row.id}
                        aria-label={
                          confirming === row.id
                            ? t('app.keptNoteDeleteConfirm')
                            : t('app.keptNoteDelete')
                        }
                        title={
                          confirming === row.id
                            ? t('app.keptNoteDeleteConfirm')
                            : t('app.keptNoteDelete')
                        }
                        onClick={(event) => {
                          /* Or the row underneath would take the click as well
                             and pin the note being deleted. */
                          event.stopPropagation()
                          /*
                           * Asked twice for a note with something in it, once
                           * for an empty one. There is no undo anywhere in this
                           * feature, and a dialog here would be an overlay over
                           * an overlay — the same trade `NoteEditor` refuses for
                           * its link control.
                           */
                          if (firstLine(row.notes) !== '' && confirming !== row.id) {
                            setConfirming(row.id)
                            return
                          }
                          setConfirming(null)
                          void (async () => {
                            await window.chorus.removeKeptNote({ id: row.id })
                            if (pinned === row.id) setPinned(null)
                            if (preview === row.id) setPreview(null)
                            await load()
                          })()
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5" />
                        </svg>
                      </button>
                    </div>
                  </li>
                )
              })}
              <li>
                <button
                  type="button"
                  className="kept-note-new"
                  onClick={() => {
                    void (async () => {
                      const made = await window.chorus.createKeptNote({})
                      await load()
                      /* Pinned rather than previewed: making one is a statement
                         that you want to write in it now. */
                      setPinned(made.id)
                      setPreview(made.id)
                    })()
                  }}
                >
                  {t('app.keptNoteNew')}
                </button>
              </li>
            </ul>

            {/*
              After the list in the DOM as well as to its right on screen.

              Reversing the row in CSS would have saved moving this block and
              cost the tab order: the menu is what the button opened, so it is
              what a keyboard should reach first, and the note is what the menu
              leads to.
            */}
            {shown !== null && (
              <div
                ref={panel}
                className="kept-note-panel"
                /* Touching the note holds it, the same as typing does. Without
                   this a resize begun on a merely previewed note would take the
                   pointer off the card and close the note under the handle being
                   held. */
                onPointerDown={() => {
                  setPinned(shown.id)
                  setHeld(true)
                }}
                style={{
                  ...resize.style,
                  /* A dragged width wins. Until there is one the panel takes the
                     room the list leaves, which is why this is inline and not a
                     stylesheet default. */
                  width: resize.sized ? undefined : (placed?.panel ?? PANEL_MAX),
                }}
              >
                <NoteEditor
                  /* Remounted per note, which is what makes one editor safe for
                     many documents: the content is seeded once, so switching
                     rows without this would keep showing the first note's text
                     while saving it under the second note's id. */
                  key={shown.id}
                  notes={shown.notes}
                  conversationId={conversationId}
                  placeholder={t('app.keptNotePlaceholder')}
                  label={t('app.keptNoteLabel')}
                  handle={handle}
                  /* The same three handles the other two notes wear, drawn on
                     this box's own edges — the slot exists precisely so a third
                     shell can hang them somewhere of its own. */
                  grips={<NoteGrips resize={resize} />}
                  onSave={(notes) => {
                    const id = shown.id
                    /* Kept locally as well as sent, so the row's label tracks
                       what is being typed. Not a re-read: re-listing here would
                       re-sort by `updated_at` and move the row under the
                       pointer while somebody is typing in it. */
                    setRows((current) =>
                      current.map((row) => (row.id === id ? { ...row, notes } : row))
                    )
                    void window.chorus.setKeptNote({ id, notes })
                  }}
                  onSendSelection={props.onSendSelection}
                  /* Typing pins it. A click into the editor is a click, and
                     without this the note would close the moment the pointer
                     wandered off the card mid-sentence. */
                  onFocusedChange={(focused) => {
                    if (focused) setPinned(shown.id)
                  }}
                  onEmptyChange={NOTHING}
                />
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  )
}

/** What the menu holds per note. The stamps order the list and stay in main. */
interface KeptRow {
  readonly id: string
  readonly notes: string | null
}

/**
 * Where the card goes, and how wide the note in it may be.
 *
 * `left` and `top` describe the **list**, not the card as a whole — the panel
 * follows the list rather than the other way round, which is the whole of why
 * the list no longer moves when a note opens.
 */
interface Placement {
  readonly left: number
  readonly top: number
  readonly panel: number
}

/** Clear of the window's edges, and of the masthead the button sits on. */
const MARGIN = 8
/** Between the list and the note, and inside the card's own box — a margin here
    would put a dead strip between them that the pointer crosses on its way to
    the note, and crossing it would read as leaving the card. */
const PANEL_GAP = 6
/** Narrow enough to fit beside the list on a small window, wide enough to write
    in. Below this the panel is not a note, it is a column. */
const PANEL_MIN = 280
const PANEL_MAX = 460
const HOVER_GRACE_MS = 200

/**
 * `NoteEditor` reports emptiness so a caller can tint a collapsed row, and this
 * caller has no collapsed row. A constant rather than an inline arrow because
 * the editor reports it from an effect keyed on the callback, and a new function
 * every render would be a new effect every render.
 */
const NOTHING = (): void => {
  /* deliberately nothing — see above */
}
