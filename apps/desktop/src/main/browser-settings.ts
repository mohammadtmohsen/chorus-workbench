import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import {
  BROWSER_FAVORITES_MAX,
  BROWSER_TITLE_MAX,
  BROWSER_URL_MAX,
  BrowserFavorite,
  BrowserIcon,
  BrowserProjectId,
  BrowserTitle,
  BrowserUrl,
  BrowserWebTabId,
  browserScrubUrl,
  isBrowserNavigable,
  type BrowserFailure,
  type BrowserSettingsStatus,
} from '../shared/browser-ipc.js'
import { WEB_TABS_MAX } from '../shared/workspace-layout.js'

export const BROWSER_SETTINGS_FILE = 'settings.json'
export const BROWSER_SETTINGS_PROJECTS_MAX = 512
export const BROWSER_SETTINGS_WEB_TABS_MAX = WEB_TABS_MAX * 2
export const BROWSER_SETTINGS_MAX_BYTES = 16 * 1024 * 1024
export const BROWSER_SETTINGS_FAVORITES_BUDGET =
  BROWSER_SETTINGS_MAX_BYTES - BROWSER_SETTINGS_PROJECTS_MAX * (BROWSER_URL_MAX + 256)
const LAST_URL_DELAY_MS = 1500
const FILE_MODE = 0o600
const READ_CHUNK_BYTES = 64 * 1024
const SETTINGS_ENVELOPE_BYTES = Buffer.byteLength(
  `${JSON.stringify({ version: 1, projects: [], webTabs: [] })}\n`,
  'utf8'
)

export function browserDataPath(userDataPath: string): string {
  return join(userDataPath, 'browser')
}

export function browserSettingsPath(userDataPath: string): string {
  return join(browserDataPath(userDataPath), BROWSER_SETTINGS_FILE)
}

export type BoundedRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'data'; readonly bytes: Buffer }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'error' }

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

