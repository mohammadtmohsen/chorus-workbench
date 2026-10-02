import type { TranscriptEvent } from '../../shared/ipc.js'

/** How many rooms are blocked on a person, which is what a dock badge answers. */
export function roomsWaiting(pending: Readonly<Record<string, readonly string[]>>): number {
  return Object.values(pending).filter((ids) => ids.length > 0).length
}

/**
 * Which approvals and questions are still unanswered, per conversation.
 *
 * Tracked by id rather than counted, because the requests and their answers
 * arrive in separate pushes and a counter cannot tell a second question from a
 * repeat of the first.
 */
export function trackPending(
  pending: Readonly<Record<string, readonly string[]>>,
  events: readonly TranscriptEvent[]
): Readonly<Record<string, readonly string[]>> {
  let next = pending
  const edit = (conversationId: string, change: (ids: readonly string[]) => readonly string[]) => {
    const before = next[conversationId] ?? []
    const after = change(before)
    if (after === before) return
    next = { ...next, [conversationId]: after }
  }

  for (const event of events) {
    const p = event.payload
    const approvalId = typeof p['approvalId'] === 'string' ? `a:${p['approvalId']}` : null
    const questionId = typeof p['userInputId'] === 'string' ? `q:${p['userInputId']}` : null

    switch (event.type) {
      case 'approval.requested':
      case 'userinput.requested': {
        const id = approvalId ?? questionId
        if (id === null) break
        edit(event.conversationId, (ids) => (ids.includes(id) ? ids : [...ids, id]))
        break
      }
      case 'approval.decided':
      case 'userinput.answered': {
        const id = approvalId ?? questionId
        if (id === null) break
        edit(event.conversationId, (ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids))
        break
      }
      default:
        break
    }
  }

  return next
}
