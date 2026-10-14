export const SWIPE_COMMIT_DISTANCE = 160
export const SWIPE_FALLBACK_MS = 500
export const SWIPE_LOST_MS = 2000
export const SWIPE_SETTLE_MS = 80
export const SWIPE_EDGE_TOLERANCE = 1
export const SWIPE_DELTA_MAX = 10_000

export type SwipeDirection = 'back' | 'forward'

export interface SwipeHistory {
  readonly back: boolean
  readonly forward: boolean
  readonly zoom: number
  readonly revision: number
}

export interface ScrollBox {
  readonly root: boolean
  readonly horizontal: boolean
  readonly overflowX: string
  readonly overscrollX: string
  readonly rtl: boolean
  readonly scrollLeft: number
  readonly scrollWidth: number
  readonly clientWidth: number
}

export interface SwipeWheel {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  readonly modified: boolean
  readonly fullscreen: boolean
  readonly path: readonly ScrollBox[]
}

export type SwipeInput =
  | {
      readonly kind: 'wheel'
      readonly time: number
      readonly wheel: SwipeWheel
      readonly history: SwipeHistory
    }
  | { readonly kind: 'begin'; readonly time: number; readonly sequence: number }
  | { readonly kind: 'end'; readonly time: number; readonly sequence: number }
  | { readonly kind: 'consumed'; readonly time: number; readonly gesture: number }
  | { readonly kind: 'history'; readonly time: number; readonly history: SwipeHistory }
  | { readonly kind: 'tick'; readonly time: number }

export type SwipeState =
  | {
      readonly kind: 'idle'
      readonly gesture: number
      readonly begin: { readonly sequence: number; readonly time: number } | null
    }
  | {
      readonly kind: 'tracking'
      readonly gesture: number
      readonly sequence: number | null
      readonly direction: SwipeDirection
      readonly revision: number
      readonly distance: number
      readonly last: number
    }
  | {
      readonly kind: 'ignored'
      readonly gesture: number
      readonly sequence: number | null
      readonly last: number
    }
  | { readonly kind: 'settling'; readonly gesture: number; readonly last: number }

export interface SwipeStep {
  readonly state: SwipeState
  readonly navigate: { readonly direction: SwipeDirection; readonly revision: number } | null
}

export function usableWheel(wheel: SwipeWheel): boolean {
  return (
    wheel.deltaMode === 0 &&
    !wheel.modified &&
    Number.isFinite(wheel.deltaX) &&
    Number.isFinite(wheel.deltaY) &&
    Math.abs(wheel.deltaX) <= SWIPE_DELTA_MAX &&
    Math.abs(wheel.deltaY) <= SWIPE_DELTA_MAX &&
    (wheel.deltaX !== 0 || wheel.deltaY !== 0)
  )
}

export function pathYields(path: readonly ScrollBox[], deltaX: number): boolean {
  for (const box of path) {
    if (!box.root && box.overflowX !== 'auto' && box.overflowX !== 'scroll') continue
    const extent = Math.max(0, box.scrollWidth - box.clientWidth)
    if (!box.horizontal && extent > SWIPE_EDGE_TOLERANCE) return true
    const minimum = box.rtl ? -extent : 0
    const maximum = box.rtl ? 0 : extent
    const room =
      deltaX < 0
        ? box.scrollLeft - minimum > SWIPE_EDGE_TOLERANCE
        : maximum - box.scrollLeft > SWIPE_EDGE_TOLERANCE
    if (room || box.overscrollX !== 'auto') return true
  }
  return false
}

export function swipeProgress(state: SwipeState): number {
  return state.kind === 'tracking' ? Math.min(1, state.distance / SWIPE_COMMIT_DISTANCE) : 0
}

function finishSwipe(state: SwipeState, time: number, commit: boolean): SwipeStep {
  return {
    state: { kind: 'settling', gesture: state.gesture, last: time },
    navigate:
      commit && state.kind === 'tracking' && state.distance >= SWIPE_COMMIT_DISTANCE
        ? { direction: state.direction, revision: state.revision }
        : null,
  }
}

