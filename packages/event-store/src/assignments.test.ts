import { beforeEach, describe, expect, it } from 'vitest'
import type { ChorusEventPayload, StoredEvent } from './events.js'
import { openSqlite, type SqliteHandle } from './sqlite.js'
import { EventStore, type AssignmentScope, type TaskWindow } from './store.js'

const PARENT = 'parent'
const CHILD = 'child'
const PREFIXES = ['discussion:', 'discussion-user:', 'live-question:', 'live-question-user:']
const CHAT = 'discussion:s1:claude:0'

let db: SqliteHandle
let store: EventStore
let clock = 0

const add = (
  payload: ChorusEventPayload,
  actor: StoredEvent['actor'] = 'claude',
  conversationId = CHILD
): StoredEvent => {
  clock += 1
  const stored = store.append({ conversationId, actor, payload }, clock)
  if (stored === null) throw new Error('store closed')
  return stored
}

const created = (conversationId: string, from?: string, objective?: string): StoredEvent =>
  add(
    {
      type: 'conversation.created',
      projectId: 'p1',
      title: conversationId,
      ...(from === undefined ? {} : { continuedFrom: from }),
      ...(from === undefined || objective === undefined
        ? {}
        : { forward: { throughSeq: 1, objective, sourceEventIds: ['src-1'] } }),
    },
    'user',
    conversationId
  )

const request = (text: string): StoredEvent => add({ type: 'user.message', text }, 'user')

const opened = (taskId: string, origin: StoredEvent): StoredEvent =>
  add(
    { type: 'task.opened', taskId, originEventId: origin.id, startedAt: origin.createdAt },
    'system'
  )

const revised = (taskId: string, complete = false): StoredEvent =>
  add({
    type: 'task.revised',
    taskId,
    agentId: 'claude',
    revision: 1,
    source: 'chorus',
    steps: [{ id: 'a', title: 'A', status: complete ? 'done' : 'active', estimateMinutes: 5 }],
    ...(complete ? { complete: true } : {}),
  })

const bound = (taskId: string, previousTaskId: string | null): StoredEvent =>
  add({ type: 'assignment.bound', taskId, previousTaskId }, 'user')

const windowOf = (taskId: string): TaskWindow => {
  const window = store.taskWindow(CHILD, taskId, store.lastSeq())
  if (window === null) throw new Error(`no window for ${taskId}`)
  return window
}

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  clock = 0
  created(PARENT)
})

describe('forwarded children', () => {
  it('lists direct children newest first, pages, and stops at the as-of point', () => {
    created('c1', PARENT, 'Do B')
    created('c2', PARENT, 'Do B again')
    const beforeThird = store.lastSeq()
    created('c3', PARENT)
    created('elsewhere', 'other')
    created('grandchild', 'c1', 'Deeper')

    const first = store.forwardedChildren(PARENT, { skip: 0, count: 2, asOfSeq: store.lastSeq() })
    expect(first.total).toBe(3)
    expect(first.children.map((child) => child.conversationId)).toEqual(['c3', 'c2'])
    const rest = store.forwardedChildren(PARENT, { skip: 2, count: 2, asOfSeq: store.lastSeq() })
    expect(rest.children.map((child) => child.conversationId)).toEqual(['c1'])
    expect(rest.children[0]).toMatchObject({ objective: 'Do B', sourceEventIds: ['src-1'] })

    const earlier = store.forwardedChildren(PARENT, { skip: 0, count: 50, asOfSeq: beforeThird })
    expect(earlier.children.map((child) => child.conversationId)).toEqual(['c2', 'c1'])
    expect(store.forwardedChildren(PARENT, { skip: 0, count: 500, asOfSeq: 99 }).count).toBe(50)
  })

  it('reads an old link with no forward details, and refuses anything not linked here', () => {
    created('legacy', PARENT)
    expect(store.forwardedChild(PARENT, 'legacy', store.lastSeq())).toMatchObject({
      objective: null,
      sourceEventIds: [],
      throughSeq: null,
    })
    created('grandchild', 'legacy', 'Deeper')
    expect(store.forwardedChild(PARENT, 'grandchild', store.lastSeq())).toBeNull()
    expect(store.forwardedChild(PARENT, 'missing', store.lastSeq())).toBeNull()
  })
})

