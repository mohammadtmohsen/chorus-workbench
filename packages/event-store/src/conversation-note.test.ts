import { beforeEach, describe, expect, it } from 'vitest'
import { CONVERSATION_NOTE_MAX_LENGTH, EMPTY_CONVERSATION_NOTE } from '@chorus/shared'
import {
  CONVERSATION_NOTE_JOURNAL_MAX_LENGTH,
  ConversationNoteStore,
  UnknownConversationError,
} from './conversation-note.js'
import { PROJECTION_TABLES } from './projections.js'
import { purgeProject } from './purge.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore } from './store.js'

let db: SqliteHandle
let store: EventStore
let notes: ConversationNoteStore

function createConversation(conversationId: string, projectId: string): void {
  store.append(
    {
      conversationId,
      actor: 'user',
      payload: { type: 'conversation.created', projectId, title: conversationId },
    },
    1_000
  )
}

function rows(conversationId?: string): number {
  const found = db
    .prepare(
      `SELECT COUNT(*) AS n FROM conversation_note
        WHERE @conversationId IS NULL OR conversation_id = @conversationId`
    )
    .get({ conversationId: conversationId ?? null }) as { n: number }
  return found.n
}

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  notes = new ConversationNoteStore(db)
  createConversation('c1', 'p1')
  createConversation('c2', 'p1')
  createConversation('c3', 'p2')
})

describe('reading', () => {
  it('reads an untouched conversation as an empty, hidden, unplaced note', () => {
    expect(notes.read('c1')).toEqual(EMPTY_CONVERSATION_NOTE)
    expect(rows()).toBe(0)
  })

  it('refuses a conversation that does not exist and creates no row for it', () => {
    expect(() => notes.read('missing')).toThrow(UnknownConversationError)
    expect(() => notes.setText('missing', 'x', 0, 'user', 1)).toThrow(UnknownConversationError)
    expect(() => notes.setView('missing', { visible: true })).toThrow(UnknownConversationError)
    expect(rows()).toBe(0)
  })

  it('degrades corrupted stored values instead of failing the read', () => {
    db.prepare(
      `INSERT INTO conversation_note (conversation_id, body, revision, version, visible, updated_by)
       VALUES ('c1', 'kept', 2, 3, 1, '')`
    ).run()
    db.exec(`PRAGMA ignore_check_constraints = ON`)
    db.prepare(
      `UPDATE conversation_note SET x = 'wide', width = 7 WHERE conversation_id = 'c1'`
    ).run()
    db.exec(`PRAGMA ignore_check_constraints = OFF`)
    const note = notes.read('c1')
    expect(note.body).toBe('kept')
    expect(note.revision).toBe(2)
    expect(note.version).toBe(3)
    expect(note.visible).toBe(true)
    expect(note.x).toBeNull()
    expect(note.width).toBeNull()
    expect(note.updatedBy).toBeNull()
  })
})

describe('text compare-and-set', () => {
  it('saves text, advancing both counters and recording who wrote it and when', () => {
    const written = notes.setText('c1', 'remember the cap', 0, 'user', 10)
    expect(written.status).toBe('saved')
    expect(written.note).toMatchObject({
      body: 'remember the cap',
      revision: 1,
      version: 1,
      updatedBy: 'user',
      updatedAt: 10,
    })
    expect(notes.read('c1')).toEqual(written.note)
  })

  it('refuses a stale revision and leaves the newer text in place', () => {
    notes.setText('c1', 'first', 0, 'user', 10)
    notes.setText('c1', 'agent edit', 1, 'claude', 20)
    const stale = notes.setText('c1', 'user edit', 1, 'user', 30)
    expect(stale.status).toBe('conflict')
    expect(stale.note).toMatchObject({
      body: 'agent edit',
      revision: 2,
      version: 2,
      updatedBy: 'claude',
      updatedAt: 20,
    })
    expect(notes.read('c1')).toEqual(stale.note)
  })

  it('accepts a retry against the current revision after a conflict', () => {
    notes.setText('c1', 'first', 0, 'user', 10)
    notes.setText('c1', 'agent edit', 1, 'codex', 20)
    expect(notes.setText('c1', 'user edit', 1, 'user', 30).status).toBe('conflict')
    const retried = notes.setText('c1', 'user edit', 2, 'user', 40)
    expect(retried.status).toBe('saved')
    expect(retried.note).toMatchObject({ body: 'user edit', revision: 3, updatedBy: 'user' })
  })

  it('treats identical text as saved without taking authorship or advancing anything', () => {
    notes.setText('c1', 'same', 0, 'claude', 10)
    const echoed = notes.setText('c1', 'same', 0, 'user', 20)
    expect(echoed.status).toBe('saved')
    expect(echoed.note).toMatchObject({
      body: 'same',
      revision: 1,
      version: 1,
      updatedBy: 'claude',
      updatedAt: 10,
    })
  })

  it('allows clearing the text, which is a real change', () => {
    notes.setText('c1', 'something', 0, 'user', 10)
    const cleared = notes.setText('c1', '', 1, 'user', 20)
    expect(cleared.status).toBe('saved')
    expect(cleared.note).toMatchObject({ body: '', revision: 2 })
  })

  it('rejects invalid text writes without storing anything', () => {
    const tooLong = 'x'.repeat(CONVERSATION_NOTE_MAX_LENGTH + 1)
    expect(() => notes.setText('c1', tooLong, 0, 'user', 1)).toThrow(RangeError)
    expect(() => notes.setText('c1', 'x', -1, 'user', 1)).toThrow(RangeError)
    expect(() => notes.setText('c1', 'x', 0.5, 'user', 1)).toThrow(RangeError)
    expect(() => notes.setText('c1', 'x', 0, '', 1)).toThrow(RangeError)
    expect(rows()).toBe(0)
  })

  it('accepts text exactly at the cap', () => {
    const atCap = 'x'.repeat(CONVERSATION_NOTE_MAX_LENGTH)
    expect(notes.setText('c1', atCap, 0, 'user', 1).status).toBe('saved')
  })
})

