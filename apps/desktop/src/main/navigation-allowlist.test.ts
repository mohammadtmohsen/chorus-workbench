import { describe, expect, it, vi } from 'vitest'

/**
 * Which documents a `WebContents` may hold, and the difference between an
 * allowlist and a prefix.
 *
 * The rule used to be "starts with `file://`, or starts with the dev server's
 * URL". Both halves are the same mistake — a test on the *shape* of an address
 * rather than on the address — and under `WebContentsView` the first one stopped
 * being academic: a workbench surface runs third-party extension code by design
 * and shares the `file://` scheme with the shell's own `index.html`, so the
 * broadest reading of "internal" admitted precisely the navigation the surface
 * exists to make impossible.
 *
 * These are about the *rule*, which is why they live beside main rather than
 * beside the two callers that build the list.
 */

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

const { lockDownNavigation } = await import('./security.js')

type WillNavigate = (event: { preventDefault: () => void }, url: string) => void

/** Only what the rule reads: one listener registration and one preventable event. */
function navigator(entries: readonly string[]): (url: string) => boolean {
  const bound: WillNavigate[] = []
  const contents = {
    on(event: string, handler: WillNavigate) {
      if (event === 'will-navigate') bound.push(handler)
      return contents
    },
    setWindowOpenHandler: vi.fn(),
  }
  lockDownNavigation(contents as never, entries)

  const listener = bound[0]
  if (listener === undefined) throw new Error('nothing bound will-navigate')

  return (url: string): boolean => {
    let prevented = false
    listener(
      {
        preventDefault: () => {
          prevented = true
        },
      },
      url
    )
    return !prevented
  }
}

const SHELL = 'file:///Applications/Chorus.app/Contents/Resources/app/out/renderer/index.html'
const SURFACE = 'file:///Applications/Chorus.app/Contents/Resources/app/out/renderer/workbench.html'
const DEV = 'http://localhost:5173'

describe('a workbench surface may hold exactly its own document', () => {
  const mayLoad = navigator([SURFACE])

  it('admits its entry, which is what a reload asks for', () => {
    expect(mayLoad(SURFACE)).toBe(true)
    // A fragment survives, because `will-navigate` never fires for an in-page
    // hash change — one arriving here is a real load of the same document.
    expect(mayLoad(`${SURFACE}#editor`)).toBe(true)
  })

  it('refuses the shell own entry, which a file:// prefix rule admitted', () => {
    // The crux. Same scheme, same directory, one path segment apart — and the
    // document on the other side of it is the one built to sit behind the
    // shell's whole `ChorusApi` preload.
    expect(mayLoad(SHELL)).toBe(false)
  })

  it('refuses every other local file, however close', () => {
    for (const url of [
      'file:///etc/passwd',
      'file:///Users/someone/.aws/credentials',
      // A directory listing of the folder the entry is in.
      'file:///Applications/Chorus.app/Contents/Resources/app/out/renderer/',
      // Same path, spelled with a host — `parsed.host` is compared for this.
      'file://evil.example/Applications/Chorus.app/Contents/Resources/app/out/renderer/workbench.html',
    ]) {
      expect(mayLoad(url)).toBe(false)
    }
  })

  it('refuses the remote schemes a prefix rule never even considered', () => {
    for (const url of [
      'https://example.com/',
      'about:blank',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'not a url at all',
    ]) {
      expect(mayLoad(url)).toBe(false)
    }
  })
})

describe('the dev server is an origin, not a prefix', () => {
  const mayLoad = navigator([`${DEV}/workbench.html`])

  it('admits the entry it was given', () => {
    expect(mayLoad(`${DEV}/workbench.html`)).toBe(true)
  })

  it('refuses a host that merely starts the same', () => {
    // `http://localhost:5173` is a prefix of `http://localhost:51739…`, which is
    // the whole reason a prefix test over an origin is not a same-origin test.
    expect(mayLoad('http://localhost:51739/workbench.html')).toBe(false)
    expect(mayLoad('http://localhost:5173.evil.example/workbench.html')).toBe(false)
  })

  it('refuses another path on the same origin', () => {
    expect(mayLoad(`${DEV}/index.html`)).toBe(false)
    expect(mayLoad(`${DEV}/`)).toBe(false)
  })

  it('refuses a query string, which is the one part that reaches the network', () => {
    // No entry Chorus loads has one, and §5.3's whole point is that a secret in
    // a URL is a secret in the server's log and in session history.
    expect(mayLoad(`${DEV}/workbench.html?tkn=whatever`)).toBe(false)
  })
})

describe('the shell own lock', () => {
  const mayLoad = navigator([SHELL])

  it('admits its entry and refuses a surface document', () => {
    expect(mayLoad(SHELL)).toBe(true)
    expect(mayLoad(SURFACE)).toBe(false)
  })
})

describe('an allowlist that cannot be built', () => {
  it('throws where the list is made rather than silently having a hole in it', () => {
    expect(() => navigator(['not a url'])).toThrow(/usable navigation entry/)
  })
})
