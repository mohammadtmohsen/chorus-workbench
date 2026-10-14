import { describe, expect, it } from 'vitest'
import {
  SWIPE_COMMIT_DISTANCE,
  SWIPE_DELTA_MAX,
  SWIPE_FALLBACK_MS,
  SWIPE_LOST_MS,
  SWIPE_SETTLE_MS,
  pathYields,
  swipeProgress,
  swipeReduce,
  usableWheel,
  type ScrollBox,
  type SwipeHistory,
  type SwipeState,
  type SwipeWheel,
} from './browser-swipe.js'

const IDLE: SwipeState = { kind: 'idle', gesture: 0, begin: null }
const HISTORY: SwipeHistory = { back: true, forward: true, zoom: 1, revision: 4 }

function box(overrides: Partial<ScrollBox> = {}): ScrollBox {
  return {
    root: true,
    horizontal: true,
    overflowX: 'auto',
    overscrollX: 'auto',
    rtl: false,
    scrollLeft: 0,
    scrollWidth: 100,
    clientWidth: 100,
    ...overrides,
  }
}

function wheel(overrides: Partial<SwipeWheel> = {}): SwipeWheel {
  return {
    deltaX: -20,
    deltaY: 0,
    deltaMode: 0,
    modified: false,
    fullscreen: false,
    path: [box()],
    ...overrides,
  }
}

function move(
  state: SwipeState,
  time: number,
  sample: Partial<SwipeWheel> = {},
  history: Partial<SwipeHistory> = {}
): SwipeState {
  return swipeReduce(state, {
    kind: 'wheel',
    time,
    wheel: wheel(sample),
    history: { ...HISTORY, ...history },
  }).state
}

function begin(state: SwipeState, sequence: number, time: number): SwipeState {
  return swipeReduce(state, { kind: 'begin', sequence, time }).state
}

describe('web tab swipe opening', () => {
  it.each([
    ['back', -20],
    ['forward', 20],
  ] as const)('tracks a horizontal start toward %s at the edge', (direction, deltaX) => {
    expect(move(IDLE, 0, { deltaX })).toMatchObject({
      kind: 'tracking',
      gesture: 1,
      sequence: null,
      direction,
      revision: HISTORY.revision,
      distance: 20,
    })
  })

  it('keeps a vertical-first gesture ignored when it becomes horizontal', () => {
    const vertical = move(IDLE, 0, { deltaX: -1, deltaY: 20 })
    expect(vertical.kind).toBe('ignored')
    expect(move(vertical, 10, { deltaX: -200 }).kind).toBe('ignored')
  })

  it.each([
    { modified: true },
    { fullscreen: true },
    { deltaMode: 1 },
    { deltaMode: 2 },
    { deltaX: SWIPE_DELTA_MAX + 1 },
    { deltaY: -SWIPE_DELTA_MAX - 1 },
    { deltaX: Number.NaN },
    { deltaY: Number.POSITIVE_INFINITY },
    { deltaX: 0, deltaY: 0 },
  ])('does not open a gesture for an unusable start %j', (sample) => {
    expect(move(IDLE, 0, sample)).toEqual(IDLE)
  })

  it('does not treat a zero-delta sample as a vertical start', () => {
    const zero = move(IDLE, 0, { deltaX: 0, deltaY: 0 })
    expect(move(zero, 1).kind).toBe('tracking')
  })

  it.each([
    [-20, { back: false }],
    [20, { forward: false }],
  ] as const)('ignores a direction without history', (deltaX, history) => {
    expect(move(IDLE, 0, { deltaX }, history).kind).toBe('ignored')
  })

  it('validates finite bounded pixel deltas independently of scroll ownership', () => {
    expect(usableWheel(wheel())).toBe(true)
    expect(usableWheel(wheel({ deltaX: -SWIPE_DELTA_MAX }))).toBe(true)
    expect(usableWheel(wheel({ modified: true }))).toBe(false)
    expect(usableWheel(wheel({ deltaMode: 1 }))).toBe(false)
    expect(usableWheel(wheel({ deltaX: Number.NEGATIVE_INFINITY }))).toBe(false)
    expect(usableWheel(wheel({ deltaY: SWIPE_DELTA_MAX + 1 }))).toBe(false)
    expect(usableWheel(wheel({ deltaX: 0, deltaY: 0 }))).toBe(false)
  })
})

