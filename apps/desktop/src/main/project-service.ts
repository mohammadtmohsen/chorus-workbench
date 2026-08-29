import { statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  DuplicateProjectRootError,
  UnknownProjectError,
  type Project,
  type ProjectStore,
} from '@chorus/event-store'
import { approveProjectRoot } from './workbench-surface.js'

/**
 * The durable set of projects the person has adopted — Phase 2's domain service,
 * and the answer to Phase 1's remaining E2 item.
 *
 * Phase 1 bounded the openable set with the native chooser: one dialog per root,
 * one capability per answer, dead when the document that asked is. That is a
 * sound authorisation and a poor product. It means every launch begins by
 * pointing at the same folders again, and it means a project **id** cannot be
 * turned into a root at all — which is why the second arm of `WorkbenchTarget`
 * has been failing closed since it was written.
 *
 * This is the table that resolves it. A grant remains the answer for a directory
 * being adopted for the first time; an id is the answer for one already adopted,
 * and `resolveRoot` is the only thing entitled to make that conversion.
 *
 * **The filesystem is asked here and nowhere below.** `ProjectStore` is a
 * database and stays one; every canonical path in it was resolved by this layer,
 * because main is the only layer allowed to look.
 */

/** Adopting a folder that is already a project is a redirect, not a failure. */
export interface AdoptResult {
  readonly project: Project
  /**
   * False when the folder was already adopted. The caller almost always wants to
   * open the existing project rather than report an error, but it should be able
   * to say "you already had this" rather than silently implying it made one.
   */
  readonly created: boolean
}

/**
 * A project whose directory is no longer there — an unmounted volume, a folder
 * renamed outside Chorus, a checkout deleted.
 *
 * Distinct from `UnknownProjectError`, and the distinction is the whole point:
 * one means the id is not ours, the other means the id is ours and the world
 * moved. The first is a bug or a forged request; the second is Tuesday, and the
 * product's answer to it is Relocate rather than an error dialog.
 */
export class ProjectRootMissingError extends Error {
  constructor(
    readonly projectId: string,
    readonly canonicalRoot: string
  ) {
    super(`The folder for this project is no longer there: ${canonicalRoot}`)
    this.name = 'ProjectRootMissingError'
  }
}

/**
 * Is that path a directory, right now.
 *
 * One implementation, used by both the refusal (`resolveRoot`) and the question
 * (`rootPresent`), because two of these drift and the symptom would be a rail
 * that shows a project as fine and a launch that says it is gone.
 *
 * Gone, unreadable, and on a volume that is not mounted are all the same answer
 * to every caller, so they are not distinguished. `statSync` rather than
 * `existsSync`: a *file* at the project's path is not a project root, and
 * `existsSync` would call it present and fail later inside the extension host.
 */
