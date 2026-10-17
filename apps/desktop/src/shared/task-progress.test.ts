import { describe, expect, it } from 'vitest'
import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'
import {
  appendTaskMarks,
  reduceTask,
  taskMarkOf,
  taskMarksFromRecords,
  taskOutcomeOf,
  type TaskBundle,
  type TaskHistoryEntry,
  type TaskMark,
  type TaskSnapshot,
} from './task-progress.js'

const MINUTE = 60_000
const T0 = 1_700_000_000_000
const TASK = 'task-1'

let counter = 0
const when = (minutes: number): { at: number; seq: number } => ({
  at: T0 + minutes * MINUTE,
  seq: ++counter,
})
const time = (minutes: number): number => T0 + minutes * MINUTE

type Step = Extract<TaskMark, { kind: 'revised' }>['steps'][number]

const step = (
  id: string,
  status: Step['status'],
  estimateMinutes?: number,
  extra: Partial<Step> = {}
): Step => ({
  id,
  title: `Step ${id}`,
  status,
  ...(estimateMinutes === undefined ? {} : { estimateMinutes }),
  ...extra,
})

const user = (minutes: number, work = true): TaskMark => ({
  kind: 'user',
  ...when(minutes),
  eventId: `user-${String(minutes)}`,
  work,
})
const opened = (minutes: number, startedMinutes = 0): TaskMark => ({
  kind: 'opened',
  ...when(minutes),
  taskId: TASK,
  originEventId: `user-${String(startedMinutes)}`,
  startedAt: time(startedMinutes),
})
const started = (minutes: number, agentId: AgentId = 'claude'): TaskMark => ({
  kind: 'turnStarted',
  ...when(minutes),
  agentId,
})
const completed = (
  minutes: number,
  agentId: AgentId = 'claude',
  status: 'completed' | 'interrupted' | 'failed' = 'completed',
  userInitiated = false
): TaskMark => ({ kind: 'turnCompleted', ...when(minutes), agentId, status, userInitiated })
let revision = 0
const revised = (
  minutes: number,
  steps: Step[],
  extra: Partial<Extract<TaskMark, { kind: 'revised' }>> = {}
): TaskMark => ({
  kind: 'revised',
  ...when(minutes),
  taskId: TASK,
  agentId: 'claude',
  revision: ++revision,
  source: 'chorus',
  steps,
  ...extra,
})
const waitStarted = (minutes: number, waitId: string, agentId: AgentId = 'claude'): TaskMark => ({
  kind: 'waitStarted',
  ...when(minutes),
  agentId,
  waitId,
  wait: 'approval',
})
const waitEnded = (minutes: number, waitId: string, agentId: AgentId = 'claude'): TaskMark => ({
  kind: 'waitEnded',
  ...when(minutes),
  agentId,
  waitId,
})

const bundle = (marks: TaskMark[], history: TaskHistoryEntry[] = []): TaskBundle => ({
  marks,
  history,
})

const reduce = (marks: TaskMark[], nowMinutes: number, history: TaskHistoryEntry[] = []) => {
  const snapshot = reduceTask(bundle(marks, history), time(nowMinutes))
  if (snapshot === null) throw new Error('expected a task')
  return snapshot
}

const minutes = (ms: number | undefined): number => (ms ?? Number.NaN) / MINUTE

const remaining = (snapshot: TaskSnapshot): number => minutes(snapshot.forecast?.remainingMs)

describe('a task with no opening', () => {
  it('has no snapshot, so the strip falls back to the working line', () => {
    expect(reduceTask(bundle([user(0), started(0)]), time(5))).toBeNull()
  })
})

