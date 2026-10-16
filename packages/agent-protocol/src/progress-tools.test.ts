import { describe, expect, it } from 'vitest'
import {
  leafPrerequisites,
  nativeProgressSteps,
  NO_PROGRESS_REPORTER,
  PROGRESS_INSTRUCTION,
  PROGRESS_LIMITS,
  PROGRESS_TOOL_INPUT_SCHEMA,
  runProgressTool,
  stepLeaves,
  validateProgressReport,
  type ProgressReport,
} from './progress-tools.js'

const plan = {
  steps: [
    {
      id: 'research',
      label: '1',
      title: 'Read the event types',
      status: 'done',
      estimateMinutes: 5,
    },
    { id: 'store', label: '2', title: 'Persist the task', status: 'active' },
    {
      id: 'store.schema',
      label: '2.a',
      parentId: 'store',
      title: 'Schema',
      status: 'done',
      estimateMinutes: 4,
    },
    {
      id: 'store.query',
      label: '2.b',
      parentId: 'store',
      title: 'Query',
      status: 'pending',
      estimateMinutes: 6,
    },
    {
      id: 'ui',
      label: '3',
      title: 'Status strip',
      status: 'pending',
      estimateMinutes: 20,
      dependsOn: ['store'],
    },
  ],
  reason: 'Split the store work',
} as const

const issuesOf = (args: unknown): string => {
  const result = validateProgressReport(args)
  return result.ok ? '' : result.issues.join(' ')
}

const one = (step: Record<string, unknown>): string =>
  issuesOf({ steps: [{ id: 'a', title: 'A', status: 'pending', ...step }] })

describe('validateProgressReport', () => {
  it('accepts a nested plan and keeps labels apart from ids', () => {
    const result = validateProgressReport(plan)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.steps.map((step) => [step.id, step.label])).toEqual([
      ['research', '1'],
      ['store', '2'],
      ['store.schema', '2.a'],
      ['store.query', '2.b'],
      ['ui', '3'],
    ])
    expect(result.report.reason).toBe('Split the store work')
  })

  it('refuses duplicate ids', () => {
    const issues = issuesOf({
      steps: [
        { id: 'a', title: 'One', status: 'pending' },
        { id: 'a', title: 'Two', status: 'pending' },
      ],
    })
    expect(issues).toMatch(/duplicate id "a"/)
  })

  it('refuses a parent that names no step, and a step that is its own parent', () => {
    expect(one({ parentId: 'z' })).toMatch(/names no step/)
    expect(one({ parentId: 'a' })).toMatch(/its own parent/)
  })

  it('refuses parents that form a cycle', () => {
    const issues = issuesOf({
      steps: [
        { id: 'a', parentId: 'b', title: 'A', status: 'pending' },
        { id: 'b', parentId: 'a', title: 'B', status: 'pending' },
      ],
    })
    expect(issues).toMatch(/parents form a cycle/)
  })

  it('refuses nesting deeper than the limit', () => {
    const steps = Array.from({ length: PROGRESS_LIMITS.depth + 1 }, (_, index) => ({
      id: `s${String(index)}`,
      ...(index === 0 ? {} : { parentId: `s${String(index - 1)}` }),
      title: `Level ${String(index)}`,
      status: 'pending',
    }))
    expect(issuesOf({ steps })).toMatch(/nested deeper than/)
  })

  it('refuses a dependency on itself, on a missing step, or listed twice', () => {
    expect(one({ dependsOn: ['a'] })).toMatch(/cannot depend on itself/)
    expect(one({ dependsOn: ['b'] })).toMatch(/dependsOn "b" names no step/)
    expect(
      issuesOf({
        steps: [
          { id: 'a', title: 'A', status: 'pending', dependsOn: ['b', 'b'] },
          { id: 'b', title: 'B', status: 'pending' },
        ],
      })
    ).toMatch(/listed twice/)
  })

  it('refuses dependencies that form a cycle, including one through a parent', () => {
    expect(
      issuesOf({
        steps: [
          { id: 'a', title: 'A', status: 'pending', dependsOn: ['b'] },
          { id: 'b', title: 'B', status: 'pending', dependsOn: ['a'] },
        ],
      })
    ).toMatch(/dependencies form a cycle/)
    expect(
      issuesOf({
        steps: [
          { id: 'p', title: 'Parent', status: 'pending' },
          { id: 'c', parentId: 'p', title: 'Child', status: 'pending', dependsOn: ['p'] },
        ],
      })
    ).toMatch(/dependencies form a cycle/)
  })

  it('refuses estimates that are not a positive, bounded number of minutes', () => {
    for (const estimateMinutes of [0, -5, PROGRESS_LIMITS.estimateMinutes + 1, Number.NaN]) {
      expect(one({ estimateMinutes }), String(estimateMinutes)).not.toBe('')
    }
  })

  it('refuses unknown fields, unknown statuses, empty plans and foreign scope', () => {
    expect(one({ owner: 'x' })).not.toBe('')
    expect(one({ status: 'started' })).not.toBe('')
    expect(issuesOf({ steps: [] })).not.toBe('')
    expect(
      issuesOf({ steps: [{ id: 'a', title: 'A', status: 'pending' }], conversationId: 'c' })
    ).not.toBe('')
  })

  it('refuses ids that are not identifiers', () => {
    expect(one({ id: 'has space' })).not.toBe('')
  })
})

