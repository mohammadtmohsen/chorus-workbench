import { z } from 'zod'
import type { Database } from './port.js'

/**
 * Deleting a project and everything it ever recorded.
 *
 * **This is the one thing in here that is not append-only, and it is a deliberate
 * exception rather than a hole.** The rule the rest of the store obeys — an
 * append and its projections land together, and nothing is ever rewritten —
 * exists so that a transcript can be rebuilt from the log after a crash, because
 * Codex discards partial output when a turn is interrupted. That guarantee is
 * about *the provider* losing data behind our back. It says nothing about the
 * person deciding they are finished with a project, which is the only way to
 * reach this function.
 *
 * So the invariant survives intact: the log is still append-only for every actor
 * that writes to it. What is added is a single destructive operation with one
 * caller, and it does not soften the rule because it does not rewrite anything —
 * a conversation is present and complete, or it is entirely absent.
 *
 * **There is no undo.** Nothing here is a soft delete, no tombstone is written
 * and no copy is kept, so re-adding the same folder afterwards produces a new
 * empty project rather than the old one. That is what the caller asked for.
 */

/**
 * The tables to clear, discovered rather than listed — and that is the point.
 *
 * A hardcoded list is exactly the failure `CLAUDE.md` records from the Phase 9
 * deletions: the next migration adds a conversation-scoped table, this file is
 * not one of the five a new event type makes you edit, and the rows leak
 * silently forever. Nothing would fail, which is what makes it expensive.
 *
 * So the schema is asked instead. Any table carrying a `conversation_id` column
 * belongs to a conversation by construction, and a future one is covered the day
 * it is created without anybody remembering this file exists.
 *
 * `projection_state` deliberately has no such column. It is global (`name` ->
 * `last_seq`) and must **not** be rewound: `events.seq` is `AUTOINCREMENT`, so a
 * sequence number is never reused and a projection that has consumed up to seq N
 * is still correct after older rows are deleted. Moving it back would replay the
 * log from a point whose events no longer exist.
 */
function conversationScopedTables(db: Database): readonly string[] {
  const tables = z
    .array(z.object({ name: z.string() }))
    .parse(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
    )
    .map((row) => row.name)

  return tables.filter((table) => {
    /*
     * `PRAGMA table_info` takes no bound parameters, so the name is
     * interpolated. It comes from `sqlite_master` in the same connection and
     * cannot be attacker-supplied, and it is quoted anyway — a table named
     * `"drop me"` is legal SQLite and would otherwise be a syntax error here
     * rather than anything worse.
     */
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all())
    return columns.some((column) => column.name === 'conversation_id')
  })
}

/** What a purge removed, for the log line that records it. */
export interface PurgedProject {
  readonly conversations: number
  readonly events: number
}

/**
 * Removes a project's conversations and every row any of them ever wrote.
 *
 * **The `projects` row is deliberately not touched here.** That row is the
 * registry's, and `ProjectStore.remove` is its own operation — the same
 * separation `ProjectStore`'s header argues for, where the log and the registry
 * answer different questions and share only a handle. The caller runs both
 * inside one transaction, which is where atomicity belongs: a half-purged
 * project is worse than either end of it. Leave the project row and its rooms
 * are gone from a project that still looks healthy; take the row without the
 * rooms and they become orphans whose `project_id` resolves to nothing, which no
 * screen lists and no query cleans up.
 *
 * Ordering within the deletes is not load-bearing — there are no foreign keys
 * between these tables, which is also exactly why every one has to be named.
 */
export function purgeProject(db: Database, projectId: string): PurgedProject {
  const scoped = conversationScopedTables(db)
  const owned = 'conversation_id IN (SELECT id FROM conversations WHERE project_id = @projectId)'

  const run = db.transaction((): PurgedProject => {
    /*
     * Both counted before the deletes, because afterwards there is nothing left
     * to count and these two numbers are the only remaining record that the work
     * ever existed.
     */
    const conversations = z
      .object({ n: z.number() })
      .parse(
        db
          .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id = @projectId')
          .get({ projectId })
      ).n
    const events = z
      .object({ n: z.number() })
      .parse(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${owned}`).get({ projectId })).n

    for (const table of scoped) {
      db.prepare(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE ${owned}`).run({ projectId })
    }
    db.prepare('DELETE FROM conversations WHERE project_id = @projectId').run({ projectId })

    return { conversations, events }
  })

  return run()
}