describe('anchoring and the whole-task clock', () => {
  it('starts at the originating message and counts research before the plan', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0.5),
        opened(10, 0),
        revised(10, [step('a', 'active', 10), step('b', 'pending', 20)]),
      ],
      20
    )
    expect(snapshot.startedAt).toBe(time(0))
    expect(snapshot.originEventId).toBe('user-0')
    expect(minutes(snapshot.clocks.elapsedMs)).toBe(20)
    expect(minutes(snapshot.clocks.workingMs)).toBe(19.5)
    expect(minutes(snapshot.clocks.idleMs)).toBe(0.5)
    expect(snapshot.state).toBe('working')
    expect(remaining(snapshot)).toBe(20)
    expect(minutes(snapshot.forecast?.firstForecastMs)).toBe(30)
    expect(snapshot.forecast?.confidence).toBe('rough')
  })

  it('keeps one timer across replies and revisions, and explains what changed', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(1, 0),
        revised(1, [step('a', 'active', 10)]),
        completed(5),
        user(8),
        started(8),
        revised(9, [step('a', 'active', 10), step('b', 'pending', 15)], {
          reason: 'Found more work',
        }),
      ],
      12
    )
    expect(minutes(snapshot.clocks.elapsedMs)).toBe(12)
    expect(minutes(snapshot.clocks.workingMs)).toBe(9)
    expect(minutes(snapshot.clocks.idleMs)).toBe(3)
    expect(remaining(snapshot)).toBe(17)
    expect(minutes(snapshot.forecast?.firstForecastMs)).toBe(10)
    expect(minutes(snapshot.forecast?.plannedMs)).toBe(25)
    expect(snapshot.changes).toHaveLength(1)
    expect(snapshot.changes[0]).toMatchObject({
      added: ['b'],
      removed: [],
      completed: [],
      reason: 'Found more work',
      estimateDeltaMinutes: 0,
    })
    expect(minutes(snapshot.changes[0]?.remainingDeltaMs ?? undefined)).toBe(15)
  })

  it('freezes everything at completion', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'done', 30)], { complete: true }),
        completed(20),
        { kind: 'closed', ...when(21), taskId: TASK, reason: 'completed' },
        started(30),
      ],
      100
    )
    expect(snapshot.state).toBe('complete')
    expect(snapshot.closeReason).toBe('completed')
    expect(minutes(snapshot.clocks.elapsedMs)).toBe(21)
    expect(minutes(snapshot.clocks.workingMs)).toBe(20)
    expect(snapshot.working).toEqual([])
    expect(snapshot.waitingOn).toEqual([])
    expect(snapshot.readyToClose).toBe(false)
  })

  it('ignores marks that belong to an earlier task', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        { kind: 'opened', ...when(0), taskId: 'old', originEventId: 'x', startedAt: time(0) },
        { ...revised(0, [step('z', 'active', 99)]), taskId: 'old' } as TaskMark,
        { kind: 'closed', ...when(1), taskId: 'old', reason: 'superseded' },
        opened(1, 1),
        revised(1, [step('a', 'active', 10)]),
      ],
      3
    )
    expect(snapshot.taskId).toBe(TASK)
    expect(snapshot.steps.map((view) => view.id)).toEqual(['a'])
    expect(minutes(snapshot.clocks.elapsedMs)).toBe(2)
  })
})

describe('finishing', () => {
  const done = [step('a', 'done', 10), step('b', 'skipped', 5)]

  it('is never ready while the declaring turn is still running, and never closes itself', () => {
    const running = reduce(
      [user(0), started(0), opened(0), revised(5, done, { complete: true })],
      6
    )
    expect(running.lanes[0]?.completion).toBe('pending')
    expect(running.readyToClose).toBe(false)
    const settled = reduce(
      [user(0), started(0), opened(0), revised(5, done, { complete: true }), completed(6)],
      7
    )
    expect(settled.lanes[0]?.completion).toBe('settled')
    expect(settled.readyToClose).toBe(true)
    expect(settled.closedAt).toBeNull()
    expect(settled.state).toBe('idle')
  })

  it('does not become ready when a turn ends without the agent saying it is done', () => {
    const snapshot = reduce([user(0), started(0), opened(0), revised(5, done), completed(6)], 7)
    expect(snapshot.lanes[0]?.completion).toBe('none')
    expect(snapshot.readyToClose).toBe(false)
  })

  it('waits for every lane to finish its own plan', () => {
    const base: TaskMark[] = [
      user(0),
      started(0, 'claude'),
      started(0, 'codex'),
      opened(0),
      revised(2, done, { complete: true }),
      revised(2, [step('n1', 'done'), step('n2', 'active')], {
        agentId: 'codex',
        source: 'native',
      }),
      completed(3, 'claude'),
    ]
    const waitingOnCodex = reduce([...base, completed(4, 'codex')], 5)
    expect(waitingOnCodex.lanes.map((lane) => [lane.agentId, lane.finished])).toEqual([
      ['claude', true],
      ['codex', false],
    ])
    expect(waitingOnCodex.readyToClose).toBe(false)

    const finished = reduce(
      [
        ...base,
        revised(4, [step('n1', 'done'), step('n2', 'done')], {
          agentId: 'codex',
          source: 'native',
        }),
        completed(5, 'codex'),
      ],
      6
    )
    expect(finished.readyToClose).toBe(true)
  })

  it('keeps one lane’s completion when another lane reports later without one', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(2, done, { complete: true }),
        completed(3, 'claude'),
        revised(4, [step('x', 'done', 3)], { agentId: 'codex' }),
        completed(5, 'codex'),
      ],
      6
    )
    expect(snapshot.lanes.map((lane) => [lane.agentId, lane.completion])).toEqual([
      ['claude', 'settled'],
      ['codex', 'none'],
    ])
    expect(snapshot.readyToClose).toBe(true)
  })

  it('voids a completion from a turn that failed, even when another lane settles', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(2, done, { complete: true }),
        completed(3, 'claude', 'failed'),
        revised(4, [step('x', 'done', 3)], { agentId: 'codex', complete: true }),
        completed(5, 'codex'),
      ],
      6
    )
    expect(snapshot.lanes[0]?.completion).toBe('void')
    expect(snapshot.readyToClose).toBe(false)
  })

  it('withdraws a completion when the same lane reports again without one', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(2, done, { complete: true }),
        revised(3, [...done, step('c', 'pending', 5)]),
        completed(4),
      ],
      5
    )
    expect(snapshot.lanes[0]?.completion).toBe('none')
    expect(snapshot.readyToClose).toBe(false)
  })
})

