import {
  leafPrerequisites,
  stepAncestors,
  stepLeaves,
  type ProgressStep,
  type ProgressStepStatus,
} from '@chorus/agent-protocol'
import type { TaskOutcomeRecord, TaskRecords } from '@chorus/event-store'
import { AgentIdSchema, isAgentId, type AgentId } from '@chorus/shared'
import { z } from 'zod'
import {
  DISCUSSION_REPLY_PREFIX,
  DISCUSSION_USER_PREFIX,
  LIVE_REPLY_PREFIX,
  LIVE_USER_PREFIX,
} from './live-message.js'

const MINUTE_MS = 60_000
const SHRINK = 5
const MIN_HISTORY_TASKS = 5
const MIN_HISTORY_SAMPLES = 10
const MAX_HISTORY_SAMPLES = 30
const MAX_OUTCOME_SAMPLES = 100
const RATIO_FLOOR = 0.1
const RATIO_CEILING = 10
const ROUGH_LOW = 0.6
const ROUGH_HIGH = 2

export const TASK_IGNORED_ITEM_REF_PREFIXES: readonly string[] = [
  DISCUSSION_REPLY_PREFIX,
  DISCUSSION_USER_PREFIX,
  LIVE_REPLY_PREFIX,
  LIVE_USER_PREFIX,
]

const position = { at: z.number(), seq: z.number() }

const StepShape = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  parentId: z.string().optional(),
  title: z.string(),
  status: z.enum(['pending', 'active', 'done', 'skipped']),
  estimateMinutes: z.number().positive().optional(),
  dependsOn: z.array(z.string()).optional(),
})

export const TaskMarkShape = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('opened'),
    ...position,
    taskId: z.string().min(1),
    originEventId: z.string().min(1),
    startedAt: z.number(),
  }),
  z.object({
    kind: z.literal('revised'),
    ...position,
    taskId: z.string().min(1),
    agentId: AgentIdSchema,
    revision: z.number().int(),
    source: z.enum(['chorus', 'native']),
    steps: z.array(StepShape),
    reason: z.string().optional(),
    parallel: z.boolean().optional(),
    awaitingUser: z.boolean().optional(),
    complete: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('closed'),
    ...position,
    taskId: z.string().min(1),
    reason: z.enum(['completed', 'superseded', 'abandoned']),
  }),
  z.object({ kind: z.literal('turnStarted'), ...position, agentId: AgentIdSchema }),
  z.object({
    kind: z.literal('turnCompleted'),
    ...position,
    agentId: AgentIdSchema,
    status: z.enum(['completed', 'interrupted', 'failed']),
    userInitiated: z.boolean(),
  }),
  z.object({
    kind: z.literal('sessionStarted'),
    ...position,
    agentId: AgentIdSchema,
    sessionRef: z.string(),
    model: z.string().nullable(),
    resumed: z.boolean(),
  }),
  z.object({
    kind: z.literal('sessionEnded'),
    ...position,
    agentId: AgentIdSchema,
    reason: z.enum(['closed', 'crashed', 'replaced', 'shutdown']),
  }),
  z.object({ kind: z.literal('user'), ...position, eventId: z.string(), work: z.boolean() }),
  z.object({
    kind: z.literal('waitStarted'),
    ...position,
    agentId: AgentIdSchema,
    waitId: z.string(),
    wait: z.enum(['approval', 'question']),
  }),
  z.object({
    kind: z.literal('waitEnded'),
    ...position,
    agentId: AgentIdSchema,
    waitId: z.string(),
  }),
  z.object({
    kind: z.literal('paused'),
    ...position,
    agentId: AgentIdSchema,
    resetsAt: z.number().nullable(),
  }),
  z.object({ kind: z.literal('evidence'), ...position, agentId: AgentIdSchema }),
])
export type TaskMark = z.infer<typeof TaskMarkShape>

export const TaskOutcomeShape = z.object({
  startedAt: z.number(),
  elapsedMs: z.number().nonnegative(),
  workingMs: z.number().nonnegative(),
  lanes: z.array(
    z.object({
      agentId: AgentIdSchema,
      model: z.string().nullable(),
      firstForecastMinutes: z.number().nonnegative().nullable(),
      finalForecastMinutes: z.number().nonnegative().nullable(),
      workingMs: z.number().nonnegative(),
      samples: z.array(
        z.object({
          estimateMinutes: z.number().positive(),
          actualMinutes: z.number().nonnegative(),
        })
      ),
    })
  ),
})
export type TaskOutcome = z.infer<typeof TaskOutcomeShape>

export const TaskHistoryShape = z.object({ taskId: z.string(), outcome: TaskOutcomeShape })
export type TaskHistoryEntry = z.infer<typeof TaskHistoryShape>

export const TaskBundleShape = z.object({
  marks: z.array(TaskMarkShape),
  history: z.array(TaskHistoryShape),
})
export type TaskBundle = z.infer<typeof TaskBundleShape>

export const TASK_LIVE_TYPES: ReadonlySet<string> = new Set([
  'task.opened',
  'task.revised',
  'task.closed',
  'turn.started',
  'turn.completed',
  'session.started',
  'session.ended',
  'user.message',
  'usage.blocked',
  'approval.requested',
  'approval.decided',
  'approval.withdrawn',
  'userinput.requested',
  'userinput.answered',
])

const NOT_EVIDENCE: ReadonlySet<string> = new Set(['task.opened', 'task.closed'])

export interface TaskEventLike {
  readonly seq: number
  readonly id: string
  readonly actor: string
  readonly type: string
  readonly payload: unknown
  readonly createdAt: number
}

const payloadOf = (event: TaskEventLike): Readonly<Record<string, unknown>> =>
  typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {}

function outsideWork(payload: Readonly<Record<string, unknown>>): boolean {
  if (payload['mode'] === 'discussion') return true
  const itemRef = payload['itemRef']
  return (
    typeof itemRef === 'string' &&
    TASK_IGNORED_ITEM_REF_PREFIXES.some((prefix) => itemRef.startsWith(prefix))
  )
}

