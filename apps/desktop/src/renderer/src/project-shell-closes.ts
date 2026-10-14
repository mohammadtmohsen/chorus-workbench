import { useEffect, useSyncExternalStore } from 'react'
import type { TerminalRefShape } from '../../shared/ipc.js'

export type ShellRef = Extract<TerminalRefShape, { scope: 'shell' }>

export interface ShellQuestion {
  readonly ref: ShellRef
  readonly process: string
}

type RemoveShell = (projectId: string, id: string) => void

interface Close {
  readonly ref: ShellRef
  question: ShellQuestion | null
  answer: ((confirmed: boolean) => void) | null
  settled: Promise<void>
}

const closes = new Map<string, Close>()
const held = new Map<string, number>()
const views = new Map<string, number>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function ask(close: Close, process: string): Promise<boolean> {
  const projectId = close.ref.projectId
  if (held.has(projectId) || (views.get(projectId) ?? 0) === 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    close.question = { ref: close.ref, process }
    close.answer = resolve
    notify()
  })
}

async function closeShell(close: Close, label: string, remove: RemoveShell): Promise<void> {
  const busy = await window.chorus.describeTerminal({ ref: close.ref }).then(
    (described) =>
      described !== null && described.running && described.busy ? described.foreground : null,
    () => label
  )
  if (busy !== null && !(await ask(close, busy))) return
  try {
    await window.chorus.killTerminal({ ref: close.ref })
  } catch {
    return
  }
  remove(close.ref.projectId, close.ref.id)
}

export function requestShellClose(ref: ShellRef, label: string, remove: RemoveShell): boolean {
  const projectId = ref.projectId
  if (closes.has(projectId) || held.has(projectId)) return false
  const close: Close = { ref, question: null, answer: null, settled: Promise.resolve() }
  closes.set(projectId, close)
  close.settled = closeShell(close, label, remove).finally(() => {
    closes.delete(projectId)
    notify()
  })
  notify()
  return true
}

export function answerShellClose(projectId: string, confirmed: boolean): void {
  const close = closes.get(projectId)
  if (close === undefined) return
  const answer = close.answer
  if (answer === null) return
  close.question = null
  close.answer = null
  notify()
  answer(confirmed)
}

export async function holdShellCloses(projectId: string): Promise<() => void> {
  held.set(projectId, (held.get(projectId) ?? 0) + 1)
  notify()
  answerShellClose(projectId, false)
  const pending = closes.get(projectId)
  if (pending !== undefined) await pending.settled
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (held.get(projectId) ?? 1) - 1
    if (left > 0) {
      held.set(projectId, left)
    } else {
      held.delete(projectId)
    }
    notify()
  }
}

export function useShellCloses(projectId: string): {
  readonly question: ShellQuestion | null
  readonly closingId: string | null
  readonly moving: boolean
} {
  useEffect(() => {
    views.set(projectId, (views.get(projectId) ?? 0) + 1)
    return () => {
      const left = (views.get(projectId) ?? 1) - 1
      if (left > 0) {
        views.set(projectId, left)
        return
      }
      views.delete(projectId)
      answerShellClose(projectId, false)
    }
  }, [projectId])
  const question = useSyncExternalStore(subscribe, () => closes.get(projectId)?.question ?? null)
  const closingId = useSyncExternalStore(subscribe, () => closes.get(projectId)?.ref.id ?? null)
  const moving = useSyncExternalStore(subscribe, () => held.has(projectId))
  return { question, closingId, moving }
}
