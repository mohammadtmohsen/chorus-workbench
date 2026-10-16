import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'
import { callRule } from './mentions.js'
import {
  clipToBytes,
  CONTEXT_DEFERRED_PREFIX,
  collectLines,
  fitBytes,
  trimMiddle,
  utf8Bytes,
  type TranscriptLine,
} from './transcript-lines.js'

/**
 * Lets an agent read what it missed while somebody else was talking.
 *
 * Chorus routes each message to the agent it was addressed to, which keeps cost
 * and duplicate answers down — but on its own it produces a conversation that
 * only looks shared. Ask Codex about something Claude just said and it has never
 * seen it: observed live, Codex answered "what i asked claude" by grepping
 * `~/.claude` off disk, because the transcript on screen was not in its context.
 *
 * So before an agent is asked to answer, it is handed the part of the shared
 * thread it has not seen. Delivering the message is what starts a turn, so the
 * catch-up rides along with it: no extra turn, no extra cost when nothing was
 * missed, and no second agent woken up to listen.
 *
 * Two kinds of thing are replayed:
 *
 *  - **Speech** — user messages and other agents' completed replies.
 *  - **Activity** — what another agent actually did: commands it ran and how
 *    they exited, files it changed, errors it hit. Speech alone left this too
 *    thin: an agent's summary of a failing test run is not the failing test run,
 *    and "why did that fail" is exactly the question the other agent gets asked.
 *
 * Activity is one line each, never a replay of the other agent's whole session.
 * Reasoning stays out — it is the agent's private working, and it is enormous.
 * Command output appears only when the command failed, which is the only time
 * anyone asks about it.
 *
 * When the budget binds, activity is dropped before speech: losing "claude ran
 * the tests" costs less than losing what claude said about them.
 */

/** Big enough for a real exchange, small enough not to dominate a turn. */
const MAX_TOTAL_BYTES = 12_000
const MAX_MESSAGE_CHARS = 1_500
const DISCUSSION_MESSAGE_CHARS = 6_000
/** Activity is supporting detail, so it may not crowd out what was said. */
const ACTIVITY_SHARE = 0.4
const HISTORY_MESSAGE_CHARS = 10_000

export interface CatchupInput {
  readonly recipient: AgentId
  /** Everything in the conversation the recipient has not seen, in `seq` order. */
  readonly events: readonly StoredEvent[]
  /** Who else is in the room, for the line that explains the format. */
  readonly participants: readonly AgentId[]
  readonly maxTotalChars?: number
  readonly maxTotalBytes?: number
  readonly maxMessageChars?: number
  readonly includeOwnDiscussion?: boolean
  readonly includeOwnMessages?: boolean
  readonly retrieval?: boolean
}

/**
 * Returns the message to deliver: the catch-up plus `message`, or `message`
 * unchanged when nothing was missed.
 */
export function withCatchup(input: CatchupInput, message: string, from?: AgentId): string {
  const preamble = composeCatchup(input)
  const rule = callRuleLine(input.participants)
  if (rule === null && preamble === null && from === undefined) return message
  const intro =
    from === undefined
      ? 'The user now says to you:'
      : `${from} now says to you (to answer ${from}, start a line with @${from}):`
  return [rule, preamble, `${intro}\n${message}`].filter((part) => part !== null).join('\n\n')
}

export function withCallRule(participants: readonly AgentId[], message: string): string {
  const rule = callRuleLine(participants)
  return rule === null ? message : `${rule}\n\n${message}`
}

function callRuleLine(participants: readonly AgentId[]): string | null {
  return participants.length > 1 ? `[Chorus] ${callRule(participants)}` : null
}

