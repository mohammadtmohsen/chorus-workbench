import type { ActivityPush } from '../../shared/ipc.js'
import type { TaskSnapshot, TaskState } from '../../shared/task-progress.js'
import {
  laneOfOperation,
  workLane,
  type HandoffOutcome,
  type LiveHandoff,
  type LiveOperation,
  type LiveTurn,
  type PendingReply,
} from './transcript.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export type DurationUnit = 'd' | 'h' | 'm' | 's'

export interface DurationPart {
  readonly unit: DurationUnit
  readonly value: number
}

function split(ms: number, units: readonly DurationUnit[]): DurationPart[] {
  const sizes: Record<DurationUnit, number> = { d: DAY_MS, h: HOUR_MS, m: MINUTE_MS, s: 1_000 }
  let rest = Math.max(0, ms)
  const parts = units.map((unit) => {
    const value = Math.floor(rest / sizes[unit])
    rest -= value * sizes[unit]
    return { unit, value }
  })
  const kept = parts.filter((part) => part.value > 0)
  const last = parts.at(-1)
  return kept.length > 0 ? kept : last === undefined ? [] : [{ unit: last.unit, value: 0 }]
}

export function workDurationParts(ms: number): DurationPart[] {
  const step = ms < HOUR_MS ? MINUTE_MS : ms < DAY_MS ? 15 * MINUTE_MS : 30 * MINUTE_MS
  const rounded =
    ms < HOUR_MS ? Math.max(MINUTE_MS, Math.ceil(ms / step) * step) : Math.round(ms / step) * step
  return split(rounded, ['d', 'h', 'm'])
}

export function elapsedParts(ms: number): DurationPart[] {
  if (ms >= DAY_MS) return split(ms, ['d', 'h', 'm'])
  if (ms >= HOUR_MS) return split(ms, ['h', 'm', 's'])
  if (ms >= MINUTE_MS) return split(ms, ['m', 's'])
  return split(ms, ['s'])
}

export type StripForecast =
  | {
      readonly kind: 'remaining'
      readonly pointMs: number
      readonly lowMs: number
      readonly highMs: number
      readonly rough: boolean
      readonly partial: boolean
      readonly frozen: boolean
    }
  | { readonly kind: 'over'; readonly overMs: number; readonly partial: boolean }
  | { readonly kind: 'unestimated' }
  | { readonly kind: 'finishing' }
  | { readonly kind: 'stepsDone' }
  | { readonly kind: 'none' }

export interface StripLane {
  readonly agentId: string
  readonly mainIndex: number
  readonly mainTotal: number
  readonly label: string
  readonly title: string
  readonly substeps: { readonly done: number; readonly total: number } | null
}

export interface StripChange {
  readonly deltaMs: number | null
  readonly added: number
  readonly removed: number
  readonly split: number
  readonly reason: string | null
}

export type StripWaiting = 'approval' | 'question' | 'user'

export type StripModel =
  | {
      readonly kind: 'activity'
      readonly agents: readonly string[]
      readonly elapsedMs: number | null
    }
  | {
      readonly kind: 'task'
      readonly taskId: string
      readonly state: TaskState
      readonly waiting: StripWaiting | null
      readonly closed: boolean
      readonly elapsedMs: number
      readonly waitingMs: number
      readonly pausedMs: number
      readonly resetsAt: number | null
      readonly forecast: StripForecast
      readonly lanes: readonly StripLane[]
      readonly progress: { readonly done: number; readonly total: number } | null
      readonly change: StripChange | null
    }

export interface StripInput {
  readonly snapshot: TaskSnapshot | null
  readonly syncing: boolean
  readonly working: readonly string[]
  readonly workingSince: Readonly<Record<string, number>>
  readonly now: number
}

const MATERIAL_DELTA_MS = MINUTE_MS

function activity(input: StripInput): StripModel | null {
  if (input.working.length === 0) return null
  const starts = input.working.flatMap((agent) => {
    const at = input.workingSince[agent]
    return at === undefined ? [] : [at]
  })
  return {
    kind: 'activity',
    agents: [...input.working],
    elapsedMs: starts.length === 0 ? null : Math.max(0, input.now - Math.min(...starts)),
  }
}

