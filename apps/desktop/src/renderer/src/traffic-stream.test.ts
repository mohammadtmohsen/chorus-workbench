import { describe, expect, it } from 'vitest'
import { TRAFFIC_CAPTURE, type TrafficRowShape } from '../../shared/ipc.js'
import {
  applySnapshot,
  attachTraffic,
  EMPTY_TRAFFIC,
  isRefusal,
  pendingUntilAttached,
  reduceTraffic,
  type TrafficAttachment,
  type TrafficStream,
} from './traffic-stream.js'

type HttpRow = Extract<TrafficRowShape, { source: 'http' }>

const PROJECT = 'project-a'
const SUB = 'subscription-1'
const CAPTURE = 'capture-1'

const row = (seq: number, over: Partial<HttpRow> = {}): HttpRow => ({
  source: 'http',
  seq,
  requestId: `request-${String(seq)}`,
  m: 'GET',
  u: `http://127.0.0.1:9000/n/${String(seq)}`,
  dpop: false,
  status: 200,
  aborted: false,
  parsed: true,
  code: 'OK',
  nextAction: null,
  ...over,
})

const attachment = (over: Partial<TrafficAttachment> = {}): TrafficAttachment => ({
  projectId: PROJECT,
  subscriptionId: SUB,
  captureId: CAPTURE,
  seq: 0,
  rows: [],
  ...over,
})

const attached = (seq: number, over: Partial<TrafficAttachment> = {}): TrafficStream =>
  attachTraffic(attachment({ seq, rows: [row(seq)], ...over }))

describe('reduceTraffic', () => {
  it('ignores a push for another project', () => {
    const state = attached(2)
    const next = reduceTraffic(state, {
      kind: 'rows',
      projectId: 'project-b',
      subscriptionId: SUB,
      captureId: CAPTURE,
      seq: 9,
      rows: [row(9)],
    })
    expect(next).toBe(state)
  })

  it('ignores a push for a subscription this view replaced', () => {
    const state = attached(2)
    const next = reduceTraffic(state, {
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: 'subscription-2',
      captureId: CAPTURE,
      seq: 9,
      rows: [row(9)],
    })
    expect(next).toBe(state)
  })

  /*
   * The generation check is what stops a view that missed a Clear from splicing
   * an old history onto a new one. Without it the rows look plausible and are
   * two different captures.
   */
  it('ignores rows from a capture generation that was cleared', () => {
    const state = attached(2)
    const next = reduceTraffic(state, {
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: SUB,
      captureId: 'capture-old',
      seq: 9,
      rows: [row(9)],
    })
    expect(next).toBe(state)
  })

  it('drops rows the snapshot already contains', () => {
    const state = attached(5)
    const next = reduceTraffic(state, {
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: SUB,
      captureId: CAPTURE,
      seq: 7,
      rows: [row(4), row(5), row(6), row(7)],
    })
    expect(next.rows.map((each) => each.seq)).toEqual([5, 6, 7])
    expect(next.seq).toBe(7)
  })

  it('returns the same state when a push carries nothing new', () => {
    const state = attached(5)
    expect(
      reduceTraffic(state, {
        kind: 'rows',
        projectId: PROJECT,
        subscriptionId: SUB,
        captureId: CAPTURE,
        seq: 5,
        rows: [row(5)],
      })
    ).toBe(state)
  })

  it('does not move seq backwards on a late push', () => {
    const state = attached(5)
    const next = reduceTraffic(state, {
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: SUB,
      captureId: CAPTURE,
      seq: 2,
      rows: [],
    })
    expect(next.seq).toBe(5)
  })

  it('accepts a jump, which is what a coalesced push looks like', () => {
    const state = attached(3)
    const next = reduceTraffic(state, {
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: SUB,
      captureId: CAPTURE,
      seq: 90,
      rows: [row(90)],
    })
    expect(next.rows.map((each) => each.seq)).toEqual([3, 90])
    expect(next.seq).toBe(90)
  })

  it('empties the rows and adopts the new generation on a reset', () => {
    const state = attached(4)
    const next = reduceTraffic(state, {
      kind: 'reset',
      projectId: PROJECT,
      subscriptionId: SUB,
      captureId: 'capture-2',
      seq: 0,
      reason: 'cleared',
    })
    expect(next.rows).toEqual([])
    expect(next.captureId).toBe('capture-2')
    expect(next.seq).toBe(0)
    expect(next.needsSnapshot).toBe(false)
  })

  it('asks for a snapshot once, however many resyncs arrive', () => {
    const state = attached(1)
    const asked = reduceTraffic(state, {
      kind: 'resync',
      projectId: PROJECT,
      subscriptionId: SUB,
    })
    expect(asked.needsSnapshot).toBe(true)
    expect(reduceTraffic(asked, { kind: 'resync', projectId: PROJECT, subscriptionId: SUB })).toBe(
      asked
    )
  })

  it('keeps rows arriving after a resync until the snapshot is asked for', () => {
    const asked = reduceTraffic(attached(1), {
      kind: 'resync',
      projectId: PROJECT,
      subscriptionId: SUB,
    })
    const next = reduceTraffic(asked, {
      kind: 'rows',
      projectId: PROJECT,
      subscriptionId: SUB,
      captureId: CAPTURE,
      seq: 2,
      rows: [row(2)],
    })
    expect(next.rows.map((each) => each.seq)).toEqual([1, 2])
    expect(next.needsSnapshot).toBe(true)
  })

  it('ignores a push that arrives before any attachment', () => {
    expect(
      reduceTraffic(EMPTY_TRAFFIC, {
        kind: 'rows',
        projectId: PROJECT,
        subscriptionId: SUB,
        captureId: CAPTURE,
        seq: 1,
        rows: [row(1)],
      })
    ).toBe(EMPTY_TRAFFIC)
  })

  it('keeps only the newest rows once the window is full', () => {
    let state = attached(0)
    for (let seq = 1; seq <= TRAFFIC_CAPTURE + 5; seq += 1) {
      state = reduceTraffic(state, {
        kind: 'rows',
        projectId: PROJECT,
        subscriptionId: SUB,
        captureId: CAPTURE,
        seq,
        rows: [row(seq)],
      })
    }
    expect(state.rows).toHaveLength(TRAFFIC_CAPTURE)
    expect(state.rows[0]?.seq).toBe(6)
    expect(state.rows[state.rows.length - 1]?.seq).toBe(TRAFFIC_CAPTURE + 5)
  })
})