describe('waiting', () => {
  const marks = [
    user(0),
    started(0),
    opened(0),
    revised(0, [step('a', 'active', 30)]),
    waitStarted(5, 'w1'),
    waitStarted(7, 'w2'),
    waitEnded(10, 'w1'),
    waitEnded(12, 'w2'),
  ]

  it('merges overlapping waits for one agent and freezes the countdown during them', () => {
    const snapshot = reduce(marks, 20)
    expect(minutes(snapshot.clocks.workingMs)).toBe(13)
    expect(minutes(snapshot.clocks.waitingMs)).toBe(7)
    expect(remaining(snapshot)).toBe(17)
  })

  it('says who is waited on while the wait lasts', () => {
    const during = reduce(marks.slice(0, 6), 8)
    expect(during.state).toBe('waiting')
    expect(during.waitingOn).toEqual([{ agentId: 'claude', kind: 'approval' }])
    expect(remaining(during)).toBe(25)
    expect(remaining(reduce(marks.slice(0, 7), 11))).toBe(25)
  })

  it('keeps log order when a turn and its approval share a millisecond', () => {
    const turn = when(1)
    const wait = { at: turn.at, seq: when(1).seq }
    const snapshot = reduce(
      [
        user(0),
        opened(0),
        revised(0, [step('a', 'pending', 30)]),
        { kind: 'waitStarted', ...wait, agentId: 'claude', waitId: 'w', wait: 'approval' },
        { kind: 'turnStarted', ...turn, agentId: 'claude' },
      ],
      5
    )
    expect(snapshot.state).toBe('waiting')
    expect(minutes(snapshot.clocks.waitingMs)).toBe(4)
    expect(minutes(snapshot.clocks.workingMs)).toBe(0)
  })

  it('never lets one agent waiting pause another agent that is working', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(0, [step('a', 'active', 20)]),
        waitStarted(2, 'w', 'claude'),
        waitEnded(8, 'w', 'claude'),
      ],
      10
    )
    expect(minutes(snapshot.clocks.workingMs)).toBe(10)
    expect(minutes(snapshot.clocks.waitingMs)).toBe(0)
    expect(remaining(snapshot)).toBe(16)
    expect(minutes(snapshot.lanes[0]?.workingMs)).toBe(4)
    const mid = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(0, [step('a', 'active', 20)]),
        waitStarted(2, 'w', 'claude'),
      ],
      5
    )
    expect(mid.state).toBe('working')
    expect(mid.working).toEqual(['codex'])
    expect(mid.waitingOn).toEqual([{ agentId: 'claude', kind: 'approval' }])
  })

  it('treats an explicit wait for the user as waiting until the next work message', () => {
    const base = [
      user(0),
      started(0),
      opened(0),
      revised(4, [step('a', 'active', 30)], { awaitingUser: true }),
      completed(5),
      user(6, false),
    ]
    const waiting = reduce(base, 6.5)
    expect(waiting.state).toBe('waiting')
    expect(waiting.waitingOn).toEqual([{ agentId: 'claude', kind: 'user' }])
    const answered = reduce([...base, user(7)], 9)
    expect(answered.state).toBe('idle')
    expect(minutes(answered.clocks.waitingMs)).toBe(2)
    expect(minutes(answered.clocks.idleMs)).toBe(2)
  })

  it('drops a wait for the user when the turn that declared it was stopped', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(4, [step('a', 'active', 30)], { awaitingUser: true }),
        completed(5, 'claude', 'interrupted', true),
      ],
      8
    )
    expect(snapshot.state).toBe('stopped')
    expect(snapshot.waitingOn).toEqual([])
    expect(minutes(snapshot.clocks.stoppedMs)).toBe(3)
  })

  it('lets a later failure of another agent outrank an older wait for the user', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(2, [step('a', 'active', 30)], { awaitingUser: true }),
        completed(3, 'claude'),
        completed(6, 'codex', 'failed'),
      ],
      8
    )
    expect(snapshot.state).toBe('failed')
    expect(snapshot.waitingOn).toEqual([{ agentId: 'claude', kind: 'user' }])
  })

  it('reads a gap between turns as idle, not as waiting', () => {
    const snapshot = reduce(
      [user(0), started(0), opened(0), revised(0, [step('a', 'active', 30)]), completed(5)],
      9
    )
    expect(snapshot.state).toBe('idle')
    expect(minutes(snapshot.clocks.waitingMs)).toBe(0)
    expect(minutes(snapshot.clocks.idleMs)).toBe(4)
  })
})

