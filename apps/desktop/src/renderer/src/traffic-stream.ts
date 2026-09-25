import { TRAFFIC_CAPTURE, type TrafficRowShape } from '../../shared/ipc.js'

import type { TrafficPush } from '../../shared/traffic-ipc.js'

export interface TrafficAttachment {
  readonly projectId: string
  readonly subscriptionId: string
  readonly captureId: string
  readonly seq: number
  readonly rows: readonly TrafficRowShape[]
}

export interface TrafficStream {
  readonly projectId: string
  readonly subscriptionId: string
  readonly captureId: string
  readonly seq: number
  readonly rows: readonly TrafficRowShape[]
  readonly needsSnapshot: boolean
}

export const EMPTY_TRAFFIC: TrafficStream = {
  projectId: '',
  subscriptionId: '',
  captureId: '',
  seq: 0,
  rows: [],
  needsSnapshot: false,
}

const isAbsolute = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

export const isRefusal = (row: Extract<TrafficRowShape, { source: 'http' }>): boolean =>
  row.status === 400 && !isAbsolute(row.u)

const windowed = (rows: readonly TrafficRowShape[]): readonly TrafficRowShape[] =>
  rows.length <= TRAFFIC_CAPTURE ? rows : rows.slice(rows.length - TRAFFIC_CAPTURE)

export const attachTraffic = (attachment: TrafficAttachment): TrafficStream => ({
  ...attachment,
  rows: windowed(attachment.rows),
  needsSnapshot: false,
})

/**
 * Whether a push belongs to this view at all.
 *
 * All three parts are checked and none is redundant. The project says the rows
 * are from the listener this view asked for; the subscription says main has not
 * replaced this document's view with a newer one; and the capture generation
 * says the rows were not produced before a Clear, which is what stops a view
 * that missed the reset from splicing two histories together.
 */
const belongs = (state: TrafficStream, push: TrafficPush): boolean =>
  push.projectId === state.projectId && push.subscriptionId === state.subscriptionId

export const reduceTraffic = (state: TrafficStream, push: TrafficPush): TrafficStream => {
  if (state.subscriptionId === '' || !belongs(state, push)) return state
  if (push.kind === 'state') return state
  if (push.kind === 'resync') {
    return state.needsSnapshot ? state : { ...state, needsSnapshot: true }
  }
  if (push.kind === 'reset') {
    return { ...state, captureId: push.captureId, seq: push.seq, rows: [], needsSnapshot: false }
  }
  if (push.captureId !== state.captureId) return state

  /*
   * Upsert, not append.
   *
   * A request writes its row twice — once when it starts, once when it settles
   * — under the same sequence, so appending would show every request twice and
   * a slow one as an empty line above its own answer. Unchanged rows are left
   * as they are, which is what keeps a push that carries nothing new from
   * redrawing the whole list.
   */
  const seq = Math.max(state.seq, push.seq)
  const rows: TrafficRowShape[] = [...state.rows]
  let changed = false
  for (const row of push.rows) {
    const at = rows.findIndex((each) => each.seq === row.seq)
    if (at === -1) {
      if (row.seq <= state.seq) continue
      rows.push(row)
      changed = true
      continue
    }
    if (JSON.stringify(rows[at]) === JSON.stringify(row)) continue
    rows[at] = row
    changed = true
  }
  // `changed` gates the state, not the scratch array: a push that carried
  // nothing new returns the same object, so React does not redraw a list whose
  // contents are identical.
  if (!changed) return seq === state.seq ? state : { ...state, seq }
  return { ...state, seq, rows: windowed(rows) }
}

export const pendingUntilAttached = (
  queued: readonly TrafficPush[],
  attachment: TrafficAttachment
): TrafficStream => queued.reduce(reduceTraffic, attachTraffic(attachment))

/** Replaces the rows with a fresh snapshot, which is how a paused view resumes. */
export const applySnapshot = (
  state: TrafficStream,
  snapshot: {
    readonly captureId: string
    readonly seq: number
    readonly rows: readonly TrafficRowShape[]
  }
): TrafficStream => ({
  ...state,
  captureId: snapshot.captureId,
  seq: snapshot.seq,
  rows: windowed(snapshot.rows),
  needsSnapshot: false,
})
