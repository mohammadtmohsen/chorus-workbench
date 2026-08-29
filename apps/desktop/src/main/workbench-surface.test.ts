import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchConnection } from '../shared/workbench-ipc.js'

/**
 * The whole class of defect here is a control that appears to exist because it
 * exists somewhere else.
 *
 * A `WebContentsView` inherits nothing: not the shell's session, not its CSP, not
 * its permission handlers, not its navigation lock, and — the one round 2 of the
 * preflight left unnamed — not its preload. Two of those failures are loud (no
 * preload at all means the surface never receives its connection) and the rest
 * are silent, which is why they are asserted here rather than looked for by hand.
 *
 * The second class, added after the containment slice was reviewed, is a control
 * that exists but is asked the wrong question: an operation authorised by the
 * *name* of a thing rather than by the *identity of the caller*, and a project
 * root that is whatever string a renderer sent.
 *
 * The third, added after the seventh round, is a control that answers a different
 * question from the one it looks like it answers. `realpathSync` was standing in
 * for authorisation — it canonicalises a path, which makes it well-formed and says
 * nothing about whether this window may open it. The tests below are written so
 * that both refusals fail loudly if the capability is taken back out: a forged but
 * real directory, and a capability minted for another window.
 */

const defaultSession = { id: 'default' }
const showOpenDialog = vi.fn()
const partitions = new Map<string, Record<string, unknown>>()

const fromPartition = vi.fn((name: string) => {
  const existing = partitions.get(name)
  if (existing !== undefined) return existing
  const created = {
    id: name,
    webRequest: { onHeadersReceived: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }
  partitions.set(name, created)
  return created
})

/** Every view constructed during a test, with the preferences it was given. */
const constructed: { webPreferences: Record<string, unknown> }[] = []

class FakeWebContents {
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  readonly sent: unknown[] = []
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  readonly setWindowOpenHandler = vi.fn()
  send(_channel: string, payload: unknown): void {
    this.sent.push(payload)
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  /** Flippable, because "the window went away mid-acquire" needs *this* object to go. */
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  readonly close = vi.fn()
  /** Arguments are forwarded: `did-start-navigation` is only readable with them. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

class FakeWebContentsView {
  readonly webContents = new FakeWebContents()
  bounds: unknown = null
  constructor(options: { webPreferences: Record<string, unknown> }) {
    constructed.push(options)
  }
  setBounds(rect: unknown): void {
    this.bounds = rect
  }
}

const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>()

/**
 * Unpackaged by default, which is what makes the gate's seeded chooser reachable
 * from here at all — and **flippable**, because the one control the trust waiver
 * rests on is the packaging check, and a control that cannot be turned off cannot
 * be tested. A getter rather than a literal so the flag is read at call time; the
 * value is captured once by a plain property and the test would then be asserting
 * against the state at mock-construction.
 */
const appState = { isPackaged: false }

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged
    },
  },
  BrowserWindow: {
    fromWebContents: () => fakeWindow,
    getAllWindows: () => [fakeWindow],
  },
  WebContentsView: FakeWebContentsView,
  dialog: { showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, request?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
  },
  session: {
    get defaultSession() {
      return defaultSession
    },
    fromPartition,
  },
  shell: { openExternal: vi.fn() },
}))

/**
 * The shared server, faked — because `openSurface` now takes its lease before it
 * creates a view, and the real `acquire` downloads 76 MB, verifies a checksum,
 * unpacks 257 MB and spawns a Node process. None of that is what this file is
 * about, and a unit test that did it would be measuring the network.
 *
 * The descriptor is still asserted end to end: what these tests check is that
 * whatever the host returns reaches **that one surface** and no other.
 */
const RUNTIME = {
  remoteAuthority: '127.0.0.1:51515',
  connectionToken: 'a-token-the-shell-must-never-see',
  commit: '987c9597516278c9fcf10d963a0592ce1384ab93',
  quality: 'stable',
}
/** How many views existed when the lease was taken — see the ordering test below. */
let viewsAtAcquire = -1
/*
 * The root is declared even though nothing here reads it, and that is the fix
 * for a real red gate rather than a tidy-up.
 *
 * `vi.fn` infers a mock's call signature from the implementation it is given, so
 * an implementation with no parameters produced a mock that could not be called
 * with one — `Expected 0 arguments, but got 1` at the forwarding line below, plus
 * an unsafe `any` return where the failed call's type collapsed. It was invisible
 * because `pnpm check` stops at its first failing leg and turbo was replaying a
 * cached green typecheck from an older hash; editing this file busted the cache.
 * Naming the parameter is what makes `acquireWorkbenchRuntime(root)` legal, and
 * the assertions that read `toHaveBeenCalledWith` a root depend on it arriving.
 */