describe('the step graph helpers', () => {
  const result = validateProgressReport(plan)
  if (!result.ok) throw new Error('fixture must be valid')
  const { steps } = result.report

  it('expands a parent to its leaves', () => {
    expect(stepLeaves(steps).get('store')).toEqual(['store.schema', 'store.query'])
    expect(stepLeaves(steps).get('ui')).toEqual(['ui'])
  })

  it('turns a dependency on a parent into a dependency on each of its leaves', () => {
    expect([...(leafPrerequisites(steps).get('ui') ?? [])]).toEqual(['store.schema', 'store.query'])
    expect(leafPrerequisites(steps).has('store')).toBe(false)
  })
})

describe('runProgressTool', () => {
  const recording = (seen: ProgressReport[]) => (report: ProgressReport) => {
    seen.push(report)
    return { ok: true, text: 'recorded' }
  }

  it('says so when the session has no reporter', async () => {
    expect(await runProgressTool(undefined, plan)).toEqual({
      ok: false,
      text: NO_PROGRESS_REPORTER,
    })
  })

  it('never reaches the reporter with an invalid report', async () => {
    const seen: ProgressReport[] = []
    const result = await runProgressTool(recording(seen), {
      steps: [{ id: 'a', title: 'A', status: 'pending', dependsOn: ['a'] }],
    })
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/^Invalid arguments: /)
    expect(seen).toEqual([])
  })

  it('hands the validated report on and returns what the reporter said', async () => {
    const seen: ProgressReport[] = []
    expect(await runProgressTool(recording(seen), plan)).toEqual({ ok: true, text: 'recorded' })
    expect(seen[0]?.steps).toHaveLength(5)
  })

  it('reports a reporter that throws as a failure', async () => {
    const result = await runProgressTool(() => {
      throw new Error('store closed')
    }, plan)
    expect(result).toEqual({ ok: false, text: 'store closed' })
  })
})

describe('the JSON schema Codex receives', () => {
  it('requires the same step fields the validator does', () => {
    const properties = PROGRESS_TOOL_INPUT_SCHEMA['properties'] as Record<
      string,
      Record<string, unknown>
    >
    const items = properties['steps']?.['items'] as { required: string[] }
    expect(items.required).toEqual(['id', 'title', 'status'])
    expect(PROGRESS_TOOL_INPUT_SCHEMA['additionalProperties']).toBe(false)
  })
})

describe('a report that says the task is complete', () => {
  it('is refused while any step is unfinished, so the plan cannot contradict it', () => {
    const issues = issuesOf({
      steps: [
        { id: 'a', title: 'A', status: 'done' },
        { id: 'b', title: 'B', status: 'active' },
      ],
      complete: true,
    })
    expect(issues).toMatch(/complete is true but "b" is not done or skipped/)
  })

  it('is accepted once every step is done or skipped', () => {
    expect(
      issuesOf({
        steps: [
          { id: 'p', title: 'Parent', status: 'pending' },
          { id: 'a', parentId: 'p', title: 'A', status: 'done' },
          { id: 'b', parentId: 'p', title: 'B', status: 'skipped' },
        ],
        complete: true,
      })
    ).toBe('')
  })
})

describe('nativeProgressSteps', () => {
  const checklist = [
    { text: 'Read the types', done: true },
    { text: '  ', done: false },
    { text: 'Fix  the parser', done: false, active: true },
    { text: 'Write a test', done: false },
  ]

  it('labels a checklist by position and carries done and active, without estimates', () => {
    const steps = nativeProgressSteps(checklist)
    expect(steps.map((step) => [step.label, step.title, step.status])).toEqual([
      ['1', 'Read the types', 'done'],
      ['2', 'Fix the parser', 'active'],
      ['3', 'Write a test', 'pending'],
    ])
    expect(steps.every((step) => step.estimateMinutes === undefined)).toBe(true)
  })

  it('keeps a step’s id when the list is reordered, so time never moves to another step', () => {
    const before = nativeProgressSteps(checklist)
    const after = nativeProgressSteps([...checklist].reverse())
    const idOf = (steps: typeof before, title: string) =>
      steps.find((step) => step.title === title)?.id
    for (const title of ['Read the types', 'Fix the parser', 'Write a test']) {
      expect(idOf(after, title), title).toBe(idOf(before, title))
    }
    expect(before.map((step) => step.id)).not.toEqual(['1', '2', '3'])
  })

  it('gives a repeated title an id of its own', () => {
    const ids = nativeProgressSteps([
      { text: 'Run the check', done: true },
      { text: 'run the check', done: false },
    ]).map((step) => step.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[1]).toBe(`${String(ids[0])}-2`)
  })
})

describe('PROGRESS_INSTRUCTION', () => {
  it('asks for early, milestone and final reports without widening what the user allowed', () => {
    expect(PROGRESS_INSTRUCTION).toMatch(/report_progress/)
    expect(PROGRESS_INSTRUCTION).toMatch(/complete set to true only when the whole task/)
    expect(PROGRESS_INSTRUCTION).toMatch(/never authorizes work the user did not ask for/)
    expect(PROGRESS_INSTRUCTION).toMatch(/whether to run tests or builds/)
  })
})
