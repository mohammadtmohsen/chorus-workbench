import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  WorkspaceSnapshot,
  type WorkspaceSnapshot as WorkspaceSnapshotType,
} from '../shared/workspace-layout.js'

/**
 * Which projects were open when the app last ran, and which conversations inside
 * each — the project-first replacement for `open-sessions.ts`.
 *
 * The difference is not the nesting, it is **what identifies a room**. The old
 * file gave every conversation its own `cwd` string, which made the directory a
 * property of the conversation: two rooms on one folder each carried their own
 * copy of the path, and nothing stopped them disagreeing. Phase 2's invariant is
 * the other way round — a Project owns the development environment, a
 * Conversation belongs to exactly one Project — so the path is recorded once, in
 * the project registry, and this file records only ids.
 *
 * **A conversation therefore cannot point somewhere its project does not.** Not
 * by rule, but because there is no field in which to say so.
 *
 * Still not derived from the event log, for the reason the old file gave: the log
 * says a session started and never ended, which after a crash is
 * indistinguishable from one that was open on purpose. This answers "what did the
 * person have on screen", it is a note to ourselves, and losing it costs a click.
 */

export const OpenConversation = z.object({
  conversationId: z.string(),
  agents: z.array(z.enum(['codex', 'claude'])),
  profileId: z.string(),
  title: z.string(),
  /**
   * Each agent's provider thread, so it can be resumed rather than restarted.
   *
   * A resumed agent still has its own reasoning; a restarted one has to be told
   * the conversation again. Keyed by agent because they resume independently and
   * one failing must not cost the other its context.
   */
  sessionRefs: z.record(z.string(), z.string()),
  /**
   * The last event this conversation's card had been caught up to. A watermark
   * rather than an unread *count*, so the number is derived and self-correcting.
   */
  lastSeenSeq: z.number().int().min(0).default(0),
  /**
   * A message typed and not sent — the one thing here that is the user's own
   * writing rather than a note about where they were, and the only part not
   * recoverable by clicking.
   */
  draft: z.string().default(''),
})
export type OpenConversation = z.infer<typeof OpenConversation>

export const OpenProject = z.object({
  /**
   * A `ProjectId` from the registry, never a path.
   *
   * The root is deliberately absent. Recording it here would create a second
   * copy of a fact the registry owns, and the two would part company the first
   * time a project was relocated — leaving a file that says a project is at a
   * directory it has moved away from, which is worse than saying nothing.
   */
  projectId: z.string(),
  conversations: z.array(OpenConversation),
})
export type OpenProject = z.infer<typeof OpenProject>

/**
 * Version 1, in a new file, and neither number is a mistake.
 *
 * `open-sessions.v2.json` reached version 2 and stops there. This is a different
 * document with a different shape, so it starts its own count rather than
 * pretending to be the next version of something it cannot parse.
 *
 * **There is no legacy reader**, and that is the clean-database decision applied
 * to the sidecar rather than an omission. A v1 entry carries a `cwd` and no
 * project id; adopting it would mean inventing a project per distinct path at
 * read time, which is a migration — the exact thing Phase 2 decided not to build.
 */
export const OpenProjectsFile = z.object({
  version: z.literal(1),
  projects: z.array(OpenProject),
  workspace: WorkspaceSnapshot.nullable(),
})

export interface OpenProjectsState {
  readonly projects: OpenProject[]
  readonly workspace: WorkspaceSnapshotType | null
}

const EMPTY: OpenProjectsState = { projects: [], workspace: null }

function path(userDataPath: string): string {
  return join(userDataPath, 'open-projects.json')
}

/** Anything unexpected means "nothing was open", which is always safe. */
export function parseOpenProjects(value: unknown): OpenProjectsState {
  const parsed = OpenProjectsFile.safeParse(value)
  return parsed.success
    ? { projects: parsed.data.projects, workspace: parsed.data.workspace }
    : EMPTY
}

export function readOpenProjects(userDataPath: string): OpenProjectsState {
  try {
    return parseOpenProjects(JSON.parse(readFileSync(path(userDataPath), 'utf8')))
  } catch {
    return EMPTY
  }
}

/** Temp file and rename, so a crash mid-write cannot destroy a valid list. */
export function writeOpenProjects(userDataPath: string, state: OpenProjectsState): void {
  try {
    mkdirSync(userDataPath, { recursive: true })
    const target = path(userDataPath)
    const temp = `${target}.tmp`
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, projects: state.projects, workspace: state.workspace }, null, 2)}\n`,
      'utf8'
    )
    renameSync(temp, target)
  } catch {
    // A note to ourselves is not worth failing a conversation over.
  }
}

/**
 * Every conversation across every open project, flattened.
 *
 * Restore walks conversations, not projects, and giving it this rather than a
 * nested loop keeps the project a conversation belongs to attached to it — which
 * is the field the old flat list had no way to carry.
 */
export function openConversations(
  state: OpenProjectsState
): readonly { readonly projectId: string; readonly conversation: OpenConversation }[] {
  return state.projects.flatMap((project) =>
    project.conversations.map((conversation) => ({ projectId: project.projectId, conversation }))
  )
}
