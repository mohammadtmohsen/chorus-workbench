import { newProjectId, type ProjectId } from '@chorus/shared'
import { z } from 'zod'
import type { Database } from './port.js'

/**
 * The Project, and why it is not in the event log.
 *
 * Phase 2's durable invariant is that a Project owns the development environment
 * and a Conversation belongs to exactly one Project. Conversation messages and
 * agent actions stay append-only, because their value is that they happened.
 * A project's name, root and last-opened time are none of those things — they
 * are current facts that get corrected, and replaying a rename from the log to
 * discover today's name would be ceremony over a single mutable row.
 *
 * So: `events` remains the log, and this is ordinary application state beside it
 * in the same database and the same transaction boundary.
 */
export interface Project {
  readonly id: ProjectId
  readonly name: string
  /**
   * The path as the person gave it — what a dialog returned, what the rail
   * shows. Kept separate from `canonicalRoot` so the UI can display the
   * directory somebody chose rather than the symlink target behind it.
   */
  readonly root: string
  /** The filesystem's own answer for `root`, symlinks resolved. */
  readonly canonicalRoot: string
  /** A `.code-workspace`, or null for a plain folder. */
  readonly workspaceFile: string | null
  readonly createdAt: number
  readonly lastOpenedAt: number
  /**
   * What agents in this project may do, for every conversation in it.
   *
   * A profile is an answer about a *place* — "agents may write in this
   * repository" — so it belongs to the directory rather than to whichever
   * conversation happened to be asked first. Null means the project has never
   * been asked and the caller's default applies; the store does not know what
   * that default is and must not invent one.
   */
  readonly profileId: string | null
  /**
   * The cast, and **null is not an empty cast**.
   *
   * Null is "never asked", which is every project that predates this column.
   * An empty array is a project somebody deliberately emptied. Collapsing the
   * two would silently re-add the default agents to the second one.
   */
  readonly agentIds: readonly string[] | null
}

/**
 * Whether two paths differing only in case are the same directory.
 *
 * **This is a property of the volume, not of the operating system**, and the
 * default below is a guess that is wrong on real machines: macOS ships
 * case-insensitive HFS+/APFS by default but case-sensitive APFS is a supported
 * choice, and a case-sensitive volume can be mounted anywhere on any platform.
 * Guessing from `process.platform` is therefore a heuristic, and it is exposed
 * as an option so the caller can replace it with something that actually asked
 * the filesystem.
 *
 * The failure it guards against is worth naming: fold when the volume is
 * case-sensitive and two genuinely different directories collide, so the second
 * Add Project silently opens the first. Do not fold when it is insensitive and
 * one directory can be added twice under different spellings, each with its own
 * id, workbench and conversations.
 */
export function platformCaseSensitivity(platform: string = process.platform): boolean {
  return platform !== 'darwin' && platform !== 'win32'
}

/**
 * The value uniqueness is enforced on.
 *
 * Trailing separators go first, because `/a/b` and `/a/b/` are one directory and
 * a dialog will return either. The root path itself is the exception — folding
 * `/` to the empty string would make every root collide with every other.
 */
export function canonicalKey(canonicalRoot: string, caseSensitive: boolean): string {
  const stripped = canonicalRoot.replace(/[/\\]+$/, '')
  const withoutTrailing = stripped === '' ? canonicalRoot.slice(0, 1) : stripped
  return caseSensitive ? withoutTrailing : withoutTrailing.toLowerCase()
}

/**
 * Thrown rather than returned, matching `EventStore`, and carrying the project
 * that already holds the directory.
 *
 * The id is on the error because the caller's next move is almost always to open
 * that project instead — "you already have this folder" is a redirect, not a
 * dead end, and making it one would force a second lookup to find out where to go.
 */
export class DuplicateProjectRootError extends Error {
  constructor(
    readonly canonicalRoot: string,
    readonly existingProjectId: ProjectId
  ) {
    super(`A project already exists for ${canonicalRoot}`)
    this.name = 'DuplicateProjectRootError'
  }
}

export class UnknownProjectError extends Error {
  constructor(readonly projectId: string) {
    super(`No project with id ${projectId}`)
    this.name = 'UnknownProjectError'
  }
}

/*
 * Validated because two of these fields are typed by a person and one comes from
 * a file dialog. `trim` on the name so a project called " " cannot exist and then
 * render as an empty row nobody can identify.
 */
const CreateProjectInput = z.object({
  name: z.string().trim().min(1),
  root: z.string().min(1),
  canonicalRoot: z.string().min(1),
  workspaceFile: z.string().min(1).nullable().default(null),
  now: z.number().int().nonnegative(),
})
export type CreateProjectInput = z.input<typeof CreateProjectInput>