function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class ProjectService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly clock: () => number = Date.now
  ) {}

  /**
   * Takes a directory somebody chose and makes it a project, or hands back the
   * project that already holds it.
   *
   * `approveProjectRoot` is reused rather than reimplemented: absolute, canonical,
   * exists, and a directory rather than a file. Those four are already the rules
   * the workbench applies to a root, and a second implementation here would be a
   * second set of rules the moment either was edited.
   *
   * The lookup is by **canonical** root, so a folder reached through a symlink is
   * recognised as the project it already is. That is the case a lexical check
   * misses, and it is not hypothetical — `/var/folders/…` and
   * `/private/var/folders/…` are one directory on this machine.
   */
  adopt(proposed: string, name?: string): AdoptResult {
    const canonicalRoot = approveProjectRoot(proposed)

    const existing = this.projects.findByCanonicalRoot(canonicalRoot)
    if (existing !== null) {
      return { project: this.projects.touch(existing.id, this.clock()), created: false }
    }

    /*
     * The name defaults to the folder's own, taken from the canonical root rather
     * than from what was typed: a trailing slash would otherwise make `basename`
     * return the empty string, and the store would refuse a blank name with an
     * error about validation rather than about the path.
     */
    const trimmed = name?.trim() ?? ''
    const chosen = trimmed === '' ? basename(canonicalRoot) : trimmed

    try {
      return {
        project: this.projects.create({
          name: chosen,
          root: proposed,
          canonicalRoot,
          workspaceFile: null,
          now: this.clock(),
        }),
        created: true,
      }
    } catch (error) {
      /*
       * Lost a race with another adopt of the same folder. The store checks and
       * inserts in one transaction, so this is the losing side of two callers
       * arriving together — and the right answer is the one the winner created,
       * which is exactly what the error carries.
       */
      if (error instanceof DuplicateProjectRootError) {
        const winner = this.projects.get(error.existingProjectId)
        if (winner !== null) return { project: winner, created: false }
      }
      throw error
    }
  }

  /**
   * The project at a canonical root, or null.
   *
   * Takes a root that is **already canonical** — a workbench surface's
   * `projectRoot` came from `approveProjectRoot` when it was opened — so this
   * does not touch the filesystem and cannot fail on a directory that has since
   * moved. `adopt` is the wrong call for this: it would create a project for a
   * root nobody chose, which is exactly the silent adoption the registry exists
   * to prevent.
   */
  findByRoot(canonicalRoot: string): Project | null {
    return this.projects.findByCanonicalRoot(canonicalRoot)
  }

  list(): readonly Project[] {
    return this.projects.list()
  }

  get(projectId: string): Project | null {
    return this.projects.get(projectId)
  }

  /**
   * An id to a root, and the only path by which that conversion happens.
   *
   * This is what `redeem`'s `projectId` arm calls, and what an agent session
   * calls to find its cwd instead of carrying one of its own. Two refusals rather
   * than one, because they mean different things to whoever is asking:
   * an id nobody adopted is refused outright, and an adopted id whose folder has
   * gone is refused as a folder problem so the caller can offer to relocate it.
   *
   * The existence check is deliberate and is not redundant with `adopt`. A root
   * verified at adopt time says nothing about the same root a week later, and
   * handing a vanished directory to the remote extension host fails much further
   * in, with an error about a server rather than about a folder.
   */
  resolveRoot(projectId: string): string {
    const project = this.projects.get(projectId)
    if (project === null) throw new UnknownProjectError(projectId)
    if (!directoryExists(project.canonicalRoot)) {
      throw new ProjectRootMissingError(projectId, project.canonicalRoot)
    }
    return project.canonicalRoot
  }

  /**
   * The same question as `resolveRoot`'s check, asked instead of enforced.
   *
   * `resolveRoot` throws because every one of its callers is about to *use* the
   * directory, and handing back a path that is not there would fail later and
   * further away. Listing is the opposite case: the rail has to be able to draw
   * a project whose folder has gone — that is the only way a person finds out,
   * and it is the screen the fix is offered from — and an exception is not a UI
   * state.
   *
   * Both go through `directoryExists` so there is one answer to "is it there",
   * rather than a listing that disagrees with a launch.
   */
  rootPresent(projectId: string): boolean {
    const project = this.projects.get(projectId)
    return project !== null && directoryExists(project.canonicalRoot)
  }

  rename(projectId: string, name: string): Project {
    return this.projects.rename(projectId, name)
  }

  /**
   * Points a project at a different directory — the one explicit operation that
   * moves a root, because no conversation may move its own.
   *
   * **Stopping and restarting whatever is running against the old root is the
   * caller's job**, and it is not a detail: a workbench surface and an agent
   * session both hold the previous path, and neither notices a database write.
   * This function is the record of the decision, not the execution of it.
   */
  relocate(projectId: string, proposed: string): Project {
    return this.projects.relocate(projectId, {
      root: proposed,
      canonicalRoot: approveProjectRoot(proposed),
      workspaceFile: null,
    })
  }

  /**
   * Records what agents in this project may do.
   *
   * **The record, not the execution.** Conversations already running keep the
   * profile they were started under until something tells them otherwise, and
   * that something is `ChorusRuntime.setProjectProfile` — this service cannot
   * see a live conversation and must not pretend to have changed one. Same
   * division as `relocate`.
   */
  setProfile(projectId: string, profileId: string | null): Project {
    return this.projects.setProfile(projectId, profileId)
  }

  /** Records the project's cast, on the same terms as `setProfile`. */
  setAgents(projectId: string, agentIds: readonly string[] | null): Project {
    return this.projects.setAgents(projectId, agentIds)
  }

  /** Records an open, which is what the projects rail orders on. */
  opened(projectId: string): Project {
    return this.projects.touch(projectId, this.clock())
  }

  /**
   * Drops a project from the rail. Its conversations and their events stay in the
   * log — forgetting a project is not a claim that the work never happened.
   */
  forget(projectId: string): boolean {
    return this.projects.remove(projectId)
  }
}
