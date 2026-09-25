import { describe, expect, it } from 'vitest'
import { assemble, LineCarries, MAX_LINE } from './log-lines.js'

describe('carries, one per terminal', () => {
  /*
   * One buffer for every terminal was the bug. `assemble` holds whatever came
   * after the last newline, so two shells writing at once shared it: the first
   * one's half-line was completed by the second one's chunk, which put bytes
   * from both into one line and filed it against whichever terminal happened to
   * deliver the completion.
   */
  it('keeps each terminal’s half-line to itself', () => {
    const carries = new LineCarries()

    expect(carries.push('session:c1:t1', 'alpha ')).toEqual([])
    expect(carries.push('global:t2', 'bravo ')).toEqual([])
    expect(carries.push('session:c1:t1', 'one\n')).toEqual(['alpha one'])
    expect(carries.push('global:t2', 'two\n')).toEqual(['bravo two'])
  })

  it('ends what a terminal left open, and only once', () => {
    const carries = new LineCarries()
    expect(carries.push('a', 'half')).toEqual([])
    expect(carries.flush('a')).toEqual(['half'])
    expect(carries.flush('a')).toEqual([])
    expect(carries.push('a', 'next\n')).toEqual(['next'])
  })

  it('drops every partial when the source changes, rather than ending them', () => {
    const carries = new LineCarries()
    carries.push('a', 'half')
    carries.push('b', 'half')
    carries.clear()
    expect(carries.push('a', 'whole\n')).toEqual(['whole'])
  })
})

describe('assemble', () => {
  it('returns complete lines and keeps the remainder', () => {
    expect(assemble('', 'one\ntwo\nthree')).toEqual({ lines: ['one', 'two'], carry: 'three' })
  })

  it('joins a line split across chunks', () => {
    const first = assemble('', 'metro is ')
    expect(first.lines).toEqual([])
    expect(first.carry).toBe('metro is ')

    const second = assemble(first.carry, 'listening\n')
    expect(second.lines).toEqual(['metro is listening'])
    expect(second.carry).toBe('')
  })

  it('treats a carriage return and line feed as one break', () => {
    expect(assemble('', 'one\r\ntwo\r\n')).toEqual({ lines: ['one', 'two'], carry: '' })
  })

  it('collapses a carriage-return redraw to its final state', () => {
    expect(assemble('', '\r10%\r55%\r100%\n')).toEqual({ lines: ['100%'], carry: '' })
  })

  it('keeps a redraw still in progress out of the lines', () => {
    const first = assemble('', '\r10%\r55%')
    expect(first.lines).toEqual([])
    expect(assemble(first.carry, '\r100%\n').lines).toEqual(['100%'])
  })

  it('strips colour and title sequences', () => {
    expect(assemble('', '\x1b[32mok\x1b[0m\n')).toEqual({ lines: ['ok'], carry: '' })
    expect(assemble('', '\x1b]0;a title\x07text\n')).toEqual({ lines: ['text'], carry: '' })
  })

  it('holds an escape split across chunks without mangling it', () => {
    const first = assemble('', 'before \x1b[3')
    expect(first.lines).toEqual([])
    expect(first.carry).toBe('before \x1b[3')

    const second = assemble(first.carry, '2mhello\n')
    expect(second.lines).toEqual(['before hello'])
  })

  it('stops a newline-free blob growing the carry, and keeps its newest end', () => {
    const blob = `${'x'.repeat(MAX_LINE * 3)}TAIL`
    const { lines, carry } = assemble('', blob)
    expect(lines).toEqual([])
    expect(carry).toHaveLength(MAX_LINE)
    expect(carry.endsWith('TAIL')).toBe(true)
  })

  it('clips an overlong line from the front, keeping what it was about', () => {
    const { lines } = assemble('', `HEAD${'y'.repeat(MAX_LINE * 2)}\n`)
    expect(lines[0]).toHaveLength(MAX_LINE)
    expect(lines[0]?.startsWith('HEAD')).toBe(true)
  })

  it('removes the control characters a binary write leaves behind', () => {
    expect(assemble('', 'a\x00b\x07c\x7f\n')).toEqual({ lines: ['abc'], carry: '' })
  })

  it('keeps a tab', () => {
    expect(assemble('', 'a\tb\n')).toEqual({ lines: ['a\tb'], carry: '' })
  })
})
