import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './migrations.js'
import {
  canonicalKey,
  DuplicateProjectRootError,
  platformCaseSensitivity,
  ProjectStore,
  UnknownProjectError,
} from './projects.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'

let db: SqliteHandle

/*
 * Case sensitivity is pinned in every test rather than inherited from whatever
 * machine is running them. A suite that reads `process.platform` passes on macOS
 * and fails on the Linux CI runner for a reason that has nothing to do with the
 * change under test, and both behaviours are ones this store must support — so
 * both are exercised explicitly instead.
 */
const sensitive = (): ProjectStore => new ProjectStore(db, { caseSensitivePaths: true })
const insensitive = (): ProjectStore => new ProjectStore(db, { caseSensitivePaths: false })

const add = (
  store: ProjectStore,
  root: string,
  name = 'Project',
  now = 1_000
): ReturnType<ProjectStore['create']> =>
  store.create({ name, root, canonicalRoot: root, workspaceFile: null, now })

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  migrate(db)
})

describe('canonicalKey', () => {
  it('treats a trailing separator as the same directory', () => {
    expect(canonicalKey('/a/b/', true)).toBe(canonicalKey('/a/b', true))
  })

  it('does not fold the filesystem root away', () => {
    expect(canonicalKey('/', true)).toBe('/')
  })

  it('folds case only when the volume is case-insensitive', () => {
    expect(canonicalKey('/A/B', false)).toBe('/a/b')
    expect(canonicalKey('/A/B', true)).toBe('/A/B')
  })
})

describe('platformCaseSensitivity', () => {
  it('guesses insensitive for macOS and Windows, sensitive elsewhere', () => {
    expect(platformCaseSensitivity('darwin')).toBe(false)
    expect(platformCaseSensitivity('win32')).toBe(false)
    expect(platformCaseSensitivity('linux')).toBe(true)
  })
})

describe('create', () => {
  it('round-trips a project and stamps both times from one clock', () => {
    const project = sensitive().create({
      name: 'Chorus',
      root: '/code/chorus',
      canonicalRoot: '/code/chorus',
      workspaceFile: null,
      now: 5_000,
    })
    expect(project).toMatchObject({
      name: 'Chorus',
      root: '/code/chorus',
      canonicalRoot: '/code/chorus',
      workspaceFile: null,
      createdAt: 5_000,
      lastOpenedAt: 5_000,
    })
    expect(sensitive().get(project.id)).toEqual(project)
  })

  it('keeps the given root and the canonical root apart', () => {
    const store = sensitive()
    const project = store.create({
      name: 'Linked',
      root: '/Users/me/shortcut',
      canonicalRoot: '/Volumes/disk/real',
      workspaceFile: null,
      now: 1,
    })
    expect(project.root).toBe('/Users/me/shortcut')
    expect(project.canonicalRoot).toBe('/Volumes/disk/real')
    // Uniqueness follows the real directory, not the name somebody reached it by.
    expect(store.findByCanonicalRoot('/Volumes/disk/real')?.id).toBe(project.id)
  })

  it('refuses a directory that is already a project, and names the one that holds it', () => {
    const store = sensitive()
    const first = add(store, '/code/chorus')
    let thrown: unknown
    try {
      add(store, '/code/chorus', 'Second')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DuplicateProjectRootError)
    expect((thrown as DuplicateProjectRootError).existingProjectId).toBe(first.id)
    expect(store.list()).toHaveLength(1)
  })

  it('treats a trailing separator as the same directory', () => {
    const store = sensitive()
    add(store, '/code/chorus')
    expect(() => add(store, '/code/chorus/')).toThrow(DuplicateProjectRootError)
  })

  /*
   * The pair that proves the option does something. Same two paths, opposite
   * answers — without both, a store hardcoded to either behaviour passes.
   */
  it('collides on case when the volume is case-insensitive', () => {
    const store = insensitive()
    add(store, '/Code/Chorus')
    expect(() => add(store, '/code/chorus')).toThrow(DuplicateProjectRootError)
  })

  it('allows both spellings when the volume is case-sensitive', () => {
    const store = sensitive()
    add(store, '/Code/Chorus')
    add(store, '/code/chorus', 'Other')
    expect(store.list()).toHaveLength(2)
  })

  it('rejects a blank name rather than storing an unidentifiable row', () => {
    expect(() => add(sensitive(), '/code/chorus', '   ')).toThrow()
  })

  it('trims the name it stores', () => {
    expect(add(sensitive(), '/code/chorus', '  Chorus  ').name).toBe('Chorus')
  })
})