describe('binding a child task as the forwarded work', () => {
  it('only suggests the first task until the user binds, and keeps every correction', () => {
    created(CHILD, PARENT, 'Do B')
    const first = request('unrelated question')
    const suggested = opened('T1', first)
    const later = request('the real B')
    opened('T2', later)

    const unbound = store.assignmentBinding(CHILD, store.lastSeq())
    expect(unbound.current).toBeNull()
    expect(unbound.suggestion).toMatchObject({ taskId: 'T1', eventId: suggested.id })

    const pick = bound('T2', null)
    const beforeCorrection = store.lastSeq()
    const fix = bound('T1', 'T2')
    const corrected = store.assignmentBinding(CHILD, store.lastSeq())
    expect(corrected.current).toMatchObject({ taskId: 'T1', previousTaskId: 'T2' })
    expect(corrected.history.map((record) => [record.taskId, record.ref.eventId])).toEqual([
      ['T1', fix.id],
      ['T2', pick.id],
    ])
    expect(store.assignmentBinding(CHILD, beforeCorrection).current?.taskId).toBe('T2')
  })
})

describe('evidence for one bound task', () => {
  const work = () => {
    created(CHILD, PARENT, 'Do B')
    const ask = request('build B')
    add({ type: 'turn.started', turnRef: 't1' })
    opened('B', ask)
    revised('B')
    const started = add({
      type: 'command.started',
      itemRef: 'c1',
      command: ['pnpm', 'test'],
      cwd: '/tmp',
    })
    const output = add({
      type: 'command.output',
      itemRef: 'c1',
      stream: 'stdout',
      chunk: 'secret output',
    })
    add({ type: 'command.completed', itemRef: 'c1', exitCode: 0 })
    add({
      type: 'file.change.completed',
      itemRef: 'f1',
      files: [{ path: 'src/a.ts', change: 'modified', added: 1, removed: 0, patch: '' }],
      outcome: 'applied',
    })
    add({
      type: 'reply.status',
      requestId: CHAT,
      sourceId: 's1',
      agentId: 'claude',
      phase: 'thinking',
    })
    const chatTool = add({
      type: 'tool.started',
      itemRef: `${CHAT}:inspect`,
      name: 'inspect',
      parentRef: null,
      detail: null,
    })
    const thought = add({ type: 'agent.reasoning.delta', itemRef: 'r1', text: 'private' })
    const reply = add({ type: 'agent.message.completed', itemRef: 'm1', text: 'B is done.' })
    revised('B', true)
    const end = add({ type: 'task.closed', taskId: 'B', reason: 'completed' }, 'system')
    add({ type: 'turn.completed', turnRef: 't1', status: 'completed', userInitiated: false })
    const binding = bound('B', null)

    const next = request('now C')
    add({ type: 'turn.started', turnRef: 't2' })
    const openedC = opened('C', next)
    const laterCommand = add({
      type: 'command.started',
      itemRef: 'c2',
      command: ['rm', 'x'],
      cwd: '/tmp',
    })
    add({
      type: 'approval.requested',
      approvalId: 'c-approval',
      kind: 'command',
      request: {},
      expiresAt: 9_999_999,
    })
    return { started, output, chatTool, thought, reply, end, binding, openedC, laterCommand }
  }

  it('keeps B complete while C runs and waits, with none of C’s activity', () => {
    const { started, end, reply } = work()
    const window = windowOf('B')
    expect(window).toMatchObject({ open: false, latest: false, toSeq: end.seq })
    expect(store.currentWork(window)).toBeNull()

    const facts = store.taskFacts(window)
    expect(facts?.closed?.id).toBe(end.id)
    expect(facts?.latestRevisions.map((event) => event.payload)).toEqual([
      expect.objectContaining({ complete: true }),
    ])

    const seen = store.windowObservations(window, { ignoredItemRefPrefixes: PREFIXES })
    expect(seen.commands).toEqual([
      {
        started: expect.objectContaining({ eventId: started.id, command: 'pnpm test' }),
        completed: expect.objectContaining({ exitCode: 0 }),
      },
    ])
    expect(seen.files).toEqual([
      expect.objectContaining({ source: 'file.change', path: 'src/a.ts', fileCount: 1 }),
    ])
    expect(seen.lastReply).toMatchObject({ eventId: reply.id, excerpt: 'B is done.' })
    expect(seen.lastActivity?.seq).toBeLessThanOrEqual(end.seq)
    expect(seen.lastActivity?.type).not.toBe('reply.status')
  })

  it('cites command output by id and time only', () => {
    const { output } = work()
    const seen = store.windowObservations(windowOf('B'), { ignoredItemRefPrefixes: PREFIXES })
    expect(seen.lastOutput).toEqual({
      seq: output.seq,
      eventId: output.id,
      at: output.createdAt,
      actor: 'claude',
      itemRef: 'c1',
    })
  })

  it('resolves task facts and in-window Work records, and refuses everything else', () => {
    const records = work()
    const window = windowOf('B')
    const scope: AssignmentScope = {
      taskIds: ['B'],
      window,
      asOfSeq: store.lastSeq(),
      ignoredItemRefPrefixes: PREFIXES,
    }
    const resolve = (eventId: string) => store.assignmentRecord(CHILD, eventId, scope)

    expect(resolve(records.binding.id).kind).toBe('fact')
    expect(resolve(records.end.id).kind).toBe('fact')
    expect(resolve(records.started.id).kind).toBe('observation')
    expect(resolve(records.output.id)).toEqual({
      kind: 'output',
      ref: { seq: records.output.seq, eventId: records.output.id, at: records.output.createdAt },
      actor: 'claude',
      itemRef: 'c1',
      stream: 'stdout',
      bytes: 'secret output'.length,
    })
    expect(resolve(records.openedC.id)).toEqual({ kind: 'refused', reason: 'unrelated' })
    expect(resolve(records.laterCommand.id)).toEqual({ kind: 'refused', reason: 'unrelated' })
    expect(resolve(records.chatTool.id)).toEqual({ kind: 'refused', reason: 'not-work' })
    expect(resolve(records.thought.id)).toEqual({ kind: 'refused', reason: 'private' })
    expect(resolve('no-such-event')).toEqual({ kind: 'refused', reason: 'unknown' })
    expect(
      store.assignmentRecord(CHILD, records.binding.id, { ...scope, asOfSeq: records.end.seq })
    ).toEqual({ kind: 'refused', reason: 'later' })
  })
})

