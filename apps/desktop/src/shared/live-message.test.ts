import { describe, expect, it } from 'vitest'
import { AGENT_IDS } from '@chorus/shared'
import { liveMessageAction, liveMessageText } from './live-message.js'

describe('live message routing', () => {
  it.each(AGENT_IDS)('routes status and questions for %s', (agent) => {
    expect(liveMessageAction(`@${agent} What are you doing?`)).toBe('status')
    expect(liveMessageAction(`@${agent} Why did you use this approach?`)).toBe('ask')
    expect(liveMessageAction(`@${agent} Use the other approach instead.`)).toBe('guide')
    expect(liveMessageAction(`@${agent} Stop.`)).toBe('stop')
  })

  it('keeps requests phrased as questions on the primary task', () => {
    expect(liveMessageAction('Can you fix the failing test?')).toBe('guide')
    expect(liveMessageAction('Could we add a button?')).toBe('guide')
    expect(liveMessageAction('What failed? Fix it please.')).toBe('guide')
    expect(liveMessageAction('Do that.')).toBe('guide')
  })

  it('respects an explicit Ask or Guide override', () => {
    expect(liveMessageAction('What happened?', 'guide')).toBe('guide')
    expect(liveMessageAction('The command failed.', 'ask')).toBe('ask')
    expect(liveMessageAction('/guide What happened?', 'ask')).toBe('guide')
    expect(liveMessageAction('/ask Why?', 'guide')).toBe('ask')
    expect(liveMessageText('  /ask Why?')).toBe('Why?')
  })

  it('does not start a separate reader for ordinary idle chat', () => {
    expect(liveMessageAction('Why this approach?', 'auto', false)).toBe('guide')
    expect(liveMessageAction('/ask Why this approach?', 'auto', false)).toBe('ask')
  })

  it('does not treat context or a quoted command as a Stop instruction', () => {
    expect(liveMessageAction('> stop')).toBe('guide')
    expect(liveMessageAction('```\nstop\n```')).toBe('guide')
    expect(liveMessageAction('Why did the command stop?')).toBe('ask')
    expect(liveMessageAction('What are you doing?\n\nEditor context: file.ts')).toBe('status')
    expect(liveMessageText('/ask Why?\n\nEditor context: file.ts')).toBe(
      'Why?\n\nEditor context: file.ts'
    )
  })
})
