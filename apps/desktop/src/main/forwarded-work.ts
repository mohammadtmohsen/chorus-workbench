import type {
  AssignmentBinding,
  AssignmentRecord,
  CurrentWork,
  EventRef,
  ForwardedChild,
  ForwardedChildPage,
  StoredEvent,
  TaskFacts,
  TaskWindow,
  WindowSearchPage,
  WorkObservations,
} from '@chorus/event-store'

export const FORWARDED_NO_ROOM =
  '[Chorus forwarded] Not enough room is left in this session’s context to read forwarded work now. Nothing was read; this does not mean there is none.'

const LINE_BYTES = 1_200
const TITLE_CHARS = 160
const OBJECTIVE_CHARS = 400
const LIST_OBJECTIVE_CHARS = 200
const STEP_CHARS = 120
const HISTORY_SHOWN = 3
const ELLIPSIS = '…'

export type AssignmentState =
  'unbound' | 'open' | 'completion-recorded' | 'abandoned' | 'superseded' | 'unknown'

export interface Claim {
  readonly kind: 'link' | 'binding' | 'suggestion' | 'task' | 'current' | 'observation'
  readonly text: string
  readonly refs: readonly EventRef[]
}

export interface InterruptedTurn {
  readonly agentId: string
  readonly started: EventRef
  readonly ended: EventRef
}

export interface DigestInput {
  readonly child: ForwardedChild
  readonly binding: AssignmentBinding
  readonly window: TaskWindow | null
  readonly facts: TaskFacts | null
  readonly observations: WorkObservations | null
  readonly current: CurrentWork | null
  readonly interrupted: readonly InterruptedTurn[]
}

export interface AssignmentDigest {
  readonly conversationId: string
  readonly title: string
  readonly taskId: string | null
  readonly bound: boolean
  readonly state: AssignmentState
  readonly declared: boolean
  readonly window: { readonly fromSeq: number; readonly toSeq: number } | null
  readonly claims: readonly Claim[]
  readonly asOfSeq: number
}

export interface ForwardedListEntry {
  readonly child: ForwardedChild
  readonly binding: AssignmentBinding
  readonly window: TaskWindow | null
}

export interface ForwardedReadContext {
  readonly conversationId: string
  readonly taskId: string | null
  readonly bound: boolean
  readonly window: TaskWindow | null
  readonly asOfSeq: number
}

export type BindAssignmentResult =
  | {
      readonly outcome: 'bound'
      readonly taskId: string
      readonly previousTaskId: string | null
      readonly ref: EventRef
    }
  | { readonly outcome: 'unchanged'; readonly taskId: string; readonly ref: EventRef }
  | {
      readonly outcome: 'refused'
      readonly reason: 'not-forwarded' | 'no-task' | 'not-latest' | 'unavailable'
    }

const pointBytes = (code: number): number =>
  code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4

export function utf8Length(text: string): number {
  let total = 0
  for (const point of text) total += pointBytes(point.codePointAt(0) ?? 0)
  return total
}

function clip(text: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const point of text) {
    used += pointBytes(point.codePointAt(0) ?? 0)
    if (used > maxBytes) return text.slice(0, end)
    end += point.length
  }
  return text
}

function fit(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text
  const room = maxBytes - utf8Length(ELLIPSIS)
  return room < 0 ? clip(text, Math.max(maxBytes, 0)) : `${clip(text, room)}${ELLIPSIS}`
}

function chars(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const points = Array.from(flat)
  return points.length <= limit ? flat : `${points.slice(0, limit).join('')}${ELLIPSIS}`
}

function sliceUtf8(
  text: string,
  offset: number,
  maxBytes: number
): { readonly text: string; readonly start: number; readonly end: number; readonly total: number } {
  let position = 0
  let start = -1
  let startIndex = text.length
  let end = -1
  let endIndex = text.length
  let index = 0
  for (const point of text) {
    const size = pointBytes(point.codePointAt(0) ?? 0)
    if (start === -1 && position >= offset) {
      start = position
      startIndex = index
    }
    if (start !== -1 && end === -1 && position + size - start > maxBytes) {
      end = position
      endIndex = index
    }
    position += size
    index += point.length
  }
  if (start === -1) start = position
  if (end === -1) end = position
  return { text: text.slice(startIndex, endIndex), start, end, total: position }
}

