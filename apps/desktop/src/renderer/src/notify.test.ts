import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { roomsWaiting, trackPending } from './notify.js'

let seq = 0
function event(
  type: string,
  payload: Record<string, unknown> = {},
  conversationId = 'c1'
): TranscriptEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId,
    actor: 'claude',
    type,
    payload,
    createdAt: seq,
  }
}

describe('trackPending', () => {
  it('holds a request until it is answered', () => {
    let pending = trackPending({}, [event('approval.requested', { approvalId: 'a1' })])
    expect(roomsWaiting(pending)).toBe(1)
    pending = trackPending(pending, [event('approval.decided', { approvalId: 'a1' })])
    expect(roomsWaiting(pending)).toBe(0)
  })

  it('tells a second question from a repeat of the first', () => {
    // Why ids rather than a counter: requests and answers arrive in separate
    // pushes, and history replay can repeat one.
    let pending = trackPending({}, [event('userinput.requested', { userInputId: 'q1' })])
    pending = trackPending(pending, [event('userinput.requested', { userInputId: 'q1' })])
    expect(pending['c1']).toHaveLength(1)

    pending = trackPending(pending, [event('userinput.requested', { userInputId: 'q2' })])
    expect(pending['c1']).toHaveLength(2)
  })

  it('counts rooms, not requests', () => {
    // The badge answers "how many rooms need me", not "how many clicks".
    const pending = trackPending({}, [
      event('approval.requested', { approvalId: 'a1' }, 'c1'),
      event('approval.requested', { approvalId: 'a2' }, 'c1'),
      event('approval.requested', { approvalId: 'a3' }, 'c2'),
    ])
    expect(roomsWaiting(pending)).toBe(2)
  })

  it('is unchanged by events that are not requests', () => {
    const pending = trackPending({}, [event('turn.completed', { status: 'completed' })])
    expect(pending).toEqual({})
  })
})
