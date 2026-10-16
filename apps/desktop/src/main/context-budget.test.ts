import { describe, expect, it } from 'vitest'
import {
  contextBudget,
  deferredContext,
  fitContext,
  fitContextExcerpt,
  fitContextTail,
} from './context-budget.js'

describe('contextBudget', () => {
  it('caps context when fresh sessions have not reported usage', () => {
    expect(contextBudget('Continue this task.')).toBe(24_000)
    expect(contextBudget('', undefined, 12_000)).toBe(12_000)
    expect(contextBudget('', undefined, 80_000)).toBe(24_000)
  })

  it('reserves room for the input, instructions and answer using conservative byte accounting', () => {
    const input = 'مرحبا 🌍'.repeat(100)
    expect(contextBudget(input, { usedTokens: 50_000, maxTokens: 66_000 })).toBe(
      16_000 - 8_192 - 2_048 - Buffer.byteLength(input, 'utf8')
    )
    expect(contextBudget(input, { usedTokens: 60_000, maxTokens: 66_000 })).toBe(0)
  })

  it('falls back to the hard cap for invalid provider measurements', () => {
    expect(contextBudget('', { usedTokens: Number.NaN, maxTokens: 100_000 })).toBe(24_000)
    expect(contextBudget('', { usedTokens: 0, maxTokens: 0 })).toBe(24_000)
  })
})

describe('fitContext', () => {
  it('respects every byte boundary without breaking multibyte characters', () => {
    const input = 'Aمرحبا 🌍Z'
    for (let maximum = 0; maximum <= 20; maximum += 1) {
      const output = fitContext(input, maximum)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(maximum)
      expect(input.startsWith(output)).toBe(true)
      expect(output).not.toContain('�')
    }
  })
})

describe('fitContextTail', () => {
  it('keeps the latest answer and closing instruction when older answers fill the budget', () => {
    const latest = 'Latest answer: investigate API retries.\nContinue in this conversation.'
    const output = fitContextTail(`${'Old answer.\n'.repeat(2000)}${latest}`, 8000)
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(8000)
    expect(output.startsWith('[Older context omitted]\n')).toBe(true)
    expect(output.endsWith(latest)).toBe(true)
  })

  it('never splits a Unicode character at the start of the retained tail', () => {
    const input = 'Aمرحبا 🌍Z'.repeat(5)
    for (let maximum = 0; maximum <= Buffer.byteLength(input, 'utf8'); maximum += 1) {
      const output = fitContextTail(input, maximum)
      const body = output.replace(/^\[Older context omitted\]\n/u, '')
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(maximum)
      expect(input.endsWith(body)).toBe(true)
      expect(output).not.toContain('�')
    }
  })
})

describe('delivery excerpts', () => {
  it('keeps both ends of a quoted reply within every Unicode byte boundary', () => {
    const text = 'BEGIN مرحبا 🌍\n'.repeat(30) + 'END'
    for (let maximum = 0; maximum < 300; maximum += 1) {
      const output = fitContextExcerpt(text, maximum)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(maximum)
      expect(output).not.toContain('�')
    }
    expect(fitContextExcerpt(text, 100)).toContain('BEGIN')
    expect(fitContextExcerpt(text, 100)).toContain('END')
  })

  it('keeps the headroom fallback short and states the actual retrieval capability', () => {
    expect(Buffer.byteLength(deferredContext(true), 'utf8')).toBeLessThan(1_024)
    expect(deferredContext(true)).toContain('read_transcript')
    expect(deferredContext(false)).not.toContain('read_transcript')
  })
})
