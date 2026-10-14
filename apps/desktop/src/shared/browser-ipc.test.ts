import { describe, expect, it } from 'vitest'
import {
  BROWSER_CONTRACT,
  BROWSER_ADDRESS_MAX,
  BROWSER_DOWNLOADS_MAX,
  BROWSER_FIND_MAX,
  BROWSER_RECT_MAX,
  BROWSER_SEARCH_MAX,
  BROWSER_TITLE_MAX,
  BROWSER_WHEEL_DELTA_MAX,
  BrowserDownload,
  BrowserDownloads,
  BrowserPageFill,
  BrowserPageForm,
  BrowserPageRowWheel,
  BrowserPageScan,
  BrowserPasswordAccount,
  BrowserPasswords,
  BrowserPoint,
  BrowserPush,
  BrowserScope,
  BrowserState,
  browserAddress,
  browserAddressOrSearch,
  browserPasswordOrigin,
  browserScrubUrl,
  browserSearchUrl,
  browserWebCommand,
  browserZoomStep,
  isBrowserNavigable,
  isLoopbackHostname,
  type BrowserKeyInput,
  type BrowserWebCommand,
} from './browser-ipc.js'
import { WEB_TABS_MAX } from './workspace-layout.js'

describe('browser origin policy', () => {
  it('treats only real loopback names as loopback', () => {
    for (const host of [
      'localhost',
      'localhost.',
      'app.localhost',
      'app.localhost.',
      '127.0.0.1',
      '127.45.6.7',
      '[::1]',
    ]) {
      expect(isLoopbackHostname(host)).toBe(true)
    }
    for (const host of [
      'localhost..',
      'localhost.evil.com',
      'evil-localhost',
      '127.0.0.1.evil.com',
      '128.0.0.1',
      '127.0.0.256',
      '[::ffff:7f00:1]',
    ]) {
      expect(isLoopbackHostname(host)).toBe(false)
    }
  })

  it('admits https and loopback http origins', () => {
    expect(browserPasswordOrigin('https://jira.example.com/login?next=/')).toBe(
      'https://jira.example.com'
    )
    expect(browserPasswordOrigin('http://localhost:3000/sign-in')).toBe('http://localhost:3000')
    expect(browserPasswordOrigin('http://127.1:5173/')).toBe('http://127.0.0.1:5173')
    expect(browserPasswordOrigin('http://[::1]:8080/')).toBe('http://[::1]:8080')
    for (const url of [
      'http://example.com/login',
      'http://localhost.evil.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
    ]) {
      expect(browserPasswordOrigin(url)).toBeNull()
    }
  })

  it('admits http on private local-network addresses only', () => {
    expect(browserPasswordOrigin('http://192.168.1.23:30010/login')).toBe(
      'http://192.168.1.23:30010'
    )
    const accepted = Object.entries({
      'http://10.0.0.1/': 'http://10.0.0.1',
      'http://10.255.255.255:8080/': 'http://10.255.255.255:8080',
      'http://172.16.0.1/': 'http://172.16.0.1',
      'http://172.31.255.254/': 'http://172.31.255.254',
      'http://192.168.0.1/': 'http://192.168.0.1',
      'http://192.168.255.255/': 'http://192.168.255.255',
    })
    for (const [url, origin] of accepted) expect(browserPasswordOrigin(url)).toBe(origin)
    for (const url of [
      'http://9.255.255.255/',
      'http://11.0.0.1/',
      'http://172.15.255.255/',
      'http://172.32.0.1/',
      'http://192.167.1.1/',
      'http://192.169.1.1/',
      'http://8.8.8.8/',
      'http://192.168.1.23.evil.com/',
      'http://10.0.0.1.nip.io/',
      'http://lan-192-168-1-23.example.com/',
    ]) {
      expect(browserPasswordOrigin(url)).toBeNull()
    }
    expect(isLoopbackHostname('192.168.1.23')).toBe(false)
  })

  it('keeps scheme, host and port distinct', () => {
    expect(browserPasswordOrigin('https://example.com:8443/')).not.toBe(
      browserPasswordOrigin('https://example.com/')
    )
    expect(browserPasswordOrigin('http://localhost:3000/')).not.toBe(
      browserPasswordOrigin('https://localhost:3000/')
    )
  })
})

