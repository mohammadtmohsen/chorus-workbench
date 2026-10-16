/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MermaidModule from './mermaid.js'

const library = vi.hoisted(() => {
  const initialize = vi.fn()
  const render = vi.fn()
  return { initialize, render, module: () => ({ default: { initialize, render } }) }
})

vi.mock('mermaid', () => library.module())

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const svg = (viewBox: string, body = '<g><text>A</text></g>'): string =>
  `<svg id="chorus-mermaid-1" width="100%" xmlns="http://www.w3.org/2000/svg" ` +
  `xmlns:xlink="http://www.w3.org/1999/xlink" class="flowchart" ` +
  `style="max-width: 812.5px; background-color: transparent;" viewBox="${viewBox}" ` +
  `role="graphics-document document">${body}</svg>`

const rendered = (viewBox = '0 0 100 50') => ({ svg: svg(viewBox), diagramType: 'flowchart' })

const FLOW = 'flowchart LR\n  Search["Search text"] -->|"q param"| GET["GET …/visits?q"]'

const decode = (url: string): Document =>
  new DOMParser().parseFromString(
    decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length)),
    'image/svg+xml'
  )

let mermaid: typeof MermaidModule

beforeEach(async () => {
  library.initialize.mockReset()
  library.render.mockReset()
  library.render.mockImplementation(() => Promise.resolve(rendered()))
  vi.resetModules()
  mermaid = await import('./mermaid.js')
})

afterEach(() => {
  vi.doMock('mermaid', () => library.module())
  document.body.replaceChildren()
})

describe('isMermaidLanguage', () => {
  it('matches the mermaid fence label in any case and nothing else', () => {
    expect(mermaid.isMermaidLanguage('mermaid')).toBe(true)
    expect(mermaid.isMermaidLanguage('Mermaid')).toBe(true)
    expect(mermaid.isMermaidLanguage('MERMAID')).toBe(true)
    expect(mermaid.isMermaidLanguage(null)).toBe(false)
    expect(mermaid.isMermaidLanguage('')).toBe(false)
    expect(mermaid.isMermaidLanguage('mmd')).toBe(false)
    expect(mermaid.isMermaidLanguage('mermaid-js')).toBe(false)
    expect(mermaid.isMermaidLanguage('ts')).toBe(false)
  })
})

describe('mermaidConfig', () => {
  it('keeps strict security, silent errors and SVG text labels', () => {
    const config = mermaid.mermaidConfig('dark', 'system-ui')
    expect(config.securityLevel).toBe('strict')
    expect(config.suppressErrorRendering).toBe(true)
    expect(config.startOnLoad).toBe(false)
    expect(config.htmlLabels).toBe(false)
    expect(config.fontFamily).toBe('system-ui')
    expect(config).not.toHaveProperty('maxEdges')
  })

  it('bounds diagram text at or below the library default, never above it', () => {
    expect(mermaid.MERMAID_MAX_SOURCE).toBeGreaterThan(0)
    expect(mermaid.MERMAID_MAX_SOURCE).toBeLessThanOrEqual(50_000)
    expect(mermaid.mermaidConfig('dark', 'f').maxTextSize).toBe(mermaid.MERMAID_MAX_SOURCE)
  })

  it('follows the scheme it is given', () => {
    expect(mermaid.mermaidConfig('dark', 'f').theme).toBe('dark')
    expect(mermaid.mermaidConfig('light', 'f').theme).toBe('default')
  })

  it('locks security, bounds and appearance against diagram directives', () => {
    const secure = mermaid.mermaidConfig('dark', 'f').secure ?? []
    for (const key of [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'maxEdges',
      'suppressErrorRendering',
      'htmlLabels',
      'theme',
      'themeVariables',
      'themeCSS',
      'darkMode',
      'look',
      'layout',
      'fontFamily',
      'altFontFamily',
    ]) {
      expect(secure).toContain(key)
    }
  })

  it('hands out a copy of the locked keys', () => {
    const secure = mermaid.mermaidConfig('dark', 'f').secure ?? []
    secure.length = 0
    expect(mermaid.MERMAID_LOCKED_KEYS).toContain('theme')
    expect(mermaid.mermaidConfig('dark', 'f').secure).toContain('theme')
  })
})