describe('web tab swipe scroll paths', () => {
  it('yields to a nested container or a root with room in the direction', () => {
    const nested = box({ root: false, scrollWidth: 300, scrollLeft: 20 })
    expect(pathYields([nested, box()], -20)).toBe(true)
    expect(pathYields([box({ scrollWidth: 300 })], 20)).toBe(true)
    expect(pathYields([box({ scrollWidth: 300 })], -20)).toBe(false)
  })

  it('uses negative RTL ranges in both directions', () => {
    const rtl = box({ rtl: true, scrollWidth: 300, scrollLeft: -100 })
    expect(pathYields([rtl], -20)).toBe(true)
    expect(pathYields([rtl], 20)).toBe(true)
    expect(pathYields([{ ...rtl, scrollLeft: -200 }], -20)).toBe(false)
    expect(pathYields([{ ...rtl, scrollLeft: 0 }], 20)).toBe(false)
    expect(move(IDLE, 0, { path: [rtl] }).kind).toBe('ignored')
  })

  it('treats fractional positions within one pixel as the edge', () => {
    expect(pathYields([box({ scrollWidth: 300, scrollLeft: 0.5 })], -20)).toBe(false)
    expect(pathYields([box({ scrollWidth: 300, scrollLeft: 199.5 })], 20)).toBe(false)
    expect(pathYields([box({ scrollWidth: 300, scrollLeft: 1.5 })], -20)).toBe(true)
    expect(move(IDLE, 0, { path: [box({ scrollLeft: 0.5 })] }).kind).toBe('tracking')
  })

  it('yields conservatively for a vertical writing mode with horizontal overflow', () => {
    const vertical = box({ horizontal: false, scrollWidth: 300 })
    expect(pathYields([vertical], -20)).toBe(true)
    expect(move(IDLE, 0, { path: [vertical] }).kind).toBe('ignored')
  })

  it.each(['contain', 'none'])('blocks navigation for overscroll-behavior-x %s', (value) => {
    const contained = box({ root: false, overscrollX: value })
    expect(pathYields([contained, box()], -20)).toBe(true)
    expect(move(IDLE, 0, { path: [contained, box()] }).kind).toBe('ignored')
  })

  it('ignores non-container overflow when walking the path', () => {
    const plain = box({ root: false, overflowX: 'visible', overscrollX: 'none' })
    expect(pathYields([plain, box()], -20)).toBe(false)
  })

  it('keeps a gesture that started scrolling ignored after it reaches the edge', () => {
    const scrolling = move(IDLE, 0, { path: [box({ scrollWidth: 300, scrollLeft: 50 })] })
    const adopted = begin(scrolling, 1, 1)
    const edge = move(adopted, 10, { deltaX: -200, path: [box()] })
    expect(edge.kind).toBe('ignored')
    expect(swipeReduce(edge, { kind: 'end', sequence: 1, time: 11 }).navigate).toBeNull()
  })
})

describe('web tab swipe distance', () => {
  it('pulls back on reversal and floors distance at zero without changing direction', () => {
    const started = move(IDLE, 0, { deltaX: -60 })
    const pulled = move(started, 1, { deltaX: 20, deltaY: 100 })
    expect(pulled).toMatchObject({ kind: 'tracking', direction: 'back', distance: 40 })
    expect(move(pulled, 2, { deltaX: 80 })).toMatchObject({
      kind: 'tracking',
      direction: 'back',
      distance: 0,
    })
  })

  it('scales accumulated distance by zoom and caps bubble progress', () => {
    const started = move(IDLE, 0, { deltaX: -40 }, { zoom: 2 })
    expect(swipeProgress(started)).toBe(0.5)
    const continued = move(started, 1, { deltaX: -60 }, { zoom: 2 })
    expect(continued).toMatchObject({ kind: 'tracking', distance: 200 })
    expect(swipeProgress(continued)).toBe(1)
    expect(swipeProgress(IDLE)).toBe(0)
  })
})