const cite = (ref: EventRef): string => `[#${String(ref.seq)} ${ref.eventId}]`

const refOfEvent = (event: StoredEvent): EventRef => ({
  seq: event.seq,
  eventId: event.id,
  at: event.createdAt,
})

const sameRef = (a: EventRef, b: EventRef): boolean => a.eventId === b.eventId

const claimLine = (claim: Claim): string => {
  const refs = claim.refs.length === 0 ? '' : ` ${claim.refs.map(cite).join(' ')}`
  return `${fit(`- ${claim.text}`, Math.max(LINE_BYTES - utf8Length(refs), 0))}${refs}`
}

function stateOf(window: TaskWindow | null): AssignmentState {
  if (window === null) return 'unknown'
  if (window.closed !== null) {
    return window.closed.reason === 'completed' ? 'completion-recorded' : window.closed.reason
  }
  return window.latest ? 'open' : 'unknown'
}

const declares = (event: StoredEvent): boolean =>
  event.payload.type === 'task.revised' && event.payload.complete === true

const revisionAgent = (event: StoredEvent): string =>
  event.payload.type === 'task.revised' ? event.payload.agentId : event.actor

const iso = (at: number): string => new Date(at).toISOString()

function isDeclared(facts: TaskFacts | null): boolean {
  if (facts === null || facts.latestRevisions.length === 0) return false
  return facts.latestRevisions.every(declares)
}

function linkClaims(child: ForwardedChild): Claim[] {
  const named = sameRef(child.titleRef, child.created)
    ? [child.created]
    : [child.created, child.titleRef]
  return [
    {
      kind: 'link',
      text: `Forwarded from this conversation as ${child.conversationId} "${chars(child.title, TITLE_CHARS)}".`,
      refs: named,
    },
    child.objective === null
      ? {
          kind: 'link',
          text: 'No objective was recorded with this forward.',
          refs: [child.created],
        }
      : {
          kind: 'link',
          text: `Objective recorded when it was forwarded: "${chars(child.objective, OBJECTIVE_CHARS)}"`,
          refs: [child.created],
        },
  ]
}

function bindingClaims(binding: AssignmentBinding): Claim[] {
  const { current } = binding
  if (current === null) {
    const { suggestion } = binding
    if (suggestion === null) {
      return [
        {
          kind: 'binding',
          text: 'Not marked, and no task has been recorded in that conversation yet. That does not show that no work was done there: agents may not have reported a plan.',
          refs: [],
        },
      ]
    }
    return [
      {
        kind: 'binding',
        text: 'Not marked: the user has not marked which task in that conversation is this forwarded work, so no status is reported for it.',
        refs: [],
      },
      {
        kind: 'suggestion',
        text: `Unconfirmed suggestion: task ${suggestion.taskId}, the first task opened there. Its progress and completion are not this work's status unless the user marks it.`,
        refs: [suggestion],
      },
    ]
  }
  const claims: Claim[] = [
    {
      kind: 'binding',
      text: `The user marked task ${current.taskId} as this forwarded work${
        current.previousTaskId === null ? '' : `, replacing task ${current.previousTaskId}`
      }.`,
      refs: [current.ref],
    },
  ]
  const earlier = binding.history.slice(1)
  if (earlier.length > 0) {
    const shown = earlier.slice(0, HISTORY_SHOWN)
    const more = earlier.length - shown.length
    claims.push({
      kind: 'binding',
      text: `Earlier markings, newest first: ${shown.map((record) => `task ${record.taskId}`).join(', ')}${
        more > 0 ? `, and ${String(more)} more` : ''
      }.`,
      refs: shown.map((record) => record.ref),
    })
  }
  return claims
}

