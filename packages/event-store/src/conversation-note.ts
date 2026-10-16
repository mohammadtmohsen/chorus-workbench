import {
  CONVERSATION_NOTE_MAX_LENGTH,
  EMPTY_CONVERSATION_NOTE,
  type ConversationNote,
  type ConversationNoteView,
  type ConversationNoteWrite,
} from '@chorus/shared'
import type { Database } from './port.js'

interface ConversationNoteRow {
  readonly body: unknown
  readonly revision: unknown
  readonly version: unknown
  readonly visible: unknown
  readonly x: unknown
  readonly y: unknown
  readonly width: unknown
  readonly height: unknown
  readonly updated_by: unknown
  readonly updated_at: unknown
}

export class UnknownConversationError extends Error {
  constructor(readonly conversationId: string) {
    super(`No conversation with id ${conversationId}`)
    this.name = 'UnknownConversationError'
  }
}

export const CONVERSATION_NOTE_JOURNAL_MAX_LENGTH = CONVERSATION_NOTE_MAX_LENGTH * 6 + 1_024

export interface ConversationNoteJournalSwap {
  readonly matched: boolean
  readonly current: string | null
}

const GEOMETRY = ['x', 'y', 'width', 'height'] as const

function counter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null
}

function asNote(row: ConversationNoteRow | undefined): ConversationNote {
  if (row === undefined) return EMPTY_CONVERSATION_NOTE
  return {
    body: typeof row.body === 'string' ? row.body : '',
    revision: counter(row.revision),
    version: counter(row.version),
    visible: row.visible === 1,
    x: fraction(row.x),
    y: fraction(row.y),
    width: fraction(row.width),
    height: fraction(row.height),
    updatedBy: typeof row.updated_by === 'string' && row.updated_by !== '' ? row.updated_by : null,
    updatedAt:
      typeof row.updated_at === 'number' && Number.isFinite(row.updated_at) ? row.updated_at : 0,
  }
}

function checkText(body: string, expectedRevision: number, author: string): void {
  if (body.length > CONVERSATION_NOTE_MAX_LENGTH) {
    throw new RangeError(
      `A conversation note holds at most ${String(CONVERSATION_NOTE_MAX_LENGTH)} characters`
    )
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RangeError('The expected revision must be a non-negative integer')
  }
  if (author === '') throw new RangeError('A conversation note write needs an author')
}

function checkView(view: ConversationNoteView): void {
  for (const key of GEOMETRY) {
    const value = view[key]
    if (value !== undefined && fraction(value) === null) {
      throw new RangeError(`${key} must be a finite fraction between 0 and 1`)
    }
  }
}

export class ConversationNoteStore {
  constructor(private readonly db: Database) {}

  read(conversationId: string): ConversationNote {
    this.requireConversation(conversationId)
    return this.current(conversationId)
  }

  setText(
    conversationId: string,
    body: string,
    expectedRevision: number,
    author: string,
    now: number
  ): ConversationNoteWrite {
    checkText(body, expectedRevision, author)
    return this.db.transaction((): ConversationNoteWrite => {
      this.requireConversation(conversationId)
      const current = this.current(conversationId)
      if (body === current.body) return { status: 'saved', note: current }
      if (expectedRevision !== current.revision) return { status: 'conflict', note: current }
      this.db
        .prepare(
          `INSERT INTO conversation_note
             (conversation_id, body, revision, version, updated_by, updated_at)
           VALUES (@conversationId, @body, @revision, @version, @author, @now)
           ON CONFLICT(conversation_id) DO UPDATE SET
             body       = excluded.body,
             revision   = excluded.revision,
             version    = excluded.version,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .run({
          conversationId,
          body,
          revision: current.revision + 1,
          version: current.version + 1,
          author,
          now,
        })
      return { status: 'saved', note: this.current(conversationId) }
    })()
  }

  setView(conversationId: string, view: ConversationNoteView): ConversationNote {
    checkView(view)
    return this.db.transaction((): ConversationNote => {
      this.requireConversation(conversationId)
      const current = this.current(conversationId)
      const next = {
        visible: view.visible ?? current.visible,
        x: view.x ?? current.x,
        y: view.y ?? current.y,
        width: view.width ?? current.width,
        height: view.height ?? current.height,
      }
      if (next.visible === current.visible && GEOMETRY.every((key) => next[key] === current[key])) {
        return current
      }
      this.db
        .prepare(
          `INSERT INTO conversation_note
             (conversation_id, visible, x, y, width, height, version)
           VALUES (@conversationId, @visible, @x, @y, @width, @height, @version)
           ON CONFLICT(conversation_id) DO UPDATE SET
             visible = excluded.visible,
             x       = excluded.x,
             y       = excluded.y,
             width   = excluded.width,
             height  = excluded.height,
             version = excluded.version`
        )
        .run({
          conversationId,
          visible: next.visible ? 1 : 0,
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
          version: current.version + 1,
        })
      return this.current(conversationId)
    })()
  }

  delete(conversationId: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM conversation_note WHERE conversation_id = @conversationId`)
        .run({ conversationId }).changes > 0
    )
  }

  readJournal(conversationId: string): string | null {
    const row = this.db
      .prepare(`SELECT journal FROM conversation_note WHERE conversation_id = @conversationId`)
      .get({ conversationId }) as { readonly journal: unknown } | undefined
    return typeof row?.journal === 'string' ? row.journal : null
  }

  compareJournal(
    conversationId: string,
    expected: string | null,
    next: string | null
  ): ConversationNoteJournalSwap {
    if (next !== null && next.length > CONVERSATION_NOTE_JOURNAL_MAX_LENGTH) {
      throw new RangeError(
        `A conversation note journal holds at most ${String(CONVERSATION_NOTE_JOURNAL_MAX_LENGTH)} characters`
      )
    }
    return this.db.transaction((): ConversationNoteJournalSwap => {
      const current = this.readJournal(conversationId)
      if (current !== expected) return { matched: false, current }
      if (next === current) return { matched: true, current }
      if (next === null) {
        this.db
          .prepare(
            `UPDATE conversation_note SET journal = NULL WHERE conversation_id = @conversationId`
          )
          .run({ conversationId })
      } else {
        this.requireConversation(conversationId)
        this.db
          .prepare(
            `INSERT INTO conversation_note (conversation_id, journal)
             VALUES (@conversationId, @next)
             ON CONFLICT(conversation_id) DO UPDATE SET journal = excluded.journal`
          )
          .run({ conversationId, next })
      }
      return { matched: true, current: this.readJournal(conversationId) }
    })()
  }

  private current(conversationId: string): ConversationNote {
    const row = this.db
      .prepare(
        `SELECT body, revision, version, visible, x, y, width, height, updated_by, updated_at
           FROM conversation_note
          WHERE conversation_id = @conversationId`
      )
      .get({ conversationId }) as ConversationNoteRow | undefined
    return asNote(row)
  }

  private requireConversation(conversationId: string): void {
    const found = this.db
      .prepare(`SELECT 1 AS found FROM conversations WHERE id = @conversationId`)
      .get({ conversationId })
    if (found === undefined) throw new UnknownConversationError(conversationId)
  }
}
