import {
  EventStore,
  openSqlite,
  type ChorusEventPayload,
  type SqliteHandle,
  type StoredEvent,
} from '@chorus/event-store'
import type { Actor, AgentId } from '@chorus/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACKNOWLEDGEMENT_MS,
  agentIsBusy,
  CODER,
  MAX_MICRO_TASKS,
  MAX_REISSUES,
  parseMicroTasks,
  PLANNER,
  REVIEWER,
  rolesFor,
  TASK_PROTOCOL,
  cardIsOpen,
  CollaborationRun,
  dispatchAndWatch,
  IDLE_MS,
  parseVerdict,
  type Clock,
  type Preset,
  type CoordinatorPort,
  type DispatchRequest,
  type DispatchResult,
  type HandoffDispatch,
  type RunStatus,
} from './collaborate.js'

/**
 * Phase 1 of docs/plans/guided-collaboration-2026-09-12/plan.md.
 *
 * Driven against a real store, because every one of these behaviours is a
 * statement about event shapes the log actually produces: `session.ended`
 * carries its agent in the payload while `error.raised` carries it in the
 * actor, `turn.started` and `turn.completed` refs cannot be correlated, and
 * `subscribe` is not scoped to a conversation.
 */

const CONV = 'conv-1'
const OTHER = 'conv-2'
const REF = 'session-ref-1'

let db: SqliteHandle
let store: EventStore

beforeEach(() => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  for (const id of [CONV, OTHER]) {
    store.append({
      conversationId: id,
      actor: 'user',
      payload: { type: 'conversation.created', projectId: 'p1', title: 'Room' },
    })
  }
})

afterEach(() => {
  db.close()
})

function append(
  payload: ChorusEventPayload,
  actor: Actor = 'codex',
  conversationId = CONV
): StoredEvent {
  const stored = store.append({ conversationId, actor, payload })
  if (stored === null) throw new Error('the store refused an append')
  return stored
}

function joined(agentId: AgentId = 'codex', sessionRef = REF): StoredEvent {
  return append(
    { type: 'session.started', agentId, sessionRef, cwd: '/tmp', model: null, cliVersion: null },
    'system'
  )
}

function left(sessionRef = REF, agentId: AgentId = 'codex'): StoredEvent {
  return append({ type: 'session.ended', agentId, sessionRef, reason: 'closed' }, 'system')
}

function turnStarted(actor: Actor = 'codex', turnRef = 't1'): StoredEvent {
  return append({ type: 'turn.started', turnRef }, actor)
}

function turnCompleted(
  status: 'completed' | 'interrupted' | 'failed' = 'completed',
  actor: Actor = 'codex',
  turnRef = 't1'
): StoredEvent {
  return append({ type: 'turn.completed', turnRef, status, userInitiated: false }, actor)
}

function said(text: string, itemRef = 'i1'): StoredEvent {
  return append({ type: 'agent.message.completed', itemRef, text })
}

function approvalRequested(approvalId: string): StoredEvent {
  return append({
    type: 'approval.requested',
    approvalId,
    kind: 'command',
    request: {},
    expiresAt: 0,
  })
}

/** Timers are injected so a deadline is fired rather than waited out. */
function fakeClock(): { clock: Clock; fire: (ms: number) => void } {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 0
  return {
    clock: {
      setTimeout: (fn, ms) => {
        next += 1
        timers.set(next, { fn, ms })
        return next
      },
      clearTimeout: (handle) => {
        if (typeof handle === 'number') timers.delete(handle)
      },
    },
    fire: (ms) => {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms) continue
        timers.delete(id)
        timer.fn()
      }
    },
  }
}

interface Tracked<T> {
  settled: boolean
  value: T | undefined
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const state: Tracked<T> = { settled: false, value: undefined }
  void promise.then((value) => {
    state.settled = true
    state.value = value
  })
  return state
}

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

function start(options: { deliver?: () => Promise<void>; controller?: AbortController } = {}): {
  result: Tracked<DispatchResult>
  drained: Tracked<void>
  controller: AbortController
  fire: (ms: number) => void
} {
  const controller = options.controller ?? new AbortController()
  const timers = fakeClock()
  const dispatch = dispatchAndWatch(
    store,
    {
      conversationId: CONV,
      agentId: 'codex',
      sessionRef: REF,
      deliver: options.deliver ?? ((): Promise<void> => Promise.resolve()),
      signal: controller.signal,
    },
    timers.clock
  )
  return {
    result: track(dispatch.result),
    drained: track(dispatch.drained),
    controller,
    fire: timers.fire,
  }
}

