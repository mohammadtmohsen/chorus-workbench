/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownView } from './MarkdownView.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import type * as MermaidModule from './mermaid.js'

type MermaidImage = MermaidModule.MermaidImage
type MermaidScheme = MermaidModule.MermaidScheme

const diagrams = vi.hoisted(() => ({
  peek: vi.fn(),
  render: vi.fn(),
  markFailed: vi.fn(),
}))

vi.mock('./mermaid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MermaidModule>()),
  peekMermaid: diagrams.peek,
  renderMermaid: diagrams.render,
  markMermaidFailed: diagrams.markFailed,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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

const image = (name: string): MermaidImage => ({
  url: `data:image/svg+xml;charset=utf-8,${name}`,
  width: 640,
  height: 180,
})

const SOURCE = 'flowchart LR\n  Search["Search text"] -->|"q param"| GET["GET …/visits?q"]'

const media = { light: false, listeners: new Set<() => void>() }

const setScheme = (light: boolean): void => {
  act(() => {
    media.light = light
    for (const listener of media.listeners) listener()
  })
}

const settle = async (): Promise<void> => {
  await act(() => Promise.resolve())
}

const FALLBACK = <pre className="md-code">source</pre>

const pending = new Map<string, Deferred<MermaidImage>>()

const renderCall = (source: string, scheme: MermaidScheme): Deferred<MermaidImage> => {
  const call = pending.get(`${scheme}\n${source}`)
  if (call === undefined) throw new Error(`no render requested for ${scheme}: ${source}`)
  return call
}

beforeEach(() => {
  media.light = false
  media.listeners.clear()
  pending.clear()
  diagrams.peek.mockReset()
  diagrams.render.mockReset()
  diagrams.markFailed.mockReset()
  diagrams.peek.mockReturnValue(undefined)
  diagrams.render.mockImplementation((source: string, scheme: MermaidScheme) => {
    const call = deferred<MermaidImage>()
    pending.set(`${scheme}\n${source}`, call)
    return call.promise
  })
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      get matches() {
        return media.light
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        media.listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: () => void) => {
        media.listeners.delete(listener)
      },
    }),
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
})