const acquireWorkbenchRuntime = vi.fn((_root: string) => {
  viewsAtAcquire = constructed.length
  return Promise.resolve(RUNTIME)
})
const releaseWorkbenchRuntime = vi.fn((_root: string) => undefined)

vi.mock('./workbench-host.js', () => ({
  acquireWorkbenchRuntime: (root: string) => acquireWorkbenchRuntime(root),
  // Braces, because the mock returns void and a shorthand arrow returning a void
  // expression is forbidden — the forwarding is the point, not the value.
  releaseWorkbenchRuntime: (root: string) => {
    releaseWorkbenchRuntime(root)
  },
}))

const fakeWindow = {
  contentView: {
    children: [] as unknown[],
    addChildView(view: unknown) {
      this.children.push(view)
    },
    removeChildView(view: unknown) {
      this.children = this.children.filter((child) => child !== view)
    },
  },
}

/**
 * Real directories, because main now decides what a project root is rather than
 * repeating what it was told, and a made-up string is exactly what it refuses.
 *
 * `realpathSync` on the way in: on macOS `tmpdir()` is itself behind a symlink
 * (`/var` → `/private/var`), so without this every descriptor assertion below
 * would be re-testing the canonicalisation rule by accident instead of the thing
 * it is about.
 */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'chorus-workbench-surface-')))
const root = (name: string): string => {
  const path = join(scratch, name)
  mkdirSync(path, { recursive: true })
  return path
}

const ROOT_A = root('a')
const ROOT_B = root('b')

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const surface = await import('./workbench-surface.js')

// Registered once, because the chooser is only reachable through its channel:
// there is no exported mint, deliberately, so a main-side caller cannot conjure a
// capability out of a path either.
surface.registerWorkbenchHandlers(undefined)

/** One shell, unless a test needs two. Ownership is decided by this object. */
let shell: FakeWebContents

beforeEach(() => {
  // Module state is shared across this file; a leaked surface would make the
  // next test's "the last constructed view" the wrong one.
  surface.closeAllSurfaces()
  showOpenDialog.mockReset()
  acquireWorkbenchRuntime.mockClear()
  releaseWorkbenchRuntime.mockClear()
  shell = new FakeWebContents()
  // The two halves of the trust waiver's condition, back to the shipped values.
  // Left set by a test that flipped them, every descriptor after it would be
  // asserting against the wrong profile — and the assertion that matters most
  // here is the *absence* of a field, which is exactly the kind that passes for
  // the wrong reason.
  appState.isPackaged = false
  delete process.env['CHORUS_WORKBENCH_E2E_ROOTS']
})

const lastView = (): FakeWebContentsView =>
  fakeWindow.contentView.children.at(-1) as FakeWebContentsView

interface Chosen {
  readonly chosen: { readonly grant: string; readonly projectRoot: string } | null
}

/**
 * A capability, obtained the only way anything can obtain one: the person picked
 * a folder in main's own dialog.
 *
 * The dialog is stubbed rather than the mint, which is the point — a test that
 * reached past the chooser would be asserting against a mint the app does not
 * have.
 */
async function chooseProject(owner: FakeWebContents, root: string): Promise<Chosen['chosen']> {
  showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] })
  const response = (await handlers.get('workbench:chooseProject')?.(
    { sender: owner },
    {}
  )) as Chosen
  return response.chosen
}

async function grantFor(owner: FakeWebContents, root: string): Promise<string> {
  const chosen = await chooseProject(owner, root)
  if (chosen === null) throw new Error('the chooser answered with nothing')
  return chosen.grant
}

/** Open a surface the way the app does: choose, then redeem. */
async function openAt(owner: FakeWebContents, root: string): Promise<string> {
  return surface.openSurface(owner as never, { grant: await grantFor(owner, root) }, undefined)
}