describe('a usage limit', () => {
  it('pauses the task until the agent starts again, and says when the limit resets', () => {
    const base: TaskMark[] = [
      user(0),
      started(0),
      opened(0),
      revised(0, [step('a', 'active', 30)]),
      { kind: 'paused', ...when(5), agentId: 'claude', resetsAt: time(60) },
      completed(5, 'claude', 'failed'),
    ]
    const paused = reduce(base, 20)
    expect(paused.state).toBe('paused')
    expect(paused.paused).toEqual([{ agentId: 'claude', resetsAt: time(60) }])
    expect(minutes(paused.clocks.pausedMs)).toBe(15)
    expect(remaining(paused)).toBe(25)

    const resumed = reduce([...base, started(61)], 70)
    expect(resumed.state).toBe('working')
    expect(resumed.paused).toEqual([])
    expect(remaining(resumed)).toBe(16)
  })
})

describe('the timing corrections', () => {
  const blocked = (
    minute: number,
    agentId: AgentId = 'claude',
    resetsAt: number | null = time(10)
  ): TaskMark => ({ kind: 'paused', ...when(minute), agentId, resetsAt })

  it('freezes a blocked agent at once, even before its turn ends, and keeps others working', () => {
    const alone = reduce(
      [user(0), started(0), opened(0), revised(0, [step('a', 'active', 30)]), blocked(5)],
      20
    )
    expect(alone.state).toBe('paused')
    expect(minutes(alone.clocks.pausedMs)).toBe(15)
    expect(remaining(alone)).toBe(25)

    const shared = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(0, [step('a', 'active', 30)]),
        blocked(5),
      ],
      20
    )
    expect(shared.state).toBe('working')
    expect(shared.working).toEqual(['codex'])
    expect(shared.paused).toEqual([{ agentId: 'claude', resetsAt: time(10) }])
    expect(remaining(shared)).toBe(25)
  })

  it('keeps the block after its reset time passes, until the agent actually works again', () => {
    const base = [user(0), started(0), opened(0), revised(0, [step('a', 'active', 30)]), blocked(5)]
    expect(reduce(base, 60).state).toBe('paused')
    const reported = reduce([...base, revised(61, [step('a', 'active', 30)])], 65)
    expect(reported.state).toBe('working')
    expect(remaining(reported)).toBe(21)
  })

  it('withdraws a settled completion when that agent starts more work', () => {
    const base: TaskMark[] = [
      user(0),
      started(0, 'claude'),
      started(0, 'codex'),
      opened(0),
      revised(2, [step('a', 'done', 5)], { complete: true }),
      completed(3, 'claude'),
      started(4, 'claude'),
    ]
    const failedAgain = reduce(
      [
        ...base,
        completed(5, 'claude', 'failed'),
        revised(6, [step('x', 'done', 5)], { agentId: 'codex', complete: true }),
        completed(7, 'codex'),
      ],
      8
    )
    expect(failedAgain.lanes[0]?.completion).toBe('none')
    expect(failedAgain.readyToClose).toBe(false)

    const settledAgain = reduce(
      [
        ...base,
        completed(5, 'claude'),
        revised(6, [step('x', 'done', 5)], { agentId: 'codex', complete: true }),
        completed(7, 'codex'),
      ],
      8
    )
    expect(settledAgain.readyToClose).toBe(true)
  })

  it('is never ready to close while the user is waited on or an agent is blocked', () => {
    const waiting = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(2, [step('a', 'done', 5)], { complete: true, awaitingUser: true }),
        completed(3),
      ],
      4
    )
    expect(waiting.lanes[0]?.completion).toBe('settled')
    expect(waiting.readyToClose).toBe(false)

    const blockedHelper = reduce(
      [
        user(0),
        started(0, 'claude'),
        started(0, 'codex'),
        opened(0),
        revised(2, [step('a', 'done', 5)], { complete: true }),
        completed(3, 'claude'),
        blocked(4, 'codex', null),
      ],
      5
    )
    expect(blockedHelper.readyToClose).toBe(false)
  })

  it('notices a new request that arrived after the task closed', () => {
    const closed: TaskMark[] = [
      user(0),
      started(0),
      opened(0),
      revised(0, [step('a', 'done', 5)], { complete: true }),
      completed(2),
      { kind: 'closed', ...when(3), taskId: TASK, reason: 'completed' },
    ]
    expect(reduce(closed, 4).requestAfterClose).toBe(false)
    expect(reduce([...closed, user(5, false)], 6).requestAfterClose).toBe(false)
    expect(reduce([...closed, user(5)], 6).requestAfterClose).toBe(true)
  })
})

