import { describe, expect, it } from 'vitest'
import type { TranscriptEvent } from '../../shared/ipc.js'
import { reduceTask, type TaskBundle } from '../../shared/task-progress.js'
import {
  applyTranscriptState,
  EMPTY_VIEW,
  mergeTaskState,
  NO_ASSIGNMENT,
  prependEvents,
  reduceEvents,
  reduceTranscriptRead,
  type TranscriptView,
} from './transcript.js'

const MINUTE = 60_000
const T0 = 1_700_000_000_000
const time = (minutes: number): number => T0 + minutes * MINUTE

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  actor: TranscriptEvent['actor'] = 'claude',
  minutes = seq
): TranscriptEvent => ({
  seq,
  id: `e${String(seq)}`,
  conversationId: 'c',
  actor,
  type,
  payload: { type, ...payload },
  createdAt: time(minutes),
})

const opened = (seq: number, taskId: string, origin: number): TranscriptEvent =>
  event(seq, 'task.opened', {
    taskId,
    originEventId: `e${String(origin)}`,
    startedAt: time(origin),
  })

const revised = (seq: number, taskId: string, estimate = 30): TranscriptEvent =>
  event(seq, 'task.revised', {
    taskId,
    agentId: 'claude',
    revision: 1,
    source: 'chorus',
    steps: [{ id: 'a', title: 'A', status: 'active', estimateMinutes: estimate }],
  })

const STATE = {
  approvals: [],
  questions: [],
  working: [],
  usageByActor: {},
}

const fresh = (taskId: string, origin: number): TaskBundle => ({
  marks: [
    { kind: 'user', at: time(origin), seq: origin, eventId: `e${String(origin)}`, work: true },
    { kind: 'turnStarted', at: time(origin), seq: origin + 1, agentId: 'claude' },
    {
      kind: 'opened',
      at: time(origin + 2),
      seq: origin + 2,
      taskId,
      originEventId: `e${String(origin)}`,
      startedAt: time(origin),
    },
  ],
  history: [],
})

const behind = (view: TranscriptView): boolean => view.taskEpoch !== view.taskSyncedEpoch

describe('a task first seen live', () => {
  it('starts a bundle from task.opened, and asks for the rest of it', () => {
    const view = reduceEvents(EMPTY_VIEW, [
      event(1, 'user.message', { text: 'go' }, 'user'),
      event(2, 'turn.started', { turnRef: 't' }),
      opened(3, 'task-1', 1),
    ])
    expect(view.task?.marks.map((mark) => mark.kind)).toEqual(['user', 'turnStarted', 'opened'])
    expect(behind(view)).toBe(true)

    const synced = mergeTaskState(view, fresh('task-1', 1), view.taskEpoch, 3)
    expect(behind(synced)).toBe(false)
    expect(synced.task?.marks.map((mark) => mark.seq)).toEqual([1, 2, 3])
    const snapshot = synced.task === null ? null : reduceTask(synced.task, time(10))
    expect(snapshot?.state).toBe('working')
    expect(snapshot?.startedAt).toBe(time(1))
  })

  it('folds nothing into a task before one exists', () => {
    const view = reduceEvents(EMPTY_VIEW, [event(1, 'turn.started', { turnRef: 't' })])
    expect(view.task).toBeNull()
    expect(behind(view)).toBe(false)
  })
})

describe('the first read and the pushes held during it', () => {
  it('takes the queried bundle, then folds held pushes once each', () => {
    const read = reduceTranscriptRead(EMPTY_VIEW, [], 3)
    const withState = applyTranscriptState(read, { ...STATE, task: fresh('task-1', 1) })
    expect(behind(withState)).toBe(false)
    const next = reduceEvents(withState, [opened(3, 'task-1', 1), revised(4, 'task-1')])
    expect(next.task?.marks.map((mark) => mark.seq)).toEqual([1, 2, 3, 4])
    expect(behind(next)).toBe(false)
  })

  it('carries a turn start the page did not reach', () => {
    const view = applyTranscriptState(EMPTY_VIEW, {
      ...STATE,
      working: ['claude'],
      workingSince: { claude: time(-120) },
    })
    expect(view.workingSince).toEqual({ claude: time(-120) })
    const ended = reduceEvents(view, [event(500, 'turn.completed', { status: 'completed' })])
    expect(ended.workingSince).toEqual({})
    const again = reduceEvents(ended, [event(501, 'turn.started', { turnRef: 't2' })])
    expect(again.workingSince).toEqual({ claude: time(501) })
  })
})