describe('the workbench session', () => {
  it('is not defaultSession, and carries its own CSP and permission handlers', () => {
    const created = surface.workbenchSession(false, RUNTIME.remoteAuthority) as unknown as {
      id: string
      webRequest: { onHeadersReceived: ReturnType<typeof vi.fn> }
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
    }

    expect(created).not.toBe(defaultSession)
    expect(fromPartition).toHaveBeenCalledWith(surface.WORKBENCH_PARTITION)
    expect(created.webRequest.onHeadersReceived).toHaveBeenCalled()
    expect(created.setPermissionRequestHandler).toHaveBeenCalled()
    expect(created.setPermissionCheckHandler).toHaveBeenCalled()
  })

  it('is in-memory, so a connection secret cannot outlive a quit in a cookie', () => {
    expect(surface.WORKBENCH_PARTITION.startsWith('persist:')).toBe(false)
  })

  it('is one partition shared by every surface, not one each', async () => {
    await openAt(shell, ROOT_A)
    await openAt(shell, ROOT_B)
    const named = fromPartition.mock.calls.map(([name]) => name)
    expect(new Set(named)).toEqual(new Set([surface.WORKBENCH_PARTITION]))
  })
})

describe('the surface webPreferences', () => {
  it('names the workbench preload and never the shell one', async () => {
    await openAt(shell, ROOT_A)
    const named: unknown = constructed.at(-1)?.webPreferences['preload']
    const preload = typeof named === 'string' ? named : ''

    // The failure this is written against is a spread of the window's own
    // `webPreferences` — whose sandbox flags are identical, so the copy looks
    // harmless and brings `preload/index.js` and the whole ChorusApi with it.
    expect(preload.endsWith('preload/workbench.js')).toBe(true)
    expect(preload).not.toContain('preload/index.js')
  })

  it('keeps the sandbox on and sub-frame node integration off', async () => {
    await openAt(shell, ROOT_A)
    const preferences = constructed.at(-1)?.webPreferences ?? {}
    expect(preferences['sandbox']).toBe(true)
    expect(preferences['contextIsolation']).toBe(true)
    expect(preferences['nodeIntegration']).toBe(false)
    // On, "all your preloads will load for every iframe" — and a workbench's
    // iframes are extension webviews.
    expect(preferences['nodeIntegrationInSubFrames']).toBe(false)
  })

  it('puts the view on the workbench session object itself', async () => {
    await openAt(shell, ROOT_A)
    expect(constructed.at(-1)?.webPreferences['session']).toBe(
      surface.workbenchSession(false, RUNTIME.remoteAuthority)
    )
    expect(constructed.at(-1)?.webPreferences['session']).not.toBe(defaultSession)
  })
})

/**
 * Item 4 of the sixth review, corrected by the seventh: the renderer does not
 * propose a project at all.
 *
 * The sixth round had main canonicalise the renderer's string and open whatever
 * existed there, which is the defect this block is now written against —
 * canonicalisation is not authorisation, and "it resolves to a real directory" is
 * a property of nearly every directory on the disk. What main opens is a
 * capability it minted itself, from a folder the person picked, bound to the
 * window that asked.
 */