describe('stops, crashes and shutdowns', () => {
  it('says stopped when the user interrupted, and failed when the turn failed', () => {
    const base = [user(0), started(0), opened(0), revised(0, [step('a', 'active', 30)])]
    const stopped = reduce([...base, completed(10, 'claude', 'interrupted', true)], 15)
    expect(stopped.state).toBe('stopped')
    expect(minutes(stopped.clocks.stoppedMs)).toBe(5)
    expect(reduce([...base, completed(10, 'claude', 'failed')], 15).state).toBe('failed')
  })

  it('never turns a crash gap into working time', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(1, 0),
        revised(1, [step('a', 'active', 60)]),
        { kind: 'evidence', ...when(10), agentId: 'claude' },
        { kind: 'sessionEnded', ...when(100), agentId: 'claude', reason: 'crashed' },
        {
          kind: 'sessionStarted',
          ...when(101),
          agentId: 'claude',
          sessionRef: 's1',
          model: null,
          resumed: true,
        },
        started(102),
      ],
      110
    )
    expect(minutes(snapshot.clocks.elapsedMs)).toBe(110)
    expect(minutes(snapshot.clocks.workingMs)).toBe(18)
    expect(minutes(snapshot.clocks.unknownMs)).toBe(92)
    expect(remaining(snapshot)).toBe(43)
    expect(snapshot.state).toBe('working')
  })

  it('reads the time after a quit in the middle of a turn as unknown', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'active', 30)]),
        { kind: 'sessionEnded', ...when(10), agentId: 'claude', reason: 'shutdown' },
      ],
      30
    )
    expect(snapshot.state).toBe('unknown')
    expect(minutes(snapshot.clocks.workingMs)).toBe(10)
    expect(minutes(snapshot.clocks.unknownMs)).toBe(20)
    expect(remaining(snapshot)).toBe(20)
  })

  it('closes a wait raised in a session that has since ended', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'active', 30)]),
        waitStarted(2, 'stale'),
        { kind: 'sessionEnded', ...when(3), agentId: 'claude', reason: 'crashed' },
        started(5),
      ],
      10
    )
    expect(snapshot.state).toBe('working')
    expect(snapshot.waitingOn).toEqual([])
  })
})

describe('the countdown', () => {
  it('shows time over the estimate instead of a negative remainder', () => {
    const over = reduce([user(0), started(0), opened(0), revised(0, [step('a', 'active', 10)])], 25)
    expect(remaining(over)).toBe(0)
    expect(minutes(over.forecast?.overrunMs)).toBe(15)
    expect(minutes(over.steps[0]?.overrunMs)).toBe(15)

    const stepOver = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'active', 10), step('b', 'pending', 5)]),
      ],
      25
    )
    expect(remaining(stepOver)).toBe(5)
    expect(minutes(stepOver.forecast?.overrunMs)).toBe(0)
    expect(minutes(stepOver.steps[0]?.overrunMs)).toBe(15)
  })

  it('does not extend the remainder without a new report', () => {
    const marks = [user(0), started(0), opened(0), revised(0, [step('a', 'active', 30)])]
    const values = [5, 10, 20, 40].map((now) => remaining(reduce(marks, now)))
    expect(values).toEqual([25, 20, 10, 0])
  })

  it('counts a parent or its sub-steps once, never both', () => {
    const split = reduce(
      [
        opened(0),
        revised(0, [
          step('p', 'pending', 30),
          step('c1', 'pending', 5, { parentId: 'p' }),
          step('c2', 'pending', 10, { parentId: 'p' }),
        ]),
      ],
      0
    )
    expect(minutes(split.forecast?.plannedMs)).toBe(15)
    expect(split.steps.find((view) => view.id === 'p')?.estimateMinutes).toBeNull()

    const whole = reduce(
      [
        opened(0),
        revised(0, [
          step('p', 'pending', 30),
          step('c1', 'pending', undefined, { parentId: 'p' }),
          step('c2', 'pending', undefined, { parentId: 'p' }),
        ]),
      ],
      0
    )
    expect(minutes(whole.forecast?.plannedMs)).toBe(30)
    expect(whole.forecast?.partial).toBe(false)
  })

  it('is sequential by default, and follows dependencies only in a parallel plan', () => {
    const steps = [
      step('a', 'pending', 10),
      step('b', 'pending', 10),
      step('c', 'pending', 5, { dependsOn: ['a', 'b'] }),
    ]
    expect(remaining(reduce([opened(0), revised(0, steps)], 0))).toBe(25)
    expect(remaining(reduce([opened(0), revised(0, steps, { parallel: true })], 0))).toBe(15)
  })

  it('adds the lanes of several agents one after another', () => {
    const snapshot = reduce(
      [
        opened(0),
        revised(0, [step('a', 'pending', 10)]),
        revised(0, [step('x', 'pending', 10)], { agentId: 'codex' }),
      ],
      0
    )
    expect(remaining(snapshot)).toBe(20)
    expect(snapshot.lanes.map((lane) => lane.agentId)).toEqual(['claude', 'codex'])
  })

  it('says the estimate is partial when some open steps have none', () => {
    const snapshot = reduce(
      [opened(0), revised(0, [step('a', 'pending', 10), step('b', 'pending')])],
      0
    )
    expect(snapshot.forecast?.partial).toBe(true)
    expect(remaining(snapshot)).toBe(10)
  })

  it('counts down a provider plan without estimates from the agent’s own pace', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('1', 'done'), step('2', 'active'), step('3', 'pending')], {
          source: 'native',
        }),
      ],
      5
    )
    expect(snapshot.forecast).toMatchObject({ paced: true, partial: false, confidence: 'rough' })
    expect(remaining(snapshot)).toBe(10)
    expect(minutes(snapshot.forecast?.lowMs)).toBe(6)
    expect(minutes(snapshot.forecast?.highMs)).toBe(20)
    expect(snapshot.progress).toEqual({ mainDone: 1, mainTotal: 3, leavesDone: 1, leavesTotal: 3 })
    expect(snapshot.current[0]?.step.id).toBe('2')
  })
})

