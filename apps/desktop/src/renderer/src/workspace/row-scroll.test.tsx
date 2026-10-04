/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useRowScroll } from './hooks.js'
import { useWorkspaceStore } from './store.js'

const lefts = new WeakMap<Element, number>()
let reachable = 0

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

function Row(props: { readonly projectId: string; readonly settled: boolean }): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  useRowScroll(row, props.projectId, props.settled, true)
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
})
