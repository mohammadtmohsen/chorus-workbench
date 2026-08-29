/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WorkbenchRect, WorkbenchShellApi } from '../../../shared/workbench-ipc.js'
import { WorkbenchFrame } from './WorkbenchFrame.js'

/**
 * One rejection, two meanings, and the error cannot tell them apart.
 *
 * `setSurfaceBounds` refuses through `ownedSurface`, which says the same thing
 * for "no such id" as for "not yours" on purpose — so a bounds report that main
 * refuses carries no information about *why*. What decides here is the frame's
 * own lifecycle: after cleanup the refusal is main having torn the shell's
 * surfaces down itself, which is the race the unmount was always going to lose
 * and means nothing; while the frame is still mounted the same string says the
 * surface is gone while this component believes it is on screen, and swallowing
 * it — the answer `closeQuietly` is right to give for a *close* — would leave an
 * overlay that has silently stopped tracking and no report of it anywhere.
 *
 * There is nothing pure to extract: the judgement *is* whether the effect's
 * cleanup ran before the promise settled, so the component is mounted, driven
 * and unmounted rather than reduced.
 */

/** Main's own refusal, quoted from `ownedSurface`, not a stand-in for it. */
const VIEW = 'view-1'
const REFUSAL = `No workbench surface "${VIEW}" belongs to this window`

/**
 * The frames belong to the test, so "one frame later" is a line here rather than
 * a wait on a clock.
 *
 * jsdom's own `requestAnimationFrame` runs off a ~16 ms timer, which would make
 * every assertion below a race against it — and would make the *control* test
 * unwritable, because with a real clock "nothing was sent" and "the frame has not
 * happened yet" are the same observation. Driving the queue by hand is what lets
 * a stable rectangle be proved silent rather than assumed to be.
 *
 * There is deliberately **no `ResizeObserver` stub any more**. jsdom does not
 * implement one, so if the component still constructed one these tests would die
 * on `ResizeObserver is not defined` — its absence here is a standing check that
 * the observer really was replaced rather than merely joined.
 */
const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1

/** Runs exactly the frames outstanding now — a callback that re-arms waits. */
function drawFrame(): void {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

beforeAll(() => {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = nextFrameId
    nextFrameId += 1
    frames.set(id, callback)
    return id
  }
  window.cancelAnimationFrame = (id: number): void => {
    frames.delete(id)
  }
})

/**
 * jsdom performs no layout, so every rectangle it reports is zero and an
 * assertion that the view matches the element would pass on `0 === 0` for ever.
 * The element is therefore given a rectangle the test moves, and the assertions
 * read it back off the element rather than restating the literal.
 */
function domRect({ x, y, width, height }: WorkbenchRect): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({ x, y, width, height }),
  }
}

function measures(element: Element, read: () => WorkbenchRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => domRect(read()),
    configurable: true,
  })
}

