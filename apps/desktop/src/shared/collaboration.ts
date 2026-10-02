import { isAgentId, type AgentId } from '@chorus/shared'

export interface CollaborationPair {
  readonly leader: AgentId
  readonly partner: AgentId
}

const MENTION = /(?:^|\s)@([a-z][a-z0-9-]*)\b/gi
const LEGACY_TASK =
  /^@([a-z][a-z0-9-]*) Run this task collaboratively with ([a-z][a-z0-9-]*)\.\n\n# TASK\n\n/
const LEGACY_PROMPT =
  /^(?:@[a-z][a-z0-9-]* )?Run this task collaboratively with ([a-z][a-z0-9-]*)\.\n\n/
const LEGACY_APPENDED =
  /\n\nRun this task collaboratively with ([a-z][a-z0-9-]*)\.\n\nYou are the LEAD ENGINEER and ORCHESTRATOR\./
const LEGACY_APPENDED_ALL = new RegExp(LEGACY_APPENDED.source, 'g')
const LEGACY_HANDOFF = '# 0. HOW TO HAND OVER — THE RUN STOPS WITHOUT THIS'
const EARLY_APPENDED_END = '- Running code and observable evidence are the final authority.'

function legacyEnd(partner: string): string {
  return `- A reply whose next step belongs to ${partner} and which does not end with an @${partner} line stops the run.`
}

function rolesHeadings(leader: AgentId, partner: AgentId): readonly string[] {
  return [
    `\n\n# ROLES AND SCOPE\n\nYou, ${leader}, are the lead and coordinator. ${partner} is your collaborator.`,
    `\n\n# ROLES\n\nYou, ${leader}, are the LEAD ENGINEER and ORCHESTRATOR. ${partner} is the CODER.`,
  ]
}

export function isExpandedCollaboration(text: string): boolean {
  const partner = LEGACY_PROMPT.exec(text)?.[1] ?? LEGACY_APPENDED.exec(text)?.[1]
  return (
    isAgentId(partner) &&
    text.includes(LEGACY_HANDOFF) &&
    text.includes(legacyEnd(partner))
  )
}

export function originalCollaborationText(text: string): string {
  let current = text
  while (true) {
    const unwrapped = withoutEnvelope(current) ?? withoutAppendedPrompt(current)
    if (unwrapped === null) return current
    current = unwrapped
  }
}

function withoutEnvelope(text: string): string | null {
  const match = LEGACY_TASK.exec(text)
  if (match === null) return null
  const leader = match[1]
  const partner = match[2]
  if (!isAgentId(leader) || !isAgentId(partner) || leader === partner) return null
  const ending = legacyEnd(partner)
  const end = text.lastIndexOf(ending)
  if (end < match[0].length) return null
  const roles = Math.max(
    ...rolesHeadings(leader, partner).map((heading) => text.lastIndexOf(heading, end))
  )
  if (roles < match[0].length) return null
  const handoff = text.indexOf(LEGACY_HANDOFF, roles)
  if (handoff === -1 || handoff >= end) return null
  const anotherHandoff = text.indexOf(LEGACY_HANDOFF, handoff + LEGACY_HANDOFF.length)
  if (anotherHandoff !== -1 && anotherHandoff < end) return null
  const task = text.slice(match[0].length, roles)
  if (task.trim() === '') return null
  return `${task}${text.slice(end + ending.length)}`
}

function withoutAppendedPrompt(text: string): string | null {
  const match = [...text.matchAll(LEGACY_APPENDED_ALL)].at(-1)
  const partner = match?.[1]
  if (match === undefined || !isAgentId(partner)) return null
  const typed = text.slice(0, match.index)
  if (!namesAnotherAgent(typed, partner)) return null
  const handoff = text.indexOf(LEGACY_HANDOFF, match.index)
  const ending = handoff === -1 ? EARLY_APPENDED_END : legacyEnd(partner)
  const end = text.indexOf(ending, match.index)
  if (end === -1 || handoff > end) return null
  return `${typed}${text.slice(end + ending.length)}`
}

function namesAnotherAgent(text: string, partner: AgentId): boolean {
  return [...text.matchAll(MENTION)].some((match) => {
    const name = match[1]?.toLowerCase()
    return isAgentId(name) && name !== partner
  })
}

export function isTeamCommand(text: string): boolean {
  return /^\/team(?:\s|$)/.test(text.trimStart())
}

export function collaborationPair(
  draft: string,
  participants: readonly string[]
): CollaborationPair | null {
  let leader: AgentId | null = null
  for (const match of draft.matchAll(MENTION)) {
    const name = match[1]?.toLowerCase()
    if (!isAgentId(name) || !participants.includes(name) || name === leader) continue
    if (leader === null) {
      leader = name
      continue
    }
    return { leader, partner: name }
  }
  return null
}
