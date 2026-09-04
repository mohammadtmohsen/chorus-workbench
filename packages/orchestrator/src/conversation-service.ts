import {
  redactAnswers,
  type AgentActivity,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type ApprovalDecision,
  type ApprovalRequest,
  type BackgroundTask,
  type HealthStatus,
  type SessionOpts,
  type UsageWindow,
  type UserInputRequest,
  type UserInputResponse,
} from '@chorus/agent-protocol'
import type { ApprovalId } from '@chorus/shared'
import type { AppendInput, ChorusEventPayload, EventStore } from '@chorus/event-store'
import { DeltaBuffer, type Scheduler } from './delta-buffer.js'
import { describeRequest, evaluate, SessionGrants } from './policy/engine.js'
import { ApprovalQueue } from './policy/queue.js'
import { DEFAULT_PROFILE_ID, profileById, type PermissionProfile } from './policy/rules.js'

/**
 * What the agent is told when it is held to an earlier file.
 *
 * Addressed to the agent and deliberately naming what to do next: told only
 * "denied", it proposes the same edit again.
 */
const HOLD =
  'Not now — the user asked for a change to an edit you proposed earlier. ' +
  'Apply their instruction to that file first, then propose this one again if it is still needed.'

/**
 * Drives one agent session and turns its normalized `AgentEvent` stream into
 * durable `ChorusEvent`s.
 *
 * Two rules govern everything here, both from the S3 spike:
 *
 *  1. Streamed text is persisted as it arrives, coalesced by `DeltaBuffer`,
 *     because Codex discards partial output on interruption and we cannot ask
 *     for it back.
 *  2. Pending deltas are flushed **before** any lifecycle event is appended, so
 *     the log's order matches what actually happened. Without this a command
 *     would appear in the transcript ahead of the sentence introducing it.
 */

interface DeltaMeta {
  readonly kind: 'message' | 'reasoning'
  readonly itemRef: string
}

export interface ConversationServiceOptions {
  readonly store: EventStore
  readonly conversationId: string
  readonly adapter: AgentAdapter
  readonly scheduler?: Scheduler
  readonly maxChars?: number
  readonly maxAgeMs?: number
  /** Defaults to read-only. Starting permissive is how permissive defaults ship. */
  readonly profile?: PermissionProfile
  /** Shared across agents in a conversation, so a grant is not re-asked per agent. */
  readonly grants?: SessionGrants
  /** Told when the provider reports its account limits. Not persisted. */
  readonly onLimits?: (windows: readonly UsageWindow[]) => void
  /** Told how full the agent's context window is. Not persisted, for the same reason. */
  readonly onContextUsage?: (usage: ContextWindow) => void
  /** Told what the agent has left running. Not persisted, for the same reason. */
  readonly onTasks?: (tasks: readonly BackgroundTask[]) => void
  /**
   * Told what the agent says it is doing right now. Not persisted, and of the
   * four this is the one that would hurt most — it arrives many times a turn.
   */
  readonly onActivity?: (activity: AgentActivity | null) => void
  /** Told when an approved plan returned the session to ordinary permissions. */
  readonly onPlanExited?: () => void
  readonly onApprovalQueued?: (request: ApprovalRequest) => void
  readonly onApprovalSettled?: (approvalId: string) => void
  readonly preflightApproval?: (request: ApprovalRequest) => Promise<boolean>
  /**
   * Nothing here may stop and wait for a person. Set for asides.
   *
   * An aside is a small card anchored to a passage, not a session: it has no
   * room for an approval card, and a card that can raise one is a modal dialog
   * wearing a tooltip's clothes. Worse, an aside nobody is watching would sit on
   * an unanswered approval until its deadline — a fork wedged on a question the
   * user never saw.
   *
   * So an `ask` verdict becomes a deny here rather than a card. `evaluate` still
   * runs first and unchanged, so whatever the profile allows outright still goes
   * through — for an aside that is the read-only profile's safe reads, which is
   * how it can go and look something up.
   *
   * What must **not** be handed to a service in this mode is a populated
   * `SessionGrants`. A grant outranks an `ask`, and a caller that never asks
   * turns every past "always allow" into silent permission to act inside a fork
   * nobody is watching. The caller owns that decision; this flag only removes
   * the card.
   */
  readonly neverAsks?: boolean
}

/** How full an agent's context window is, as last measured. */
export interface ContextWindow {
  readonly usedTokens: number
  readonly maxTokens: number
  /** 0-100. */
  readonly percentUsed: number
}