describe('the open-turn preflight', () => {
  it('counts only inside the current session epoch', () => {
    joined()
    turnStarted()
    append(
      { type: 'session.ended', agentId: 'codex', sessionRef: REF, reason: 'crashed' },
      'system'
    )
    joined('codex', 'session-ref-2')
    expect(agentIsBusy(store.read(CONV), 'codex')).toBe(false)
  })

  it('is busy while a start inside the epoch is unmatched', () => {
    joined()
    turnStarted()
    expect(agentIsBusy(store.read(CONV), 'codex')).toBe(true)
  })

  it('attributes a turn by actor, because neither payload names an agent', () => {
    joined()
    joined('claude', 'claude-ref')
    turnStarted('claude')
    expect(agentIsBusy(store.read(CONV), 'codex')).toBe(false)
    expect(agentIsBusy(store.read(CONV), 'claude')).toBe(true)
  })
})

describe('the idle suspension', () => {
  it('closes on a withdrawal, not only on a decision', () => {
    joined()
    approvalRequested('a1')
    expect(cardIsOpen(store.read(CONV), 'codex')).toBe(true)
    append({ type: 'approval.withdrawn', approvalId: 'a1' })
    expect(cardIsOpen(store.read(CONV), 'codex')).toBe(false)
  })

  it('closes on a decision the user made', () => {
    joined()
    approvalRequested('a2')
    append(
      {
        type: 'approval.decided',
        approvalId: 'a2',
        outcome: 'allow',
        scope: 'once',
        decidedBy: 'user',
        policyRuleId: null,
      },
      'user'
    )
    expect(cardIsOpen(store.read(CONV), 'codex')).toBe(false)
  })

  it('stays open for a question, which is registered with no timer at all', () => {
    joined()
    append({ type: 'userinput.requested', userInputId: 'q1', request: {}, expiresAt: 0 })
    expect(cardIsOpen(store.read(CONV), 'codex')).toBe(true)
    append(
      {
        type: 'userinput.answered',
        userInputId: 'q1',
        outcome: 'answered',
        answers: [],
        answeredBy: 'user',
      },
      'user'
    )
    expect(cardIsOpen(store.read(CONV), 'codex')).toBe(false)
  })
})