describe('pairing an operation with its own result', () => {
  type Agent = 'claude' | 'codex'
  const command = (itemRef: string, actor: Agent, words: string[]): StoredEvent =>
    add({ type: 'command.started', itemRef, command: words, cwd: '/tmp' }, actor)
  const commandDone = (itemRef: string, actor: Agent, exitCode: number): StoredEvent =>
    add({ type: 'command.completed', itemRef, exitCode }, actor)
  const toolStart = (itemRef: string, path: string | null, actor: Agent = 'claude'): StoredEvent =>
    add(
      {
        type: 'tool.started',
        itemRef,
        name: 'Edit',
        parentRef: null,
        detail: null,
        ...(path === null ? {} : { path }),
      },
      actor
    )
  const toolDone = (itemRef: string, actor: Agent = 'claude'): StoredEvent =>
    add({ type: 'tool.completed', itemRef, status: 'ok', summary: null, patch: '-a\n+b' }, actor)

  it('never lends one agent’s result, or a later start’s, to another command', () => {
    created(CHILD, PARENT, 'Do B')
    opened('B', request('build B'))
    const claudeShared = command('x', 'claude', ['pnpm', 'lint'])
    command('x', 'codex', ['pnpm', 'build'])
    commandDone('x', 'codex', 1)
    const unfinished = command('y', 'claude', ['pnpm', 'test'])
    const rerun = command('y', 'claude', ['pnpm', 'test'])
    const rerunDone = commandDone('y', 'claude', 0)

    const seen = store.windowObservations(windowOf('B'), { ignoredItemRefPrefixes: PREFIXES })
    const resultOf = new Map(seen.commands.map((entry) => [entry.started.eventId, entry.completed]))
    expect(resultOf.get(claudeShared.id)).toBeNull()
    expect(resultOf.get(unfinished.id)).toBeNull()
    expect(resultOf.get(rerun.id)).toMatchObject({ eventId: rerunDone.id, exitCode: 0 })
    const codexEntry = seen.commands.find((entry) => entry.started.actor === 'codex')
    expect(codexEntry?.completed).toMatchObject({ exitCode: 1 })
  })

  it('takes a patch path only from the same agent’s own start inside the window', () => {
    created(CHILD, PARENT, 'Do B')
    opened('A', request('an earlier task'))
    toolStart('p', 'old.ts')
    toolDone('p')
    add({ type: 'task.closed', taskId: 'A', reason: 'completed' }, 'system')
    opened('B', request('build B'))
    toolStart('p', 'codex.ts', 'codex')
    const borrowed = toolDone('p')
    toolStart('q', 'b.ts')
    const own = toolDone('q')

    const files = store.windowObservations(windowOf('B'), {
      ignoredItemRefPrefixes: PREFIXES,
    }).files
    expect(files.find((file) => file.eventId === borrowed.id)?.path).toBeNull()
    expect(files.find((file) => file.eventId === own.id)?.path).toBe('b.ts')
  })

  it('takes the path of the latest start, so a later start with none does not inherit one', () => {
    created(CHILD, PARENT, 'Do B')
    opened('B', request('build B'))
    toolStart('r', 'old.ts')
    toolStart('r', null)
    const pathless = toolDone('r')

    const files = store.windowObservations(windowOf('B'), {
      ignoredItemRefPrefixes: PREFIXES,
    }).files
    expect(files.find((file) => file.eventId === pathless.id)?.path).toBeNull()
  })
})