export class ConversationService {
  private readonly store: EventStore
  private readonly conversationId: string
  private readonly adapter: AgentAdapter
  private readonly buffer: DeltaBuffer<DeltaMeta>
  private profile: PermissionProfile
  /** Asides answer their own approvals — see `ConversationServiceOptions.neverAsks`. */
  private readonly neverAsks: boolean
  private readonly grants: SessionGrants
  private readonly queue: ApprovalQueue
  private readonly onLimits: ((windows: readonly UsageWindow[]) => void) | undefined
  private readonly onContextUsage: ((usage: ContextWindow) => void) | undefined
  private readonly onTasks: ((tasks: readonly BackgroundTask[]) => void) | undefined
  private readonly onActivity: ((activity: AgentActivity | null) => void) | undefined
  private readonly onPlanExited: (() => void) | undefined
  private readonly onApprovalQueued: ((request: ApprovalRequest) => void) | undefined
  private readonly onApprovalSettled: ((approvalId: string) => void) | undefined
  private readonly preflightApproval: ((request: ApprovalRequest) => Promise<boolean>) | undefined
  /**
   * Question sets waiting on the user, kept so an answer can be checked against
   * the questions that produced it — which is what redaction needs to know
   * which values are secret.
   *
   * None carries a timer. Neither provider imposes a deadline, so the one that
   * used to live here was Chorus's own — and it *answered* on expiry rather
   * than merely giving up, which turned walking away into a decision. A
   * question now waits for the person it was asked of.
   *
   * `expiresAt` is kept because the request carries it and the log records it.
   * Nothing reads it back.
   */
  private readonly pendingUserInput = new Map<
    string,
    {
      request: UserInputRequest
      expiresAt: number
    }
  >()
  /**
   * A file whose edit was refused with an instruction, and not yet re-proposed.
   *
   * While this is set, the agent is held to finishing that file before it may
   * touch another. It is the difference between "no" and "no, do it like this":
   * the second is an instruction about *this* file, and an agent that answers it
   * by going off to edit the next one has ignored it.
   *
   * Cleared when the same file comes back — that proposal is the correction and
   * must reach a card — and at the end of the turn, so a hold never outlives the
   * plan it belongs to.
   */
  private awaitingCorrectionFor: string | null = null
  private session: AgentSession | null = null
  private pump: Promise<void> | null = null
  /** Set when *we* asked to stop, so an interrupt is not reported as a failure. */
  private interruptRequested = false

  constructor(options: ConversationServiceOptions) {
    this.store = options.store
    this.conversationId = options.conversationId
    this.adapter = options.adapter
    this.profile = options.profile ?? profileById(DEFAULT_PROFILE_ID)
    this.neverAsks = options.neverAsks ?? false
    this.grants = options.grants ?? new SessionGrants()
    this.onLimits = options.onLimits
    this.onContextUsage = options.onContextUsage
    this.onTasks = options.onTasks
    this.onActivity = options.onActivity
    this.onPlanExited = options.onPlanExited
    this.onApprovalQueued = options.onApprovalQueued
    this.onApprovalSettled = options.onApprovalSettled
    this.preflightApproval = options.preflightApproval
    this.queue = new ApprovalQueue({
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      onResolved: (entry, decision, decidedBy) =>
        this.recordAndAnswer(entry.request.id, decision, decidedBy, null),
    })
    this.buffer = new DeltaBuffer<DeltaMeta>({
      ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      onFlush: (entries) => {
        this.append(
          entries.map((e) => ({
            actor: this.adapter.id,
            payload:
              e.meta.kind === 'message'
                ? { type: 'agent.message.delta' as const, itemRef: e.meta.itemRef, text: e.text }
                : { type: 'agent.reasoning.delta' as const, itemRef: e.meta.itemRef, text: e.text },
          }))
        )
      },
    })
  }

  /** Starts a session on the adapter and consumes it. */
  async start(opts: SessionOpts): Promise<AgentSession> {
    const health = await this.adapter.health()
    const session = await this.adapter.start(opts)
    await this.attach(session, opts, health)
    return session
  }

