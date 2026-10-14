import { AGENT_IDS } from '@chorus/shared'

export type LiveMessageMode = 'auto' | 'ask' | 'guide'
export type LiveMessageAction = 'ask' | 'guide' | 'status' | 'stop'

export const LIVE_REPLY_PREFIX = 'live-question:'
export const LIVE_USER_PREFIX = 'live-question-user:'

export function isLiveReply(key: string): boolean {
  return key.startsWith(LIVE_REPLY_PREFIX)
}

export function isLiveInteraction(key: string): boolean {
  return isLiveReply(key) || key.startsWith(LIVE_USER_PREFIX)
}

export function liveMessageText(text: string): string {
  return text
    .trimStart()
    .replace(/^\/(?:ask|guide|status|stop)(?:\s+|$)/i, '')
    .trim()
}

export function liveMessageAction(
  text: string,
  mode: LiveMessageMode = 'auto',
  working = true
): LiveMessageAction {
  let body = text.trim()
  while (body.startsWith('@')) {
    const space = body.search(/\s/)
    const name = (space < 0 ? body : body.slice(0, space)).slice(1).toLowerCase()
    if (!AGENT_IDS.some((agent) => agent === name)) break
    body = space < 0 ? '' : body.slice(space).trimStart()
  }
  const first = body.split(/\n\s*\n/, 1)[0]?.trim() ?? ''
  const command = /^\/(ask|guide|status|stop)(?:\s|$)/i.exec(first)?.[1]?.toLowerCase()
  if (command === 'ask' || command === 'guide' || command === 'status' || command === 'stop') {
    return command
  }
  if (
    /^(?:please\s+)?(?:stop|pause|cancel)(?:\s+(?:now|working|the\s+(?:task|work)|all(?:\s+agents)?))?[.!]*$/i.test(
      first
    )
  ) {
    return 'stop'
  }
  if (mode !== 'auto') return mode
  if (
    /^(?:(?:status|progress)(?:\s+update)?|(?:what(?:'s| is)\s+(?:the\s+)?(?:status|progress))|what\s+are\s+you\s+doing(?:\s+(?:now|right\s+now))?|how(?:'s| is)\s+it\s+going|how\s+(?:far|much)\s+(?:have\s+you\s+(?:got|done)|is\s+done)|are\s+you\s+(?:done|still\s+working))[?.!]*$/i.test(
      first
    )
  ) {
    return 'status'
  }
  if (!working) return 'guide'
  if (first.startsWith('>') || first.startsWith('```')) return 'guide'
  if (/^(?:do\s+(?:that|it)|go\s+ahead|yes(?:\s+please)?|ok(?:ay)?)[.!]*$/i.test(first))
    return 'guide'
  if (
    /(?:^|[.!?;,]\s*)(?:please\s+)?(?:(?:can|could|would|will|should)\s+(?:you|we)\s+)?(?:implement|build|fix|change|update|replace|remove|delete|add|write|create|make|run|test|install|commit|push|deploy|publish|refactor|use|switch|continue|resume)\b/i.test(
      first
    )
  ) {
    return 'guide'
  }
  if (/\b(?:actually|instead)\b/i.test(first)) return 'guide'
  if (
    /^(?:what|why|how|which|where|when|who|is|are|does|do|did|can|could|would|will|should|have|has)\b/i.test(
      first
    )
  ) {
    return 'ask'
  }
  if (/^(?:please\s+)?(?:explain|tell\s+me|help\s+me\s+understand)\b/i.test(first)) {
    return 'ask'
  }
  if (/[?؟]$/.test(first)) return 'ask'
  return 'guide'
}
