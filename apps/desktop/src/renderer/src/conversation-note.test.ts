import { describe, expect, it } from 'vitest'
import { EMPTY_CONVERSATION_NOTE, type ConversationNote } from '@chorus/shared'
import {
  adoptsJournal,
  clampNoteRect,
  gestureRect,
  initialNoteState,
  journalOf,
  needsTextSend,
  needsViewSend,
  NOTE_MIN_HEIGHT,
  NOTE_MIN_WIDTH,
  noteConflict,
  noteFractions,
  NoteJournalSlot,
  noteNeedsAttention,
  noteStatus,
  noteText,
  noteView,
  parseJournal,
  placeNote,
  reduceNote,
  type JournalBackend,
  type NoteBounds,
  type NoteJournal,
  type NoteRect,
  type NoteEvent,
  type NoteState,
} from './useConversationNote.js'

const server = (overrides: Partial<ConversationNote>): ConversationNote => ({
  ...EMPTY_CONVERSATION_NOTE,
  ...overrides,
})

const base = server({ body: 'first', revision: 1, version: 1, updatedBy: 'user', updatedAt: 1 })
const second = server({ ...base, body: 'second', revision: 2, version: 2 })

function run(state: NoteState, ...events: NoteEvent[]): NoteState {
  return events.reduce(reduceNote, state)
}

const ready = (note: ConversationNote = base): NoteState =>
  run(initialNoteState(null), { type: 'loading' }, { type: 'loaded', note })

describe('loading', () => {
  it('waits, then loads the saved note as clean', () => {
    const waiting = initialNoteState(null)
    expect(noteStatus(waiting)).toBe('waiting')
    const state = ready()
    expect(noteStatus(state)).toBe('saved')
    expect(noteText(state)).toBe('first')
  })

  it('never turns a failed load into an editable empty note', () => {
    const failed = run(initialNoteState(null), { type: 'loading' }, { type: 'loadFailed' })
    expect(noteStatus(failed)).toBe('failed')
    const typed = reduceNote(failed, { type: 'edited', text: 'overwrite' })
    expect(typed).toBe(failed)
    expect(needsTextSend(typed)).toBe(false)
    expect(reduceNote(failed, { type: 'viewChanged', view: { visible: true } })).toBe(failed)
  })

  it('keeps a loaded note when a later refresh fails', () => {
    const state = ready()
    expect(run(state, { type: 'loading' }, { type: 'loadFailed' })).toBe(state)
  })
})

describe('typing and saving', () => {
  it('journals pending text, sends it against the loaded revision, and clears on ack', () => {
    const typed = reduceNote(ready(), { type: 'edited', text: 'second' })
    expect(journalOf(typed)).toEqual({ text: { text: 'second', base: 1 }, view: null })
    expect(needsTextSend(typed)).toBe(true)
    const sending = reduceNote(typed, { type: 'textSending' })
    expect(sending.sending).toEqual({ text: 'second', base: 1 })
    expect(journalOf(sending)?.text).toEqual({ text: 'second', base: 1 })
    expect(noteStatus(sending)).toBe('saving')
    const acked = reduceNote(sending, {
      type: 'textSent',
      request: { text: 'second', base: 1 },
      result: { status: 'saved', note: second },
    })
    expect(acked.pending).toBeNull()
    expect(journalOf(acked)).toBeNull()
    expect(noteStatus(acked)).toBe('saved')
  })

  it('treats typing back to the saved text as clean when nothing is in flight', () => {
    const state = run(ready(), { type: 'edited', text: 'x' }, { type: 'edited', text: 'first' })
    expect(state.pending).toBeNull()
  })

  it('keeps the draft and its journal through a failed save, and retries on the next edit', () => {
    const failed = run(
      ready(),
      { type: 'edited', text: 'second' },
      { type: 'textSending' },
      { type: 'textFailed' }
    )
    expect(noteStatus(failed)).toBe('saveFailed')
    expect(noteText(failed)).toBe('second')
    expect(journalOf(failed)?.text).toEqual({ text: 'second', base: 1 })
    expect(needsTextSend(failed)).toBe(false)
    expect(needsTextSend(reduceNote(failed, { type: 'retried' }))).toBe(true)
    expect(needsTextSend(reduceNote(failed, { type: 'edited', text: 'second!' }))).toBe(true)
  })
})

