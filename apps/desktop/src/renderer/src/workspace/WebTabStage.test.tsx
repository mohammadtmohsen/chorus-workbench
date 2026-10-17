/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_RECT_MAX, BrowserRect, type BrowserState } from '../../../shared/browser-ipc.js'
import { useWorkspaceStore } from './store.js'
import { updateWebPage } from './web-pages.js'
import { WebTabStage } from './WebTabStage.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../BrowserPasswords.js', () => ({
  BrowserPasswords: () => null,
}))

type Chorus = typeof window.chorus
type GeometryRequest = Parameters<Chorus['setBrowserGeometry']>[0]

const resizeCallbacks: ResizeObserverCallback[] = []

class FakeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback)
  }

  observe(): void {
    return undefined
  }

  unobserve(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }
}

const state: BrowserState = {
  status: 'ready',
  live: true,
  url: 'http://127.0.0.1:1/page',
  title: 'page',
  icon: null,
  canGoBack: false,
  canGoForward: false,
  documentId: null,
  passwordOrigin: null,
  error: null,
  zoom: 1,
}

let box = { left: 96, top: 144.1953125, width: 1180, height: 711.8046875 }

const setBrowserGeometry = vi.fn<Chorus['setBrowserGeometry']>()
const actOnBrowser = vi.fn<Chorus['actOnBrowser']>()

const requests = (): GeometryRequest[] => setBrowserGeometry.mock.calls.map(([request]) => request)

const settle = async (ms = 120): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function Stage(props: { readonly id: string }): React.JSX.Element {
  return <WebTabStage key={props.id} webTabId={props.id} />
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number =>
    window.setTimeout(() => {
      callback(performance.now())
    }, 4)
  )
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    window.clearTimeout(handle)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ): DOMRect {
    const measured = this.classList.contains('web-stage-body')
      ? box
      : { left: 0, top: 0, width: 0, height: 0 }
    return {
      x: measured.left,
      y: measured.top,
      left: measured.left,
      top: measured.top,
      width: measured.width,
      height: measured.height,
      right: measured.left + measured.width,
      bottom: measured.top + measured.height,
      toJSON: () => measured,
    }
  })
})

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  resizeCallbacks.length = 0
  box = { left: 96, top: 144.1953125, width: 1180, height: 711.8046875 }
  setBrowserGeometry.mockReset()
  actOnBrowser.mockReset()
  setBrowserGeometry.mockImplementation((request) =>
    BrowserRect.safeParse(request.rect).success
      ? Promise.resolve({ revision: request.revision, still: null })
      : Promise.reject(new Error('Invalid request on "browser:geometry"'))
  )
  actOnBrowser.mockImplementation(() => Promise.resolve({ state, failure: null }))
  const bridge: Partial<Chorus> = { setBrowserGeometry, actOnBrowser }
  Object.assign(window, { chorus: bridge })
  useWorkspaceStore.setState({
    webTabs: { tabs: [{ id: 'tab-a' }, { id: 'tab-b' }], activeId: 'tab-a', showing: true },
  })
  updateWebPage('tab-a', { browserId: 'browser-a', state, revision: 0 })
  updateWebPage('tab-b', { browserId: 'browser-b', state, revision: 0 })
})

afterEach(() => {
  cleanup()
})

describe('WebTabStage geometry', () => {
  it('sends one valid integral rectangle for a fractional layout instead of retrying a rejected one', async () => {
    render(<Stage id="tab-a" />)
    await settle()

    expect(requests().every((request) => BrowserRect.safeParse(request.rect).success)).toBe(true)
    const shown = requests().filter((request) => request.active)
    expect(shown).toHaveLength(1)
    expect(shown[0]?.rect).toEqual({ x: 96, y: 144, width: 1180, height: 712 })
    expect(shown[0]?.bodyOrigin).toEqual({ x: 96, y: 144 })
    expect(shown[0]?.fullyVisible).toBe(true)
    expect(actOnBrowser).toHaveBeenCalledWith({ browserId: 'browser-a', action: 'focus' })
  })

  it('passes an integral layout through unchanged', async () => {
    box = { left: 100, top: 120, width: 800, height: 600 }
    render(<Stage id="tab-a" />)
    await settle()
    const shown = requests().filter((request) => request.active)
    expect(shown).toHaveLength(1)
    expect(shown[0]?.rect).toEqual({ x: 100, y: 120, width: 800, height: 600 })
  })

  it('keeps out-of-range and zero-size layouts inside the rectangle contract', async () => {
    box = { left: -40_000.4, top: 10.5, width: 0, height: 99_999.6 }
    render(<Stage id="tab-a" />)
    await settle()
    const [shown] = requests().filter((request) => request.active)
    expect(shown).toBeDefined()
    expect(BrowserRect.safeParse(shown?.rect).success).toBe(true)
    expect(shown?.rect.x).toBe(-BROWSER_RECT_MAX)
    expect(shown?.rect.width).toBe(0)
    expect(shown?.rect.height).toBe(BROWSER_RECT_MAX)
    expect(shown?.fullyVisible).toBe(false)
  })

  it('reports a resize once, with the new edges', async () => {
    render(<Stage id="tab-a" />)
    await settle()
    box = { left: 96.4, top: 150.6, width: 900.3, height: 500.2 }
    const registered = [...resizeCallbacks]
    const observer = new FakeObserver(() => undefined)
    act(() => {
      for (const callback of registered) callback([], observer)
    })
    await settle()
    const shown = requests().filter((request) => request.active)
    expect(shown).toHaveLength(2)
    expect(shown[1]?.rect).toEqual({ x: 96, y: 151, width: 901, height: 500 })
    expect(requests().every((request) => BrowserRect.safeParse(request.rect).success)).toBe(true)
  })

  it('hides the old page before showing the next across rapid A/B/A switches', async () => {
    const view = render(<Stage id="tab-a" />)
    await settle()
    view.rerender(<Stage id="tab-b" />)
    await settle()
    view.rerender(<Stage id="tab-a" />)
    await settle()
    view.unmount()

    const sequence = requests().map((request) => `${request.browserId}:${String(request.active)}`)
    expect(sequence).toEqual([
      'browser-a:true',
      'browser-a:false',
      'browser-b:true',
      'browser-b:false',
      'browser-a:true',
      'browser-a:false',
    ])
    expect(requests().every((request) => BrowserRect.safeParse(request.rect).success)).toBe(true)
    for (const browserId of ['browser-a', 'browser-b']) {
      const revisions = requests()
        .filter((request) => request.browserId === browserId)
        .map((request) => request.revision)
      expect(revisions).toEqual([...revisions].sort((left, right) => left - right))
      expect(new Set(revisions).size).toBe(revisions.length)
    }
  })
})