describe('view updates', () => {
  it('moves, resizes and shows the note without touching the text or its revision', () => {
    notes.setText('c1', 'pinned', 0, 'deepseek', 10)
    const viewed = notes.setView('c1', { visible: true, x: 0.2, y: 0.3, width: 0.5, height: 0.4 })
    expect(viewed).toMatchObject({
      body: 'pinned',
      revision: 1,
      version: 2,
      visible: true,
      x: 0.2,
      y: 0.3,
      width: 0.5,
      height: 0.4,
      updatedBy: 'deepseek',
      updatedAt: 10,
    })
    expect(notes.setText('c1', 'pinned and edited', 1, 'user', 20).status).toBe('saved')
  })

  it('keeps fields the update did not name', () => {
    notes.setView('c1', { x: 0.1, y: 0.15, width: 0.3, height: 0.35 })
    const shown = notes.setView('c1', { visible: true })
    expect(shown).toMatchObject({ visible: true, x: 0.1, y: 0.15, width: 0.3, height: 0.35 })
    const hidden = notes.setView('c1', { visible: false })
    expect(hidden).toMatchObject({ visible: false, x: 0.1, y: 0.15, width: 0.3, height: 0.35 })
  })

  it('advances the version on every stored view change and not on a repeated one', () => {
    const first = notes.setView('c1', { visible: true })
    expect(first.version).toBe(1)
    const repeated = notes.setView('c1', { visible: true })
    expect(repeated.version).toBe(1)
    const moved = notes.setView('c1', { x: 0.4 })
    expect(moved.version).toBe(2)
    expect(moved.revision).toBe(0)
  })

  it('keeps the view when text is written into a note that was only ever shown', () => {
    notes.setView('c1', { visible: true, width: 0.6 })
    const written = notes.setText('c1', 'later text', 0, 'user', 10)
    expect(written.status).toBe('saved')
    expect(written.note).toMatchObject({
      body: 'later text',
      revision: 1,
      version: 2,
      visible: true,
      width: 0.6,
    })
  })

  it('rejects geometry outside 0..1 or not finite without storing anything', () => {
    expect(() => notes.setView('c1', { x: -0.1 })).toThrow(RangeError)
    expect(() => notes.setView('c1', { y: 1.5 })).toThrow(RangeError)
    expect(() => notes.setView('c1', { width: Number.NaN })).toThrow(RangeError)
    expect(() => notes.setView('c1', { height: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(rows()).toBe(0)
  })
})

describe('ownership', () => {
  it('keeps two chats isolated', () => {
    notes.setText('c1', 'first chat', 0, 'user', 10)
    notes.setView('c2', { visible: true, x: 0.9 })
    notes.setText('c2', 'second chat', 0, 'codex', 20)
    expect(notes.read('c1')).toMatchObject({
      body: 'first chat',
      revision: 1,
      version: 1,
      visible: false,
      x: null,
      updatedBy: 'user',
    })
    expect(notes.read('c2')).toMatchObject({
      body: 'second chat',
      revision: 1,
      version: 2,
      visible: true,
      x: 0.9,
      updatedBy: 'codex',
    })
  })

  it('stores exactly one row per conversation however often it is written', () => {
    notes.setText('c1', 'a', 0, 'user', 1)
    notes.setText('c1', 'b', 1, 'claude', 2)
    notes.setView('c1', { visible: true })
    notes.setView('c1', { x: 0.5 })
    expect(rows('c1')).toBe(1)
    expect(rows()).toBe(1)
  })

  it('lives outside the projections and survives rebuilding them', () => {
    expect(PROJECTION_TABLES).not.toContain('conversation_note')
    notes.setText('c1', 'durable', 0, 'user', 10)
    notes.setView('c1', { visible: true, x: 0.25 })
    const before = notes.read('c1')
    store.rebuildProjections()
    expect(notes.read('c1')).toEqual(before)
  })

  it('goes with its project when the project is purged, and only then', () => {
    notes.setText('c1', 'one', 0, 'user', 1)
    notes.setText('c2', 'two', 0, 'user', 1)
    notes.setText('c3', 'three', 0, 'user', 1)
    purgeProject(db, 'p1')
    expect(rows('c1')).toBe(0)
    expect(rows('c2')).toBe(0)
    expect(notes.read('c3').body).toBe('three')
  })
})

describe('the recovery journal', () => {
  it('reads nothing for a conversation that has no row yet, without creating one', () => {
    expect(notes.readJournal('c1')).toBeNull()
    expect(notes.readJournal('starting')).toBeNull()
    expect(rows()).toBe(0)
  })

  it('refuses to write a journal for a conversation that does not exist', () => {
    expect(() => notes.compareJournal('starting', null, 'J')).toThrow(UnknownConversationError)
    expect(rows()).toBe(0)
    expect(notes.compareJournal('starting', null, null)).toEqual({ matched: true, current: null })
    expect(rows()).toBe(0)
  })

  it('never lets a stale observer replace or clear a newer record', () => {
    expect(notes.compareJournal('c1', null, 'A')).toEqual({ matched: true, current: 'A' })
    const observed = notes.readJournal('c1')
    expect(notes.compareJournal('c1', observed, 'B')).toEqual({ matched: true, current: 'B' })
    expect(notes.compareJournal('c1', observed, null)).toEqual({ matched: false, current: 'B' })
    expect(notes.compareJournal('c1', observed, 'A2')).toEqual({ matched: false, current: 'B' })
    expect(notes.readJournal('c1')).toBe('B')
  })

  it('clears a matched record and answers an already-current value as matched', () => {
    notes.compareJournal('c1', null, 'A')
    expect(notes.compareJournal('c1', 'A', 'A')).toEqual({ matched: true, current: 'A' })
    expect(notes.compareJournal('c1', 'A', null)).toEqual({ matched: true, current: null })
    expect(notes.readJournal('c1')).toBeNull()
  })

  it('stays out of the note snapshot, its counters and its text and view writes', () => {
    const saved = notes.setText('c1', 'pinned', 0, 'user', 10).note
    notes.compareJournal('c1', null, 'J')
    expect(notes.read('c1')).toEqual(saved)
    const shown = notes.setView('c1', { visible: true, x: 0.3 })
    expect(shown).toMatchObject({ revision: 1, version: 2 })
    expect(notes.readJournal('c1')).toBe('J')
    notes.setText('c1', 'pinned again', 1, 'claude', 20)
    expect(notes.readJournal('c1')).toBe('J')
    notes.compareJournal('c2', null, 'only a journal')
    expect(notes.read('c2')).toEqual(EMPTY_CONVERSATION_NOTE)
  })

  it('refuses an oversized record without changing the stored one', () => {
    notes.compareJournal('c1', null, 'A')
    const oversized = 'x'.repeat(CONVERSATION_NOTE_JOURNAL_MAX_LENGTH + 1)
    expect(() => notes.compareJournal('c1', 'A', oversized)).toThrow(RangeError)
    expect(notes.readJournal('c1')).toBe('A')
  })

  it('survives a projection rebuild and goes with its project', () => {
    notes.compareJournal('c1', null, 'one')
    notes.compareJournal('c3', null, 'three')
    store.rebuildProjections()
    expect(notes.readJournal('c1')).toBe('one')
    purgeProject(db, 'p1')
    expect(notes.readJournal('c1')).toBeNull()
    expect(notes.readJournal('c3')).toBe('three')
  })
})

describe('deleting a closed chat’s note', () => {
  it('removes its text, view and journal, and nothing that belongs to another chat', () => {
    notes.setText('c1', 'one', 0, 'user', 1)
    notes.setView('c1', { visible: true, x: 0.4 })
    notes.compareJournal('c1', null, 'J1')
    notes.setText('c2', 'two', 0, 'user', 1)
    notes.compareJournal('c2', null, 'J2')
    const history = store.read('c1').length

    expect(notes.delete('c1')).toBe(true)
    expect(rows('c1')).toBe(0)
    expect(notes.read('c1')).toEqual(EMPTY_CONVERSATION_NOTE)
    expect(notes.readJournal('c1')).toBeNull()
    expect(notes.read('c2')).toMatchObject({ body: 'two', revision: 1 })
    expect(notes.readJournal('c2')).toBe('J2')
    expect(store.read('c1')).toHaveLength(history)
    expect(notes.delete('c1')).toBe(false)
  })
})