describe('own in-flight text echoed by a push', () => {
  it('acknowledges the echo, keeps newer typing, and keeps saving without a conflict', () => {
    const inFlight = run(
      ready(),
      { type: 'edited', text: 'second' },
      { type: 'textSending' },
      { type: 'edited', text: 'second and more' }
    )
    const echoed = reduceNote(inFlight, {
      type: 'pushed',
      note: server({ ...base, body: 'second', revision: 2, version: 2 }),
    })
    expect(noteText(echoed)).toBe('second and more')
    expect(echoed.pending).toEqual({ text: 'second and more', base: 2 })
    expect(noteConflict(echoed)).toBeNull()

    const answered = reduceNote(echoed, {
      type: 'textSent',
      request: { text: 'second', base: 1 },
      result: { status: 'saved', note: second },
    })
    expect(answered.pending).toEqual({ text: 'second and more', base: 2 })
    expect(noteConflict(answered)).toBeNull()
    expect(needsTextSend(answered)).toBe(true)
  })

  it('clears the draft when the echo matches everything typed', () => {
    const echoed = run(
      ready(),
      { type: 'edited', text: 'second' },
      { type: 'textSending' },
      { type: 'pushed', note: server({ ...base, body: 'second', revision: 2, version: 2 }) }
    )
    expect(echoed.pending).toBeNull()
    expect(noteText(echoed)).toBe('second')
  })
})

describe('stale responses and pushes', () => {
  it('ignores a push that is not newer than what it already holds', () => {
    const state = ready(server({ ...base, version: 4 }))
    const older = server({ ...base, body: 'old', version: 3 })
    expect(reduceNote(state, { type: 'pushed', note: older })).toBe(state)
  })

  it('does not let a stale invoke response erase a newer external update', () => {
    const external = server({ body: 'agent text', revision: 3, version: 3, updatedBy: 'claude' })
    const state = run(
      ready(),
      { type: 'edited', text: 'second' },
      { type: 'textSending' },
      { type: 'pushed', note: external },
      {
        type: 'textSent',
        request: { text: 'second', base: 1 },
        result: { status: 'saved', note: second },
      }
    )
    expect(state.saved).toEqual(external)
    expect(noteText(state)).toBe('agent text')
  })
})

describe('an external change while the draft is dirty', () => {
  const external = server({ body: 'agent text', revision: 2, version: 2, updatedBy: 'claude' })
  const dirty = run(ready(), { type: 'edited', text: 'my text' })
  const conflicted = reduceNote(dirty, { type: 'pushed', note: external })

  it('keeps the draft and exposes the conflict instead of saving over it', () => {
    expect(noteText(conflicted)).toBe('my text')
    expect(noteConflict(conflicted)).toEqual(external)
    expect(noteStatus(conflicted)).toBe('conflict')
    expect(needsTextSend(conflicted)).toBe(false)
    expect(journalOf(conflicted)?.text).toEqual({ text: 'my text', base: 1 })
  })

  it('keeps mine against the latest saved revision', () => {
    const newer = server({ ...external, body: 'agent again', revision: 3, version: 3 })
    const kept = run(conflicted, { type: 'pushed', note: newer }, { type: 'keptMine' })
    expect(kept.pending).toEqual({ text: 'my text', base: 3 })
    expect(noteConflict(kept)).toBeNull()
    expect(needsTextSend(kept)).toBe(true)
  })

  it('uses the saved text and discards the draft only when asked', () => {
    const used = reduceNote(conflicted, { type: 'usedSaved' })
    expect(used.pending).toBeNull()
    expect(noteText(used)).toBe('agent text')
    expect(journalOf(used)).toBeNull()
  })

  it('reports a conflict answered by main the same way', () => {
    const answered = run(
      dirty,
      { type: 'textSending' },
      {
        type: 'textSent',
        request: { text: 'my text', base: 1 },
        result: { status: 'conflict', note: external },
      }
    )
    expect(noteConflict(answered)).toEqual(external)
    expect(noteText(answered)).toBe('my text')
  })

  it('shows no conflict while its own write is still in flight', () => {
    const inFlight = run(dirty, { type: 'textSending' }, { type: 'pushed', note: external })
    expect(noteConflict(inFlight)).toBeNull()
  })
})