describe('applySnapshot', () => {
  it('replaces the rows and stops asking', () => {
    const asked = reduceTraffic(attached(9, { rows: [row(9)] }), {
      kind: 'resync',
      projectId: PROJECT,
      subscriptionId: SUB,
    })
    const resumed = applySnapshot(asked, {
      captureId: 'capture-2',
      seq: 2,
      rows: [row(1), row(2)],
    })
    expect(resumed.rows.map((each) => each.seq)).toEqual([1, 2])
    expect(resumed.captureId).toBe('capture-2')
    expect(resumed.needsSnapshot).toBe(false)
  })
})

describe('isRefusal', () => {
  it('is a 400 whose request line was never resolved', () => {
    expect(isRefusal(row(1, { status: 400, u: '/origin-form' }))).toBe(true)
  })

  it('is not a resolved row, whichever scheme the upstream uses', () => {
    expect(isRefusal(row(1, { status: 400, u: 'http://127.0.0.1:9000/api/x' }))).toBe(false)
    expect(isRefusal(row(1, { status: 400, u: 'https://uat.example/api/x' }))).toBe(false)
  })

  it('is not any other status', () => {
    expect(isRefusal(row(1, { status: 200, u: '/origin-form' }))).toBe(false)
    expect(isRefusal(row(1, { status: 502, u: '/origin-form' }))).toBe(false)
  })
})

describe('pendingUntilAttached', () => {
  const snapshot = attachment({ seq: 5, rows: [row(5)] })

  it('keeps a push that landed between the snapshot and the attachment', () => {
    const state = pendingUntilAttached(
      [
        {
          kind: 'rows',
          projectId: PROJECT,
          subscriptionId: SUB,
          captureId: CAPTURE,
          seq: 6,
          rows: [row(6)],
        },
      ],
      snapshot
    )
    expect(state.rows.map((each) => each.seq)).toEqual([5, 6])
    expect(state.seq).toBe(6)
  })

  it('drops a queued push the snapshot already covers', () => {
    const state = pendingUntilAttached(
      [
        {
          kind: 'rows',
          projectId: PROJECT,
          subscriptionId: SUB,
          captureId: CAPTURE,
          seq: 5,
          rows: [row(5)],
        },
      ],
      snapshot
    )
    expect(state.rows.map((each) => each.seq)).toEqual([5])
  })

  it('drops a queued push from a superseded subscription', () => {
    const state = pendingUntilAttached(
      [
        {
          kind: 'rows',
          projectId: PROJECT,
          subscriptionId: 'subscription-0',
          captureId: CAPTURE,
          seq: 9,
          rows: [row(9)],
        },
      ],
      snapshot
    )
    expect(state.rows.map((each) => each.seq)).toEqual([5])
  })

  it('replays in order, so the last push decides the sequence number', () => {
    const state = pendingUntilAttached(
      [
        {
          kind: 'rows',
          projectId: PROJECT,
          subscriptionId: SUB,
          captureId: CAPTURE,
          seq: 6,
          rows: [row(6)],
        },
        {
          kind: 'rows',
          projectId: PROJECT,
          subscriptionId: SUB,
          captureId: CAPTURE,
          seq: 8,
          rows: [row(7), row(8)],
        },
      ],
      snapshot
    )
    expect(state.rows.map((each) => each.seq)).toEqual([5, 6, 7, 8])
    expect(state.seq).toBe(8)
  })
})
