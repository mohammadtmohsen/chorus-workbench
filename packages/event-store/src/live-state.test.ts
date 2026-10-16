import type { AgentId } from '@chorus/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore, type LiveState } from './store.js'

const CONV = 'conv-live'
const PREFIXES = ['discussion:', 'discussion-user:', 'live-question:', 'live-question-user:']
const CHAT = 'discussion:s1:codex:0'

type Input = Parameters<EventStore['append']>[0]

let db: SqliteHandle
let store: EventStore

const write = (actor: Input['actor'], payload: Input['payload'], at: number): number => {
  const stored = store.append({ conversationId: CONV, actor, payload }, at)
  if (stored === null) throw new Error('the store is closed')
  return stored.seq
}

const live = (chatRequests: { requestId: string; agentId: string }[] = []): LiveState =>
  store.liveState(CONV, { chatRequests, ignoredItemRefPrefixes: PREFIXES })

const startTurn = (agent: AgentId, at: number): number =>
  write(agent, { type: 'turn.started', turnRef: `turn-${String(at)}` }, at)

const endTurn = (agent: AgentId, at: number): number =>
  write(
    agent,
    {
      type: 'turn.completed',
      turnRef: `turn-${String(at)}`,
      status: 'completed',
      userInitiated: false,
    },
    at
  )

const tool = (agent: AgentId, itemRef: string, at: number, detail: string | null = null) =>
  write(agent, { type: 'tool.started', itemRef, name: 'Read', parentRef: null, detail }, at)

const toolDone = (agent: AgentId, itemRef: string, at: number) =>
  write(agent, { type: 'tool.completed', itemRef, status: 'ok', summary: null }, at)

const status = (
  agent: AgentId,
  requestId: string,
  phase: 'waiting' | 'thinking' | 'replying' | 'done',
  at: number
) => write(agent, { type: 'reply.status', requestId, sourceId: 's1', agentId: agent, phase }, at)

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  write('user', { type: 'conversation.created', projectId: 'p1', title: 'Live' }, 1)
})

describe('the live state of a Work turn', () => {
  it('recovers an operation started long before the newest events, and drops finished ones', () => {
    const generation = startTurn('claude', 100)
    tool('claude', 'read-early', 110, 'src/a.ts')
    for (let index = 0; index < 450; index += 1) {
      tool('claude', `noise-${String(index)}`, 200 + index)
      toolDone('claude', `noise-${String(index)}`, 200 + index)
    }
    write(
      'claude',
      { type: 'command.started', itemRef: 'cmd-1', command: ['pnpm', 'test'], cwd: '/tmp' },
      900
    )
    write(
      'claude',
      { type: 'command.output', itemRef: 'cmd-1', stream: 'stdout', chunk: 'ok' },
      950
    )

    const state = live()
    expect(state.work).toEqual([{ agentId: 'claude', generation, startedAt: 100, evidenceAt: 950 }])
    expect(state.operations).toEqual([
      {
        agentId: 'claude',
        requestId: null,
        generation,
        itemRef: 'read-early',
        kind: 'tool',
        name: 'Read',
        detail: 'src/a.ts',
        startedAt: 110,
      },
      {
        agentId: 'claude',
        requestId: null,
        generation,
        itemRef: 'cmd-1',
        kind: 'command',
        name: 'pnpm test',
        detail: null,
        startedAt: 900,
      },
    ])

    write('claude', { type: 'command.completed', itemRef: 'cmd-1', exitCode: 0 }, 960)
    expect(live().operations.map((operation) => operation.itemRef)).toEqual(['read-early'])
  })

  it('keeps two agents apart when their providers reuse the same ref', () => {
    startTurn('claude', 100)
    startTurn('codex', 101)
    tool('claude', 'item-1', 110)
    tool('codex', 'item-1', 111)
    toolDone('codex', 'item-1', 120)
    expect(live().operations.map((operation) => [operation.agentId, operation.itemRef])).toEqual([
      ['claude', 'item-1'],
    ])
  })

  it('keeps Chat and live-question activity out of the Work lane, and in its own', () => {
    startTurn('codex', 100)
    status('codex', CHAT, 'waiting', 300)
    tool('codex', `${CHAT}:inspect`, 310)
    write(
      'codex',
      {
        type: 'approval.requested',
        approvalId: 'chat-approval',
        kind: 'mcpToolCall',
        request: {},
        expiresAt: 9_999,
        mode: 'discussion',
        requestId: CHAT,
      },
      320
    )
    write(
      'codex',
      { type: 'agent.message.delta', itemRef: 'live-question:q1:codex:m', text: 'aside' },
      330
    )

    const state = live([{ requestId: CHAT, agentId: 'codex' }])
    expect(state.work).toEqual([
      { agentId: 'codex', generation: expect.any(Number), startedAt: 100, evidenceAt: 100 },
    ])
    expect(state.chat).toEqual([
      { requestId: CHAT, agentId: 'codex', startedAt: 300, evidenceAt: 320 },
    ])
    expect(state.operations.map((operation) => [operation.requestId, operation.itemRef])).toEqual([
      [CHAT, `${CHAT}:inspect`],
    ])
  })

  it('forgets the open work of a turn that ended, and starts the next generation clean', () => {
    const first = startTurn('claude', 100)
    tool('claude', 'left-open', 110)
    endTurn('claude', 120)
    expect(live()).toMatchObject({ work: [], operations: [] })
    const second = startTurn('claude', 130)
    expect(second).toBeGreaterThan(first)
    expect(live()).toMatchObject({
      work: [{ agentId: 'claude', generation: second, startedAt: 130 }],
      operations: [],
    })
  })

  it('closes the lane at a session boundary, so a replaced session leaves nothing open', () => {
    startTurn('claude', 100)
    tool('claude', 'mid-flight', 110)
    write(
      'system',
      { type: 'session.ended', agentId: 'claude', sessionRef: 'old', reason: 'replaced' },
      120
    )
    expect(live()).toMatchObject({ work: [], operations: [] })
  })
})

