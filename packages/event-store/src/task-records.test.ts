import { beforeEach, describe, expect, it } from 'vitest'
import type { ChorusEventPayload, StoredEvent } from './events.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore } from './store.js'

const CONV = 'conv-task'
const IGNORED = ['discussion:', 'live-question:']

let db: SqliteHandle
let store: EventStore

const add = (
  payload: ChorusEventPayload,
  at: number,
  actor: StoredEvent['actor'] = 'claude',
  conversationId = CONV
): StoredEvent => {
  const stored = store.append({ conversationId, actor, payload }, at)
  if (stored === null) throw new Error('store closed')
  return stored
}

const opened = (taskId: string, origin: StoredEvent, at: number): StoredEvent =>
  add({ type: 'task.opened', taskId, originEventId: origin.id, startedAt: origin.createdAt }, at)

const revised = (taskId: string, revision: number, at: number): StoredEvent =>
  add(
    {
      type: 'task.revised',
      taskId,
      agentId: 'claude',
      revision,
      source: 'chorus',
      steps: [{ id: 'a', title: 'A', status: 'active', estimateMinutes: 10 }],
    },
    at
  )

const sessionStarted = (at: number, sessionRef = 's1'): StoredEvent =>
  add(
    {
      type: 'session.started',
      agentId: 'claude',
      sessionRef,
      cwd: '/tmp',
      model: null,
      cliVersion: null,
    },
    at,
    'system'
  )

const approval = (approvalId: string, at: number, mode?: 'discussion'): StoredEvent =>
  add(
    {
      type: 'approval.requested',
      approvalId,
      kind: 'command',
      request: { id: approvalId },
      expiresAt: at + 60_000,
      ...(mode === undefined ? {} : { mode }),
    },
    at
  )

const decided = (
  approvalId: string,
  at: number,
  decidedBy: 'user' | 'policy',
  mode?: 'discussion'
): StoredEvent =>
  add(
    {
      type: 'approval.decided',
      approvalId,
      outcome: 'allow',
      scope: 'once',
      decidedBy,
      policyRuleId: decidedBy === 'policy' ? 'allow-reads' : null,
      ...(mode === undefined ? {} : { mode }),
    },
    at
  )

const typesOf = (events: readonly StoredEvent[] | undefined) =>
  (events ?? []).map((event) => event.type)

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  add({ type: 'conversation.created', projectId: 'p1', title: 'Task' }, 1, 'user')
})