export function swipeReduce(state: SwipeState, input: SwipeInput): SwipeStep {
  switch (input.kind) {
    case 'begin': {
      if (state.kind === 'tracking' || state.kind === 'ignored') {
        if (state.sequence === null) {
          return { state: { ...state, sequence: input.sequence }, navigate: null }
        }
        if (state.sequence === input.sequence) return { state, navigate: null }
      }
      return {
        state: {
          kind: 'idle',
          gesture: state.gesture,
          begin: { sequence: input.sequence, time: input.time },
        },
        navigate: null,
      }
    }
    case 'end': {
      if (state.kind === 'tracking' || state.kind === 'ignored') {
        return state.sequence === input.sequence
          ? finishSwipe(state, input.time, true)
          : { state, navigate: null }
      }
      if (state.kind === 'idle' && state.begin?.sequence === input.sequence) {
        return { state: { ...state, begin: null }, navigate: null }
      }
      return { state, navigate: null }
    }
    case 'consumed': {
      if (state.kind !== 'tracking' || state.gesture !== input.gesture) {
        return { state, navigate: null }
      }
      return {
        state: {
          kind: 'ignored',
          gesture: state.gesture,
          sequence: state.sequence,
          last: state.last,
        },
        navigate: null,
      }
    }
    case 'history': {
      if (state.kind !== 'tracking' || state.revision === input.history.revision) {
        return { state, navigate: null }
      }
      return {
        state: {
          kind: 'ignored',
          gesture: state.gesture,
          sequence: state.sequence,
          last: state.last,
        },
        navigate: null,
      }
    }
    case 'tick': {
      if (state.kind === 'tracking' || state.kind === 'ignored') {
        const timeout = state.sequence === null ? SWIPE_FALLBACK_MS : SWIPE_LOST_MS
        return input.time - state.last >= timeout
          ? finishSwipe(state, input.time, state.sequence === null)
          : { state, navigate: null }
      }
      if (state.kind === 'settling' && input.time - state.last >= SWIPE_SETTLE_MS) {
        return { state: { kind: 'idle', gesture: state.gesture, begin: null }, navigate: null }
      }
      if (
        state.kind === 'idle' &&
        state.begin !== null &&
        input.time - state.begin.time >= SWIPE_LOST_MS
      ) {
        return { state: { ...state, begin: null }, navigate: null }
      }
      return { state, navigate: null }
    }
    case 'wheel': {
      if (state.kind === 'settling' && input.time - state.last < SWIPE_SETTLE_MS) {
        return { state: { ...state, last: input.time }, navigate: null }
      }
      const current: SwipeState =
        state.kind === 'settling' ? { kind: 'idle', gesture: state.gesture, begin: null } : state
      const { wheel, history, time } = input
      if (!usableWheel(wheel) || wheel.fullscreen) {
        if (
          (current.kind === 'tracking' || current.kind === 'ignored') &&
          (wheel.deltaX !== 0 || wheel.deltaY !== 0 || wheel.modified || wheel.fullscreen)
        ) {
          return {
            state: {
              kind: 'ignored',
              gesture: current.gesture,
              sequence: current.sequence,
              last: time,
            },
            navigate: null,
          }
        }
        return { state: current, navigate: null }
      }
      if (current.kind === 'ignored') {
        return { state: { ...current, last: time }, navigate: null }
      }
      if (current.kind === 'tracking') {
        if (current.revision !== history.revision) {
          return {
            state: {
              kind: 'ignored',
              gesture: current.gesture,
              sequence: current.sequence,
              last: time,
            },
            navigate: null,
          }
        }
        const distance = current.direction === 'back' ? -wheel.deltaX : wheel.deltaX
        return {
          state: {
            ...current,
            distance: Math.max(0, current.distance + distance * history.zoom),
            last: time,
          },
          navigate: null,
        }
      }
      const gesture = current.gesture + 1
      const sequence =
        current.begin !== null && time - current.begin.time < SWIPE_LOST_MS
          ? current.begin.sequence
          : null
      const direction = wheel.deltaX < 0 ? 'back' : 'forward'
      if (
        Math.abs(wheel.deltaX) <= Math.abs(wheel.deltaY) ||
        !history[direction] ||
        pathYields(wheel.path, wheel.deltaX)
      ) {
        return { state: { kind: 'ignored', gesture, sequence, last: time }, navigate: null }
      }
      return {
        state: {
          kind: 'tracking',
          gesture,
          sequence,
          direction,
          revision: history.revision,
          distance: Math.abs(wheel.deltaX) * history.zoom,
          last: time,
        },
        navigate: null,
      }
    }
  }
}
