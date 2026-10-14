import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { LIVE_REPLY_PREFIX } from '../../shared/live-message.js'
import { EMPTY_VIEW, finalAnswerKey, reduceEvents } from './transcript.js'

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  actor: TranscriptEvent['actor'] = 'codex'
): TranscriptEvent {
  return {
    seq,
    id: `event-${String(seq)}`,
    conversationId: 'conversation',
    actor,
    type,
    payload,
    createdAt: seq,
  }
}

describe('live answers beside a task', () => {
  it('does not mark task progress as a final answer when a live question arrives', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(1, 'user.message', { text: 'Build the feature.' }, 'user'),
      event(2, 'turn.started', { turnRef: 'primary' }),
      event(3, 'agent.message.completed', { itemRef: 'progress', text: 'Editing the feature.' }),
      event(4, 'user.message', { text: 'Why this approach?', live: true }, 'user'),
      event(5, 'agent.message.completed', {
        itemRef: `${LIVE_REPLY_PREFIX}question`,
        text: 'A live explanation.',
      }),
    ])
    expect(view.working).toEqual(['codex'])
    expect(finalAnswerKey(view)).toBeNull()
    const finished = reduceEvents(view, [
      event(6, 'turn.completed', { turnRef: 'primary', status: 'completed' }),
    ])
    expect(finalAnswerKey(finished)).toBe('progress')
  })

  it('keeps an idle task answer marked when a later live answer finishes', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(1, 'agent.message.completed', {
        itemRef: 'task-result',
        text: 'The feature is written.',
      }),
      event(2, 'user.message', { text: '/ask Explain that.', live: true }, 'user'),
      event(3, 'agent.message.completed', {
        itemRef: `${LIVE_REPLY_PREFIX}question`,
        text: 'A live explanation.',
      }),
    ])
    expect(finalAnswerKey(view)).toBe('task-result')
  })
})
