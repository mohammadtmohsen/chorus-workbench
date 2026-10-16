import type { StoredEvent } from '@chorus/event-store'
import { composeCarryover, composeTranscript } from '@chorus/orchestrator'
import { describe, expect, it } from 'vitest'
import { conversationChain, forwardContext } from './conversation-context.js'

const event = (
  conversationId: string,
  seq: number,
  payload: StoredEvent['payload']
): StoredEvent => ({
  id: `${conversationId}-${String(seq)}`,
  conversationId,
  seq,
  payload,
  type: payload.type,
  actor: 'user',
  schemaVersion: 1,
  createdAt: seq,
})

const created = (id: string, seq: number, parent?: string, pin?: number): StoredEvent =>
  event(id, seq, {
    type: 'conversation.created',
    projectId: 'project',
    title: id,
    ...(parent === undefined ? {} : { continuedFrom: parent }),
    ...(pin === undefined
      ? {}
      : { forward: { throughSeq: pin, objective: 'API calls', sourceEventIds: [] } }),
  })

describe('conversationChain', () => {
  const root = [
    created('root', 1),
    event('root', 2, { type: 'user.message', text: 'API retry decision: three attempts.' }),
    event('root', 5, { type: 'user.message', text: 'Later root update.' }),
    event('root', 9, {
      type: 'conversation.renamed',
      title: 'Later root title',
      previousTitle: 'root',
    }),
  ]
  const middle = [
    created('middle', 3, 'root', 2),
    event('middle', 4, { type: 'user.message', text: 'API timeout decision: five seconds.' }),
    event('middle', 8, { type: 'user.message', text: 'Later middle update.' }),
  ]
  const child = [created('child', 6, 'middle', 4)]
  const rooms: Readonly<Record<string, readonly StoredEvent[]>> = { root, middle, child }
  const read = (id: string): readonly StoredEvent[] => rooms[id] ?? []

  it('keeps separate snapshot boundaries and original titles across two hops', () => {
    const chain = conversationChain(read, 'child')
    expect(
      chain.map(({ conversationId, throughSeq, title }) => ({ conversationId, throughSeq, title }))
    ).toEqual([
      { conversationId: 'root', throughSeq: 2, title: 'root' },
      { conversationId: 'middle', throughSeq: 4, title: 'middle' },
      { conversationId: 'child', throughSeq: undefined, title: 'child' },
    ])
    const context = composeCarryover(chain, { objective: 'API calls' })
    expect(context).toContain('three attempts')
    expect(context).toContain('five seconds')
    expect(context).not.toContain('Later root update')
    expect(context).not.toContain('Later middle update')
  })

  it('reads later parent records only through an explicit updates request', () => {
    const chain = conversationChain(read, 'child')
    const snapshot = composeTranscript(chain, { skip: 0, count: 50 })
    expect(snapshot).not.toContain('Later root update')
    expect(snapshot).not.toContain('Later middle update')
    const updates = composeTranscript(chain, { skip: 0, count: 50, scope: 'updates' })
    expect(updates).toContain('Later root update')
    expect(updates).toContain('Later middle update')
    expect(updates).not.toContain('three attempts')
    expect(updates).toContain('not part of this conversation')
  })

  it('uses the child creation sequence as a stable boundary for legacy rows', () => {
    const legacy = [created('legacy', 4, 'root')]
    const chain = conversationChain((id) => (id === 'legacy' ? legacy : read(id)), 'legacy')
    expect(chain[0]?.throughSeq).toBe(3)
    expect(composeCarryover(chain)).not.toContain('Later root update')
    expect(forwardContext(legacy)).toBeUndefined()
  })

  it('retains a missing source reference without exposing unrelated conversations', () => {
    const missing = [created('missing-child', 10, 'deleted', 7)]
    const chain = conversationChain(
      (id) => (id === 'missing-child' ? missing : []),
      'missing-child'
    )
    expect(chain[0]).toMatchObject({ conversationId: 'deleted', throughSeq: 7, events: [] })
    const unavailable = composeTranscript(chain, { skip: 0, count: 20, conversationId: 'deleted' })
    expect(unavailable).toContain('No longer available')
    expect(composeTranscript(chain, { skip: 0, count: 20, conversationId: 'root' })).toContain(
      'No conversation root is readable'
    )
  })

  it('stops corrupt cycles without following a parent outside the pin', () => {
    const a = [created('a', 1, 'b', 3)]
    const b = [created('b', 2, 'a', 1)]
    expect(
      conversationChain((id) => (id === 'a' ? a : b), 'a').map((source) => source.conversationId)
    ).toEqual(['b', 'a'])
    expect(conversationChain(read, 'middle', 2).map((source) => source.conversationId)).toEqual([
      'middle',
    ])
  })
})