describe('a dispatch', () => {
  it('resolves with the last completed message and its event id', async () => {
    joined()
    const run = start()
    turnStarted()
    said('first', 'i1')
    said('middle', 'i2')
    const last = said('verdict: ready', 'i3')
    turnCompleted()
    await flush()
    expect(run.result.value).toEqual({
      status: 'completed',
      eventId: last.id,
      text: 'verdict: ready',
    })
    expect(run.drained.settled).toBe(true)
  })

  it('ignores another conversation, because subscribe is global', async () => {
    joined()
    const run = start()
    append({ type: 'turn.started', turnRef: 't1' }, 'codex', OTHER)
    append(
      { type: 'turn.completed', turnRef: 't1', status: 'completed', userInitiated: false },
      'codex',
      OTHER
    )
    await flush()
    expect(run.result.settled).toBe(false)
    expect(run.drained.settled).toBe(false)
  })

  it('fails on an interrupted turn', async () => {
    joined()
    const run = start()
    turnStarted()
    said('half a thought')
    turnCompleted('interrupted')
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'turnFailed' })
  })

  it('fails with noReply when a turn says nothing', async () => {
    joined()
    const run = start()
    turnStarted()
    turnCompleted()
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'noReply' })
  })

  it('survives the recoverable error a supervisor restart emits', async () => {
    joined()
    const run = start()
    turnStarted()
    append({
      type: 'error.raised',
      message: 'agent codex exited unexpectedly; restarting',
      recoverable: true,
    })
    await flush()
    expect(run.result.settled).toBe(false)
  })

  it('fails on a non-recoverable error, read from the actor', async () => {
    joined()
    const run = start()
    turnStarted()
    append({ type: 'error.raised', message: 'the binary is gone', recoverable: false })
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'turnFailed' })
    expect(run.drained.settled).toBe(false)
  })

  it('releases on the captured session ref and not on another', async () => {
    joined()
    const run = start()
    left('a-different-ref')
    await flush()
    expect(run.drained.settled).toBe(false)
    left(REF)
    await flush()
    expect(run.drained.settled).toBe(true)
    expect(run.result.value).toEqual({ status: 'failed', reason: 'sessionEnded' })
  })

  it('fails on the acknowledgement deadline and frees nobody', async () => {
    joined()
    const run = start({ deliver: () => new Promise<void>(() => undefined) })
    run.fire(ACKNOWLEDGEMENT_MS)
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'acknowledgement' })
    expect(run.drained.settled).toBe(false)
  })

  it('fails on the idle deadline and frees nobody', async () => {
    joined()
    const run = start()
    turnStarted()
    run.fire(IDLE_MS)
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'idle' })
    expect(run.drained.settled).toBe(false)
  })

  it('does not go idle while a card is open, and can once it is withdrawn', async () => {
    joined()
    const run = start()
    turnStarted()
    approvalRequested('a1')
    run.fire(IDLE_MS)
    await flush()
    expect(run.result.settled).toBe(false)
    append({ type: 'approval.withdrawn', approvalId: 'a1' })
    run.fire(IDLE_MS)
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'idle' })
  })

  it('settles the result on abort and keeps watching for the proof', async () => {
    joined()
    const run = start()
    run.controller.abort()
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'aborted' })
    expect(run.drained.settled).toBe(false)
    turnStarted()
    turnCompleted()
    await flush()
    expect(run.drained.settled).toBe(true)
  })

  it('keeps watching when the abort lands after the turn started', async () => {
    joined()
    const run = start()
    turnStarted()
    run.controller.abort()
    await flush()
    expect(run.drained.settled).toBe(false)
    turnCompleted()
    await flush()
    expect(run.drained.settled).toBe(true)
  })

  it('releases at once when nothing was ever delivered', async () => {
    joined()
    const controller = new AbortController()
    controller.abort()
    const run = start({ controller })
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'aborted' })
    expect(run.drained.settled).toBe(true)
  })

  it('fails on a delivery rejection without releasing ownership', async () => {
    joined()
    const run = start({ deliver: () => Promise.reject(new Error('never written')) })
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'delivery' })
    expect(run.drained.settled).toBe(false)
  })

  /* The proof is that the run passes: vitest fails a suite on an unhandled rejection. */
  it('consumes a delivery rejection that lands after an abort', async () => {
    joined()
    let reject!: (error: Error) => void
    const run = start({
      deliver: () =>
        new Promise<void>((_resolve, r) => {
          reject = r
        }),
    })
    run.controller.abort()
    await flush()
    reject(new Error('too late to matter'))
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'aborted' })
  })

  it('loses attribution to a user message, so only a session end releases it', async () => {
    joined()
    const run = start()
    append({ type: 'user.message', text: 'stop' }, 'user')
    turnStarted()
    said('a reply to the user')
    turnCompleted()
    await flush()
    expect(run.result.settled).toBe(true)
    expect(run.drained.settled).toBe(false)
    left(REF)
    await flush()
    expect(run.drained.settled).toBe(true)
  })

  it('gives up attribution on a foreign turn', async () => {
    joined()
    const run = start()
    turnStarted('codex', 't1')
    turnStarted('codex', 't2')
    await flush()
    expect(run.result.value).toEqual({ status: 'failed', reason: 'foreignTurn' })
    turnCompleted('completed', 'codex', 't1')
    turnCompleted('completed', 'codex', 't2')
    await flush()
    expect(run.drained.settled).toBe(false)
  })

  it('releases on start-plus-completion while the delivery is still pending', async () => {
    joined()
    const run = start({ deliver: () => new Promise<void>(() => undefined) })
    turnStarted()
    said('verdict: objections')
    turnCompleted()
    await flush()
    expect(run.drained.settled).toBe(true)
  })

  it('holds ownership when the delivery resolves before the turn starts', async () => {
    joined()
    const run = start()
    await flush()
    expect(run.drained.settled).toBe(false)
    turnStarted()
    said('verdict: ready')
    turnCompleted()
    await flush()
    expect(run.drained.settled).toBe(true)
  })
})

interface PendingHop {
  resolve: (result: DispatchResult) => void
  release: () => void
  request: DispatchRequest
}

/**
 * The coordinator's ports, so a whole run is driven without a provider.
 *
 * `watch` hands back promises the test settles by hand, which is the only way
 * to assert that a cancel lands between two hops rather than after them.
 */
function fakePort(options: { sessionRef?: string | null; noCoder?: boolean } = {}): {
  port: CoordinatorPort
  sent: HandoffDispatch[]
  statuses: RunStatus[]
  hops: PendingHop[]
} {
  const sent: HandoffDispatch[] = []
  const statuses: RunStatus[] = []
  const hops: PendingHop[] = []
  let version = 0

  const port: CoordinatorPort = {
    handoff: (input) => {
      sent.push(input)
      return Promise.resolve()
    },
    sessionRef: (_conversationId, agentId) => {
      // The coder is the one agent a run tolerates being absent, so the fake has
      // to be able to say so for exactly that agent.
      if (agentId === CODER && options.noCoder === true) return null
      return options.sessionRef === undefined ? REF : options.sessionRef
    },
    watch: (request) => {
      let resolve!: (result: DispatchResult) => void
      let release!: () => void
      const result = new Promise<DispatchResult>((settle) => {
        resolve = settle
      })
      const drained = new Promise<void>((settle) => {
        release = () => {
          settle()
        }
      })
      hops.push({ resolve, release, request })
      void request.deliver()
      return { result, drained }
    },
    read: () => store.read(CONV),
    nextStatusVersion: () => {
      version += 1
      return version
    },
    onStatus: (status) => {
      statuses.push(status)
    },
    newRunId: () => 'run-1',
  }

  return { port, sent, statuses, hops }
}

function bothJoined(): void {
  joined()
  joined('claude', 'claude-ref')
}

