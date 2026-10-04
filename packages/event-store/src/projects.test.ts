import { beforeEach, describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS } from './migrations.js'
import {
  canonicalKey,
  DuplicateProjectRootError,
  DuplicateTrafficPortError,
  LOCAL_HOST,
  NoFreeTrafficPortError,
  NoLegacyTrafficError,
  platformCaseSensitivity,
  ProjectStore,
  remoteProjectHost,
  ReservedTrafficPortError,
  type RunCommands,
  UnknownProjectError,
  UnknownTrafficOwnershipError,
  UnresolvedLegacyTrafficError,
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
  store.create({ name, host: LOCAL_HOST, root, canonicalRoot: root, workspaceFile: null, now })

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
      host: LOCAL_HOST,
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
      host: LOCAL_HOST,
      root: '/Users/me/shortcut',
      canonicalRoot: '/Volumes/disk/real',
      workspaceFile: null,
      now: 1,
    })
    expect(project.root).toBe('/Users/me/shortcut')
    expect(project.canonicalRoot).toBe('/Volumes/disk/real')
    // Uniqueness follows the real directory, not the name somebody reached it by.
    expect(store.findByRoot({ host: LOCAL_HOST, canonicalRoot: '/Volumes/disk/real' })?.id).toBe(
      project.id
    )
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

describe('a project on another host', () => {
  const remote = (
    store: ProjectStore,
    host: string,
    root: string
  ): ReturnType<ProjectStore['create']> =>
    store.create({ name: 'Api', host, root, canonicalRoot: root, workspaceFile: null, now: 2 })

  it('accepts a remote host only when it names one', () => {
    expect(remoteProjectHost('  TPA-BE ')).toBe('tpa-be')
    expect(() => remoteProjectHost('')).toThrow('Not a usable remote host')
    expect(() => remoteProjectHost('   ')).toThrow('Not a usable remote host')
    expect(() => remoteProjectHost('-oProxyCommand=x')).toThrow('Not a usable remote host')
  })

  it('lets two hosts hold the same path', () => {
    const store = sensitive()
    const here = add(store, 'C:/code/api')
    const there = remote(store, 'tpa-be', 'C:/code/api')
    expect(there.id).not.toBe(here.id)
    expect(store.findByRoot({ host: LOCAL_HOST, canonicalRoot: 'C:/code/api' })?.id).toBe(here.id)
    expect(store.findByRoot({ host: 'tpa-be', canonicalRoot: 'C:/code/api' })?.id).toBe(there.id)
  })

  it('still refuses the same path twice on one host', () => {
    const store = sensitive()
    add(store, 'C:/code/api')
    expect(() => remote(store, 'tpa-be', 'C:/code/api')).not.toThrow()
    expect(() => remote(store, 'tpa-be', 'C:/code/api')).toThrow(DuplicateProjectRootError)
  })

  it('folds a host the way a name is folded, not the way a path is', () => {
    const store = sensitive()
    const project = remote(store, '  TPA-BE  ', 'C:/code/api')
    expect(project.host).toBe('tpa-be')
    expect(store.findByRoot({ host: 'tpa-be', canonicalRoot: 'C:/code/api' })?.id).toBe(project.id)
  })

  it('refuses a blank host, and one that a shell would read as an option', () => {
    const store = sensitive()
    expect(() => remote(store, '   ', 'C:/code/api')).toThrow()
    expect(() => remote(store, '-oProxyCommand=calc', 'C:/code/api')).toThrow()
    expect(() => remote(store, 'tpa be', 'C:/code/api')).toThrow()
  })

  it('relocates within its own host, so a path held elsewhere does not block the move', () => {
    const store = sensitive()
    const there = remote(store, 'tpa-be', 'C:/code/api')
    const moved = store.relocate(add(store, 'C:/code/other').id, {
      root: 'C:/code/api',
      canonicalRoot: 'C:/code/api',
      workspaceFile: null,
    })
    expect(moved.root).toBe('C:/code/api')
    expect(moved.host).toBe(LOCAL_HOST)
    expect(store.get(there.id)?.root).toBe('C:/code/api')
  })
})