describe('view-only changes', () => {
  it('apply a geometry push without a text conflict while the draft is dirty', () => {
    const dirty = run(ready(), { type: 'edited', text: 'my text' })
    const moved = reduceNote(dirty, {
      type: 'pushed',
      note: server({ ...base, version: 2, visible: true, x: 0.5, width: 0.4 }),
    })
    expect(noteConflict(moved)).toBeNull()
    expect(noteText(moved)).toBe('my text')
    expect(noteView(moved)).toMatchObject({ visible: true, x: 0.5, width: 0.4 })
    expect(needsTextSend(moved)).toBe(true)
  })

  it('show local view changes until they are acknowledged, and journal them', () => {
    const shown = reduceNote(ready(), { type: 'viewChanged', view: { visible: true, x: 0.2 } })
    expect(noteView(shown)).toMatchObject({ visible: true, x: 0.2 })
    expect(journalOf(shown)?.view).toEqual({ visible: true, x: 0.2 })
    expect(needsViewSend(shown)).toBe(true)
    const sending = reduceNote(shown, { type: 'viewSending' })
    expect(journalOf(sending)?.view).toEqual({ visible: true, x: 0.2 })
    const acked = reduceNote(sending, {
      type: 'viewSent',
      note: server({ ...base, version: 2, visible: true, x: 0.2 }),
    })
    expect(journalOf(acked)).toBeNull()
    expect(noteView(acked)).toMatchObject({ visible: true, x: 0.2 })
  })

  it('restore an unacknowledged view change after a failure', () => {
    const failed = run(
      ready(),
      { type: 'viewChanged', view: { visible: true } },
      { type: 'viewSending' },
      { type: 'viewChanged', view: { x: 0.3 } },
      { type: 'viewFailed' }
    )
    expect(failed.pendingView).toEqual({ visible: true, x: 0.3 })
    expect(noteView(failed)).toMatchObject({ visible: true, x: 0.3 })
    expect(noteStatus(failed)).toBe('saveFailed')
  })
})

describe('a recovered journal', () => {
  const journal = parseJournal(
    JSON.stringify({ text: { text: 'unsaved', base: 1 }, view: { visible: true, x: 0.1 } })
  )

  it('parses only well-formed drafts and views', () => {
    expect(journal).toEqual({ text: { text: 'unsaved', base: 1 }, view: { visible: true, x: 0.1 } })
    expect(parseJournal('not json')).toBeNull()
    expect(parseJournal(JSON.stringify({ text: { text: 1, base: 1 } }))).toBeNull()
    expect(parseJournal(JSON.stringify({ text: { text: 'a', base: -1 } }))).toBeNull()
    expect(parseJournal(JSON.stringify({ view: { x: 2, visible: 'yes' } }))).toBeNull()
    expect(parseJournal(null)).toBeNull()
  })

  it('is sent when the saved revision is still the one it was based on', () => {
    const state = run(
      initialNoteState(journal),
      { type: 'loading' },
      { type: 'loaded', note: base }
    )
    expect(noteText(state)).toBe('unsaved')
    expect(needsTextSend(state)).toBe(true)
    expect(needsViewSend(state)).toBe(true)
  })

  it('is acknowledged when main already holds the same text', () => {
    const state = run(
      initialNoteState(journal),
      { type: 'loading' },
      { type: 'loaded', note: server({ ...base, body: 'unsaved', revision: 2, version: 2 }) }
    )
    expect(state.pending).toBeNull()
  })

  it('becomes a conflict when the note moved on, and is never dropped silently', () => {
    const moved = server({ body: 'agent text', revision: 4, version: 5, updatedBy: 'codex' })
    const state = run(
      initialNoteState(journal),
      { type: 'loading' },
      { type: 'loaded', note: moved }
    )
    expect(noteText(state)).toBe('unsaved')
    expect(noteConflict(state)).toEqual(moved)
    expect(journalOf(state)?.text).toEqual({ text: 'unsaved', base: 1 })
  })

  it('is held, unsent, while the chat is still starting', () => {
    const waiting = initialNoteState(journal)
    expect(needsTextSend(waiting)).toBe(false)
    expect(needsViewSend(waiting)).toBe(false)
    expect(journalOf(waiting)).toEqual(journal)
  })
})