  /**
   * Consumes a session someone else created — in practice a `SupervisedSession`,
   * which transparently restarts the provider underneath. This service is
   * deliberately unaware of that: a restart shows up as an ordinary `error`
   * event in the stream, and the transcript keeps going.
   */
  attach(
    session: AgentSession,
    opts: SessionOpts,
    health: HealthStatus,
    /** Set when the app is reopening this, not when an agent is joining. */
    resumed = false
  ): Promise<void> {
    this.session = session
    this.appendOne({
      actor: 'system',
      payload: {
        type: 'session.started',
        agentId: this.adapter.id,
        sessionRef: session.sessionRef,
        cwd: opts.cwd,
        model: opts.model ?? null,
        // Recorded because Chorus drives the user's installed CLIs, which
        // self-update (plan §2.5).
        cliVersion: health.state === 'ready' ? health.version : null,
        resumed,
      },
    })
    this.pump = this.consume(session)
    return Promise.resolve()
  }

  /**
   * Logs the message and delivers it. Only correct when this service is the
   * conversation's sole agent — with several, the runtime logs once and calls
   * `deliver` on each recipient, or the transcript shows the user repeating
   * themselves once per agent.
   */
  async sendUserMessage(text: string, delivered: string = text): Promise<void> {
    /*
     * The two can differ, and for an aside they do. What is logged is the
     * question as it was typed; what is delivered carries the quoted passage and
     * the instruction not to work, which is scaffolding rather than something
     * the user said. Logging the wrapper would put words in their mouth in their
     * own transcript.
     */
    this.appendOne({ actor: 'user', payload: { type: 'user.message', text } })
    await this.deliver(delivered)
  }

  /** Delivers without logging — the shared-conversation path. */
  async deliver(text: string): Promise<void> {
    await this.session?.send({ text })
  }

  /**
   * Re-points this session at another profile.
   *
   * Only affects approvals asked *after* it: a request already on screen was
   * evaluated under the old rules and is the user's to settle either way.
   * Session grants survive too — they were given deliberately, and a profile
   * change is not a reason to re-ask for something already allowed.
   */
  setProfile(profile: PermissionProfile): void {
    this.profile = profile
  }

  profileId(): string {
    return this.profile.id
  }

  /**
   * What a queued edit would leave on disk, or `null` when it cannot be said.
   *
   * Forwarded rather than computed here: the adapter holds the provider's tool
   * input and is the only thing that can read it, and `CLAUDE.md` lets nothing
   * provider-specific past that boundary. The caller supplies the current text
   * because the adapter must not learn to read a filesystem.
   *
   * **The answer is never carried on the request**, which is appended to the log
   * whole — so it is pulled, held in main for as long as the card is open, and
   * dropped when the card settles.
   */
  previewFileChange(approvalId: ApprovalId, currentText: string | null): string | null {
    try {
      return this.session?.previewFileChange?.(approvalId, currentText) ?? null
    } catch {
      // A preview that throws is a preview nobody gets, not a broken decision.
      return null
    }
  }

  /**
   * Asks the provider to re-read its account windows, if it can be asked.
   *
   * Silent when the session is not up or the provider has no such notion — the
   * caller is a button, and a button that reports "this agent does not meter"
   * is noise rather than news.
   */
  async refreshLimits(): Promise<void> {
    await this.session?.readLimits?.()
  }

  async interrupt(): Promise<void> {
    this.interruptRequested = true
    await this.session?.interrupt()
  }

