import { beforeEach, describe, expect, it } from 'vitest'
import { ChorusEventPayload } from './events.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore } from './store.js'

const CONV = 'conv-handoff'

let db: SqliteHandle
let store: EventStore

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  store.append(
    {
      conversationId: CONV,
      actor: 'user',
      payload: { type: 'conversation.created', projectId: 'p1', title: 'Handoffs' },
    },
    1000
  )
})

const outcome = (value: string) => ({
  type: 'handoff.outcome',
  handoffId: 'h1',
  from: 'claude',
  to: 'codex',
  sourceEventIds: ['e1'],
  outcome: value,
})

describe('handoff.outcome', () => {
  it('accepts the four outcomes and nothing else', () => {
    for (const value of ['submitted', 'failed', 'cancelled', 'unavailable']) {
      expect(ChorusEventPayload.safeParse(outcome(value)).success).toBe(true)
    }
    expect(ChorusEventPayload.safeParse(outcome('delivered')).success).toBe(false)
    expect(ChorusEventPayload.safeParse(outcome('read')).success).toBe(false)
  })

  it('names its source reply even when no handoff.created was written', () => {
    const withoutSource = {
      type: 'handoff.outcome',
      handoffId: 'h1',
      from: 'claude',
      to: 'codex',
      outcome: 'cancelled',
    }
    expect(ChorusEventPayload.safeParse(withoutSource).success).toBe(false)
    expect(ChorusEventPayload.safeParse(outcome('cancelled')).success).toBe(true)
  })

  it('round-trips through the log and leaves the handoffs projection alone, on rebuild too', () => {
    store.append({
      conversationId: CONV,
      actor: 'claude',
      payload: {
        type: 'handoff.created',
        handoffId: 'h1',
        from: 'claude',
        to: 'codex',
        sourceEventIds: ['e1'],
        brief: 'Review the parser.',
      },
    })
    store.append({
      conversationId: CONV,
      actor: 'system',
      payload: {
        type: 'handoff.outcome',
        handoffId: 'h1',
        from: 'claude',
        to: 'codex',
        sourceEventIds: ['e1'],
        outcome: 'submitted',
      },
    })
    const rows = (): readonly unknown[] => db.prepare('SELECT id, to_agent FROM handoffs').all()
    expect(rows()).toEqual([{ id: 'h1', to_agent: 'codex' }])
    expect(store.read(CONV, { types: ['handoff.outcome'] }).map((event) => event.payload)).toEqual([
      {
        type: 'handoff.outcome',
        handoffId: 'h1',
        from: 'claude',
        to: 'codex',
        sourceEventIds: ['e1'],
        outcome: 'submitted',
      },
    ])
    store.rebuildProjections()
    expect(rows()).toEqual([{ id: 'h1', to_agent: 'codex' }])
  })
})

describe('Chat provenance on existing events', () => {
  const approval = (extra: Record<string, unknown>) => ({
    type: 'approval.requested',
    approvalId: 'a1',
    kind: 'mcpToolCall',
    request: {},
    expiresAt: 2000,
    ...extra,
  })
  const question = (extra: Record<string, unknown>) => ({
    type: 'userinput.requested',
    userInputId: 'q1',
    request: {},
    expiresAt: 2000,
    ...extra,
  })
  const status = (extra: Record<string, unknown>) => ({
    type: 'reply.status',
    requestId: 'discussion:s1:claude:1',
    sourceId: 's1',
    agentId: 'claude',
    phase: 'thinking',
    ...extra,
  })

  it('still parses waits and statuses written before the fields existed', () => {
    expect(ChorusEventPayload.safeParse(approval({})).success).toBe(true)
    expect(ChorusEventPayload.safeParse(approval({ mode: 'discussion' })).success).toBe(true)
    expect(ChorusEventPayload.safeParse(question({ mode: 'discussion' })).success).toBe(true)
    expect(ChorusEventPayload.safeParse(status({})).success).toBe(true)
  })

  it('carries the request a Chat wait belongs to, and refuses an empty one', () => {
    const requestId = 'discussion:s1:codex:0'
    expect(ChorusEventPayload.parse(approval({ mode: 'discussion', requestId }))).toMatchObject({
      requestId,
    })
    expect(ChorusEventPayload.parse(question({ mode: 'discussion', requestId }))).toMatchObject({
      requestId,
    })
    expect(ChorusEventPayload.safeParse(approval({ requestId: '' })).success).toBe(false)
    expect(ChorusEventPayload.safeParse(question({ requestId: '' })).success).toBe(false)
  })

  it('names the agent that handed a Chat round over, and only a real agent', () => {
    expect(ChorusEventPayload.parse(status({ from: 'codex' }))).toMatchObject({ from: 'codex' })
    expect(ChorusEventPayload.safeParse(status({ from: 'someone' })).success).toBe(false)
  })
})