function stateClaim(
  state: AssignmentState,
  taskId: string,
  window: TaskWindow | null,
  binding: EventRef,
  asOfSeq: number
): Claim {
  if (window === null) {
    return {
      kind: 'task',
      text: `Task ${taskId} has no readable records as of #${String(asOfSeq)}.`,
      refs: [binding],
    }
  }
  const closed = window.closed === null ? [] : [window.closed]
  switch (state) {
    case 'completion-recorded':
      return { kind: 'task', text: `Completion was recorded for task ${taskId}.`, refs: closed }
    case 'abandoned':
      return {
        kind: 'task',
        text: `Tracking of task ${taskId} ended without completion (abandoned).`,
        refs: closed,
      }
    case 'superseded':
      return {
        kind: 'task',
        text: `Task ${taskId} was superseded: a new request there started a new task.`,
        refs: closed,
      }
    case 'open':
      return {
        kind: 'task',
        text: `Task ${taskId} is open: no close is recorded for it.`,
        refs: [window.opened],
      }
    case 'unbound':
    case 'unknown':
      return {
        kind: 'task',
        text: `No close is recorded for task ${taskId}, but a later task opened there after #${String(window.toSeq)}, so its outcome is unknown.`,
        refs: [window.opened],
      }
  }
}

function declarationClaim(
  state: AssignmentState,
  facts: TaskFacts,
  declared: boolean
): Claim | null {
  const revisions = facts.latestRevisions.map(refOfEvent)
  const recorded = state === 'completion-recorded'
  if (declared) {
    const tail = recorded
      ? ''
      : state === 'open'
        ? '; no completion is recorded yet'
        : state === 'abandoned' || state === 'superseded'
          ? `, but tracking closed as ${state}`
          : ''
    return {
      kind: 'task',
      text: `Every agent's latest plan revision declares it complete${tail}.`,
      refs: revisions,
    }
  }
  const declaring = facts.latestRevisions.filter(declares).map(revisionAgent)
  if (declaring.length > 0) {
    const others = facts.latestRevisions.filter((event) => !declares(event)).map(revisionAgent)
    return {
      kind: 'task',
      text: `Only some agents declare it complete: the latest plan revision of ${declaring.join(', ')} does, and that of ${others.join(', ')} does not${
        recorded ? '. Completion was recorded without every agent declaring it' : ''
      }.`,
      refs: revisions,
    }
  }
  if (!recorded) return null
  return {
    kind: 'task',
    text:
      revisions.length === 0
        ? 'No plan was reported for it, so completion was recorded without an agent declaration.'
        : "No agent's latest plan revision declares it complete, so completion was recorded without an agent declaration.",
    refs: revisions,
  }
}

function progressClaims(taskId: string, facts: TaskFacts): Claim[] {
  if (facts.latestRevisions.length === 0) {
    return [{ kind: 'task', text: `No plan has been reported for task ${taskId}.`, refs: [] }]
  }
  return facts.latestRevisions.flatMap((event): Claim[] => {
    const { payload } = event
    if (payload.type !== 'task.revised') return []
    const finished = payload.steps.filter(
      (step) => step.status === 'done' || step.status === 'skipped'
    ).length
    const active = payload.steps.find((step) => step.status === 'active')
    const parts = [
      `${payload.agentId}'s latest plan (revision ${String(payload.revision)}): ${String(finished)} of ${String(payload.steps.length)} steps finished`,
      active === undefined ? '' : `current step "${chars(active.title, STEP_CHARS)}"`,
      payload.awaitingUser === true ? 'it says it is waiting on the user' : '',
      payload.complete === true ? 'it declares the task complete' : '',
    ].filter((part) => part !== '')
    return [{ kind: 'task', text: `${parts.join('; ')}.`, refs: [refOfEvent(event)] }]
  })
}

