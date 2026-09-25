import type { TrafficRowShape } from '../../shared/ipc.js'
import { isRefusal } from './traffic-stream.js'

export const PAGE = 200

export type TrafficOutcome = 'read' | 'refused' | 'backend' | 'unreadable' | 'aborted'

type HttpRow = Extract<TrafficRowShape, { source: 'http' }>

/**
 * What a request turned out to be, in one word.
 *
 * **One function, used by the label and by the filter.** Two copies would agree
 * until one of them was edited, and the failure would be a row that says
 * "refused" while a filter for refusals hides it — a contradiction that looks
 * like a bug in the data rather than in the code.
 */
export const outcomeOf = (row: HttpRow): TrafficOutcome => {
  if (row.aborted) return 'aborted'
  if (isRefusal(row)) return 'refused'
  if (row.status === 502) return 'backend'
  if (!row.parsed) return 'unreadable'
  return 'read'
}

export const filterRows = (
  rows: readonly TrafficRowShape[],
  search: string
): readonly TrafficRowShape[] => {
  const needle = search.trim().toLowerCase()
  if (needle === '') return rows

  return rows.filter((row) =>
    row.source !== 'http'
      ? row.line.toLowerCase().includes(needle)
      : row.m.toLowerCase().includes(needle) ||
        row.u.toLowerCase().includes(needle) ||
        (row.code ?? '').toLowerCase().includes(needle) ||
        (row.nextAction ?? '').toLowerCase().includes(needle)
  )
}

export interface TrafficPage {
  readonly rows: readonly TrafficRowShape[]
  readonly index: number
  readonly count: number
}

/**
 * One page of the list, in start-time order.
 *
 * `page: null` means the last page, which is the one a person watching wants —
 * and it stays the last page as rows arrive, so a live capture does not scroll
 * out from under them. Naming a page fixes it, so paging back through history
 * holds still while new requests land above.
 *
 * A page is a slice with its bounds reported, never a truncation: the tail that
 * is not on this page is on the next one, and the control says which.
 */
export const pageOf = (
  rows: readonly TrafficRowShape[],
  page: number | null,
  size = PAGE
): TrafficPage => {
  const count = Math.max(1, Math.ceil(rows.length / size))
  const index = page === null ? count - 1 : Math.min(Math.max(page, 0), count - 1)
  return { rows: rows.slice(index * size, (index + 1) * size), index, count }
}