function newRun(
  port: CoordinatorPort,
  preset: Preset = 'delivery',
  sourceEventId = 'source-1'
): CollaborationRun {
  return new CollaborationRun(port, { conversationId: CONV, preset, sourceEventId })
}

describe('parseVerdict', () => {
  it('reads the first nonblank line', () => {
    expect(parseVerdict('verdict: ready\n\nlooks right')).toBe('ready')
    expect(parseVerdict('\n  verdict: objections\n\n- one thing')).toBe('objections')
  })

  it('accepts emphasis, because a reviewer writing bold meant the verdict', () => {
    expect(parseVerdict('**verdict: ready**')).toBe('ready')
    expect(parseVerdict('- verdict: objections')).toBe('objections')
  })

  it('refuses a verdict anywhere but the first line', () => {
    expect(parseVerdict('I will answer with verdict: ready as asked.')).toBe('unparsed')
    expect(parseVerdict('Looks fine to me.\n\nverdict: ready')).toBe('unparsed')
  })

  it('is unparsed on an empty reply, and never ready', () => {
    expect(parseVerdict('')).toBe('unparsed')
    expect(parseVerdict('   \n  ')).toBe('unparsed')
  })
})

describe('the delivery pipeline', () => {
  /*
   * `guided` used to be review → revise → verify → report between two agents.
   * It is now the delivery pipeline: the planner's reply *is* the plan, the
   * reviewer reviews it, the planner splits the result, and each micro-task goes
   * to the coder and comes back to the planner to be checked.
   */
  const SPLIT = 'The final plan.\n\ntasks:\n- one\n- two'
  const ONE_TASK = 'Plan.\n\ntasks:\n- only'

  /** Resolves the next pending hop, in order, with the text given. */
  const answer = async (fake: ReturnType<typeof fakePort>, index: number, text: string) => {
    await flush()
    fake.hops[index]?.resolve({ status: 'completed', eventId: `e${String(index + 1)}`, text })
    // A second flush so the run has acted on the reply before anything is
    // asserted about the state it left behind.
    await flush()
  }

  it('reviews the plan, splits it, then delivers each task and checks it', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: objections\n\ntoo coarse')
    await answer(fake, 1, SPLIT)
    await answer(fake, 2, 'did one')
    await answer(fake, 3, 'verdict: ready')
    await answer(fake, 4, 'did two')
    await answer(fake, 5, 'verdict: ready')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 6, 'where it ended')

    expect(await done).toEqual({ phase: 'finished', outcome: 'agreed' })
    expect(fake.sent.map((hop) => [hop.from, hop.to, hop.intent])).toEqual([
      ['claude', 'codex', 'review'],
      ['codex', 'claude', 'discuss'],
      ['claude', 'deepseek', 'implement'],
      ['deepseek', 'claude', 'review'],
      ['claude', 'deepseek', 'implement'],
      ['deepseek', 'claude', 'review'],
      ['claude', 'claude', 'discuss'],
    ])
  })

  it('quotes the one task onto the note rather than naming its number', async () => {
    /*
     * The coder is handed the transcript so far, so "do task 2" would make it
     * count a list it may be reading in a different order than the planner
     * wrote it.
     */
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, SPLIT)
    await answer(fake, 2, 'did one')
    await answer(fake, 3, 'verdict: ready')
    await answer(fake, 4, 'did two')
    await answer(fake, 5, 'verdict: ready')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 6, 'where it ended')
    await done

    expect(fake.sent[2]?.note).toContain('one')
    expect(fake.sent[4]?.note).toContain('two')
    expect(fake.sent[2]?.note).not.toContain('task 1')
  })

  it('never asks the coder for a verdict', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, ONE_TASK)
    await answer(fake, 2, 'done')
    await answer(fake, 3, 'verdict: ready')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 4, 'where it ended')
    await done

    const toCoder = fake.sent.filter((hop) => hop.to === CODER)
    expect(toCoder).toHaveLength(1)
    expect(toCoder[0]?.note).not.toContain('verdict:')
  })

  it('re-issues a rejected task, and gives up after the cap', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, ONE_TASK)
    for (let attempt = 0; attempt < MAX_REISSUES; attempt += 1) {
      await answer(fake, 2 + attempt * 2, 'attempt')
      await answer(fake, 3 + attempt * 2, 'verdict: objections')
    }

    /*
     * Ends the run rather than moving on. The tasks are a plan in order, and
     * carrying past one the planner would not accept builds the rest on top of
     * work it rejected.
     */
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 2 + MAX_REISSUES * 2, 'where it ended')

    expect(await done).toEqual({ phase: 'finished', outcome: 'unresolved' })
    expect(fake.sent.filter((hop) => hop.to === CODER)).toHaveLength(MAX_REISSUES)
  })

  it('skips the plan review entirely under the build preset', async () => {
    /*
     * The case this exists for: you have discussed the plan with the planner
     * and you are satisfied. A review hop would re-open a question you closed,
     * and it would need a reviewer seated that the room may not have.
     */
    bothJoined()
    const fake = fakePort()
    const run = new CollaborationRun(fake.port, {
      conversationId: CONV,
      preset: 'build',
      sourceEventId: 'the-agreed-plan',
    })
    const done = run.start()

    await answer(fake, 0, ONE_TASK)
    await answer(fake, 1, 'done')
    await answer(fake, 2, 'verdict: ready')
    await answer(fake, 3, 'where it ended')

    expect(await done).toEqual({ phase: 'finished', outcome: 'agreed' })
    // Codex is never dispatched to, and the first hop is the split itself.
    expect(fake.sent.some((hop) => hop.to === REVIEWER)).toBe(false)
    expect(fake.sent.map((hop) => [hop.from, hop.to, hop.intent])).toEqual([
      ['claude', 'claude', 'discuss'],
      ['claude', 'deepseek', 'implement'],
      ['deepseek', 'claude', 'review'],
      ['claude', 'claude', 'discuss'],
    ])
    expect(fake.sent[0]?.sourceEventIds).toEqual(['the-agreed-plan'])
  })

  it('counts one hop fewer than delivery before the loop', async () => {
    bothJoined()
    const fake = fakePort()
    const run = new CollaborationRun(fake.port, {
      conversationId: CONV,
      preset: 'build',
      sourceEventId: 'source-1',
    })
    const done = run.start()

    await answer(fake, 0, ONE_TASK)
    // One to get here, two for the task, one report — against delivery's five.
    expect(run.status().stepTotal).toBe(4)

    await answer(fake, 1, 'done')
    await answer(fake, 2, 'verdict: ready')
    await answer(fake, 3, 'where it ended')
    await done
  })

  it('writes no report when nothing was delivered', async () => {
    /*
     * `unsplit` and `tooManyTasks` end before any task is sent. A report on a
     * run that did nothing is a turn spent restating what the transcript
     * already shows.
     */
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, 'prose, no list')

    expect(await done).toEqual({ phase: 'finished', outcome: 'unsplit' })
    expect(fake.sent.some((hop) => hop.intent === 'discuss' && hop.from === hop.to)).toBe(false)
  })

  it('refuses a list longer than the cap rather than truncating it', async () => {
    // Delivering the first twenty of twenty-five would leave five tasks nobody
    // did and a report that did not say so.
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    const tooMany = Array.from({ length: MAX_MICRO_TASKS + 1 }, (_, i) => `- t${String(i)}`)
    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, ['plan', '', 'tasks:', ...tooMany].join('\n'))

    expect(await done).toEqual({ phase: 'finished', outcome: 'tooManyTasks' })
    expect(fake.sent.some((hop) => hop.to === CODER)).toBe(false)
  })

  it('falls back to the planner coding, and skips the check when it does', async () => {
    /*
     * A review is only worth a turn when someone else wrote the code. With no
     * coder seated the planner does its own micro-tasks and is not asked to
     * review the turn it just took.
     */
    bothJoined()
    const fake = fakePort({ noCoder: true })
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, SPLIT)
    await answer(fake, 2, 'did one')
    await answer(fake, 3, 'did two')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 4, 'where it ended')

    expect(await done).toEqual({ phase: 'finished', outcome: 'agreed' })
    expect(fake.sent.some((hop) => hop.to === CODER)).toBe(false)
    expect(fake.sent.filter((hop) => hop.intent === 'implement')).toHaveLength(2)
    expect(fake.sent.some((hop) => hop.intent === 'review' && hop.from === PLANNER)).toBe(true)
  })

  it('does not short-circuit on a ready verdict', async () => {
    /*
     * The old flow stopped here: a reviewer with no objections meant there was
     * nothing to revise. The pipeline still has to split an approved plan,
     * because the split is the deliverable rather than the fix.
     */
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, ONE_TASK)
    await answer(fake, 2, 'done')
    await answer(fake, 3, 'verdict: ready')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 4, 'where it ended')
    await done

    expect(fake.sent).toHaveLength(5)
  })

  it('carries the verdict protocol to the reviewer and the task protocol to the planner', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: objections')
    await answer(fake, 1, ONE_TASK)
    await answer(fake, 2, 'done')
    await answer(fake, 3, 'verdict: ready')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 4, 'where it ended')
    await done

    expect(fake.sent[0]?.note).toContain('verdict: objections')
    expect(fake.sent[0]?.note).not.toContain('tasks:')
    expect(fake.sent[1]?.note).toContain('tasks:')
  })

  it('ends unsplit when the planner returns no readable task list', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await answer(fake, 0, 'verdict: ready')
    await answer(fake, 1, 'here is the plan, in prose')

    expect(await done).toEqual({ phase: 'finished', outcome: 'unsplit' })
  })

  it('does not know its length until the split is read', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()

    await flush()
    expect(run.status().stepTotal).toBeNull()
    await answer(fake, 0, 'verdict: ready')
    expect(run.status().stepTotal).toBeNull()
    await answer(fake, 1, SPLIT)
    // Two hops to get here, two per task, and the closing report.
    expect(run.status().stepTotal).toBe(7)

    await answer(fake, 2, 'did one')
    await answer(fake, 3, 'verdict: ready')
    await answer(fake, 4, 'did two')
    await answer(fake, 5, 'verdict: ready')
    // The closing report: a handoff from the planner to itself.
    await answer(fake, 6, 'where it ended')
    await done
  })
})

