/* eslint-disable no-control-regex -- ANSI and C0 escapes are this module's subject, not an accident */

export interface Carried {
  readonly lines: readonly string[]
  readonly carry: string
}

export const MAX_LINE = 4_000

const ANSI =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_]/g

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

const head = (text: string): string => (text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text)
const tail = (text: string): string => (text.length > MAX_LINE ? text.slice(-MAX_LINE) : text)

/**
 * The partial lines of several terminals, held apart.
 *
 * **One buffer for every terminal was the bug.** `assemble` carries whatever
 * followed the last newline, and a single carry meant two shells producing
 * output at the same time wrote into one place: the first one's half-line was
 * completed by the second one's chunk, so the assembled line contained bytes
 * from both and was attributed to whichever terminal delivered the completion.
 * The first terminal's own bytes never reached it.
 *
 * Keyed by `terminalRefKey`, which is the whole tuple and not `id` alone.
 */
export class LineCarries {
  private readonly held = new Map<string, string>()

  /** The lines a chunk completed, leaving whatever it left open for the next. */
  push(key: string, chunk: string): readonly string[] {
    const { lines, carry } = assemble(this.held.get(key) ?? '', chunk)
    if (carry === '') this.held.delete(key)
    else this.held.set(key, carry)
    return lines
  }

  /** What is still open, ended — what a terminal's exit has to say before it goes. */
  flush(key: string): readonly string[] {
    const carry = this.held.get(key)
    if (carry === undefined) return []
    this.held.delete(key)
    return assemble(carry, '\n').lines
  }

  /**
   * Every partial goes.
   *
   * This is what changing a project's traffic source means, and it is a discard
   * rather than a flush in both directions: a half-line belongs to the source
   * being left, and ending it would send a line nobody typed a newline for.
   */
  clear(): void {
    this.held.clear()
  }
}

export const assemble = (carry: string, chunk: string): Carried => {
  const text = (carry + chunk).replace(ANSI, '').replace(/\r\n/g, '\n')
  const parts = text.split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.map((part) =>
    head(part.slice(part.lastIndexOf('\r') + 1)).replace(CONTROL, '')
  )
  return { lines, carry: tail(rest) }
}