function currentClaims(
  window: TaskWindow,
  current: CurrentWork | null,
  interrupted: readonly InterruptedTurn[],
  asOfSeq: number
): Claim[] {
  if (current === null) {
    if (window.closed !== null) return []
    return [
      {
        kind: 'current',
        text: window.requestAfter
          ? 'Whether that conversation is working on this task now is not shown: the user made another request there after the task opened, so current activity may belong to that request.'
          : 'Whether that conversation is working on this task now is not shown: a later task opened there.',
        refs: [],
      },
    ]
  }
  const claims: Claim[] = [
    ...current.turns.map((turn): Claim => ({
      kind: 'current',
      text: `${turn.agentId} has a turn running there.`,
      refs: [turn],
    })),
    ...current.approvals.map((wait): Claim => ({
      kind: 'current',
      text: `${wait.agentId} is waiting for an approval.`,
      refs: [wait],
    })),
    ...current.questions.map((wait): Claim => ({
      kind: 'current',
      text: `${wait.agentId} is waiting for the user to answer a question.`,
      refs: [wait],
    })),
    ...interrupted.map((turn): Claim => ({
      kind: 'current',
      text: `${turn.agentId}'s last turn ended without a recorded result, because its session ended or restarted mid-turn; whether that work finished is unknown.`,
      refs: [turn.started, turn.ended],
    })),
  ]
  return claims.length > 0
    ? claims
    : [
        {
          kind: 'current',
          text: `No running turn or open wait that began in this task's tracked window was found as of #${String(asOfSeq)}. That does not show the conversation is idle: work that began before the window is not attributed to this task.`,
          refs: [],
        },
      ]
}

function observationClaims(observations: WorkObservations): Claim[] {
  const claims: Claim[] = []
  for (const entry of [...observations.commands].reverse()) {
    const { started, completed } = entry
    const result =
      completed === null
        ? ', with no result recorded in this window'
        : completed.exitCode === null
          ? ', with no exit code recorded'
          : `, exit code ${String(completed.exitCode)}`
    claims.push({
      kind: 'observation',
      text: `${started.actor} ran \`${chars(started.command, STEP_CHARS)}\`${result}.`,
      refs: completed === null ? [started] : [started, completed],
    })
  }
  for (const file of [...observations.files].reverse()) {
    const more = file.fileCount > 1 ? ` and ${String(file.fileCount - 1)} more` : ''
    claims.push({
      kind: 'observation',
      text:
        file.source === 'file.change'
          ? `${file.actor} applied a file change to ${file.path ?? 'an unnamed file'}${more}.`
          : `${file.actor} recorded a patch${file.path === null ? '' : ` for ${file.path}`}; that alone does not show the file changed.`,
      refs: [file],
    })
  }
  for (const failure of [...observations.failures].reverse()) {
    const detail = failure.text === '' ? '' : `: ${chars(failure.text, STEP_CHARS)}`
    claims.push({
      kind: 'observation',
      text:
        failure.kind === 'error'
          ? `An error was raised${detail}.`
          : `${failure.actor}'s turn failed${detail}.`,
      refs: [failure],
    })
  }
  const { lastReply, lastActivity, lastOutput } = observations
  if (lastReply !== null) {
    claims.push({
      kind: 'observation',
      text: `${lastReply.actor}'s last reply in this window: "${chars(lastReply.excerpt, OBJECTIVE_CHARS)}"`,
      refs: [lastReply],
    })
  }
  if (lastOutput !== null) {
    claims.push({
      kind: 'observation',
      text: `Last command output in this window came from ${lastOutput.actor}, item ${lastOutput.itemRef}. Its text is not readable here; eventId gives its size.`,
      refs: [lastOutput],
    })
  }
  if (lastActivity !== null) {
    claims.push({
      kind: 'observation',
      text: `Last Work activity in this window: ${lastActivity.type} by ${lastActivity.actor}, recorded ${iso(lastActivity.at)}.`,
      refs: [lastActivity],
    })
  }
  return claims.length > 0
    ? claims
    : [{ kind: 'observation', text: 'No Work activity was recorded in this window.', refs: [] }]
}