function forecastOf(snapshot: TaskSnapshot): StripForecast {
  const forecast = snapshot.forecast
  const working = snapshot.state === 'working'
  const allDone = snapshot.lanes.length > 0 && snapshot.lanes.every((lane) => lane.finished)
  if (allDone) return working ? { kind: 'finishing' } : { kind: 'stepsDone' }
  if (forecast === null) return { kind: 'none' }
  if (forecast.overrunMs > 0) {
    return { kind: 'over', overMs: forecast.overrunMs, partial: forecast.partial }
  }
  if (forecast.remainingMs === 0) {
    return forecast.partial ? { kind: 'unestimated' } : { kind: 'over', overMs: 0, partial: false }
  }
  return {
    kind: 'remaining',
    pointMs: forecast.remainingMs,
    lowMs: forecast.lowMs,
    highMs: forecast.highMs,
    rough: forecast.confidence === 'rough',
    partial: forecast.partial,
    frozen: !working,
  }
}

function changeOf(snapshot: TaskSnapshot): StripChange | null {
  const material = snapshot.changes.findLast(
    (change) =>
      change.added.length + change.removed.length + change.split.length > 0 ||
      change.reason !== null ||
      (change.remainingDeltaMs !== null && Math.abs(change.remainingDeltaMs) >= MATERIAL_DELTA_MS)
  )
  if (material === undefined) return null
  return {
    deltaMs:
      material.remainingDeltaMs === null || Math.abs(material.remainingDeltaMs) < MATERIAL_DELTA_MS
        ? null
        : material.remainingDeltaMs,
    added: material.added.length,
    removed: material.removed.length,
    split: material.split.length,
    reason: material.reason,
  }
}

export function taskStrip(input: StripInput): StripModel | null {
  const { snapshot } = input
  if (snapshot === null || input.syncing) return activity(input)
  const closed = snapshot.closedAt !== null
  const closedAt = snapshot.closedAt ?? Infinity
  const newerWork = input.working.some(
    (agent) => (input.workingSince[agent] ?? -Infinity) > closedAt
  )
  if (closed && (newerWork || snapshot.requestAfterClose)) return activity(input)
  const waiting = snapshot.state === 'waiting' ? (snapshot.waitingOn[0]?.kind ?? null) : null
  const resets = snapshot.paused.flatMap((entry) =>
    entry.resetsAt === null ? [] : [entry.resetsAt]
  )
  return {
    kind: 'task',
    taskId: snapshot.taskId,
    state: snapshot.state,
    waiting,
    closed,
    elapsedMs: snapshot.clocks.elapsedMs,
    waitingMs: snapshot.clocks.waitingMs,
    pausedMs: snapshot.clocks.pausedMs,
    resetsAt: snapshot.state === 'paused' && resets.length > 0 ? Math.min(...resets) : null,
    forecast: closed ? { kind: 'none' } : forecastOf(snapshot),
    lanes: closed
      ? []
      : snapshot.current.map((current) => ({
          agentId: current.agentId,
          mainIndex: current.mainIndex,
          mainTotal: current.mainTotal,
          label: current.step.label,
          title: current.step.title,
          substeps: current.substeps,
        })),
    progress:
      snapshot.progress.mainTotal > 0
        ? { done: snapshot.progress.mainDone, total: snapshot.progress.mainTotal }
        : null,
    change: closed ? null : changeOf(snapshot),
  }
}

export function tickingStrip(model: StripModel | null): boolean {
  if (model === null) return false
  return model.kind === 'activity' ? model.elapsedMs !== null : !model.closed
}

export type LivePhase = NonNullable<ActivityPush['activity']> | 'working' | 'queued' | 'replying'

export interface StripOperation {
  readonly kind: 'tool' | 'command'
  readonly name: string
  readonly detail: string | null
  readonly forMs: number
}

export interface StripLiveRow {
  readonly key: string
  readonly agentId: string
  readonly mode: 'work' | 'chat'
  readonly phase: LivePhase
  readonly blocked: 'approval' | 'question' | null
  readonly operation: StripOperation | null
  readonly moreOperations: number
  readonly from: string | null
  readonly elapsedMs: number | null
  readonly updatedMs: number | null
}

export interface StripHandoffLine {
  readonly handoffId: string
  readonly from: string
  readonly to: string
  readonly outcome: HandoffOutcome | 'pending'
  readonly ageMs: number
}

export interface LiveStrip {
  readonly rows: readonly StripLiveRow[]
  readonly handoffs: readonly StripHandoffLine[]
  readonly mixed: boolean
}