function evidenceOf(event: TaskEventLike): TaskMark | null {
  if (!isAgentId(event.actor) || NOT_EVIDENCE.has(event.type)) return null
  if (outsideWork(payloadOf(event))) return null
  return { kind: 'evidence', at: event.createdAt, seq: event.seq, agentId: event.actor }
}

function candidateMark(event: TaskEventLike): Record<string, unknown> | null {
  const payload = payloadOf(event)
  const at = { at: event.createdAt, seq: event.seq }
  const actor = event.actor
  const work = payload['mode'] !== 'discussion'
  switch (event.type) {
    case 'task.opened':
      return {
        kind: 'opened',
        ...at,
        taskId: payload['taskId'],
        originEventId: payload['originEventId'],
        startedAt: payload['startedAt'],
      }
    case 'task.revised':
      return {
        kind: 'revised',
        ...at,
        taskId: payload['taskId'],
        agentId: payload['agentId'],
        revision: payload['revision'],
        source: payload['source'],
        steps: payload['steps'],
        reason: payload['reason'],
        parallel: payload['parallel'],
        awaitingUser: payload['awaitingUser'],
        complete: payload['complete'],
      }
    case 'task.closed':
      return { kind: 'closed', ...at, taskId: payload['taskId'], reason: payload['reason'] }
    case 'turn.started':
      return { kind: 'turnStarted', ...at, agentId: actor }
    case 'turn.completed':
      return {
        kind: 'turnCompleted',
        ...at,
        agentId: actor,
        status: payload['status'],
        userInitiated: payload['userInitiated'] === true,
      }
    case 'session.started':
      return {
        kind: 'sessionStarted',
        ...at,
        agentId: payload['agentId'],
        sessionRef: payload['sessionRef'],
        model: payload['model'] ?? null,
        resumed: payload['resumed'] === true,
      }
    case 'session.ended':
      return { kind: 'sessionEnded', ...at, agentId: payload['agentId'], reason: payload['reason'] }
    case 'user.message':
      return {
        kind: 'user',
        ...at,
        eventId: event.id,
        work: work && payload['live'] !== true,
      }
    case 'usage.blocked':
      return { kind: 'paused', ...at, agentId: actor, resetsAt: payload['resetsAt'] ?? null }
    case 'approval.requested':
      return work
        ? {
            kind: 'waitStarted',
            ...at,
            agentId: actor,
            waitId: payload['approvalId'],
            wait: 'approval',
          }
        : null
    case 'approval.decided':
    case 'approval.withdrawn':
      return work
        ? { kind: 'waitEnded', ...at, agentId: actor, waitId: payload['approvalId'] }
        : null
    case 'userinput.requested':
      return work
        ? {
            kind: 'waitStarted',
            ...at,
            agentId: actor,
            waitId: payload['userInputId'],
            wait: 'question',
          }
        : null
    case 'userinput.answered':
      return work
        ? { kind: 'waitEnded', ...at, agentId: actor, waitId: payload['userInputId'] }
        : null
    default:
      return null
  }
}

