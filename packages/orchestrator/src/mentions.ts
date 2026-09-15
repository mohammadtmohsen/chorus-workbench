import type { AgentId } from '@chorus/shared'

/**
 * Decides which agent a message is addressed to.
 *
 * This is the routing rule for the shared conversation: one transcript, several
 * agents, each with its own context. Getting it wrong is expensive in both
 * directions — a message sent to nobody looks like the app hung, and a message
 * broadcast to everyone doubles the cost and produces two agents talking past
 * each other.
 */

export interface MentionRoute {
  /** Agents that should receive this turn. Never empty when participants exist. */
  readonly targets: readonly AgentId[]
  /** The message with its leading mentions removed, as the agent should see it. */
  readonly text: string
  /** True when the user named the recipients rather than us inferring them. */
  readonly explicit: boolean
}

export interface RouteContext {
  /** Agents with a live session in this conversation. */
  readonly participants: readonly AgentId[]
  /** Who the user last addressed, used when a message names nobody. */
  readonly lastAddressed?: AgentId | undefined
}

/** `@codex`, `@claude` — word-boundary anchored so `email@codex.dev` is not a mention. */
const MENTION = /(?:^|\s)@([a-z][a-z0-9-]*)\b/gi

export function parseMentions(text: string, context: RouteContext): MentionRoute {
  const known = new Set(context.participants)
  const named: AgentId[] = []

  for (const match of text.matchAll(MENTION)) {
    const name = match[1]?.toLowerCase()
    if (name === undefined) continue
    if (known.has(name as AgentId) && !named.includes(name as AgentId)) {
      named.push(name as AgentId)
    }
  }

  if (named.length > 0) {
    const { leading, rest } = splitLeadingMentions(text, named)
    return {
      targets: leading.length > 0 ? leading : named.slice(0, 1),
      text: rest,
      explicit: true,
    }
  }

  return { targets: inferTarget(context), text: text.trim(), explicit: false }
}

/**
 * With nobody named, prefer whoever the user last addressed. A conversation
 * naturally continues with the same agent, and silently switching would send
 * a follow-up to an agent that never saw what it follows.
 */
function inferTarget(context: RouteContext): readonly AgentId[] {
  const { participants, lastAddressed } = context
  if (participants.length === 0) return []
  if (lastAddressed !== undefined && participants.includes(lastAddressed)) return [lastAddressed]
  const first = participants[0]
  return first === undefined ? [] : [first]
}

/**
 * Strips mentions only from the start of the message.
 *
 * A mid-sentence mention is usually meaningful content — "ask @codex to review
 * this" — and removing it would change what the agent reads.
 */
function splitLeadingMentions(
  text: string,
  named: readonly AgentId[]
): { leading: AgentId[]; rest: string } {
  const leading: AgentId[] = []
  let rest = text.trimStart()
  for (;;) {
    const match = /^@([a-z][a-z0-9-]*)\b[,:]?\s*/i.exec(rest)
    const name = match?.[1]?.toLowerCase()
    if (match === null || name === undefined) break
    if (!named.includes(name as AgentId)) break
    if (!leading.includes(name as AgentId)) leading.push(name as AgentId)
    rest = rest.slice(match[0].length)
  }
  return { leading, rest: rest.trim() }
}

export interface ReplyHandoff {
  readonly to: AgentId
  readonly prompt: string
  readonly above: string
}

export function findReplyHandoff(
  reply: string,
  from: AgentId,
  agents: readonly AgentId[]
): ReplyHandoff | null {
  const lines = reply.split('\n')
  let fenced = false
  let call: { readonly index: number; readonly to: AgentId; readonly rest: string } | null = null
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^@([a-z][a-z0-9-]*)\b[,:]?\s*/i.exec(line)
    const name = match?.[1]?.toLowerCase()
    const to = agents.find((agent) => agent === name)
    if (match === null || to === undefined || to === from) continue
    call = { index, to, rest: line.slice(match[0].length) }
  }
  if (call === null) return null
  const prompt = [call.rest, ...lines.slice(call.index + 1)].join('\n').trim()
  if (prompt === '') return null
  return { to: call.to, prompt, above: lines.slice(0, call.index).join('\n').trim() }
}

export function callRule(agents: readonly AgentId[]): string {
  return [
    `Agents in this conversation: ${agents.join(', ')}.`,
    'To call another agent, for a review, a task, advice or anything else, end your reply',
    'with a line that starts with @ and its name, such as @codex, followed by what you want.',
    'Everything from that line down is sent to that agent, and it starts at once.',
    'When an agent calls you, answer it the same way.',
    'Leave that line out when your answer is for the user.',
    "Never start a line with an agent's name unless you mean to call it.",
  ].join(' ')
}

/** Renders a route for a log line or a UI hint. */
export function describeRoute(route: MentionRoute): string {
  if (route.targets.length === 0) return 'nobody'
  return route.targets.join(' and ')
}