describe('what main will open, and what it refuses', () => {
  it('refuses a forged path, however real the directory is', async () => {
    /*
     * The adversarial case, and the reason it has to be a *real* directory:
     * against a made-up path this passes with the capability removed, because
     * `approveProjectRoot` refuses it for a reason that has nothing to do with
     * authorisation. `ROOT_A` exists, is absolute, is canonical and is a
     * directory — every test the old code applied — and it is still refused,
     * because it is not a capability.
     */
    await expect(surface.openSurface(shell as never, { grant: ROOT_A }, undefined)).rejects.toThrow(
      /belongs to this window/
    )
    expect(fakeWindow.contentView.children).toHaveLength(0)

    // And one level out, at the boundary itself: the channel has no shape for a
    // path, so a renderer naming one is refused by the schema rather than by a
    // check someone has to remember to write.
    await expect(
      handlers.get('workbench:open')?.({ sender: shell }, { projectRoot: ROOT_A })
    ).rejects.toThrow(/Invalid request/)

    // The control, so this cannot pass by nothing working at all.
    await expect(openAt(shell, ROOT_A)).resolves.toEqual(expect.any(String))
  })

  it('refuses a capability minted for another window', async () => {
    const other = new FakeWebContents()
    const grant = await grantFor(shell, ROOT_A)

    /*
     * A grant is not a secret. It crosses IPC, sits in React state, and would sit
     * in the first log line anybody adds while debugging this — so a second
     * window holding one is the case to design against, not an unlikely one.
     */
    await expect(surface.openSurface(other as never, { grant }, undefined)).rejects.toThrow(
      /belongs to this window/
    )
    await expect(handlers.get('workbench:open')?.({ sender: other }, { grant })).rejects.toThrow(
      /belongs to this window/
    )
    expect(fakeWindow.contentView.children).toHaveLength(0)

    // The control: the window it was minted for still opens with it.
    await expect(surface.openSurface(shell as never, { grant }, undefined)).resolves.toEqual(
      expect.any(String)
    )
  })

  it('refuses a project id when no registry was wired', async () => {
    // Fail-closed rather than falling through to the grant branch, where
    // `target.grant` is not even present. A build that forgot to inject the
    // resolver must refuse, not misread the request as something else.
    await expect(
      handlers.get('workbench:open')?.({ sender: shell }, { projectId: 'anything' })
    ).rejects.toThrow(/No project registry is wired/)
  })

  /*
   * The wired half. Re-registering only reassigns the module-level resolver, and
   * the registration is restored in the `finally` so the surrounding file keeps
   * the unwired default every other test was written against.
   */
  it('opens a project id against the injected registry, and passes its refusal through', async () => {
    const adopted = new Map([['known', ROOT_A]])
    surface.registerWorkbenchHandlers(undefined, (projectId) => {
      const root = adopted.get(projectId)
      if (root === undefined) throw new Error(`No project with id ${projectId}`)
      return root
    })

    try {
      await expect(
        handlers.get('workbench:open')?.({ sender: shell }, { projectId: 'known' })
      ).resolves.toEqual({ viewId: expect.any(String) })

      // The renderer cannot invent one: an id nobody adopted resolves to nothing,
      // which is what bounds the openable set now that a grant is not required.
      await expect(
        handlers.get('workbench:open')?.({ sender: shell }, { projectId: 'invented' })
      ).rejects.toThrow(/No project with id invented/)
    } finally {
      surface.registerWorkbenchHandlers(undefined)
    }
  })

  it('lets a grant die with the document it was minted for', async () => {
    const grant = await grantFor(shell, ROOT_A)
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/index.html',
      isMainFrame: true,
      isSameDocument: false,
    })

    // The authorisation was the person's, given to *this* document. Whatever
    // loads next in the same `WebContents` did not receive it.
    await expect(surface.openSurface(shell as never, { grant }, undefined)).rejects.toThrow(
      /belongs to this window/
    )
  })

  it('canonicalises what the chooser answered rather than storing the spelling', async () => {
    const link = join(scratch, 'link-to-a')
    rmSync(link, { force: true })
    symlinkSync(ROOT_A, link, 'dir')

    const chosen = await chooseProject(shell, link)
    expect(chosen?.projectRoot).toBe(ROOT_A)

    await surface.openSurface(shell as never, { grant: chosen?.grant ?? '' }, undefined)
    const view = lastView()
    view.webContents.emit('did-finish-load')

    // The descriptor is the resolved tree, not the second name for it. Two
    // spellings of one project would otherwise be two projects to every refcount,
    // cache key and storage path that comes after.
    expect(view.webContents.sent).toEqual([{ ...RUNTIME, projectRoot: ROOT_A }])
  })

  it('mints nothing from a cancelled dialog', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handlers.get('workbench:chooseProject')?.({ sender: shell }, {})).resolves.toEqual(
      { chosen: null }
    )
  })

  it('still refuses a root that does not exist, a file, and a relative path', async () => {
    const file = join(scratch, 'not-a-directory.txt')
    writeFileSync(file, 'x')

    // Now applied to the *chooser's* answer rather than the renderer's request:
    // the dialog can return a path that has since gone, and a seeded root is a
    // string like any other.
    await expect(chooseProject(shell, join(scratch, 'absent'))).rejects.toThrow(
      /No such workbench project root/
    )
    await expect(chooseProject(shell, file)).rejects.toThrow(/must be a directory/)
    // Resolved against *main's* cwd, which is whatever launched the app.
    await expect(chooseProject(shell, 'relative/path')).rejects.toThrow(/must be an absolute path/)
  })

  it('is enforced wherever a string becomes a root', () => {
    // `approveProjectRoot` is exported for this assertion and for the handler's
    // error message; what matters is that the mint calls it whether or not the
    // caller did.
    expect(surface.approveProjectRoot(ROOT_B)).toBe(ROOT_B)
    expect(() => surface.approveProjectRoot(join(scratch, 'absent'))).toThrow()
  })
})

