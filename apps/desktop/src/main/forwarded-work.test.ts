import {
  EventStore,
  openSqlite,
  type AssignmentRecord,
  type AssignmentScope,
  type ChorusEventPayload,
  type StoredEvent,
} from '@chorus/event-store'
import { beforeEach, describe, expect, it } from 'vitest'
import { TASK_IGNORED_ITEM_REF_PREFIXES } from '../shared/task-progress.js'
import {
  digestAssignment,
  FORWARDED_NO_ROOM,
  interruptedTurns,
  renderDigest,
  renderForwardedList,
  renderNotForwarded,
  renderRecord,
  renderSearch,
  utf8Length,
  type AssignmentDigest,
  type ForwardedReadContext,
} from './forwarded-work.js'

const PARENT = 'parent'
const CHILD = 'child'
const BUDGET = 16_000
const LONE_SURROGATE = /[\uD800-\uDFFF]/u
const prefixes = TASK_IGNORED_ITEM_REF_PREFIXES

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

const forward = (conversationId = CHILD, objective = 'Do B'): StoredEvent =>
  add(
    {
      type: 'conversation.created',
      projectId: 'p1',
      title: conversationId,
      continuedFrom: PARENT,
      forward: { throughSeq: 1, objective, sourceEventIds: [] },
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

const revised = (
  taskId: string,
  complete = false,
  revision = 1,
  agentId: 'claude' | 'codex' = 'claude'
): StoredEvent =>
  add(
    {
      type: 'task.revised',
      taskId,
      agentId,
      revision,
      source: 'chorus',
      steps: [
        { id: 'a', title: 'Read', status: 'done', estimateMinutes: 5 },
        { id: 'b', title: 'Write', status: complete ? 'done' : 'active', estimateMinutes: 5 },
      ],
      ...(complete ? { complete: true } : {}),
    },
    agentId
  )

const closed = (taskId: string, reason: 'completed' | 'abandoned' | 'superseded'): StoredEvent =>
  add({ type: 'task.closed', taskId, reason }, 'system')

const bound = (taskId: string, previousTaskId: string | null): StoredEvent =>
  add({ type: 'assignment.bound', taskId, previousTaskId }, 'user')

const command = (itemRef: string, words: string[]): StoredEvent =>
  add({ type: 'command.started', itemRef, command: words, cwd: '/tmp' })

const digestOf = (conversationId = CHILD): AssignmentDigest => {
  const asOfSeq = store.lastSeq()
  const child = store.forwardedChild(PARENT, conversationId, asOfSeq)
  if (child === null) throw new Error('not forwarded')
  const binding = store.assignmentBinding(conversationId, asOfSeq)
  const taskId = binding.current?.taskId ?? binding.suggestion?.taskId ?? null
  const window = taskId === null ? null : store.taskWindow(conversationId, taskId, asOfSeq)
  const marked = binding.current === null ? null : window
  const current = marked === null ? null : store.currentWork(marked)
  const records =
    marked === null || current === null
      ? null
      : store.taskRecordsFor(marked, { ignoredItemRefPrefixes: prefixes })
  return digestAssignment(
    {
      child,
      binding,
      window,
      facts: marked === null ? null : store.taskFacts(marked),
      observations:
        window === null
          ? null
          : store.windowObservations(window, { ignoredItemRefPrefixes: prefixes }),
      current,
      interrupted:
        marked === null || records === null ? [] : interruptedTurns(records.events, marked.fromSeq),
    },
    asOfSeq
  )
}

const kinds = (digest: AssignmentDigest, kind: string): string[] =>
  digest.claims.filter((claim) => claim.kind === kind).map((claim) => claim.text)

const cited = (digest: AssignmentDigest): Set<string> =>
  new Set(digest.claims.flatMap((claim) => claim.refs.map((ref) => ref.eventId)))

const scopeOf = (digest: AssignmentDigest): AssignmentScope => {
  const { asOfSeq, conversationId, taskId } = digest
  return {
    taskIds: taskId === null ? [] : [taskId],
    window: taskId === null ? null : store.taskWindow(conversationId, taskId, asOfSeq),
    asOfSeq,
    ignoredItemRefPrefixes: prefixes,
  }
}

const scopeContext = (digest: AssignmentDigest): ForwardedReadContext => ({
  conversationId: digest.conversationId,
  taskId: digest.taskId,
  bound: digest.bound,
  window: scopeOf(digest).window,
  asOfSeq: digest.asOfSeq,
})

const unresolved = (digest: AssignmentDigest): string[] =>
  [...cited(digest)].filter(
    (eventId) =>
      store.assignmentRecord(digest.conversationId, eventId, scopeOf(digest)).kind === 'refused'
  )

beforeEach(() => {
  store = EventStore.open(openSqlite({ path: ':memory:' })).store
  clock = 0
  add({ type: 'conversation.created', projectId: 'p1', title: 'Parent' }, 'user', PARENT)
})

describe('an assignment the user has not marked', () => {
  it('offers the first task only as a suggestion, even once that task is complete', () => {
    forward()
    const first = opened('T1', request('build B'))
    revised('T1', true)
    closed('T1', 'completed')

    const digest = digestOf()
    expect(digest).toMatchObject({ bound: false, state: 'unbound', declared: false, taskId: 'T1' })
    expect(kinds(digest, 'suggestion')).toEqual([expect.stringContaining('Unconfirmed suggestion')])
    expect(cited(digest).has(first.id)).toBe(true)
    expect(kinds(digest, 'task')).toEqual([])
    expect(kinds(digest, 'current')).toEqual([])
    const text = renderDigest(digest, BUDGET)
    expect(text).toContain('no status is reported')
    expect(text).not.toContain('Completion was recorded')
    expect(text).not.toContain('declares it complete')
    expect(text).toContain('while the suggested task T1 was tracked')
    expect(unresolved(digest)).toEqual([])
  })

  it('says no task is recorded without claiming that nothing was done', () => {
    forward()
    request('build B')
    command('c1', ['pnpm', 'test'])
    const digest = digestOf()
    expect(digest).toMatchObject({ state: 'unbound', taskId: null, window: null })
    expect(renderDigest(digest, BUDGET)).toContain('That does not show that no work was done there')
  })
})

describe('a marked task', () => {
  it('reads a binding recorded after the task closed, and keeps a correction’s provenance', () => {
    forward()
    opened('B', request('build B'))
    revised('B', true)
    const end = closed('B', 'completed')
    const first = bound('B', null)

    const digest = digestOf()
    expect(digest).toMatchObject({ bound: true, state: 'completion-recorded', declared: true })
    expect(cited(digest).has(first.id)).toBe(true)
    expect(cited(digest).has(end.id)).toBe(true)
    expect(kinds(digest, 'task')).toContain(
      "Every agent's latest plan revision declares it complete."
    )
    expect(unresolved(digest)).toEqual([])

    opened('C', request('now C'))
    const fix = bound('C', 'B')
    const corrected = digestOf()
    expect(corrected.taskId).toBe('C')
    expect(kinds(corrected, 'binding')[0]).toContain('replacing task B')
    expect(cited(corrected).has(fix.id)).toBe(true)
    expect(cited(corrected).has(first.id)).toBe(true)
    expect(corrected.state).toBe('open')
    expect(unresolved(corrected)).toEqual([])
  })

  it('keeps B’s recorded completion while C runs and waits, with none of C’s activity', () => {
    forward()
    opened('B', request('build B'))
    command('c1', ['pnpm', 'test'])
    add({ type: 'command.completed', itemRef: 'c1', exitCode: 0 })
    revised('B', true)
    closed('B', 'completed')
    bound('B', null)
    opened('C', request('now C'))
    add({ type: 'turn.started', turnRef: 't2' })
    const later = command('c2', ['rm', 'x'])
    add({
      type: 'approval.requested',
      approvalId: 'c-approval',
      kind: 'command',
      request: {},
      expiresAt: 9_999_999,
    })

    const digest = digestOf()
    expect(digest.state).toBe('completion-recorded')
    expect(kinds(digest, 'current')).toEqual([])
    expect(cited(digest).has(later.id)).toBe(false)
    const text = renderDigest(digest, BUDGET)
    expect(text).toContain('ran `pnpm test`, exit code 0')
    expect(text).not.toContain('rm x')
    expect(text).not.toContain('waiting for an approval')
    expect(unresolved(digest)).toEqual([])
    const last = digest.claims.find((claim) => claim.text.startsWith('Last Work activity'))
    const lastRef = last?.refs[0]
    if (lastRef === undefined) throw new Error('no last activity')
    expect(last?.text).toContain(`recorded ${new Date(lastRef.at).toISOString()}.`)
    const followed = store.assignmentRecord(CHILD, lastRef.eventId, scopeOf(digest))
    expect(renderRecord(followed, lastRef.eventId, scopeContext(digest), 0, BUDGET)).toContain(
      `written ${new Date(lastRef.at).toISOString()}`
    )
  })

  it('shows a later request’s activity only as observation, and claims nothing current', () => {
    forward()
    opened('B', request('build B'))
    revised('B')
    bound('B', null)
    request('also do C')
    add({ type: 'turn.started', turnRef: 't2' })
    const tool = command('c2', ['rm', 'x'])

    const digest = digestOf()
    expect(digest.state).toBe('open')
    expect(kinds(digest, 'current')).toEqual([
      expect.stringContaining('the user made another request there'),
    ])
    expect(kinds(digest, 'observation').join('\n')).toContain('ran `rm x`')
    const citing = digest.claims.find((claim) => claim.refs.some((ref) => ref.eventId === tool.id))
    expect(citing?.kind).toBe('observation')
    expect(renderDigest(digest, BUDGET)).not.toContain('has a turn running')
  })

  it('reports current work only while the task is open, latest and unchallenged', () => {
    forward()
    const ask = request('build B')
    const turn = add({ type: 'turn.started', turnRef: 't1' })
    opened('B', ask)
    revised('B')
    bound('B', null)
    const wait = add({
      type: 'approval.requested',
      approvalId: 'a1',
      kind: 'command',
      request: {},
      expiresAt: 9_999_999,
    })
    const digest = digestOf()
    expect(kinds(digest, 'current')).toEqual([
      'claude has a turn running there.',
      'claude is waiting for an approval.',
    ])
    expect(cited(digest).has(turn.id)).toBe(true)
    expect(cited(digest).has(wait.id)).toBe(true)
    expect(unresolved(digest)).toEqual([])
  })

  it('does not call a task idle because the turn running began before its window', () => {
    forward()
    request('build B')
    const turn = add({ type: 'turn.started', turnRef: 't1' })
    const guidance = request('use the v2 endpoint')
    opened('B', guidance)
    revised('B')
    bound('B', null)

    const digest = digestOf()
    expect(store.taskWindow(CHILD, 'B', digest.asOfSeq)?.fromSeq).toBe(guidance.seq)
    const now = kinds(digest, 'current')
    expect(now).toEqual([expect.stringContaining("began in this task's tracked window")])
    expect(now[0]).toContain('That does not show the conversation is idle')
    expect(cited(digest).has(turn.id)).toBe(false)
    const text = renderDigest(digest, BUDGET)
    expect(text).not.toContain('has a turn running')
    expect(text).not.toContain('Nothing is running')
  })

  it('reads a turn cut off by a session ending as unknown, and lets each citation be read', () => {
    forward()
    const started = (sessionRef: string, resumed = false): StoredEvent =>
      add(
        {
          type: 'session.started',
          agentId: 'claude',
          sessionRef,
          cwd: '/private/work',
          model: null,
          cliVersion: null,
          ...(resumed ? { resumed: true } : {}),
        },
        'system'
      )
    const early = started('ref-early')
    const ask = request('build B')
    const turn = add({ type: 'turn.started', turnRef: 't1' })
    opened('B', ask)
    revised('B')
    bound('B', null)
    const end = add(
      { type: 'session.ended', agentId: 'claude', sessionRef: 'ref-crashed', reason: 'crashed' },
      'system'
    )
    const resumed = started('ref-resumed', true)

    const digest = digestOf()
    expect(digest.state).toBe('open')
    expect(kinds(digest, 'current')).toEqual([
      expect.stringContaining('ended without a recorded result'),
    ])
    expect(cited(digest).has(turn.id)).toBe(true)
    expect(cited(digest).has(end.id)).toBe(true)
    expect(unresolved(digest)).toEqual([])

    const scope = scopeOf(digest)
    const boundary = store.assignmentRecord(CHILD, end.id, scope)
    expect(boundary).toEqual({
      kind: 'boundary',
      ref: { seq: end.seq, eventId: end.id, at: end.createdAt },
      agentId: 'claude',
      boundary: 'session.ended',
      reason: 'crashed',
      resumed: false,
    })
    const shown = renderRecord(boundary, end.id, scopeContext(digest), 0, BUDGET)
    expect(shown).toContain("claude's session ended (crashed)")
    expect(shown).toContain('It is an observation, not that task')
    expect(shown).not.toContain('ref-crashed')
    expect(shown).not.toContain('/private/work')
    expect(store.assignmentRecord(CHILD, early.id, scope)).toEqual({
      kind: 'refused',
      reason: 'unrelated',
    })
    expect(store.assignmentRecord(CHILD, resumed.id, scope)).toEqual({
      kind: 'refused',
      reason: 'not-work',
    })

    opened('C', request('now C'))
    add({ type: 'turn.started', turnRef: 't2' })
    const later = add(
      { type: 'session.ended', agentId: 'claude', sessionRef: 'ref-later', reason: 'crashed' },
      'system'
    )
    expect(store.assignmentRecord(CHILD, later.id, scopeOf(digestOf()))).toEqual({
      kind: 'refused',
      reason: 'unrelated',
    })
  })

  it('treats a withdrawn declaration as not declared', () => {
    forward()
    opened('B', request('build B'))
    revised('B', true, 1)
    revised('B', false, 2)
    bound('B', null)
    const digest = digestOf()
    expect(digest).toMatchObject({ state: 'open', declared: false })
    expect(renderDigest(digest, BUDGET)).not.toContain('declares it complete')
  })

  it('says a completion closed by hand was recorded without an agent declaration', () => {
    forward()
    opened('B', request('build B'))
    revised('B')
    closed('B', 'completed')
    bound('B', null)
    const digest = digestOf()
    expect(digest).toMatchObject({ state: 'completion-recorded', declared: false })
    expect(kinds(digest, 'task')).toContain(
      "No agent's latest plan revision declares it complete, so completion was recorded without an agent declaration."
    )
  })

  it('says which agents declared completion when only some did', () => {
    forward()
    opened('B', request('build B'))
    revised('B', true, 1, 'claude')
    revised('B', false, 2, 'codex')
    bound('B', null)
    const open = digestOf()
    expect(open).toMatchObject({ state: 'open', declared: false })
    expect(kinds(open, 'task')).toContain(
      'Only some agents declare it complete: the latest plan revision of claude does, and that of codex does not.'
    )

    closed('B', 'completed')
    const recorded = digestOf()
    expect(recorded).toMatchObject({ state: 'completion-recorded', declared: false })
    const task = kinds(recorded, 'task').join('\n')
    expect(task).toContain(
      'Only some agents declare it complete: the latest plan revision of claude does, and that of codex does not. Completion was recorded without every agent declaring it.'
    )
    expect(task).not.toContain('without an agent declaration')
    expect(task).toContain('it declares the task complete')
  })

  it('names abandoned and superseded tracking as what they are', () => {
    forward()
    opened('B', request('build B'))
    closed('B', 'abandoned')
    bound('B', null)
    expect(digestOf().state).toBe('abandoned')
    forward('other')
    add({ type: 'task.opened', taskId: 'S', originEventId: 'x', startedAt: 0 }, 'system', 'other')
    add({ type: 'task.closed', taskId: 'S', reason: 'superseded' }, 'system', 'other')
    add({ type: 'assignment.bound', taskId: 'S', previousTaskId: null }, 'user', 'other')
    expect(digestOf('other').state).toBe('superseded')
  })

  it('keeps Chat out of a marked task’s digest', () => {
    forward()
    opened('B', request('build B'))
    bound('B', null)
    add({
      type: 'agent.message.completed',
      itemRef: 'discussion:s1:claude:0:reply',
      text: 'CHAT_ONLY',
    })
    add({
      type: 'agent.message.completed',
      itemRef: 'm2',
      text: 'IN_DISCUSSION',
      mode: 'discussion',
    })
    const text = renderDigest(digestOf(), BUDGET)
    expect(text).not.toContain('CHAT_ONLY')
    expect(text).not.toContain('IN_DISCUSSION')
  })
})

describe('the rendered answers', () => {
  const context = (
    window = store.taskWindow(CHILD, 'B', store.lastSeq())
  ): ForwardedReadContext => ({
    conversationId: CHILD,
    taskId: 'B',
    bound: true,
    window,
    asOfSeq: store.lastSeq(),
  })

  it('stays within a small budget, on whole characters, and keeps its as-of point', () => {
    const link = forward(CHILD, `هدف ${'🌙'.repeat(450)}`)
    opened('B', request('build B'))
    add({ type: 'agent.message.completed', itemRef: 'm', text: '🌙'.repeat(2_000) })
    bound('B', null)
    const digest = digestOf()
    const objective = renderDigest(digest, BUDGET)
      .split('\n')
      .find((line) => line.startsWith('- Objective recorded'))
    expect(objective?.endsWith(`[#${String(link.seq)} ${link.id}]`)).toBe(true)
    for (const budget of [500, 900, 2_000, 4_000]) {
      const text = renderDigest(digest, budget)
      expect(utf8Length(text)).toBeLessThanOrEqual(budget)
      expect(text).not.toMatch(LONE_SURROGATE)
      expect(text).toContain(`#${String(digest.asOfSeq)}`)
    }
    const cramped = renderDigest(digest, 120)
    expect(utf8Length(cramped)).toBeLessThanOrEqual(120)
    expect(FORWARDED_NO_ROOM.startsWith(cramped.slice(0, -1))).toBe(true)
  })

  it('cites command output by its size and never its text', () => {
    forward()
    opened('B', request('build B'))
    command('c1', ['cat', '.env'])
    const output = add({
      type: 'command.output',
      itemRef: 'c1',
      stream: 'stdout',
      chunk: 'TOKEN=سر',
    })
    const record: AssignmentRecord = store.assignmentRecord(CHILD, output.id, {
      taskIds: ['B'],
      window: store.taskWindow(CHILD, 'B', store.lastSeq()),
      asOfSeq: store.lastSeq(),
      ignoredItemRefPrefixes: prefixes,
    })
    const text = renderRecord(record, output.id, context(), 0, BUDGET)
    expect(text).toContain(`${String(utf8Length('TOKEN=سر'))} bytes`)
    expect(text).not.toContain('TOKEN')

    const reference = `[#${String(output.seq)} ${output.id}]`
    for (const budget of [40, 90, 140, 200, 320]) {
      const small = renderRecord(record, output.id, context(), 0, budget)
      expect(utf8Length(small), String(budget)).toBeLessThanOrEqual(budget)
      expect(small).not.toContain('TOKEN')
      const opened = small.split('[#').length - 1
      const whole = small.split(reference).length - 1
      expect(opened, String(budget)).toBe(whole)
    }
  })

  it('reads a long multibyte record in parts that rebuild it exactly, each within budget', () => {
    forward()
    opened('B', request('build B'))
    const long = add({
      type: 'agent.message.completed',
      itemRef: 'm',
      text: `BEGIN ${'نص طويل 🌙 '.repeat(3_000)} END`,
    })
    const record = store.assignmentRecord(CHILD, long.id, {
      taskIds: ['B'],
      window: store.taskWindow(CHILD, 'B', store.lastSeq()),
      asOfSeq: store.lastSeq(),
      ignoredItemRefPrefixes: prefixes,
    })
    expect(record.kind).toBe('observation')
    let offset = 0
    let rebuilt = ''
    for (let reads = 0; ; reads++) {
      if (reads > 200) throw new Error('the record never ended')
      const reply = renderRecord(record, long.id, context(), offset, 4_000)
      expect(utf8Length(reply)).toBeLessThanOrEqual(4_000)
      expect(reply).not.toMatch(LONE_SURROGATE)
      const split = reply.indexOf('\n\n')
      rebuilt += reply.slice(split + 2)
      const next = /offset (\d+)\.$/mu.exec(reply.slice(0, split))
      if (next === null) break
      offset = Number(next[1])
    }
    expect(rebuilt).toBe(`claude agent.message.completed:\n${JSON.stringify(long.payload)}`)
  })

  it('pages the list, says how to reach older ones, and stays within budget', () => {
    for (const id of ['c1', 'c2', 'c3']) forward(id, `Objective ${id}`)
    const asOfSeq = store.lastSeq()
    const page = store.forwardedChildren(PARENT, { skip: 0, count: 2, asOfSeq })
    const entries = page.children.map((child) => ({
      child,
      binding: store.assignmentBinding(child.conversationId, asOfSeq),
      window: null,
    }))
    const text = renderForwardedList(page, entries, BUDGET)
    expect(text).toContain('3 in total. Showing 1–2. Older ones: skip=2.')
    expect(text.indexOf('c3')).toBeLessThan(text.indexOf('c2'))
    expect(text).not.toContain('Objective c1')
    const tight = renderForwardedList(page, entries, 330)
    expect(utf8Length(tight)).toBeLessThanOrEqual(330)
    expect(renderNotForwarded('stranger', page, 200).length).toBeGreaterThan(0)
    expect(utf8Length(renderNotForwarded('stranger', page, 200))).toBeLessThanOrEqual(200)
    expect(renderNotForwarded('stranger', page, BUDGET)).toContain('c3 "c3"; c2 "c2"; and 1 more')
  })

  it('cites the rename a listed title comes from, beside the link it was created by', () => {
    const link = forward('c1', 'Objective c1')
    const renamed = add(
      { type: 'conversation.renamed', title: 'B, renamed', previousTitle: 'c1' },
      'user',
      'c1'
    )
    const asOfSeq = store.lastSeq()
    const page = store.forwardedChildren(PARENT, { skip: 0, count: 20, asOfSeq })
    const entries = page.children.map((child) => ({
      child,
      binding: store.assignmentBinding(child.conversationId, asOfSeq),
      window: null,
    }))
    const line = renderForwardedList(page, entries, BUDGET)
      .split('\n')
      .find((each) => each.startsWith('- c1 '))
    expect(line).toContain(`[#${String(link.seq)} ${link.id}]`)
    expect(line).toContain(`(title [#${String(renamed.seq)} ${renamed.id}])`)
    expect(line).toContain('Title "B, renamed"')
    expect(
      store.assignmentRecord('c1', renamed.id, {
        taskIds: [],
        window: null,
        asOfSeq,
        ignoredItemRefPrefixes: prefixes,
      }).kind
    ).toBe('fact')
  })

  it('labels a search as observations within the tracked window', () => {
    forward()
    opened('B', request('build B'))
    command('c1', ['grep', 'needle'])
    const window = store.taskWindow(CHILD, 'B', store.lastSeq())
    if (window === null) throw new Error('no window')
    const page = store.searchWindow(window, 'needle', {
      skip: 0,
      count: 20,
      ignoredItemRefPrefixes: prefixes,
    })
    const text = renderSearch(page, 'needle', context(window), BUDGET)
    expect(text).toContain('1 matching records. These are observations, not task status.')
    expect(text).toContain('claude command.started: grep needle')
  })
})

describe('interrupted turns', () => {
  it('names the session boundary that cut a turn off, and clears once a new turn finishes', () => {
    forward()
    const ask = request('build B')
    const start = add({ type: 'turn.started', turnRef: 't1' })
    const end = add(
      { type: 'session.ended', agentId: 'claude', sessionRef: 's1', reason: 'crashed' },
      'system'
    )
    const events = store.read(CHILD)
    expect(interruptedTurns(events, ask.seq)).toEqual([
      {
        agentId: 'claude',
        started: { seq: start.seq, eventId: start.id, at: start.createdAt },
        ended: { seq: end.seq, eventId: end.id, at: end.createdAt },
      },
    ])
    add({ type: 'turn.started', turnRef: 't2' })
    add({ type: 'turn.completed', turnRef: 't2', status: 'completed', userInitiated: false })
    expect(interruptedTurns(store.read(CHILD), ask.seq)).toEqual([])
  })
})