/** The catch-up block alone, or `null` when the recipient is already current. */
export function composeCatchup(input: CatchupInput): string | null {
  const ceiling = Math.max(input.maxTotalBytes ?? input.maxTotalChars ?? MAX_TOTAL_BYTES, 0)
  const collected = collectLines(
    input.events,
    input.includeOwnMessages === true ? null : input.recipient,
    input.includeOwnDiscussion === true
  )
  if (collected.length === 0) return null

  const lines = collected.map((line) => {
    const cap =
      input.maxMessageChars ?? (line.discussion ? DISCUSSION_MESSAGE_CHARS : MAX_MESSAGE_CHARS)
    const text = trimMiddle(line.text, cap)
    const reference = `[#${String(line.seq)} ${line.eventId}] `
    return {
      ...line,
      text:
        text === line.text || input.retrieval === false
          ? `${reference}${text}`
          : `${reference}${text}\n(full record: read_transcript eventId ${line.eventId})`,
    }
  })
  const conversations = [...new Set(collected.map((line) => line.conversationId))]
  const others = input.participants.filter((id) => id !== input.recipient)
  const head = [
    `[Chorus] You are "${input.recipient}" in a shared conversation with the user` +
      `${others.length === 0 ? '' : ` and ${others.join(' and ')}`}. ` +
      'Everyone reads one transcript, but each of you is only addressed by name. ' +
      'Here is what happened while you were not addressed — context only, ' +
      'already handled by whoever it was addressed to. Each entry is marked [#seq event-id]' +
      `${conversations.length === 1 ? ` from conversation ${String(conversations[0])}` : ''}; ` +
      'entries whose text starts with · are actions another agent took, not requests to you.',
    '',
    '--- transcript ---',
  ]
  const foot = '--- end transcript ---'
  const omitted = (count: number): string => `(${String(count)} earlier entries omitted)`
  const fixed =
    utf8Bytes(head.join('\n')) + 1 + utf8Bytes(foot) + utf8Bytes(omitted(lines.length)) + 1
  if (fixed > ceiling) {
    return (
      CONTEXT_DEFERRED_PREFIX +
      `[Chorus] ${String(lines.length)} entries were added to this shared conversation while you were not addressed, ` +
      (input.retrieval === false
        ? 'and there is no room to show them in this session; say so rather than guessing about them.'
        : 'and there is no room to include them here. Read them with read_transcript before relying on what happened.')
    )
  }

  const { kept, dropped } = fitToBudget(lines, ceiling - fixed)
  const text = [
    ...head,
    ...(dropped === 0 ? [] : [omitted(dropped)]),
    ...kept.map((line) => line.text),
    foot,
  ].join('\n')
  return utf8Bytes(text) <= ceiling ? text : clipToBytes(text, ceiling)
}

export function composeHistory(
  events: readonly StoredEvent[],
  request: { readonly skip: number; readonly count: number }
): string {
  const lines = collectLines(events, null)
  const end = Math.max(lines.length - request.skip, 0)
  const start = Math.max(end - request.count, 0)
  if (start === end) {
    return `Nothing there. This conversation has ${String(lines.length)} entries.`
  }
  return [
    `Entries ${String(start + 1)} to ${String(end)} of ${String(lines.length)}, oldest first.`,
    '',
    ...lines.slice(start, end).map((line) => trimMiddle(line.text, HISTORY_MESSAGE_CHARS)),
  ].join('\n')
}

/**
 * Keeps the most recent lines that fit, shedding activity before speech.
 *
 * Oldest-first is the right thing to drop within each kind: the tail is what the
 * next message actually follows on from.
 */
function fitToBudget(
  lines: readonly TranscriptLine[],
  budget: number
): { kept: TranscriptLine[]; dropped: number } {
  const cost = (line: TranscriptLine): number => utf8Bytes(line.text) + 1
  const activityBudget = Math.floor(budget * ACTIVITY_SHARE)

  // Pass one: cap activity on its own, so a chatty tool loop cannot evict the
  // conversation it was supporting.
  const trimmed: TranscriptLine[] = []
  let activityUsed = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue
    if (line.kind === 'activity') {
      if (activityUsed + cost(line) > activityBudget) continue
      activityUsed += cost(line)
    }
    trimmed.unshift(line)
  }

  // Pass two: the overall budget, newest first, whatever the kind.
  const kept: TranscriptLine[] = []
  let used = 0
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const line = trimmed[i]
    if (line === undefined) continue
    if (used + cost(line) > budget) {
      if (kept.length === 0 && budget > 1)
        kept.unshift({ ...line, text: fitBytes(line.text, budget - 1) })
      break
    }
    used += cost(line)
    kept.unshift(line)
  }

  return { kept, dropped: lines.length - kept.length }
}