describe('browser navigation policy', () => {
  it('allows web pages and the blank page only', () => {
    expect(isBrowserNavigable('https://example.com/')).toBe(true)
    expect(isBrowserNavigable('http://example.com/')).toBe(true)
    expect(isBrowserNavigable('about:blank')).toBe(true)
    for (const url of [
      'file:///etc/hosts',
      'chrome://settings',
      'devtools://devtools',
      'javascript:alert(1)',
      'chorus://open',
      'about:config',
    ]) {
      expect(isBrowserNavigable(url)).toBe(false)
    }
  })

  it('normalises typed addresses', () => {
    expect(browserAddress('localhost:3000')).toBe('http://localhost:3000/')
    expect(browserAddress('127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app')
    expect(browserAddress('[::1]:8080')).toBe('http://[::1]:8080/')
    expect(browserAddress('example.com')).toBe('https://example.com/')
    expect(browserAddress('  https://gitlab.com/users/sign_in ')).toBe(
      'https://gitlab.com/users/sign_in'
    )
    for (const input of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:secret@example.com/',
      'two words',
    ]) {
      expect(browserAddress(input)).toBeNull()
    }
  })
})

describe('restored address scrubbing', () => {
  it('drops OAuth and credential parameters', () => {
    expect(browserScrubUrl('https://app.example.com/callback?code=abc&state=xyz&tab=2')).toBe(
      'https://app.example.com/callback?tab=2'
    )
    expect(browserScrubUrl('https://app.example.com/#access_token=abc&token_type=bearer')).toBe(
      'https://app.example.com/'
    )
    expect(browserScrubUrl('https://user:pw@example.com/a')).toBe('https://example.com/a')
    expect(browserScrubUrl('https://example.com/docs#intro')).toBe('https://example.com/docs#intro')
    expect(browserScrubUrl('about:blank')).toBeNull()
  })
})

describe('web address and search', () => {
  it.each([
    ['localhost:3000', 'http://localhost:3000/'],
    ['example.com', 'https://example.com/'],
    ['about:blank', 'about:blank'],
    ['  https://example.com/docs  ', 'https://example.com/docs'],
    ['what is 2.5', 'https://www.google.com/search?q=what%20is%202.5'],
    ['hello', 'https://www.google.com/search?q=hello'],
    ['javascript:x', 'https://www.google.com/search?q=javascript%3Ax'],
  ])('resolves %s', (input, expected) => {
    expect(browserAddressOrSearch(input)).toBe(expected)
  })

  it('refuses empty input and bounds both input and the encoded search URL', () => {
    expect(browserAddressOrSearch('   ')).toBeNull()
    expect(browserAddressOrSearch('x'.repeat(BROWSER_ADDRESS_MAX + 1))).toBeNull()
    expect(browserAddressOrSearch('%'.repeat(BROWSER_ADDRESS_MAX))).toBeNull()
  })

  it('always searches selected addresses and bounds the selected query', () => {
    expect(browserSearchUrl(' example.com ')).toBe('https://www.google.com/search?q=example.com')
    expect(browserSearchUrl('localhost:3000')).toBe(
      'https://www.google.com/search?q=localhost%3A3000'
    )
    expect(browserSearchUrl('https://example.com')).toBe(
      'https://www.google.com/search?q=https%3A%2F%2Fexample.com'
    )
    const query = 'x'.repeat(BROWSER_SEARCH_MAX + 1)
    expect(browserSearchUrl(query)).toBe(
      `https://www.google.com/search?q=${'x'.repeat(BROWSER_SEARCH_MAX)}`
    )
    expect(browserSearchUrl('   ')).toBeNull()
    expect(browserSearchUrl('界'.repeat(BROWSER_SEARCH_MAX))).toBeNull()
  })

  it('keeps longer address-bar searches intact', () => {
    const query = 'x'.repeat(BROWSER_SEARCH_MAX + 1)
    expect(browserAddressOrSearch(query)).toBe(`https://www.google.com/search?q=${query}`)
    expect(browserAddressOrSearch('example.com')).toBe('https://example.com/')
  })

  it('keeps a clipped Unicode query well formed', () => {
    const query = `${'x'.repeat(BROWSER_SEARCH_MAX - 1)}😀`
    expect(browserSearchUrl(query)).toBe(
      `https://www.google.com/search?q=${'x'.repeat(BROWSER_SEARCH_MAX - 1)}`
    )
  })
})