describe('list', () => {
  /*
   * This asserted the opposite until the rail became arrangeable: the order was
   * `last_opened_at DESC`, so opening a project moved its tile. Both halves are
   * kept as one test because the pair is the actual rule — new projects go to the
   * end, and using one does not move it. Dropping the `touch` half would leave
   * the regression that matters untested, since recency re-sorting is precisely
   * what an arrangement has to survive.
   */
  it('keeps the arrangement, and opening a project does not disturb it', () => {
    const store = sensitive()
    const first = add(store, '/a', 'A', 1_000)
    const second = add(store, '/b', 'B', 2_000)
    expect(store.list().map((p) => p.id)).toEqual([first.id, second.id])

    store.touch(first.id, 3_000)
    expect(store.list().map((p) => p.id)).toEqual([first.id, second.id])
  })

  it('appends a new project rather than putting it on top', () => {
    const store = sensitive()
    const first = add(store, '/a', 'A', 1_000)
    const second = add(store, '/b', 'B', 2_000)
    const third = add(store, '/c', 'C', 3_000)
    expect(store.list().map((p) => p.id)).toEqual([first.id, second.id, third.id])
  })
})

describe('moveOrder', () => {
  /*
   * The swap this replaced could not express it: dragging the last tile onto the
   * first exchanged the two and left everything between untouched, so one
   * gesture made two moves.
   */
  it('inserts before the named neighbour and shifts everything between', () => {
    const store = sensitive()
    const a = add(store, '/a', 'A', 1_000)
    const b = add(store, '/b', 'B', 2_000)
    const c = add(store, '/c', 'C', 3_000)

    store.moveOrder(c.id, a.id)
    expect(store.list().map((p) => p.id)).toEqual([c.id, a.id, b.id])
  })

  it('sends a project to the end when no neighbour is named', () => {
    const store = sensitive()
    const a = add(store, '/a', 'A', 1_000)
    const b = add(store, '/b', 'B', 2_000)
    const c = add(store, '/c', 'C', 3_000)

    store.moveOrder(a.id, null)
    expect(store.list().map((p) => p.id)).toEqual([b.id, c.id, a.id])
  })

  it('survives being moved back', () => {
    const store = sensitive()
    const a = add(store, '/a', 'A', 1_000)
    const b = add(store, '/b', 'B', 2_000)

    store.moveOrder(a.id, null)
    store.moveOrder(a.id, b.id)
    expect(store.list().map((p) => p.id)).toEqual([a.id, b.id])
  })

  /*
   * Renumbered whole, so the column always reads 0..n-1. A gap left behind would
   * be a value a later reader has to interpret, and the tie-break this column
   * exists to replace is what would interpret it.
   */
  it('leaves the order dense, with no gaps for a tie-break to fill', () => {
    const store = sensitive()
    const a = add(store, '/a', 'A', 1_000)
    add(store, '/b', 'B', 2_000)
    add(store, '/c', 'C', 3_000)

    store.moveOrder(a.id, null)
    expect(store.list().map((p) => p.sortOrder)).toEqual([0, 1, 2])
  })

  /*
   * A no-op rather than a write, which is the shape that would collapse a tile
   * onto its own position and hand the order back to the tie-breaker.
   */
  it('does nothing when a project is moved before itself', () => {
    const store = sensitive()
    const a = add(store, '/a', 'A', 1_000)
    const b = add(store, '/b', 'B', 2_000)

    store.moveOrder(a.id, a.id)
    expect(store.list().map((p) => p.id)).toEqual([a.id, b.id])
  })

  it('refuses an id nobody adopted, and moves nothing', () => {
    const store = sensitive()
    const a = add(store, '/a', 'A', 1_000)
    const b = add(store, '/b', 'B', 2_000)

    expect(() => {
      store.moveOrder(a.id, 'nope')
    }).toThrow(UnknownProjectError)
    expect(() => {
      store.moveOrder('nope', a.id)
    }).toThrow(UnknownProjectError)
    expect(store.list().map((p) => p.id)).toEqual([a.id, b.id])
  })
})

