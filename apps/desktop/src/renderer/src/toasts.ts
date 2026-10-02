import { createSignal, type Signal } from './workspace/signal.js'
import type { AttentionEvent, TranscriptEvent } from '../../shared/ipc.js'

export const NOTICE_KEY: Record<
  AttentionEvent['reason'],
  'notify.waiting' | 'notify.question' | 'notify.idle'
> = {
  approval: 'notify.waiting',
  question: 'notify.question',
  idle: 'notify.idle',
}

export const toasts: Signal<readonly AttentionEvent[]> = createSignal<readonly AttentionEvent[]>([])

export function toastKey(toast: AttentionEvent): string {
  if (toast.reason === 'approval') return `a:${toast.approvalId}`
  if (toast.reason === 'question') return `q:${toast.userInputId}`
  return `i:${toast.conversationId}`
}

export function addToast(toast: AttentionEvent): void {
  const current = toasts.get()
  const key = toastKey(toast)
  if (current.some((existing) => toastKey(existing) === key)) return
  toasts.set([toast, ...current])
}

export function dismissToast(key: string): void {
  const current = toasts.get()
  const next = current.filter((toast) => toastKey(toast) !== key)
  if (next.length !== current.length) toasts.set(next)
}

export function reduceToasts(
  current: readonly AttentionEvent[],
  events: readonly TranscriptEvent[]
): readonly AttentionEvent[] {
  let next = current

  for (const event of events) {
    const payload = event.payload
    const approvalId = typeof payload['approvalId'] === 'string' ? payload['approvalId'] : null
    const userInputId = typeof payload['userInputId'] === 'string' ? payload['userInputId'] : null

    const drop = (keep: (toast: AttentionEvent) => boolean): void => {
      const remaining = next.filter(keep)
      if (remaining.length !== next.length) next = remaining
    }

    switch (event.type) {
      case 'approval.decided':
      case 'approval.withdrawn':
        if (approvalId !== null) {
          drop((toast) => toast.reason !== 'approval' || toast.approvalId !== approvalId)
        }
        break
      case 'userinput.answered':
        if (userInputId !== null) {
          drop((toast) => toast.reason !== 'question' || toast.userInputId !== userInputId)
        }
        break
      case 'turn.started':
      case 'user.message':
      case 'session.ended':
        drop((toast) => toast.reason !== 'idle' || toast.conversationId !== event.conversationId)
        break
      default:
        break
    }
  }

  return next
}

export function pruneToasts(events: readonly TranscriptEvent[]): void {
  const current = toasts.get()
  const next = reduceToasts(current, events)
  if (next !== current) toasts.set(next)
}