describe('a database written before hosts existed', () => {
  it('reads its projects as local and still refuses the same folder twice', () => {
    const old = openSqlite({ path: ':memory:' })
    for (const migration of MIGRATIONS.filter((m) => m.version <= 11)) old.exec(migration.up)
    old.exec('PRAGMA user_version = 11')
    old
      .prepare(
        `INSERT INTO projects
           (id, name, root, canonical_root, canonical_key, created_at, last_opened_at)
         VALUES ('old-project', 'Old', '/code/chorus', '/code/chorus', '/code/chorus', 1, 1)`
      )
      .run()

    migrate(old)

    const store = new ProjectStore(old, { caseSensitivePaths: true })
    expect(store.get('old-project')?.host).toBe(LOCAL_HOST)
    expect(() => add(store, '/code/chorus')).toThrow(DuplicateProjectRootError)
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
    expect(store.findByRoot({ host: LOCAL_HOST, canonicalRoot: '/old' })).toBeNull()
    expect(store.findByRoot({ host: LOCAL_HOST, canonicalRoot: '/new' })?.id).toBe(project.id)
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

describe('traffic configuration', () => {
  const shared = (port: number | null, origin: string | null = 'http://127.0.0.1:8080') => ({
    origin,
    port,
    access: 'lan' as const,
  })

  it('starts a project with no connection of its own, open to the network', () => {
    const project = add(sensitive(), '/code/one')
    expect(project.trafficOrigin).toBeNull()
    expect(project.trafficPort).toBeNull()
    expect(project.trafficAccess).toBe('lan')
  })

  it('offers the first free port from the one it is asked, and the next to the next project', () => {
    const store = sensitive()
    const one = add(store, '/code/one')
    const two = add(store, '/code/two')

    expect(store.nextTrafficPort(one.id, 30_100)).toBe(30_100)
    store.setTrafficConfig(one.id, { trafficPort: 30_100 })
    expect(store.nextTrafficPort(two.id, 30_100)).toBe(30_101)
  })

  it('holds the shared connection’s port against an automatic allocation', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)

    const project = add(store, '/code/one')
    expect(store.nextTrafficPort(project.id, 30_100)).toBe(30_101)
  })

  it('holds it against an explicit edit too, and refuses it by name', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)
    const project = add(store, '/code/one')

    expect(() => store.setTrafficConfig(project.id, { trafficPort: 30_100 })).toThrow(
      ReservedTrafficPortError
    )
    expect(store.nextTrafficPort(project.id, 30_100)).toBe(30_101)
  })

  it('reserves nothing for a saved ephemeral port, and remembers it anyway', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate({ origin: null, port: 0, access: 'lan' }, null)

    expect(store.legacyTrafficImport().candidate).toEqual({
      origin: null,
      port: 0,
      access: 'lan',
    })
    const project = add(store, '/code/one')
    expect(store.nextTrafficPort(project.id, 30_100)).toBe(30_100)
  })

  it('refuses to move the shared connection onto a port a project already holds', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)
    const project = add(store, '/code/one')
    store.setTrafficConfig(project.id, { trafficPort: store.nextTrafficPort(project.id, 30_100) })

    expect(() => store.recordLegacyTrafficCandidate(shared(30_101), null)).toThrow(
      DuplicateTrafficPortError
    )
    expect(store.legacyTrafficImport().candidate?.port).toBe(30_100)
  })

  it('refuses a port another project holds', () => {
    const store = sensitive()
    const one = add(store, '/code/one')
    const two = add(store, '/code/two')
    store.setTrafficConfig(one.id, { trafficPort: 30_100 })

    expect(() => store.setTrafficConfig(two.id, { trafficPort: 30_100 })).toThrow(
      DuplicateTrafficPortError
    )
  })

  it('lets a project keep its own port through an edit that does not mention it', () => {
    const store = sensitive()
    const project = add(store, '/code/one')
    store.setTrafficConfig(project.id, { trafficPort: 30_100 })

    expect(
      store.setTrafficConfig(project.id, { trafficOrigin: 'http://127.0.0.1:8081' }).trafficPort
    ).toBe(30_100)
  })

  it('refuses an origin it cannot forward through, rather than tidying it', () => {
    const store = sensitive()
    const project = add(store, '/code/one')

    for (const origin of [
      'http://user:pw@host:8080',
      'ftp://host:8080',
      'http://host:8080/?token=1',
      'http://host:8080/#frag',
      'https://example.test/api/v1/',
      'not a url',
    ]) {
      expect(() => store.setTrafficConfig(project.id, { trafficOrigin: origin })).toThrow()
    }
    expect(
      store.setTrafficConfig(project.id, { trafficOrigin: 'http://127.0.0.1:8080' }).trafficOrigin
    ).toBe('http://127.0.0.1:8080')
  })

  it('adopts the shared connection once', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)
    const project = add(store, '/code/one')

    const adopted = store.adoptLegacyTraffic(project.id)
    expect(adopted.trafficPort).toBe(30_100)
    expect(adopted.trafficOrigin).toBe('http://127.0.0.1:8080')
    expect(adopted.trafficAccess).toBe('lan')

    expect(store.legacyTrafficImport()).toEqual({
      completed: true,
      assignedProjectId: project.id,
      candidate: null,
      error: null,
    })
  })

  it('refuses a second adoption, whoever asks', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)
    const one = add(store, '/code/one')
    const two = add(store, '/code/two')
    store.adoptLegacyTraffic(one.id)

    expect(() => store.adoptLegacyTraffic(two.id)).toThrow(NoLegacyTrafficError)
  })

  it('refuses to adopt a connection nobody has configured', () => {
    const store = sensitive()
    const project = add(store, '/code/one')
    expect(() => store.adoptLegacyTraffic(project.id)).toThrow(NoLegacyTrafficError)
  })

  it('blocks every project port while the saved connection is on an unknown one', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(
      { origin: null, port: null, access: 'lan' },
      'the settings file was not json'
    )
    const project = add(store, '/code/one')

    expect(() => store.nextTrafficPort(project.id, 30_100)).toThrow(UnknownTrafficOwnershipError)
    expect(() => store.setTrafficConfig(project.id, { trafficPort: 30_100 })).toThrow(
      UnknownTrafficOwnershipError
    )
    expect(
      store.setTrafficConfig(project.id, { trafficOrigin: 'http://127.0.0.1:8080' }).trafficOrigin
    ).toBe('http://127.0.0.1:8080')
  })

  it('lets a project keep its port through an unrelated edit while ownership is unknown', () => {
    const store = sensitive()
    const project = add(store, '/code/one')
    store.setTrafficConfig(project.id, { trafficPort: 30_150 })
    store.recordLegacyTrafficCandidate(
      { origin: null, port: null, access: 'lan' },
      'the settings file was not json'
    )

    expect(
      store.setTrafficConfig(project.id, { trafficOrigin: 'http://127.0.0.1:8080' }).trafficPort
    ).toBe(30_150)
    expect(() => store.setTrafficConfig(project.id, { trafficPort: 30_151 })).toThrow(
      UnknownTrafficOwnershipError
    )
  })

  it('refuses to adopt a connection it could not read', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), 'the settings file was not json')
    const project = add(store, '/code/one')

    expect(() => store.adoptLegacyTraffic(project.id)).toThrow(UnresolvedLegacyTrafficError)
  })

  it('gives ports out again once the unknown connection is decided', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(
      { origin: null, port: null, access: 'lan' },
      'the settings file was not json'
    )
    store.completeLegacyTrafficImport()

    const project = add(store, '/code/one')
    expect(store.nextTrafficPort(project.id, 30_100)).toBe(30_100)
  })

  it('releases the reservation when the import is dismissed', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)
    store.completeLegacyTrafficImport()

    expect(store.legacyTrafficImport().candidate).toBeNull()
    const project = add(store, '/code/one')
    expect(store.nextTrafficPort(project.id, 30_100)).toBe(30_100)
  })

  it('never reopens a completed import, whatever the settings file still says', () => {
    const store = sensitive()
    store.completeLegacyTrafficImport()

    expect(store.recordLegacyTrafficCandidate(shared(30_100), null)).toBe(false)
    expect(store.legacyTrafficImport().candidate).toBeNull()

    const project = add(store, '/code/one')
    expect(store.nextTrafficPort(project.id, 30_100)).toBe(30_100)
  })

  it('keeps a connection through a rename and a relocate', () => {
    const store = sensitive()
    const project = add(store, '/code/one')
    store.setTrafficConfig(project.id, {
      trafficOrigin: 'http://127.0.0.1:8080',
      trafficPort: 30_140,
      trafficAccess: 'lan',
    })

    store.rename(project.id, 'Renamed')
    const moved = store.relocate(project.id, {
      root: '/code/moved',
      canonicalRoot: '/code/moved',
      workspaceFile: null,
    })

    expect(moved.trafficPort).toBe(30_140)
    expect(moved.trafficOrigin).toBe('http://127.0.0.1:8080')
    expect(moved.trafficAccess).toBe('lan')
  })

  it('frees the adopted port when its project is forgotten, and stays decided', () => {
    const store = sensitive()
    store.recordLegacyTrafficCandidate(shared(30_100), null)
    const project = add(store, '/code/one')
    store.adoptLegacyTraffic(project.id)

    expect(store.remove(project.id)).toBe(true)
    const next = add(store, '/code/two')
    expect(store.nextTrafficPort(next.id, 30_100)).toBe(30_100)
    expect(store.legacyTrafficImport().completed).toBe(true)
  })

  it('says so when the range it was given is full', () => {
    const store = sensitive()
    const from = 65_530
    for (let port = from; port <= 65_535; port += 1) {
      const project = add(store, `/code/${String(port)}`)
      store.setTrafficConfig(project.id, { trafficPort: port })
    }

    const oneTooMany = add(store, '/code/one-too-many')
    expect(() => store.nextTrafficPort(oneTooMany.id, from)).toThrow(NoFreeTrafficPortError)
  })
})