const RelocateProjectInput = z.object({
  root: z.string().min(1),
  canonicalRoot: z.string().min(1),
  workspaceFile: z.string().min(1).nullable().default(null),
})
export type RelocateProjectInput = z.input<typeof RelocateProjectInput>

interface ProjectRow {
  id: string
  name: string
  root: string
  canonical_root: string
  workspace_file: string | null
  permission_profile_id: string | null
  agent_ids: string | null
  created_at: number
  last_opened_at: number
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    name: row.name,
    root: row.root,
    canonicalRoot: row.canonical_root,
    workspaceFile: row.workspace_file,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    profileId: row.permission_profile_id,
    agentIds: parseAgentIds(row.agent_ids),
  }
}

/**
 * A stored cast, or null — and a corrupt value reads as null rather than throwing.
 *
 * This column is written only by `setAgents`, so a malformed one means the file
 * was edited or a write was torn. Refusing to load the project over it would
 * make a bad string unrecoverable through the app; degrading to "never asked"
 * puts the default cast back and lets the person set it again.
 */
function parseAgentIds(raw: string | null): readonly string[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    // No assertion needed: `every` with a `typeof` test narrows the array through
    // its inferred type predicate, so `parsed` is already `string[]` here.
    return parsed.every((id) => typeof id === 'string') ? parsed : null
  } catch {
    return null
  }
}

const COLUMNS = `id, name, root, canonical_root, workspace_file, permission_profile_id, agent_ids, created_at, last_opened_at`

/**
 * The project registry — create, find, rename, relocate, forget.
 *
 * Deliberately not part of `EventStore`. They share a `Database` handle and can
 * share a transaction, but the log and the registry answer different questions,
 * and folding projects into the class whose invariant is "an append and its
 * projections land together" would put mutable state inside a guarantee that has
 * nothing to say about it.
 *
 * Nothing here touches the filesystem. `canonicalRoot` is supplied by the caller
 * — main resolves it, because main is the only layer allowed to ask.
 */
export class ProjectStore {
  private readonly caseSensitive: boolean

  constructor(
    private readonly db: Database,
    options: { readonly caseSensitivePaths?: boolean } = {}
  ) {
    this.caseSensitive = options.caseSensitivePaths ?? platformCaseSensitivity()
  }

  /** The key this store would enforce uniqueness on for a given canonical root. */
  keyFor(canonicalRoot: string): string {
    return canonicalKey(canonicalRoot, this.caseSensitive)
  }

  /**
   * Creates, or refuses because the directory is already a project.
   *
   * The lookup and the insert are one transaction. Without it, two Add Project
   * calls racing on the same folder both see nothing and the second fails on the
   * unique index with a driver-level message instead of the domain's own — and
   * `DuplicateProjectRootError` exists precisely so the caller can offer to open
   * the project that already exists.
   */
  create(input: CreateProjectInput): Project {
    const parsed = CreateProjectInput.parse(input)
    const key = this.keyFor(parsed.canonicalRoot)
    const id = newProjectId()

    const insert = this.db.transaction((): Project => {
      const clash = this.db
        .prepare(`SELECT id FROM projects WHERE canonical_key = @key`)
        .get({ key }) as { id: string } | undefined
      if (clash !== undefined) {
        throw new DuplicateProjectRootError(parsed.canonicalRoot, clash.id as ProjectId)
      }
      this.db
        .prepare(
          `INSERT INTO projects
             (id, name, root, canonical_root, canonical_key, workspace_file, created_at, last_opened_at)
           VALUES
             (@id, @name, @root, @canonicalRoot, @key, @workspaceFile, @now, @now)`
        )
        .run({
          id,
          name: parsed.name,
          root: parsed.root,
          canonicalRoot: parsed.canonicalRoot,
          key,
          workspaceFile: parsed.workspaceFile,
          now: parsed.now,
        })
      return {
        id,
        name: parsed.name,
        root: parsed.root,
        canonicalRoot: parsed.canonicalRoot,
        workspaceFile: parsed.workspaceFile,
        createdAt: parsed.now,
        lastOpenedAt: parsed.now,
        // Never asked yet. The caller supplies the default cast and profile at
        // the first conversation, and `setProfile`/`setAgents` record an answer.
        profileId: null,
        agentIds: null,
      }
    })

    return insert()
  }