describe('geometry', () => {
  const pane = { width: 1_000, height: 800 }

  it('places an unplaced note at its default size in the top corner', () => {
    const rect = placeNote(noteView(ready()), pane)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.left + rect.width).toBeLessThanOrEqual(pane.width)
  })

  it('draws a stored note inside a smaller pane without changing what is stored', () => {
    const view = { visible: true, x: 0.8, y: 0.8, width: 0.5, height: 0.5 }
    const small = { width: 300, height: 200 }
    const rect = placeNote(view, small)
    expect(rect.left + rect.width).toBeLessThanOrEqual(small.width)
    expect(rect.top + rect.height).toBeLessThanOrEqual(small.height)
    expect(rect.width).toBeGreaterThanOrEqual(NOTE_MIN_WIDTH)
    expect(view).toEqual({ visible: true, x: 0.8, y: 0.8, width: 0.5, height: 0.5 })
  })

  it('caps the minimum size by a pane smaller than the minimum', () => {
    const tiny = { width: 100, height: 60 }
    const rect = clampNoteRect({ left: 50, top: 50, width: 10, height: 10 }, tiny)
    expect(rect).toEqual({ left: 0, top: 0, width: 100, height: 60 })
    expect(clampNoteRect({ left: 0, top: 0, width: 10, height: 10 }, pane)).toMatchObject({
      width: NOTE_MIN_WIDTH,
      height: NOTE_MIN_HEIGHT,
    })
  })

  it('stores a gesture as normalised fractions within 0..1', () => {
    const fractions = noteFractions({ left: 250, top: 200, width: 500, height: 400 }, pane)
    expect(fractions).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    const outside = noteFractions({ left: -20, top: 900, width: 2_000, height: 10 }, pane)
    for (const value of Object.values(outside)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

interface FakeJournal extends JournalBackend {
  stored: string | null
  failReads: boolean
  failCompares: boolean
  loseNextReply: boolean
  compares: number
  between: (() => void) | null
}

function fakeJournal(initial: string | null = null): FakeJournal {
  const journal: FakeJournal = {
    stored: initial,
    failReads: false,
    failCompares: false,
    loseNextReply: false,
    compares: 0,
    between: null,
    read: () =>
      journal.failReads ? { ok: false } : { ok: true, matched: true, current: journal.stored },
    compare: (expected, next) => {
      journal.compares += 1
      const interleaved = journal.between
      journal.between = null
      interleaved?.()
      if (journal.failCompares) return { ok: false }
      if (journal.stored !== expected) return { ok: true, matched: false, current: journal.stored }
      journal.stored = next
      if (journal.loseNextReply) {
        journal.loseNextReply = false
        return { ok: false }
      }
      return { ok: true, matched: true, current: next }
    },
  }
  return journal
}

function opened(journal: FakeJournal, owner: string): NoteJournalSlot {
  const slot = new NoteJournalSlot(journal, owner)
  const read = slot.read()
  if (!read.ok) throw new Error('unreadable')
  slot.adopt(read.raw)
  return slot
}

const draft = (text: string): NoteJournal => ({ text: { text, base: 1 }, view: null })

const textOf = (journal: FakeJournal): string | undefined =>
  parseJournal(journal.stored)?.text?.text

describe('a journal shared by two renderers during a transfer', () => {
  it('keeps the newer draft when the old renderer is acknowledged late', () => {
    const journal = fakeJournal()
    const before = opened(journal, 'old')
    expect(before.sync(draft('A'))).toBe('ok')

    const after = new NoteJournalSlot(journal, 'new')
    const read = after.read()
    if (!read.ok) throw new Error('unreadable')
    expect(read.journal?.text).toEqual({ text: 'A', base: 1 })
    after.adopt(read.raw)
    const recovered = run(
      initialNoteState(read.journal),
      { type: 'loading' },
      { type: 'loaded', note: base },
      { type: 'edited', text: 'B' }
    )
    expect(after.sync(journalOf(recovered))).toBe('ok')

    expect(before.sync(null)).toBe('ok')
    expect(textOf(journal)).toBe('B')
    expect(before.sync(draft('A again'))).toBe('writeFailed')
    expect(textOf(journal)).toBe('B')

    expect(after.sync(draft('B2'))).toBe('ok')
    expect(textOf(journal)).toBe('B2')
    expect(after.sync(null)).toBe('ok')
    expect(journal.stored).toBeNull()
  })

  it('keeps a newer draft written between the old renderer’s knowledge and its compare', () => {
    const journal = fakeJournal()
    const before = opened(journal, 'old')
    expect(before.sync(draft('A'))).toBe('ok')
    const after = opened(journal, 'new')
    journal.between = () => {
      expect(after.sync(draft('B'))).toBe('ok')
    }
    expect(before.sync(null)).toBe('ok')
    expect(textOf(journal)).toBe('B')
  })

  it('refuses an old replacement that races a newer draft, leaving the newer one', () => {
    const journal = fakeJournal()
    const before = opened(journal, 'old')
    expect(before.sync(draft('A'))).toBe('ok')
    const after = opened(journal, 'new')
    journal.between = () => {
      expect(after.sync(draft('B'))).toBe('ok')
    }
    expect(before.sync(draft('A2'))).toBe('writeFailed')
    expect(textOf(journal)).toBe('B')
  })

  it('writes its draft again when its record disappeared underneath it', () => {
    const journal = fakeJournal()
    const slot = opened(journal, 'me')
    expect(slot.sync(draft('kept'))).toBe('ok')
    journal.stored = null
    expect(slot.sync(draft('kept'))).toBe('ok')
    expect(textOf(journal)).toBe('kept')
  })

  it('recovers when the acknowledgement of its own write was lost', () => {
    const journal = fakeJournal()
    const slot = opened(journal, 'me')
    journal.loseNextReply = true
    expect(slot.sync(draft('first'))).toBe('writeFailed')
    expect(slot.sync(draft('second'))).toBe('ok')
    expect(textOf(journal)).toBe('second')
  })
})

describe('journal failures', () => {
  it('treats an unreadable journal as unknown, not absent, and adopts it on retry', () => {
    const journal = fakeJournal(
      JSON.stringify({ owner: 'gone', text: { text: 'unsaved', base: 1 }, view: null })
    )
    journal.failReads = true
    const slot = new NoteJournalSlot(journal, 'me')
    expect(slot.read().ok).toBe(false)

    const state = run(
      initialNoteState(null, 'readFailed'),
      { type: 'loading' },
      { type: 'loaded', note: base }
    )
    expect(noteStatus(state)).toBe('journalReadFailed')
    expect(noteNeedsAttention(state)).toBe(true)
    expect(slot.sync(draft('typed'))).toBe('readFailed')
    expect(slot.sync(null)).toBe('readFailed')
    expect(journal.compares).toBe(0)
    expect(textOf(journal)).toBe('unsaved')

    journal.failReads = false
    const read = slot.read()
    if (!read.ok) throw new Error('still unreadable')
    expect(adoptsJournal(state, read.journal)).toBe(true)
    slot.adopt(read.raw)
    const adopted = reduceNote(state, { type: 'journalRead', journal: read.journal })
    expect(noteText(adopted)).toBe('unsaved')
    const healthy = reduceNote(adopted, {
      type: 'journaled',
      health: slot.sync(journalOf(adopted)),
    })
    expect(healthy.journal).toBe('ok')
    expect(noteStatus(healthy)).toBe('saving')
    expect(needsTextSend(healthy)).toBe(true)
  })

  it('never overwrites an unread draft with a different local one', () => {
    const journal = fakeJournal(
      JSON.stringify({ owner: 'gone', text: { text: 'older', base: 1 }, view: null })
    )
    journal.failReads = true
    const slot = new NoteJournalSlot(journal, 'me')
    expect(slot.read().ok).toBe(false)
    const typed = run(
      initialNoteState(null, 'readFailed'),
      { type: 'loading' },
      { type: 'loaded', note: base },
      { type: 'edited', text: 'newer' }
    )
    journal.failReads = false
    const read = slot.read()
    if (!read.ok) throw new Error('still unreadable')
    expect(adoptsJournal(typed, read.journal)).toBe(false)
    expect(slot.sync(journalOf(typed))).toBe('writeFailed')
    expect(textOf(journal)).toBe('older')
  })

  it('reports a failed write and clears it when a retry succeeds', () => {
    const journal = fakeJournal()
    const slot = opened(journal, 'me')
    const typed = reduceNote(ready(), { type: 'edited', text: 'second' })
    journal.failCompares = true
    const failing = reduceNote(typed, {
      type: 'journaled',
      health: slot.sync(journalOf(typed)),
    })
    expect(noteStatus(failing)).toBe('journalFailed')
    expect(noteNeedsAttention(failing)).toBe(true)
    expect(noteText(failing)).toBe('second')

    journal.failCompares = false
    const retried = reduceNote(reduceNote(failing, { type: 'retried' }), {
      type: 'journaled',
      health: slot.sync(journalOf(failing)),
    })
    expect(retried.journal).toBe('ok')
    expect(textOf(journal)).toBe('second')
  })

  it('keeps a failed cleanup of its own record visible after the note saved', () => {
    const journal = fakeJournal()
    const slot = opened(journal, 'me')
    const typed = reduceNote(ready(), { type: 'edited', text: 'second' })
    expect(slot.sync(journalOf(typed))).toBe('ok')
    journal.failCompares = true
    const acked = run(
      typed,
      { type: 'textSending' },
      {
        type: 'textSent',
        request: { text: 'second', base: 1 },
        result: { status: 'saved', note: second },
      }
    )
    const reported = reduceNote(acked, {
      type: 'journaled',
      health: slot.sync(journalOf(acked)),
    })
    expect(noteStatus(reported)).toBe('journalFailed')
    expect(textOf(journal)).toBe('second')

    journal.failCompares = false
    const retried = reduceNote(reduceNote(reported, { type: 'retried' }), {
      type: 'journaled',
      health: slot.sync(journalOf(reported)),
    })
    expect(noteStatus(retried)).toBe('saved')
    expect(journal.stored).toBeNull()
  })

  it('never reports a stale view journal healthy across repeated failed cleanups', () => {
    const journal = fakeJournal()
    const slot = opened(journal, 'me')
    expect(slot.sync({ text: null, view: { x: 0.2 } })).toBe('ok')
    journal.failCompares = true
    expect(slot.sync(null)).toBe('writeFailed')
    expect(slot.sync({ text: null, view: { x: 0.6 } })).toBe('writeFailed')
    expect(slot.sync(null)).toBe('writeFailed')
    expect(parseJournal(journal.stored)?.view).toEqual({ x: 0.2 })
    journal.failCompares = false
    expect(slot.sync(null)).toBe('ok')
    expect(journal.stored).toBeNull()
  })

  it('treats a journal that is really empty as healthy', () => {
    const journal = fakeJournal()
    const slot = opened(journal, 'me')
    expect(slot.sync(null)).toBe('ok')
    expect(journal.compares).toBe(0)
    journal.failCompares = true
    expect(slot.sync(draft('x'))).toBe('writeFailed')
    journal.failCompares = false
    expect(slot.sync(null)).toBe('ok')
    expect(journal.stored).toBeNull()
  })
})

describe('a gesture while the pane changes size', () => {
  const wide: NoteBounds = { width: 1_000, height: 800 }
  const narrow: NoteBounds = { width: 360, height: 240 }
  const stored = { visible: true, x: 0.6, y: 0.6, width: 0.35, height: 0.35 }
  const origin: NoteRect = placeNote(stored, wide)

  const inside = (rect: NoteRect, bounds: NoteBounds): void => {
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.left + rect.width).toBeLessThanOrEqual(bounds.width)
    expect(rect.top + rect.height).toBeLessThanOrEqual(bounds.height)
  }

  it('clamps a move and a resize against the current bounds', () => {
    inside(gestureRect('move', origin, 40, 30, narrow), narrow)
    inside(gestureRect('move', origin, -2_000, -2_000, narrow), narrow)
    inside(gestureRect('resize', origin, 900, 900, narrow), narrow)
  })

  it('draws a still gesture inside the smaller pane without touching stored geometry', () => {
    inside(gestureRect('move', origin, 0, 0, narrow), narrow)
    inside(placeNote(stored, narrow), narrow)
    expect(stored).toEqual({ visible: true, x: 0.6, y: 0.6, width: 0.35, height: 0.35 })
  })
})