describe('the live state of a Chat request', () => {
  it('keeps the request start through its phase changes', () => {
    status('codex', CHAT, 'waiting', 200)
    status('codex', CHAT, 'thinking', 260)
    status('codex', CHAT, 'replying', 300)
    expect(live([{ requestId: CHAT, agentId: 'codex' }]).chat).toEqual([
      { requestId: CHAT, agentId: 'codex', startedAt: 200, evidenceAt: 300 },
    ])
  })

  it('reports only the requests the runtime still holds', () => {
    status('codex', CHAT, 'thinking', 200)
    expect(live().chat).toEqual([])
    expect(live([{ requestId: 'discussion:never:codex:0', agentId: 'codex' }]).chat).toEqual([])
  })
})

describe('handoffs in the live state', () => {
  const created = (handoffId: string, at: number) =>
    write(
      'claude',
      {
        type: 'handoff.created',
        handoffId,
        from: 'claude',
        to: 'codex',
        sourceEventIds: [`reply-${handoffId}`],
        brief: 'Review it.',
      },
      at
    )
  const outcome = (
    handoffId: string,
    value: 'submitted' | 'failed' | 'cancelled' | 'unavailable',
    at: number
  ) =>
    write(
      'system',
      {
        type: 'handoff.outcome',
        handoffId,
        from: 'claude',
        to: 'codex',
        sourceEventIds: [`reply-${handoffId}`],
        outcome: value,
      },
      at
    )

  it('folds by id, keeps a standalone outcome, and keeps only the current interaction', () => {
    write('user', { type: 'user.message', text: 'earlier work', mode: 'work' }, 10)
    created('old', 20)
    write('user', { type: 'user.message', text: 'current work', mode: 'work' }, 30)
    created('h1', 40)
    outcome('h1', 'submitted', 41)
    outcome('h2', 'cancelled', 50)
    write('user', { type: 'user.message', text: 'a question', mode: 'discussion' }, 60)
    outcome('h1', 'failed', 70)

    expect(live().handoffs).toEqual([
      {
        handoffId: 'h1',
        from: 'claude',
        to: 'codex',
        sourceEventIds: ['reply-h1'],
        createdAt: 40,
        outcome: 'submitted',
        outcomeAt: 41,
      },
      {
        handoffId: 'h2',
        from: 'claude',
        to: 'codex',
        sourceEventIds: ['reply-h2'],
        createdAt: null,
        outcome: 'cancelled',
        outcomeAt: 50,
      },
    ])
  })
})

describe('wait provenance in the transcript state', () => {
  it('names the mode and request of a Chat wait, and leaves a Work wait plain', () => {
    const approval = (approvalId: string, extra: { mode?: 'discussion'; requestId?: string }) =>
      write(
        'codex',
        {
          type: 'approval.requested',
          approvalId,
          kind: 'command',
          request: {},
          expiresAt: 9_999,
          ...extra,
        },
        100
      )
    approval('work-wait', {})
    approval('chat-wait', { mode: 'discussion', requestId: CHAT })
    write(
      'codex',
      {
        type: 'userinput.requested',
        userInputId: 'chat-question',
        request: {},
        expiresAt: 9_999,
        mode: 'discussion',
        requestId: 'discussion:s2:codex:0',
      },
      110
    )

    const state = store.transcriptState(CONV)
    const work = state.approvals.find((entry) => entry.approvalId === 'work-wait')
    expect(work).not.toHaveProperty('mode')
    expect(work).not.toHaveProperty('requestId')
    expect(state.approvals.find((entry) => entry.approvalId === 'chat-wait')).toMatchObject({
      mode: 'discussion',
      requestId: CHAT,
    })
    expect(state.questions).toMatchObject([
      { userInputId: 'chat-question', mode: 'discussion', requestId: 'discussion:s2:codex:0' },
    ])
  })
})