  get(projectId: string): Project | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE id = @projectId`)
      .get({ projectId }) as ProjectRow | undefined
    return row === undefined ? null : toProject(row)
  }

  /**
   * The lookup Add Project makes before it creates anything, and the one that
   * makes "already open this folder" possible rather than a duplicate.
   */
  findByCanonicalRoot(canonicalRoot: string): Project | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM projects WHERE canonical_key = @key`)
      .get({ key: this.keyFor(canonicalRoot) }) as ProjectRow | undefined
    return row === undefined ? null : toProject(row)
  }

  /** Most recently opened first — the order the rail wants and the only one asked for. */
  list(): readonly Project[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM projects ORDER BY last_opened_at DESC, created_at DESC`)
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  rename(projectId: string, name: string): Project {
    const clean = z.string().trim().min(1).parse(name)
    const changed = this.db
      .prepare(`UPDATE projects SET name = @name WHERE id = @projectId`)
      .run({ name: clean, projectId }).changes
    if (changed === 0) throw new UnknownProjectError(projectId)
    return this.require(projectId)
  }

  /**
   * Moving a project to a different directory, which is one explicit operation
   * by design.
   *
   * A conversation cannot change its own cwd, so this is the only way a root ever
   * moves, and it moves for every conversation under the project at once. It can
   * still collide: the destination may already be somebody else's project, and
   * that is refused with the same error Add Project raises.
   *
   * **Stopping and restarting the workbench and agent processes is the caller's
   * job.** This function changes a row. Anything already running against the old
   * root keeps running against the old root until something restarts it, and a
   * store that pretended otherwise would be lying about what a database write can do.
   */
  relocate(projectId: string, input: RelocateProjectInput): Project {
    const parsed = RelocateProjectInput.parse(input)
    const key = this.keyFor(parsed.canonicalRoot)

    const move = this.db.transaction((): void => {
      const existing = this.db
        .prepare(`SELECT id FROM projects WHERE id = @projectId`)
        .get({ projectId }) as { id: string } | undefined
      if (existing === undefined) throw new UnknownProjectError(projectId)

      const clash = this.db
        .prepare(`SELECT id FROM projects WHERE canonical_key = @key AND id <> @projectId`)
        .get({ key, projectId }) as { id: string } | undefined
      if (clash !== undefined) {
        throw new DuplicateProjectRootError(parsed.canonicalRoot, clash.id as ProjectId)
      }

      this.db
        .prepare(
          `UPDATE projects
              SET root = @root,
                  canonical_root = @canonicalRoot,
                  canonical_key = @key,
                  workspace_file = @workspaceFile
            WHERE id = @projectId`
        )
        .run({
          root: parsed.root,
          canonicalRoot: parsed.canonicalRoot,
          key,
          workspaceFile: parsed.workspaceFile,
          projectId,
        })
    })

    move()
    return this.require(projectId)
  }

  /**
   * Records the project's permission profile.
   *
   * **The store does not validate the id.** Which profiles exist is the policy
   * engine's question and it lives in `@chorus/orchestrator`; a check here would
   * be a second copy of that list, drifting. What it does guarantee is that the
   * project exists — writing a profile for a project nobody adopted is a caller
   * bug, and a silent no-op is how that bug reaches a person as "the setting
   * will not stick".
   */
  setProfile(projectId: string, profileId: string | null): Project {
    const changed = this.db
      .prepare(`UPDATE projects SET permission_profile_id = @profileId WHERE id = @projectId`)
      .run({ profileId, projectId }).changes
    if (changed === 0) throw new UnknownProjectError(projectId)
    return this.require(projectId)
  }

  /**
   * Records the project's cast.
   *
   * Duplicates are folded and order is preserved, because this is a set the UI
   * renders as a list. Passing null clears the answer back to "never asked",
   * which is not the same as passing `[]` — see `Project.agentIds`.
   */
  setAgents(projectId: string, agentIds: readonly string[] | null): Project {
    const value = agentIds === null ? null : JSON.stringify([...new Set(agentIds)])
    const changed = this.db
      .prepare(`UPDATE projects SET agent_ids = @value WHERE id = @projectId`)
      .run({ value, projectId }).changes
    if (changed === 0) throw new UnknownProjectError(projectId)
    return this.require(projectId)
  }

  /** Records that a project was opened, which is what the rail orders on. */
  touch(projectId: string, now: number): Project {
    const changed = this.db
      .prepare(`UPDATE projects SET last_opened_at = @now WHERE id = @projectId`)
      .run({ now, projectId }).changes
    if (changed === 0) throw new UnknownProjectError(projectId)
    return this.require(projectId)
  }

  /**
   * Forgets a project. **Its conversations and their events are left alone** —
   * they are in the append-only log, and removing a project from the rail is not
   * a claim that the work never happened. Reclaiming them is a separate decision
   * nobody has asked for yet.
   */
  remove(projectId: string): boolean {
    return (
      this.db.prepare(`DELETE FROM projects WHERE id = @projectId`).run({ projectId }).changes > 0
    )
  }

  private require(projectId: string): Project {
    const project = this.get(projectId)
    if (project === null) throw new UnknownProjectError(projectId)
    return project
  }
}
