import { randomUUID } from 'node:crypto'
import type { Database } from './port.js'

/**
 * One note in the collection the masthead opens.
 *
 * **Separate from `AppNote` rather than a generalisation of it**, and that is a
 * decision rather than duplication. The app's note is a single fact about the
 * app, addressed by nothing and always present; these are addressed by id,
 * created and deleted, and there may be none. Folding the two together would put
 * a nullable id and a CHECK on one table and make every read ask which kind it
 * had.
 *
 * No title. A row is labelled by the note's own first line, which the renderer
 * derives from the document it already has to hold.
 */
export interface KeptNote {
  readonly id: string
  /** The serialised document, or null for a note nobody has written in yet. */
  readonly notes: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * What a row can actually hold, which is looser than what the column says.
 *
 * SQLite does not enforce a column's type, so the nullable shapes here are not
 * pessimism — they are the same allowance `app-note.ts` makes, one table over.
 */
interface KeptNoteRow {
  id: string
  notes: string | null
  created_at: number | null
  updated_at: number | null
}

/**
 * A row as a note, with the fields that could be anything checked.
 *
 * A number where the document goes reaches the renderer and is handed straight
 * to `trim()`. Degrading to null reads as a note nobody has written in yet,
 * which is recoverable; throwing would cost the whole list for one bad row.
 */
function asNote(row: KeptNoteRow): KeptNote {
  return {
    id: row.id,
    notes: typeof row.notes === 'string' ? row.notes : null,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
  }
}

/** A stored time, or zero — which sorts such a row last and hides nothing. */
function stamp(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export class KeptNoteStore {
  constructor(private readonly db: Database) {}

  /**
   * Every note, in the order somebody put them in.
   *
   * **`updated_at` decides nothing here any more.** It ordered this list until
   * the rows became draggable, and it is kept because migration 11's backfill
   * needs it and because a stamp is not recoverable once dropped — but reading
   * it here would fight the arrangement.
   *
   * That also retires the care the menu had to take: the order used to be frozen
   * while it was open, because typing re-sorted it and moved the row out from
   * under the pointer. An arranged order cannot do that.
   *
   * The id breaks the tie so the order is total. Two notes that somehow share a
   * position would otherwise come back in whatever order SQLite felt like, which
   * is a list that shuffles between reads.
   */
  list(): KeptNote[] {
    const rows = this.db
      .prepare(`SELECT id, notes, created_at, updated_at FROM kept_note ORDER BY position, id`)
      .all() as readonly KeptNoteRow[]
    return rows.map(asNote)
  }

  /**
   * Writes a whole sequence, in one transaction.
   *
   * **The sequence rather than one row's new index**, because a move changes
   * where everything after it sits. Sending one row would mean the caller and
   * this store each doing half the arithmetic and agreeing about the half they
   * cannot see.
   *
   * Positions are rewritten from zero rather than nudged, so the numbers stay
   * small and dense however many times the list is rearranged. Ids that are not
   * in the table are simply not matched — a stale list from a menu that was open
   * while something was deleted elsewhere is a no-op for that row rather than an
   * error for the whole drag.
   */
  reorder(ids: readonly string[]): void {
    const write = this.db.prepare(`UPDATE kept_note SET position = @position WHERE id = @id`)
    this.db.transaction(() => {
      ids.forEach((id, position) => {
        write.run({ id, position })
      })
    })()
  }

  /**
   * A new, empty note.
   *
   * Empty rather than seeded with anything: the first line is the label, so a
   * placeholder would name every new note the same thing until somebody typed
   * over it.
   *
   * The id is made here rather than taken from the caller, so there is one place
   * that decides what an id is and no way for two callers to disagree.
   */
  create(now: number): KeptNote {
    const note: KeptNote = { id: randomUUID(), notes: null, createdAt: now, updatedAt: now }
    this.db
      .prepare(
        /* Above everything, and without touching another row: one less than the
           smallest position there is. The numbers drift negative and nobody
           cares, because `reorder` rewrites them from zero the first time the
           list is rearranged. */
        `INSERT INTO kept_note (id, notes, created_at, updated_at, position)
         VALUES (
           @id, @notes, @createdAt, @updatedAt,
           (SELECT COALESCE(MIN(position), 0) - 1 FROM kept_note)
         )`
      )
      .run({ id: note.id, notes: note.notes, createdAt: note.createdAt, updatedAt: note.updatedAt })
    return note
  }

  /**
   * Records a note, or answers null if there is no such note any more.
   *
   * **Null rather than an error, because the race is ordinary.** The editor saves
   * on a debounce, so a write can land after the note it belongs to was deleted
   * — the same shape as the project note's debounce outliving its component. The
   * delete is the later intention and wins; failing loudly would turn a normal
   * sequence into an error somebody has to read.
   *
   * Stored verbatim: no trim, no cap, no parsing, like both notes before it.
   */
  setNotes(id: string, notes: string | null, now: number): KeptNote | null {
    this.db
      .prepare(`UPDATE kept_note SET notes = @notes, updated_at = @now WHERE id = @id`)
      .run({ id, notes, now })
    return this.read(id)
  }

  read(id: string): KeptNote | null {
    const row = this.db
      .prepare(`SELECT id, notes, created_at, updated_at FROM kept_note WHERE id = @id`)
      .get({ id }) as KeptNoteRow | undefined
    return row === undefined ? null : asNote(row)
  }

  /** Whether a row went. False for an id that was already gone. */
  remove(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM kept_note WHERE id = @id`).run({ id })
    return result.changes > 0
  }
}