export function taskMarkOf(event: TaskEventLike): TaskMark | null {
  if (!TASK_LIVE_TYPES.has(event.type)) return evidenceOf(event)
  const candidate = candidateMark(event)
  if (candidate === null) return null
  const parsed = TaskMarkShape.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function sortMarks<T extends { readonly at: number; readonly seq: number }>(marks: T[]): T[] {
  return marks.sort((a, b) => a.seq - b.seq || a.at - b.at)
}

const sessionBoundary = (mark: TaskMark, agentId: AgentId): boolean =>
  (mark.kind === 'sessionStarted' || mark.kind === 'sessionEnded') && mark.agentId === agentId

function withEvidence(marks: TaskMark[], evidence: TaskMark): TaskMark[] {
  if (evidence.kind !== 'evidence') return [...marks, evidence]
  const boundary = marks.findLast((mark) => sessionBoundary(mark, evidence.agentId))?.seq ?? -1
  return [
    ...marks.filter(
      (mark) =>
        !(mark.kind === 'evidence' && mark.agentId === evidence.agentId && mark.seq > boundary)
    ),
    evidence,
  ]
}

export function taskMarksFromRecords(records: TaskRecords): TaskMark[] {
  const marks = records.events.flatMap((event) => {
    const mark = taskMarkOf(event)
    return mark === null ? [] : [mark]
  })
  const known = new Set(marks.map((mark) => mark.seq))
  for (const event of records.evidence) {
    if (known.has(event.seq)) continue
    const mark = evidenceOf(event)
    if (mark !== null) marks.push(mark)
  }
  return sortMarks(marks)
}

export function taskBundleFrom(
  records: TaskRecords | null,
  outcomes: readonly TaskOutcomeRecord[]
): TaskBundle | null {
  if (records === null) return null
  return {
    marks: taskMarksFromRecords(records),
    history: outcomes.map((record) => ({ taskId: record.taskId, outcome: record.outcome })),
  }
}

export function mergeTaskMarks(
  fresh: TaskBundle,
  live: TaskBundle | null,
  throughSeq: number
): TaskBundle {
  const known = new Set(fresh.marks.map((mark) => mark.seq))
  const newer = (live?.marks ?? []).filter((mark) => mark.seq > throughSeq && !known.has(mark.seq))
  return newer.length === 0 ? fresh : { ...fresh, marks: sortMarks([...fresh.marks, ...newer]) }
}

export function appendTaskMarks(bundle: TaskBundle, events: readonly TaskEventLike[]): TaskBundle {
  const known = new Set(bundle.marks.map((mark) => mark.seq))
  let marks: TaskMark[] = bundle.marks
  for (const event of events) {
    if (known.has(event.seq)) continue
    const mark = taskMarkOf(event)
    if (mark === null) continue
    known.add(event.seq)
    marks = mark.kind === 'evidence' ? withEvidence(marks, mark) : [...marks, mark]
  }
  return marks === bundle.marks ? bundle : { ...bundle, marks: sortMarks([...marks]) }
}

export type TaskState =
  | 'working'
  | 'waiting'
  | 'paused'
  | 'idle'
  | 'stopped'
  | 'failed'
  | 'unknown'
  | 'complete'
  | 'closed'

export type TaskCompletion = 'none' | 'pending' | 'settled' | 'void'

export interface TaskStepView {
  readonly agentId: AgentId
  readonly id: string
  readonly label: string
  readonly title: string
  readonly status: ProgressStepStatus
  readonly parentId: string | null
  readonly depth: number
  readonly leaf: boolean
  readonly estimateMinutes: number | null
  readonly spentMs: number
  readonly remainingMs: number | null
  readonly overrunMs: number
}

export interface TaskCurrentStep {
  readonly agentId: AgentId
  readonly step: TaskStepView
  readonly main: TaskStepView
  readonly mainIndex: number
  readonly mainTotal: number
  readonly substeps: { readonly done: number; readonly total: number } | null
}

export interface TaskRevisionChange {
  readonly at: number
  readonly agentId: AgentId
  readonly revision: number
  readonly source: 'chorus' | 'native'
  readonly reason: string | null
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly completed: readonly string[]
  readonly split: readonly string[]
  readonly estimateDeltaMinutes: number
  readonly remainingDeltaMs: number | null
}

export interface TaskForecast {
  readonly remainingMs: number
  readonly lowMs: number
  readonly highMs: number
  readonly overrunMs: number
  readonly confidence: 'rough' | 'calibrated'
  readonly partial: boolean
  readonly paced: boolean
  readonly firstForecastMs: number
  readonly plannedMs: number
}

export interface TaskSample {
  readonly estimateMinutes: number
  readonly actualMinutes: number
}

export interface TaskLaneView {
  readonly agentId: AgentId
  readonly source: 'chorus' | 'native'
  readonly model: string | null
  readonly parallel: boolean
  readonly revisions: number
  readonly workingMs: number
  readonly firstForecastMinutes: number | null
  readonly finalForecastMinutes: number | null
  readonly speedFactor: number
  readonly confidence: 'rough' | 'calibrated'
  readonly completion: TaskCompletion
  readonly finished: boolean
  readonly samples: readonly TaskSample[]
}

export interface TaskClocks {
  readonly elapsedMs: number
  readonly workingMs: number
  readonly waitingMs: number
  readonly pausedMs: number
  readonly idleMs: number
  readonly stoppedMs: number
  readonly unknownMs: number
}

export interface TaskSnapshot {
  readonly taskId: string
  readonly originEventId: string
  readonly startedAt: number
  readonly closedAt: number | null
  readonly closeReason: 'completed' | 'superseded' | 'abandoned' | null
  readonly state: TaskState
  readonly working: readonly AgentId[]
  readonly waitingOn: readonly {
    readonly agentId: AgentId
    readonly kind: 'approval' | 'question' | 'user'
  }[]
  readonly paused: readonly { readonly agentId: AgentId; readonly resetsAt: number | null }[]
  readonly readyToClose: boolean
  readonly requestAfterClose: boolean
  readonly clocks: TaskClocks
  readonly lanes: readonly TaskLaneView[]
  readonly steps: readonly TaskStepView[]
  readonly current: readonly TaskCurrentStep[]
  readonly progress: {
    readonly mainDone: number
    readonly mainTotal: number
    readonly leavesDone: number
    readonly leavesTotal: number
  }
  readonly forecast: TaskForecast | null
  readonly changes: readonly TaskRevisionChange[]
  readonly asOf: number
}

interface Unit {
  readonly id: string
  readonly estimateMinutes: number
  readonly leaves: readonly string[]
}

interface Plan {
  readonly steps: readonly ProgressStep[]
  readonly byId: ReadonlyMap<string, ProgressStep>
  readonly leaves: ReadonlyMap<string, readonly string[]>
  readonly leafOrder: readonly string[]
  readonly units: ReadonlyMap<string, Unit>
  readonly leafUnit: ReadonlyMap<string, string>
  readonly prerequisites: ReadonlyMap<string, ReadonlySet<string>>
}

interface Lane {
  readonly agentId: AgentId
  source: 'chorus' | 'native'
  plan: Plan
  parallel: boolean
  revisions: number
  completion: TaskCompletion
  readonly spent: Map<string, number>
  readonly startEstimate: Map<string, number>
  firstForecast: number | null
  finalForecast: number | null
}

type EndKind = 'completed' | 'stopped' | 'failed' | 'unknown'

interface Agent {
  turnOpen: boolean
  readonly waits: Map<string, 'approval' | 'question'>
  sessionRef: string | null
  model: string | null
  readonly modelByRef: Map<string, string>
  workingMs: number
  lastEnd: EndKind | null
  paused: { readonly resetsAt: number | null } | null
  awaiting: { settledAt: number | null } | null
}

type Timeline = TaskMark | { readonly kind: 'lost'; at: number; seq: number; agentId: AgentId }

function toStep(raw: z.infer<typeof StepShape>): ProgressStep {
  return {
    id: raw.id,
    title: raw.title,
    status: raw.status,
    ...(raw.label === undefined ? {} : { label: raw.label }),
    ...(raw.parentId === undefined ? {} : { parentId: raw.parentId }),
    ...(raw.estimateMinutes === undefined ? {} : { estimateMinutes: raw.estimateMinutes }),
    ...(raw.dependsOn === undefined ? {} : { dependsOn: raw.dependsOn }),
  }
}

const EMPTY_PLAN: Plan = {
  steps: [],
  byId: new Map(),
  leaves: new Map(),
  leafOrder: [],
  units: new Map(),
  leafUnit: new Map(),
  prerequisites: new Map(),
}

function planOf(steps: readonly ProgressStep[]): Plan {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const leaves = stepLeaves(steps)
  const leafOrder = steps
    .filter((step) => {
      const own = leaves.get(step.id)
      return own?.length === 1 && own[0] === step.id
    })
    .map((step) => step.id)
  const covered = new Set<string>()
  for (const step of steps) {
    if (step.estimateMinutes === undefined) continue
    for (const ancestor of stepAncestors(steps, step.id)) covered.add(ancestor)
  }
  const units = new Map<string, Unit>()
  const leafUnit = new Map<string, string>()
  for (const step of steps) {
    if (step.estimateMinutes === undefined || covered.has(step.id)) continue
    const own = leaves.get(step.id) ?? [step.id]
    units.set(step.id, { id: step.id, estimateMinutes: step.estimateMinutes, leaves: own })
    for (const leaf of own) leafUnit.set(leaf, step.id)
  }
  return {
    steps,
    byId,
    leaves,
    leafOrder,
    units,
    leafUnit,
    prerequisites: leafPrerequisites(steps),
  }
}

const finished = (status: ProgressStepStatus | undefined): boolean =>
  status === 'done' || status === 'skipped'

function derivedStatus(plan: Plan, id: string): ProgressStepStatus {
  const own = plan.leaves.get(id) ?? [id]
  const statuses = own.map((leaf) => plan.byId.get(leaf)?.status ?? 'pending')
  if (statuses.every((status) => status === 'skipped')) return 'skipped'
  if (statuses.every(finished)) return 'done'
  if (statuses.some((status) => status === 'active')) return 'active'
  if (statuses.some(finished)) return 'active'
  return 'pending'
}

function unitFinished(plan: Plan, unit: Unit): boolean {
  return unit.leaves.every((leaf) => finished(plan.byId.get(leaf)?.status))
}

function planFinished(plan: Plan): boolean {
  return (
    plan.leafOrder.length > 0 &&
    plan.leafOrder.every((leaf) => finished(plan.byId.get(leaf)?.status))
  )
}

function chargedUnits(lane: Lane): string[] {
  const { plan } = lane
  const open = plan.leafOrder.filter((leaf) => !finished(plan.byId.get(leaf)?.status))
  const active = open.filter((leaf) => plan.byId.get(leaf)?.status === 'active')
  const chosen = lane.parallel
    ? active.length > 0
      ? active
      : open.slice(0, 1)
    : (active.length > 0 ? active : open).slice(0, 1)
  const units = new Set<string>()
  for (const leaf of chosen) {
    const unit = plan.leafUnit.get(leaf)
    if (unit !== undefined) units.add(unit)
  }
  return [...units]
}

interface Calibration {
  readonly factor: number
  readonly low: number
  readonly high: number
  readonly growth: number
  readonly confidence: 'rough' | 'calibrated'
}

const logRatio = (actual: number, estimate: number): number | null => {
  if (!(actual > 0) || !(estimate > 0)) return null
  return Math.log(Math.min(Math.max(actual / estimate, RATIO_FLOOR), RATIO_CEILING))
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const low = sorted[lower] ?? 0
  const high = sorted[upper] ?? low
  return low + (high - low) * (index - lower)
}

function laneSamples(lane: Lane): TaskSample[] {
  const samples: TaskSample[] = []
  for (const unit of lane.plan.units.values()) {
    if (!unitFinished(lane.plan, unit)) continue
    const estimate = lane.startEstimate.get(unit.id)
    const spent = lane.spent.get(unit.id) ?? 0
    if (estimate === undefined || spent <= 0) continue
    samples.push({ estimateMinutes: estimate, actualMinutes: spent / MINUTE_MS })
  }
  return samples.slice(0, MAX_OUTCOME_SAMPLES)
}

function calibrate(
  lane: Lane,
  model: string | null,
  history: readonly TaskHistoryEntry[],
  taskId: string
): Calibration {
  const comparable =
    model === null
      ? []
      : history
          .filter((entry) => entry.taskId !== taskId)
          .flatMap((entry) =>
            entry.outcome.lanes
              .filter((other) => other.agentId === lane.agentId && other.model === model)
              .map((other) => ({ taskId: entry.taskId, lane: other }))
          )
  const historyLogs = comparable
    .flatMap((entry) => entry.lane.samples)
    .flatMap((sample) => {
      const value = logRatio(sample.actualMinutes, sample.estimateMinutes)
      return value === null ? [] : [value]
    })
    .slice(0, MAX_HISTORY_SAMPLES)
  const historyTasks = new Set(
    comparable.filter((entry) => entry.lane.samples.length > 0).map((entry) => entry.taskId)
  ).size
  const ownLogs = laneSamples(lane).flatMap((sample) => {
    const value = logRatio(sample.actualMinutes, sample.estimateMinutes)
    return value === null ? [] : [value]
  })
  const historyMedian = quantile(historyLogs, 0.5) ?? 0
  const ownMedian = quantile(ownLogs, 0.5) ?? 0
  const calibrated =
    model !== null && historyTasks >= MIN_HISTORY_TASKS && historyLogs.length >= MIN_HISTORY_SAMPLES
  const historyWeight = calibrated ? historyLogs.length : 0
  const center =
    (historyWeight * historyMedian + ownLogs.length * ownMedian) /
    (historyWeight + ownLogs.length + SHRINK)
  const spreadLow = calibrated
    ? Math.min(0, (quantile(historyLogs, 0.25) ?? historyMedian) - historyMedian)
    : Math.log(ROUGH_LOW)
  const spreadHigh = calibrated
    ? Math.max(0, (quantile(historyLogs, 0.75) ?? historyMedian) - historyMedian)
    : Math.log(ROUGH_HIGH)
  const growths = comparable.flatMap((entry) => {
    const first = entry.lane.firstForecastMinutes
    const final = entry.lane.finalForecastMinutes
    return first !== null && final !== null && first > 0 && final > 0 ? [final / first] : []
  })
  const growth =
    calibrated && growths.length >= MIN_HISTORY_TASKS
      ? Math.max(1, quantile(growths, 0.75) ?? 1)
      : 1
  return {
    factor: Math.exp(center),
    low: Math.exp(center + spreadLow),
    high: Math.exp(center + spreadHigh),
    growth,
    confidence: calibrated ? 'calibrated' : 'rough',
  }
}

function unitRemainingMs(lane: Lane, unit: Unit, factor: number): number {
  if (unitFinished(lane.plan, unit)) return 0
  return Math.max(0, unit.estimateMinutes * MINUTE_MS * factor - (lane.spent.get(unit.id) ?? 0))
}

function laneRemainingMs(lane: Lane, factor: number): number {
  const { plan } = lane
  const remaining = new Map<string, number>()
  for (const unit of plan.units.values()) {
    remaining.set(unit.id, unitRemainingMs(lane, unit, factor))
  }
  const serial = [...remaining.values()].reduce((sum, value) => sum + value, 0)
  if (!lane.parallel) return serial

  const needs = new Map<string, Set<string>>()
  for (const unit of plan.units.values()) {
    const set = new Set<string>()
    for (const leaf of unit.leaves) {
      for (const prerequisite of plan.prerequisites.get(leaf) ?? []) {
        const owner = plan.leafUnit.get(prerequisite)
        if (owner !== undefined && owner !== unit.id) set.add(owner)
      }
    }
    needs.set(unit.id, set)
  }
  const finish = new Map<string, number>()
  const visiting = new Set<string>()
  const loop = { found: false }
  const finishOf = (id: string): number => {
    const known = finish.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) {
      loop.found = true
      return 0
    }
    visiting.add(id)
    let start = 0
    for (const before of needs.get(id) ?? []) start = Math.max(start, finishOf(before))
    visiting.delete(id)
    const value = start + (remaining.get(id) ?? 0)
    finish.set(id, value)
    return value
  }
  let longest = 0
  for (const id of plan.units.keys()) longest = Math.max(longest, finishOf(id))
  return loop.found ? serial : longest
}