/**
 * Item 2 of the review. A view id is opaque but it is not a secret: it crosses
 * IPC, sits in the shell's React state and would sit in the first log line
 * anybody adds while debugging the layout. Authorising on it alone means any
 * window can move or destroy another window's workbench by naming it.
 */
describe('who may drive a surface', () => {
  it('refuses a window that does not own it, for bounds and for close alike', async () => {
    const other = new FakeWebContents()
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    const placed = { x: 1, y: 2, width: 3, height: 4 }
    surface.setSurfaceBounds(shell as never, viewId, placed)

    expect(() => {
      surface.setSurfaceBounds(other as never, viewId, { x: 9, y: 9, width: 9, height: 9 })
    }).toThrow(/belongs to this window/)
    expect(() => {
      surface.closeSurface(other as never, viewId)
    }).toThrow(/belongs to this window/)

    // The refusal has to be a refusal, not a message: the view is where its owner
    // put it, and it is still alive.
    expect(view.bounds).toEqual(placed)
    expect(view.webContents.close).not.toHaveBeenCalled()

    // The control, so this cannot pass by nothing working: the owner still moves
    // it.
    const moved = { x: 5, y: 6, width: 7, height: 8 }
    surface.setSurfaceBounds(shell as never, viewId, moved)
    expect(view.bounds).toEqual(moved)
  })

  it('says the same thing about an id that never existed', () => {
    // Two different messages would answer "does this id exist?", which is the
    // only thing an id-guessing caller could learn here.
    expect(() => {
      surface.closeSurface(shell as never, 'not-an-id')
    }).toThrow(/belongs to this window/)
  })

  it('lets the owner close its own surface', async () => {
    const viewId = await openAt(shell, ROOT_A)
    const view = lastView()
    surface.closeSurface(shell as never, viewId)
    expect(view.webContents.close).toHaveBeenCalled()
    expect(fakeWindow.contentView.children).not.toContain(view)
  })
})

/**
 * Item 3 of the review. A surface is destroyed today by the renderer's own
 * unmount — the one path a reload does not take.
 */
describe('a shell that goes away without saying so', () => {
  it('takes its surfaces with it when it reloads', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    // The shape Electron passes: a cross-document main-frame navigation, which
    // is what `location.reload()` and a dev-server full reload both are.
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/index.html',
      isMainFrame: true,
      isSameDocument: false,
    })

    expect(view.webContents.close).toHaveBeenCalled()
    expect(fakeWindow.contentView.children).not.toContain(view)
  })

  it('takes them when it is destroyed', async () => {
    await openAt(shell, ROOT_B)
    const view = lastView()
    shell.emit('destroyed')
    expect(view.webContents.close).toHaveBeenCalled()
  })

  it('leaves them alone for a same-document navigation', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    // The control, and it is not decorative: a `pushState` or a fragment is the
    // shell still running, and tearing four workbenches down because a route
    // changed would be a worse bug than the one this fixes.
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/index.html#somewhere',
      isMainFrame: true,
      isSameDocument: true,
    })
    shell.emit('did-start-navigation', {
      url: 'file:///wherever/frame.html',
      isMainFrame: false,
      isSameDocument: false,
    })

    expect(view.webContents.close).not.toHaveBeenCalled()
  })

  it('does not touch another shell surfaces', async () => {
    const other = new FakeWebContents()
    await openAt(shell, ROOT_A)
    const mine = lastView()
    await openAt(other, ROOT_B)
    const theirs = lastView()

    other.emit('destroyed')

    expect(theirs.webContents.close).toHaveBeenCalled()
    expect(mine.webContents.close).not.toHaveBeenCalled()
  })
})