describe('a new task replacing an old one', () => {
  it('asks again, and keeps the old task’s marks out of the merged bundle', () => {
    const first = applyTranscriptState(EMPTY_VIEW, { ...STATE, task: fresh('task-1', 1) })
    const ended = reduceEvents(first, [
      revised(4, 'task-1'),
      event(5, 'task.closed', { taskId: 'task-1', reason: 'completed' }),
    ])
    const closing = reduceEvents(ended, [
      event(6, 'turn.started', { turnRef: 'late' }),
      event(20, 'user.message', { text: 'next' }, 'user'),
    ])
    expect(closing.task?.marks.map((mark) => mark.kind)).toEqual([
      'user',
      'turnStarted',
      'opened',
      'revised',
      'closed',
      'user',
    ])
    const replaced = reduceEvents(closing, [opened(22, 'task-2', 20)])
    expect(behind(replaced)).toBe(true)
    const merged = mergeTaskState(replaced, fresh('task-2', 20), replaced.taskEpoch, 22)
    expect(merged.task?.marks.every((mark) => mark.seq >= 20)).toBe(true)
    const snapshot = merged.task === null ? null : reduceTask(merged.task, time(30))
    expect(snapshot?.taskId).toBe('task-2')
  })
})

describe('coming back to a carried pane', () => {
  it('rebuilds the task from a full read even when its start is before the page', () => {
    const carried: TranscriptView = {
      ...EMPTY_VIEW,
      lastSeq: 900,
      firstSeq: 500,
      task: { marks: [], history: [] },
    }
    const caught = reduceTranscriptRead(
      carried,
      [event(901, 'turn.started', { turnRef: 't' }), event(902, 'tool.started', { itemRef: 'r' })],
      902
    )
    const merged = mergeTaskState(caught, fresh('task-1', 10), caught.taskEpoch, 900)
    const snapshot = merged.task === null ? null : reduceTask(merged.task, time(1000))
    expect(snapshot?.startedAt).toBe(time(10))
    expect(snapshot?.taskId).toBe('task-1')
    expect(merged.task?.marks.some((mark) => mark.seq === 901)).toBe(true)
  })

  it('applies a full read once even if it races a push that carries the same event', () => {
    const view = applyTranscriptState(EMPTY_VIEW, { ...STATE, task: fresh('task-1', 1) })
    const pushed = reduceEvents(view, [revised(4, 'task-1')])
    const again = mergeTaskState(
      pushed,
      { ...fresh('task-1', 1), marks: [...fresh('task-1', 1).marks] },
      pushed.taskEpoch,
      3
    )
    expect(again.task?.marks.filter((mark) => mark.seq === 4)).toHaveLength(1)
  })
})