describe('the traffic tables, added to a database that already has projects', () => {
  it('leaves the fields an existing project already had alone', () => {
    const upgraded = openSqlite({ path: ':memory:' })
    for (const step of MIGRATIONS.filter((m) => m.version <= 13)) {
      upgraded.exec(step.up)
      upgraded.exec(`PRAGMA user_version = ${String(step.version)}`)
    }
    const before = add(new ProjectStore(upgraded, { caseSensitivePaths: true }), '/code/older')

    migrate(upgraded)

    const after = new ProjectStore(upgraded, { caseSensitivePaths: true })
    expect(after.get(before.id)).toEqual({
      ...before,
      trafficOrigin: null,
      trafficPort: null,
      trafficAccess: 'lan',
    })
    expect(after.legacyTrafficImport()).toEqual({
      completed: false,
      assignedProjectId: null,
      candidate: null,
      error: null,
    })
  })

  /*
   * The two things migration 18 does that could quietly go wrong, on one row
   * that has a value in every column the rebuild copies.
   *
   * The first is the claim the row rewrite makes — that a stored `loopback` is
   * the column's default and not an answer, so flipping it takes nothing away.
   * The second is the rebuild itself: `projects` is dropped and recreated to
   * change a column's DEFAULT, which SQLite will not do in place, and a column
   * missed in the copy comes back empty rather than raising.
   */
  it('flips a stored loopback and carries every other column through the rebuild', () => {
    const upgraded = openSqlite({ path: ':memory:' })
    for (const step of MIGRATIONS.filter((m) => m.version <= 17)) {
      upgraded.exec(step.up)
      upgraded.exec(`PRAGMA user_version = ${String(step.version)}`)
    }
    const store = new ProjectStore(upgraded, { caseSensitivePaths: true })
    const before = add(store, '/code/older')
    upgraded
      .prepare(
        `UPDATE projects
            SET traffic_origin = @origin, traffic_port = 30100,
                traffic_access = 'loopback', traffic_env_var = 'API_URL'
          WHERE id = @id`
      )
      .run({ origin: 'http://127.0.0.1:8080', id: before.id })
    expect(
      upgraded.prepare(`SELECT traffic_access FROM projects WHERE id = @id`).get({ id: before.id })
    ).toEqual({ traffic_access: 'loopback' })

    migrate(upgraded)

    expect(new ProjectStore(upgraded, { caseSensitivePaths: true }).get(before.id)).toEqual({
      ...before,
      trafficOrigin: 'http://127.0.0.1:8080',
      trafficPort: 30_100,
      trafficAccess: 'lan',
      trafficEnvVar: 'API_URL',
    })
  })

  it('widens the port-0 constraint on a database that was already at version 15', () => {
    const upgraded = openSqlite({ path: ':memory:' })
    for (const step of MIGRATIONS.filter((m) => m.version <= 15)) {
      upgraded.exec(step.up)
      upgraded.exec(`PRAGMA user_version = ${String(step.version)}`)
    }
    upgraded
      .prepare(
        `UPDATE traffic_legacy_import
            SET pending_origin = @origin, pending_port = 30100, pending_access = 'lan'
          WHERE id = 1`
      )
      .run({ origin: 'http://127.0.0.1:8080' })

    migrate(upgraded)

    const store = new ProjectStore(upgraded, { caseSensitivePaths: true })
    expect(store.legacyTrafficImport().candidate).toEqual({
      origin: 'http://127.0.0.1:8080',
      port: 30_100,
      access: 'lan',
    })
    expect(store.recordLegacyTrafficCandidate({ origin: null, port: 0, access: 'lan' }, null)).toBe(
      true
    )
    expect(store.legacyTrafficImport().candidate?.port).toBe(0)
  })
})