describe('cancelling a run', () => {
  it('ends at once, keeps the agents owned, and frees them on the drain', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    run.cancel('stop')
    fake.hops[0]?.resolve({ status: 'failed', reason: 'aborted' })
    expect(await done).toEqual({ phase: 'cancelled', by: 'stop' })
    expect(run.status().draining).toBe(true)
    expect(run.status().ownership).toBe('owned')

    fake.hops[0]?.release()
    await flush()
    expect(run.status().draining).toBe(false)
    expect(run.status().ownership).toBe('free')
  })

  it('dispatches nothing further once cancelled', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    run.cancel('stop')
    fake.hops[0]?.resolve({ status: 'completed', eventId: 'e1', text: 'verdict: objections' })
    await done
    await flush()
    expect(fake.sent).toHaveLength(1)
  })

  it('loses attribution to a user message and not to Stop', async () => {
    bothJoined()
    const stopped = fakePort()
    const byStop = newRun(stopped.port)
    const stopDone = byStop.start()
    await flush()
    byStop.cancel('stop')
    stopped.hops[0]?.resolve({ status: 'failed', reason: 'aborted' })
    await stopDone
    expect(byStop.status().ownership).toBe('owned')

    const messaged = fakePort()
    const bySend = newRun(messaged.port)
    const sendDone = bySend.start()
    await flush()
    bySend.cancel('userMessage')
    messaged.hops[0]?.resolve({ status: 'failed', reason: 'aborted' })
    await sendDone
    expect(bySend.status().ownership).toBe('unattributable')
  })

  it('ignores a second cancel', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    run.cancel('stop')
    run.cancel('userMessage')
    fake.hops[0]?.resolve({ status: 'failed', reason: 'aborted' })
    expect(await done).toEqual({ phase: 'cancelled', by: 'stop' })
    expect(run.status().ownership).toBe('owned')
  })
})

