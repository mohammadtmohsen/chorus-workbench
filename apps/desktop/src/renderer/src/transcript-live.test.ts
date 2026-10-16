import { describe, expect, it } from 'vitest'
import type { LiveStateWire, TranscriptEvent } from '../../shared/ipc.js'
import {
  applyTranscriptState,
  EMPTY_VIEW,
  reduceEvents,
  reduceTranscriptRead,
  type TranscriptView,
} from './transcript.js'

const CHAT = 'discussion:s1:codex:0'
const OTHER_CHAT = 'discussion:s2:codex:0'

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  actor: TranscriptEvent['actor'] = 'claude',
  at = seq * 10
): TranscriptEvent => ({
  seq,
  id: `e${String(seq)}`,
  conversationId: 'c',
  actor,
  type,
  payload: { type, ...payload },
  createdAt: at,
})

const chatStatus = (
  seq: number,
  requestId: string,
  phase: string,
  extra: Record<string, unknown> = {}
): TranscriptEvent =>
  event(
    seq,
    'reply.status',
    { requestId, sourceId: requestId, agentId: 'codex', phase, ...extra },
    'codex'
  )

const handoff = (
  seq: number,
  type: 'handoff.created' | 'handoff.outcome',
  handoffId: string,
  extra: Record<string, unknown>,
  from: 'claude' | 'codex' = 'claude'
): TranscriptEvent =>
  event(
    seq,
    type,
    {
      handoffId,
      from,
      to: from === 'claude' ? 'codex' : 'claude',
      sourceEventIds: [`r-${handoffId}`],
      ...extra,
    },
    type === 'handoff.created' ? from : 'system'
  )

const STATE = { approvals: [], questions: [], working: [], usageByActor: {} }
const NO_LIVE: LiveStateWire = { work: [], chat: [], operations: [], handoffs: [] }

const liveFields = (view: TranscriptView) => ({
  turns: view.turns,
  operations: view.operations,
  evidenceAt: view.evidenceAt,
  handoffs: view.handoffs,
  replies: view.replies,
})

describe('operations in a Work lane', () => {
  it('opens and closes them per agent, even when two providers reuse a ref', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 'c' }),
      event(2, 'turn.started', { turnRef: 'x' }, 'codex'),
      event(3, 'tool.started', { itemRef: 'r1', name: 'Read', detail: 'a.ts' }),
      event(4, 'tool.started', { itemRef: 'r1', name: 'Grep' }, 'codex'),
      event(5, 'tool.completed', { itemRef: 'r1', status: 'ok' }, 'codex'),
    ])
    expect(Object.keys(view.operations)).toEqual(['work:claude|r1'])
    expect(view.operations['work:claude|r1']).toEqual({
      agentId: 'claude',
      requestId: null,
      generation: 1,
      itemRef: 'r1',
      kind: 'tool',
      name: 'Read',
      detail: 'a.ts',
      startedAt: 30,
    })
  })

  it('refreshes evidence from command output without adding a row, and closes on completion', () => {
    const started = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 't' }),
      event(2, 'command.started', { itemRef: 'c1', command: ['pnpm', 'test'], cwd: '/tmp' }),
    ])
    const rows = started.messages.length
    const output = reduceEvents(started, [
      event(3, 'command.output', { itemRef: 'c1', stream: 'stdout', chunk: 'ok' }, 'claude', 900),
    ])
    expect(output.messages).toHaveLength(rows)
    expect(output.evidenceAt['work:claude']).toBe(900)
    expect(output.operations['work:claude|c1']?.name).toBe('pnpm test')
    const done = reduceEvents(output, [
      event(4, 'command.completed', { itemRef: 'c1', exitCode: 0 }),
    ])
    expect(done.operations).toEqual({})
  })

  it('drops a closed generation and refuses late evidence until a new turn starts', () => {
    const replaced = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 't1' }),
      event(2, 'tool.started', { itemRef: 'r1', name: 'Read' }),
      event(
        3,
        'session.ended',
        { agentId: 'claude', sessionRef: 'old', reason: 'replaced' },
        'system'
      ),
      event(4, 'tool.started', { itemRef: 'late', name: 'Read' }),
    ])
    expect(replaced.turns).toEqual({})
    expect(replaced.operations).toEqual({})
    expect(replaced.evidenceAt).toEqual({})
    const next = reduceEvents(replaced, [event(5, 'turn.started', { turnRef: 't2' })])
    expect(next.turns).toEqual({ claude: { generation: 5, startedAt: 50 } })
    expect(next.operations).toEqual({})
  })
})

