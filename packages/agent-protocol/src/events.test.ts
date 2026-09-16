import { describe, expect, it } from 'vitest'
import { mergeUsageWindows, type UsageWindow } from './events.js'

const FIVE: UsageWindow = { id: 'five_hour', usedPercent: 25, windowMinutes: 300, resetsAt: 1_000 }
const WEEK: UsageWindow = {
  id: 'seven_day',
  usedPercent: 49,
  windowMinutes: 10_080,
  resetsAt: 2_000,
}

describe('mergeUsageWindows', () => {
  it('keeps a held window the report does not carry', () => {
    expect(mergeUsageWindows([FIVE, WEEK], [{ ...FIVE, usedPercent: 26 }])).toEqual([
      { ...FIVE, usedPercent: 26 },
      WEEK,
    ])
  })

  it('never lets a window without a percent clear one', () => {
    expect(mergeUsageWindows([FIVE, WEEK], [{ ...WEEK, usedPercent: null }])).toEqual([FIVE, WEEK])
  })

  it('adds a window it has not held before', () => {
    expect(mergeUsageWindows([FIVE], [WEEK])).toEqual([FIVE, WEEK])
  })

  it('orders the result shortest first, whatever order it arrived in', () => {
    expect(mergeUsageWindows([], [WEEK, FIVE])).toEqual([FIVE, WEEK])
  })
})
