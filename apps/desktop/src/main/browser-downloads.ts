import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { shell, type DownloadItem, type Event, type Session, type WebContents } from 'electron'
import {
  BROWSER_DOWNLOADS_MAX,
  BROWSER_TITLE_MAX,
  type BrowserDownload,
  type BrowserFailure,
  type BrowserPush,
} from '../shared/browser-ipc.js'

interface BrowserDownloadsDeps {
  readonly session: Session
  readonly ownerOf: (contents: WebContents) => { owner: WebContents; browserId: string } | null
  readonly mainOwner: () => WebContents | null
  readonly directory: () => string
  readonly deliver: (owner: WebContents, push: BrowserPush) => void
}

interface DownloadRecord {
  readonly id: string
  readonly browserId: string
  readonly filename: string
  readonly path: string
  readonly updated: () => void
  readonly done: (_event: Event, state: 'completed' | 'cancelled' | 'interrupted') => void
  item: DownloadItem | null
  state: BrowserDownload['state']
  received: number
  total: number
}

interface OwnerDownloads {
  readonly records: DownloadRecord[]
  readonly destroyed: () => void
  browserId: string
  timer: ReturnType<typeof setTimeout> | null
}

interface ExpectedDownload {
  readonly timer: ReturnType<typeof setTimeout>
  readonly destroyed: () => void
}

const DOWNLOAD_UPDATE_MS = 250
const DOWNLOAD_EXPECT_MS = 10_000
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

export function safeDownloadName(suggested: string, platform: string): string {
  const leaf = suggested.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const cleaned = Array.from(basename(leaf))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
  const usable = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'download' : cleaned
  const safe = platform === 'win32' && RESERVED_NAME.test(usable) ? `_${usable}` : usable
  let bounded = ''
  for (const character of safe) {
    if (
      Buffer.byteLength(bounded + character, 'utf8') > 200 ||
      bounded.length >= BROWSER_TITLE_MAX
    ) {
      break
    }
    bounded += character
  }
  return bounded.replace(/[. ]+$/, '') || 'download'
}

export function uniqueDownloadPath(
  directory: string,
  name: string,
  taken: (path: string) => boolean
): string {
  const extension = extname(name)
  const stem = extension === '' ? name : name.slice(0, -extension.length)
  let candidate = join(directory, name)
  for (let suffix = 1; taken(candidate); suffix += 1) {
    candidate = join(directory, `${stem} (${String(suffix)})${extension}`)
  }
  return candidate
}

function boundedBytes(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0
}

export class BrowserDownloads {
  private readonly deps: BrowserDownloadsDeps
  private readonly owners = new Map<WebContents, OwnerDownloads>()
  private readonly expected = new Map<WebContents, ExpectedDownload>()
  private readonly reserved = new Set<string>()
  private disposed = false

  constructor(deps: BrowserDownloadsDeps) {
    this.deps = deps
    deps.session.on('will-download', this.claim)
  }

  expect(contents: WebContents): void {
    if (this.disposed || contents.isDestroyed()) return
    this.clearExpected(contents)
    const pending: ExpectedDownload = {
      timer: setTimeout(() => {
        this.clearExpected(contents)
      }, DOWNLOAD_EXPECT_MS),
      destroyed: () => {
        this.clearExpected(contents)
      },
    }
    this.expected.set(contents, pending)
    contents.once('destroyed', pending.destroyed)
  }

  list(owner: WebContents): BrowserDownload[] {
    return (this.owners.get(owner)?.records ?? []).map((record) => ({
      id: record.id,
      filename: record.filename,
      state: record.state,
      received: record.received,
      total: record.total,
    }))
  }

  act(
    owner: WebContents,
    downloadId: string,
    action: 'open' | 'show' | 'cancel' | 'clear'
  ): BrowserFailure | null {
    const listed = this.owners.get(owner)
    const record = listed?.records.find((entry) => entry.id === downloadId)
    if (listed === undefined || record === undefined) return 'not-found'
    if (action === 'cancel') {
      record.item?.cancel()
      return null
    }
    if (action === 'clear') {
      if (record.item !== null) return 'not-eligible'
      listed.records.splice(listed.records.indexOf(record), 1)
      this.schedule(owner, listed, record.browserId)
      return null
    }
    if (record.state !== 'completed') return 'not-eligible'
    if (!existsSync(record.path)) return 'not-found'
    if (action === 'show') shell.showItemInFolder(record.path)
    else shell.openPath(record.path).catch(() => undefined)
    return null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.deps.session.off('will-download', this.claim)
    for (const contents of this.expected.keys()) this.clearExpected(contents)
    for (const [owner, listed] of this.owners) this.release(owner, listed)
    this.owners.clear()
    this.reserved.clear()
  }