/**
 * The Workspace Trust waiver, and the only test here worth writing is the one
 * that tries to get it in a packaged build.
 *
 * The waiver turns a real security control off. What makes that acceptable is not
 * that the gate needs it — everything needs something — but that a shipped Chorus
 * **cannot receive it**, and that safety rests entirely on one `&&`. So the happy
 * case is the cheap assertion and the packaged case is the load-bearing one: with
 * `app.isPackaged` dropped from the condition, an exported
 * `CHORUS_WORKBENCH_E2E_ROOTS` in a user's shell would be enough to silence the
 * trust prompt in an installed app, and nothing else in this file would notice.
 *
 * Proved against the defect reinstated, one experiment each: removing
 * `!app.isPackaged` from `isE2eProfile` turns the packaged case red, and removing
 * the environment check turns the no-seed case red.
 */
describe('the Workspace Trust waiver', () => {
  /** The descriptor this surface would be handed, straight from the pull. */
  const descriptorFrom = (view: FakeWebContentsView): Record<string, unknown> =>
    handlers.get('workbench:connection')?.({ sender: view.webContents }) as Record<string, unknown>

  it('is granted to an unpackaged app that carries the E2E root seed', async () => {
    process.env['CHORUS_WORKBENCH_E2E_ROOTS'] = ROOT_A
    await openAt(shell, ROOT_A)
    expect(descriptorFrom(lastView())['workspaceTrust']).toBe('waived')
  })

  it('is refused to a packaged app, however the environment is set', async () => {
    process.env['CHORUS_WORKBENCH_E2E_ROOTS'] = ROOT_A
    appState.isPackaged = true
    await openAt(shell, ROOT_A)

    const descriptor = descriptorFrom(lastView())
    // Absent, not false. `toHaveProperty` rather than a truthiness check, because
    // the schema's whole point is that there is no value meaning "enforced" — a
    // descriptor with the key present at all is the defect.
    expect(descriptor).not.toHaveProperty('workspaceTrust')
    expect(WorkbenchConnection.parse(descriptor).workspaceTrust).toBeUndefined()
  })

  it('is refused to an unpackaged app with no seed, which is every pnpm dev', async () => {
    await openAt(shell, ROOT_A)
    expect(descriptorFrom(lastView())).not.toHaveProperty('workspaceTrust')
  })
})

describe('the connection descriptor', () => {
  it('is pushed only after that view has finished loading', async () => {
    await openAt(shell, ROOT_A)
    const view = lastView()

    // Nothing before the document exists: Electron makes no promise that `send`
    // queues, and the preload's buffer covers only the window after load.
    expect(view.webContents.sent).toEqual([])
    view.webContents.emit('did-finish-load')
    expect(view.webContents.sent).toEqual([{ ...RUNTIME, projectRoot: ROOT_A }])
  })

  it('answers a pull with the sender own project, not the most recent one', async () => {
    await openAt(shell, ROOT_A)
    const a = lastView()
    await openAt(shell, ROOT_B)
    const b = lastView()

    const pull = handlers.get('workbench:connection')
    expect(pull).toBeDefined()

    /*
     * The adversarial direction, and the only one worth asserting: a lookup
     * keyed on "the most recently opened project" passes the friendly version of
     * this test. A is asked *after* B was opened.
     */
    expect(pull?.({ sender: a.webContents })).toEqual({ ...RUNTIME, projectRoot: ROOT_A })
    expect(pull?.({ sender: b.webContents })).toEqual({ ...RUNTIME, projectRoot: ROOT_B })
  })

  it('refuses a sender it never minted a surface for', () => {
    const pull = handlers.get('workbench:connection')
    expect(() => pull?.({ sender: new FakeWebContents() })).toThrow(/unknown workbench surface/)
  })

  it('refuses to let a surface open, close or choose', async () => {
    const grant = await grantFor(shell, ROOT_B)
    await openAt(shell, ROOT_A)
    const view = lastView()

    // Not "it has no method for this" — that is a property of one preload file,
    // where the sender check is a property of the boundary.
    await expect(
      handlers.get('workbench:open')?.({ sender: view.webContents }, { grant })
    ).rejects.toThrow(/not available to a workbench surface/)
    await expect(
      handlers.get('workbench:chooseProject')?.({ sender: view.webContents }, {})
    ).rejects.toThrow(/not available to a workbench surface/)
  })

  it('is answered for the sender of the request, never for a window it names', async () => {
    const other = new FakeWebContents()
    const grant = await grantFor(shell, ROOT_A)
    const { viewId } = (await handlers.get('workbench:open')?.({ sender: shell }, { grant })) as {
      viewId: string
    }

    // The handler passes `event.sender` through as the owner, so the foreign
    // window's request is refused at the same place a direct call would be.
    await expect(handlers.get('workbench:close')?.({ sender: other }, { viewId })).rejects.toThrow(
      /belongs to this window/
    )
    await expect(handlers.get('workbench:close')?.({ sender: shell }, { viewId })).resolves.toEqual(
      { ok: true }
    )
  })
})