describe('MermaidDiagram', () => {
  it('keeps the source and asks for nothing while the message is live', () => {
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled={false}>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(container.querySelector('pre.md-code')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('shows the source while drawing, then only the image', async () => {
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(diagrams.render).toHaveBeenCalledWith(SOURCE, 'dark')
    expect(container.querySelector('pre.md-code')).not.toBeNull()

    renderCall(SOURCE, 'dark').resolve(image('flow'))
    await settle()

    const img = container.querySelector('.md-diagram > img')
    expect(img?.getAttribute('src')).toBe(image('flow').url)
    expect(img?.getAttribute('width')).toBe('640')
    expect(img?.getAttribute('height')).toBe('180')
    expect(img?.getAttribute('alt')).toBe('conversation.diagramAlt')
    expect(container.querySelector('.md-diagram')?.getAttribute('dir')).toBe('ltr')
    expect(container.querySelector('pre.md-code')).toBeNull()
  })

  it('draws once the message settles', async () => {
    const { container, rerender } = render(
      <MermaidDiagram source={SOURCE} settled={false}>
        {FALLBACK}
      </MermaidDiagram>
    )
    rerender(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(diagrams.render).toHaveBeenCalledTimes(1)
    renderCall(SOURCE, 'dark').resolve(image('flow'))
    await settle()
    expect(container.querySelector('.md-diagram > img')).not.toBeNull()
  })

  it('paints a remembered diagram on the first render without drawing again', () => {
    diagrams.peek.mockImplementation((source: string, scheme: MermaidScheme) =>
      source === SOURCE && scheme === 'dark' ? image('cached') : undefined
    )
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(container.querySelector('.md-diagram > img')?.getAttribute('src')).toBe(
      image('cached').url
    )
    expect(container.querySelector('pre.md-code')).toBeNull()
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('keeps showing a remembered diagram after the cache lets it go', () => {
    diagrams.peek.mockReturnValue(image('cached'))
    const { container, rerender } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('cached').url)

    diagrams.peek.mockReturnValue(undefined)
    rerender(
      <MermaidDiagram source={SOURCE} settled>
        <pre className="md-code">fresh</pre>
      </MermaidDiagram>
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('cached').url)
    expect(container.querySelector('pre.md-code')).toBeNull()
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('shows a diagram remembered between rendering and its effect', () => {
    diagrams.peek.mockReturnValueOnce(undefined).mockReturnValue(image('warmed'))
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('warmed').url)
    expect(container.querySelector('pre.md-code')).toBeNull()
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('keeps a remembered failure after the cache lets it go', () => {
    diagrams.peek.mockReturnValue('failed')
    const { container, rerender } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    diagrams.peek.mockReturnValue(undefined)
    rerender(
      <MermaidDiagram source={SOURCE} settled>
        <pre className="md-code">fresh</pre>
      </MermaidDiagram>
    )
    expect(container.querySelector('pre.md-code')?.textContent).toBe('fresh')
    expect(container.querySelector('.md-diagram-failed')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('never shows a result for a source that has since changed', async () => {
    const next = `${SOURCE}\n  GET --> BE`
    const { container, rerender } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    rerender(
      <MermaidDiagram source={next} settled>
        {FALLBACK}
      </MermaidDiagram>
    )

    renderCall(SOURCE, 'dark').resolve(image('old'))
    await settle()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('pre.md-code')).not.toBeNull()

    renderCall(next, 'dark').resolve(image('new'))
    await settle()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('new').url)
  })

  it('never shows a result for a scheme that has since changed', async () => {
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    setScheme(true)
    expect(diagrams.render).toHaveBeenLastCalledWith(SOURCE, 'light')

    renderCall(SOURCE, 'dark').resolve(image('dark'))
    await settle()
    expect(container.querySelector('img')).toBeNull()

    renderCall(SOURCE, 'light').resolve(image('light'))
    await settle()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('light').url)
  })

  it('redraws for the new scheme after a diagram is already shown', async () => {
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    renderCall(SOURCE, 'dark').resolve(image('dark'))
    await settle()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('dark').url)

    setScheme(true)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('pre.md-code')).not.toBeNull()
    renderCall(SOURCE, 'light').resolve(image('light'))
    await settle()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(image('light').url)
  })

  it('stops listening to the scheme and ignores a late result once unmounted', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(media.listeners.size).toBe(1)
    unmount()
    expect(media.listeners.size).toBe(0)
    renderCall(SOURCE, 'dark').resolve(image('late'))
    await settle()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('keeps the source and says why when the diagram cannot be drawn', async () => {
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    renderCall(SOURCE, 'dark').reject(new Error('Parse error on line 2'))
    await settle()
    expect(container.querySelector('pre.md-code')).not.toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.md-diagram-failed')?.textContent).toBe(
      'conversation.diagramFailed'
    )
  })

  it('shows a remembered failure as source without drawing again', () => {
    diagrams.peek.mockReturnValue('failed')
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(container.querySelector('pre.md-code')).not.toBeNull()
    expect(container.querySelector('.md-diagram-failed')).not.toBeNull()
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('returns to the source when the image cannot be decoded', async () => {
    const { container } = render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    renderCall(SOURCE, 'dark').resolve(image('broken'))
    await settle()
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    if (img !== null) fireEvent.error(img)

    expect(diagrams.markFailed).toHaveBeenCalledWith(SOURCE, 'dark')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('pre.md-code')).not.toBeNull()
    expect(container.querySelector('.md-diagram-failed')).not.toBeNull()
  })

  it('draws for the dark scheme where matchMedia does not exist', () => {
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true })
    render(
      <MermaidDiagram source={SOURCE} settled>
        {FALLBACK}
      </MermaidDiagram>
    )
    expect(diagrams.render).toHaveBeenCalledWith(SOURCE, 'dark')
  })
})

describe('a mermaid fence in MarkdownView', () => {
  const FENCE = `\`\`\`mermaid\n${SOURCE}\n\`\`\``

  it('keeps the language label and copies the exact source while showing the diagram', async () => {
    const copyText = vi.fn((_request: { text: string }) => Promise.resolve())
    Object.defineProperty(window, 'chorus', { value: { copyText }, configurable: true })
    const { container } = render(<MarkdownView source={FENCE} />)

    renderCall(SOURCE, 'dark').resolve(image('flow'))
    await settle()

    expect(container.querySelector('.md-code-wrap > .md-code-tools .md-lang')?.textContent).toBe(
      'mermaid'
    )
    expect(container.querySelector('.md-code-wrap > .md-diagram > img')).not.toBeNull()
    const copy = container.querySelector<HTMLButtonElement>('.md-copy')
    expect(copy).not.toBeNull()
    await act(async () => {
      copy?.click()
      await Promise.resolve()
    })
    expect(copyText).toHaveBeenCalledWith({ text: SOURCE })
  })

  it('keeps a live reply as source and draws it once the reply settles', async () => {
    const { container, rerender } = render(<MarkdownView source={FENCE} live />)
    expect(diagrams.render).not.toHaveBeenCalled()
    expect(container.querySelector('.md-code-wrap > pre.md-code')).not.toBeNull()

    rerender(<MarkdownView source={FENCE} live={false} />)
    expect(diagrams.render).toHaveBeenCalledWith(SOURCE, 'dark')
    renderCall(SOURCE, 'dark').resolve(image('flow'))
    await settle()
    expect(container.querySelector('.md-diagram > img')).not.toBeNull()
  })

  it('draws a mermaid fence nested in a quote once settled', () => {
    render(<MarkdownView source={'> ```mermaid\n> flowchart LR\n>   A --> B\n> ```'} />)
    expect(diagrams.render).toHaveBeenCalledWith('flowchart LR\n  A --> B', 'dark')
  })

  it('keeps a nested mermaid fence as source while the reply is live', () => {
    render(<MarkdownView source={'> ```mermaid\n> flowchart LR\n>   A --> B\n> ```'} live />)
    expect(diagrams.render).not.toHaveBeenCalled()
  })

  it('leaves every other language on the ordinary code path', () => {
    const { container } = render(
      <MarkdownView source={'```ts\nconst a = 1\n```\n\n```\nplain\n```\n\n```mmd\nA-->B\n```'} />
    )
    expect(diagrams.render).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.md-code-wrap > pre.md-code')).toHaveLength(3)
    expect(container.querySelector('.md-diagram')).toBeNull()
  })
})