describe('saved run commands', () => {
  const saved: RunCommands = {
    version: 1,
    defaultId: 'clean',
    commands: [
      { id: 'dev', label: 'dev', command: 'npm run dev' },
      { id: 'clean', label: 'dev:clean', command: 'npm run dev:clean' },
    ],
  }

  it('reads null for a project nobody has set up', () => {
    const project = add(sensitive(), '/code/mobile')

    expect(project.runCommands).toBeNull()
    expect(sensitive().get(project.id)?.runCommands).toBeNull()
  })

  it('keeps what was saved across a fresh store, and clears it back to null', () => {
    const project = add(sensitive(), '/code/mobile')

    expect(sensitive().setRunCommands(project.id, saved).runCommands).toEqual(saved)
    expect(sensitive().get(project.id)?.runCommands).toEqual(saved)

    expect(sensitive().setRunCommands(project.id, null).runCommands).toBeNull()
    expect(sensitive().get(project.id)?.runCommands).toBeNull()
  })

  it('stores a label and a command without their surrounding blanks', () => {
    const project = add(sensitive(), '/code/mobile')

    const stored = sensitive().setRunCommands(project.id, {
      version: 1,
      defaultId: 'dev',
      commands: [{ id: 'dev', label: '  dev  ', command: '  npm run dev  ' }],
    })

    expect(stored.runCommands?.commands).toEqual([
      { id: 'dev', label: 'dev', command: 'npm run dev' },
    ])
  })

  it('refuses two commands with one id, and a default that names nothing, keeping the old value', () => {
    const project = add(sensitive(), '/code/mobile')
    sensitive().setRunCommands(project.id, saved)

    expect(() =>
      sensitive().setRunCommands(project.id, {
        version: 1,
        defaultId: 'dev',
        commands: [
          { id: 'dev', label: 'dev', command: 'npm run dev' },
          { id: 'dev', label: 'again', command: 'npm run dev:clean' },
        ],
      })
    ).toThrow()
    expect(() =>
      sensitive().setRunCommands(project.id, { ...saved, defaultId: 'missing' })
    ).toThrow()
    expect(() => sensitive().setRunCommands(project.id, { ...saved, commands: [] })).toThrow()

    expect(sensitive().get(project.id)?.runCommands).toEqual(saved)
  })

  it('refuses a project nobody adopted', () => {
    expect(() => sensitive().setRunCommands('nobody', saved)).toThrow(UnknownProjectError)
  })

  it('reads an unreadable or invalid stored value as null and still loads the project', () => {
    const project = add(sensitive(), '/code/mobile', 'Mobile')
    const write = (value: string): void => {
      db.prepare(`UPDATE projects SET run_commands = @value WHERE id = @id`).run({
        value,
        id: project.id,
      })
    }

    for (const value of [
      '{not json',
      JSON.stringify({ ...saved, version: 2 }),
      JSON.stringify({ ...saved, defaultId: 'missing' }),
      JSON.stringify([saved]),
    ]) {
      write(value)
      const loaded = sensitive().get(project.id)
      expect(loaded?.name).toBe('Mobile')
      expect(loaded?.runCommands).toBeNull()
    }
  })

  it('adds the column to a database that already has projects, leaving them unconfigured', () => {
    const upgraded = openSqlite({ path: ':memory:' })
    for (const step of MIGRATIONS.filter((m) => m.version <= 19)) {
      upgraded.exec(step.up)
      upgraded.exec(`PRAGMA user_version = ${String(step.version)}`)
    }
    const before = add(new ProjectStore(upgraded, { caseSensitivePaths: true }), '/code/older')
    upgraded
      .prepare(`UPDATE projects SET notes = 'keep me', traffic_env_var = 'API_URL' WHERE id = @id`)
      .run({ id: before.id })

    migrate(upgraded)

    const after = new ProjectStore(upgraded, { caseSensitivePaths: true })
    expect(after.get(before.id)).toEqual({
      ...before,
      notes: 'keep me',
      trafficEnvVar: 'API_URL',
      runCommands: null,
    })
    expect(after.setRunCommands(before.id, saved).runCommands).toEqual(saved)
  })
})