describe('web zoom steps', () => {
  it('stops at the limits and resets either limit to actual size', () => {
    expect(browserZoomStep(0.25, -1)).toBe(0.25)
    expect(browserZoomStep(5, 1)).toBe(5)
    expect(browserZoomStep(0.25, 1)).toBe(0.33)
    expect(browserZoomStep(5, -1)).toBe(4)
    expect(browserZoomStep(0.25, 0)).toBe(1)
    expect(browserZoomStep(5, 0)).toBe(1)
  })

  it('steps from a zoom factor between the supported levels', () => {
    expect(browserZoomStep(1.12, 1)).toBe(1.25)
    expect(browserZoomStep(1.12, -1)).toBe(1.1)
  })
})

describe('web keyboard commands', () => {
  const input: BrowserKeyInput = {
    type: 'keyDown',
    key: 't',
    meta: true,
    control: false,
    shift: false,
    alt: false,
    isAutoRepeat: false,
    isComposing: false,
  }
  const bindings: { key: string; shift: boolean; command: BrowserWebCommand }[] = [
    { key: 'T', shift: false, command: 'new-tab' },
    { key: 't', shift: true, command: 'reopen-tab' },
    { key: 'w', shift: false, command: 'close-tab' },
    { key: 'l', shift: false, command: 'focus-address' },
    { key: 'f', shift: false, command: 'find' },
    { key: 'g', shift: false, command: 'find-next' },
    { key: 'g', shift: true, command: 'find-previous' },
    { key: '[', shift: false, command: 'back' },
    { key: ']', shift: false, command: 'forward' },
    { key: '[', shift: true, command: 'previous-tab' },
    { key: ']', shift: true, command: 'next-tab' },
    { key: '{', shift: true, command: 'previous-tab' },
    { key: '}', shift: true, command: 'next-tab' },
  ]

  it.each(['darwin', 'win32', 'linux'])('maps primary shortcuts on %s', (platform) => {
    const primary = { meta: platform === 'darwin', control: platform !== 'darwin' }
    for (const { key, shift, command } of bindings) {
      expect(browserWebCommand({ ...input, ...primary, key, shift }, platform)).toBe(command)
    }
    expect(browserWebCommand({ ...input, meta: false, control: false }, platform)).toBeNull()
    expect(browserWebCommand({ ...input, meta: true, control: true }, platform)).toBeNull()
  })

  it('does not repeat tab mutations but allows repeating find commands', () => {
    const repeating = { ...input, isAutoRepeat: true }
    expect(browserWebCommand(repeating, 'darwin')).toBeNull()
    expect(browserWebCommand({ ...repeating, shift: true }, 'darwin')).toBeNull()
    expect(browserWebCommand({ ...repeating, key: 'w' }, 'darwin')).toBeNull()
    expect(browserWebCommand({ ...repeating, key: 'g' }, 'darwin')).toBe('find-next')
    expect(browserWebCommand({ ...repeating, key: 'g', shift: true }, 'darwin')).toBe(
      'find-previous'
    )
  })

  it.each(['darwin', 'win32', 'linux'])('moves tabs with primary+Alt+Shift on %s', (platform) => {
    const primary = { meta: platform === 'darwin', control: platform !== 'darwin' }
    const moving = { ...input, ...primary, alt: true, shift: true }
    expect(browserWebCommand({ ...moving, key: 'ArrowLeft' }, platform)).toBe('move-tab-left')
    expect(browserWebCommand({ ...moving, key: 'ArrowRight' }, platform)).toBe('move-tab-right')
    expect(browserWebCommand({ ...moving, key: 'ArrowRight', isAutoRepeat: true }, platform)).toBe(
      'move-tab-right'
    )
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      expect(browserWebCommand({ ...moving, key, shift: false }, platform)).toBeNull()
      expect(browserWebCommand({ ...moving, key, alt: false }, platform)).toBeNull()
      expect(browserWebCommand({ ...moving, key, isComposing: true }, platform)).toBeNull()
      expect(browserWebCommand({ ...moving, key, type: 'keyUp' }, platform)).toBeNull()
      expect(browserWebCommand({ ...moving, key, meta: true, control: true }, platform)).toBeNull()
      expect(
        browserWebCommand({ ...moving, key, meta: false, control: false }, platform)
      ).toBeNull()
    }
  })

  it.each(['darwin', 'win32', 'linux'])('rejects Alt for every other command on %s', (platform) => {
    const primary = { meta: platform === 'darwin', control: platform !== 'darwin' }
    for (const { key, shift } of bindings) {
      expect(
        browserWebCommand({ ...input, ...primary, key, shift, alt: true }, platform)
      ).toBeNull()
    }
    for (const key of ['ArrowUp', 'ArrowDown']) {
      expect(
        browserWebCommand({ ...input, ...primary, key, alt: true, shift: true }, platform)
      ).toBeNull()
    }
  })

  it('ignores composition, Alt, key-up and unsupported combinations', () => {
    for (const changed of [
      { isComposing: true },
      { alt: true },
      { type: 'keyUp' },
      { key: 'x' },
      { key: 'w', shift: true },
    ]) {
      expect(browserWebCommand({ ...input, ...changed }, 'darwin')).toBeNull()
    }
  })
})