describe('reads pinned to an as-of point', () => {
  it('keeps what was pending at a captured point, and shows nothing that came later', () => {
    created(CHILD, PARENT, 'Do B')
    const ask = request('build B')
    const turn = add({ type: 'turn.started', turnRef: 't1' })
    opened('B', ask)
    const pending = add({
      type: 'approval.requested',
      approvalId: 'a1',
      kind: 'command',
      request: {},
      expiresAt: 9_999_999,
    })
    const captured = windowOf('B')

    add(
      {
        type: 'approval.decided',
        approvalId: 'a1',
        outcome: 'allow',
        scope: 'once',
        decidedBy: 'user',
        policyRuleId: null,
      },
      'user'
    )
    add({
      type: 'approval.requested',
      approvalId: 'a2',
      kind: 'command',
      request: {},
      expiresAt: 9_999_999,
    })
    add({ type: 'turn.completed', turnRef: 't1', status: 'completed', userInitiated: false })
    add({ type: 'turn.started', turnRef: 't2' }, 'codex')
    request('also C')

    const then = store.currentWork(captured)
    expect(then?.approvals.map((wait) => [wait.approvalId, wait.eventId])).toEqual([
      ['a1', pending.id],
    ])
    expect(then?.turns.map((open) => [open.agentId, open.eventId])).toEqual([['claude', turn.id]])

    const now = store.taskWindow(CHILD, 'B', store.lastSeq())
    expect(now).toMatchObject({ requestAfter: true })
    if (now === null) throw new Error('expected a window')
    expect(store.currentWork(now)).toBeNull()
  })

  it('keeps the title a child had at an earlier as-of point', () => {
    const child = created('titled', PARENT, 'Do B')
    const asOf = store.lastSeq()
    const renamed = add(
      { type: 'conversation.renamed', title: 'B, renamed', previousTitle: 'titled' },
      'user',
      'titled'
    )
    const earlier = store.forwardedChildren(PARENT, { skip: 0, count: 20, asOfSeq: asOf })
    expect(earlier.children[0]).toMatchObject({ title: 'titled', titleRef: { eventId: child.id } })
    expect(store.forwardedChild(PARENT, 'titled', store.lastSeq())).toMatchObject({
      title: 'B, renamed',
      titleRef: { eventId: renamed.id },
    })
  })

  it('resolves the title cited as of a read, and refuses a rename that was not it then', () => {
    created(CHILD, PARENT, 'Do B')
    const first = add(
      { type: 'conversation.renamed', title: 'B one', previousTitle: CHILD },
      'user'
    )
    const asOf = store.lastSeq()
    const second = add(
      { type: 'conversation.renamed', title: 'B two', previousTitle: 'B one' },
      'user'
    )
    const scope = (asOfSeq: number): AssignmentScope => ({
      taskIds: [],
      window: null,
      asOfSeq,
      ignoredItemRefPrefixes: PREFIXES,
    })
    const cited = store.forwardedChild(PARENT, CHILD, asOf)?.titleRef.eventId
    expect(cited).toBe(first.id)
    expect(store.assignmentRecord(CHILD, first.id, scope(asOf)).kind).toBe('fact')
    expect(store.assignmentRecord(CHILD, first.id, scope(store.lastSeq()))).toEqual({
      kind: 'refused',
      reason: 'unrelated',
    })
    expect(store.assignmentRecord(CHILD, second.id, scope(store.lastSeq())).kind).toBe('fact')
    expect(store.assignmentRecord(CHILD, second.id, scope(asOf))).toEqual({
      kind: 'refused',
      reason: 'later',
    })
  })

  it('cuts the reply excerpt on whole characters', () => {
    created(CHILD, PARENT, 'Do B')
    opened('B', request('build B'))
    add({ type: 'agent.message.completed', itemRef: 'm', text: `${'🌙'.repeat(700)}tail` })
    const excerpt =
      store.windowObservations(windowOf('B'), { ignoredItemRefPrefixes: PREFIXES }).lastReply
        ?.excerpt ?? ''
    expect(Array.from(excerpt)).toHaveLength(600)
    expect(excerpt).not.toMatch(/[\uD800-\uDFFF]/u)
  })

  it('reports each agent’s latest revision, so a withdrawn completion is not current', () => {
    created(CHILD, PARENT, 'Do B')
    opened('B', request('build B'))
    revised('B', true)
    const latest = revised('B')
    const facts = store.taskFacts(windowOf('B'))
    expect(facts?.latestRevisions.map((event) => event.id)).toEqual([latest.id])
    expect(facts?.latestRevisions[0]?.payload).not.toMatchObject({ complete: true })
  })
})