  private readonly claim = (
    event: Event,
    item: DownloadItem,
    contents: WebContents | undefined
  ): void => {
    if (this.disposed || contents === undefined) return
    const expected = this.expected.has(contents)
    this.clearExpected(contents)
    const source = this.deps.ownerOf(contents)
    const owner = expected ? this.deps.mainOwner() : (source?.owner ?? null)
    if (owner === null || owner.isDestroyed()) {
      if (expected) event.preventDefault()
      return
    }
    const browserId = source?.browserId ?? String(contents.id)
    const listed = this.owner(owner, browserId)
    if (listed.records.length >= BROWSER_DOWNLOADS_MAX) {
      const finished = listed.records.findIndex((record) => record.item === null)
      if (finished === -1) {
        event.preventDefault()
        return
      }
      listed.records.splice(finished, 1)
    }
    const filename = safeDownloadName(item.getFilename(), process.platform)
    const path = uniqueDownloadPath(
      this.deps.directory(),
      filename,
      (candidate) => existsSync(candidate) || this.reserved.has(this.reservation(candidate))
    )
    this.reserved.add(this.reservation(path))
    item.setSavePath(path)
    const record: DownloadRecord = {
      id: randomUUID(),
      browserId,
      filename: basename(path),
      path,
      item,
      state: 'progressing',
      received: boundedBytes(item.getReceivedBytes()),
      total: boundedBytes(item.getTotalBytes()),
      updated: () => {
        record.state = item.isPaused() ? 'paused' : item.getState()
        record.received = boundedBytes(item.getReceivedBytes())
        record.total = boundedBytes(item.getTotalBytes())
        this.schedule(owner, listed, browserId)
      },
      done: (_event, state) => {
        record.state = state
        record.received = boundedBytes(item.getReceivedBytes())
        record.total = boundedBytes(item.getTotalBytes())
        item.off('updated', record.updated)
        item.off('done', record.done)
        record.item = null
        this.reserved.delete(this.reservation(path))
        this.schedule(owner, listed, browserId)
      },
    }
    listed.records.push(record)
    item.on('updated', record.updated)
    item.once('done', record.done)
    this.schedule(owner, listed, browserId)
  }

  private clearExpected(contents: WebContents): void {
    const pending = this.expected.get(contents)
    if (pending === undefined) return
    this.expected.delete(contents)
    clearTimeout(pending.timer)
    if (!contents.isDestroyed()) contents.off('destroyed', pending.destroyed)
  }

  private reservation(path: string): string {
    if (process.platform === 'darwin') return path.normalize('NFD').toLowerCase()
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private owner(owner: WebContents, browserId: string): OwnerDownloads {
    const existing = this.owners.get(owner)
    if (existing !== undefined) return existing
    const listed: OwnerDownloads = {
      records: [],
      browserId,
      timer: null,
      destroyed: () => {
        this.release(owner, listed)
        this.owners.delete(owner)
      },
    }
    this.owners.set(owner, listed)
    owner.once('destroyed', listed.destroyed)
    return listed
  }

  private schedule(owner: WebContents, listed: OwnerDownloads, browserId: string): void {
    if (this.disposed || owner.isDestroyed()) return
    listed.browserId = browserId
    if (listed.timer !== null) return
    listed.timer = setTimeout(() => {
      listed.timer = null
      if (this.disposed || owner.isDestroyed()) return
      this.deps.deliver(owner, {
        kind: 'downloads',
        browserId: listed.browserId,
        downloads: this.list(owner),
      })
    }, DOWNLOAD_UPDATE_MS)
  }

  private release(owner: WebContents, listed: OwnerDownloads): void {
    if (listed.timer !== null) clearTimeout(listed.timer)
    listed.timer = null
    if (!owner.isDestroyed()) owner.off('destroyed', listed.destroyed)
    for (const record of listed.records) {
      const item = record.item
      if (item === null) continue
      item.off('updated', record.updated)
      item.off('done', record.done)
      record.item = null
      item.cancel()
      this.reserved.delete(this.reservation(record.path))
    }
  }
}