describe('web tab contracts', () => {
  const state: BrowserState = {
    status: 'empty',
    live: false,
    url: null,
    title: '',
    icon: null,
    canGoBack: false,
    canGoForward: false,
    documentId: null,
    passwordOrigin: null,
    error: null,
    zoom: 1,
  }
  const download = {
    id: 'download-1',
    filename: 'report.pdf',
    state: 'progressing',
    received: 42,
    total: 100,
  }

  it('requires exactly one bounded attach scope', () => {
    expect(BrowserScope.safeParse({ projectId: 'project-1' }).success).toBe(true)
    expect(BrowserScope.safeParse({ webTabId: 'web-1' }).success).toBe(true)
    expect(
      BROWSER_CONTRACT['browser:attach'].request.safeParse({ webTabId: 'web-1' }).success
    ).toBe(true)
    for (const request of [
      {},
      { projectId: 'project-1', webTabId: 'web-1' },
      { webTabId: '' },
      { webTabId: 'bad/id' },
      { webTabId: 'a'.repeat(129) },
      { webTabId: 'web-1', password: 'x' },
    ]) {
      expect(BrowserScope.safeParse(request).success).toBe(false)
    }
  })

  it('bounds find requests and close positions', () => {
    const find = BROWSER_CONTRACT['browser:find'].request
    const request = { browserId: 'browser-1', text: 'hello', forward: true, start: true }
    expect(find.safeParse(request).success).toBe(true)
    expect(find.safeParse({ ...request, text: 'x'.repeat(BROWSER_FIND_MAX) }).success).toBe(true)
    for (const changed of [
      { text: '' },
      { text: 'x'.repeat(BROWSER_FIND_MAX + 1) },
      { browserId: '' },
      { start: undefined },
      { password: 'x' },
    ]) {
      expect(find.safeParse({ ...request, ...changed }).success).toBe(false)
    }
    const close = BROWSER_CONTRACT['browser:close'].request
    expect(close.safeParse({ browserId: 'browser-1', index: WEB_TABS_MAX - 1 }).success).toBe(true)
    for (const index of [-1, 0.5, WEB_TABS_MAX, Infinity]) {
      expect(close.safeParse({ browserId: 'browser-1', index }).success).toBe(false)
    }
    expect(close.safeParse({ browserId: 'browser-1', index: 0, position: 0 }).success).toBe(false)
    expect(BROWSER_CONTRACT['browser:find'].response.safeParse({ failure: null }).success).toBe(
      true
    )
    expect(BROWSER_CONTRACT['browser:close'].response.safeParse({ ok: false }).success).toBe(false)
  })

  it('keeps reopen and download requests empty and responses strict', () => {
    for (const channel of ['browser:reopen', 'browser:downloads'] as const) {
      expect(BROWSER_CONTRACT[channel].request.safeParse({}).success).toBe(true)
      expect(BROWSER_CONTRACT[channel].request.safeParse({ browserId: 'browser-1' }).success).toBe(
        false
      )
    }
    const reopen = BROWSER_CONTRACT['browser:reopen'].response
    expect(reopen.safeParse({ reopened: null }).success).toBe(true)
    expect(reopen.safeParse({ reopened: { webTabId: 'web-1', index: 0, state } }).success).toBe(
      true
    )
    expect(
      reopen.safeParse({ reopened: { webTabId: 'web-1', index: WEB_TABS_MAX, state } }).success
    ).toBe(false)
    expect(
      reopen.safeParse({ reopened: { webTabId: 'web-1', index: 0, state, history: [] } }).success
    ).toBe(false)
    expect(
      BROWSER_CONTRACT['browser:downloads'].response.safeParse({ downloads: [download] }).success
    ).toBe(true)
    expect(
      BROWSER_CONTRACT['browser:download'].response.safeParse({ downloads: [], failure: null })
        .success
    ).toBe(true)
    const act = BROWSER_CONTRACT['browser:download'].request
    for (const action of ['open', 'show', 'cancel', 'clear']) {
      expect(act.safeParse({ downloadId: 'download-1', action }).success).toBe(true)
    }
    expect(act.safeParse({ downloadId: 'download-1', action: 'remove' }).success).toBe(false)
    expect(
      act.safeParse({ downloadId: 'download-1', action: 'open', path: '/tmp/file' }).success
    ).toBe(false)
  })

  it('keeps the renderer readiness contract empty and strict', () => {
    const ready = BROWSER_CONTRACT['browser:webReady']
    expect(ready.request.safeParse({}).success).toBe(true)
    expect(ready.request.safeParse({ ready: true }).success).toBe(false)
    expect(ready.response.safeParse({ ok: true }).success).toBe(true)
    expect(ready.response.safeParse({ ok: false }).success).toBe(false)
    expect(ready.response.safeParse({ ok: true, owner: 'main' }).success).toBe(false)
  })

  it('accepts a null opener for a tab opened from a project panel', () => {
    const push = {
      kind: 'tab-open',
      browserId: 'browser-1',
      webTabId: 'web-1',
      openerWebTabId: null,
      background: true,
      state,
    }
    expect(BrowserPush.safeParse(push).success).toBe(true)
    expect(BrowserPush.safeParse({ ...push, openerWebTabId: undefined }).success).toBe(false)
  })

  it('requires a finite zoom factor within the page range', () => {
    expect(BrowserState.safeParse(state).success).toBe(true)
    for (const zoom of [undefined, 0.24, 5.01, NaN, Infinity]) {
      expect(BrowserState.safeParse({ ...state, zoom }).success).toBe(false)
    }
    for (const action of ['focus', 'zoom-in', 'zoom-out', 'zoom-reset', 'find-stop']) {
      expect(
        BROWSER_CONTRACT['browser:action'].request.safeParse({ browserId: 'browser-1', action })
          .success
      ).toBe(true)
    }
  })

  it('bounds download metadata and the list without exposing a filesystem path', () => {
    expect(BrowserDownload.safeParse(download).success).toBe(true)
    for (const changed of [
      { filename: '' },
      { filename: 'x'.repeat(BROWSER_TITLE_MAX + 1) },
      { received: -1 },
      { received: 0.5 },
      { total: Infinity },
      { total: Number.MAX_SAFE_INTEGER + 1 },
      { path: '/tmp/file' },
    ]) {
      expect(BrowserDownload.safeParse({ ...download, ...changed }).success).toBe(false)
    }
    expect(
      BrowserDownloads.safeParse(Array.from({ length: BROWSER_DOWNLOADS_MAX }, () => download))
        .success
    ).toBe(true)
    expect(
      BrowserDownloads.safeParse(Array.from({ length: BROWSER_DOWNLOADS_MAX + 1 }, () => download))
        .success
    ).toBe(false)
  })

  it('requires an owner record on each new push variant', () => {
    const pushes = [
      { kind: 'found', browserId: 'browser-1', matches: 2, active: 1 },
      {
        kind: 'tab-open',
        browserId: 'browser-1',
        webTabId: 'web-1',
        openerWebTabId: 'web-2',
        background: false,
        state,
      },
      { kind: 'command', browserId: 'browser-1', command: 'new-tab' },
      { kind: 'downloads', browserId: 'browser-1', downloads: [download] },
    ]
    for (const push of pushes) {
      expect(BrowserPush.safeParse(push).success).toBe(true)
      expect(BrowserPush.safeParse({ ...push, browserId: undefined }).success).toBe(false)
      expect(BrowserPush.safeParse({ ...push, password: 'x' }).success).toBe(false)
    }
    expect(
      BrowserPush.safeParse({ kind: 'found', browserId: 'browser-1', matches: -1, active: 0 })
        .success
    ).toBe(false)
    expect(
      BrowserPush.safeParse({ kind: 'command', browserId: 'browser-1', command: 'unknown' }).success
    ).toBe(false)
  })
})