describe('a session boundary cited for a cut-off turn', () => {
  const session = (type: 'session.started' | 'session.ended', sessionRef: string): StoredEvent =>
    add(
      type === 'session.started'
        ? {
            type,
            agentId: 'claude',
            sessionRef,
            cwd: '/private/work',
            model: null,
            cliVersion: null,
          }
        : { type, agentId: 'claude', sessionRef, reason: 'crashed' },
      'system'
    )

  it('resolves only a boundary that cut off a turn in the window, as metadata', () => {
    created(CHILD, PARENT, 'Do B')
    const before = session('session.started', 'ref-0')
    const ask = request('build B')
    add({ type: 'turn.started', turnRef: 't1' })
    opened('B', ask)
    const end = session('session.ended', 'ref-1')
    const again = session('session.started', 'ref-2')
    const asOfSeq = store.lastSeq()
    const scope: AssignmentScope = {
      taskIds: ['B'],
      window: windowOf('B'),
      asOfSeq,
      ignoredItemRefPrefixes: PREFIXES,
    }
    const resolve = (eventId: string) => store.assignmentRecord(CHILD, eventId, scope)

    expect(resolve(end.id)).toEqual({
      kind: 'boundary',
      ref: { seq: end.seq, eventId: end.id, at: end.createdAt },
      agentId: 'claude',
      boundary: 'session.ended',
      reason: 'crashed',
      resumed: false,
    })
    expect(JSON.stringify(resolve(end.id))).not.toContain('ref-1')
    expect(resolve(again.id)).toEqual({ kind: 'refused', reason: 'not-work' })
    expect(resolve(before.id)).toEqual({ kind: 'refused', reason: 'unrelated' })

    add({ type: 'turn.completed', turnRef: 't1', status: 'completed', userInitiated: false })
    add({ type: 'turn.started', turnRef: 't2' })
    add({ type: 'turn.completed', turnRef: 't2', status: 'completed', userInitiated: false })
    const quiet = session('session.ended', 'ref-3')
    const later: AssignmentScope = { ...scope, window: windowOf('B'), asOfSeq: store.lastSeq() }
    expect(store.assignmentRecord(CHILD, quiet.id, later)).toEqual({
      kind: 'refused',
      reason: 'not-work',
    })
    expect(resolve(quiet.id)).toEqual({ kind: 'refused', reason: 'later' })
  })
})

