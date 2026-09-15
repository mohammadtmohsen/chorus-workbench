import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'

/**
 * Phase 1 of docs/plans/guided-collaboration-2026-09-12/plan.md: knowing when a
 * dispatched agent has finished, and when it is provably free again.
 *
 * Those are two different questions with two different answers, which is the
 * whole design. `result` serves the user and is cancellable; `drained` serves
 * the next run and is not. Aborting settles the first and leaves the second
 * watching, because ownership can only end on events that arrive afterwards —
 * and revision 9 tore down the one subscription that would have seen them.
 *
 * Nothing here reads `turnRef`. Claude's `turn.started` ref is invented in its
 * adapter and its `turn.completed` ref is the SDK's uuid, which can be the empty
 * string, so the two cannot be correlated at all (claude-adapter.ts:251).
 * Exclusivity is what makes counting sound instead.
 */

/** Delivery to `turn.started`. Beyond this a turn is unbounded. */
export const ACKNOWLEDGEMENT_MS = 60_000

/**
 * Any event from the agent to its next one.
 *
 * Not a cap on thinking: a working agent emits deltas, tool events and command
 * output continuously. It is the only bound that covers a turn lost to a
 * supervisor restart, which resends nothing and synthesizes no completion
 * (supervisor.ts:302).
 */
export const IDLE_MS = 300_000

export type DispatchFailure =
  | 'aborted'
  | 'acknowledgement'
  | 'delivery'
  | 'foreignTurn'
  | 'idle'
  | 'noReply'
  | 'sessionEnded'
  | 'turnFailed'

export type DispatchResult =
  | { readonly status: 'completed'; readonly eventId: string; readonly text: string }
  | { readonly status: 'failed'; readonly reason: DispatchFailure }