describe('the pace fallback', () => {
  it('shows no estimate before the agent has finished a step', () => {
    const snapshot = reduce(
      [user(0), started(0), opened(0), revised(0, [step('a', 'active'), step('b', 'pending')])],
      5
    )
    expect(snapshot.forecast).toBeNull()
  })

  it('fills only a mixed plan’s unestimated steps, and keeps calibration to estimates', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'done'), step('c', 'active'), step('b', 'pending', 10)]),
      ],
      6
    )
    expect(snapshot.forecast).toMatchObject({ paced: true, partial: false })
    expect(remaining(snapshot)).toBe(16)
    expect(minutes(snapshot.forecast?.plannedMs)).toBe(10)
    expect(minutes(snapshot.forecast?.firstForecastMs)).toBe(10)
  })

  it('uses each agent’s own pace and adds the agents together', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        started(4, 'codex'),
        opened(0),
        revised(0, [step('a', 'done'), step('b', 'active')]),
        revised(0, [step('x', 'done'), step('y', 'active'), step('z', 'pending')], {
          agentId: 'codex',
        }),
      ],
      10
    )
    expect(snapshot.forecast?.paced).toBe(true)
    expect(remaining(snapshot)).toBe(22)
  })

  it('is not used when every open step has an agent estimate', () => {
    const snapshot = reduce(
      [user(0), started(0), opened(0), revised(0, [step('a', 'done'), step('b', 'active', 10)])],
      4
    )
    expect(snapshot.forecast?.paced).toBe(false)
  })
})

describe('nested steps', () => {
  const nested = (labelled: boolean): Step[] => {
    const label = (text: string) => (labelled ? { label: text } : {})
    return [
      step('s1', 'done', undefined, label('1')),
      step('s2', 'done', undefined, label('2')),
      step('s3', 'done', undefined, label('3')),
      step('s4', 'active', undefined, label('4')),
      step('s41', 'done', undefined, { parentId: 's4', ...label('4.1') }),
      step('s42', 'active', undefined, { parentId: 's4', ...label('4.2') }),
      step('s43', 'pending', undefined, { parentId: 's4', ...label('4.3') }),
      step('s5', 'pending', undefined, label('5')),
      step('s6', 'pending', undefined, label('6')),
      step('s7', 'pending', undefined, label('7')),
    ]
  }

  it('counts main steps and sub-steps apart, and names the current one', () => {
    const snapshot = reduce([opened(0), revised(0, nested(true))], 0)
    expect(snapshot.progress).toEqual({ mainDone: 3, mainTotal: 7, leavesDone: 4, leavesTotal: 9 })
    const current = snapshot.current[0]
    expect(current?.step.label).toBe('4.2')
    expect(current?.main.label).toBe('4')
    expect(current?.mainIndex).toBe(4)
    expect(current?.mainTotal).toBe(7)
    expect(current?.substeps).toEqual({ done: 1, total: 3 })
  })

  it('numbers steps by position when the agent gave no labels', () => {
    const snapshot = reduce([opened(0), revised(0, nested(false))], 0)
    expect(snapshot.current[0]?.step.label).toBe('4.2')
  })

  it('derives a parent’s status from its sub-steps', () => {
    const snapshot = reduce(
      [
        opened(0),
        revised(0, [
          step('p', 'pending'),
          step('c1', 'done', undefined, { parentId: 'p' }),
          step('c2', 'skipped', undefined, { parentId: 'p' }),
        ]),
      ],
      0
    )
    expect(snapshot.steps.find((view) => view.id === 'p')?.status).toBe('done')
  })
})