describe('merging a full read at its watermark', () => {
  const snapshotAt = (taskId: string): TaskBundle => ({
    marks: [
      {
        kind: 'sessionStarted',
        at: time(1),
        seq: 1,
        agentId: 'claude',
        sessionRef: 's1',
        model: null,
        resumed: false,
      },
      { kind: 'user', at: time(30), seq: 30, eventId: 'e30', work: true },
      { kind: 'turnStarted', at: time(30), seq: 31, agentId: 'claude' },
      {
        kind: 'opened',
        at: time(32),
        seq: 32,
        taskId,
        originEventId: 'e30',
        startedAt: time(30),
      },
      { kind: 'evidence', at: time(34), seq: 34, agentId: 'claude' },
    ],
    history: [],
  })

  const carried = (): TranscriptView => ({
    ...EMPTY_VIEW,
    lastSeq: 40,
    task: {
      marks: [
        {
          kind: 'opened',
          at: time(10),
          seq: 10,
          taskId: 'old',
          originEventId: 'e9',
          startedAt: time(9),
        },
        {
          kind: 'revised',
          at: time(11),
          seq: 11,
          taskId: 'old',
          agentId: 'claude',
          revision: 1,
          source: 'chorus',
          steps: [{ id: 'z', title: 'Z', status: 'done', estimateMinutes: 5 }],
          complete: true,
        },
        { kind: 'closed', at: time(12), seq: 12, taskId: 'old', reason: 'completed' },
        {
          kind: 'waitStarted',
          at: time(33),
          seq: 33,
          agentId: 'claude',
          waitId: 'auto',
          wait: 'approval',
        },
        { kind: 'waitEnded', at: time(33), seq: 35, agentId: 'claude', waitId: 'auto' },
        {
          kind: 'opened',
          at: time(32),
          seq: 32,
          taskId: 'new',
          originEventId: 'e30',
          startedAt: time(30),
        },
        {
          kind: 'revised',
          at: time(38),
          seq: 38,
          taskId: 'new',
          agentId: 'claude',
          revision: 1,
          source: 'chorus',
          steps: [{ id: 'a', title: 'A', status: 'active', estimateMinutes: 20 }],
        },
      ],
      history: [],
    },
  })

  it('drops older task records and policy waits the read left out, behind an old session', () => {
    const merged = mergeTaskState(carried(), snapshotAt('new'), 0, 36)
    const seqs = merged.task?.marks.map((mark) => mark.seq)
    expect(seqs).toEqual([1, 30, 31, 32, 34, 38])
    expect(merged.task?.marks.some((mark) => 'taskId' in mark && mark.taskId === 'old')).toBe(false)
  })

  it('keeps what a push delivered after the read, whatever it is', () => {
    const view = carried()
    const raced: TranscriptView = {
      ...view,
      task: {
        marks: [
          ...(view.task?.marks ?? []),
          { kind: 'closed', at: time(41), seq: 41, taskId: 'new', reason: 'abandoned' },
        ],
        history: [],
      },
    }
    const merged = mergeTaskState(raced, snapshotAt('new'), 0, 36)
    const snapshot = merged.task === null ? null : reduceTask(merged.task, time(50))
    expect(snapshot?.state).toBe('closed')
    expect(merged.task?.marks.at(-1)?.seq).toBe(41)
  })

  it('keeps the read’s own last work evidence, so a later crash ends work there', () => {
    const view = carried()
    const before: TranscriptView = {
      ...view,
      task: { marks: (view.task?.marks ?? []).filter((mark) => mark.seq <= 36), history: [] },
    }
    const merged = mergeTaskState(before, snapshotAt('new'), 0, 36)
    const crash = { agentId: 'claude', sessionRef: 's1', reason: 'crashed' }
    const crashed = reduceEvents(merged, [event(60, 'session.ended', crash, 'system')])
    const snapshot = crashed.task === null ? null : reduceTask(crashed.task, time(70))
    expect(snapshot?.clocks.workingMs).toBe(4 * MINUTE)
    expect(snapshot?.clocks.unknownMs).toBe(36 * MINUTE)
    expect(snapshot?.state).toBe('unknown')
  })

  it('keeps only newer live marks when the read found no task at all', () => {
    expect(mergeTaskState(carried(), null, 0, 40).task).toBeNull()
    const merged = mergeTaskState(carried(), null, 0, 37)
    expect(merged.task?.marks.map((mark) => mark.seq)).toEqual([38])
  })
})

describe('turn liveness in the view', () => {
  it('ends a running turn when its session ends, and starts again with a newer turn', () => {
    const running = reduceEvents(EMPTY_VIEW, [event(1, 'turn.started', { turnRef: 't1' })])
    expect(running.working).toEqual(['claude'])
    const shutdown = { agentId: 'claude', sessionRef: 's1', reason: 'shutdown' }
    const ended = reduceEvents(running, [event(2, 'session.ended', shutdown, 'system')])
    expect(ended.working).toEqual([])
    expect(ended.workingSince).toEqual({})
    expect(ended.busy).toBe(false)
    const again = reduceEvents(ended, [event(3, 'turn.started', { turnRef: 't2' })])
    expect(again.working).toEqual(['claude'])
    expect(again.workingSince).toEqual({ claude: time(3) })
  })
})