describe('searching one task’s tracking window', () => {
  const search = (query: string, skip = 0, count = 20) =>
    store.searchWindow(windowOf('B'), query, { skip, count, ignoredItemRefPrefixes: PREFIXES })

  const work = () => {
    created(CHILD, PARENT, 'Do B')
    opened('A', request('an earlier task'))
    add({ type: 'agent.message.completed', itemRef: 'm0', text: 'NEEDLE before B' })
    add({ type: 'task.closed', taskId: 'A', reason: 'completed' }, 'system')
    const ask = request('build B with NEEDLE')
    opened('B', ask)
    const reply = add({ type: 'agent.message.completed', itemRef: 'm1', text: 'Found the Needle.' })
    const run = add({
      type: 'command.started',
      itemRef: 'c1',
      command: ['grep', 'needle'],
      cwd: '/tmp',
    })
    add({ type: 'command.output', itemRef: 'c1', stream: 'stdout', chunk: 'NEEDLE secret' })
    add({ type: 'agent.reasoning.delta', itemRef: 'r1', text: 'NEEDLE privately' })
    add({
      type: 'agent.message.completed',
      itemRef: `${CHAT}:reply`,
      text: 'NEEDLE in Chat',
    })
    add({
      type: 'agent.message.completed',
      itemRef: 'm2',
      text: 'NEEDLE in discussion',
      mode: 'discussion',
    })
    const tool = add({
      type: 'tool.started',
      itemRef: 't1',
      name: 'Read',
      parentRef: null,
      detail: null,
      path: 'src/needle.ts',
    })
    const failure = add(
      { type: 'error.raised', message: 'needle broke', recoverable: true },
      'system'
    )
    add({ type: 'task.closed', taskId: 'B', reason: 'completed' }, 'system')
    opened('C', request('now C'))
    add({ type: 'agent.message.completed', itemRef: 'm3', text: 'NEEDLE during C' })
    return { ask, reply, run, tool, failure }
  }

  it('finds Work records in the window only, never output, reasoning, Chat or requests', () => {
    const { reply, run, tool, failure } = work()
    const found = search('needle')
    expect(found.total).toBe(4)
    expect(found.matches.map((match) => match.eventId)).toEqual([
      failure.id,
      tool.id,
      run.id,
      reply.id,
    ])
    expect(found.matches.find((match) => match.eventId === run.id)?.snippet).toBe('grep needle')
    const hidden = ['secret', 'privately', 'in Chat', 'in discussion', 'during C', 'before B']
    for (const text of hidden) {
      expect(search(text).total, text).toBe(0)
    }
    expect(search('build B').total).toBe(0)
  })

  it('pages newest first with a fixed ceiling, and treats an empty query as no search', () => {
    const { reply, run } = work()
    const page = search('needle', 2, 2)
    expect(page.matches.map((match) => match.eventId)).toEqual([run.id, reply.id])
    expect(search('needle', 0, 500).count).toBe(50)
    expect(search('')).toEqual({ matches: [], total: 0, skip: 0, count: 20 })
  })

  it('cuts a snippet around the match on whole characters', () => {
    created(CHILD, PARENT, 'Do B')
    opened('B', request('build B'))
    const long = add({
      type: 'agent.message.completed',
      itemRef: 'm',
      text: `${'🌙'.repeat(500)}MATCH${'ب'.repeat(1_000)}`,
    })
    const [match] = search('match').matches
    expect(match?.eventId).toBe(long.id)
    expect(match).toMatchObject({ clippedStart: true, clippedEnd: true })
    const snippet = match?.snippet ?? ''
    expect(Array.from(snippet)).toHaveLength(605)
    expect(snippet.startsWith('🌙')).toBe(true)
    expect(snippet).toContain('MATCH')
  })
})

describe('the marking a forwarded child’s transcript state carries', () => {
  it('is unlinked for an ordinary conversation, even with a stray binding record', () => {
    expect(store.transcriptState(PARENT).assignment).toEqual({ linked: false, boundTaskId: null })
    add({ type: 'assignment.bound', taskId: 'T1', previousTaskId: null }, 'user', PARENT)
    expect(store.transcriptState(PARENT).assignment).toEqual({ linked: false, boundTaskId: null })
  })

  it('links an old forward with no details, and never counts the first task as the marking', () => {
    created(CHILD, PARENT)
    expect(store.transcriptState(CHILD).assignment).toEqual({ linked: true, boundTaskId: null })
    opened('T1', request('build B'))
    expect(store.transcriptState(CHILD).assignment).toEqual({ linked: true, boundTaskId: null })
  })

  it('names the latest marking, after a correction', () => {
    created(CHILD, PARENT, 'Do B')
    opened('T1', request('build B'))
    bound('T1', null)
    opened('T2', request('the real B'))
    bound('T2', 'T1')
    expect(store.transcriptState(CHILD).assignment).toEqual({ linked: true, boundTaskId: 'T2' })
  })

  it('recovers the link and the marking when both precede the page a pane loads', () => {
    created(CHILD, PARENT, 'Do B')
    opened('B', request('build B'))
    const marking = bound('B', null)
    for (let index = 0; index < 30; index++) {
      add({ type: 'agent.message.completed', itemRef: `m${String(index)}`, text: 'later' })
    }
    const page = store.readPage(CHILD, { limit: 10 })
    expect(page.some((event) => event.id === marking.id)).toBe(false)
    expect(page.some((event) => event.type === 'conversation.created')).toBe(false)
    expect(store.transcriptState(CHILD).assignment).toEqual({ linked: true, boundTaskId: 'B' })
  })
})
