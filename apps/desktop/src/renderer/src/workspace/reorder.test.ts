import { describe, expect, it } from 'vitest'
import { moveBefore, tileOffsets } from './reorder.js'

/**
 * What a swap got wrong, stated as tests.
 *
 * Dragging the last tile onto the first used to exchange the two and leave
 * everything between untouched — one gesture, two moves, and a list that did not
 * match the one being arranged.
 */
describe('moving a tile before another', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('takes the tile out and puts it back in front of its new neighbour', () => {
    expect(moveBefore(ids, 'd', 'a')).toEqual(['d', 'a', 'b', 'c'])
    expect(moveBefore(ids, 'a', 'd')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveBefore(ids, 'b', 'd')).toEqual(['a', 'c', 'b', 'd'])
  })

  /*
   * The case the swap could not express at all: everything between the two ends
   * shifts by one, rather than two tiles trading and the rest standing still.
   */
  it('shifts everything between, rather than trading two', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })

  it('sends it to the end when there is no neighbour to name', () => {
    expect(moveBefore(ids, 'a', null)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveBefore(ids, 'd', null)).toBe(ids)
  })

  /*
   * Identity is returned, not a copy, so a rail rendering from this does not
   * remount a row for every pointer move that changed nothing.
   */
  it('answers with the same array when nothing moves', () => {
    expect(moveBefore(ids, 'a', 'b')).toBe(ids)
    expect(moveBefore(ids, 'a', 'a')).toBe(ids)
    expect(moveBefore(ids, 'nope', 'a')).toBe(ids)
  })

  /*
   * A neighbour forgotten mid-drag. `null` and "gone" are different inputs and
   * both mean the end — the gesture was heading past everything that is left.
   */
  it('appends when the neighbour is no longer in the list', () => {
    expect(moveBefore(ids, 'a', 'vanished')).toEqual(['b', 'c', 'd', 'a'])
  })
})

describe('how far each tile travels', () => {
  it('reports whole tiles, signed', () => {
    const offsets = tileOffsets(['a', 'b', 'c'], ['c', 'a', 'b'])
    expect(offsets.get('c')).toBe(-2)
    expect(offsets.get('a')).toBe(1)
    expect(offsets.get('b')).toBe(1)
  })

  /*
   * Absent rather than zero: a tile that is not moving should carry no inline
   * style, or the rail writes to every tile on every frame of a drag.
   */
  it('says nothing about a tile that stays where it is', () => {
    const offsets = tileOffsets(['a', 'b', 'c'], ['b', 'a', 'c'])
    expect(offsets.has('c')).toBe(false)
    expect(offsets.get('a')).toBe(1)
    expect(offsets.get('b')).toBe(-1)
  })

  it('is empty when the order did not change', () => {
    expect(tileOffsets(['a', 'b'], ['a', 'b']).size).toBe(0)
  })

  /* A tile that left the list between the two arrays simply has no destination. */
  it('ignores a tile the previewed order does not contain', () => {
    const offsets = tileOffsets(['a', 'gone'], ['a'])
    expect(offsets.has('gone')).toBe(false)
  })
})
