import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_FAVORITES_MAX,
  BROWSER_ICON_MAX,
  BROWSER_TITLE_MAX,
} from '../shared/browser-ipc.js'
import {
  BROWSER_SETTINGS_MAX_BYTES,
  BROWSER_SETTINGS_FAVORITES_BUDGET,
  BROWSER_SETTINGS_WEB_TABS_MAX,
  BrowserSettingsStore,
  browserSettingsPath,
  readBounded,
} from './browser-settings.js'

let profile: string

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'chorus-browser-settings-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(profile, { recursive: true, force: true })
})

function page(url: string): { url: string; title: string; icon: null } {
  return { url, title: 'Page', icon: null }
}

const EMPTY = { status: 'ready', settings: { lastUrl: null, favorites: [] } }
const EMPTY_WEB = { status: 'ready', page: { url: null, title: '', icon: null } }

describe('bounded reads', () => {
  it('accepts a file at the cap and refuses one past it', async () => {
    const path = join(profile, 'sample.bin')
    writeFileSync(path, Buffer.alloc(10, 1))
    expect(await readBounded(path, 10)).toEqual({ kind: 'data', bytes: Buffer.alloc(10, 1) })
    writeFileSync(path, Buffer.alloc(11, 1))
    expect(await readBounded(path, 10)).toEqual({ kind: 'too-large' })
    expect(await readBounded(join(profile, 'absent.bin'), 10)).toEqual({ kind: 'missing' })
  })

  it('reassembles a file larger than one read chunk', async () => {
    const path = join(profile, 'large.bin')
    const bytes = Buffer.alloc(200 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    writeFileSync(path, bytes)
    const read = await readBounded(path, 300 * 1024)
    expect(read.kind === 'data' && read.bytes.equals(bytes)).toBe(true)
  })
})

describe('browser settings', () => {
  it('reads a missing file as empty', async () => {
    const store = new BrowserSettingsStore(profile)
    expect(await store.status()).toBe('ready')
    expect(await store.project('p1')).toEqual(EMPTY)
  })

  it('keeps simultaneous favorites for different projects', async () => {
    const store = new BrowserSettingsStore(profile)
    const results = await Promise.all([
      store.addFavorite('p1', page('https://one.example.com/')),
      store.addFavorite('p2', page('https://two.example.com/')),
      store.addFavorite('p1', page('https://three.example.com/')),
    ])
    expect(results.map((result) => result.failure)).toEqual([null, null, null])
    const reopened = new BrowserSettingsStore(profile)
    const first = await reopened.project('p1')
    const second = await reopened.project('p2')
    expect(first.settings.favorites.map((favorite) => favorite.url)).toEqual([
      'https://one.example.com/',
      'https://three.example.com/',
    ])
    expect(second.settings.favorites.map((favorite) => favorite.url)).toEqual([
      'https://two.example.com/',
    ])
  })

  it('persists a scrubbed last address only after a flush', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    expect(await store.setLastUrl('p1', 'https://app.example.com/cb?code=secret&view=1')).toBeNull()
    expect(await new BrowserSettingsStore(profile).project('p1')).toEqual(EMPTY)
    expect(await store.flush()).toBeNull()
    expect(readFileSync(browserSettingsPath(profile), 'utf8')).not.toContain('secret')
    const reopened = await new BrowserSettingsStore(profile).project('p1')
    expect(reopened.settings.lastUrl).toBe('https://app.example.com/cb?view=1')
  })

  it('never replaces a corrupt file', async () => {
    const corrupt = '{"version":1,"projects":['
    mkdirSync(join(profile, 'browser'), { recursive: true })
    writeFileSync(browserSettingsPath(profile), corrupt, 'utf8')
    const store = new BrowserSettingsStore(profile)
    expect(await store.status()).toBe('corrupt')
    expect((await store.addFavorite('p1', page('https://example.com/'))).failure).toBe(
      'settings-corrupt'
    )
    expect(await store.setLastUrl('p1', 'https://example.com/')).toBe('settings-corrupt')
    await store.flush()
    expect(readFileSync(browserSettingsPath(profile), 'utf8')).toBe(corrupt)
  })

  it('treats a saved non-web address or favorite as corrupt and keeps the file', async () => {
    const favorite = { id: 'f1', url: 'javascript:alert(1)', title: 'x', icon: null }
    const tampered = [
      { projectId: 'p1', lastUrl: 'file:///etc/passwd', favorites: [] },
      { projectId: 'p1', lastUrl: null, favorites: [favorite] },
    ].map((project) => JSON.stringify({ version: 1, projects: [project] }))
    mkdirSync(join(profile, 'browser'), { recursive: true })
    for (const text of tampered) {
      writeFileSync(browserSettingsPath(profile), text, 'utf8')
      const store = new BrowserSettingsStore(profile)
      expect(await store.status()).toBe('corrupt')
      expect(await store.prune(new Set(), new Set())).toBe('settings-corrupt')
      await store.flush()
      expect(readFileSync(browserSettingsPath(profile), 'utf8')).toBe(text)
    }
  })

  it('treats project ids as data rather than object keys', async () => {
    const store = new BrowserSettingsStore(profile)
    expect((await store.addFavorite('__proto__', page('https://example.com/'))).failure).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect((await reopened.project('__proto__')).settings.favorites).toHaveLength(1)
    expect(await reopened.project('constructor')).toEqual(EMPTY)
    expect(Object.prototype).not.toHaveProperty('favorites')
  })

  it('prunes only projects outside the authoritative set', async () => {
    const store = new BrowserSettingsStore(profile)
    await store.addFavorite('keep', page('https://keep.example.com/'))
    await store.addFavorite('gone', page('https://gone.example.com/'))
    expect(await store.prune(new Set(['keep']), new Set())).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect((await reopened.project('keep')).settings.favorites).toHaveLength(1)
    expect(await reopened.project('gone')).toEqual(EMPTY)
  })

  it('refuses favorites that are not web pages', async () => {
    const store = new BrowserSettingsStore(profile)
    expect((await store.addFavorite('p1', page('javascript:alert(1)'))).failure).toBe(
      'not-eligible'
    )
    expect((await store.addFavorite('p1', page('file:///etc/passwd'))).failure).toBe('not-eligible')
  })
})

