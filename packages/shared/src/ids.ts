import { z } from 'zod'

declare const brand: unique symbol

/** Nominal typing so a ConversationId can never be passed where an EventId is wanted. */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type EventId = Brand<string, 'EventId'>
export type ConversationId = Brand<string, 'ConversationId'>
export type ProjectId = Brand<string, 'ProjectId'>
export type MessageId = Brand<string, 'MessageId'>
export type ApprovalId = Brand<string, 'ApprovalId'>
/**
 * A question set, not a question. Both providers answer every question in one
 * response, so the whole set is what has an identity and what gets answered.
 */
export type UserInputId = Brand<string, 'UserInputId'>
export type HandoffId = Brand<string, 'HandoffId'>
export type AgentSessionId = Brand<string, 'AgentSessionId'>

/**
 * Which agent produced or is targeted by something.
 *
 * **The tuple is the declaration and the type is derived from it**, so a new
 * agent is added in exactly one place. It used to be a hand-written union with
 * the pair spelled out again at 119 further sites, of which the compiler saw
 * eighteen — every `z.enum`, every equality predicate and every per-agent record
 * kept compiling while silently excluding whoever was added.
 */
export const AGENT_IDS = ['codex', 'claude', 'deepseek'] as const

export type AgentId = (typeof AGENT_IDS)[number]

/** Who acted. `system` covers Chorus itself (timeouts, policy auto-decisions). */
export const ACTORS = ['user', 'system', ...AGENT_IDS] as const

export type Actor = (typeof ACTORS)[number]

export const AgentIdSchema = z.enum(AGENT_IDS)
export const ActorSchema = z.enum(ACTORS)

/**
 * Narrows an `Actor` — or anything else — to an agent.
 *
 * Replaces the `x === 'codex' || x === 'claude'` predicate and its negation,
 * which were written out at twenty-two sites and are the shape that compiles
 * happily while dropping an agent the union already knows about.
 */
export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)
}

/**
 * A value per agent, built from the tuple rather than written out.
 *
 * The eleven per-agent object literals this replaces — `models`, `efforts`,
 * `openChanges` and the defaults beside them — name their keys directly, so
 * adding an agent left a hole that no typecheck reported. `Record<AgentId, T>`
 * is only enforced when the object is *annotated* with it, and most were not.
 */
export function agentRecord<T>(value: (id: AgentId) => T): Record<AgentId, T> {
  return Object.fromEntries(AGENT_IDS.map((id) => [id, value(id)])) as Record<AgentId, T>
}

/**
 * UUIDv7 — time-ordered, so `events.seq` and id ordering agree and an index on
 * id stays local rather than scattering writes across the B-tree.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const ts = Date.now()
  // 48-bit big-endian millisecond timestamp.
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff

  // Version 7 in the high nibble of octet 6; RFC 4122 variant in octet 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const newEventId = (): EventId => uuidv7() as EventId
export const newConversationId = (): ConversationId => uuidv7() as ConversationId
export const newProjectId = (): ProjectId => uuidv7() as ProjectId
export const newMessageId = (): MessageId => uuidv7() as MessageId
export const newApprovalId = (): ApprovalId => uuidv7() as ApprovalId
export const newUserInputId = (): UserInputId => uuidv7() as UserInputId
export const newHandoffId = (): HandoffId => uuidv7() as HandoffId
export const newAgentSessionId = (): AgentSessionId => uuidv7() as AgentSessionId