/**
 * §5.4's lease, from the surface's side.
 *
 * The unit of the refcount is the **project**, and the whole reason is that a
 * count over visible views reaches zero while projects are still open — with a
 * four-pane cap and no cap on open projects, switching to a fifth project would
 * kill the build running in the first one's terminal. That is the bug the plan's
 * own sentence forbids, arrived at by counting the wrong thing.
 */
describe('the shared server lease', () => {
  it('is taken before the view exists, for the canonical root', async () => {
    const before = constructed.length
    await openAt(shell, ROOT_A)
    expect(acquireWorkbenchRuntime).toHaveBeenCalledWith(ROOT_A)
    /*
     * Ordering, measured rather than asserted about.
     *
     * `viewsAtAcquire` is sampled inside the mock, so this compares the number of
     * views that existed *when the lease was taken* against the number after the
     * open. Before, not after: a workbench document that exists with nothing to
     * connect to cannot tell that state apart from a server that died. An earlier
     * draft of this compared a call-order index against a constant and could
     * never have failed, which is C-027's shape one file over.
     */
    expect(viewsAtAcquire).toBe(before)
    expect(constructed.length).toBe(before + 1)
  })

  it('carries the descriptor to that surface and to no other', async () => {
    await openAt(shell, ROOT_A)
    const a = lastView()
    await openAt(shell, ROOT_B)
    const b = lastView()
    a.webContents.emit('did-finish-load')
    b.webContents.emit('did-finish-load')

    // One shared server, so both hold the same authority and token — and each
    // still reports its own project, which is what a lookup keyed on "most
    // recently opened" would get wrong.
    expect(a.webContents.sent).toEqual([{ ...RUNTIME, projectRoot: ROOT_A }])
    expect(b.webContents.sent).toEqual([{ ...RUNTIME, projectRoot: ROOT_B }])
  })

  it('releases only when the last surface on that root goes', async () => {
    const first = await openAt(shell, ROOT_A)
    const second = await openAt(shell, ROOT_A)

    surface.closeSurface(shell as never, first)
    // Still open elsewhere, so the project is still open. Releasing here would be
    // the refcount counting views again, one level in.
    expect(releaseWorkbenchRuntime).not.toHaveBeenCalled()

    surface.closeSurface(shell as never, second)
    expect(releaseWorkbenchRuntime).toHaveBeenCalledWith(ROOT_A)
  })

  it('does not leave a lease behind when the window went away mid-acquire', async () => {
    // A 76 MB fetch is long enough for a window to close underneath it, and a
    // lease for a project nobody opened would keep a server alive for nothing.
    const grant = await grantFor(shell, ROOT_B)
    /*
     * The *same* `WebContents`, marked destroyed — not a copy of it. A spread
     * produced a different object, which `redeem` refused as a foreign window
     * before the destroyed check was ever reached, so the test passed its
     * assertion for the wrong reason and proved nothing about the lease.
     */
    shell.destroyed = true
    await expect(surface.openSurface(shell as never, { grant }, undefined)).rejects.toThrow(
      /needs a window/
    )
    expect(releaseWorkbenchRuntime).toHaveBeenCalledWith(ROOT_B)
  })
})
