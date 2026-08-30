import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, ProjectStore, UnknownProjectError, openSqlite } from '@chorus/event-store'
import { beforeEach, describe, expect, it } from 'vitest'
import { ProjectRootMissingError, ProjectService } from './project-service.js'

/*
 * Real directories, not a mocked filesystem, and the reason is the bug this
 * layer exists to avoid. macOS puts every temp directory under `/var`, which is
 * a symlink to `/private/var` — so a fake `statSync` would make the canonical
 * path tests pass while proving nothing about the case they were written for.
 */
const scratch = mkdtempSync(join(tmpdir(), 'chorus-project-service-'))

let service: ProjectService
let clock: number

const dir = (name: string): string => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

beforeEach(() => {
  const db = openSqlite({ path: ':memory:' })
  migrate(db)
  clock = 1_000
  service = new ProjectService(new ProjectStore(db, { caseSensitivePaths: true }), db, () => clock)
})

describe('adopt', () => {
  it('names a project after its folder', () => {
    const { project, created } = service.adopt(dir('alpha'))
    expect(created).toBe(true)
    expect(project.name).toBe('alpha')
  })

  it('takes an explicit name over the folder name', () => {
    expect(service.adopt(dir('beta'), '  My Thing  ').project.name).toBe('My Thing')
  })

  it('falls back to the folder name when the given one is blank', () => {
    expect(service.adopt(dir('gamma'), '   ').project.name).toBe('gamma')
  })

  it('stores the canonical root, not the path it was reached by', () => {
    const real = dir('real')
    const link = join(scratch, 'link-to-real')
    symlinkSync(real, link)

    const { project } = service.adopt(link)
    expect(project.root).toBe(link)
    // The symlink is not the canonical root, and on macOS neither is `/var/...`.
    expect(project.canonicalRoot).not.toBe(link)
    expect(project.canonicalRoot.endsWith('real')).toBe(true)
  })

  /*
   * The case a lexical comparison misses, and the one that would give a person
   * two projects, two workbenches and two sets of conversations for one folder.
   */
  it('recognises a folder already adopted under another name', () => {
    const real = dir('shared')
    const link = join(scratch, 'link-to-shared')
    symlinkSync(real, link)

    const first = service.adopt(real)
    const second = service.adopt(link)

    expect(second.created).toBe(false)
    expect(second.project.id).toBe(first.project.id)
    expect(service.list()).toHaveLength(1)
  })

  it('records an open when it hands back an existing project', () => {
    const path = dir('touched')
    const first = service.adopt(path)
    clock = 9_000
    expect(service.adopt(path).project.lastOpenedAt).toBe(9_000)
    expect(first.project.lastOpenedAt).toBe(1_000)
  })

  it('refuses a path that is not there', () => {
    expect(() => service.adopt(join(scratch, 'nothing-here'))).toThrow(/No such workbench project/)
  })

  it('refuses a file', () => {
    const file = join(scratch, 'a-file.txt')
    writeFileSync(file, 'x')
    expect(() => service.adopt(file)).toThrow(/must be a directory/)
  })

  it('refuses a relative path', () => {
    expect(() => service.adopt('relative/path')).toThrow(/absolute/)
  })
})

describe('resolveRoot', () => {
  it('turns an adopted id into its canonical root', () => {
    const { project } = service.adopt(dir('resolvable'))
    expect(service.resolveRoot(project.id)).toBe(project.canonicalRoot)
  })

  /*
   * Phase 1's E2 requirement, stated there as "a test that an id nobody adopted
   * is refused". The second arm of WorkbenchTarget resolves against this, so an
   * id that resolves to anything at all is a directory somebody was handed
   * without a dialog.
   */
  it('refuses an id nobody adopted', () => {
    expect(() => service.resolveRoot('not-a-project')).toThrow(UnknownProjectError)
  })

  it('refuses an adopted id whose folder has gone, and says which folder', () => {
    const path = dir('vanishing')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })

    let thrown: unknown
    try {
      service.resolveRoot(project.id)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProjectRootMissingError)
    expect((thrown as ProjectRootMissingError).canonicalRoot).toBe(project.canonicalRoot)
  })

  /*
   * The two refusals must stay distinguishable. A caller offers Relocate for one
   * and nothing at all for the other, so collapsing them into a single error
   * would make a moved folder look like a forged id.
   */
  it('distinguishes a missing folder from an unknown id', () => {
    const path = dir('distinct')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })

    expect(() => service.resolveRoot(project.id)).not.toThrow(UnknownProjectError)
    expect(() => service.resolveRoot('never-adopted')).not.toThrow(ProjectRootMissingError)
  })
})