describe('a new session for an agent', () => {
  it('ends its old turn without a session end, and only the newer generation works', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 'old' }),
      event(2, 'tool.started', { itemRef: 'r-old', name: 'Read' }),
      event(3, 'turn.started', { turnRef: 'x' }, 'codex'),
      chatStatus(4, CHAT, 'thinking'),
      event(
        5,
        'session.started',
        { agentId: 'claude', sessionRef: 'new', cwd: '/tmp', model: null, cliVersion: null },
        'system'
      ),
    ])
    expect(view.working).toEqual(['codex'])
    expect(view.workingSince).toEqual({ codex: 30 })
    expect(Object.keys(view.turns)).toEqual(['codex'])
    expect(view.operations).toEqual({})
    expect(Object.keys(view.replies)).toEqual([CHAT])
    expect(view.busy).toBe(true)

    const next = reduceEvents(view, [
      event(6, 'turn.started', { turnRef: 'new' }),
      event(7, 'tool.started', { itemRef: 'r-new', name: 'Grep' }),
    ])
    expect(next.turns['claude']).toEqual({ generation: 6, startedAt: 60 })
    expect(Object.keys(next.operations)).toEqual(['work:claude|r-new'])
    expect(next.working).toEqual(['codex', 'claude'])
  })
})

describe('Work and Chat for one agent', () => {
  it('keeps Chat, its waits and live questions out of the Work lane', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 'w' }, 'codex'),
      chatStatus(2, CHAT, 'waiting'),
      event(3, 'tool.started', { itemRef: `${CHAT}:inspect`, name: 'inspect' }, 'codex'),
      event(
        4,
        'approval.requested',
        {
          approvalId: 'a1',
          kind: 'mcpToolCall',
          request: {},
          expiresAt: 9_999,
          mode: 'discussion',
          requestId: CHAT,
        },
        'codex'
      ),
      event(
        5,
        'agent.message.delta',
        { itemRef: 'live-question:q:codex:m', text: 'aside' },
        'codex'
      ),
    ])
    expect(view.evidenceAt).toEqual({ 'work:codex': 10, [CHAT]: 40 })
    expect(Object.keys(view.operations)).toEqual([`${CHAT}|${CHAT}:inspect`])
    expect(view.operations[`${CHAT}|${CHAT}:inspect`]?.requestId).toBe(CHAT)
    expect(view.approvals[0]).toMatchObject({ mode: 'chat', requestId: CHAT })
  })

  it('names which of two queued Chat requests a wait blocks', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      chatStatus(1, CHAT, 'thinking'),
      chatStatus(2, OTHER_CHAT, 'waiting'),
      event(
        3,
        'userinput.requested',
        {
          userInputId: 'q1',
          request: { questions: [{ id: 'scope', question: 'Which part?', options: [] }] },
          expiresAt: 9_999,
          mode: 'discussion',
          requestId: CHAT,
        },
        'codex'
      ),
    ])
    expect(Object.keys(view.replies)).toEqual([CHAT, OTHER_CHAT])
    const waits = [...view.approvals, ...view.questions]
    expect(waits.map((wait) => [wait.mode, wait.requestId])).toEqual([['chat', CHAT]])
    expect(waits.filter((wait) => wait.requestId === OTHER_CHAT)).toEqual([])
  })
})

describe('a Chat request clock', () => {
  it('keeps the request start across phases, live and after a full read', () => {
    const from = { from: 'claude' }
    const view = reduceEvents(EMPTY_VIEW, [
      chatStatus(1, CHAT, 'waiting', from),
      chatStatus(2, CHAT, 'thinking', from),
      chatStatus(3, CHAT, 'replying', from),
    ])
    expect(view.replies[CHAT]).toMatchObject({ startedAt: 10, phaseSince: 30, from: 'claude' })

    const read = reduceTranscriptRead(EMPTY_VIEW, [], 3)
    const restored = applyTranscriptState(read, {
      ...STATE,
      replies: [chatStatus(3, CHAT, 'replying', from)],
      live: {
        ...NO_LIVE,
        chat: [{ requestId: CHAT, agentId: 'codex', startedAt: 10, evidenceAt: 30 }],
      },
    })
    expect(restored.replies[CHAT]).toMatchObject({
      phase: 'replying',
      startedAt: 10,
      phaseSince: 30,
      from: 'claude',
    })
    expect(restored.evidenceAt[CHAT]).toBe(30)
  })
})