export interface LiveWait {
  readonly agentId: string
  readonly mode?: 'chat' | undefined
  readonly requestId?: string | undefined
}

export interface LiveSource {
  readonly working: readonly string[]
  readonly workingSince: Readonly<Record<string, number>>
  readonly turns: Readonly<Record<string, LiveTurn>>
  readonly replies: readonly PendingReply[]
  readonly operations: readonly LiveOperation[]
  readonly evidenceAt: Readonly<Record<string, number>>
  readonly handoffs: readonly LiveHandoff[]
  readonly approvals: readonly LiveWait[]
  readonly questions: readonly LiveWait[]
  readonly activity: Readonly<Record<string, ActivityPush['activity']>>
}

const LABEL_LIMIT = 160
const HANDOFF_LINES = 3

function oneLine(text: string): string {
  const first = text.split('\n', 1)[0] ?? ''
  return first.length > LABEL_LIMIT ? `${first.slice(0, LABEL_LIMIT - 1)}…` : first
}

export function liveStrip(source: LiveSource, now: number): LiveStrip {
  const age = (at: number | undefined): number | null =>
    at === undefined ? null : Math.max(0, now - at)

  const byLane = new Map<string, LiveOperation[]>()
  for (const operation of source.operations) {
    const lane = laneOfOperation(operation)
    byLane.set(lane, [...(byLane.get(lane) ?? []), operation])
  }
  const observed = (lane: string): Pick<StripLiveRow, 'operation' | 'moreOperations'> => {
    const open = byLane.get(lane) ?? []
    const newest = open.reduce<LiveOperation | null>(
      (latest, operation) =>
        latest === null || operation.startedAt >= latest.startedAt ? operation : latest,
      null
    )
    return {
      operation:
        newest === null
          ? null
          : {
              kind: newest.kind,
              name: oneLine(newest.name),
              detail: newest.detail === null ? null : oneLine(newest.detail),
              forMs: Math.max(0, now - newest.startedAt),
            },
      moreOperations: Math.max(0, open.length - 1),
    }
  }
  const blockedBy = (matches: (wait: LiveWait) => boolean): StripLiveRow['blocked'] =>
    source.approvals.some(matches) ? 'approval' : source.questions.some(matches) ? 'question' : null

  const work = source.working.map((agentId): StripLiveRow => {
    const lane = workLane(agentId)
    return {
      key: lane,
      agentId,
      mode: 'work',
      phase: source.activity[agentId] ?? 'working',
      blocked: blockedBy((wait) => wait.agentId === agentId && wait.mode !== 'chat'),
      ...observed(lane),
      from: null,
      elapsedMs: age(source.turns[agentId]?.startedAt ?? source.workingSince[agentId]),
      updatedMs: age(source.evidenceAt[lane]),
    }
  })

  const chat = source.replies.map((reply): StripLiveRow => {
    const onlyRequest =
      source.replies.filter((other) => other.agentId === reply.agentId).length === 1
    return {
      key: reply.requestId,
      agentId: reply.agentId,
      mode: 'chat',
      phase: reply.phase === 'waiting' ? 'queued' : reply.phase,
      blocked: blockedBy(
        (wait) =>
          wait.mode === 'chat' &&
          (wait.requestId === undefined
            ? onlyRequest && wait.agentId === reply.agentId
            : wait.requestId === reply.requestId)
      ),
      ...observed(reply.requestId),
      from: reply.from,
      elapsedMs: age(reply.startedAt),
      updatedMs: age(source.evidenceAt[reply.requestId]),
    }
  })

  const when = (handoff: LiveHandoff): number => handoff.outcomeAt ?? handoff.createdAt ?? now
  const handoffs = [...source.handoffs]
    .sort((left, right) => when(left) - when(right))
    .slice(-HANDOFF_LINES)
    .map((handoff): StripHandoffLine => ({
      handoffId: handoff.handoffId,
      from: handoff.from,
      to: handoff.to,
      outcome: handoff.outcome ?? 'pending',
      ageMs: Math.max(0, now - when(handoff)),
    }))

  return { rows: [...work, ...chat], handoffs, mixed: work.length > 0 && chat.length > 0 }
}

export function tickingLive(live: LiveStrip): boolean {
  return live.rows.length > 0 || live.handoffs.length > 0
}