describe('toMermaidImage', () => {
  it('sizes the image from the viewBox and drops the shrink-to-fit width', () => {
    const image = mermaid.toMermaidImage(svg('-8 -8 812.5 200'))
    expect(image.width).toBe(813)
    expect(image.height).toBe(200)
    const root = decode(image.url).documentElement
    expect(root.getAttribute('width')).toBe('813')
    expect(root.getAttribute('height')).toBe('200')
    expect(root.getAttribute('style')).toBe('background-color: transparent')
  })

  it('accepts a negative origin with comma separators', () => {
    const image = mermaid.toMermaidImage(svg('-12.5,-4,30,20.2'))
    expect(image).toMatchObject({ width: 30, height: 21 })
  })

  it('removes the style attribute when max-width was all it held', () => {
    const markup = svg('0 0 10 10').replace(
      'style="max-width: 812.5px; background-color: transparent;"',
      'style="max-width: 10px;"'
    )
    const root = decode(mermaid.toMermaidImage(markup).url).documentElement
    expect(root.hasAttribute('style')).toBe(false)
  })

  it('returns a data URL holding well-formed SVG', () => {
    const image = mermaid.toMermaidImage(svg('0 0 100 50'))
    expect(image.url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    const parsed = decode(image.url)
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(parsed.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(parsed.documentElement.localName).toBe('svg')
  })

  it('turns an HTML no-break space entity into XML the image can parse', () => {
    const image = mermaid.toMermaidImage(svg('0 0 100 50', '<text>Search&nbsp;text</text>'))
    const parsed = decode(image.url)
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(parsed.documentElement.textContent).toBe('Search\u00a0text')
  })

  it('keeps escaped markup in labels as text', () => {
    const image = mermaid.toMermaidImage(
      svg('0 0 100 50', '<text>a &amp;nbsp; &lt;b&gt;</text><style>#x .a&gt;.b{fill:red}</style>')
    )
    const parsed = decode(image.url)
    expect(parsed.getElementsByTagName('b')).toHaveLength(0)
    expect(parsed.documentElement.textContent).toContain('a &nbsp; <b>')
    expect(parsed.documentElement.textContent).toContain('#x .a>.b{fill:red}')
  })

  it('keeps namespaced link attributes valid', () => {
    const image = mermaid.toMermaidImage(svg('0 0 100 50', '<a xlink:href="#n"><text>n</text></a>'))
    const link = decode(image.url).getElementsByTagName('a')[0]
    expect(link?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#n')
  })

  it.each([
    ['no viewBox', svg('0 0 1 1').replace(' viewBox="0 0 1 1"', '')],
    ['a zero width', svg('0 0 0 10')],
    ['a negative height', svg('0 0 10 -5')],
    ['a non-numeric size', svg('0 0 wide 10')],
    ['an infinite size', svg('0 0 Infinity 10')],
    ['three viewBox numbers', svg('0 0 10')],
    ['five viewBox numbers', svg('0 0 10 10 10')],
    ['a non-numeric x origin', svg('left 0 10 10')],
    ['a non-numeric y origin', svg('0 top 10 10')],
    ['a NaN origin', svg('NaN 0 10 10')],
    ['an infinite x origin', svg('Infinity 0 10 10')],
    ['an infinite y origin', svg('0 -Infinity 10 10')],
    ['malformed markup', svg('0 0 10 10', '<g><text>A</text>')],
    ['an unclosed HTML element', svg('0 0 10 10', '<foreignObject><br></foreignObject>')],
    ['an HTML root', '<div xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"></div>'],
    ['an svg outside the SVG namespace', '<svg viewBox="0 0 1 1"></svg>'],
  ])('refuses output with %s', (_label, markup) => {
    expect(() => mermaid.toMermaidImage(markup)).toThrow()
  })
})

describe('renderMermaid', () => {
  it('renders through the public API with the locked configuration', async () => {
    const image = await mermaid.renderMermaid(FLOW, 'dark')
    expect(image).toMatchObject({ width: 100, height: 50 })
    expect(library.initialize).toHaveBeenCalledTimes(1)
    expect(library.initialize).toHaveBeenCalledWith(
      mermaid.mermaidConfig('dark', 'system-ui, sans-serif')
    )
    expect(library.render).toHaveBeenCalledWith(
      expect.stringMatching(/^chorus-mermaid-\d+$/),
      FLOW,
      expect.any(HTMLDivElement)
    )
  })

  it('measures in a hidden host that is gone once rendering ends', async () => {
    const seen: { connected: boolean; hidden: string | null; host: Element }[] = []
    library.render.mockImplementation((_id: string, _text: string, host: Element) => {
      seen.push({
        connected: host.isConnected,
        hidden: host.getAttribute('aria-hidden'),
        host,
      })
      return Promise.resolve(rendered())
    })
    await mermaid.renderMermaid(FLOW, 'dark')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.connected).toBe(true)
    expect(seen[0]?.hidden).toBe('true')
    expect(seen[0]?.host.isConnected).toBe(false)
    expect(document.body.childElementCount).toBe(0)
  })

  it('removes the host when rendering throws', async () => {
    library.render.mockImplementation(() => Promise.reject(new Error('Parse error')))
    await expect(mermaid.renderMermaid(FLOW, 'dark')).rejects.toThrow('Parse error')
    expect(document.body.childElementCount).toBe(0)
  })

  it('removes the host when the output cannot become an image', async () => {
    library.render.mockImplementation(() =>
      Promise.resolve({ svg: '<svg viewBox="0 0 1 1"></svg>', diagramType: 'flowchart' })
    )
    await expect(mermaid.renderMermaid(FLOW, 'dark')).rejects.toThrow()
    expect(document.body.childElementCount).toBe(0)
    expect(mermaid.peekMermaid(FLOW, 'dark')).toBe('failed')
  })

  it('never reuses an element id', async () => {
    await mermaid.renderMermaid('flowchart LR\n  A --> B', 'dark')
    await mermaid.renderMermaid('flowchart LR\n  B --> C', 'dark')
    await mermaid.renderMermaid('flowchart LR\n  A --> B', 'light')
    const ids = library.render.mock.calls.map((call) => call[0] as string)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('remembers a rendered diagram per source and scheme', async () => {
    const first = await mermaid.renderMermaid(FLOW, 'dark')
    expect(mermaid.peekMermaid(FLOW, 'dark')).toEqual(first)
    await expect(mermaid.renderMermaid(FLOW, 'dark')).resolves.toEqual(first)
    expect(library.render).toHaveBeenCalledTimes(1)
    expect(mermaid.peekMermaid(FLOW, 'light')).toBeUndefined()
    expect(mermaid.peekMermaid(`${FLOW}\n`, 'dark')).toBeUndefined()
  })

  it('shares one render between simultaneous requests for the same diagram', async () => {
    const [a, b] = await Promise.all([
      mermaid.renderMermaid(FLOW, 'dark'),
      mermaid.renderMermaid(FLOW, 'dark'),
    ])
    expect(a).toEqual(b)
    expect(library.render).toHaveBeenCalledTimes(1)
  })

  it('re-initializes only when the scheme changes', async () => {
    await mermaid.renderMermaid('flowchart LR\n  A --> B', 'dark')
    await mermaid.renderMermaid('flowchart LR\n  B --> C', 'dark')
    await mermaid.renderMermaid('flowchart LR\n  A --> B', 'light')
    await mermaid.renderMermaid('flowchart LR\n  C --> D', 'dark')
    expect(
      library.initialize.mock.calls.map((call) => (call[0] as { theme: string }).theme)
    ).toEqual(['dark', 'default', 'dark'])
  })

  it('runs one render at a time, so a scheme change cannot reach a queued job', async () => {
    const first = deferred<ReturnType<typeof rendered>>()
    library.render.mockImplementationOnce(() => first.promise)
    const dark = mermaid.renderMermaid('flowchart LR\n  A --> B', 'dark')
    const light = mermaid.renderMermaid('flowchart LR\n  B --> C', 'light')
    await vi.waitFor(() => {
      expect(library.render).toHaveBeenCalledTimes(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(library.render).toHaveBeenCalledTimes(1)
    expect(library.initialize).toHaveBeenCalledTimes(1)

    first.resolve(rendered())
    await dark
    await light
    expect(library.render).toHaveBeenCalledTimes(2)
    expect(
      library.initialize.mock.calls.map((call) => (call[0] as { theme: string }).theme)
    ).toEqual(['dark', 'default'])
  })

  it('keeps the queue moving after a failure', async () => {
    library.render.mockImplementationOnce(() => Promise.reject(new Error('Parse error')))
    const broken = mermaid.renderMermaid('flowchart LR\n  A -->', 'dark')
    const fine = mermaid.renderMermaid('flowchart LR\n  A --> B', 'dark')
    await expect(broken).rejects.toThrow('Parse error')
    await expect(fine).resolves.toMatchObject({ width: 100 })
  })

  it('remembers a failure without rendering it again', async () => {
    library.render.mockImplementation(() => Promise.reject(new Error('Parse error')))
    await expect(mermaid.renderMermaid(FLOW, 'dark')).rejects.toThrow()
    expect(mermaid.peekMermaid(FLOW, 'dark')).toBe('failed')
    await expect(mermaid.renderMermaid(FLOW, 'dark')).rejects.toThrow()
    expect(library.render).toHaveBeenCalledTimes(1)
  })

  it('records a failure reported by the image itself', () => {
    mermaid.markMermaidFailed(FLOW, 'light')
    expect(mermaid.peekMermaid(FLOW, 'light')).toBe('failed')
    expect(mermaid.peekMermaid(FLOW, 'dark')).toBeUndefined()
  })

  it('holds a bounded number of diagrams, dropping the oldest', async () => {
    for (let i = 0; i <= mermaid.MERMAID_CACHE_LIMIT; i += 1) {
      await mermaid.renderMermaid(`flowchart LR\n  A${String(i)} --> B`, 'dark')
    }
    expect(mermaid.peekMermaid('flowchart LR\n  A0 --> B', 'dark')).toBeUndefined()
    expect(mermaid.peekMermaid('flowchart LR\n  A1 --> B', 'dark')).not.toBeUndefined()
    expect(
      mermaid.peekMermaid(`flowchart LR\n  A${String(mermaid.MERMAID_CACHE_LIMIT)} --> B`, 'dark')
    ).not.toBeUndefined()
  })

  it('still draws a diagram exactly at the size limit', async () => {
    const largest = 'a'.repeat(mermaid.MERMAID_MAX_SOURCE)
    await expect(mermaid.renderMermaid(largest, 'dark')).resolves.toMatchObject({ width: 100 })
    expect(library.render).toHaveBeenCalledWith(expect.any(String), largest, expect.anything())
    expect(mermaid.peekMermaid(largest, 'dark')).toMatchObject({ width: 100 })
  })

  it('refuses a diagram over the size limit before loading or drawing anything', async () => {
    const huge = 'a'.repeat(mermaid.MERMAID_MAX_SOURCE + 1)
    expect(mermaid.peekMermaid(huge, 'dark')).toBe('failed')
    expect(mermaid.peekMermaid(huge, 'light')).toBe('failed')
    await expect(mermaid.renderMermaid(huge, 'dark')).rejects.toThrow()
    expect(library.initialize).not.toHaveBeenCalled()
    expect(library.render).not.toHaveBeenCalled()
    expect(document.body.childElementCount).toBe(0)
  })

  it('never remembers an oversized diagram in the bounded cache', async () => {
    for (let i = 0; i < mermaid.MERMAID_CACHE_LIMIT; i += 1) {
      await mermaid.renderMermaid(`flowchart LR\n  A${String(i)} --> B`, 'dark')
    }
    const huge = 'a'.repeat(mermaid.MERMAID_MAX_SOURCE + 1)
    await expect(mermaid.renderMermaid(huge, 'dark')).rejects.toThrow()
    mermaid.markMermaidFailed(huge, 'dark')
    expect(mermaid.peekMermaid('flowchart LR\n  A0 --> B', 'dark')).not.toBeUndefined()
    expect(mermaid.peekMermaid(huge, 'dark')).toBe('failed')
  })

  it('fails to source when the library cannot load', async () => {
    vi.doMock('mermaid', () => {
      throw new Error('chunk missing')
    })
    vi.resetModules()
    const fresh = await import('./mermaid.js')
    await expect(fresh.renderMermaid(FLOW, 'dark')).rejects.toThrow()
    expect(fresh.peekMermaid(FLOW, 'dark')).toBe('failed')
    expect(library.render).not.toHaveBeenCalled()
  })
})