describe('rename', () => {
  it('changes the name and nothing else', () => {
    const store = sensitive()
    const before = add(store, '/code/chorus')
    const after = store.rename(before.id, 'Renamed')
    expect(after).toEqual({ ...before, name: 'Renamed' })
  })

  it('refuses an id nobody adopted', () => {
    expect(() => sensitive().rename('nope', 'X')).toThrow(UnknownProjectError)
  })
})

describe('relocate', () => {
  it('moves the root and the canonical root together', () => {
    const store = sensitive()
    const project = add(store, '/old')
    const moved = store.relocate(project.id, {
      root: '/new',
      canonicalRoot: '/new',
      workspaceFile: null,
    })
    expect(moved.root).toBe('/new')
    expect(store.findByCanonicalRoot('/old')).toBeNull()
    expect(store.findByCanonicalRoot('/new')?.id).toBe(project.id)
  })

  it('refuses to move onto another project, leaving the original untouched', () => {
    const store = sensitive()
    const first = add(store, '/a', 'A')
    const second = add(store, '/b', 'B')
    expect(() =>
      store.relocate(second.id, { root: '/a', canonicalRoot: '/a', workspaceFile: null })
    ).toThrow(DuplicateProjectRootError)
    expect(store.get(second.id)?.canonicalRoot).toBe('/b')
    expect(store.get(first.id)?.canonicalRoot).toBe('/a')
  })

  /*
   * A project may be relocated onto the directory it already occupies — renaming
   * a workspace file in place, or re-resolving a root after a mount change. The
   * clash check therefore has to exclude the row being moved, and this is the
   * test that fails if it does not.
   */
  it('allows a project to be relocated onto itself', () => {
    const store = sensitive()
    const project = add(store, '/a')
    const moved = store.relocate(project.id, {
      root: '/a',
      canonicalRoot: '/a',
      workspaceFile: '/a/thing.code-workspace',
    })
    expect(moved.workspaceFile).toBe('/a/thing.code-workspace')
  })

  it('refuses an id nobody adopted', () => {
    expect(() =>
      sensitive().relocate('nope', { root: '/x', canonicalRoot: '/x', workspaceFile: null })
    ).toThrow(UnknownProjectError)
  })
})

describe('remove', () => {
  it('forgets a project and reports whether there was one', () => {
    const store = sensitive()
    const project = add(store, '/code/chorus')
    expect(store.remove(project.id)).toBe(true)
    expect(store.get(project.id)).toBeNull()
    expect(store.remove(project.id)).toBe(false)
  })

  it('frees the directory for a new project', () => {
    const store = sensitive()
    store.remove(add(store, '/code/chorus').id)
    expect(() => add(store, '/code/chorus', 'Again')).not.toThrow()
  })
})

describe('durability', () => {
  /*
   * The exit criterion says "restarting restores the registry". A new store over
   * the same handle is the closest this package can get to a restart — it holds
   * no state of its own, so anything it can still see came from the database.
   */
  it('survives a new store over the same database', () => {
    const project = add(sensitive(), '/code/chorus')
    expect(new ProjectStore(db, { caseSensitivePaths: true }).list()).toEqual([project])
  })
})