describe('taskRecords', () => {
  it('is null for a conversation that never opened a task, which is every old log', () => {
    add({ type: 'user.message', text: 'hello' }, 10, 'user')
    expect(store.taskRecords(CONV)).toBeNull()
    expect(store.taskEvents(CONV)).toEqual([])
  })

  it('finds the start and the latest plan when a 400-event page cannot', () => {
    const origin = add({ type: 'user.message', text: 'build it', mode: 'work' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1001)
    for (let index = 0; index < 500; index += 1) {
      add({ type: 'agent.message.delta', itemRef: 'm1', text: 'x' }, 1002 + index)
    }
    opened('t1', origin, 5000)
    revised('t1', 1, 5001)

    const page = store.readPage(CONV, { limit: 400 })
    expect(page.some((event) => event.id === origin.id)).toBe(false)
    expect(typesOf(store.taskRecords(CONV)?.events)).toEqual([
      'user.message',
      'turn.started',
      'task.opened',
      'task.revised',
    ])
  })

  it('includes the running turn and each agent’s own session state before the request', () => {
    add(
      {
        type: 'session.started',
        agentId: 'codex',
        sessionRef: 'c1',
        cwd: '/tmp',
        model: 'm',
        cliVersion: null,
      },
      800,
      'system'
    )
    sessionStarted(850)
    add({ type: 'turn.started', turnRef: 'before' }, 900)
    const origin = add({ type: 'user.message', text: 'also this' }, 1000, 'user')
    opened('t1', origin, 1100)
    const events = store.taskRecords(CONV)?.events ?? []
    const sessions = events.flatMap((event) =>
      event.payload.type === 'session.started' ? [event.payload.agentId] : []
    )
    expect(sessions.sort()).toEqual(['claude', 'codex'])
    expect(events.find((event) => event.type === 'turn.started')?.createdAt).toBe(900)
  })

  it('returns waits as logged events in order, leaving out what policy decided at once', () => {
    const origin = add({ type: 'user.message', text: 'go' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1000)
    opened('t1', origin, 1000)
    approval('auto', 1100)
    decided('auto', 1100, 'policy')
    approval('asked', 1200)
    decided('asked', 1500, 'user')
    add(
      { type: 'userinput.requested', userInputId: 'q1', request: { id: 'q1' }, expiresAt: 0 },
      1600
    )
    const events = store.taskRecords(CONV)?.events ?? []
    const ids = events.flatMap((event) =>
      event.payload.type === 'approval.requested' || event.payload.type === 'approval.decided'
        ? [`${event.type}:${event.payload.approvalId}`]
        : event.payload.type === 'userinput.requested'
          ? [`${event.type}:${event.payload.userInputId}`]
          : []
    )
    expect(ids).toEqual([
      'approval.requested:asked',
      'approval.decided:asked',
      'userinput.requested:q1',
    ])
    const seqs = events.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('keeps the discussion provenance a wait was logged with', () => {
    const origin = add({ type: 'user.message', text: 'go' }, 1000, 'user')
    opened('t1', origin, 1000)
    approval('side', 1100, 'discussion')
    decided('side', 1200, 'user', 'discussion')
    const side = (store.taskRecords(CONV)?.events ?? []).filter(
      (event) => event.type === 'approval.requested' || event.type === 'approval.decided'
    )
    expect(side.map((event) => (event.payload as { mode?: string }).mode)).toEqual([
      'discussion',
      'discussion',
    ])
  })

  it('carries a wait that was already pending when the request arrived', () => {
    add({ type: 'turn.started', turnRef: 't0' }, 900)
    approval('early', 950)
    const origin = add({ type: 'user.message', text: 'while you wait' }, 1000, 'user')
    opened('t1', origin, 1001)
    decided('early', 1300, 'user')
    expect(
      typesOf(store.taskRecords(CONV)?.events).filter((type) => type.startsWith('approval'))
    ).toEqual(['approval.requested', 'approval.decided'])
  })

  it('takes crash evidence from the last work event, never a discussion or live reply', () => {
    sessionStarted(900)
    const origin = add({ type: 'user.message', text: 'go' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1001)
    opened('t1', origin, 1002)
    add(
      { type: 'tool.started', itemRef: 'read', name: 'Read', parentRef: null, detail: null },
      2000
    )
    add({ type: 'agent.message.delta', itemRef: 'discussion:s:claude:1:m', text: 'x' }, 2500)
    add({ type: 'agent.message.completed', itemRef: 'm', text: 'x', mode: 'discussion' }, 2600)
    add({ type: 'agent.message.delta', itemRef: 'live-question:q:claude:m', text: 'x' }, 2700)
    approval('side', 2800, 'discussion')
    add(
      { type: 'session.ended', agentId: 'claude', sessionRef: 's1', reason: 'crashed' },
      9000,
      'system'
    )
    const evidence = store.taskRecords(CONV, { ignoredItemRefPrefixes: IGNORED })?.evidence ?? []
    expect(evidence.map((event) => [event.type, event.createdAt])).toEqual([['tool.started', 2000]])
  })

  it('reads the marker startup reconciliation appends after a hard kill', () => {
    sessionStarted(900)
    const origin = add({ type: 'user.message', text: 'go' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1001)
    opened('t1', origin, 1002)
    add({ type: 'tool.started', itemRef: 'r', name: 'Read', parentRef: null, detail: null }, 2000)
    expect(store.reconcileOrphanedSessions(50_000)).toEqual({ closed: 1 })
    const records = store.taskRecords(CONV, { ignoredItemRefPrefixes: IGNORED })
    expect(records?.events.at(-1)?.payload).toMatchObject({
      type: 'session.ended',
      reason: 'crashed',
    })
    expect(records?.evidence.map((event) => event.createdAt)).toEqual([2000])
  })
})

describe('taskEvents', () => {
  it('returns the latest task and nothing from the one before it', () => {
    const first = add({ type: 'user.message', text: 'one' }, 1000, 'user')
    opened('t1', first, 1001)
    add({ type: 'task.closed', taskId: 't1', reason: 'completed' }, 1002)
    const second = add({ type: 'user.message', text: 'two' }, 2000, 'user')
    opened('t2', second, 2001)
    revised('t2', 1, 2002)
    const taskIds = store
      .taskEvents(CONV)
      .map((event) => ('taskId' in event.payload ? event.payload.taskId : null))
    expect(taskIds).toEqual(['t2', 't2'])
  })
})

describe('taskOutcomes', () => {
  it('reads closed tasks from every conversation, newest first, skipping any without one', () => {
    const outcome = {
      startedAt: 0,
      elapsedMs: 60_000,
      workingMs: 30_000,
      lanes: [
        {
          agentId: 'claude' as const,
          model: 'm1',
          firstForecastMinutes: 10,
          finalForecastMinutes: 12,
          workingMs: 30_000,
          samples: [{ estimateMinutes: 10, actualMinutes: 8 }],
        },
      ],
    }
    add({ type: 'task.closed', taskId: 'a', reason: 'completed', outcome }, 100)
    add({ type: 'task.closed', taskId: 'b', reason: 'abandoned' }, 200, 'system', 'other')
    add({ type: 'task.closed', taskId: 'c', reason: 'completed', outcome }, 300, 'claude', 'other')
    expect(store.taskOutcomes().map((record) => [record.conversationId, record.taskId])).toEqual([
      ['other', 'c'],
      [CONV, 'a'],
    ])
  })
})

describe('rebuilding', () => {
  it('replays task and limit events without a table and without drift', () => {
    const origin = add({ type: 'user.message', text: 'go' }, 1000, 'user')
    opened('t1', origin, 1001)
    revised('t1', 1, 1002)
    add({ type: 'usage.blocked', resetsAt: 5000 }, 1003)
    add({ type: 'task.closed', taskId: 't1', reason: 'completed' }, 1004)
    store.rebuildProjections()
    expect(store.projectionDrift()).toEqual([])
    expect(store.taskEvents(CONV)).toHaveLength(3)
  })
})

describe('transcriptState', () => {
  it('reports when each running turn started, which a page may not contain', () => {
    add({ type: 'turn.started', turnRef: 'old' }, 100)
    add({ type: 'turn.completed', turnRef: 'old', status: 'completed', userInitiated: false }, 200)
    add({ type: 'turn.started', turnRef: 'now' }, 300)
    add({ type: 'turn.started', turnRef: 'other' }, 350, 'codex')
    add(
      { type: 'turn.completed', turnRef: 'other', status: 'completed', userInitiated: false },
      360,
      'codex'
    )
    const state = store.transcriptState(CONV)
    expect(state.working).toEqual(['claude'])
    expect(state.workingSince).toEqual({ claude: 300 })
  })
})

describe('which turns are still running', () => {
  it('stops a turn when its session ends, and starts again with a newer turn', () => {
    sessionStarted(100)
    add({ type: 'turn.started', turnRef: 't1' }, 200)
    add(
      { type: 'session.ended', agentId: 'claude', sessionRef: 's1', reason: 'shutdown' },
      300,
      'system'
    )
    expect(store.transcriptState(CONV).working).toEqual([])
    expect(store.transcriptState(CONV).workingSince).toEqual({})
    sessionStarted(400, 's2')
    add({ type: 'turn.started', turnRef: 't2' }, 500)
    expect(store.transcriptState(CONV).working).toEqual(['claude'])
    expect(store.transcriptState(CONV).workingSince).toEqual({ claude: 500 })
  })

  it('stops an orphaned turn once startup reconciles its session, with no task at all', () => {
    sessionStarted(100)
    add({ type: 'user.message', text: 'quick question' }, 150, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 200)
    expect(store.transcriptState(CONV).working).toEqual(['claude'])
    store.reconcileOrphanedSessions(9_000)
    expect(store.taskRecords(CONV)).toBeNull()
    expect(store.transcriptState(CONV).working).toEqual([])
  })
})

describe('evidence for the session still running', () => {
  it('includes the last work event even before any session marker exists', () => {
    sessionStarted(900)
    const origin = add({ type: 'user.message', text: 'go' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1001)
    opened('t1', origin, 1002)
    add({ type: 'tool.started', itemRef: 'r', name: 'Read', parentRef: null, detail: null }, 2000)
    add({ type: 'agent.message.delta', itemRef: 'discussion:s:claude:1:m', text: 'x' }, 2100)
    const evidence = store.taskRecords(CONV, { ignoredItemRefPrefixes: IGNORED })?.evidence ?? []
    expect(evidence.map((event) => [event.type, event.createdAt])).toEqual([['tool.started', 2000]])
  })
})

describe('an earlier task read by its id', () => {
  const tool = (itemRef: string, at: number): StoredEvent =>
    add({ type: 'tool.started', itemRef, name: 'Read', parentRef: null, detail: null }, at)
  const closed = (taskId: string, at: number): StoredEvent =>
    add({ type: 'task.closed', taskId, reason: 'completed' }, at, 'system')

  const finishedThenReplaced = () => {
    sessionStarted(900)
    const first = add({ type: 'user.message', text: 'build B' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1001)
    opened('B', first, 1002)
    revised('B', 1, 1003)
    tool('b-read', 1004)
    const end = closed('B', 1010)
    add({ type: 'turn.completed', turnRef: 't1', status: 'completed', userInitiated: false }, 1011)
    const second = add({ type: 'user.message', text: 'now C' }, 1020, 'user')
    add({ type: 'turn.started', turnRef: 't2' }, 1021)
    opened('C', second, 1022)
    revised('C', 1, 1023)
    approval('c-approval', 1024)
    tool('c-read', 1025)
    return end
  }

  it('stays readable after a later task opens, bounded at its own close', () => {
    const end = finishedThenReplaced()
    const window = store.taskWindow(CONV, 'B', store.lastSeq())
    expect(window).toMatchObject({
      taskId: 'B',
      toSeq: end.seq,
      open: false,
      latest: false,
      closed: { reason: 'completed', eventId: end.id },
    })
    if (window === null) throw new Error('expected a window')
    const records = store.taskRecordsFor(window, { ignoredItemRefPrefixes: IGNORED })
    const seqs = records?.events.map((event) => event.seq) ?? []
    expect(Math.max(...seqs)).toBeLessThanOrEqual(end.seq)
    const tasks = (records?.events ?? []).flatMap((event) =>
      event.payload.type === 'task.opened' ||
      event.payload.type === 'task.revised' ||
      event.payload.type === 'task.closed'
        ? [event.payload.taskId]
        : []
    )
    expect(new Set(tasks)).toEqual(new Set(['B']))
    expect(records?.events.some((event) => event.type === 'approval.requested')).toBe(false)
  })

  it('stops the current evidence at the window end, so later work is never B’s', () => {
    const end = finishedThenReplaced()
    const window = store.taskWindow(CONV, 'B', store.lastSeq())
    if (window === null) throw new Error('expected a window')
    const evidence =
      store.taskRecordsFor(window, { ignoredItemRefPrefixes: IGNORED })?.evidence ?? []
    expect(evidence.every((event) => event.seq <= end.seq)).toBe(true)
    expect(evidence.map((event) => event.createdAt)).toContain(1004)
    const latest = store.taskRecords(CONV, { ignoredItemRefPrefixes: IGNORED })?.evidence ?? []
    expect(latest.map((event) => event.createdAt)).toContain(1025)
  })

  it('leaves the latest-task read exactly as it was', () => {
    finishedThenReplaced()
    const latest = store.taskRecords(CONV, { ignoredItemRefPrefixes: IGNORED })
    const types = latest?.events.map((event) => event.type) ?? []
    expect(types).toContain('approval.requested')
    const openedC = latest?.events.some(
      (event) => event.payload.type === 'task.opened' && event.payload.taskId === 'C'
    )
    expect(openedC).toBe(true)
  })

  it('refuses a task id the conversation never opened, or one opened after the as-of point', () => {
    const end = finishedThenReplaced()
    expect(store.taskWindow(CONV, 'never', store.lastSeq())).toBeNull()
    expect(store.taskWindow(CONV, 'C', end.seq)).toBeNull()
    expect(store.taskWindow(CONV, 'C', store.lastSeq())).toMatchObject({ open: true, latest: true })
  })

  it('marks a later request before C’s first plan, and then claims no current work for B', () => {
    sessionStarted(900)
    const first = add({ type: 'user.message', text: 'build B' }, 1000, 'user')
    add({ type: 'turn.started', turnRef: 't1' }, 1001)
    opened('B', first, 1002)
    approval('b-approval', 1003)
    const quiet = store.taskWindow(CONV, 'B', store.lastSeq())
    expect(quiet).toMatchObject({ open: true, latest: true, requestAfter: false })
    if (quiet === null) throw new Error('expected a window')
    expect(store.currentWork(quiet)?.approvals.map((wait) => wait.approvalId)).toEqual([
      'b-approval',
    ])

    add({ type: 'user.message', text: 'also do C' }, 1020, 'user')
    tool('c-read', 1021)
    const after = store.taskWindow(CONV, 'B', store.lastSeq())
    expect(after).toMatchObject({ open: true, latest: true, requestAfter: true })
    if (after === null) throw new Error('expected a window')
    expect(store.currentWork(after)).toBeNull()
  })
})