describe('calibration', () => {
  const sessionWith = (model: string | null): TaskMark => ({
    kind: 'sessionStarted',
    ...when(-1),
    agentId: 'claude',
    sessionRef: 's1',
    model,
    resumed: false,
  })

  const history = (
    count: number,
    samples: { estimateMinutes: number; actualMinutes: number }[],
    forecast: { first: number; final: number } = { first: 30, final: 30 }
  ): TaskHistoryEntry[] =>
    Array.from({ length: count }, (_, index) => ({
      taskId: `h${String(index)}`,
      outcome: {
        startedAt: 0,
        elapsedMs: 0,
        workingMs: 0,
        lanes: [
          {
            agentId: 'claude' as const,
            model: 'm1',
            firstForecastMinutes: forecast.first,
            finalForecastMinutes: forecast.final,
            workingMs: 0,
            samples,
          },
        ],
      },
    }))

  const slow = [1, 2, 3].map(() => ({ estimateMinutes: 10, actualMinutes: 20 }))

  it('uses comparable history once there is enough of it', () => {
    const snapshot = reduce(
      [sessionWith('m1'), opened(0), revised(0, [step('a', 'pending', 10)])],
      0,
      history(5, slow)
    )
    expect(snapshot.forecast?.confidence).toBe('calibrated')
    expect(remaining(snapshot)).toBeCloseTo(10 * 2 ** 0.75, 6)
  })

  it('stays rough, with the raw guess, for an unknown model or sparse history', () => {
    const unknown = reduce(
      [sessionWith(null), opened(0), revised(0, [step('a', 'pending', 10)])],
      0,
      history(5, slow)
    )
    expect(unknown.forecast?.confidence).toBe('rough')
    expect(remaining(unknown)).toBe(10)
    expect(minutes(unknown.forecast?.lowMs)).toBeCloseTo(6, 6)
    expect(minutes(unknown.forecast?.highMs)).toBeCloseTo(20, 6)

    const sparse = reduce(
      [sessionWith('m1'), opened(0), revised(0, [step('a', 'pending', 10)])],
      0,
      history(2, slow)
    )
    expect(sparse.forecast?.confidence).toBe('rough')
    expect(remaining(sparse)).toBe(10)
  })

  it('learns from this task’s own finished steps, shrunk toward the raw guess', () => {
    const snapshot = reduce(
      [
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'active', 10), step('b', 'pending', 10)]),
        revised(20, [step('a', 'done', 10), step('b', 'active', 10)]),
      ],
      20
    )
    expect(snapshot.lanes[0]?.samples).toEqual([{ estimateMinutes: 10, actualMinutes: 20 }])
    expect(remaining(snapshot)).toBeCloseTo(10 * 2 ** (1 / 6), 6)
    expect(snapshot.forecast?.confidence).toBe('rough')
  })

  it('widens only the upper end for scope that usually grows', () => {
    const snapshot = reduce(
      [sessionWith('m1'), opened(0), revised(0, [step('a', 'pending', 10)])],
      0,
      history(
        5,
        [1, 2, 3].map(() => ({ estimateMinutes: 10, actualMinutes: 10 })),
        { first: 10, final: 20 }
      )
    )
    expect(remaining(snapshot)).toBeCloseTo(10, 6)
    expect(minutes(snapshot.forecast?.lowMs)).toBeCloseTo(10, 6)
    expect(minutes(snapshot.forecast?.highMs)).toBeCloseTo(20, 6)
  })

  it('never calibrates a task against its own outcome', () => {
    const own: TaskHistoryEntry[] = history(5, slow).map((entry) => ({ ...entry, taskId: TASK }))
    const snapshot = reduce(
      [sessionWith('m1'), opened(0), revised(0, [step('a', 'pending', 10)])],
      0,
      own
    )
    expect(snapshot.forecast?.confidence).toBe('rough')
  })

  it('records the first forecast, the final one and the speed samples at close', () => {
    const snapshot = reduce(
      [
        sessionWith('m1'),
        user(0),
        started(0),
        opened(0),
        revised(0, [step('a', 'active', 10)]),
        revised(15, [step('a', 'done', 10), step('b', 'active', 20)]),
      ],
      20
    )
    expect(taskOutcomeOf(snapshot).lanes).toEqual([
      {
        agentId: 'claude',
        model: 'm1',
        firstForecastMinutes: 10,
        finalForecastMinutes: 30,
        workingMs: 20 * MINUTE,
        samples: [{ estimateMinutes: 10, actualMinutes: 15 }],
      },
    ])
  })
})

