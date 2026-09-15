import type { Database } from './port.js'

/**
 * The note that belongs to no project, and the size of the panel showing it.
 *
 * The project note's argument, one level up: this is a current fact that gets
 * corrected and eventually deleted, so it lives in the registry beside the log
 * rather than in it. See migration 8 for why it is its own table.
 *
 * Null for `notes` means never written, which is not the same as emptied — the
 * same distinction version 7 kept for a project, and for the same reason. Null
 * for `width` means never dragged, and the caller supplies the default; this
 * store does not know what a window is and must not invent one.
 */
export interface AppNote {
  readonly notes: string | null
  readonly width: number | null
  readonly height: number | null
}

interface AppNoteRow {
  notes: string | null
  width: number | null
  height: number | null
}

const NEVER_WRITTEN: AppNote = { notes: null, width: null, height: null }

export class AppNoteStore {
  constructor(private readonly db: Database) {}

  read(): AppNote {
    const row = this.db.prepare(`SELECT notes, width, height FROM app_note WHERE id = 1`).get() as
      AppNoteRow | undefined
    if (row === undefined) return NEVER_WRITTEN
    return { notes: row.notes, width: measure(row.width), height: measure(row.height) }
  }

  /**
   * Records the note.
   *
   * **Upsert rather than UPDATE, and that is not defensiveness.** Migration 8
   * creates the table empty, so there is no row until the first write — a plain
   * UPDATE would report zero changes and drop the first note ever typed, which
   * reaches a person as "it saved nothing and told me nothing".
   *
   * Stored verbatim: no trim, no cap, no markdown parsing, the same as a
   * project's.
   */
  setNotes(notes: string | null): AppNote {
    this.db
      .prepare(
        `INSERT INTO app_note (id, notes) VALUES (1, @notes)
           ON CONFLICT(id) DO UPDATE SET notes = @notes`
      )
      .run({ notes })
    return this.read()
  }

  /**
   * The panel's size as fractions of the window. Bounds are the caller's.
   *
   * Both together rather than a setter each, because the corner handle moves
   * both in one gesture and two writes for one drag is two chances to store half
   * of it. A null height is a real value and means never dragged.
   */
  setSize(width: number, height: number | null): AppNote {
    this.db
      .prepare(
        `INSERT INTO app_note (id, width, height) VALUES (1, @width, @height)
           ON CONFLICT(id) DO UPDATE SET width = @width, height = @height`
      )
      .run({ width, height })
    return this.read()
  }
}

/**
 * A stored measurement, or null for one that cannot be trusted.
 *
 * SQLite does not enforce a column's type, so a torn write or an edited file can
 * put a string or a NaN here. Degrading to null puts the caller's default back;
 * throwing would make one bad number cost the note as well, which is the half a
 * person actually cares about.
 */
function measure(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