export async function readBounded(path: string, maxBytes: number): Promise<BoundedRead> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' }
  }
  try {
    const { size } = await handle.stat()
    if (size > maxBytes) return { kind: 'too-large' }
    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) return { kind: 'data', bytes: Buffer.concat(chunks, total) }
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    return { kind: 'too-large' }
  } catch {
    return { kind: 'error' }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function writeAtomically(
  target: string,
  data: string | Uint8Array,
  mode: number
): Promise<void> {
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, data, { mode, flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function favoriteIdsUnique(project: { readonly favorites: readonly BrowserFavorite[] }): boolean {
  return unique(project.favorites.map((favorite) => favorite.id))
}

const StoredUrl = BrowserUrl.refine(isBrowserNavigable)

const StoredFavorite = BrowserFavorite.refine((favorite) => isBrowserNavigable(favorite.url))

const StoredProject = z
  .object({
    projectId: BrowserProjectId,
    lastUrl: StoredUrl.nullable(),
    favorites: z.array(StoredFavorite).max(BROWSER_FAVORITES_MAX),
  })
  .strict()

const StoredWebTab = z
  .object({
    id: BrowserWebTabId,
    url: StoredUrl.nullable(),
    title: BrowserTitle,
    icon: BrowserIcon.nullable(),
  })
  .strict()

const StoredSettings = z
  .object({
    version: z.literal(1),
    projects: z.array(StoredProject).max(BROWSER_SETTINGS_PROJECTS_MAX),
    webTabs: z.array(StoredWebTab).max(BROWSER_SETTINGS_WEB_TABS_MAX).default([]),
  })
  .strict()
  .refine((settings) => unique(settings.projects.map((project) => project.projectId)))
  .refine((settings) => settings.projects.every(favoriteIdsUnique))
  .refine((settings) => unique(settings.webTabs.map((tab) => tab.id)))

export interface BrowserProjectSettings {
  readonly lastUrl: string | null
  readonly favorites: readonly BrowserFavorite[]
}

export interface BrowserFavoriteInput {
  readonly url: string
  readonly title: string
  readonly icon: string | null
}

export interface BrowserProjectRead {
  readonly status: BrowserSettingsStatus
  readonly settings: BrowserProjectSettings
}

export interface BrowserWebTabPage {
  readonly url: string | null
  readonly title: string
  readonly icon: string | null
}

export interface BrowserWebTabRead {
  readonly status: BrowserSettingsStatus
  readonly page: BrowserWebTabPage
}

export interface BrowserFavoritesOutcome {
  readonly favorites: readonly BrowserFavorite[]
  readonly failure: BrowserFailure | null
}

const EMPTY: BrowserProjectSettings = { lastUrl: null, favorites: [] }
const EMPTY_WEB_PAGE: BrowserWebTabPage = Object.freeze({ url: null, title: '', icon: null })

interface SettingsBytes {
  readonly projects: Map<string, number>
  readonly webTabs: Map<string, number>
  total: number
}

type Loaded =
  | {
      readonly kind: 'ready'
      projects: Map<string, BrowserProjectSettings>
      webTabs: Map<string, BrowserWebTabPage>
      bytes: SettingsBytes
    }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'unreadable' }

type Ready = Extract<Loaded, { kind: 'ready' }>

function decode(read: BoundedRead): Loaded {
  if (read.kind === 'missing') return readySettings(new Map(), new Map())
  if (read.kind === 'error') return { kind: 'unreadable' }
  if (read.kind === 'too-large') return { kind: 'corrupt' }
  let raw: unknown
  try {
    raw = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return { kind: 'corrupt' }
  }
  const parsed = StoredSettings.safeParse(raw)
  if (!parsed.success) return { kind: 'corrupt' }
  return readySettings(
    new Map(
      parsed.data.projects.map((project): [string, BrowserProjectSettings] => [
        project.projectId,
        { lastUrl: project.lastUrl, favorites: project.favorites },
      ])
    ),
    new Map(
      parsed.data.webTabs.map((tab): [string, BrowserWebTabPage] => [
        tab.id,
        { url: tab.url, title: tab.title, icon: tab.icon },
      ])
    )
  )
}

function projectBytes(projectId: string, settings: BrowserProjectSettings): number {
  if (settings.lastUrl === null && settings.favorites.length === 0) return 0
  return Buffer.byteLength(
    JSON.stringify({ projectId, lastUrl: settings.lastUrl, favorites: settings.favorites }),
    'utf8'
  )
}

function webTabBytes(id: string, page: BrowserWebTabPage): number {
  return Buffer.byteLength(JSON.stringify({ id, ...page }), 'utf8')
}

function entryBytes(bytes: number): number {
  return bytes === 0 ? 0 : bytes + 1
}

function measureBytes(
  projects: ReadonlyMap<string, BrowserProjectSettings>,
  webTabs: ReadonlyMap<string, BrowserWebTabPage>,
  previous?: Ready
): SettingsBytes {
  const sizes: SettingsBytes = {
    projects: new Map(),
    webTabs: new Map(),
    total: SETTINGS_ENVELOPE_BYTES,
  }
  for (const [id, settings] of projects) {
    const cached =
      previous?.projects.get(id) === settings ? previous.bytes.projects.get(id) : undefined
    const bytes = cached ?? projectBytes(id, settings)
    sizes.projects.set(id, bytes)
    sizes.total += entryBytes(bytes)
  }
  for (const [id, page] of webTabs) {
    const cached = previous?.webTabs.get(id) === page ? previous.bytes.webTabs.get(id) : undefined
    const bytes = cached ?? webTabBytes(id, page)
    sizes.webTabs.set(id, bytes)
    sizes.total += entryBytes(bytes)
  }
  return sizes
}

function readySettings(
  projects: Map<string, BrowserProjectSettings>,
  webTabs: Map<string, BrowserWebTabPage>
): Ready {
  return { kind: 'ready', projects, webTabs, bytes: measureBytes(projects, webTabs) }
}

function encode(
  projects: ReadonlyMap<string, BrowserProjectSettings>,
  webTabs: ReadonlyMap<string, BrowserWebTabPage>
): string {
  const stored = StoredSettings.parse({
    version: 1,
    projects: [...projects]
      .filter(([, settings]) => settings.lastUrl !== null || settings.favorites.length > 0)
      .map(([projectId, settings]) => ({
        projectId,
        lastUrl: settings.lastUrl,
        favorites: [...settings.favorites],
      })),
    webTabs: [...webTabs].map(([id, page]) => ({ id, ...page })),
  })
  return `${JSON.stringify(stored)}\n`
}

function failureOf(kind: 'corrupt' | 'unreadable'): BrowserFailure {
  return kind === 'corrupt' ? 'settings-corrupt' : 'settings-unreadable'
}

function validProject(projectId: string): boolean {
  return BrowserProjectId.safeParse(projectId).success
}

function admissibleIcon(icon: string | null): string | null {
  return icon !== null && BrowserIcon.safeParse(icon).success ? icon : null
}

export class BrowserSettingsStore {
  private readonly path: string
  private readonly delayMs: number
  private tail: Promise<void> = Promise.resolve()
  private loaded: Loaded | null = null
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(userDataPath: string, options: { readonly lastUrlDelayMs?: number } = {}) {
    this.path = browserSettingsPath(userDataPath)
    this.delayMs = options.lastUrlDelayMs ?? LAST_URL_DELAY_MS
  }

  status(): Promise<BrowserSettingsStatus> {
    return this.run(async () => (await this.load()).kind)
  }

  project(projectId: string): Promise<BrowserProjectRead> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return { status: loaded.kind, settings: EMPTY }
      return { status: 'ready', settings: loaded.projects.get(projectId) ?? EMPTY }
    })
  }

  webTab(webTabId: string): Promise<BrowserWebTabRead> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return { status: loaded.kind, page: EMPTY_WEB_PAGE }
      return { status: 'ready', page: loaded.webTabs.get(webTabId) ?? EMPTY_WEB_PAGE }
    })
  }

  favorite(projectId: string, favoriteId: string): Promise<BrowserFavorite | null> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return null
      const favorites = loaded.projects.get(projectId)?.favorites ?? []
      return favorites.find((favorite) => favorite.id === favoriteId) ?? null
    })
  }

  setLastUrl(projectId: string, url: string | null): Promise<BrowserFailure | null> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      if (!validProject(projectId)) return 'unknown-project'
      const lastUrl = url === null ? null : browserScrubUrl(url)
      const current = loaded.projects.get(projectId)
      if ((current?.lastUrl ?? null) === lastUrl) return null
      if (current === undefined && loaded.projects.size >= BROWSER_SETTINGS_PROJECTS_MAX) {
        return 'limit'
      }
      const next = { lastUrl, favorites: current?.favorites ?? [] }
      const previousBytes = loaded.bytes.projects.get(projectId) ?? 0
      const nextBytes =
        previousBytes === 0
          ? projectBytes(projectId, next)
          : lastUrl === null && next.favorites.length === 0
            ? 0
            : previousBytes +
              Buffer.byteLength(JSON.stringify(lastUrl), 'utf8') -
              Buffer.byteLength(JSON.stringify(current?.lastUrl ?? null), 'utf8')
      const total = loaded.bytes.total - entryBytes(previousBytes) + entryBytes(nextBytes)
      if (total > BROWSER_SETTINGS_MAX_BYTES) return 'limit'
      loaded.projects.set(projectId, next)
      loaded.bytes.projects.set(projectId, nextBytes)
      loaded.bytes.total = total
      this.schedule()
      return null
    })
  }

  setWebTabPage(webTabId: string, page: BrowserWebTabPage): Promise<BrowserFailure | null> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      if (!BrowserWebTabId.safeParse(webTabId).success) return 'unknown-browser'
      const next: BrowserWebTabPage = {
        url: page.url === null ? null : browserScrubUrl(page.url),
        title: page.title.slice(0, BROWSER_TITLE_MAX),
        icon: admissibleIcon(page.icon),
      }
      const current = loaded.webTabs.get(webTabId)
      const previous = current ?? EMPTY_WEB_PAGE
      if (
        previous.url === next.url &&
        previous.title === next.title &&
        previous.icon === next.icon
      ) {
        return null
      }
      if (current === undefined && loaded.webTabs.size >= BROWSER_SETTINGS_WEB_TABS_MAX) {
        return 'limit'
      }
      const previousBytes = loaded.bytes.webTabs.get(webTabId) ?? 0
      const nextBytes = webTabBytes(webTabId, next)
      const total = loaded.bytes.total - entryBytes(previousBytes) + entryBytes(nextBytes)
      if (total > BROWSER_SETTINGS_MAX_BYTES) return 'limit'
      loaded.webTabs.set(webTabId, next)
      loaded.bytes.webTabs.set(webTabId, nextBytes)
      loaded.bytes.total = total
      this.schedule()
      return null
    })
  }

  removeWebTab(webTabId: string): Promise<BrowserFailure | null> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      if (!BrowserWebTabId.safeParse(webTabId).success) return 'unknown-browser'
      if (!loaded.webTabs.has(webTabId)) return null
      const webTabs = new Map(loaded.webTabs)
      webTabs.delete(webTabId)
      return this.write(loaded, loaded.projects, webTabs)
    })
  }

  addFavorite(projectId: string, input: BrowserFavoriteInput): Promise<BrowserFavoritesOutcome> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return { favorites: [], failure: failureOf(loaded.kind) }
      if (!validProject(projectId)) return { favorites: [], failure: 'unknown-project' }
      const current = loaded.projects.get(projectId) ?? EMPTY
      const url = browserScrubUrl(input.url)
      if (url === null) return { favorites: current.favorites, failure: 'not-eligible' }
      if (current.favorites.some((favorite) => favorite.url === url)) {
        return { favorites: current.favorites, failure: null }
      }
      if (current.favorites.length >= BROWSER_FAVORITES_MAX) {
        return { favorites: current.favorites, failure: 'limit' }
      }
      if (
        !loaded.projects.has(projectId) &&
        loaded.projects.size >= BROWSER_SETTINGS_PROJECTS_MAX
      ) {
        return { favorites: current.favorites, failure: 'limit' }
      }
      const favorite = BrowserFavorite.safeParse({
        id: randomUUID(),
        url,
        title: input.title.slice(0, BROWSER_TITLE_MAX),
        icon: admissibleIcon(input.icon),
      })
      if (!favorite.success) return { favorites: current.favorites, failure: 'failed' }
      return this.commit(loaded, projectId, {
        lastUrl: current.lastUrl,
        favorites: [...current.favorites, favorite.data],
      })
    })
  }

  removeFavorite(projectId: string, favoriteId: string): Promise<BrowserFavoritesOutcome> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return { favorites: [], failure: failureOf(loaded.kind) }
      const current = loaded.projects.get(projectId) ?? EMPTY
      const favorites = current.favorites.filter((favorite) => favorite.id !== favoriteId)
      if (favorites.length === current.favorites.length) {
        return { favorites: current.favorites, failure: 'not-found' }
      }
      return this.commit(loaded, projectId, { lastUrl: current.lastUrl, favorites })
    })
  }

  prune(
    knownProjects: ReadonlySet<string>,
    knownWebTabs: ReadonlySet<string>
  ): Promise<BrowserFailure | null> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      const projects = new Map(
        [...loaded.projects].filter(([projectId]) => knownProjects.has(projectId))
      )
      const webTabs = new Map([...loaded.webTabs].filter(([id]) => knownWebTabs.has(id)))
      if (projects.size === loaded.projects.size && webTabs.size === loaded.webTabs.size) {
        return null
      }
      return this.write(loaded, projects, webTabs)
    })
  }

  flush(): Promise<BrowserFailure | null> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.run(() => this.persist())
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async load(): Promise<Loaded> {
    if (this.loaded !== null && this.loaded.kind !== 'unreadable') return this.loaded
    this.loaded = decode(await readBounded(this.path, BROWSER_SETTINGS_MAX_BYTES))
    return this.loaded
  }

  private async commit(
    loaded: Ready,
    projectId: string,
    next: BrowserProjectSettings
  ): Promise<BrowserFavoritesOutcome> {
    const previous = loaded.projects.get(projectId)?.favorites ?? []
    const projects = new Map(loaded.projects)
    projects.set(projectId, next)
    const failure = await this.write(
      loaded,
      projects,
      loaded.webTabs,
      BROWSER_SETTINGS_FAVORITES_BUDGET
    )
    return failure === null
      ? { favorites: next.favorites, failure: null }
      : { favorites: previous, failure }
  }

  private async write(
    loaded: Ready,
    projects: Map<string, BrowserProjectSettings>,
    webTabs = loaded.webTabs,
    budget = BROWSER_SETTINGS_MAX_BYTES
  ): Promise<BrowserFailure | null> {
    let text: string
    try {
      text = encode(projects, webTabs)
    } catch {
      return 'failed'
    }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > BROWSER_SETTINGS_MAX_BYTES) return 'limit'
    const sizes = measureBytes(projects, webTabs, loaded)
    if (budget < BROWSER_SETTINGS_MAX_BYTES) {
      const pageBytes =
        [...sizes.webTabs.values()].reduce((total, size) => total + entryBytes(size), 0) -
        (webTabs.size === 0 ? 0 : 1)
      if (bytes - pageBytes > budget) return 'limit'
    }
    try {
      await writeAtomically(this.path, text, FILE_MODE)
    } catch {
      return 'failed'
    }
    loaded.projects = projects
    loaded.webTabs = webTabs
    loaded.bytes = sizes
    this.dirty = false
    return null
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(() => this.persist())
    }, this.delayMs)
  }

  private async persist(): Promise<BrowserFailure | null> {
    const loaded = this.loaded
    if (!this.dirty || loaded?.kind !== 'ready') return null
    return this.write(loaded, loaded.projects)
  }
}