/** What main should have been told, derived from the element and never typed twice. */
function measured(element: Element): WorkbenchRect {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function surfaceOf(container: HTMLElement): Element {
  const element = container.querySelector('.workbench-surface')
  if (element === null) throw new Error('the frame rendered no surface placeholder')
  return element
}

/**
 * The three methods this component reaches for, and there is no fourth.
 *
 * `window.chorus` is `readonly` because the preload injects it and the renderer
 * may not, which is exactly the shape being honoured here: `defineProperty` is
 * the way in rather than an assignment that would need the type widened, and
 * `configurable` so each test installs its own bridge over the last one.
 */
interface Bridge {
  readonly openWorkbench: WorkbenchShellApi['openWorkbench']
  readonly closeWorkbench: WorkbenchShellApi['closeWorkbench']
  readonly setWorkbenchBounds: WorkbenchShellApi['setWorkbenchBounds']
}

function install(bridge: Bridge): void {
  Object.defineProperty(window, 'chorus', { value: bridge, configurable: true })
}

/**
 * A bounds call whose settling this test owns, so the rejection can be made to
 * arrive strictly *after* the unmount rather than merely near it. A stub that
 * rejects immediately cannot express "late", and "late" is the whole case.
 */
interface Pending {
  readonly promise: Promise<{ ok: true }>
  readonly refuse: (error: Error) => void
}

function pending(): Pending {
  let refuse: (error: Error) => void = () => {
    // Replaced before `new Promise` returns, since an executor runs
    // synchronously. This arm exists because TypeScript cannot see that, and it
    // throws rather than no-opping so a broken assumption fails loudly.
    throw new Error('the promise executor did not run')
  }
  const promise = new Promise<{ ok: true }>((_resolve, reject) => {
    refuse = reject
  })
  return { promise, refuse }
}

/**
 * Drains the chain the component is built on — the open resolving, the state it
 * sets, the bounds effect that state runs, the report that effect makes, and the
 * rejection of it — each of which is its own turn. A macrotask boundary inside
 * `act` so React's work is flushed with the microtasks rather than after the
 * assertion.
 */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

afterEach(() => {
  cleanup()
  /*
   * An assertion rather than a reset. A frame still outstanding once the
   * component is gone is a measurement loop that never stops — invisible in a
   * test that simply cleared the queue, and in the app a `getBoundingClientRect`
   * every frame for a surface nobody can see.
   */
  expect(frames.size).toBe(0)
  frames.clear()
})

describe('WorkbenchFrame bounds reporting', () => {
  it('reports a refusal that arrives while the frame is still mounted', async () => {
    const failures: string[] = []
    const reported: string[] = []

    install({
      openWorkbench: () => Promise.resolve({ viewId: VIEW }),
      closeWorkbench: () => Promise.resolve({ ok: true }),
      setWorkbenchBounds: ({ viewId }) => {
        reported.push(viewId)
        return Promise.reject(new Error(REFUSAL))
      },
    })

    render(
      <WorkbenchFrame
        target={{ grant: 'grant-1' }}
        projectRoot="/tmp/project"
        onFailed={(message) => {
          failures.push(message)
        }}
      />
    )
    await settle()

    // The control, and it is not decoration: without it "no failure reported"
    // and "no bounds call ever attempted" are the same green.
    expect(reported).toEqual([VIEW])
    expect(failures).toEqual([REFUSAL])
  })

  it('says nothing about a refusal that arrives after cleanup', async () => {
    const failures: string[] = []
    const reported: string[] = []
    const call = pending()

    install({
      openWorkbench: () => Promise.resolve({ viewId: VIEW }),
      closeWorkbench: () => Promise.resolve({ ok: true }),
      setWorkbenchBounds: ({ viewId }) => {
        reported.push(viewId)
        return call.promise
      },
    })

    const { unmount } = render(
      <WorkbenchFrame
        target={{ grant: 'grant-1' }}
        projectRoot="/tmp/project"
        onFailed={(message) => {
          failures.push(message)
        }}
      />
    )
    await settle()

    // In flight at the moment the frame goes: the report has left, main has not
    // answered, and the unmount is about to make the answer irrelevant. A test
    // that unmounted before any call was made would pass on nothing happening.
    expect(reported).toEqual([VIEW])

    unmount()
    call.refuse(new Error(REFUSAL))
    await settle()

    expect(failures).toEqual([])
  })
})

/**
 * E1, and the case it was opened for is the second step below.
 *
 * The mechanism this replaced was a `ResizeObserver` plus a `resize` listener,
 * which between them see size and nothing else — so an element that moved without
 * changing size was tracked by neither and the view stayed where it was, over
 * whatever had taken its place. Every assertion here reads the expected rectangle
 * back off the element with `measured()` rather than restating a literal: the
 * claim is that main was told what the placeholder *is*, and a literal would only
 * prove main was told what this file typed.
 */
describe('WorkbenchFrame bounds tracking', () => {
  function trackingBridge(sent: WorkbenchRect[]): Bridge {
    return {
      openWorkbench: () => Promise.resolve({ viewId: VIEW }),
      closeWorkbench: () => Promise.resolve({ ok: true }),
      setWorkbenchBounds: ({ rect }) => {
        sent.push(rect)
        return Promise.resolve({ ok: true })
      },
    }
  }

  it('follows the placeholder through movement that changes no size', async () => {
    const sent: WorkbenchRect[] = []
    const failures: string[] = []
    let rect: WorkbenchRect = { x: 12, y: 40, width: 800, height: 600 }

    install(trackingBridge(sent))

    const { container } = render(
      <WorkbenchFrame
        target={{ grant: 'grant-1' }}
        projectRoot="/tmp/project"
        onFailed={(message) => {
          failures.push(message)
        }}
      />
    )
    const surface = surfaceOf(container)
    measures(surface, () => rect)

    // The bounds effect is gated on the id main returns, so at this point it has
    // not run: the rectangle above is in place *before* the first measurement
    // rather than racing it. If this ever fails the opening report was measuring
    // jsdom's zeros and every assertion below would still have passed.
    expect(sent).toEqual([])

    await settle()
    expect(sent).toEqual([measured(surface)])

    /*
     * The four operations E1's exit criterion names, in its order. jsdom lays
     * nothing out, so each is written as the rectangle that operation leaves
     * behind rather than as the DOM operation that would produce it — which is
     * the honest shape of the test, because the tracking under test never sees
     * the operation either. Two of the four change position and not size, and
     * those two are exactly what the old mechanism could not see.
     */
    const steps: readonly WorkbenchRect[] = [
      { x: 12, y: 40, width: 640, height: 480 }, // window resize — size, same origin
      { x: 12, y: 96, width: 640, height: 480 }, // tab switch — a taller strip pushes it down
      { x: 12, y: 96, width: 320, height: 480 }, // pane split — narrower, same origin
      { x: 340, y: 96, width: 320, height: 480 }, // sibling close — slides across, same size
    ]

    for (const step of steps) {
      rect = step
      drawFrame()
      expect(sent.at(-1)).toEqual(measured(surface))
    }

    // One report per change and not one more: the loop measures every frame, and
    // this is what says it does not *talk* every frame.
    expect(sent).toHaveLength(1 + steps.length)
    expect(failures).toEqual([])
  })

  it('says nothing at all while the rectangle is unchanged', async () => {
    const sent: WorkbenchRect[] = []
    const failures: string[] = []
    const rect: WorkbenchRect = { x: 12, y: 40, width: 800, height: 600 }

    install(trackingBridge(sent))

    const { container } = render(
      <WorkbenchFrame
        target={{ grant: 'grant-1' }}
        projectRoot="/tmp/project"
        onFailed={(message) => {
          failures.push(message)
        }}
      />
    )
    measures(surfaceOf(container), () => rect)
    await settle()

    expect(sent).toHaveLength(1)

    /*
     * The control, and the test above needs it. Without it, "one report per
     * change" is consistent with a loop that reports on every frame and simply
     * happened to be drawn once per change here.
     */
    for (let pass = 0; pass < 5; pass += 1) drawFrame()

    expect(sent).toHaveLength(1)
    expect(failures).toEqual([])
  })
})
