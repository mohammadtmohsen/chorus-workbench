import { describe, expect, it } from 'vitest'
import type { TrafficRowShape } from '../../shared/ipc.js'
import { filterRows, outcomeOf, PAGE, pageOf } from './traffic-filter.js'

type HttpRow = Extract<TrafficRowShape, { source: 'http' }>
type LogRow = Extract<TrafficRowShape, { source: 'log' }>

const row = (seq: number, over: Partial<HttpRow> = {}): HttpRow => ({
  source: 'http',
  seq,
  requestId: `r${String(seq)}`,
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

const logRow = (seq: number, line: string): LogRow => ({
  source: 'log',
  seq,
  ref: { scope: 'global', id: 't1' },
  line,
  exit: null,
})

describe('outcomeOf', () => {
  it('names each situation once, in the order that matters', () => {
    expect(outcomeOf(row(1, { aborted: true, status: 400, u: '/x' }))).toBe('aborted')
    expect(outcomeOf(row(2, { status: 400, u: '/origin-form' }))).toBe('refused')
    expect(outcomeOf(row(3, { status: 502 }))).toBe('backend')
    expect(outcomeOf(row(4, { parsed: false }))).toBe('unreadable')
    expect(outcomeOf(row(5))).toBe('read')
  })
})

describe('filterRows', () => {
  const rows = [
    row(1, { m: 'GET', code: 'OK' }),
    row(2, { m: 'POST', status: 404, code: 'NOT_FOUND' }),
    row(3, { m: 'POST', status: null }),
    logRow(4, 'Metro waiting on 8081'),
  ]

  it('returns everything when nothing is asked, including for blank space', () => {
    expect(filterRows(rows, '')).toHaveLength(4)
    expect(filterRows(rows, '   ')).toHaveLength(4)
  })

  it('searches the fields the plan names, and not the body', () => {
    expect(filterRows(rows, 'not_found').map((each) => each.seq)).toEqual([2])
    expect(filterRows(rows, '/n/3').map((each) => each.seq)).toEqual([3])
  })

  it('searches a terminal line too, since nothing asks only about requests now', () => {
    expect(filterRows(rows, 'metro').map((each) => each.seq)).toEqual([4])
  })
})

describe('pageOf', () => {
  const rows = Array.from({ length: PAGE * 2 + 5 }, (_, index) => row(index + 1))

  it('shows the newest page when the page is not named', () => {
    const page = pageOf(rows, null)
    expect(page.count).toBe(3)
    expect(page.index).toBe(2)
    expect(page.rows).toHaveLength(5)
    expect(page.rows[0]?.seq).toBe(PAGE * 2 + 1)
  })

  it('holds a named page still rather than following the tail', () => {
    expect(pageOf(rows, 0).rows[0]?.seq).toBe(1)
    expect(pageOf(rows, 1).rows).toHaveLength(PAGE)
  })

  it('clamps a page past the end rather than showing nothing', () => {
    expect(pageOf(rows, 9).index).toBe(2)
    expect(pageOf(rows, -3).index).toBe(0)
  })

  it('is one page of nothing when there is nothing, not zero pages', () => {
    const page = pageOf([], null)
    expect(page.count).toBe(1)
    expect(page.rows).toEqual([])
  })
})