describe('the forwarded-work marking in the view', () => {
  const marked = (seq: number, taskId: string, previousTaskId: string | null = null) =>
    event(seq, 'assignment.bound', { taskId, previousTaskId }, 'user')
  const linked = { linked: true, boundTaskId: null }

  it('starts unlinked, and takes the queried marking from the transcript state', () => {
    expect(EMPTY_VIEW.assignment).toEqual(NO_ASSIGNMENT)
    expect(NO_ASSIGNMENT).toEqual({ linked: false, boundTaskId: null })
    const view = applyTranscriptState(EMPTY_VIEW, {
      ...STATE,
      assignment: { linked: true, boundTaskId: 'task-1' },
    })
    expect(view.assignment).toEqual({ linked: true, boundTaskId: 'task-1' })
  })

  it('keeps what it holds when an older main sends no marking', () => {
    const held = applyTranscriptState(EMPTY_VIEW, { ...STATE, assignment: linked })
    expect(applyTranscriptState(held, STATE).assignment).toEqual(linked)
    expect(applyTranscriptState(EMPTY_VIEW, STATE).assignment).toEqual(NO_ASSIGNMENT)
  })

  it('folds a pushed marking and a later correction, and keeps it through unrelated pushes', () => {
    const start = applyTranscriptState(EMPTY_VIEW, { ...STATE, assignment: linked })
    const first = reduceEvents(start, [marked(10, 'task-1')])
    expect(first.assignment).toEqual({ linked: true, boundTaskId: 'task-1' })
    const busy = reduceEvents(first, [
      event(11, 'turn.started', { turnRef: 't' }),
      event(12, 'agent.message.completed', { itemRef: 'm', text: 'hi' }),
      event(13, 'turn.completed', { turnRef: 't', status: 'completed' }),
    ])
    expect(busy.assignment).toEqual({ linked: true, boundTaskId: 'task-1' })
    const corrected = reduceEvents(busy, [marked(14, 'task-2', 'task-1')])
    expect(corrected.assignment).toEqual({ linked: true, boundTaskId: 'task-2' })
  })

  it('never links a conversation from a pushed record alone', () => {
    const stray = reduceEvents(EMPTY_VIEW, [marked(3, 'task-1')])
    expect(stray.assignment.linked).toBe(false)
  })

  it('applies the snapshot before held pushes, so an old snapshot cannot erase a new mark', () => {
    const held = [marked(41, 'task-2', 'task-1')]
    const read = reduceTranscriptRead(EMPTY_VIEW, [], 40)
    const withState = applyTranscriptState(read, {
      ...STATE,
      assignment: { linked: true, boundTaskId: 'task-1' },
    })
    expect(reduceEvents(withState, held).assignment).toEqual({
      linked: true,
      boundTaskId: 'task-2',
    })

    const already = reduceTranscriptRead(EMPTY_VIEW, [], 41)
    const current = applyTranscriptState(already, {
      ...STATE,
      assignment: { linked: true, boundTaskId: 'task-2' },
    })
    expect(reduceEvents(current, [marked(41, 'task-1')]).assignment).toEqual({
      linked: true,
      boundTaskId: 'task-2',
    })
  })

  it('survives a remount carry, and an earlier page never changes it', () => {
    const view = reduceEvents(applyTranscriptState(EMPTY_VIEW, { ...STATE, assignment: linked }), [
      marked(50, 'task-3'),
    ])
    const remounted: TranscriptView = { ...EMPTY_VIEW, ...view }
    expect(remounted.assignment).toEqual({ linked: true, boundTaskId: 'task-3' })
    const { assignment: _dropped, ...olderCarry } = view
    const fromOlderBuild: TranscriptView = { ...EMPTY_VIEW, ...olderCarry }
    expect(fromOlderBuild.assignment).toEqual(NO_ASSIGNMENT)
    const paged = prependEvents(view, [
      marked(5, 'task-0'),
      event(6, 'user.message', { text: 'x' }, 'user'),
    ])
    expect(paged.assignment).toEqual({ linked: true, boundTaskId: 'task-3' })
  })
})