function lanePlannedMs(lane: Lane): number {
  let total = 0
  for (const unit of lane.plan.units.values()) total += unit.estimateMinutes * MINUTE_MS
  return total
}

function planTotalMinutes(plan: Plan): number | null {
  if (plan.units.size === 0) return null
  let total = 0
  for (const unit of plan.units.values()) total += unit.estimateMinutes
  return total
}

function withLostMarks(marks: readonly TaskMark[]): Timeline[] {
  const open = new Map<AgentId, { at: number; seq: number }>()
  const last = new Map<AgentId, { at: number; seq: number }>()
  const lost: Timeline[] = []
  const seen = (agentId: AgentId, mark: { at: number; seq: number }): void => {
    const known = last.get(agentId)
    if (known === undefined || mark.seq > known.seq) last.set(agentId, mark)
  }
  for (const mark of marks) {
    switch (mark.kind) {
      case 'turnStarted':
        open.set(mark.agentId, mark)
        seen(mark.agentId, mark)
        break
      case 'turnCompleted':
        open.delete(mark.agentId)
        seen(mark.agentId, mark)
        break
      case 'evidence':
      case 'waitStarted':
      case 'waitEnded':
      case 'paused':
      case 'revised':
        seen(mark.agentId, mark)
        break
      case 'sessionStarted':
      case 'sessionEnded': {
        const since = open.get(mark.agentId)
        const crashed = mark.kind === 'sessionStarted' || mark.reason === 'crashed'
        if (since !== undefined && crashed) {
          const evidence = last.get(mark.agentId) ?? since
          const end = evidence.seq >= since.seq ? evidence : since
          lost.push({ kind: 'lost', at: end.at, seq: end.seq + 0.5, agentId: mark.agentId })
        }
        open.delete(mark.agentId)
        break
      }
      case 'opened':
      case 'closed':
      case 'user':
        break
    }
  }
  return sortMarks<Timeline>([...marks, ...lost])
}