describe('a failing hop', () => {
  it('names the failure and still holds the agents', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    fake.hops[0]?.resolve({ status: 'failed', reason: 'acknowledgement' })
    expect(await done).toEqual({ phase: 'failed', reason: 'acknowledgement' })
    expect(run.status().draining).toBe(true)
    expect(run.status().ownership).toBe('owned')
  })

  it('reports a foreign turn as interrupted and unattributable', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    fake.hops[0]?.resolve({ status: 'failed', reason: 'foreignTurn' })
    expect(await done).toEqual({ phase: 'interrupted', reason: 'foreignTurn' })
    expect(run.status().ownership).toBe('unattributable')
  })

  it('fails without dispatching when the target is not in the room', async () => {
    bothJoined()
    const fake = fakePort({ sessionRef: null })
    const run = newRun(fake.port)

    expect(await run.start()).toEqual({ phase: 'failed', reason: 'sessionEnded' })
    expect(fake.sent).toHaveLength(0)
  })

  it('refuses to start while an agent has an unmatched turn', async () => {
    bothJoined()
    turnStarted()
    const fake = fakePort()
    const run = newRun(fake.port)

    expect(await run.start()).toEqual({ phase: 'failed', reason: 'sessionEnded' })
    expect(fake.sent).toHaveLength(0)
  })
})