describe('web tab settings', () => {
  it('reads missing pages and old files without webTabs as empty', async () => {
    expect(await new BrowserSettingsStore(profile).webTab('web-1')).toEqual(EMPTY_WEB)
    mkdirSync(join(profile, 'browser'), { recursive: true })
    writeFileSync(
      browserSettingsPath(profile),
      JSON.stringify({
        version: 1,
        projects: [{ projectId: 'p1', lastUrl: 'https://example.com/', favorites: [] }],
      })
    )
    const store = new BrowserSettingsStore(profile)
    expect(await store.status()).toBe('ready')
    expect(await store.webTab('web-1')).toEqual(EMPTY_WEB)
    expect((await store.project('p1')).settings.lastUrl).toBe('https://example.com/')
  })

  it('round-trips queued pages through project writes and a flush', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    const first = { ...page('https://one.example.com/'), icon: 'data:image/png;base64,AA==' }
    const second = page('https://two.example.com/')
    expect(
      await Promise.all([store.setWebTabPage('web-1', first), store.setWebTabPage('web-2', second)])
    ).toEqual([null, null])
    const added = await store.addFavorite('p1', page('https://favorite.example.com/'))
    expect(added.failure).toBeNull()
    expect(await store.setLastUrl('p1', 'https://project.example.com/')).toBeNull()
    expect(await store.flush()).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect(await reopened.webTab('web-1')).toEqual({ status: 'ready', page: first })
    expect(await reopened.webTab('web-2')).toEqual({ status: 'ready', page: second })
    expect((await reopened.project('p1')).settings.lastUrl).toBe('https://project.example.com/')
    const favorite = added.favorites[0]
    expect(favorite).toBeDefined()
    expect((await store.removeFavorite('p1', favorite?.id ?? '')).failure).toBeNull()
    expect(await new BrowserSettingsStore(profile).webTab('web-1')).toEqual({
      status: 'ready',
      page: first,
    })
  })

  it('scrubs URL credentials and bounds page metadata before saving', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    expect(
      await store.setWebTabPage('web-1', {
        url: 'https://user:secret@app.example.com/cb?code=secret&view=1#access_token=secret',
        title: 'x'.repeat(BROWSER_TITLE_MAX + 1),
        icon: 'https://app.example.com/icon.png',
      })
    ).toBeNull()
    expect(await store.flush()).toBeNull()
    expect(readFileSync(browserSettingsPath(profile), 'utf8')).not.toContain('secret')
    expect(await new BrowserSettingsStore(profile).webTab('web-1')).toEqual({
      status: 'ready',
      page: {
        url: 'https://app.example.com/cb?view=1',
        title: 'x'.repeat(BROWSER_TITLE_MAX),
        icon: null,
      },
    })
    expect(await store.setWebTabPage('web-2', page('javascript:x'))).toBeNull()
    expect((await store.webTab('web-2')).page.url).toBeNull()
    expect(await store.flush()).toBeNull()
  })

  it('coalesces page updates until the scheduled save', async () => {
    vi.useFakeTimers()
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 1500 })
    await store.setWebTabPage('web-1', page('https://first.example.com/'))
    const latest = page('https://last.example.com/')
    await store.setWebTabPage('web-1', latest)
    await vi.advanceTimersByTimeAsync(1499)
    expect(await new BrowserSettingsStore(profile).webTab('web-1')).toEqual(EMPTY_WEB)
    await vi.advanceTimersByTimeAsync(1)
    expect(await store.status()).toBe('ready')
    expect(await new BrowserSettingsStore(profile).webTab('web-1')).toEqual({
      status: 'ready',
      page: latest,
    })
    expect(await store.flush()).toBeNull()
  })

  it('does not serialize unrelated settings while updating a page or project address', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    const kept = { ...page('https://keep.example.com/'), title: 'Kept page' }
    await store.setWebTabPage('web-kept', kept)
    await store.addFavorite('p1', page('https://favorite.example.com/'))
    await store.setLastUrl('p1', 'https://first.example.com/')
    await store.flush()
    const updated = { ...page('https://updated.example.com/'), title: 'Updated "page" 😀' }
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(await store.setWebTabPage('web-updated', updated)).toBeNull()
      expect(await store.setLastUrl('p1', 'https://last.example.com/')).toBeNull()
      const values: unknown[] = stringify.mock.calls.map(([value]): unknown => value)
      expect(
        values.some(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            ('projects' in value ||
              'favorites' in value ||
              ('id' in value && value.id === 'web-kept'))
        )
      ).toBe(false)
    } finally {
      stringify.mockRestore()
    }
    expect(await store.flush()).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect((await reopened.webTab('web-kept')).page).toEqual(kept)
    expect((await reopened.webTab('web-updated')).page).toEqual(updated)
    expect((await reopened.project('p1')).settings.lastUrl).toBe('https://last.example.com/')
  })

  it('removes a page without dropping other pages or project settings', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    await store.setWebTabPage('web-1', page('https://one.example.com/'))
    const kept = page('https://two.example.com/')
    await store.setWebTabPage('web-2', kept)
    await store.addFavorite('p1', page('https://project.example.com/'))
    expect(await store.removeWebTab('web-1')).toBeNull()
    expect(await store.removeWebTab('web-1')).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect(await reopened.webTab('web-1')).toEqual(EMPTY_WEB)
    expect(await reopened.webTab('web-2')).toEqual({ status: 'ready', page: kept })
    expect((await reopened.project('p1')).settings.favorites).toHaveLength(1)
    expect(await store.flush()).toBeNull()
  })

  it('prunes pages and projects against their separate authoritative sets', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    const kept = page('https://keep.example.com/')
    await store.setWebTabPage('web-keep', kept)
    await store.setWebTabPage('web-gone', page('https://gone.example.com/'))
    await store.addFavorite('project-keep', kept)
    await store.addFavorite('project-gone', page('https://gone.example.com/'))
    expect(await store.prune(new Set(['project-keep']), new Set(['web-keep']))).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect(await reopened.webTab('web-keep')).toEqual({ status: 'ready', page: kept })
    expect(await reopened.webTab('web-gone')).toEqual(EMPTY_WEB)
    expect((await reopened.project('project-keep')).settings.favorites).toHaveLength(1)
    expect(await reopened.project('project-gone')).toEqual(EMPTY)
    expect(await store.flush()).toBeNull()
  })

  it('leaves malformed present webTabs byte-identical', async () => {
    const saved = { id: 'web-1', ...page('https://example.com/') }
    const malformed = [
      null,
      {},
      'web-1',
      [null],
      [{ ...saved, id: 'bad/id' }],
      [{ ...saved, url: 'file:///etc/passwd' }],
      [{ ...saved, title: 'x'.repeat(BROWSER_TITLE_MAX + 1) }],
      [{ ...saved, icon: 'https://example.com/icon.png' }],
      [{ ...saved, password: 'x' }],
      [saved, saved],
      Array.from({ length: BROWSER_SETTINGS_WEB_TABS_MAX + 1 }, (_, index) => ({
        ...saved,
        id: `web-${String(index)}`,
      })),
    ]
    mkdirSync(join(profile, 'browser'), { recursive: true })
    for (const webTabs of malformed) {
      const bytes = Buffer.from(JSON.stringify({ version: 1, projects: [], webTabs }))
      writeFileSync(browserSettingsPath(profile), bytes)
      const store = new BrowserSettingsStore(profile)
      expect(await store.status()).toBe('corrupt')
      expect(await store.webTab('web-1')).toEqual({ ...EMPTY_WEB, status: 'corrupt' })
      expect(await store.setWebTabPage('web-1', page('https://replacement.example.com/'))).toBe(
        'settings-corrupt'
      )
      expect(await store.removeWebTab('web-1')).toBe('settings-corrupt')
      expect(await store.prune(new Set(), new Set())).toBe('settings-corrupt')
      await store.flush()
      expect(readFileSync(browserSettingsPath(profile))).toEqual(bytes)
    }
  })

  it('keeps ids unique and refuses invalid ids or pages over the record limit', async () => {
    const store = new BrowserSettingsStore(profile, { lastUrlDelayMs: 60_000 })
    for (const id of ['', 'bad/id', 'a'.repeat(129)]) {
      expect(await store.setWebTabPage(id, page('https://example.com/'))).toBe('unknown-browser')
      expect(await store.removeWebTab(id)).toBe('unknown-browser')
    }
    for (let index = 0; index < BROWSER_SETTINGS_WEB_TABS_MAX; index += 1) {
      expect(
        await store.setWebTabPage(
          `web-${String(index)}`,
          page(`https://example.com/${String(index)}`)
        )
      ).toBeNull()
    }
    expect(await store.setWebTabPage('web-extra', page('https://extra.example.com/'))).toBe('limit')
    const latest = page('https://updated.example.com/')
    expect(await store.setWebTabPage('web-0', latest)).toBeNull()
    expect(await store.flush()).toBeNull()
    const saved: unknown = JSON.parse(readFileSync(browserSettingsPath(profile), 'utf8'))
    expect(saved).toMatchObject({
      webTabs: expect.arrayContaining([{ id: 'web-0', ...latest }]),
    })
    expect(await new BrowserSettingsStore(profile).webTab('web-extra')).toEqual(EMPTY_WEB)
    expect(await new BrowserSettingsStore(profile).webTab('web-0')).toEqual({
      status: 'ready',
      page: latest,
    })
  })

  it('refuses page updates that exceed the shared byte budget', async () => {
    const prefix = 'data:image/png;base64,'
    const icon = prefix + 'A'.repeat(BROWSER_ICON_MAX - prefix.length)
    const favorites = Array.from({ length: 510 }, (_, index) => ({
      id: `favorite-${String(index)}`,
      ...page('https://example.com/'),
      icon,
    }))
    const projects = Array.from(
      { length: Math.ceil(favorites.length / BROWSER_FAVORITES_MAX) },
      (_, index) => ({
        projectId: `project-${String(index)}`,
        lastUrl: null,
        favorites: favorites.slice(
          index * BROWSER_FAVORITES_MAX,
          (index + 1) * BROWSER_FAVORITES_MAX
        ),
      })
    )
    const saved = { version: 1, projects, webTabs: [] }
    const bytes = Buffer.from(JSON.stringify(saved))
    const oversized = { id: 'web-1', ...page('https://example.com/'), icon }
    expect(bytes.length).toBeLessThan(BROWSER_SETTINGS_MAX_BYTES)
    expect(Buffer.byteLength(JSON.stringify({ ...saved, webTabs: [oversized] }))).toBeGreaterThan(
      BROWSER_SETTINGS_MAX_BYTES
    )
    mkdirSync(join(profile, 'browser'), { recursive: true })
    writeFileSync(browserSettingsPath(profile), bytes)
    const store = new BrowserSettingsStore(profile)
    expect(await store.status()).toBe('ready')
    expect(await store.setWebTabPage('web-1', oversized)).toBe('limit')
    expect(await store.webTab('web-1')).toEqual(EMPTY_WEB)
    expect(await store.flush()).toBeNull()
    expect(readFileSync(browserSettingsPath(profile)).equals(bytes)).toBe(true)
    expect(
      await store.prune(new Set(projects.slice(1).map((project) => project.projectId)), new Set())
    ).toBeNull()
    expect(await store.setWebTabPage('web-1', oversized)).toBeNull()
    expect(await store.flush()).toBeNull()
    expect(await new BrowserSettingsStore(profile).webTab('web-1')).toEqual({
      status: 'ready',
      page: { ...page('https://example.com/'), icon },
    })
    expect(readFileSync(browserSettingsPath(profile)).length).toBeLessThan(
      BROWSER_SETTINGS_MAX_BYTES
    )
  })

  it('keeps page bytes separate from favorites under the shared file cap', async () => {
    const prefix = 'data:image/png;base64,'
    const icon = prefix + 'A'.repeat(BROWSER_ICON_MAX - prefix.length)
    const favorites = Array.from({ length: 200 }, (_, index) => ({
      id: `favorite-${String(index)}`,
      ...page('https://example.com/'),
      icon,
    }))
    const projects = Array.from(
      { length: Math.ceil(favorites.length / BROWSER_FAVORITES_MAX) },
      (_, index) => ({
        projectId: `project-${String(index)}`,
        lastUrl: null,
        favorites: favorites.slice(
          index * BROWSER_FAVORITES_MAX,
          (index + 1) * BROWSER_FAVORITES_MAX
        ),
      })
    )
    const webTabs = Array.from({ length: BROWSER_SETTINGS_WEB_TABS_MAX }, (_, index) => ({
      id: `web-${String(index)}`,
      ...page('https://example.com/'),
      icon,
    }))
    const bytes = Buffer.from(JSON.stringify({ version: 1, projects, webTabs }))
    expect(bytes.length).toBeGreaterThan(BROWSER_SETTINGS_FAVORITES_BUDGET)
    expect(bytes.length).toBeLessThan(BROWSER_SETTINGS_MAX_BYTES)
    mkdirSync(join(profile, 'browser'), { recursive: true })
    writeFileSync(browserSettingsPath(profile), bytes)
    const store = new BrowserSettingsStore(profile)
    const added = await store.addFavorite('new-project', page('https://new.example.com/'))
    expect(added.failure).toBeNull()
    expect((await store.removeFavorite('project-0', 'favorite-0')).failure).toBeNull()
    const reopened = new BrowserSettingsStore(profile)
    expect(await reopened.webTab('web-0')).toEqual({
      status: 'ready',
      page: { ...page('https://example.com/'), icon },
    })
    expect((await reopened.project('project-0')).settings.favorites).toHaveLength(
      BROWSER_FAVORITES_MAX - 1
    )
    expect((await reopened.project('new-project')).settings.favorites).toHaveLength(1)
    expect(readFileSync(browserSettingsPath(profile)).length).toBeLessThan(
      BROWSER_SETTINGS_MAX_BYTES
    )
  })
})