function stepLabel(plan: Plan, step: ProgressStep): string {
  if (step.label !== undefined && step.label !== '') return step.label
  const siblings = plan.steps.filter((other) => other.parentId === step.parentId)
  const index = String(siblings.indexOf(step) + 1)
  const parent = step.parentId === undefined ? undefined : plan.byId.get(step.parentId)
  return parent === undefined ? index : `${stepLabel(plan, parent)}.${index}`
}

function changeOf(
  previous: Plan | null,
  next: Plan,
  mark: Extract<TaskMark, { kind: 'revised' }>
): Omit<TaskRevisionChange, 'remainingDeltaMs'> {
  const before = previous ?? EMPTY_PLAN
  const added = next.steps.filter((step) => !before.byId.has(step.id)).map((step) => step.id)
  const removed = before.steps.filter((step) => !next.byId.has(step.id)).map((step) => step.id)
  const completed = next.steps
    .filter((step) => {
      if (!before.byId.has(step.id)) return false
      return derivedStatus(next, step.id) === 'done' && derivedStatus(before, step.id) !== 'done'
    })
    .map((step) => step.id)
  const split = [...before.units.keys()].filter(
    (id) =>
      next.byId.has(id) &&
      !next.units.has(id) &&
      (next.leaves.get(id) ?? []).some((leaf) => next.leafUnit.has(leaf))
  )
  let estimateDeltaMinutes = 0
  for (const [id, unit] of next.units) {
    const old = before.units.get(id)
    if (old !== undefined) estimateDeltaMinutes += unit.estimateMinutes - old.estimateMinutes
  }
  return {
    at: mark.at,
    agentId: mark.agentId,
    revision: mark.revision,
    source: mark.source,
    reason: mark.reason ?? null,
    added,
    removed,
    completed,
    split,
    estimateDeltaMinutes,
  }
}

type Bucket = 'working' | 'waiting' | 'paused' | 'stopped' | 'failed' | 'unknown' | 'idle'