export function digestAssignment(input: DigestInput, asOfSeq: number): AssignmentDigest {
  const { child, binding, window } = input
  const { current } = binding
  const taskId = current?.taskId ?? binding.suggestion?.taskId ?? null
  const usable = window !== null && window.taskId === taskId ? window : null
  const state: AssignmentState = current === null ? 'unbound' : stateOf(usable)
  const facts = current !== null && usable !== null ? input.facts : null
  const declared = isDeclared(facts)
  const claims: Claim[] = [...linkClaims(child), ...bindingClaims(binding)]
  if (current !== null) {
    claims.push(stateClaim(state, current.taskId, usable, current.ref, asOfSeq))
    if (facts !== null) {
      const declaration = declarationClaim(state, facts, declared)
      if (declaration !== null) claims.push(declaration)
      claims.push(...progressClaims(current.taskId, facts))
    }
    if (usable !== null) {
      const attributable = usable.open && usable.latest && !usable.requestAfter
      claims.push(
        ...currentClaims(
          usable,
          attributable ? input.current : null,
          attributable ? input.interrupted : [],
          asOfSeq
        )
      )
    }
  }
  if (usable !== null && input.observations !== null) {
    claims.push(...observationClaims(input.observations))
  }
  return {
    conversationId: child.conversationId,
    title: chars(child.title, TITLE_CHARS),
    taskId,
    bound: current !== null,
    state,
    declared,
    window: usable === null ? null : { fromSeq: usable.fromSeq, toSeq: usable.toSeq },
    claims,
    asOfSeq,
  }
}

function fitLines(
  fixed: readonly string[],
  tail: readonly string[],
  sections: readonly { readonly heading: string; readonly lines: readonly string[] }[],
  maxBytes: number
): string {
  const join = (parts: readonly string[]): string => parts.join('\n')
  const omitted = (count: number): string =>
    `(${String(count)} more ${count === 1 ? 'line' : 'lines'} left out for room; read records by eventId or search with query.)`
  const total = sections.reduce((sum, section) => sum + section.lines.length, 0)
  const base = utf8Length(join([...fixed, ...tail]))
  const reserve = total === 0 ? 0 : utf8Length(omitted(total)) + 1
  if (base + reserve > maxBytes) return fit(FORWARDED_NO_ROOM, maxBytes)
  const body: string[] = []
  let used = base
  let shown = 0
  let full = false
  for (const section of sections) {
    let opened = false
    for (const line of section.lines) {
      const heading = opened || section.heading === '' ? 0 : utf8Length(section.heading) + 1
      const cost = utf8Length(line) + 1 + heading
      if (used + cost + (shown + 1 < total ? reserve : 0) > maxBytes) {
        full = true
        break
      }
      if (!opened && section.heading !== '') body.push(section.heading)
      opened = true
      body.push(line)
      used += cost
      shown += 1
    }
    if (full) break
  }
  return join([...fixed, ...body, ...(shown < total ? [omitted(total - shown)] : []), ...tail])
}

export function renderDigest(digest: AssignmentDigest, maxBytes: number): string {
  const asOf = `#${String(digest.asOfSeq)}`
  const of = (kinds: readonly Claim['kind'][]): string[] =>
    digest.claims.filter((claim) => kinds.includes(claim.kind)).map(claimLine)
  const head = `[Chorus forwarded] Forwarded conversation ${digest.conversationId} "${digest.title}", as of ${asOf}. Reading it changes nothing there.`
  const tail = `As of ${asOf}: anything written after that is not included. Search the tracked window with query, or read a cited record with eventId (and offset).`
  const window = digest.window
  const label = digest.taskId === null ? '' : `task ${digest.taskId}`
  return fitLines(
    [head],
    [tail],
    [
      { heading: '', lines: of(['link', 'binding', 'suggestion']) },
      {
        heading: digest.bound ? `Status, from ${label}'s own records:` : '',
        lines: of(['task']),
      },
      { heading: digest.bound ? 'Now:' : '', lines: of(['current']) },
      {
        heading:
          window === null
            ? ''
            : `Observed in that conversation while ${digest.bound ? label : `the suggested ${label}`} was tracked (#${String(window.fromSeq)}–#${String(window.toSeq)}). These are records, not ${digest.bound ? "this task's" : 'its'} status:`,
        lines: of(['observation']),
      },
    ],
    maxBytes
  )
}

