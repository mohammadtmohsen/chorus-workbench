import type { AgentId } from '@chorus/shared'

export const COLLABORATORS = ['claude', 'deepseek'] as const satisfies readonly AgentId[]

export interface CollaborationPair {
  readonly leader: AgentId
  readonly partner: AgentId
}

const MENTION = /(?:^|\s)@([a-z][a-z0-9-]*)\b/gi

export function collaborationPair(
  draft: string,
  participants: readonly string[]
): CollaborationPair | null {
  for (const match of draft.matchAll(MENTION)) {
    const name = match[1]?.toLowerCase()
    const leader = COLLABORATORS.find((id) => id === name)
    if (leader === undefined) continue
    const partner = COLLABORATORS.find((id) => id !== leader)
    if (partner === undefined) continue
    if (!participants.includes(leader) || !participants.includes(partner)) continue
    return { leader, partner }
  }
  return null
}

export function appendPrompt(draft: string, prompt: string): string {
  const body = draft.replace(/\s+$/, '')
  return body === '' ? prompt : `${body}\n\n${prompt}`
}
