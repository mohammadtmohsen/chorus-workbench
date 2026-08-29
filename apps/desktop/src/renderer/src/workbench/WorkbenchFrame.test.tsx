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
 * The four methods this component reaches for, and there is no fifth.
 *
 * `window.chorus` is `readonly` because the preload injects it and the renderer
 * may not, which is exactly the shape being honoured here: `defineProperty` is
 * the way in rather than an assignment that would need the type widened, and
 * `configurable` so each test installs its own bridge over the last one.
 *
 * **It said "three" and there was a fourth.** Phase 9's Editor switch added
 * `setWorkbenchVisible`, and this stub did not gain it — so the mount effect
 * threw `setWorkbenchVisible is not a function` before it ever reported bounds,
 * and all four tests in this file failed for a reason none of them was about.
 * A hand-written bridge is a second copy of an interface, and it drifts; this
 * one is spelled against `WorkbenchShellApi` so at least the *shapes* stay
 * honest, but nothing makes it complete except noticing.
 */
interface Bridge {
  readonly openWorkbench: WorkbenchShellApi['openWorkbench']
  readonly closeWorkbench: WorkbenchShellApi['closeWorkbench']
  readonly setWorkbenchBounds: WorkbenchShellApi['setWorkbenchBounds']
  readonly setWorkbenchVisible: WorkbenchShellApi['setWorkbenchVisible']
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
      // `stills` is required: hiding views hands back a JPEG of each so the
      // region does not go black. Nothing here reads them, and returning none
      // is the honest answer for a bridge that never hides anything.
      setWorkbenchVisible: () => Promise.resolve({ ok: true, stills: [] }),
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
      // `stills` is required: hiding views hands back a JPEG of each so the
      // region does not go black. Nothing here reads them, and returning none
      // is the honest answer for a bridge that never hides anything.
      setWorkbenchVisible: () => Promise.resolve({ ok: true, stills: [] }),
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
      // `stills` is required: hiding views hands back a JPEG of each so the
      // region does not go black. Nothing here reads them, and returning none
      // is the honest answer for a bridge that never hides anything.
      setWorkbenchVisible: () => Promise.resolve({ ok: true, stills: [] }),
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

/**
 * The region has a rectangle, and a zero one is a fault worth naming.
 *
 * Written after shipping exactly this bug: a sizing rule was moved onto a new
 * wrapper element as `flex: 1 1 auto`, the wrapper's parent is not a flex
 * container so the shorthand was inert, and the placeholder collapsed to zero
 * height. Main positioned the native view at zero height and the editor region
 * was black — with a healthy server, an opened surface and nothing anywhere
 * reporting a problem.
 *
 * **This is a guard, not a reproduction of the CSS fault.** jsdom performs no
 * layout, so no test here can catch a rule that fails to apply; the rectangles
 * in this file are stubbed. What the guard buys is that the *consequence* stops
 * being silent — the next time any layout change collapses the region, the pane
 * says so instead of going black. Catching the CSS itself needs a real browser
 * and belongs in the e2e suite.
 */
describe('WorkbenchFrame zero-area reporting', () => {
  function bridge(sent: WorkbenchRect[]): Bridge {
    return {
      openWorkbench: () => Promise.resolve({ viewId: VIEW }),
      closeWorkbench: () => Promise.resolve({ ok: true }),
      setWorkbenchBounds: ({ rect }) => {
        sent.push(rect)
        return Promise.resolve({ ok: true })
      },
      setWorkbenchVisible: () => Promise.resolve({ ok: true, stills: [] }),
    }
  }

  const mount = async (
    rect: WorkbenchRect
  ): Promise<{ failures: string[]; sent: WorkbenchRect[] }> => {
    const failures: string[] = []
    const sent: WorkbenchRect[] = []
    install(bridge(sent))
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
    /*
     * Past the grace window on purpose. The guard requires the region to measure
     * nothing *continuously* — a single zero frame is ordinary before first
     * layout — so a test that only settled would prove the opposite of what it
     * claims and pass for the wrong reason.
     */
    for (let pass = 0; pass < 40; pass += 1) drawFrame()
    return { failures, sent }
  }

  it('reports a region with no height, naming the size it measured', async () => {
    const { failures } = await mount({ x: 12, y: 40, width: 800, height: 0 })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('800\u00d70')
    /*
     * It must blame Chorus rather than the editor. The whole cost of the
     * original bug was hours spent looking at the server, the extraction and the
     * surface, none of which was wrong.
     */
    expect(failures[0]).toContain('layout fault in Chorus')
  })

  it('reports a region with no width too', async () => {
    const { failures } = await mount({ x: 12, y: 40, width: 0, height: 600 })
    expect(failures).toHaveLength(1)
  })

  it('says nothing at all about a region that has area', async () => {
    const { failures, sent } = await mount({ x: 12, y: 40, width: 800, height: 600 })
    expect(failures).toEqual([])
    // The control: silence must mean "measured and fine", not "never measured".
    expect(sent).toHaveLength(1)
  })

  it('reports once per mount rather than once per frame', async () => {
    const { failures } = await mount({ x: 0, y: 0, width: 0, height: 0 })
    // `mount` has already run well past the grace; these are the frames that
    // would turn one report into sixty a second if it were not latched.
    for (let pass = 0; pass < 40; pass += 1) drawFrame()
    expect(failures).toHaveLength(1)
  })

  /*
   * The control the three above need. Without it "a zero region is reported"
   * is consistent with a guard that fires on the first frame — which is what the
   * first version did, and it broke two unrelated tests in this file that had no
   * rectangle stubbed and no quarrel with geometry.
   */
  it('says nothing about a region that is briefly zero and then laid out', async () => {
    let rect: WorkbenchRect = { x: 0, y: 0, width: 0, height: 0 }
    const failures: string[] = []
    const sent: WorkbenchRect[] = []
    install(bridge(sent))
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

    // A handful of zero frames, as a real first layout produces.
    for (let pass = 0; pass < 3; pass += 1) drawFrame()
    rect = { x: 12, y: 40, width: 800, height: 600 }
    for (let pass = 0; pass < 40; pass += 1) drawFrame()

    expect(failures).toEqual([])
    expect(sent.at(-1)).toEqual({ x: 12, y: 40, width: 800, height: 600 })
  })
})
