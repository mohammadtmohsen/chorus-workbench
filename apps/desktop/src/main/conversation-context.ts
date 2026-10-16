import type { StoredEvent } from '@chorus/event-store'
import type { CarryoverSource } from '@chorus/orchestrator'

type Created = Extract<StoredEvent['payload'], { readonly type: 'conversation.created' }>
export type ForwardContext = NonNullable<Created['forward']>
type ReadEvents = (conversationId: string) => readonly StoredEvent[]

export function forwardContext(events: readonly StoredEvent[]): ForwardContext | undefined {
  const created = events.find((event) => event.payload.type === 'conversation.created')
  return created?.payload.type === 'conversation.created' &&
    created.payload.continuedFrom !== undefined
    ? created.payload.forward
    : undefined
}

export function conversationChain(
  read: ReadEvents,
  conversationId: string,
  throughSeq?: number
): CarryoverSource[] {
  const sources: CarryoverSource[] = []
  const visited = new Set<string>()
  let id: string | undefined = conversationId
  let boundary = throughSeq

  while (id !== undefined && !visited.has(id)) {
    visited.add(id)
    const events = read(id)
    const visible = events.filter((event) => boundary === undefined || event.seq <= boundary)
    const created = visible.find((event) => event.payload.type === 'conversation.created')
    const meta = created?.payload.type === 'conversation.created' ? created.payload : undefined
    const renamed = visible.findLast((event) => event.payload.type === 'conversation.renamed')
    const title =
      renamed?.payload.type === 'conversation.renamed' ? renamed.payload.title : (meta?.title ?? id)

    sources.unshift({
      conversationId: id,
      title,
      events,
      ...(boundary === undefined ? {} : { throughSeq: boundary }),
    })
    id = meta?.continuedFrom
    if (id !== undefined) {
      boundary = Math.min(
        boundary ?? Number.MAX_SAFE_INTEGER,
        meta?.forward?.throughSeq ?? Math.max((created?.seq ?? 1) - 1, 0)
      )
    }
  }

  return sources
}