describe('the status contract', () => {
  it('numbers every status from one conversation-wide counter', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()
    fake.hops[0]?.resolve({ status: 'completed', eventId: 'e1', text: 'verdict: ready' })
    await flush()
    fake.hops[1]?.resolve({
      status: 'completed',
      eventId: 'e2',
      text: 'Plan.\n\ntasks:\n- only',
    })
    /*
     * One task, delivered and checked. The pipeline no longer ends at the split,
     * so a status test has to run the loop out or it waits for a hop nobody
     * answers.
     */
    await flush()
    fake.hops[2]?.resolve({ status: 'completed', eventId: 'e3', text: 'done' })
    await flush()
    fake.hops[3]?.resolve({ status: 'completed', eventId: 'e4', text: 'verdict: ready' })
    // And the closing report, which the planner hands to itself.
    await flush()
    fake.hops[4]?.resolve({ status: 'completed', eventId: 'e5', text: 'where it ended' })
    await done

    const versions = fake.statuses.map((status) => status.statusVersion)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
  })

  /*
   * The published snapshot is what `sendHandoff` reads to refuse a manual
   * handoff, so it has to be true *during* a hop rather than only after one
   * ends. It was not: `hop` published before the dispatch was held, and `hold`
   * published only on release — so a manual handoff went through mid-hop, and
   * its turn could be taken for the coordinator's own.
   */
  it('is draining from the moment a hop is dispatched, not only once it ends', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    expect(fake.sent).toHaveLength(1)
    expect(run.status().draining).toBe(true)
    expect(run.status().ownership).toBe('owned')

    fake.hops[0]?.resolve({ status: 'completed', eventId: 'e1', text: 'verdict: ready' })
    await flush()
    fake.hops[1]?.resolve({
      status: 'completed',
      eventId: 'e2',
      text: 'Plan.\n\ntasks:\n- only',
    })
    /*
     * One task, delivered and checked. The pipeline no longer ends at the split,
     * so a status test has to run the loop out or it waits for a hop nobody
     * answers.
     */
    await flush()
    fake.hops[2]?.resolve({ status: 'completed', eventId: 'e3', text: 'done' })
    await flush()
    fake.hops[3]?.resolve({ status: 'completed', eventId: 'e4', text: 'verdict: ready' })
    // And the closing report, which the planner hands to itself.
    await flush()
    fake.hops[4]?.resolve({ status: 'completed', eventId: 'e5', text: 'where it ended' })
    await done
    expect(run.status().draining).toBe(true)

    // Both hops hold: the pipeline no longer stops on a ready verdict, so a run
    // is only free once every agent it dispatched to has released.
    for (const hop of fake.hops) hop.release()
    await flush()
    expect(run.status().draining).toBe(false)
    expect(run.status().ownership).toBe('free')
  })

  it('stays draining across a hop boundary, so the gap between hops is not open', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()

    fake.hops[0]?.resolve({ status: 'completed', eventId: 'e1', text: 'verdict: objections' })
    await flush()
    expect(fake.sent).toHaveLength(2)
    expect(run.status().draining).toBe(true)

    fake.hops[1]?.resolve({
      status: 'completed',
      eventId: 'e2',
      text: 'Plan.\n\ntasks:\n- only',
    })
    /*
     * One task, delivered and checked. The pipeline no longer ends at the split,
     * so a status test has to run the loop out or it waits for a hop nobody
     * answers.
     */
    await flush()
    fake.hops[2]?.resolve({ status: 'completed', eventId: 'e3', text: 'done' })
    await flush()
    fake.hops[3]?.resolve({ status: 'completed', eventId: 'e4', text: 'verdict: ready' })
    // And the closing report, which the planner hands to itself.
    await flush()
    fake.hops[4]?.resolve({ status: 'completed', eventId: 'e5', text: 'where it ended' })
    await done
    expect(run.status().draining).toBe(true)
  })

  it('leaves stepTotal unknown until the split is read', () => {
    /*
     * The pipeline's length is `3 + 2 x tasks` and nothing can compute it
     * before the planner has split the plan — so the honest value until then is
     * null, not a guess.
     */
    bothJoined()
    const fake = fakePort()
    expect(newRun(fake.port).status().stepTotal).toBeNull()
  })

  it('counts the step it is on', async () => {
    bothJoined()
    const fake = fakePort()
    const run = newRun(fake.port)
    const done = run.start()
    await flush()
    expect(run.status().stepIndex).toBe(1)

    fake.hops[0]?.resolve({ status: 'completed', eventId: 'e1', text: 'verdict: objections' })
    await flush()
    expect(run.status().stepIndex).toBe(2)

    fake.hops[1]?.resolve({
      status: 'completed',
      eventId: 'e2',
      text: 'Plan.\n\ntasks:\n- only',
    })
    /*
     * One task, delivered and checked. The pipeline no longer ends at the split,
     * so a status test has to run the loop out or it waits for a hop nobody
     * answers.
     */
    await flush()
    fake.hops[2]?.resolve({ status: 'completed', eventId: 'e3', text: 'done' })
    await flush()
    fake.hops[3]?.resolve({ status: 'completed', eventId: 'e4', text: 'verdict: ready' })
    // And the closing report, which the planner hands to itself.
    await flush()
    fake.hops[4]?.resolve({ status: 'completed', eventId: 'e5', text: 'where it ended' })
    await done
    expect(run.status().stepIndex).toBe(5)
  })
})

/**
 * Who a run needs, asked once.
 *
 * `runtime.ts` refuses a start when a required agent is not seated, and this
 * file dispatches to them. Those were two hardcoded pairs that happened to
 * agree; `rolesFor` makes them one answer, because the pipeline's cast is about
 * to differ per preset and two lists would drift the moment it does.
 */