describe('shell-facing contracts', () => {
  it('never carry a password', () => {
    const origin = 'https://example.com'
    expect(
      BrowserPasswordAccount.safeParse({ id: 'a', origin, username: 'me', password: 'x' }).success
    ).toBe(false)
    expect(
      BrowserPasswords.safeParse({
        storage: 'ready',
        origin,
        accounts: [],
        neverSave: false,
        password: 'x',
      }).success
    ).toBe(false)
    expect(
      BrowserPush.safeParse({
        kind: 'prompt',
        browserId: 'b',
        prompt: {
          candidateId: 'c',
          documentId: 'd',
          origin,
          username: 'me',
          mode: 'save',
          password: 'x',
        },
      }).success
    ).toBe(false)
  })

  it('keeps page form, scan and fill messages strict', () => {
    const documentToken = 'a'.repeat(32)
    expect(BrowserPageForm.safeParse({ documentToken, phase: 'password' }).success).toBe(true)
    expect(BrowserPageForm.safeParse({ documentToken, phase: 'identifier' }).success).toBe(true)
    expect(BrowserPageForm.safeParse({ documentToken, phase: 'otp' }).success).toBe(false)
    expect(
      BrowserPageForm.safeParse({ documentToken, phase: 'password', password: 'x' }).success
    ).toBe(false)
    expect(BrowserPageScan.safeParse({ documentToken }).success).toBe(true)
    expect(BrowserPageScan.safeParse({ documentToken, password: 'x' }).success).toBe(false)
    const fill = { documentToken, origin: 'https://example.com', username: 'me', password: 'pw' }
    expect(BrowserPageFill.safeParse({ ...fill, mode: 'automatic' }).success).toBe(true)
    expect(BrowserPageFill.safeParse({ ...fill, mode: 'manual' }).success).toBe(true)
    expect(BrowserPageFill.safeParse(fill).success).toBe(false)
    expect(BrowserPageFill.safeParse({ ...fill, mode: 'silent' }).success).toBe(false)
  })

  it('requires a bounded fractional body origin on the geometry request', () => {
    const geometry = BROWSER_CONTRACT['browser:geometry'].request
    const missing = {
      browserId: 'page',
      revision: 3,
      rect: { x: 151, y: 40, width: 997, height: 548 },
      active: true,
      fullyVisible: true,
    }
    const request = { ...missing, bodyOrigin: { x: 151.4, y: 39.75 } }
    expect(geometry.safeParse(request).success).toBe(true)
    expect(geometry.safeParse({ ...request, bodyOrigin: { x: -600.5, y: 0 } }).success).toBe(true)
    expect(geometry.safeParse(missing).success).toBe(false)
    for (const bodyOrigin of [
      null,
      { x: 0 },
      { y: 0 },
      { x: '1', y: 0 },
      { x: NaN, y: 0 },
      { x: 0, y: Infinity },
      { x: BROWSER_RECT_MAX + 1, y: 0 },
      { x: 0, y: -BROWSER_RECT_MAX - 0.5 },
      { x: 0, y: 0, z: 0 },
    ]) {
      expect(geometry.safeParse({ ...request, bodyOrigin }).success).toBe(false)
    }
    expect(BrowserPoint.safeParse({ x: 0.5, y: -0.5 }).success).toBe(true)
    expect(BrowserPoint.safeParse({ x: 0.5, y: -0.5, left: 0 }).success).toBe(false)
  })

  it('keep website preload channels out of the shell contract', () => {
    const channels = Object.keys(BROWSER_CONTRACT)
    expect(channels.some((channel) => channel.startsWith('browser:page:'))).toBe(false)
  })
})