function bindingSummary(entry: ForwardedListEntry): string {
  const { current, suggestion } = entry.binding
  if (current === null) {
    return suggestion === null
      ? 'Not marked; no task recorded there yet.'
      : `Not marked; its first task ${suggestion.taskId} ${cite(suggestion)} is only an unconfirmed suggestion.`
  }
  const window = entry.window?.taskId === current.taskId ? entry.window : null
  const state = stateOf(window)
  const closed = window?.closed ?? null
  const status =
    state === 'completion-recorded' && closed !== null
      ? `completion recorded ${cite(closed)}`
      : (state === 'abandoned' || state === 'superseded') && closed !== null
        ? `tracking ended, ${state} ${cite(closed)}`
        : state === 'open'
          ? 'open'
          : 'outcome unknown'
  return `Marked task ${current.taskId} ${cite(current.ref)}: ${status}.`
}

export function renderForwardedList(
  page: ForwardedChildPage,
  entries: readonly ForwardedListEntry[],
  maxBytes: number
): string {
  const asOf = `#${String(page.asOfSeq)}`
  const head = `[Chorus forwarded] Conversations forwarded from this one, newest first, as of ${asOf}.`
  const tail =
    'Read one with conversationId: its marked task’s own records, and the activity observed while that task was tracked.'
  if (page.total === 0) {
    return fit(
      [head, `None: no conversation was forwarded from this one as of ${asOf}.`].join('\n'),
      maxBytes
    )
  }
  const lines = entries.map((entry) => {
    const { child } = entry
    const titled = sameRef(child.titleRef, child.created) ? '' : ` (title ${cite(child.titleRef)})`
    const named = `- ${child.conversationId} ${cite(child.created)}${titled}. ${bindingSummary(entry)}`
    const about = ` Title "${chars(child.title, TITLE_CHARS)}"${
      child.objective === null
        ? '.'
        : `; objective "${chars(child.objective, LIST_OBJECTIVE_CHARS)}".`
    }`
    return `${named}${fit(about, Math.max(LINE_BYTES - utf8Length(named), 0))}`
  })
  const summary = (shown: number): string => {
    const next = page.skip + shown
    return shown === 0
      ? `${String(page.total)} in total. Nothing there at skip=${String(page.skip)}.`
      : `${String(page.total)} in total. Showing ${String(page.skip + 1)}–${String(next)}. ${
          next < page.total ? `Older ones: skip=${String(next)}.` : 'No older ones.'
        }`
  }
  if (lines.length === 0) return fit([head, summary(0)].join('\n'), maxBytes)
  let shown = 0
  while (
    shown < lines.length &&
    utf8Length([head, summary(shown + 1), ...lines.slice(0, shown + 1), tail].join('\n')) <=
      maxBytes
  ) {
    shown += 1
  }
  return shown === 0
    ? fit(FORWARDED_NO_ROOM, maxBytes)
    : [head, summary(shown), ...lines.slice(0, shown), tail].join('\n')
}

export function renderNotForwarded(
  conversationId: string,
  page: ForwardedChildPage,
  maxBytes: number
): string {
  const head = `[Chorus forwarded] No forwarded conversation ${conversationId} is readable here: only conversations forwarded directly from this one are, as of #${String(page.asOfSeq)}.`
  if (page.total === 0) return fit(`${head} None are.`, maxBytes)
  const names = page.children.map(
    (child) => `${child.conversationId} "${chars(child.title, TITLE_CHARS)}"`
  )
  let shown = names.length
  const text = (count: number): string => {
    const rest = page.total - count
    return `${head} Readable: ${names.slice(0, count).join('; ')}${
      rest > 0 ? `; and ${String(rest)} more, listed with scope "forwarded" and skip` : ''
    }.`
  }
  while (shown > 0 && utf8Length(text(shown)) > maxBytes) shown -= 1
  return shown === 0 ? fit(head, maxBytes) : text(shown)
}

