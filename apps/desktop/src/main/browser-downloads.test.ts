import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_DOWNLOADS_MAX, type BrowserPush } from '../shared/browser-ipc.js'
import { BrowserDownloads, safeDownloadName, uniqueDownloadPath } from './browser-downloads.js'

const harness = vi.hoisted(() => ({
  exists: vi.fn(() => false),
  open: vi.fn(() => Promise.resolve('')),
  show: vi.fn(),
}))

vi.mock('node:fs', () => ({ existsSync: harness.exists }))
vi.mock('electron', () => ({ shell: { openPath: harness.open, showItemInFolder: harness.show } }))

class Item extends EventEmitter {
  path: string | null = null
  received = 0
  total = 100
  paused = false
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing'
  readonly cancel = vi.fn(() => {
    this.state = 'cancelled'
    this.emit('done', {}, this.state)
  })

  constructor(readonly name: string) {
    super()
  }
  getFilename(): string {
    return this.name
  }
  setSavePath(path: string): void {
    this.path = path
  }
  getReceivedBytes(): number {
    return this.received
  }
  getTotalBytes(): number {
    return this.total
  }
  getState(): typeof this.state {
    return this.state
  }
  isPaused(): boolean {
    return this.paused
  }
}

let nextContentsId = 1

class Owner extends EventEmitter {
  readonly id = nextContentsId++

  isDestroyed(): boolean {
    return false
  }
}

const opened: BrowserDownloads[] = []
const DIRECTORY = join('/downloads')

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  harness.exists.mockReturnValue(false)
})

afterEach(() => {
  for (const downloads of opened.splice(0)) downloads.dispose()
  vi.useRealTimers()
})

function setup(main?: Owner | null) {
  const session = new EventEmitter()
  const owner = new Owner()
  const mainOwner = main === undefined ? owner : main
  const contents = new Owner() as unknown as WebContents
  const sources = new Map<WebContents, { owner: WebContents; browserId: string }>([
    [contents, { owner: owner as unknown as WebContents, browserId: 'tab-1' }],
  ])
  const pushes: BrowserPush[] = []
  const delivered: { readonly owner: WebContents; readonly push: BrowserPush }[] = []
  const downloads = new BrowserDownloads({
    session: session as unknown as Session,
    ownerOf: (source) => sources.get(source) ?? null,
    mainOwner: () => (mainOwner === null ? null : (mainOwner as unknown as WebContents)),
    directory: () => DIRECTORY,
    deliver: (owner, push) => {
      pushes.push(push)
      delivered.push({ owner, push })
    },
  })
  opened.push(downloads)
  const claim = (item: Item, source = contents) => {
    const event = { preventDefault: vi.fn() }
    session.emit('will-download', event, item, source)
    return event
  }
  const list = () => downloads.list(owner as unknown as WebContents)
  return { session, owner, contents, sources, pushes, delivered, downloads, claim, list }
}

describe('download filenames', () => {
  it.each(['CON', 'con.txt', 'PRN', 'AUX.json', 'NUL', 'COM1.zip', 'COM9', 'LPT1', 'lpt9.log'])(
    'renames reserved Windows device name %s',
    (name) => {
      expect(safeDownloadName(name, 'win32')).toBe(`_${name}`)
    }
  )

  it('strips paths, forbidden characters and trailing dots and spaces', () => {
    expect(safeDownloadName('C:\\temp\\a:b?c*.txt... ', 'win32')).toBe('abc.txt')
    expect(safeDownloadName('/tmp/..', 'win32')).toBe('download')
    expect(safeDownloadName('COM10.txt', 'win32')).toBe('COM10.txt')
    expect(safeDownloadName('CON.txt', 'linux')).toBe('CON.txt')
    expect(
      Buffer.byteLength(safeDownloadName('界'.repeat(300), 'linux'), 'utf8')
    ).toBeLessThanOrEqual(200)
  })

  it('keeps the extension when choosing a path after taken names', () => {
    const taken = new Set([join(DIRECTORY, 'file.tar.gz'), join(DIRECTORY, 'file.tar (1).gz')])
    expect(uniqueDownloadPath(DIRECTORY, 'file.tar.gz', (path) => taken.has(path))).toBe(
      join(DIRECTORY, 'file.tar (2).gz')
    )
  })
})