describe('the snapshot at a read', () => {
  it('seeds a Work generation that started outside the page, then folds newer pushes on top', () => {
    const operation = {
      agentId: 'claude',
      requestId: null,
      itemRef: 'early',
      kind: 'tool' as const,
      name: 'Read',
      detail: 'a.ts',
    }
    const read = reduceTranscriptRead(EMPTY_VIEW, [], 500)
    const restored = applyTranscriptState(read, {
      ...STATE,
      working: ['claude'],
      workingSince: { claude: 100 },
      live: {
        ...NO_LIVE,
        work: [{ agentId: 'claude', generation: 50, startedAt: 100, evidenceAt: 400 }],
        operations: [
          { ...operation, generation: 50, startedAt: 110 },
          { ...operation, itemRef: 'stale', generation: 49, startedAt: 90 },
        ],
      },
    })
    expect(restored.turns).toEqual({ claude: { generation: 50, startedAt: 100 } })
    expect(Object.keys(restored.operations)).toEqual(['work:claude|early'])
    expect(restored.evidenceAt).toEqual({ 'work:claude': 400 })

    const held = reduceEvents(restored, [
      event(500, 'tool.started', { itemRef: 'already-read', name: 'Read' }),
      event(501, 'tool.completed', { itemRef: 'early', status: 'ok' }),
      event(502, 'command.started', { itemRef: 'c2', command: ['ls'], cwd: '/tmp' }),
    ])
    expect(Object.keys(held.operations)).toEqual(['work:claude|c2'])
    expect(held.operations['work:claude|c2']?.generation).toBe(50)
    expect(held.evidenceAt['work:claude']).toBe(5_020)
  })

  it('clears every live field when the authoritative state is empty', () => {
    const busy = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 't' }),
      event(2, 'tool.started', { itemRef: 'r1', name: 'Read' }),
      chatStatus(3, CHAT, 'thinking'),
      handoff(4, 'handoff.outcome', 'h1', { outcome: 'cancelled' }),
    ])
    const cleared = applyTranscriptState(busy, { ...STATE, replies: [], live: NO_LIVE })
    expect(liveFields(cleared)).toEqual({
      turns: {},
      operations: {},
      evidenceAt: {},
      handoffs: {},
      replies: {},
    })
    expect(cleared.busy).toBe(false)
  })

  it('prunes to the live lanes when an older main sends no snapshot', () => {
    const busy = reduceEvents(EMPTY_VIEW, [
      event(1, 'turn.started', { turnRef: 't' }),
      event(2, 'tool.started', { itemRef: 'r1', name: 'Read' }),
      event(3, 'turn.started', { turnRef: 'x' }, 'codex'),
      event(4, 'tool.started', { itemRef: 'r2', name: 'Read' }, 'codex'),
    ])
    const pruned = applyTranscriptState(busy, { ...STATE, working: ['codex'], replies: [] })
    expect(Object.keys(pruned.turns)).toEqual(['codex'])
    expect(Object.keys(pruned.operations)).toEqual(['work:codex|r2'])
  })
})

describe('handoffs by identity', () => {
  it('keeps standalone and simultaneous outcomes, once each, and never finishes one on a turn', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      handoff(1, 'handoff.created', 'h1', { brief: 'go' }),
      handoff(2, 'handoff.created', 'h2', { brief: 'back' }, 'codex'),
      handoff(3, 'handoff.outcome', 'h2', { outcome: 'submitted' }, 'codex'),
      handoff(4, 'handoff.outcome', 'h1', { outcome: 'failed' }),
      handoff(5, 'handoff.outcome', 'h3', { outcome: 'cancelled' }),
      handoff(6, 'handoff.outcome', 'h1', { outcome: 'submitted' }),
      event(7, 'turn.started', { turnRef: 't' }, 'codex'),
      event(8, 'turn.completed', { turnRef: 't', status: 'completed' }, 'codex'),
    ])
    expect(
      Object.values(view.handoffs).map((entry) => [
        entry.handoffId,
        entry.from,
        entry.to,
        entry.createdAt,
        entry.outcome,
      ])
    ).toEqual([
      ['h1', 'claude', 'codex', 10, 'failed'],
      ['h2', 'codex', 'claude', 20, 'submitted'],
      ['h3', 'claude', 'codex', null, 'cancelled'],
    ])
  })

  it('keeps them through a Chat message and drops them at the next Work message', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      handoff(1, 'handoff.created', 'h1', { brief: 'go' }),
      event(2, 'user.message', { text: 'a question', mode: 'discussion' }, 'user'),
      event(3, 'user.message', { text: 'aside', live: true }, 'user'),
    ])
    expect(Object.keys(view.handoffs)).toEqual(['h1'])
    const next = reduceEvents(view, [event(4, 'user.message', { text: 'next' }, 'user')])
    expect(next.handoffs).toEqual({})
  })
})

describe('live and replay agree', () => {
  it('folds the same durable facts whether events arrive together or one push at a time', () => {
    const events = [
      event(1, 'turn.started', { turnRef: 't' }),
      event(2, 'tool.started', { itemRef: 'r1', name: 'Read', detail: 'a.ts' }),
      chatStatus(3, CHAT, 'waiting'),
      event(4, 'command.started', { itemRef: 'c1', command: ['ls'], cwd: '/tmp' }),
      event(5, 'command.output', { itemRef: 'c1', stream: 'stdout', chunk: 'a' }),
      chatStatus(6, CHAT, 'thinking'),
      event(7, 'command.completed', { itemRef: 'c1', exitCode: 0 }),
      handoff(8, 'handoff.created', 'h1', { brief: 'go' }),
      handoff(9, 'handoff.outcome', 'h1', { outcome: 'submitted' }),
    ]
    const together = reduceEvents(EMPTY_VIEW, events)
    const oneByOne = events.reduce((view, next) => reduceEvents(view, [next]), EMPTY_VIEW)
    const split = reduceEvents(reduceEvents(EMPTY_VIEW, events.slice(0, 4)), events.slice(4))
    expect(liveFields(oneByOne)).toEqual(liveFields(together))
    expect(liveFields(split)).toEqual(liveFields(together))
    expect(Object.keys(together.operations)).toEqual(['work:claude|r1'])
    expect(together.replies[CHAT]).toMatchObject({ startedAt: 30, phaseSince: 60 })
    expect(together.evidenceAt['work:claude']).toBe(70)
  })
})
