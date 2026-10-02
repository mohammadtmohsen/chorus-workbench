import type { WorkbenchTerminalEnv } from '../../../shared/workbench-ipc.js'

export type TerminalEnvMemory = Readonly<Record<string, string | null>>

export interface OwnedTerminalEnv {
  readonly env: WorkbenchTerminalEnv
  readonly shadowed: { readonly present: boolean; readonly value: string | null }
}

export interface TerminalEnvTarget {
  readonly read: (key: string) => TerminalEnvMemory | undefined
  readonly write: (key: string, memory: TerminalEnvMemory | undefined) => Promise<void>
  readonly watch: (listener: (affects: (key: string) => boolean) => void) => void
  readonly fail: (error: unknown) => void
}

const TERMINAL_ENV_KEYS = [
  'terminal.integrated.env.osx',
  'terminal.integrated.env.linux',
  'terminal.integrated.env.windows',
] as const

const sameEnv = (a: WorkbenchTerminalEnv | null, b: WorkbenchTerminalEnv | null): boolean =>
  a?.name === b?.name && a?.value === b?.value

const sameMemory = (
  a: TerminalEnvMemory | undefined,
  b: TerminalEnvMemory | undefined
): boolean => {
  const left = a ?? {}
  const right = b ?? {}
  const names = Object.keys(left)
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => Object.hasOwn(right, name) && right[name] === left[name])
  )
}

export function overlayTerminalEnv(
  memory: TerminalEnvMemory | undefined,
  owned: OwnedTerminalEnv | null,
  next: WorkbenchTerminalEnv | null
): { readonly memory: TerminalEnvMemory | undefined; readonly owned: OwnedTerminalEnv | null } {
  const releasing =
    owned !== null && memory !== undefined && memory[owned.env.name] === owned.env.value
      ? owned
      : null
  const entries: Record<string, string | null> = Object.fromEntries(
    Object.entries(memory ?? {}).filter(([name]) => name !== releasing?.env.name)
  )
  if (releasing?.shadowed.present === true) entries[releasing.env.name] = releasing.shadowed.value
  if (next === null) {
    return { memory: Object.keys(entries).length === 0 ? undefined : entries, owned: null }
  }
  const present = Object.hasOwn(entries, next.name)
  const shadowed = { present, value: present ? (entries[next.name] ?? null) : null }
  return { memory: { ...entries, [next.name]: next.value }, owned: { env: next, shadowed } }
}

let wanted: WorkbenchTerminalEnv | null = null
let target: TerminalEnvTarget | null = null
let pushCount = 0
let scheduled = false
let applying = false
const owned = new Map<string, OwnedTerminalEnv>()

function liveOwner(key: string, memory: TerminalEnvMemory | undefined): OwnedTerminalEnv | null {
  const held = owned.get(key)
  if (held === undefined) return null
  const { name, value } = held.env
  if (memory !== undefined && Object.hasOwn(memory, name) && memory[name] === value) return held
  owned.delete(key)
  return null
}

function apply(): void {
  const bound = target
  if (bound === null) return
  applying = true
  try {
    for (const key of TERMINAL_ENV_KEYS) {
      const memory = bound.read(key)
      const held = liveOwner(key, memory)
      if (sameEnv(held?.env ?? null, wanted)) continue
      const next = overlayTerminalEnv(memory, held, wanted)
      void bound.write(key, next.memory).catch(bound.fail)
      if (!sameMemory(bound.read(key), next.memory)) continue
      if (next.owned === null) owned.delete(key)
      else owned.set(key, next.owned)
    }
  } finally {
    applying = false
  }
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    apply()
  })
}

function receive(env: WorkbenchTerminalEnv | null): void {
  wanted = env
  apply()
}

export async function seedTerminalEnv(): Promise<void> {
  window.chorusWorkbench.onTerminalEnvChanged((env) => {
    pushCount += 1
    receive(env)
  })
  const before = pushCount
  try {
    const env = await window.chorusWorkbench.terminalEnv()
    if (pushCount === before) receive(env)
  } catch {
    return
  }
}

export function bindTerminalEnv(next: TerminalEnvTarget): void {
  target = next
  next.watch((affects) => {
    if (!applying && TERMINAL_ENV_KEYS.some((key) => affects(key))) schedule()
  })
  apply()
}