describe('reading the log, live and on reload', () => {
  let seq = 1_000
  const stored = (
    type: string,
    payload: Record<string, unknown>,
    actor: StoredEvent['actor'],
    minute: number
  ): StoredEvent =>
    ({
      seq: ++seq,
      id: `e${String(seq)}`,
      conversationId: 'c',
      actor,
      type,
      payload: { type, ...payload },
      createdAt: time(minute),
      schemaVersion: 1,
    }) as unknown as StoredEvent

  const steps = [{ id: 'a', title: 'A', status: 'active', estimateMinutes: 60 }]

  const log = (): StoredEvent[] => [
    stored('user.message', { text: 'go' }, 'user', 0),
    stored('turn.started', { turnRef: 't1' }, 'claude', 0),
    stored(
      'task.opened',
      { taskId: TASK, originEventId: 'e1001', startedAt: time(0) },
      'claude',
      1
    ),
    stored(
      'task.revised',
      { taskId: TASK, agentId: 'claude', revision: 1, source: 'chorus', steps },
      'claude',
      1
    ),
    stored('approval.requested', { approvalId: 'ap1', kind: 'command' }, 'claude', 2),
    stored('approval.requested', { approvalId: 'ap2', kind: 'command' }, 'claude', 3),
    stored('approval.decided', { approvalId: 'ap1', outcome: 'allow' }, 'claude', 4),
    stored('approval.decided', { approvalId: 'ap2', outcome: 'allow' }, 'claude', 5),
    stored(
      'approval.requested',
      { approvalId: 'side', kind: 'command', mode: 'discussion' },
      'claude',
      6
    ),
    stored('tool.started', { itemRef: 'read-1', name: 'Read' }, 'claude', 8),
    stored('agent.message.delta', { itemRef: 'discussion:x:claude:1:m', text: 'hi' }, 'claude', 9),
    stored(
      'session.ended',
      { agentId: 'claude', sessionRef: 's1', reason: 'crashed' },
      'system',
      50
    ),
  ]

  it('reaches the same clocks whether the events arrived live or were restored', () => {
    const events = log()
    const live = appendTaskMarks({ marks: [], history: [] }, events)
    const canonical = events.filter((event) =>
      [
        'user.message',
        'turn.started',
        'task.opened',
        'task.revised',
        'approval.requested',
        'approval.decided',
        'session.ended',
      ].includes(event.type)
    )
    const restored: TaskBundle = {
      marks: taskMarksFromRecords({
        events: canonical,
        evidence: events.filter((event) => event.type === 'tool.started'),
      }),
      history: [],
    }
    const now = time(60)
    const fromLive = reduceTask(live, now)
    const fromRestore = reduceTask(restored, now)
    expect(fromLive?.clocks).toEqual(fromRestore?.clocks)
    expect(fromLive?.forecast).toEqual(fromRestore?.forecast)
    expect(minutes(fromRestore?.clocks.workingMs)).toBe(5)
    expect(minutes(fromRestore?.clocks.waitingMs)).toBe(3)
    expect(minutes(fromRestore?.clocks.unknownMs)).toBe(52)
  })

  it('never lets a discussion approval pause the work clock', () => {
    const events = [
      stored('user.message', { text: 'go' }, 'user', 0),
      stored('turn.started', { turnRef: 't1' }, 'claude', 0),
      stored('task.opened', { taskId: TASK, originEventId: 'x', startedAt: time(0) }, 'claude', 0),
      stored(
        'approval.requested',
        { approvalId: 'side', kind: 'command', mode: 'discussion' },
        'claude',
        1
      ),
      stored('approval.decided', { approvalId: 'side', mode: 'discussion' }, 'claude', 4),
      stored('approval.withdrawn', { approvalId: 'side', mode: 'discussion' }, 'claude', 4),
    ]
    const live = reduceTask(appendTaskMarks({ marks: [], history: [] }, events), time(5))
    const restored = reduceTask(
      { marks: taskMarksFromRecords({ events, evidence: [] }), history: [] },
      time(5)
    )
    for (const snapshot of [live, restored]) {
      expect(snapshot?.state).toBe('working')
      expect(minutes(snapshot?.clocks.workingMs)).toBe(5)
      expect(minutes(snapshot?.clocks.waitingMs)).toBe(0)
    }
  })

  it('keeps one piece of live evidence per agent and session, and drops non-work events', () => {
    const delta = (minute: number, itemRef = 'm') =>
      stored('agent.message.delta', { itemRef, text: 'x' }, 'claude', minute)
    const first = appendTaskMarks({ marks: [], history: [] }, [delta(1), delta(2), delta(3)])
    expect(first.marks.map((mark) => [mark.kind, mark.at])).toEqual([['evidence', time(3)]])
    const ended = stored(
      'session.ended',
      { agentId: 'claude', sessionRef: 's', reason: 'closed' },
      'system',
      4
    )
    const late = delta(5)
    const crossed = appendTaskMarks(first, [ended, late, delta(6, 'live-question:q:claude:m')])
    expect(crossed.marks.map((mark) => [mark.kind, mark.at])).toEqual([
      ['evidence', time(3)],
      ['sessionEnded', time(4)],
      ['evidence', time(5)],
    ])
    expect(appendTaskMarks(crossed, [late])).toBe(crossed)
  })

  it('reads nothing it cannot validate, and nothing from a discussion', () => {
    expect(
      taskMarkOf(stored('task.revised', { taskId: TASK, agentId: 'claude' }, 'claude', 1))
    ).toBeNull()
    expect(taskMarkOf(stored('turn.started', { turnRef: 't' }, 'system', 1))).toBeNull()
    expect(
      taskMarkOf(
        stored('userinput.requested', { userInputId: 'q', mode: 'discussion' }, 'claude', 1)
      )
    ).toBeNull()
    expect(
      taskMarkOf(stored('agent.message.completed', { mode: 'discussion', text: 'x' }, 'claude', 1))
    ).toBeNull()
    expect(taskMarkOf(stored('user.message', { text: 'x', live: true }, 'user', 1))).toMatchObject({
      kind: 'user',
      work: false,
    })
    expect(taskMarkOf(stored('usage.blocked', { resetsAt: null }, 'claude', 1))).toMatchObject({
      kind: 'paused',
      resetsAt: null,
    })
  })
})