export function reduceTask(bundle: TaskBundle, now: number): TaskSnapshot | null {
  const sorted = sortMarks([...bundle.marks])
  const opened = sorted.findLast((mark) => mark.kind === 'opened')
  if (opened?.kind !== 'opened') return null
  const { taskId, startedAt } = opened
  const marks = sorted.filter(
    (mark) => !(mark.kind === 'revised' || mark.kind === 'closed') || mark.taskId === taskId
  )
  const timeline = withLostMarks(marks)

  const agents = new Map<AgentId, Agent>()
  const agentOf = (agentId: AgentId): Agent => {
    let found = agents.get(agentId)
    if (found === undefined) {
      found = {
        turnOpen: false,
        waits: new Map(),
        sessionRef: null,
        model: null,
        modelByRef: new Map(),
        workingMs: 0,
        lastEnd: null,
        paused: null,
        awaiting: null,
      }
      agents.set(agentId, found)
    }
    return found
  }
  const lanes = new Map<AgentId, Lane>()
  const changes: TaskRevisionChange[] = []
  let lastEnd: { kind: EndKind; at: number } | null = null
  let closed: { at: number; reason: 'completed' | 'superseded' | 'abandoned' } | null = null
  let anyRevision = false
  const clocks = { working: 0, waiting: 0, paused: 0, stopped: 0, unknown: 0, idle: 0 }
  const limit = (): number => closed?.at ?? Math.max(now, startedAt)
  let cursor = startedAt

  const workingAgents = (): AgentId[] =>
    [...agents.entries()]
      .filter(([, agent]) => agent.turnOpen && agent.waits.size === 0 && agent.paused === null)
      .map(([agentId]) => agentId)

  const blockedAgents = (): { agentId: AgentId; kind: 'approval' | 'question' }[] =>
    [...agents.entries()].flatMap(([agentId, agent]) => {
      if (!agent.turnOpen) return []
      return [...new Set(agent.waits.values())].map((kind) => ({ agentId, kind }))
    })

  const pausedAgents = (): { agentId: AgentId; resetsAt: number | null }[] =>
    [...agents.entries()].flatMap(([agentId, agent]) =>
      agent.paused === null ? [] : [{ agentId, resetsAt: agent.paused.resetsAt }]
    )

  const awaitingAgents = (): { agentId: AgentId; settledAt: number }[] =>
    [...agents.entries()].flatMap(([agentId, agent]) => {
      const settledAt = agent.awaiting?.settledAt ?? null
      return settledAt === null ? [] : [{ agentId, settledAt }]
    })

  const bucket = (): Bucket => {
    if (workingAgents().length > 0) return 'working'
    if (blockedAgents().length > 0) return 'waiting'
    if (pausedAgents().length > 0) return 'paused'
    const awaiting = awaitingAgents()
    const abnormal = lastEnd !== null && lastEnd.kind !== 'completed' ? lastEnd : null
    const latestAwait = Math.max(-Infinity, ...awaiting.map((entry) => entry.settledAt))
    if (awaiting.length > 0 && (abnormal === null || abnormal.at <= latestAwait)) return 'waiting'
    if (abnormal !== null) return abnormal.kind === 'completed' ? 'idle' : abnormal.kind
    return 'idle'
  }

  const calibrations = (): Map<AgentId, Calibration> =>
    new Map(
      [...lanes.values()].map((lane) => [
        lane.agentId,
        calibrate(lane, agentOf(lane.agentId).model, bundle.history, taskId),
      ])
    )

  const totalRemaining = (): number | null => {
    if (![...lanes.values()].some((lane) => lane.plan.units.size > 0)) return null
    const factors = calibrations()
    let total = 0
    for (const lane of lanes.values()) {
      total += laneRemainingMs(lane, factors.get(lane.agentId)?.factor ?? 1)
    }
    return total
  }

  const accumulate = (dt: number): void => {
    const current = bucket()
    if (current !== 'working') {
      if (current === 'failed') clocks.stopped += dt
      else clocks[current] += dt
      return
    }
    clocks.working += dt
    for (const agentId of workingAgents()) {
      agentOf(agentId).workingMs += dt
      const lane = lanes.get(agentId)
      if (lane === undefined) continue
      for (const unitId of chargedUnits(lane)) {
        lane.spent.set(unitId, (lane.spent.get(unitId) ?? 0) + dt)
        const unit = lane.plan.units.get(unitId)
        if (unit !== undefined && !lane.startEstimate.has(unitId)) {
          lane.startEstimate.set(unitId, unit.estimateMinutes)
        }
      }
    }
  }

  const advance = (to: number): void => {
    const end = Math.min(to, limit())
    if (end > cursor) {
      accumulate(end - cursor)
      cursor = end
    }
  }

  const endTurn = (agentId: AgentId, kind: EndKind, at: number): void => {
    const agent = agentOf(agentId)
    agent.turnOpen = false
    agent.waits.clear()
    agent.lastEnd = kind
    lastEnd = { kind, at }
    if (kind === 'completed') {
      if (agent.awaiting !== null && agent.awaiting.settledAt === null) {
        agent.awaiting.settledAt = at
      }
    } else {
      agent.awaiting = null
    }
    const lane = lanes.get(agentId)
    if (lane?.completion === 'pending') lane.completion = kind === 'completed' ? 'settled' : 'void'
  }

  for (const mark of timeline) {
    if (closed !== null || mark.at > limit()) break
    advance(mark.at)
    switch (mark.kind) {
      case 'opened':
      case 'evidence':
        break
      case 'revised': {
        const remainingBefore = anyRevision ? totalRemaining() : null
        const plan = planOf(mark.steps.map(toStep))
        const existing = lanes.get(mark.agentId)
        const previous = existing?.plan ?? null
        const lane: Lane = existing ?? {
          agentId: mark.agentId,
          source: mark.source,
          plan,
          parallel: mark.parallel === true,
          revisions: 0,
          completion: 'none',
          spent: new Map(),
          startEstimate: new Map(),
          firstForecast: null,
          finalForecast: null,
        }
        lane.source = mark.source
        lane.plan = plan
        lane.parallel = mark.parallel === true
        lane.revisions += 1
        const agent = agentOf(mark.agentId)
        agent.paused = null
        lane.completion = mark.complete === true ? (agent.turnOpen ? 'pending' : 'settled') : 'none'
        const total = planTotalMinutes(plan)
        if (lane.firstForecast === null && total !== null) lane.firstForecast = total
        lane.finalForecast = total ?? lane.finalForecast
        lanes.set(mark.agentId, lane)
        agent.awaiting =
          mark.awaitingUser === true ? { settledAt: agent.turnOpen ? null : mark.at } : null
        if (anyRevision) {
          const remainingAfter = totalRemaining()
          changes.push({
            ...changeOf(previous, plan, mark),
            remainingDeltaMs:
              remainingBefore === null || remainingAfter === null
                ? null
                : remainingAfter - remainingBefore,
          })
        }
        anyRevision = true
        break
      }
      case 'closed':
        closed = { at: mark.at, reason: mark.reason }
        break
      case 'turnStarted': {
        const agent = agentOf(mark.agentId)
        agent.turnOpen = true
        agent.waits.clear()
        agent.paused = null
        agent.awaiting = null
        const lane = lanes.get(mark.agentId)
        if (lane?.completion === 'settled') lane.completion = 'none'
        break
      }
      case 'turnCompleted':
        endTurn(
          mark.agentId,
          mark.status === 'completed'
            ? 'completed'
            : mark.status === 'interrupted' && mark.userInitiated
              ? 'stopped'
              : 'failed',
          mark.at
        )
        break
      case 'lost':
        endTurn(mark.agentId, 'unknown', mark.at)
        break
      case 'sessionStarted': {
        const agent = agentOf(mark.agentId)
        if (agent.turnOpen) endTurn(mark.agentId, 'unknown', mark.at)
        agent.sessionRef = mark.sessionRef
        if (mark.model !== null) agent.modelByRef.set(mark.sessionRef, mark.model)
        agent.model = mark.model ?? agent.modelByRef.get(mark.sessionRef) ?? null
        break
      }
      case 'sessionEnded': {
        const agent = agentOf(mark.agentId)
        if (agent.turnOpen) endTurn(mark.agentId, 'unknown', mark.at)
        agent.waits.clear()
        break
      }
      case 'user':
        if (mark.work) {
          for (const agent of agents.values()) agent.awaiting = null
        }
        break
      case 'paused':
        agentOf(mark.agentId).paused = { resetsAt: mark.resetsAt }
        break
      case 'waitStarted': {
        const agent = agentOf(mark.agentId)
        if (agent.turnOpen) agent.waits.set(mark.waitId, mark.wait)
        break
      }
      case 'waitEnded':
        agentOf(mark.agentId).waits.delete(mark.waitId)
        break
    }
  }
  advance(limit())

  const factors = calibrations()
  const finalClosed: { at: number; reason: 'completed' | 'superseded' | 'abandoned' } | null =
    closed
  const working = finalClosed === null ? workingAgents() : []
  const blocked = finalClosed === null ? blockedAgents() : []
  const paused = finalClosed === null ? pausedAgents() : []
  const awaiting = finalClosed === null ? awaitingAgents() : []
  const current = bucket()
  const state: TaskState =
    finalClosed !== null ? (finalClosed.reason === 'completed' ? 'complete' : 'closed') : current

  const steps: TaskStepView[] = []
  const currentSteps: TaskCurrentStep[] = []
  let mainDone = 0
  let mainTotal = 0
  let leavesDone = 0
  let leavesTotal = 0
  let partial = false
  const paceOf = (lane: Lane): number | null => {
    const done = lane.plan.leafOrder.filter((leaf) =>
      finished(lane.plan.byId.get(leaf)?.status)
    ).length
    const worked = agentOf(lane.agentId).workingMs
    return done > 0 && worked > 0 ? worked / done : null
  }
  const unestimatedOpen = (lane: Lane): number =>
    lane.plan.leafOrder.filter(
      (leaf) => !finished(lane.plan.byId.get(leaf)?.status) && !lane.plan.leafUnit.has(leaf)
    ).length
  for (const lane of lanes.values()) {
    const { plan } = lane
    const factor = factors.get(lane.agentId)?.factor ?? 1
    const viewOf = (step: ProgressStep): TaskStepView => {
      const unit = plan.units.get(step.id)
      const spent = unit === undefined ? 0 : (lane.spent.get(unit.id) ?? 0)
      const budget = unit === undefined ? 0 : unit.estimateMinutes * MINUTE_MS * factor
      const leaf = plan.leafOrder.includes(step.id)
      return {
        agentId: lane.agentId,
        id: step.id,
        label: stepLabel(plan, step),
        title: step.title,
        status: leaf ? step.status : derivedStatus(plan, step.id),
        parentId: step.parentId ?? null,
        depth: stepAncestors(plan.steps, step.id).length + 1,
        leaf,
        estimateMinutes: unit?.estimateMinutes ?? null,
        spentMs: spent,
        remainingMs: unit === undefined ? null : unitRemainingMs(lane, unit, factor),
        overrunMs: unit === undefined ? 0 : Math.max(0, spent - budget),
      }
    }
    const views = new Map(plan.steps.map((step) => [step.id, viewOf(step)]))
    for (const view of views.values()) steps.push(view)
    const mains = plan.steps.filter((step) => step.parentId === undefined)
    mainTotal += mains.length
    mainDone += mains.filter((step) => finished(views.get(step.id)?.status)).length
    leavesTotal += plan.leafOrder.length
    leavesDone += plan.leafOrder.filter((leaf) => finished(plan.byId.get(leaf)?.status)).length

    const open = plan.leafOrder.filter((leaf) => !finished(plan.byId.get(leaf)?.status))
    if (open.some((leaf) => !plan.leafUnit.has(leaf)) && paceOf(lane) === null) partial = true

    const focus = open.find((leaf) => plan.byId.get(leaf)?.status === 'active') ?? open[0]
    const step = focus === undefined ? undefined : views.get(focus)
    if (step === undefined) continue
    const rootId = stepAncestors(plan.steps, step.id).at(-1) ?? step.id
    const main = views.get(rootId)
    if (main === undefined) continue
    const children = plan.steps.filter((candidate) => candidate.parentId === rootId)
    currentSteps.push({
      agentId: lane.agentId,
      step,
      main,
      mainIndex: mains.findIndex((candidate) => candidate.id === rootId) + 1,
      mainTotal: mains.length,
      substeps:
        children.length === 0
          ? null
          : {
              done: children.filter((child) => finished(views.get(child.id)?.status)).length,
              total: children.length,
            },
    })
  }

  const forecastLanes = [...lanes.values()].filter(
    (lane) => lane.plan.units.size > 0 || (unestimatedOpen(lane) > 0 && paceOf(lane) !== null)
  )
  let forecast: TaskForecast | null = null
  if (forecastLanes.length > 0) {
    let remainingMs = 0
    let lowMs = 0
    let highMs = 0
    let overrunMs = 0
    let firstForecastMs = 0
    let plannedMs = 0
    let rough = false
    let paced = false
    let openUnits = 0
    for (const lane of forecastLanes) {
      const calibration = factors.get(lane.agentId) ?? {
        factor: 1,
        low: ROUGH_LOW,
        high: ROUGH_HIGH,
        growth: 1,
        confidence: 'rough' as const,
      }
      if (calibration.confidence === 'rough') rough = true
      const pace = paceOf(lane)
      const pacedMs = pace === null ? 0 : unestimatedOpen(lane) * pace
      if (pacedMs > 0) paced = true
      const estimated = laneRemainingMs(lane, calibration.factor)
      const planned = lanePlannedMs(lane)
      const share = planned > 0 ? Math.min(1, estimated / (planned * calibration.factor)) : 0
      remainingMs += estimated + pacedMs
      lowMs += laneRemainingMs(lane, calibration.low) + pacedMs * ROUGH_LOW
      highMs +=
        laneRemainingMs(lane, calibration.high) * (1 + (calibration.growth - 1) * share) +
        pacedMs * ROUGH_HIGH
      firstForecastMs += (lane.firstForecast ?? 0) * MINUTE_MS
      plannedMs += planned
      for (const unit of lane.plan.units.values()) {
        if (unitFinished(lane.plan, unit)) continue
        openUnits += 1
        const budget = unit.estimateMinutes * MINUTE_MS * calibration.factor
        overrunMs += Math.max(0, (lane.spent.get(unit.id) ?? 0) - budget)
      }
    }
    forecast = {
      remainingMs,
      lowMs: Math.min(lowMs, remainingMs),
      highMs: Math.max(highMs, remainingMs),
      overrunMs: remainingMs === 0 && openUnits > 0 ? overrunMs : 0,
      confidence: rough || paced ? 'rough' : 'calibrated',
      partial,
      paced,
      firstForecastMs,
      plannedMs,
    }
  }

  const laneList = [...lanes.values()]
  const laneSettled = (lane: Lane): boolean => {
    if (!planFinished(lane.plan)) return false
    if (lane.completion === 'pending' || lane.completion === 'void') return false
    return lane.completion === 'settled' || agentOf(lane.agentId).lastEnd === 'completed'
  }
  const readyToClose =
    finalClosed === null &&
    working.length === 0 &&
    blocked.length === 0 &&
    paused.length === 0 &&
    awaiting.length === 0 &&
    laneList.length > 0 &&
    laneList.every(laneSettled) &&
    (laneList.some((lane) => lane.completion === 'settled') ||
      laneList.every((lane) => lane.source === 'native'))

  const end = limit()
  return {
    taskId,
    originEventId: opened.originEventId,
    startedAt,
    closedAt: finalClosed?.at ?? null,
    closeReason: finalClosed?.reason ?? null,
    state,
    working,
    waitingOn: [
      ...blocked,
      ...awaiting.map((entry) => ({ agentId: entry.agentId, kind: 'user' as const })),
    ],
    paused,
    readyToClose,
    requestAfterClose:
      finalClosed !== null &&
      marks.some((mark) => mark.kind === 'user' && mark.work && mark.at > finalClosed.at),
    clocks: {
      elapsedMs: Math.max(0, end - startedAt),
      workingMs: clocks.working,
      waitingMs: clocks.waiting,
      pausedMs: clocks.paused,
      idleMs: clocks.idle,
      stoppedMs: clocks.stopped,
      unknownMs: clocks.unknown,
    },
    lanes: laneList.map((lane) => {
      const calibration = factors.get(lane.agentId)
      return {
        agentId: lane.agentId,
        source: lane.source,
        model: agentOf(lane.agentId).model,
        parallel: lane.parallel,
        revisions: lane.revisions,
        workingMs: agentOf(lane.agentId).workingMs,
        firstForecastMinutes: lane.firstForecast,
        finalForecastMinutes: lane.finalForecast,
        speedFactor: calibration?.factor ?? 1,
        confidence: calibration?.confidence ?? 'rough',
        completion: lane.completion,
        finished: planFinished(lane.plan),
        samples: laneSamples(lane),
      }
    }),
    steps,
    current: currentSteps,
    progress: { mainDone, mainTotal, leavesDone, leavesTotal },
    forecast,
    changes,
    asOf: end,
  }
}

export function taskOutcomeOf(snapshot: TaskSnapshot): TaskOutcome {
  return {
    startedAt: snapshot.startedAt,
    elapsedMs: snapshot.clocks.elapsedMs,
    workingMs: snapshot.clocks.workingMs,
    lanes: snapshot.lanes.map((lane) => ({
      agentId: lane.agentId,
      model: lane.model,
      firstForecastMinutes: lane.firstForecastMinutes,
      finalForecastMinutes: lane.finalForecastMinutes,
      workingMs: lane.workingMs,
      samples: lane.samples.map((sample) => ({ ...sample })),
    })),
  }
}