describe('browser row wheel messages', () => {
  const wheel = {
    deltaX: 40,
    deltaY: 3,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  }

  it('accepts horizontal and shift wheel in pixel, line and page units', () => {
    for (const deltaMode of [0, 1, 2]) {
      expect(BrowserPageRowWheel.safeParse({ ...wheel, deltaMode }).success).toBe(true)
      expect(BrowserPageRowWheel.safeParse({ ...wheel, deltaMode, deltaX: -40 }).success).toBe(true)
      const shifted = { ...wheel, deltaMode, shiftKey: true, deltaX: 0, deltaY: -20 }
      expect(BrowserPageRowWheel.safeParse(shifted).success).toBe(true)
    }
    const push = { kind: 'row-wheel', browserId: 'page', wheel }
    expect(BrowserPush.safeParse(push).success).toBe(true)
  })

  it('refuses vertical, zero, zoom, invalid units and unbounded messages', () => {
    for (const changed of [
      { deltaX: 0, deltaY: 40 },
      { deltaX: 40, deltaY: 40 },
      { deltaX: 0, deltaY: 0, shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { deltaMode: 3 },
      { deltaMode: 0.5 },
      { deltaX: NaN },
      { deltaY: Infinity },
      { deltaX: BROWSER_WHEEL_DELTA_MAX + 1 },
      { deltaY: -BROWSER_WHEEL_DELTA_MAX - 1 },
      { password: 'secret' },
    ]) {
      expect(BrowserPageRowWheel.safeParse({ ...wheel, ...changed }).success).toBe(false)
    }
    expect(
      BrowserPush.safeParse({ kind: 'row-wheel', browserId: 'page', wheel, password: 'secret' })
        .success
    ).toBe(false)
  })
})