describe('the roles a run needs', () => {
  it('names three distinct agents', () => {
    expect(new Set([PLANNER, REVIEWER, CODER]).size).toBe(3)
  })

  it('asks for the planner alone when the plan is already agreed', () => {
    /*
     * `build` skips the plan review, so it needs no reviewer seated — that is
     * the whole point of it. `runtime.ts` refuses a start on exactly this list,
     * so returning the reviewer here would make the preset impossible in the
     * rooms it exists for: a project with only Claude and DeepSeek.
     */
    expect(rolesFor('build')).toEqual([PLANNER])
    expect(rolesFor('build')).not.toContain(REVIEWER)
    expect(rolesFor('build')).not.toContain(CODER)
  })

  it('asks for the planner and the reviewer, and never for the coder', () => {
    /*
     * **The coder is deliberately not here, and stays not here.** `runtime.ts`
     * refuses to start a run when a listed agent is missing, and the coder is
     * the one agent whose absence is survivable — a run without it falls back to
     * the planner writing its own micro-tasks. Adding it to this list would turn
     * that fallback into a refusal.
     */
    expect(rolesFor('delivery')).toEqual([PLANNER, REVIEWER])
    expect(rolesFor('delivery')).not.toContain(CODER)
  })

  it('never returns the same agent twice', () => {
    // A duplicate would make `runtime.ts` check one seat twice and miss another.
    for (const preset of ['delivery', 'build'] as const) {
      const roles = rolesFor(preset)
      expect(new Set(roles).size).toBe(roles.length)
    }
  })
})

/**
 * The split, read from a reply written by a model rather than by a fixture.
 *
 * Every case here is a way a model actually formats a list. The one that matters
 * most is the plan that *quotes* the protocol before emitting the real block —
 * taking the first anchor would turn a sentence about the list into the list.
 */
describe('parseMicroTasks', () => {
  it('reads a plain list under the anchor', () => {
    expect(
      parseMicroTasks(['Here is the plan.', '', 'tasks:', '- one', '- two', '- three'].join('\n'))
    ).toEqual(['one', 'two', 'three'])
  })

  it('takes the last anchor, so a plan may quote the protocol', () => {
    /*
     * The failure this exists to stop: a planner explaining what it is about to
     * do, in the words the protocol gave it, and those words becoming the work.
     */
    const reply = [
      'I will end with a line that is exactly:',
      'tasks:',
      'then one task per line. First, the approach…',
      '',
      'tasks:',
      '- the real one',
    ].join('\n')
    expect(parseMicroTasks(reply)).toEqual(['the real one'])
  })

  it('accepts numbered lists, because models write them', () => {
    expect(parseMicroTasks(['tasks:', '1. first', '2) second'].join('\n'))).toEqual([
      'first',
      'second',
    ])
  })

  it('accepts an emphasised anchor', () => {
    expect(parseMicroTasks(['**tasks:**', '- one'].join('\n'))).toEqual(['one'])
  })

  it('skips blank lines between tasks rather than ending on one', () => {
    // Ending on the first blank would take one task from a list of three.
    expect(parseMicroTasks(['tasks:', '- one', '', '- two', '', '- three'].join('\n'))).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('stops at prose after the list', () => {
    expect(
      parseMicroTasks(['tasks:', '- one', '', 'That is the whole plan.', '- not a task'].join('\n'))
    ).toEqual(['one'])
  })

  it('returns nothing when there is no anchor', () => {
    expect(parseMicroTasks('- one\n- two')).toEqual([])
  })

  it('returns nothing when the last anchor has no list under it', () => {
    /*
     * The safe failure. A reply that repeats the bare anchor after its real
     * block lands here, and the caller asks again — rather than the parser
     * guessing which of the two blocks was meant.
     */
    expect(parseMicroTasks(['tasks:', '- one', '', 'tasks:'].join('\n'))).toEqual([])
  })

  it('does not treat a sentence beginning "tasks:" as an anchor', () => {
    // `tasks: done` is prose. Only a line that is exactly the anchor counts, or
    // any sentence starting with the word would end the list early.
    expect(parseMicroTasks(['tasks:', '- one', '', 'tasks: done'].join('\n'))).toEqual(['one'])
  })

  it('does not truncate a long list', () => {
    // Bounding is the run's decision, not the parser's — a parser that silently
    // cut the list would hide a malformed split instead of reporting one.
    const many = Array.from({ length: 200 }, (_, i) => `- task ${String(i)}`)
    expect(parseMicroTasks(['tasks:', ...many].join('\n'))).toHaveLength(200)
  })

  it('survives carriage returns', () => {
    expect(parseMicroTasks('tasks:\r\n- one\r\n- two')).toEqual(['one', 'two'])
  })

  it('asks for the anchor it parses', () => {
    // The protocol and the parser drifting apart is the failure no other test
    // here can see: both would be internally consistent and disagree.
    expect(TASK_PROTOCOL).toContain('tasks:')
    expect(parseMicroTasks(`${TASK_PROTOCOL}\n\ntasks:\n- proof`)).toEqual(['proof'])
  })
})