export const renderForwardedRefusal = (reason: string, maxBytes: number): string =>
  fit(`[Chorus forwarded] ${reason}`, maxBytes)

const subjectOf = (context: ForwardedReadContext): string =>
  context.taskId === null
    ? 'no task'
    : context.bound
      ? `task ${context.taskId}`
      : `the suggested task ${context.taskId}, which the user has not marked`

function factLabel(event: StoredEvent, context: ForwardedReadContext): string {
  const { payload } = event
  if (
    payload.type === 'task.opened' ||
    payload.type === 'task.revised' ||
    payload.type === 'task.closed'
  ) {
    return payload.taskId === context.taskId
      ? `Task record for ${subjectOf(context)}`
      : `Task record for task ${payload.taskId}`
  }
  if (payload.type === 'assignment.bound') return 'The user’s marking of the forwarded work'
  if (payload.type === 'conversation.created') return 'The forward link'
  if (payload.type === 'conversation.renamed') return 'The title it had'
  return `The request ${subjectOf(context)} was opened for`
}

const REFUSALS: Readonly<
  Record<Extract<AssignmentRecord, { kind: 'refused' }>['reason'], (id: string) => string>
> = {
  unknown: (id) => `No record ${id} exists in that conversation.`,
  later: (id) => `Record ${id} was written after this read started; read again to include it.`,
  private: (id) => `Record ${id} is private reasoning and is not readable.`,
  unrelated: (id) =>
    `Record ${id} is not among the marked task’s records or inside its tracked window, so it is not readable here.`,
  'not-work': (id) =>
    `Record ${id} is not Work activity — Chat, a status heartbeat, or a user or host record — so it is not readable here.`,
}

export function renderRecord(
  record: AssignmentRecord,
  eventId: string,
  context: ForwardedReadContext,
  offset: number,
  maxBytes: number
): string {
  const where = `forwarded conversation ${context.conversationId}`
  const asOf = `as of #${String(context.asOfSeq)}`
  if (record.kind === 'refused') {
    return fit(
      `[Chorus forwarded] ${REFUSALS[record.reason](eventId)} (${where}, ${asOf}.)`,
      maxBytes
    )
  }
  if (record.kind === 'output' || record.kind === 'boundary') {
    const named = `[Chorus forwarded] ${record.kind === 'output' ? 'Command output' : 'Session boundary'} ${cite(record.ref)}`
    const detail =
      record.kind === 'output'
        ? `${record.stream} from ${record.actor} for item ${record.itemRef}, ${String(record.bytes)} bytes, written ${iso(record.ref.at)}. Its text is not readable through this route.`
        : `${record.agentId}'s session ${
            record.boundary === 'session.ended'
              ? `ended${record.reason === null ? '' : ` (${record.reason})`}`
              : record.resumed
                ? 'was resumed'
                : 'started'
          } at ${iso(record.ref.at)}, cutting off a turn that began in ${subjectOf(context)}'s tracked window with no recorded result. It is an observation, not that task's status.`
    const full = `${named} in ${where}, ${asOf}: ${detail}`
    if (utf8Length(full) <= maxBytes) return full
    const brief = `${named}: ${
      record.kind === 'output'
        ? `${String(record.bytes)} bytes, its text withheld`
        : `${record.agentId} ${record.boundary}`
    }, ${asOf}.`
    return utf8Length(brief) <= maxBytes ? brief : fit(FORWARDED_NO_ROOM, maxBytes)
  }
  const { event } = record
  const ref = refOfEvent(event)
  const window = context.window
  const written = `${cite(ref)}, written ${iso(event.createdAt)},`
  const head =
    record.kind === 'fact'
      ? `[Chorus forwarded] ${factLabel(event, context)} ${written} in ${where}, ${asOf}.`
      : `[Chorus forwarded] Observation ${written} recorded in ${where} while ${subjectOf(context)} was tracked${
          window === null ? '' : ` (#${String(window.fromSeq)}–#${String(window.toSeq)})`
        }, ${asOf}. It is not that task's status.`
  const text = `${event.actor} ${event.type}:\n${JSON.stringify(event.payload)}`
  const status = (start: number, end: number, total: number): string =>
    `Bytes ${String(start)}–${String(end)} of ${String(total)}. ` +
    (end < total ? `Continue with eventId ${event.id} offset ${String(end)}.` : 'End of record.')
  const total = utf8Length(text)
  const room = maxBytes - utf8Length(head) - utf8Length(status(total, total, total + 1)) - 3
  if (room < 64) return fit(FORWARDED_NO_ROOM, maxBytes)
  const part = sliceUtf8(text, offset, room)
  if (offset > 0 && part.start >= part.total) {
    const past = `Offset ${String(offset)} is past the end: this record has ${String(part.total)} bytes.`
    return `${head}\n${fit(past, maxBytes - utf8Length(head) - 1)}`
  }
  return [head, status(part.start, part.end, part.total), '', part.text].join('\n')
}

