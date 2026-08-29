import type { Database } from './port.js'

/**
 * Numbered, forward-only, run inside a transaction at startup.
 *
 * Adding a migration means appending to this array. Never edit a shipped one —
 * a database that already applied version N will not re-run it.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: string
}

/**
 * The second migration this database has ever had, and the first to run against
 * one holding real data.
 *
 * Three nullable columns and nothing else. Nullable is the whole design: every
 * `conversation.created` ever appended lacks these fields, and a rebuild has to
 * produce the same rows it always did for them. `kind IS NULL` therefore means
 * "an ordinary conversation", which is what every existing row is.
 *
 * No index. Asides are read by `parent_id`, but a user has tens of
 * conversations and a handful of asides each; an index here would be ceremony,
 * and `PRAGMA user_version` moving is the risk worth minimising.
 */
const ASIDE_COLUMNS = `
  ALTER TABLE conversations ADD COLUMN kind            TEXT;
  ALTER TABLE conversations ADD COLUMN parent_id       TEXT;
  ALTER TABLE conversations ADD COLUMN source_event_id TEXT;
`

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      -- The append-only log. Everything else in this file is a projection that
      -- can be dropped and rebuilt from these rows.
      CREATE TABLE events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT    NOT NULL UNIQUE,
        conversation_id TEXT    NOT NULL,
        actor           TEXT    NOT NULL,
        type            TEXT    NOT NULL,
        payload         TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        schema_ver      INTEGER NOT NULL
      );
      CREATE INDEX events_conv_seq ON events (conversation_id, seq);
      CREATE INDEX events_type ON events (type);

      CREATE TABLE projects (
        id                    TEXT PRIMARY KEY,
        root_path             TEXT NOT NULL,
        name                  TEXT NOT NULL,
        permission_profile_id TEXT,
        created_at            INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- One row per message. Agent messages are built up from delta events, so
      -- content grows and status moves streaming -> complete.
      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        seq             INTEGER NOT NULL,
        actor           TEXT    NOT NULL,
        -- Always set. For agent messages it is the provider's streaming item id,
        -- which is how a run of deltas is stitched into one row; for user
        -- messages it is the originating event id, so the index stays simple.
        item_ref        TEXT    NOT NULL,
        content         TEXT    NOT NULL DEFAULT '',
        status          TEXT    NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX messages_conv_seq ON messages (conversation_id, seq);
      CREATE UNIQUE INDEX messages_item_ref ON messages (conversation_id, item_ref);

      CREATE TABLE agent_sessions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT    NOT NULL,
        session_ref     TEXT    NOT NULL,
        cwd             TEXT    NOT NULL,
        model           TEXT,
        cli_version     TEXT,
        status          TEXT    NOT NULL,
        started_at      INTEGER NOT NULL
      );
      CREATE INDEX agent_sessions_conv ON agent_sessions (conversation_id);

      CREATE TABLE approvals (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT,
        kind            TEXT    NOT NULL,
        request         TEXT    NOT NULL,
        outcome         TEXT,
        scope           TEXT,
        decided_by      TEXT,
        decided_at      INTEGER,
        policy_rule_id  TEXT,
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX approvals_conv ON approvals (conversation_id);

      CREATE TABLE handoffs (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT    NOT NULL,
        from_agent       TEXT    NOT NULL,
        to_agent         TEXT    NOT NULL,
        brief            TEXT    NOT NULL,
        source_event_ids TEXT    NOT NULL,
        created_at       INTEGER NOT NULL
      );

      -- Lets us detect a projection that has drifted from the log, and is the
      -- resume point for an incremental rebuild.
      CREATE TABLE projection_state (
        name     TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'aside-conversations',
    up: ASIDE_COLUMNS,
  },
  {
    version: 3,
    name: 'pending-questions',
    /*
     * The one piece of transcript state a paged read cannot get from anywhere
     * else.
     *
     * A page is a suffix of the log, so anything derived by *accumulation*
     * cannot be rebuilt from it — an agent can ask a question thousands of
     * events before the page the reader opens on. Approvals already had this
     * problem and already had a table; questions had neither, and folding the
     * whole conversation to find them is the cost this phase exists to remove.
     *
     * Shaped like `approvals` deliberately: requested, then answered or expired,
     * with the answer's absence being what "pending" means. `answered_at IS
     * NULL` is the query.
     */
    up: `
      CREATE TABLE questions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT,
        event_id        TEXT    NOT NULL,
        request         TEXT    NOT NULL,
        answered_at     INTEGER,
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX questions_conv ON questions (conversation_id);

      /*
       * Backfilled from the log, and the table is wrong without this.
       *
       * A new projection starts empty, and nothing rebuilds projections on
       * startup -- EventStore.open runs migrate() and returns. So an upgraded
       * database would have had a questions table containing nothing, and since
       * the paged transcript reads pending questions from HERE rather than by
       * folding the log, every question an agent was already waiting on would
       * have disappeared: no card, no error, and a fresh test database passing
       * every test. Found in review, not by running it.
       *
       * Done in SQL inside the migration's own transaction rather than by
       * calling rebuildProjections() afterwards. Rebuilding replays every event
       * into every projection -- 247,800 of them on the author's database -- to
       * populate one table, and it would run outside the transaction that
       * created it, so a failure would leave the schema migrated and the table
       * empty.
       *
       * The events_type index makes both scans indexed. COALESCE on request
       * because the column is NOT NULL and json_extract yields NULL for a
       * payload that recorded no request; 'null' is what the live projection
       * writes for the same case.
       *
       * NB: no backticks anywhere in this comment. It lives inside a template
       * literal, and one would end the string -- which is the trap CLAUDE.md
       * records for exactly this file, and it still caught me.
       */
      INSERT INTO questions
        (id, conversation_id, agent_id, event_id, request, answered_at, expires_at, created_at)
      SELECT
        json_extract(q.payload, '$.userInputId'),
        q.conversation_id,
        q.actor,
        q.id,
        COALESCE(json_extract(q.payload, '$.request'), 'null'),
        (SELECT MAX(a.created_at) FROM events a
          WHERE a.type = 'userinput.answered'
            AND json_extract(a.payload, '$.userInputId')
                = json_extract(q.payload, '$.userInputId')),
        COALESCE(json_extract(q.payload, '$.expiresAt'), 0),
        q.created_at
      FROM events q
      WHERE q.type = 'userinput.requested'
        AND json_extract(q.payload, '$.userInputId') IS NOT NULL
      ON CONFLICT (id) DO NOTHING;

      /*
       * The high-water mark for the projection this migration just created.
       *
       * projectionDrift() compares every name in PROJECTION_NAMES against the
       * log's last seq and reports the ones behind. A backfilled table with no
       * projection_state row reads as sequence 0 -- so the drift check would
       * have reported questions as 249,099 events behind on a database where it
       * was in fact completely up to date, until the next append happened to
       * bump every projection at once and the symptom vanished on its own.
       *
       * COALESCE because MAX over an empty events table is NULL, and a fresh
       * database installs this migration with nothing in it.
       *
       * The backfill above reads the whole log, so the whole log is exactly what
       * this projection has seen.
       */
      INSERT INTO projection_state (name, last_seq)
      SELECT 'questions', COALESCE((SELECT MAX(seq) FROM events), 0)
      ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq;
    `,
  },
  {
    version: 4,
    name: 'project-as-domain',
    /*
     * Phase 2's Project, and the table is **recreated rather than altered**.
     *
     * `projects` has existed since migration 1 and has never been written: there
     * is no INSERT, UPDATE or SELECT against it anywhere in this repository, and
     * it is not in PROJECTION_NAMES, so nothing rebuilds it either. It was a
     * placeholder for the domain this migration finally supplies.
     *
     * That is what makes DROP the honest option rather than the destructive one.
     * `canonical_root` cannot be derived in SQL — resolving a path means asking
     * the filesystem, and copying `root_path` into it would record a value that
     * nobody resolved and that every uniqueness check downstream would then
     * trust. ALTER TABLE also cannot add a NOT NULL column to an existing table
     * without a default, so altering would leave the two columns the domain most
     * depends on permanently nullable to preserve rows that do not exist.
     *
     * If a row somehow did exist, `migrate()` snapshots the database before any
     * upgrade from a non-zero version, so this is recoverable rather than final.
     *
     * `permission_profile_id` is carried across although the Phase 2 domain does
     * not name it. Nothing reads it, it costs one nullable column, and dropping a
     * field this change was not asked to remove is the more expensive mistake.
     */
    up: `
      DROP TABLE projects;

      CREATE TABLE projects (
        id                    TEXT    PRIMARY KEY,
        name                  TEXT    NOT NULL,
        root                  TEXT    NOT NULL,
        -- The filesystem's own answer for 'root', symlinks resolved. Supplied by
        -- the caller because only main can ask; this package never touches disk.
        canonical_root        TEXT    NOT NULL,
        -- What uniqueness is actually enforced on: canonical_root folded for a
        -- case-insensitive filesystem, or identical to it on a case-sensitive
        -- one. Stored rather than computed in the index because the fold is a
        -- property of the volume the project lives on, which SQL cannot know.
        canonical_key         TEXT    NOT NULL,
        workspace_file        TEXT,
        permission_profile_id TEXT,
        created_at            INTEGER NOT NULL,
        last_opened_at        INTEGER NOT NULL
      );

      -- The invariant the domain rests on: one project per real directory. A
      -- second Add Project on the same folder must find the first, not shadow it.
      CREATE UNIQUE INDEX projects_canonical_key ON projects (canonical_key);
      -- The rail's order, and the only ordering anything asks for.
      CREATE INDEX projects_last_opened ON projects (last_opened_at DESC);
    `,
  },
  {
    version: 5,
    name: 'project-owns-its-settings',
    /*
     * The permission profile and the cast move up to the Project.
     *
     * They were per-conversation, which put the same three questions in front of
     * a person once per conversation and let two conversations in one directory
     * disagree about what may be run there. A profile is an answer about a
     * *place* — "agents may write in this repository" — and it was only ever
     * conversation-scoped because the conversation was the top-level thing.
     *
     * `permission_profile_id` already exists: migration 4 carried it across
     * without a reader, on the argument that dropping a field it was not asked
     * to remove was the more expensive mistake. This is the migration that
     * proves that call, and it needs no DDL for that column at all.
     *
     * `agent_ids` is a JSON array and **nullable on purpose**. Null is not an
     * empty cast; it is "this project has never been asked", which is what every
     * row migrated from before this change is. The distinction matters because
     * an empty array is a legitimate answer — a project with no agents in it —
     * and collapsing the two would silently re-add the default cast to a project
     * somebody had deliberately emptied.
     *
     * ALTER rather than a recreate, unlike migration 4: this table now holds
     * real rows that nothing can reconstruct, and the column is nullable, which
     * is the one shape ALTER TABLE ADD COLUMN accepts without a default.
     */
    up: `
      ALTER TABLE projects ADD COLUMN agent_ids TEXT;
    `,
  },
]

export interface MigrationResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
  readonly backedUpTo: string | null
}

export function currentVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get()
  const parsed = row as { user_version?: number } | undefined
  return parsed?.user_version ?? 0
}

/**
 * `backup` is injected rather than called directly because it is the one async
 * method on better-sqlite3 (S4) and the port is otherwise synchronous. Callers
 * that can snapshot pass one in; tests and in-memory databases pass nothing.
 */
export function migrate(
  db: Database,
  onBeforeMigrate?: (from: number) => string | null
): MigrationResult {
  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from)

  if (pending.length === 0) {
    return { from, to: from, applied: [], backedUpTo: null }
  }

  // Snapshot before touching a database that already holds data. A failed
  // migration on an empty database costs nothing; on a real one it costs
  // everything.
  const backedUpTo = from > 0 ? (onBeforeMigrate?.(from) ?? null) : null

  const run = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.up)
      db.exec(`PRAGMA user_version = ${String(m.version)}`)
    }
  })
  run()

  const to = pending.at(-1)?.version ?? from
  return { from, to, applied: pending.map((m) => m.name), backedUpTo }
}
