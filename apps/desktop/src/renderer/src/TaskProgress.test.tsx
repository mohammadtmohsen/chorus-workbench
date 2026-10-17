import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptAssignment } from '../../shared/ipc.js'
import type { TaskBundle, TaskMark } from '../../shared/task-progress.js'
import type { LiveSource } from './task-strip.js'
import { TaskProgress } from './TaskProgress.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const NOW = Date.now()
const QUIET: LiveSource = {
  working: [],
  workingSince: {},
  turns: {},
  replies: [],
  operations: [],
  evidenceAt: {},
  handoffs: [],
  approvals: [],
  questions: [],
  activity: {},
}

const bundle = (taskId: string, closed: boolean): TaskBundle => {
  const marks: TaskMark[] = [
    { kind: 'user', at: NOW - 60_000, seq: 1, eventId: 'e1', work: true },
    {
      kind: 'opened',
      at: NOW - 59_000,
      seq: 2,
      taskId,
      originEventId: 'e1',
      startedAt: NOW - 60_000,
    },
    {
      kind: 'revised',
      at: NOW - 58_000,
      seq: 3,
      taskId,
      agentId: 'claude',
      revision: 1,
      source: 'chorus',
      steps: [{ id: 'a', title: 'Build B', status: 'active', estimateMinutes: 10 }],
    },
  ]
  if (closed) {
    marks.push({ kind: 'closed', at: NOW - 1_000, seq: 4, taskId, reason: 'completed' })
  }
  return { marks, history: [] }
}

const render = (assignment: TranscriptAssignment, closed = false): string =>
  renderToStaticMarkup(
    <TaskProgress
      conversationId="child-1"
      task={bundle('task-b', closed)}
      assignment={assignment}
      syncing={false}
      working={[]}
      workingSince={{}}
      live={QUIET}
      onError={() => undefined}
    />
  )

describe('marking the forwarded work on the strip', () => {
  it('offers the mark on an open task in a forwarded conversation', () => {
    const markup = render({ linked: true, boundTaskId: null })
    expect(markup).toContain('task-progress-bind')
    expect(markup).toContain('taskProgress.forwarded.mark')
    expect(markup).toContain('taskProgress.close')
    expect(markup).not.toContain('taskProgress.forwarded.bound<')
  })

  it('still offers it once the shown task has closed', () => {
    const markup = render({ linked: true, boundTaskId: null }, true)
    expect(markup).toContain('task-progress-bind')
    expect(markup).not.toContain('taskProgress.close<')
  })

  it('offers it to correct a marking that names another task', () => {
    const markup = render({ linked: true, boundTaskId: 'task-a' })
    expect(markup).toContain('task-progress-bind')
    expect(markup).not.toContain('taskProgress.forwarded.bound<')
  })

  it('shows the marker instead of the action once the shown task is the marked one', () => {
    const markup = render({ linked: true, boundTaskId: 'task-b' })
    expect(markup).toContain('taskProgress.forwarded.bound<')
    expect(markup).not.toContain('task-progress-bind')
  })

  it('offers neither in a conversation that was not forwarded', () => {
    for (const assignment of [
      { linked: false, boundTaskId: null },
      { linked: false, boundTaskId: 'task-b' },
    ]) {
      const markup = render(assignment)
      expect(markup).not.toContain('taskProgress.forwarded')
      expect(markup).not.toContain('task-progress-bind')
    }
  })
})

describe('a forecast filled from pace', () => {
  it('says it is based on pace beside the rough marker', () => {
    const marks: TaskMark[] = [
      { kind: 'user', at: NOW - 60_000, seq: 1, eventId: 'e1', work: true },
      { kind: 'turnStarted', at: NOW - 60_000, seq: 2, agentId: 'claude' },
      {
        kind: 'opened',
        at: NOW - 59_000,
        seq: 3,
        taskId: 'task-p',
        originEventId: 'e1',
        startedAt: NOW - 60_000,
      },
      {
        kind: 'revised',
        at: NOW - 58_000,
        seq: 4,
        taskId: 'task-p',
        agentId: 'claude',
        revision: 1,
        source: 'chorus',
        steps: [
          { id: 'a', title: 'Read', status: 'done' },
          { id: 'b', title: 'Write', status: 'active' },
        ],
      },
    ]
    const markup = renderToStaticMarkup(
      <TaskProgress
        conversationId="c1"
        task={{ marks, history: [] }}
        assignment={{ linked: false, boundTaskId: null }}
        syncing={false}
        working={['claude']}
        workingSince={{ claude: NOW - 60_000 }}
        live={QUIET}
        onError={() => undefined}
      />
    )
    expect(markup).toContain('taskProgress.paced<')
    expect(markup).toContain('title="taskProgress.pacedHint"')
    expect(markup).toContain('taskProgress.rough<')
  })
})