export function renderSearch(
  page: WindowSearchPage,
  query: string,
  context: ForwardedReadContext,
  maxBytes: number
): string {
  const window = context.window
  const asOf = `#${String(context.asOfSeq)}`
  if (window === null) {
    return fit(
      `[Chorus forwarded] There is no tracked window to search in forwarded conversation ${context.conversationId} as of ${asOf}: no task has been recorded there. That does not show that no work was done there.`,
      maxBytes
    )
  }
  const head = `[Chorus forwarded] Search for "${query}" (literal; ASCII letters match either case) in forwarded conversation ${context.conversationId}, within ${subjectOf(context)}'s tracked window (#${String(window.fromSeq)}–#${String(window.toSeq)}), Work activity only, as of ${asOf}: ${String(page.total)} matching records. These are observations, not task status.`
  const end = Math.max(page.total - page.skip, 0)
  const status = (shown: number): string => {
    if (shown === 0) return `Nothing there at skip=${String(page.skip)}.`
    const from = end - shown
    return `Showing ${String(from + 1)}–${String(end)}, oldest first. ${
      from > 0 ? `Older matches: skip=${String(page.skip + shown)}.` : 'No older matches.'
    }`
  }
  const lines = page.matches.map((match) =>
    fit(
      `${cite(match)} ${match.actor} ${match.type}: ${match.clippedStart ? ELLIPSIS : ''}${match.snippet}${
        match.clippedEnd ? ELLIPSIS : ''
      }`,
      LINE_BYTES
    )
  )
  if (lines.length === 0) return fit([head, status(0)].join('\n'), maxBytes)
  let shown = 0
  while (
    shown < lines.length &&
    utf8Length([head, status(shown + 1), ...lines.slice(0, shown + 1)].join('\n')) <= maxBytes
  ) {
    shown += 1
  }
  return shown === 0
    ? fit(FORWARDED_NO_ROOM, maxBytes)
    : [head, status(shown), ...lines.slice(0, shown).reverse()].join('\n')
}

export function interruptedTurns(
  events: readonly StoredEvent[],
  fromSeq: number
): InterruptedTurn[] {
  const open = new Map<string, StoredEvent>()
  const interrupted = new Map<string, InterruptedTurn>()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq < fromSeq) continue
    const { payload } = event
    if (payload.type === 'turn.started') {
      open.set(event.actor, event)
      interrupted.delete(event.actor)
    } else if (payload.type === 'turn.completed') {
      open.delete(event.actor)
      interrupted.delete(event.actor)
    } else if (payload.type === 'session.started' || payload.type === 'session.ended') {
      const started = open.get(payload.agentId)
      if (started === undefined) continue
      open.delete(payload.agentId)
      interrupted.set(payload.agentId, {
        agentId: payload.agentId,
        started: refOfEvent(started),
        ended: refOfEvent(event),
      })
    }
  }
  return [...interrupted.values()]
}