/*
 * The same question `resolveRoot` enforces, asked without an exception — the
 * listing needs it, because a project whose folder has gone still has to be
 * drawn. Until it existed the renderer found out by failing, and on launch the
 * thing that failed was the auto-start, which replaced the whole app with an
 * error screen offering no way back to the project it was complaining about.
 */
describe('rootPresent', () => {
  it('is true while the folder is there', () => {
    const { project } = service.adopt(dir('still-here'))
    expect(service.rootPresent(project.id)).toBe(true)
  })

  it('is false once the folder has gone, and does not throw', () => {
    const path = dir('went-away')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })

    expect(service.rootPresent(project.id)).toBe(false)
    // The whole point: the listing must not need a try/catch around each row.
    expect(() => service.rootPresent(project.id)).not.toThrow()
  })

  it('is false for an id nobody adopted, rather than throwing', () => {
    expect(service.rootPresent('not-a-project')).toBe(false)
  })

  it('agrees with resolveRoot, so a listing cannot contradict a launch', () => {
    const path = dir('agreeing')
    const { project } = service.adopt(path)
    expect(service.rootPresent(project.id)).toBe(true)
    expect(() => service.resolveRoot(project.id)).not.toThrow()

    rmSync(path, { recursive: true, force: true })
    expect(service.rootPresent(project.id)).toBe(false)
    expect(() => service.resolveRoot(project.id)).toThrow(ProjectRootMissingError)
  })

  /*
   * A file where a directory should be. `existsSync` would call this present and
   * the failure would surface much later, inside the extension host, as an error
   * about a server rather than about a folder.
   */
  it('is false for a path that exists but is not a directory', () => {
    const path = dir('becomes-a-file')
    const { project } = service.adopt(path)
    rmSync(path, { recursive: true, force: true })
    writeFileSync(path, 'not a directory')

    expect(service.rootPresent(project.id)).toBe(false)
  })
})

describe('relocate', () => {
  it('moves a project to a directory that exists', () => {
    const { project } = service.adopt(dir('before-move'))
    const destination = dir('after-move')

    const moved = service.relocate(project.id, destination)
    expect(moved.root).toBe(destination)
    expect(service.resolveRoot(project.id)).toBe(moved.canonicalRoot)
  })

  it('refuses to relocate onto a path that is not there', () => {
    const { project } = service.adopt(dir('stays-put'))
    expect(() => service.relocate(project.id, join(scratch, 'no-such-dir'))).toThrow(
      /No such workbench project/
    )
    expect(service.get(project.id)?.root).toBe(join(scratch, 'stays-put'))
  })
})

describe('the rest of the registry', () => {
  it('renames', () => {
    const { project } = service.adopt(dir('to-rename'))
    expect(service.rename(project.id, 'Renamed').name).toBe('Renamed')
  })

  it('forgets, and reports whether there was anything to forget', () => {
    const { project } = service.adopt(dir('to-forget'))
    expect(service.forget(project.id)).toBe(true)
    expect(service.get(project.id)).toBeNull()
    expect(service.forget(project.id)).toBe(false)
  })

  /*
   * This asserted recency ordering until the rail became arrangeable. `opened` is
   * still the interesting half: it still records the open, and the regression to
   * guard is that recording it stops moving the tile.
   */
  it('keeps the arrangement when a project is opened', () => {
    const first = service.adopt(dir('one')).project
    clock = 2_000
    const second = service.adopt(dir('two')).project
    expect(service.list().map((p) => p.id)).toEqual([first.id, second.id])

    clock = 3_000
    service.opened(first.id)
    expect(service.list().map((p) => p.id)).toEqual([first.id, second.id])
  })

  it('swaps two projects and answers with the new order', () => {
    const first = service.adopt(dir('one')).project
    clock = 2_000
    const second = service.adopt(dir('two')).project

    expect(service.swapOrder(first.id, second.id).map((p) => p.id)).toEqual([second.id, first.id])
    expect(service.list().map((p) => p.id)).toEqual([second.id, first.id])
  })
})