  /**
   * Answers an approval **and records the decision**.
   *
   * Routing this through the service rather than straight to the session is what
   * makes "human controlled" auditable (plan §4.4): every decision lands in the
   * log with who made it and, for an auto-decision, which rule did. Talking to
   * the session directly would answer the agent while leaving no trace — and
   * would leave the pending card on screen forever, since the UI clears it on
   * `approval.decided`.
   */
  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: 'user' | 'policy' | 'system' = 'user'
  ): Promise<void> {
    // "Allow for session" is remembered before the queue forgets the request,
    // so the same action does not ask again. Outward-facing kinds refuse to be
    // remembered — `SessionGrants.add` returns false for them (plan §2.6).
    const entry = this.queue.get(approvalId)
    if (
      entry?.request.kind === 'fileChange' &&
      decision.outcome === 'allow' &&
      this.preflightApproval !== undefined
    ) {
      /*
       * A preflight that throws reads as stale, not as fine.
       *
       * It compares the file against the copy the person was shown, so the only
       * safe reading of "could not compare" is that the two may differ — and
       * refusing costs a re-ask while proceeding could apply an edit to a file
       * nobody looked at.
       */
      let current: boolean
      try {
        current = await this.preflightApproval(entry.request)
      } catch {
        current = false
      }
      if (!current) {
        this.lifecycle({
          type: 'notice.raised',
          level: 'warn',
          source: 'system',
          text: '',
          code: 'staleEditPreview',
          detail: null,
        })
        await this.queue.resolve(
          approvalId,
          { outcome: 'deny', message: 'The file changed after the preview.' },
          'system'
        )
        return
      }
    }

    const effectiveDecision: ApprovalDecision =
      entry?.request.kind === 'fileChange' &&
      decision.outcome === 'allow' &&
      decision.scope === 'always'
        ? { ...decision, scope: 'session' }
        : decision
    /*
     * "Always" is remembered past this run; "session" only until it ends.
     *
     * Both are recorded before the queue forgets the request, and only `always`
     * may answer for a kind that can never be auto-decided — because that is the
     * user having decided, not a profile deciding for them.
     */
    if (
      entry !== undefined &&
      effectiveDecision.outcome === 'allow' &&
      effectiveDecision.scope === 'always'
    ) {
      this.grants.addAlways(entry.request)
    }
    if (
      entry !== undefined &&
      effectiveDecision.outcome === 'allow' &&
      effectiveDecision.scope === 'session'
    ) {
      /*
       * An edit grants nothing, ever — not even for this file.
       *
       * There is no "allow all edits this session" any more: the button was
       * removed on 2026-09-04 because pressing it once switched the feature off
       * for the rest of the session, which is the opposite of what someone turns
       * it on for. With no button, a grant would be a state nothing can set and
       * nothing can see, so the honest expression of "every edit is asked about"
       * is that answering one settles that one and nothing else.
       *
       * A `session` scope can still arrive over IPC. It is quietly narrowed to
       * once rather than refused: the answer the person gave is still honoured,
       * just not widened.
       */
      if (entry.request.kind !== 'fileChange') this.grants.add(entry.request)
    }

    /*
     * Approving a plan is what ends plan mode.
     *
     * `ExitPlanMode` is the agent saying it has finished reasoning and would
     * like to act, and it arrives as an ordinary permission request. Answering
     * yes to the plan and separately having to leave the mode would be two
     * decisions for one intention — and the second one is easy to forget, which
     * leaves an approved plan that never runs.
     *
     * Only on allow. A rejected plan means keep planning.
     */
    if (
      entry !== undefined &&
      effectiveDecision.outcome === 'allow' &&
      entry.request.kind === 'permissionGrant' &&
      entry.request.toolName === 'ExitPlanMode'
    ) {
      void this.leavePlanMode()
    }

    const handled = await this.queue.resolve(approvalId, effectiveDecision, decidedBy)
    if (!handled) {
      // Not queued — an auto-decided or already-settled approval. Still log it.
      await this.recordAndAnswer(approvalId, effectiveDecision, decidedBy, null)
    }

    if (entry !== undefined) await this.standDownAfterRefusal(entry.request, effectiveDecision)
  }

  /**
   * A refusal with words holds the agent to that file until it comes back.
   *
   * Refusing an edit with an instruction — "not like that, do X" — and then
   * being asked about the *next* file, and only afterwards being re-asked about
   * the first, is the sequence this exists to stop. The instruction was about
   * one file; an agent that answers it by moving on has not answered it.
   *
   * Two halves, because the edits arrive two ways. Anything already queued from
   * the same batch is refused now — an assistant message can propose several at
   * once. And a hold is set for anything proposed *next*, because measured on
   * 2026-09-04 the sequence is not a batch at all: the second edit is not
   * requested until the first is answered, so a one-shot sweep found nothing to
   * cancel and the problem survived it.
   *
   * **Only when words were given.** A bare "No" says nothing about the rest — it
   * may well mean "not that one, the others are fine" — and holding the agent to
   * a file on it would take away a choice the person did not make.
   */
  private async standDownAfterRefusal(
    refused: ApprovalRequest,
    decision: ApprovalDecision
  ): Promise<void> {
    if (refused.kind !== 'fileChange') return
    if (decision.outcome !== 'deny') return
    if (decision.message.trim() === '') return

    this.awaitingCorrectionFor = refused.files[0]?.path ?? null

    const stale = this.queue
      .list()
      .filter(
        (pending) =>
          pending.request.kind === 'fileChange' &&
          pending.request.agentId === refused.agentId &&
          pending.request.id !== refused.id
      )

    for (const pending of stale) {
      await this.queue.resolve(pending.request.id, { outcome: 'deny', message: HOLD }, 'system')
    }
  }

  /**
   * Why this edit is refused, or `null` when it may proceed.
   *
   * The held file itself always may: that proposal is the correction being
   * asked for, and blocking it would hold the agent to a file it is forbidden to
   * touch. Answering it clears the hold whichever way it is answered — an allow
   * ends the matter, and a second refusal sets a fresh hold through
   * `standDownAfterRefusal`.
   */
  private heldByCorrection(request: ApprovalRequest): string | null {
    if (this.awaitingCorrectionFor === null) return null
    if (request.kind !== 'fileChange') return null
    if (request.files[0]?.path === this.awaitingCorrectionFor) {
      this.awaitingCorrectionFor = null
      return null
    }
    return HOLD
  }

  /**
   * Answers a question set and lets the agent's turn continue.
   *
   * The log entry is written before the provider is told, and the answers are
   * redacted on the way into it. Ordering matters: if the wire call throws, the
   * record of what the user chose still exists.
   */
  async answerUserInput(
    userInputId: string,
    response: UserInputResponse,
    answeredBy: 'user' | 'system' = 'user'
  ): Promise<void> {
    const pending = this.pendingUserInput.get(userInputId)
    // Already answered, timed out, or never ours. Answering twice is harmless
    // by design — a double-submit from the UI must not throw at the user.
    if (pending === undefined) return
    const { request } = pending

    /*
     * The answers must name the questions that were actually asked, checked
     * before anything is written down.
     *
     * The log entry is deliberately written before the provider is told, so an
     * unvalidated response becomes a permanent `answered` record for an answer
     * the provider may reject — which is precisely how C-018 stayed invisible
     * for weeks. A renderer left open across a new request, or an id regression,
     * produces exactly that.
     *
     * Left pending rather than resolved: the card stays up, the user can answer
     * again, and the deadline still bounds it. Recording a `cancel` the user did
     * not ask for would be its own lie.
     */
    if (response.outcome === 'answered') {
      const asked = new Set(request.questions.map((q) => q.id))
      const answered = new Set(response.answers.map((a) => a.questionId))
      const matches = asked.size === answered.size && [...asked].every((id) => answered.has(id))
      // No logger on this class, and a `notice` would put a line in the
      // transcript for what is a caller bug rather than something the
      // conversation did. Returning is the behaviour; the test is the record.
      if (!matches) return
    }

    this.pendingUserInput.delete(userInputId)

    this.lifecycle({
      type: 'userinput.answered',
      userInputId,
      outcome: response.outcome,
      answers:
        response.outcome === 'answered'
          ? redactAnswers(request, response.answers).map((a) => ({
              questionId: a.questionId,
              values: a.values === null ? null : [...a.values],
            }))
          : null,
      answeredBy,
    })

    await this.session?.respondToUserInput(request.id, response)
  }

  /**
   * Pushes a question's deadline out, or just reports it.
   *
   * The clock measured time since the *agent asked*; nothing restarted it, and
   * answering was not an input to it — so a card could be on screen, focused and
   * half-filled, and still expire. Measured over the real log, 10 of 25 question
   * sets died at exactly 300.0s.
   *
   * `engaged` must mean a gesture the app cannot manufacture. The card focuses
   * itself on mount, so focus is not evidence; a remounting card asks with
   * `engaged: false`, which reads the deadline and changes nothing.
   */

  /** Question sets still waiting on the user, for the UI to draw after a replay. */
  pendingQuestions(): UserInputRequest[] {
    return [...this.pendingUserInput.values()].map((p) => p.request)
  }

  /** Everything a person or a rule may grant this session, for the audit view. */
  sessionGrants(): { key: string; describe: string }[] {
    return this.grants.list()
  }

  pendingApprovals(): { id: string; describe: string; expiresAt: number }[] {
    return this.queue.list().map((e) => ({
      id: e.request.id,
      describe: describeRequest(e.request),
      expiresAt: e.request.expiresAt,
    }))
  }

  /** The single place a decision becomes both a log entry and a wire response. */
  private async recordAndAnswer(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: 'user' | 'policy' | 'system',
    policyRuleId: string | null
  ): Promise<void> {
    this.lifecycle({
      type: 'approval.decided',
      approvalId,
      outcome: decision.outcome,
      scope: decision.outcome === 'allow' ? decision.scope : null,
      decidedBy,
      policyRuleId,
    })
    try {
      this.onApprovalSettled?.(approvalId)
    } catch {
      // The provider still needs its answer.
    }
    // A timeout is a denial on the wire; the log keeps the distinction.
    const answer: ApprovalDecision =
      decision.outcome === 'timeout'
        ? { outcome: 'deny', message: 'Timed out waiting for a decision' }
        : decision
    await this.session?.respondToApproval(approvalId as ApprovalId, answer)
  }

  /** Resolves once the event stream has ended and everything is durable. */
  async drain(): Promise<void> {
    await this.pump
    this.buffer.flushAll()
  }

  async close(reason: 'closed' | 'crashed' | 'replaced' | 'shutdown' = 'closed'): Promise<void> {
    // Anything still waiting is denied, or the agent blocks on a prompt nobody
    // will ever see.
    await this.queue.drain('Session closed')
    // Questions the same way: the card is going away, so anything still open
    // has to be settled rather than left holding the turn.
    for (const id of [...this.pendingUserInput.keys()]) {
      await this.answerUserInput(id, { outcome: 'cancel' }, 'system')
    }
    this.buffer.flushAll()
    const ref = this.session?.sessionRef
    await this.session?.close()
    await this.pump
    this.buffer.flushAll()
    this.buffer.dispose()
    this.queue.dispose()
    if (ref !== undefined) {
      this.appendOne({
        actor: 'system',
        payload: {
          type: 'session.ended',
          agentId: this.adapter.id,
          sessionRef: ref,
          reason,
        },
      })
    }
  }

  private async consume(session: AgentSession): Promise<void> {
    for await (const event of session.events) {
      this.handle(event)
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.type) {
      case 'message.delta':
        this.buffer.push(`message:${event.itemRef}`, event.text, {
          kind: 'message',
          itemRef: event.itemRef,
        })
        return

      case 'reasoning.delta':
        this.buffer.push(`reasoning:${event.itemRef}`, event.text, {
          kind: 'reasoning',
          itemRef: event.itemRef,
        })
        return

      case 'message.completed':
        // The provider's final text supersedes the buffered fragments, so drop
        // them rather than writing text that the completed event repeats.
        this.buffer.flushKey(`message:${event.itemRef}`)
        this.lifecycle({
          type: 'agent.message.completed',
          itemRef: event.itemRef,
          text: event.text,
        })
        return

      case 'turn.started':
        this.lifecycle({ type: 'turn.started', turnRef: event.turnRef })
        return

      case 'turn.completed': {
        const status =
          this.interruptRequested && event.status !== 'completed' ? 'interrupted' : event.status
        this.lifecycle({
          type: 'turn.completed',
          turnRef: event.turnRef,
          status,
          userInitiated: this.interruptRequested,
        })
        this.interruptRequested = false
        // A hold belongs to the plan that was refused. The turn is over, so the
        // plan is too, and holding a later one to it would be arbitrary.
        this.awaitingCorrectionFor = null
        return
      }

      case 'command.started':
        this.lifecycle({
          type: 'command.started',
          itemRef: event.itemRef,
          command: [...event.command],
          cwd: event.cwd,
        })
        return

      case 'command.output':
        this.lifecycle({
          type: 'command.output',
          itemRef: event.itemRef,
          stream: event.stream,
          chunk: event.chunk,
        })
        return

      case 'command.completed':
        this.lifecycle({
          type: 'command.completed',
          itemRef: event.itemRef,
          exitCode: event.exitCode,
        })
        return

      case 'file.change.proposed':
        this.lifecycle({
          type: 'file.change.proposed',
          itemRef: event.itemRef,
          files: event.files.map((f) => ({ path: f.path, patch: f.patch })),
        })
        return

      case 'file.change.completed':
        this.lifecycle({
          type: 'file.change.completed',
          itemRef: event.itemRef,
          files: event.files.map((f) => ({
            path: f.path,
            ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
            change: f.change,
            added: f.added,
            removed: f.removed,
            patch: f.patch,
            ...(f.omittedLines === undefined ? {} : { omittedLines: f.omittedLines }),
          })),
          outcome: event.outcome,
        })
        return

      case 'diff.updated':
        this.lifecycle({ type: 'diff.updated', unifiedDiff: event.unifiedDiff })
        return

      case 'approval.requested': {
        this.lifecycle({
          type: 'approval.requested',
          approvalId: event.request.id,
          kind: event.request.kind,
          request: event.request,
          expiresAt: event.request.expiresAt,
        })

        /*
         * The agent was told to change something and went to another file.
         *
         * Refused before policy sees it, because policy would allow it: a
         * profile has no opinion about *which* file, and the objection is not
         * about permission at all. The correction itself passes the path check,
         * so the one edit that can clear the hold is never blocked by it.
         */
        const held = this.heldByCorrection(event.request)
        if (held !== null) {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'deny', message: held },
            'system',
            null
          )
          return
        }

        /*
         * Policy decides before the user ever sees a card. An auto-decision is
         * logged with the rule that made it — an allow nobody can trace back to
         * a rule is indistinguishable from no policy at all (plan §4.4).
         */
        const verdict = evaluate(event.request, this.profile, this.grants)
        if (verdict.decision === 'allow') {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'allow', scope: verdict.scope },
            'policy',
            verdict.ruleId
          )
          return
        }
        if (verdict.decision === 'deny') {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'deny', message: verdict.reason },
            'policy',
            verdict.ruleId
          )
          return
        }

        /*
         * An aside has nobody to ask, so it answers for itself.
         *
         * Denied rather than allowed, and denied *immediately* rather than left
         * to the queue's deadline: an unattended fork holding an approval open
         * is a wedged turn, which is the failure this whole branch exists to
         * avoid.
         *
         * The message goes to the *provider*, not to the log — `approval.decided`
         * records a verdict, a scope and a rule, and carries no text. So the
         * agent learns why and can say so in its answer; a card wanting to
         * explain the refusal has to supply its own words.
         */
        if (this.neverAsks) {
          void this.recordAndAnswer(
            event.request.id,
            { outcome: 'deny', message: 'An aside may explain, not act.' },
            'policy',
            null
          )
          return
        }

        // Nobody but a person can settle this one; the queue owns its deadline.
        this.queue.add(this.conversationId, event.request)
        try {
          this.onApprovalQueued?.(event.request)
        } catch {
          // A preview failure must not block the event pump.
        }
        return
      }

      case 'approval.withdrawn':
        this.queue.withdraw(event.approvalId)
        this.lifecycle({ type: 'approval.withdrawn', approvalId: event.approvalId })
        try {
          this.onApprovalSettled?.(event.approvalId)
        } catch {
          // The withdrawal is already complete.
        }
        return

      /*
       * Logged and held, never auto-answered.
       *
       * Deliberately does not go past `evaluate()`. A permission profile decides
       * whether an action is allowed, which is a question it can be given rules
       * about; what the user *wants* is not. An auto-answered question would put
       * words in their mouth and the agent would have no way to tell.
       */
      case 'userinput.requested': {
        this.lifecycle({
          type: 'userinput.requested',
          userInputId: event.request.id,
          request: event.request,
          expiresAt: event.request.expiresAt,
        })
        /*
         * Same reasoning as an approval, one step further: an aside cannot host
         * a question set either, and waiting out its deadline in a card nobody
         * is looking at is the wedge again. `timeout` rather than a fabricated
         * choice — the provider is told nothing was chosen, which it can recover
         * from; an invented answer it cannot.
         */
        /*
         * Registered with no timer. A question waits for the person it was asked
         * of, for as long as that takes — see `ApprovalQueue` for the whole
         * argument, which is the same one: neither provider imposes a deadline,
         * the window was Chorus's own, and its expiry *answered* rather than
         * merely giving up.
         *
         * `neverAsks` below is untouched and still resolves at once. An aside has
         * nobody to ask, so waiting there would wedge a fork nobody is watching —
         * which is the case the timer was really protecting.
         */
        this.pendingUserInput.set(event.request.id, {
          request: event.request,
          expiresAt: event.request.expiresAt,
        })

        /*
         * Answered *after* being registered, which is the whole point of the
         * ordering.
         *
         * `answerUserInput` looks the request up in `pendingUserInput` and
         * returns silently when it is not there — a deliberate guard against
         * double-submits. Called before the `set` above, as this was, it hit
         * that guard every time: the provider was never told, and the turn this
         * branch exists to unblock stayed blocked forever. The timer is set and
         * immediately cleared by the answer, which costs nothing and keeps one
         * path through this case rather than two.
         */
        if (this.neverAsks) {
          void this.answerUserInput(event.request.id, { outcome: 'timeout' }, 'system')
        }
        return
      }

      /*
       * Handed on, never written down.
       *
       * The log records what happened in a conversation; how full an account's
       * weekly window is happened to the account, and reading it back a week
       * later would be worse than not having it. It goes straight to whoever
       * asked to be told.
       */
      case 'limits':
        this.onLimits?.(event.windows)
        return

      /*
       * Pushed, not appended — the same treatment as `limits`, and for the
       * reason given on the event: it is the agent's current state rather than
       * something that happened in the conversation, and compaction resets it.
       */
      case 'context.usage':
        this.onContextUsage?.({
          usedTokens: event.usedTokens,
          maxTokens: event.maxTokens,
          percentUsed: event.percentUsed,
        })
        return

      /*
       * Pushed like the two above, and for the same reason: a list of processes
       * that stop existing when the session does is state, not history.
       *
       * Passed on whole every time, including when it is empty. The provider's
       * payload replaces rather than merges, so an empty list is not "no news" —
       * it is the only way anyone learns the last task finished.
       */
      case 'tasks.changed':
        this.onTasks?.(event.tasks)
        return

      /*
       * The fourth of the same kind, and the loudest. `null` is passed on like
       * an empty task list is: it is the only thing that says the agent stopped
       * compacting, and a falsy guard here would leave the word standing for
       * the rest of the turn.
       */
      case 'activity.changed':
        this.onActivity?.(event.activity)
        return

      case 'usage.updated':
        this.lifecycle({
          type: 'usage.updated',
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd ?? null,
        })
        return

      /*
       * Recorded, not merely shown: the moment an agent stopped holding the
       * whole conversation is a fact about that conversation, and one you would
       * want when reading the log back and wondering why it forgot something.
       */
      case 'context.compacted':
        this.lifecycle({ type: 'context.compacted' })
        return

      case 'plan.updated':
        // No durable projection yet; the plan panel lands in M4.
        return

      case 'error':
        this.lifecycle({
          type: 'error.raised',
          message: event.message,
          recoverable: event.recoverable,
        })
        return

      case 'tool.started':
        this.lifecycle({
          type: 'tool.started',
          itemRef: event.itemRef,
          name: event.name,
          parentRef: event.parentRef ?? null,
          detail: event.detail ?? null,
          // Omitted rather than nulled when the call names no file: the schema
          // has it optional so that logs written before it keep parsing, and a
          // key that is sometimes absent and sometimes null is two shapes.
          ...(event.path === undefined ? {} : { path: event.path }),
        })
        return

      case 'tool.progress':
        this.lifecycle({
          type: 'tool.progress',
          itemRef: event.itemRef,
          note: event.note ?? null,
          elapsedMs: event.elapsedMs ?? null,
        })
        return

      case 'tool.completed':
        this.lifecycle({
          type: 'tool.completed',
          itemRef: event.itemRef,
          status: event.status,
          summary: event.summary ?? null,
          patch: event.patch ?? null,
          omittedLines: event.omittedLines ?? null,
        })
        return

      case 'notice':
        this.lifecycle({
          type: 'notice.raised',
          level: event.level,
          source: event.source,
          text: event.text,
          detail: event.detail ?? null,
          ...(event.code === undefined ? {} : { code: event.code }),
          // Carried through rather than recomputed — the adapter did the cutting
          // and is the only thing that saw the original length. Spread rather
          // than defaulted to 0, so a notice that lost nothing is written
          // exactly as it always was.
          ...(event.detailOmittedBytes === undefined
            ? {}
            : { detailOmittedBytes: event.detailOmittedBytes }),
        })
        return
    }
  }

  /**
   * Tells the provider to accept edits from now on.
   *
   * Best effort by design: a provider that cannot be told simply keeps asking,
   * which is a worse experience and not a broken one. Failing the decision the
   * user just made because a preference could not be forwarded would be the
   * wrong trade.
   */
  /**
   * Returns the session to ordinary permissions once a plan is approved.
   *
   * Told upward as well as forwarded down, because the mode belongs to the
   * conversation and something has to keep the control that turned it on
   * honest.
   */
  private async leavePlanMode(): Promise<void> {
    try {
      await this.session?.setPermissionMode?.('default')
      this.onPlanExited?.()
    } catch {
      // The turn is already approved; a mode that failed to change is a worse
      // experience than a failed decision, not a broken one.
    }
  }

  /** Every non-delta event goes through here so the flush-first rule cannot be skipped. */
  private lifecycle(payload: ChorusEventPayload): void {
    this.buffer.flushAll()
    this.appendOne({ actor: this.adapter.id, payload })
  }

  private appendOne(input: Omit<AppendInput, 'conversationId'>): void {
    this.store.append({ ...input, conversationId: this.conversationId })
  }

  private append(inputs: readonly Omit<AppendInput, 'conversationId'>[]): void {
    if (inputs.length === 0) return
    this.store.appendMany(inputs.map((i) => ({ ...i, conversationId: this.conversationId })))
  }
}