/** Injected so a test is not at the mercy of the clock, as `Scheduler` is. */
export interface Clock {
  readonly setTimeout: (fn: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/**
 * The store, narrowed to what a dispatch needs.
 *
 * `subscribe` is global — one listener set notified after every commit — so
 * every consumer here filters `conversationId` first.
 */
export interface EventFeed {
  readonly subscribe: (listener: (events: readonly StoredEvent[]) => void) => () => void
  readonly lastSeq: () => number
}

export interface DispatchRequest {
  readonly conversationId: string
  readonly agentId: AgentId
  /**
   * Captured before delivering, because proof of release is a `session.ended`
   * carrying *this* ref rather than one naming the agent.
   *
   * The case it was written for was `removeParticipant`, which deleted the
   * participant before awaiting its close — so an end could arrive for a session
   * the map no longer held. That method is gone with the fixed cast, and the
   * reasoning is not: `endConversation` and a failed resume both end a session
   * whose ref is the only thing that identifies *which* one, and an agent
   * restarted under the same name gets a new ref.
   */
  readonly sessionRef: string
  /** Started, never awaited before the watch: a hung deliver would hang the wait. */
  readonly deliver: () => Promise<void>
  readonly signal: AbortSignal
}

export interface Dispatch {
  /** The reply, or a named failure. Settled by abort. */
  readonly result: Promise<DispatchResult>
  /** Resolves only on proof that the agent is free. Never settled by abort. */
  readonly drained: Promise<void>
}

/**
 * Where the agent's current session begins.
 *
 * A crash leaves `turn.started` unmatched, and `reconcileOrphanedSessions`
 * appends a `session.ended` on the next boot with a fresh `session.started` when
 * the agent rejoins — so counting the whole history would call that agent busy
 * forever.
 */
export function sessionEpochStart(events: readonly StoredEvent[], agentId: AgentId): number {
  let start = 0
  for (const event of events) {
    const payload = event.payload
    if (payload.type === 'session.started' && payload.agentId === agentId) start = event.seq
  }
  return start
}

/**
 * Open turns for one agent inside its current session epoch.
 *
 * Attributed by `event.actor`: neither turn payload names an agent, and
 * `lifecycle` appends both with the adapter's own id
 * (conversation-service.ts:1081).
 */
export function openTurnDepth(events: readonly StoredEvent[], agentId: AgentId): number {
  const epoch = sessionEpochStart(events, agentId)
  let depth = 0
  for (const event of events) {
    if (event.seq <= epoch) continue
    if (event.actor !== agentId) continue
    if (event.payload.type === 'turn.started') depth += 1
    if (event.payload.type === 'turn.completed') depth -= 1
  }
  return depth
}

export function agentIsBusy(events: readonly StoredEvent[], agentId: AgentId): boolean {
  return openTurnDepth(events, agentId) > 0
}

/**
 * Whether the agent is waiting on a person, which is not the same as idle.
 *
 * A question is registered with no timer at all and an approval waits on a
 * card, so a turn can be legitimately silent for hours and resume the moment
 * someone answers. **Every way a card closes counts**: an agent that abandons
 * its own request produces `approval.withdrawn` and never an
 * `approval.decided`, and counting only decisions would suspend the idle clock
 * for the rest of the run.
 */
export function cardIsOpen(events: readonly StoredEvent[], agentId: AgentId): boolean {
  const epoch = sessionEpochStart(events, agentId)
  const open = new Set<string>()
  for (const event of events) {
    if (event.seq <= epoch) continue
    trackCard(open, event, agentId)
  }
  return open.size > 0
}

/** True when this event opened or closed a card, so a caller can re-arm the clock. */
function trackCard(open: Set<string>, event: StoredEvent, agentId: AgentId): boolean {
  const payload = event.payload
  if (payload.type === 'approval.requested') {
    if (event.actor !== agentId) return false
    open.add(`approval:${payload.approvalId}`)
    return true
  }
  if (payload.type === 'approval.decided' || payload.type === 'approval.withdrawn') {
    return open.delete(`approval:${payload.approvalId}`)
  }
  if (payload.type === 'userinput.requested') {
    if (event.actor !== agentId) return false
    open.add(`question:${payload.userInputId}`)
    return true
  }
  if (payload.type === 'userinput.answered') {
    return open.delete(`question:${payload.userInputId}`)
  }
  return false
}

/**
 * Delivers to one agent and watches for its reply.
 *
 * The subscription opens before the watermark is taken and before anything is
 * delivered, so an event appended in between still arrives and is filtered by
 * `seq`. A turn already running when this starts would otherwise satisfy the
 * wait, which is why the caller refuses to dispatch to a busy agent.
 */
export function dispatchAndWatch(
  feed: EventFeed,
  request: DispatchRequest,
  clock: Clock = realClock
): Dispatch {
  const watch = new TurnWatch(feed, request, clock)
  watch.start()
  return { result: watch.result, drained: watch.drained }
}

class TurnWatch {
  readonly result: Promise<DispatchResult>
  readonly drained: Promise<void>

  private settleResult!: (result: DispatchResult) => void
  private settleDrained!: () => void
  private resultSettled = false
  private drainedSettled = false

  private watermark = 0
  private depth = 0
  private started = false
  /** False once anything but this dispatch could have started a turn here. */
  private attributable = true
  private delivered = false
  private lastMessage: { eventId: string; text: string } | null = null
  private readonly openCards = new Set<string>()

  private unsubscribe: (() => void) | null = null
  private acknowledgementTimer: unknown = null
  private idleTimer: unknown = null

  private readonly onAbort = (): void => {
    this.finishResult({ status: 'failed', reason: 'aborted' })
    /*
     * The deadlines only ever fed `result`, so they are dead weight now — but
     * the subscription is not. Ownership still needs a proof, and if none
     * arrives the run shows as terminal-and-draining and offers Restart.
     */
    this.clearTimers()
    if (!this.delivered) this.release()
  }

  constructor(
    private readonly feed: EventFeed,
    private readonly request: DispatchRequest,
    private readonly clock: Clock
  ) {
    this.result = new Promise<DispatchResult>((resolve) => {
      this.settleResult = resolve
    })
    this.drained = new Promise<void>((resolve) => {
      this.settleDrained = resolve
    })
  }

  start(): void {
    if (this.request.signal.aborted) {
      this.finishResult({ status: 'failed', reason: 'aborted' })
      this.release()
      return
    }

    this.unsubscribe = this.feed.subscribe((events) => {
      this.receive(events)
    })
    this.watermark = this.feed.lastSeq()
    this.request.signal.addEventListener('abort', this.onAbort)

    this.acknowledgementTimer = this.clock.setTimeout(() => {
      if (this.started) return
      this.finishResult({ status: 'failed', reason: 'acknowledgement' })
    }, ACKNOWLEDGEMENT_MS)

    this.delivered = true
    /*
     * Not awaited before the watch, and its rejection is always consumed: a
     * `deliver` that settles late — or rejects after an abort — must not surface
     * as an unhandled rejection out of a pump nobody awaits.
     *
     * A rejection is not proof the request was never accepted. `sendOnce` writes
     * to the transport inside the promise and a later timer rejects it
     * (adapter-codex/src/rpc.ts:138), so it fails the run and frees nobody.
     */
    this.request.deliver().catch(() => {
      if (this.started) return
      this.finishResult({ status: 'failed', reason: 'delivery' })
    })
  }

  private receive(events: readonly StoredEvent[]): void {
    for (const event of events) {
      if (this.drainedSettled) return
      if (event.conversationId !== this.request.conversationId) continue
      if (event.seq <= this.watermark) continue
      this.consider(event)
    }
  }

  private consider(event: StoredEvent): void {
    const payload = event.payload

    /*
     * Any user message costs attribution, whoever it was addressed to. The log
     * does not record the routing, so narrowing this to the owned agent would
     * mean guessing — and the whole point of attribution is not guessing.
     */
    if (payload.type === 'user.message') this.attributable = false

    if (trackCard(this.openCards, event, this.request.agentId)) this.armIdle()

    if (
      payload.type === 'session.ended' &&
      payload.agentId === this.request.agentId &&
      payload.sessionRef === this.request.sessionRef
    ) {
      this.finishResult({ status: 'failed', reason: 'sessionEnded' })
      this.release()
      return
    }

    if (event.actor !== this.request.agentId) return

    if (payload.type === 'agent.message.completed') {
      this.lastMessage = { eventId: event.id, text: payload.text }
    }

    if (payload.type === 'error.raised' && !payload.recoverable) {
      this.finishResult({ status: 'failed', reason: 'turnFailed' })
    }

    if (payload.type === 'turn.started') {
      if (this.started) {
        this.attributable = false
        this.finishResult({ status: 'failed', reason: 'foreignTurn' })
      } else {
        this.started = true
        this.clock.clearTimeout(this.acknowledgementTimer)
        this.acknowledgementTimer = null
      }
      this.depth += 1
    }

    if (payload.type === 'turn.completed') {
      this.depth -= 1
      if (this.started && this.depth <= 0) {
        this.finishTurn(payload.status)
        return
      }
    }

    this.armIdle()
  }

  private finishTurn(status: 'completed' | 'interrupted' | 'failed'): void {
    if (status !== 'completed') {
      this.finishResult({ status: 'failed', reason: 'turnFailed' })
    } else if (this.lastMessage === null) {
      this.finishResult({ status: 'failed', reason: 'noReply' })
    } else {
      this.finishResult({
        status: 'completed',
        eventId: this.lastMessage.eventId,
        text: this.lastMessage.text,
      })
    }
    if (this.attributable) this.release()
  }

  private armIdle(): void {
    this.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.started) return
    if (this.resultSettled) return
    if (this.openCards.size > 0) return
    this.idleTimer = this.clock.setTimeout(() => {
      this.finishResult({ status: 'failed', reason: 'idle' })
    }, IDLE_MS)
  }

  private finishResult(result: DispatchResult): void {
    if (this.resultSettled) return
    this.resultSettled = true
    this.settleResult(result)
  }

  private release(): void {
    if (this.drainedSettled) return
    this.drainedSettled = true
    this.clearTimers()
    this.request.signal.removeEventListener('abort', this.onAbort)
    this.unsubscribe?.()
    this.unsubscribe = null
    this.settleDrained()
  }

  private clearTimers(): void {
    this.clock.clearTimeout(this.acknowledgementTimer)
    this.clock.clearTimeout(this.idleTimer)
    this.acknowledgementTimer = null
    this.idleTimer = null
  }
}

/**
 * Phase 2: the coordinator.
 *
 * Four steps, each of which dispatches, waits, and moves. There is no branch
 * that dispatches nothing and no path that does not reach one of the five
 * `RunState` phases — a finished agent does not start another turn on its own,
 * so "carry on" is a message like every other hop.
 */

/**
 * How a run is driven. One shape, named for what it does.
 *
 * `oneShot` was a two-hop review and is gone; `guided` was the other and is now
 * this. A single-member union rather than dropping the field: the preset is on
 * the IPC and in every status, and the pipeline is one of several a run could
 * take rather than the only one there will ever be.
 */
export type Preset = 'delivery' | 'build'
export type Step = 'reviewPlan' | 'split' | 'implement' | 'accept' | 'report'
export type Verdict = 'ready' | 'objections' | 'unparsed'
export type Outcome = 'agreed' | 'unresolved' | 'unsplit' | 'tooManyTasks'
export type Ownership = 'owned' | 'unattributable' | 'free'
export type HandoffIntent = 'review' | 'implement' | 'discuss'
export type CancelCause = 'stop' | 'userMessage' | 'manualHandoff' | 'shutdown'

export type RunState =
  | { readonly phase: 'running'; readonly step: Step }
  | { readonly phase: 'finished'; readonly outcome: Outcome }
  | { readonly phase: 'cancelled'; readonly by: CancelCause }
  | { readonly phase: 'interrupted'; readonly reason: 'foreignTurn' }
  | {
      readonly phase: 'failed'
      readonly reason:
        'delivery' | 'acknowledgement' | 'idle' | 'turnFailed' | 'noReply' | 'sessionEnded'
    }

export interface RunStatus {
  readonly conversationId: string
  /** Monotonic per conversation, across runs. The only ordering key. */
  readonly statusVersion: number
  readonly runId: string
  readonly state: RunState
  /** True while either agent is still owned. Sends are unaffected by it. */
  readonly draining: boolean
  readonly ownership: Ownership
  readonly preset: Preset
  readonly stepIndex: number
  /**
   * How many hops this run will take, or null while that is not yet known.
   *
   * The count is `3 + 2 × tasks` and nothing can compute it until the planner's
   * split has been read — so the honest value before then is "not yet", and the
   * row that draws it has to survive not knowing rather than print a number
   * nobody computed.
   */
  readonly stepTotal: number | null
}

export interface HandoffDispatch {
  readonly conversationId: string
  readonly from: AgentId
  readonly to: AgentId
  readonly sourceEventIds: readonly string[]
  readonly intent: HandoffIntent
  readonly note: string
}

export interface CoordinatorPort {
  /**
   * Appends `handoff.created` and delivers it **without advancing `seenSeq`**.
   *
   * `sendHandoff` assigns `target.seenSeq = store.lastSeq()` unconditionally
   * (runtime.ts:2806), and a scalar watermark cannot say which events were
   * shown — so moving it would mark the user's original request as seen by an
   * agent that was never shown it.
   */
  readonly handoff: (input: HandoffDispatch) => Promise<void>
  /** Null when that agent is not in the room. */
  readonly sessionRef: (conversationId: string, agentId: AgentId) => string | null
  readonly watch: (request: DispatchRequest) => Dispatch
  readonly read: (conversationId: string) => readonly StoredEvent[]
  readonly nextStatusVersion: (conversationId: string) => number
  readonly onStatus: (status: RunStatus) => void
  readonly newRunId: () => string
}

/**
 * Why a run was refused, decided in main.
 *
 * `busy` names the agent whose turn the log never closed, because a refusal
 * that says what to do is the difference between a feature that looks broken
 * and one that is honest — and a supervisor restart appends no new
 * `session.started`, so the epoch rule cannot clear it.
 */
export type CollaborationRefusal =
  | 'running'
  | 'draining'
  | 'missingAgent'
  | 'unknownEvent'
  | 'notAgentMessage'
  | 'notPlanner'
  | 'busy'

export type CollaborationStart =
  | { readonly outcome: 'started'; readonly runId: string }
  | {
      readonly outcome: 'refused'
      readonly reason: CollaborationRefusal
      readonly agentId: AgentId | null
    }

export interface RunRequest {
  readonly conversationId: string
  readonly preset: Preset
  /** The completed Claude reply the run starts from. */
  readonly sourceEventId: string
}

export const VERDICT_PROTOCOL = [
  'Begin your reply with exactly one of these as the first line:',
  'verdict: ready',
  'verdict: objections',
  'Then a blank line, then your review.',
].join('\n')

/**
 * The cast, by role rather than by pair.
 *
 * `WORKER` and `GUIDE` were the old names and they described a two-sided
 * exchange: one produced, the other checked. That shape cannot hold a third
 * agent whose job is neither — DeepSeek codes and does not think about what to
 * code — so the roles are named for what each one is asked for.
 *
 * `CODER` is unused until the micro-task loop exists. It is declared here now
 * because the role is the thing this rename is for, and a role that appears
 * later reads as an afterthought.
 */
export const PLANNER: AgentId = 'claude'
export const REVIEWER: AgentId = 'codex'
export const CODER: AgentId = 'deepseek'

/**
 * Which agents a run of this preset needs in the room.
 *
 * A list rather than a hardcoded pair, because the pipeline's cast is about to
 * differ per preset and the caller — `runtime.ts` — has to refuse on exactly the
 * same set this file dispatches to. Two places deciding that separately is two
 * places to disagree.
 */
export function rolesFor(preset: Preset): readonly AgentId[] {
  /*
   * `build` skips the plan review, so it needs no reviewer seated — that is the
   * whole point of it. A project with only Claude can run it, and `runtime.ts`
   * refuses a start on exactly this list, so returning the reviewer here would
   * make the preset impossible in the rooms it exists for.
   *
   * The coder is in neither list: it is the one agent whose absence is
   * survivable, and a run without it falls back to the planner writing its own
   * micro-tasks.
   */
  return preset === 'build' ? [PLANNER] : [PLANNER, REVIEWER]
}

/**
 * How many micro-tasks a run will deliver, and how many times one may come back.
 *
 * **Both are spend limits, not correctness limits**, which is why they are named
 * and sit together rather than being buried at their call sites. Each delivered
 * task is a turn from the coder and a turn from the planner; each re-issue is
 * another pair. A planner that never accepts one task is otherwise unbounded
 * spend across two providers.
 *
 * An over-long list is **refused rather than truncated**. Delivering 20 of 25
 * quietly would leave five tasks nobody did and a report that did not say so.
 */
export const MAX_MICRO_TASKS = 20
export const MAX_REISSUES = 3

/**
 * Whether a run may start here.
 *
 * Exported because the IPC boundary is the one that has to refuse, and it
 * refuses with a reason: an unmatched `turn.started` inside the current session
 * epoch is a turn the log never closed, and restarting that agent is what
 * clears it.
 */
export function preflight(
  events: readonly StoredEvent[]
): { readonly ok: true } | { readonly ok: false; readonly busy: AgentId } {
  for (const agentId of rolesFor('delivery')) {
    if (agentIsBusy(events, agentId)) return { ok: false, busy: agentId }
  }
  return { ok: true }
}

/**
 * The verdict, read from the first nonblank line and nowhere else.
 *
 * Anchoring is the point: scanning for `verdict:` anywhere would let a sentence
 * quoting this protocol decide the loop. Emphasis and a list marker are stripped
 * because a reviewer writing `**verdict: ready**` meant the verdict, and an
 * envelope that only ever parses when unformatted would make `unparsed` the
 * common case rather than the exception.
 */
export function parseVerdict(text: string): Verdict {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (first === undefined) return 'unparsed'
  const bare = first
    .replace(/^[-*>\s]+/, '')
    .replace(/[*_`]+/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (bare === 'verdict: ready') return 'ready'
  if (bare === 'verdict: objections') return 'objections'
  return 'unparsed'
}

/**
 * What the planner is asked to end its split with.
 *
 * Deliberately shaped so the machine-readable part is **last**. A verdict is one
 * word and goes first, where nothing can precede it; a task list is long and
 * follows a plan that will quote and discuss it, so the only place it can sit
 * unambiguously is the end.
 */
export const TASK_PROTOCOL = [
  'End your reply with the plan split into micro-tasks.',
  'The last thing in your reply must be a line that is exactly:',
  'tasks:',
  'then one task per line, each beginning with "- ".',
  'One task is one change a coder can make without deciding anything.',
  'Write nothing after the last task.',
].join('\n')

/** Emphasis and list markers stripped, the way `parseVerdict` strips them. */
function bare(line: string): string {
  return line
    .replace(/^[-*>\s]+/, '')
    .replace(/[*_`]+/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/** One task line, or null when this line ends the list. */
function taskText(line: string): string | null {
  const marked = /^(?:[-*\u2022]|\d+[.)])\s+(.*)$/.exec(line)
  if (marked === null) return null
  return (marked[1] ?? '').trim()
}

/**
 * The micro-tasks, read from the **last** `tasks:` line and nowhere else.
 *
 * Anchoring is the point, and it is anchored at the opposite end from
 * `parseVerdict` for the opposite reason. A verdict is the first nonblank line
 * because nothing legitimate precedes it. A split is preceded by the whole plan,
 * which will quote this protocol while explaining what it is about to do — so
 * taking the *first* anchor would let a sentence about the list become the list.
 *
 * **The failure mode is deliberately an empty list rather than a wrong one.** A
 * reply that mentions `tasks:` after its real block finds no task lines under
 * that later anchor and returns nothing, which the caller treats as unparsed and
 * can ask again for. A parser that guessed would instead dispatch prose to a
 * coder as though it were work.
 *
 * **No cap here.** A run bounds how many tasks it will accept, because that is a
 * spend decision and belongs where the spending happens; a parser that silently
 * truncated would hide a malformed split rather than report one.
 */
export function parseMicroTasks(text: string): readonly string[] {
  const lines = text.split('\n').map((line) => line.trimEnd())
  let anchor = -1
  for (const [index, line] of lines.entries()) {
    if (bare(line) === 'tasks:') anchor = index
  }
  if (anchor === -1) return []

  const tasks: string[] = []
  for (const line of lines.slice(anchor + 1)) {
    const trimmed = line.trim()
    /*
     * A blank line between tasks is skipped rather than treated as the end.
     * Models space lists out, and ending on the first blank would take one task
     * from a list of nine and call it the plan.
     */
    if (trimmed === '') continue
    const task = taskText(trimmed)
    if (task === null) break
    if (task !== '') tasks.push(task)
  }
  return tasks
}

/** What each hop is asked for. `implement` is never used — see the plan's §3. */
function noteFor(step: Step): { intent: HandoffIntent; note: string } {
  switch (step) {
    case 'reviewPlan':
      return {
        intent: 'review',
        note:
          `${VERDICT_PROTOCOL}\n\n` +
          'Review the plan below. Say what it gets wrong, and plan the parts it ' +
          'leaves too large to hand to a coder without further decisions.',
      }
    case 'split':
      return {
        intent: 'discuss',
        note:
          'Take the review above into the plan, then split the result into ' +
          'micro-tasks. Each one is a single change a coder can make without ' +
          `deciding anything.\n\n${TASK_PROTOCOL}`,
      }
    case 'implement':
      return {
        intent: 'implement',
        note:
          'Do exactly this one task and nothing else. Do not plan, do not ' +
          'refactor beyond it, and do not start the next one.',
      }
    case 'accept':
      return {
        intent: 'review',
        note:
          `${VERDICT_PROTOCOL}\n\n` +
          'Say whether the work above does the one task it was given. Judge only ' +
          'that task.',
      }
    case 'report':
      return {
        intent: 'discuss',
        note:
          'State where this ended: which micro-tasks landed, which did not, and ' +
          'anything still open. Report only — do not start new work.',
      }
  }
}

interface Hop {
  readonly step: Step
  readonly from: AgentId
  readonly to: AgentId
  readonly sourceEventIds: readonly string[]
  /**
   * The one micro-task this hop is about, quoted into the note.
   *
   * Quoted rather than referred to: the coder is handed the transcript so far
   * and "do task 4" would make it count a list it may be reading in a different
   * order than the planner wrote it.
   */
  readonly task?: string
}

/**
 * One run, in memory, for one conversation.
 *
 * If the app dies the run dies, and the transcript still holds every dispatch
 * and every reply because each hop was a `handoff.created` and each reply an
 * ordinary agent message. That is the whole benefit of not making it durable:
 * there is no state left behind to be wrong about.
 */
export class CollaborationRun {
  readonly runId: string
  private readonly controller = new AbortController()
  private readonly outstanding = new Set<Promise<void>>()
  private state: RunState = { phase: 'running', step: 'reviewPlan' }
  private attributable = true
  private stepIndex = 0
  private cancelledBy: CancelCause | null = null
  /** The planner's split, once read. Null means it has not been asked for yet. */
  private tasks: readonly string[] | null = null

  private current: RunStatus

  constructor(
    private readonly port: CoordinatorPort,
    private readonly request: RunRequest
  ) {
    this.runId = port.newRunId()
    this.current = this.compose()
  }

  /** Resolves when the run reaches a terminal state, not when the agents are free. */
  async start(): Promise<RunState> {
    const ready = preflight(this.port.read(this.request.conversationId))
    if (!ready.ok) {
      this.state = { phase: 'failed', reason: 'sessionEnded' }
      this.publish()
      return this.state
    }

    return this.deliver()
  }

  /**
   * The delivery pipeline: the plan is reviewed, then split into micro-tasks.
   *
   * The run starts from a completed planner reply, and **that reply is the
   * plan** — you ask for one in the ordinary way and then start a run on the
   * answer. Nothing here dispatches a planning turn of its own.
   *
   * Stops at the split. The micro-task loop and the closing report are the next
   * two phases, and a run that ended here having produced a readable list has
   * done everything this phase claims to.
   */
  /**
   * Who implements, which is not always DeepSeek.
   *
   * `sessionRef` is null for an agent that is not in the room, which covers both
   * ways the coder can be missing — not in the cast, and no API key, since an
   * adapter that refuses to start never produces a session. The fallback is the
   * planner doing its own micro-tasks, which is slower and costs the planner's
   * provider rather than failing the run outright.
   */
  private coder(): AgentId {
    const seated = this.port.sessionRef(this.request.conversationId, CODER)
    return seated === null ? PLANNER : CODER
  }

  private async deliver(): Promise<RunState> {
    /*
     * `build` starts at the split. It exists for the case where the plan is
     * already agreed — you have discussed it with the planner and you are
     * satisfied — so a review hop would re-open a question you have closed.
     */
    let source = this.request.sourceEventId
    if (this.request.preset === 'delivery') {
      const reviewed = await this.hop({
        step: 'reviewPlan',
        from: PLANNER,
        to: REVIEWER,
        sourceEventIds: [source],
      })
      if (reviewed === null) return this.state
      source = reviewed.eventId
    }

    const split = await this.hop({
      step: 'split',
      /*
       * Whoever actually spoke last. With a review that is the reviewer; without
       * one the planner is handing to itself, which is the only truthful sender
       * when nobody else has taken a turn.
       */
      from: this.request.preset === 'delivery' ? REVIEWER : PLANNER,
      to: PLANNER,
      sourceEventIds: [source],
    })
    if (split === null) return this.state

    /*
     * Assigning this is what makes `stepTotal` a number: until the split is
     * read the run genuinely does not know how long it is.
     */
    this.tasks = parseMicroTasks(split.text)
    this.publish()

    /*
     * An unreadable split is its own outcome, not a failure. The planner
     * answered and the turn succeeded — what is missing is a list a machine can
     * act on, and saying `unverified` would blame the reviewer for it.
     */
    if (this.tasks.length === 0) return this.finish('unsplit')
    /*
     * Refused rather than truncated. Delivering the first twenty of twenty-five
     * would leave five tasks nobody did and a report that did not say so.
     */
    if (this.tasks.length > MAX_MICRO_TASKS) return this.finish('tooManyTasks')

    const delivered = await this.deliverTasks(this.tasks, split.eventId)
    if (delivered === null) return this.state

    /*
     * The closing report, and it is a handoff from the planner to itself.
     *
     * There is no other truthful sender: the planner took the last turn, either
     * accepting the final task or refusing one. Asking the reviewer to report
     * would put a summary in the mouth of an agent that has not seen the work
     * since it reviewed the plan.
     *
     * Only reached when something was delivered. `unsplit` and `tooManyTasks`
     * end before any task is sent, and a report on a run that did nothing is a
     * turn spent restating what the transcript already shows.
     */
    const reported = await this.hop({
      step: 'report',
      from: PLANNER,
      to: PLANNER,
      sourceEventIds: [delivered.lastEventId],
    })
    if (reported === null) return this.state

    return this.finish(delivered.outcome)
  }

  /**
   * One micro-task at a time, each checked before the next is sent.
   *
   * Sequential because it was asked for and because it is the only version where
   * a rejection can be attributed: two tasks in flight against one working tree
   * produce a review that cannot say which one broke it.
   *
   * **The coder is never asked for a verdict**, including on its own work. When
   * the fallback is in force the planner is the coder, and the `accept` hop is
   * skipped entirely — a review is only worth a turn when someone else wrote
   * the code.
   */
  private async deliverTasks(
    tasks: readonly string[],
    from: string
  ): Promise<{ outcome: Outcome; lastEventId: string } | null> {
    const coder = this.coder()
    const selfCoded = coder === PLANNER
    let previous = from

    for (const task of tasks) {
      let attempts = 0

      for (;;) {
        const built = await this.hop({
          step: 'implement',
          from: PLANNER,
          to: coder,
          sourceEventIds: [previous],
          task,
        })
        if (built === null) return null
        previous = built.eventId

        if (selfCoded) break

        const checked = await this.hop({
          step: 'accept',
          from: coder,
          to: PLANNER,
          sourceEventIds: [built.eventId],
          task,
        })
        if (checked === null) return null
        previous = checked.eventId

        if (parseVerdict(checked.text) === 'ready') break

        attempts += 1
        /*
         * Giving up on the task ends the run rather than moving to the next one.
         * The tasks are a plan in order, and carrying on past one the planner
         * would not accept builds the rest on top of work it rejected.
         */
        if (attempts >= MAX_REISSUES) return { outcome: 'unresolved', lastEventId: previous }
      }
    }

    return { outcome: 'agreed', lastEventId: previous }
  }

  /**
   * Ends the run now and leaves the agents owned.
   *
   * A user message and a manual handoff also cost attribution, because
   * something other than this run has dispatched to an agent it holds and the
   * log does not record the routing. `stop` and `shutdown` cost nothing:
   * nothing else was delivered, so the dispatched turn's own completion can
   * still release it.
   */
  cancel(by: CancelCause): void {
    if (this.cancelledBy !== null) return
    if (!this.isRunning()) return
    this.cancelledBy = by
    if (by === 'userMessage' || by === 'manualHandoff') this.attributable = false
    this.state = { phase: 'cancelled', by }
    this.controller.abort()
    this.publish()
  }

  /**
   * The last status published, not a fresh one.
   *
   * Reading must not mint a `statusVersion`: it is the renderer's only ordering
   * key, and a poll that advanced it would let a snapshot answered late look
   * newer than the push it should lose to.
   */
  status(): RunStatus {
    return this.current
  }

  private compose(): RunStatus {
    return {
      conversationId: this.request.conversationId,
      statusVersion: this.port.nextStatusVersion(this.request.conversationId),
      runId: this.runId,
      state: this.state,
      draining: this.outstanding.size > 0,
      ownership: this.ownership(),
      preset: this.request.preset,
      stepIndex: this.stepIndex,
      stepTotal: this.totalSteps(),
    }
  }

  /**
   * Null until the split is read, then a real number.
   *
   * Phase 3 of the delivery plan stops at `split`, so the count is the two hops
   * taken to get there. The micro-task loop adds `2 × tasks` and a closing
   * report, and this is the line that changes when it does.
   */
  private totalSteps(): number | null {
    if (this.tasks === null) return null
    /*
     * Two hops to get here, then one or two per task. Two when a separate coder
     * wrote the change and the planner checks it; one when the planner is also
     * the coder, because the `accept` hop is skipped rather than asking an agent
     * to review the turn it just took.
     */
    const perTask = this.coder() === PLANNER ? 1 : 2
    // The hops before the loop — two with a plan review, one without — then one
    // or two per task, then the closing report.
    const before = this.request.preset === 'delivery' ? 2 : 1
    return before + perTask * this.tasks.length + 1
  }

  private ownership(): Ownership {
    if (this.outstanding.size === 0) return 'free'
    return this.attributable ? 'owned' : 'unattributable'
  }

  private isRunning(): boolean {
    return this.state.phase === 'running'
  }

  private async hop(hop: Hop): Promise<{ eventId: string; text: string } | null> {
    if (!this.isRunning()) return null

    const sessionRef = this.port.sessionRef(this.request.conversationId, hop.to)
    if (sessionRef === null) {
      this.state = { phase: 'failed', reason: 'sessionEnded' }
      this.publish()
      return null
    }

    this.stepIndex += 1
    this.state = { phase: 'running', step: hop.step }
    this.publish()

    const { intent, note: base } = noteFor(hop.step)
    /*
     * The task is quoted onto the note rather than referred to by number. The
     * coder is handed the transcript so far, and "do task 4" would make it count
     * a list it may be reading in a different order than the planner wrote it.
     */
    const note = hop.task === undefined ? base : `${base}\n\nThe task:\n${hop.task}`
    const dispatch = this.port.watch({
      conversationId: this.request.conversationId,
      agentId: hop.to,
      sessionRef,
      deliver: () =>
        this.port.handoff({
          conversationId: this.request.conversationId,
          from: hop.from,
          to: hop.to,
          sourceEventIds: hop.sourceEventIds,
          intent,
          note,
        }),
      signal: this.controller.signal,
    })

    this.hold(dispatch.drained)

    const result = await dispatch.result
    if (result.status === 'completed') return { eventId: result.eventId, text: result.text }

    if (this.isRunning()) {
      this.state =
        result.reason === 'foreignTurn'
          ? { phase: 'interrupted', reason: 'foreignTurn' }
          : result.reason === 'aborted'
            ? { phase: 'cancelled', by: this.cancelledBy ?? 'stop' }
            : { phase: 'failed', reason: result.reason }
      if (result.reason === 'foreignTurn') this.attributable = false
      this.publish()
    }
    return null
  }

  /** Ownership outlives the run, so a drain publishes when it clears. */
  private hold(drained: Promise<void>): void {
    this.outstanding.add(drained)
    /*
     * Published on the way in as well as on the way out.
     *
     * `status()` returns the last *published* snapshot, and the caller that
     * reads it — `sendHandoff`, refusing a manual handoff while agents are
     * owned — would otherwise see the `draining: false` published a few lines
     * above, before this hop was held. Nothing awaits in between, so republishing
     * here makes the snapshot true before control returns to the event loop.
     *
     * The missed refusal is not the worst of it: a manual handoff let through
     * before the coordinator's own `turn.started` arrives becomes the first
     * start above the watermark, and the watcher takes its completion as proof
     * and frees an agent on a turn that was never its own.
     */
    this.publish()
    void drained.then(() => {
      this.outstanding.delete(drained)
      this.publish()
    })
  }

  private finish(outcome: Outcome): RunState {
    this.state = { phase: 'finished', outcome }
    this.publish()
    return this.state
  }

  private publish(): void {
    this.current = this.compose()
    this.port.onStatus(this.current)
  }
}