describe('owned browser downloads', () => {
  it('reserves in-flight paths before the files exist', () => {
    const { claim, list } = setup()
    const first = new Item('same.txt')
    const second = new Item('same.txt')
    claim(first)
    claim(second)
    expect(first.path).toBe(join(DIRECTORY, 'same.txt'))
    expect(second.path).toBe(join(DIRECTORY, 'same (1).txt'))
    expect(list().map((entry) => entry.filename)).toEqual(['same.txt', 'same (1).txt'])
  })

  it('avoids concurrent case collisions on Windows and macOS', () => {
    const { claim } = setup()
    const first = new Item('report.pdf')
    const second = new Item('REPORT.pdf')
    claim(first)
    claim(second)
    expect(second.path).toBe(
      process.platform === 'win32' || process.platform === 'darwin'
        ? join(DIRECTORY, 'REPORT (1).pdf')
        : join(DIRECTORY, 'REPORT.pdf')
    )
  })

  it('evicts the oldest finished item while keeping every in-progress item', () => {
    const { claim, list } = setup()
    const running = new Item('running.txt')
    const finished = new Item('finished.txt')
    claim(running)
    claim(finished)
    finished.state = 'completed'
    finished.emit('done', {}, 'completed')
    for (let index = 2; index <= BROWSER_DOWNLOADS_MAX; index += 1) {
      claim(new Item(`file-${String(index)}.txt`))
    }
    expect(list()).toHaveLength(BROWSER_DOWNLOADS_MAX)
    expect(list().some((entry) => entry.filename === 'running.txt')).toBe(true)
    expect(list().some((entry) => entry.filename === 'finished.txt')).toBe(false)
    const overflow = new Item('overflow.txt')
    expect(claim(overflow).preventDefault).toHaveBeenCalledOnce()
    expect(overflow.path).toBeNull()
    expect(list()).toHaveLength(BROWSER_DOWNLOADS_MAX)
  })

  it('leaves downloads from unowned contents to Electron', () => {
    const { claim, list } = setup()
    const item = new Item('unowned.txt')
    const event = claim(item, {} as WebContents)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(item.path).toBeNull()
    expect(list()).toEqual([])
  })

  it('claims an explicit project-panel save into the main owner Downloads list', () => {
    const main = new Owner()
    const { contents, sources, downloads, claim, list, delivered } = setup(main)
    sources.delete(contents)
    downloads.expect(contents)
    const item = new Item('project.pdf')
    const event = claim(item)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(item.path).toBe(join(DIRECTORY, 'project.pdf'))
    expect(list()).toEqual([])
    const mainList = downloads.list(main as unknown as WebContents)
    expect(mainList).toMatchObject([{ filename: 'project.pdf', state: 'progressing' }])
    vi.advanceTimersByTime(250)
    expect(delivered).toEqual([
      {
        owner: main,
        push: { kind: 'downloads', browserId: String(contents.id), downloads: mainList },
      },
    ])
    const next = new Item('ordinary.pdf')
    expect(claim(next).preventDefault).not.toHaveBeenCalled()
    expect(next.path).toBeNull()
    expect(downloads.list(main as unknown as WebContents)).toHaveLength(1)
  })

  it('leaves an unexpected project-panel download to the default dialog', () => {
    const { contents, sources, downloads, claim, owner } = setup()
    sources.delete(contents)
    const item = new Item('ordinary.pdf')
    expect(claim(item).preventDefault).not.toHaveBeenCalled()
    expect(item.path).toBeNull()
    expect(downloads.list(owner as unknown as WebContents)).toEqual([])
  })

  it('expires an unclaimed explicit save after ten seconds', () => {
    const { contents, sources, downloads, claim, list } = setup()
    sources.delete(contents)
    downloads.expect(contents)
    expect(contents.listenerCount('destroyed')).toBe(1)
    vi.advanceTimersByTime(9_999)
    expect(contents.listenerCount('destroyed')).toBe(1)
    vi.advanceTimersByTime(1)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const item = new Item('expired.pdf')
    expect(claim(item).preventDefault).not.toHaveBeenCalled()
    expect(item.path).toBeNull()
    expect(list()).toEqual([])
  })

  it('clears an expectation when its contents is destroyed', () => {
    const { contents, sources, downloads, claim } = setup()
    sources.delete(contents)
    downloads.expect(contents)
    contents.emit('destroyed')
    expect(vi.getTimerCount()).toBe(0)
    const item = new Item('closed.pdf')
    expect(claim(item).preventDefault).not.toHaveBeenCalled()
    expect(item.path).toBeNull()
  })

  it('clears expectation timers and listeners on dispose', () => {
    const { contents, downloads } = setup()
    downloads.expect(contents)
    expect(contents.listenerCount('destroyed')).toBe(1)
    downloads.dispose()
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses an explicit save when the main window no longer exists', () => {
    const { contents, sources, downloads, claim, list } = setup(null)
    sources.delete(contents)
    downloads.expect(contents)
    const item = new Item('closed.pdf')
    expect(claim(item).preventDefault).toHaveBeenCalledOnce()
    expect(item.path).toBeNull()
    expect(list()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('coalesces progress pushes to one owner update every 250 ms', () => {
    const { claim, pushes, list, sources, contents } = setup()
    const item = new Item('progress.txt')
    claim(item)
    sources.delete(contents)
    item.received = 10
    item.emit('updated', {}, 'progressing')
    item.received = 40
    item.emit('updated', {}, 'progressing')
    vi.advanceTimersByTime(249)
    expect(pushes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(pushes).toEqual([{ kind: 'downloads', browserId: 'tab-1', downloads: list() }])
    expect(list()[0]?.received).toBe(40)
    item.paused = true
    item.emit('updated', {}, 'progressing')
    vi.advanceTimersByTime(250)
    expect(pushes).toHaveLength(2)
    expect(list()[0]?.state).toBe('paused')
  })

  it('authorizes actions by owner and exposes only metadata', () => {
    const { claim, downloads, list, owner } = setup()
    const item = new Item('file.txt')
    claim(item)
    const id = list()[0]?.id ?? ''
    const owned = owner as unknown as WebContents
    expect(downloads.act({} as WebContents, id, 'cancel')).toBe('not-found')
    expect(downloads.act(owned, id, 'clear')).toBe('not-eligible')
    item.state = 'completed'
    item.received = 100
    item.emit('done', {}, 'completed')
    expect(list()[0]).toEqual({
      id,
      filename: 'file.txt',
      state: 'completed',
      received: 100,
      total: 100,
    })
    expect(downloads.act(owned, id, 'open')).toBe('not-found')
    harness.exists.mockReturnValue(true)
    expect(downloads.act(owned, id, 'open')).toBeNull()
    expect(harness.open).toHaveBeenCalledWith(join(DIRECTORY, 'file.txt'))
    expect(downloads.act(owned, id, 'show')).toBeNull()
    expect(harness.show).toHaveBeenCalledWith(join(DIRECTORY, 'file.txt'))
    expect(downloads.act(owned, id, 'clear')).toBeNull()
    expect(list()).toEqual([])
  })

  it('cancels an in-progress item and releases its filename reservation', () => {
    const { claim, downloads, owner, list } = setup()
    const item = new Item('cancel.txt')
    claim(item)
    expect(downloads.act(owner as unknown as WebContents, list()[0]?.id ?? '', 'cancel')).toBeNull()
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(list()[0]?.state).toBe('cancelled')
    const next = new Item('cancel.txt')
    claim(next)
    expect(next.path).toBe(join(DIRECTORY, 'cancel.txt'))
  })

  it('clears timers and session/item listeners on dispose', () => {
    const { claim, downloads, session, pushes } = setup()
    const item = new Item('active.txt')
    claim(item)
    expect(session.listenerCount('will-download')).toBe(1)
    downloads.dispose()
    downloads.dispose()
    expect(session.listenerCount('will-download')).toBe(0)
    expect(item.listenerCount('updated')).toBe(0)
    expect(item.listenerCount('done')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(pushes).toEqual([])
  })

  it('releases downloads when their owning window is destroyed', () => {
    const { claim, owner, list } = setup()
    const item = new Item('active.txt')
    claim(item)
    owner.emit('destroyed')
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(list()).toEqual([])
  })
})