describe('web tab swipe sequence endings', () => {
  it.each([
    [SWIPE_COMMIT_DISTANCE, { direction: 'back', revision: HISTORY.revision }],
    [SWIPE_COMMIT_DISTANCE - 1, null],
  ] as const)('resolves an adopted end at distance %i', (distance, navigate) => {
    const started = move(IDLE, 0, { deltaX: -distance })
    const adopted = begin(started, 7, 1)
    const ended = swipeReduce(adopted, { kind: 'end', sequence: 7, time: 2 })
    expect(ended.state.kind).toBe('settling')
    expect(ended.navigate).toEqual(navigate)
  })

  it('uses a begin received before the first usable wheel', () => {
    const pending = begin(IDLE, 3, 0)
    const started = move(pending, 1, { deltaX: -SWIPE_COMMIT_DISTANCE })
    expect(started).toMatchObject({ kind: 'tracking', sequence: 3 })
    expect(swipeReduce(started, { kind: 'end', sequence: 3, time: 2 }).navigate).toEqual({
      direction: 'back',
      revision: HISTORY.revision,
    })
  })

  it('does not commit a pause while an adopted sequence is still open', () => {
    const started = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    const paused = swipeReduce(started, { kind: 'tick', time: SWIPE_FALLBACK_MS + 1 })
    expect(paused.state).toEqual(started)
    expect(paused.navigate).toBeNull()
  })

  it('ignores an end belonging to another sequence', () => {
    const started = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    expect(swipeReduce(started, { kind: 'end', sequence: 2, time: 2 })).toEqual({
      state: started,
      navigate: null,
    })
  })

  it('cancels a lost adopted end after the lost timeout without navigating', () => {
    const started = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    expect(swipeReduce(started, { kind: 'tick', time: SWIPE_LOST_MS - 1 }).state).toEqual(started)
    const lost = swipeReduce(started, { kind: 'tick', time: SWIPE_LOST_MS })
    expect(lost.state.kind).toBe('settling')
    expect(lost.navigate).toBeNull()
  })

  it('resolves the fallback only after quiet without an adopted begin', () => {
    const started = move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE })
    expect(swipeReduce(started, { kind: 'tick', time: SWIPE_FALLBACK_MS - 1 }).state).toEqual(
      started
    )
    expect(swipeReduce(started, { kind: 'tick', time: SWIPE_FALLBACK_MS }).navigate).toEqual({
      direction: 'back',
      revision: HISTORY.revision,
    })
    const short = move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE + 1 })
    expect(swipeReduce(short, { kind: 'tick', time: SWIPE_FALLBACK_MS }).navigate).toBeNull()
  })
})

describe('web tab swipe settling and cancellation', () => {
  it('swallows tail wheels until a quiet settling interval has passed', () => {
    const started = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    const ended = swipeReduce(started, { kind: 'end', sequence: 1, time: 2 }).state
    const tail = move(ended, 3, { deltaX: -200 })
    expect(tail.kind).toBe('settling')
    expect(swipeReduce(tail, { kind: 'tick', time: 3 + SWIPE_SETTLE_MS - 1 }).state).toEqual(
      tail
    )
    const quiet = swipeReduce(tail, { kind: 'tick', time: 3 + SWIPE_SETTLE_MS }).state
    expect(quiet.kind).toBe('idle')
    expect(move(quiet, 4 + SWIPE_SETTLE_MS).gesture).toBe(started.gesture + 1)
  })

  it('opens a new sequence during settling and resolves two rapid gestures separately', () => {
    const first = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    const firstEnd = swipeReduce(first, { kind: 'end', sequence: 1, time: 2 })
    const secondBegin = begin(firstEnd.state, 2, 3)
    const second = move(secondBegin, 4, { deltaX: SWIPE_COMMIT_DISTANCE })
    const secondEnd = swipeReduce(second, { kind: 'end', sequence: 2, time: 5 })
    expect(firstEnd.navigate).toEqual({ direction: 'back', revision: HISTORY.revision })
    expect(secondEnd.navigate).toEqual({ direction: 'forward', revision: HISTORY.revision })
    expect(second.gesture).toBe(first.gesture + 1)
  })

  it('ignores a gesture consumed by the page', () => {
    const started = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    const consumed = swipeReduce(started, {
      kind: 'consumed',
      gesture: started.gesture,
      time: 2,
    }).state
    expect(consumed.kind).toBe('ignored')
    expect(swipeReduce(consumed, { kind: 'end', sequence: 1, time: 3 }).navigate).toBeNull()
  })

  it('does not let a stale cancellation consume the next gesture', () => {
    const first = begin(move(IDLE, 0), 1, 1)
    const ended = swipeReduce(first, { kind: 'end', sequence: 1, time: 2 }).state
    const second = move(begin(ended, 2, 3), 4)
    expect(
      swipeReduce(second, { kind: 'consumed', gesture: first.gesture, time: 5 }).state
    ).toEqual(second)
  })

  it('cancels on a history revision change, including same-document navigation', () => {
    const started = begin(move(IDLE, 0, { deltaX: -SWIPE_COMMIT_DISTANCE }), 1, 1)
    const unchanged = swipeReduce(started, { kind: 'history', history: HISTORY, time: 2 })
    expect(unchanged.state).toEqual(started)
    const changed = swipeReduce(started, {
      kind: 'history',
      history: { ...HISTORY, revision: HISTORY.revision + 1 },
      time: 3,
    }).state
    expect(changed.kind).toBe('ignored')
    expect(swipeReduce(changed, { kind: 'end', sequence: 1, time: 4 }).navigate).toBeNull()
  })
})
