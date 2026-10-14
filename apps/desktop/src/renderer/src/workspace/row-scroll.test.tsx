/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useRowScroll } from './hooks.js'
import { useWorkspaceStore } from './store.js'

const lefts = new WeakMap<Element, number>()
let reachable = 0
let markTouched: (projectId: string) => void = () => undefined

beforeAll(() => {
  Object.defineProperty(HTMLDivElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: HTMLDivElement): number {
      return lefts.get(this) ?? 0
    },
    set(this: HTMLDivElement, value: number) {
      lefts.set(this, Math.max(0, Math.min(value, reachable)))
    },
  })
})

afterAll(() => {
  Reflect.deleteProperty(HTMLDivElement.prototype, 'scrollLeft')
})

beforeEach(() => {
  reachable = 900
  useWorkspaceStore.setState({ rowScroll: { p1: 1_500, p2: 200 } })
})

afterEach(() => {
  cleanup()
})

function Row(props: {
  readonly projectId: string
  readonly settled: boolean
  readonly origin?: number
}): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  markTouched = useRowScroll(row, props.projectId, props.settled, true, props.origin)
  return (
    <div ref={row} data-row="true">
      <div data-chat="true" />
    </div>
  )
}

const rowIn = (container: HTMLElement): HTMLDivElement => {
  const row = container.querySelector<HTMLDivElement>('[data-row]')
  if (row === null) throw new Error('the row is not drawn')
  return row
}

const saved = (): Readonly<Record<string, number>> => useWorkspaceStore.getState().rowScroll

describe('restoring a project row’s scroll', () => {
  it('keeps the initial editor width and saves full-width expansion across reopening', () => {
    reachable = 2_000
    useWorkspaceStore.setState({ rowScroll: {} })
    const view = render(<Row projectId="p1" settled origin={500} />)
    const row = rowIn(view.container)
    expect(row.scrollLeft).toBe(500)
    expect(saved()['p1']).toBeUndefined()

    fireEvent.wheel(row)
    row.scrollLeft = 0
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(-500)
    view.unmount()

    const reopened = render(<Row projectId="p1" settled origin={500} />)
    const restored = rowIn(reopened.container)
    expect(restored.scrollLeft).toBe(0)
    fireEvent.wheel(restored)
    restored.scrollLeft = 500
    fireEvent.scroll(restored)
    expect(saved()['p1']).toBe(0)
  })

  it('preserves older chat offsets through startup clamping and editor width changes', () => {
    reachable = 600
    useWorkspaceStore.setState({ rowScroll: { p1: 300 } })
    const view = render(<Row projectId="p1" settled={false} origin={500} />)
    const row = rowIn(view.container)
    expect(row.scrollLeft).toBe(600)
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(300)

    reachable = 2_000
    view.rerender(<Row projectId="p1" settled origin={500} />)
    expect(row.scrollLeft).toBe(800)
    expect(saved()['p1']).toBe(300)
    view.rerender(<Row projectId="p1" settled origin={300} />)
    expect(row.scrollLeft).toBe(600)
    expect(saved()['p1']).toBe(300)
  })

  it('holds the saved place through a short row until the run pane has settled', () => {
    const { container, rerender } = render(<Row projectId="p1" settled={false} />)
    const row = rowIn(container)
    expect(row.scrollLeft).toBe(900)
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(1_500)

    reachable = 1_540
    rerender(<Row projectId="p1" settled />)
    expect(row.scrollLeft).toBe(1_500)
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(1_500)
  })

  it('does not save the clamp when the pane never arrives, but saves a later real scroll', () => {
    const { container, rerender } = render(<Row projectId="p1" settled={false} />)
    const row = rowIn(container)
    rerender(<Row projectId="p1" settled />)
    expect(row.scrollLeft).toBe(900)
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(1_500)

    row.scrollLeft = 400
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(400)
  })

  it('lets a real swipe win while the pane is still settling, even one the row intercepts', () => {
    const { container, rerender } = render(<Row projectId="p1" settled={false} />)
    const row = rowIn(container)
    row.addEventListener(
      'wheel',
      (event) => {
        event.stopPropagation()
      },
      { capture: true }
    )
    const chat = container.querySelector('[data-chat]')
    if (chat === null) throw new Error('the chat is not drawn')
    fireEvent.wheel(chat)
    row.scrollLeft = 300
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(300)

    reachable = 1_540
    rerender(<Row projectId="p1" settled />)
    expect(row.scrollLeft).toBe(300)
  })

  it('restores each project to its own place, and never saves one over the other', () => {
    const { container, rerender } = render(<Row projectId="p1" settled={false} />)
    const row = rowIn(container)
    expect(row.scrollLeft).toBe(900)

    rerender(<Row projectId="p2" settled={false} />)
    expect(row.scrollLeft).toBe(200)
    fireEvent.scroll(row)

    reachable = 1_540
    rerender(<Row projectId="p2" settled />)
    expect(row.scrollLeft).toBe(200)
    expect(saved()).toEqual({ p1: 1_500, p2: 200 })
  })

  it('lets a browser swipe marked for this project win before the pane settles', () => {
    const { container, rerender } = render(<Row projectId="p1" settled={false} />)
    const row = rowIn(container)
    expect(row.scrollLeft).toBe(900)

    markTouched('p1')
    row.scrollLeft -= 600
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(300)

    reachable = 1_540
    rerender(<Row projectId="p1" settled />)
    expect(row.scrollLeft).toBe(300)
    expect(saved()['p1']).toBe(300)
  })

  it('still snaps back when the browser swipe is marked for another project', () => {
    const { container, rerender } = render(<Row projectId="p1" settled={false} />)
    const row = rowIn(container)

    markTouched('p2')
    row.scrollLeft -= 600
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(1_500)

    reachable = 1_540
    rerender(<Row projectId="p1" settled />)
    expect(row.scrollLeft).toBe(1_500)
    expect(saved()).toEqual({ p1: 1_500, p2: 200 })
  })

  it('ignores a mark with no restore pending, so the next restore still lands', () => {
    const { container, rerender } = render(<Row projectId="p1" settled />)
    const row = rowIn(container)
    row.scrollLeft = 400
    fireEvent.scroll(row)
    expect(saved()['p1']).toBe(400)

    markTouched('p1')
    markTouched('p2')
    expect(saved()).toEqual({ p1: 400, p2: 200 })

    rerender(<Row projectId="p2" settled={false} />)
    expect(row.scrollLeft).toBe(200)
    row.scrollLeft = 600
    fireEvent.scroll(row)
    expect(saved()['p2']).toBe(200)

    rerender(<Row projectId="p2" settled />)
    expect(row.scrollLeft).toBe(200)
    expect(saved()).toEqual({ p1: 400, p2: 200 })
  })
})
