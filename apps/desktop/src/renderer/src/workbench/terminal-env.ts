import { TRAFFIC_ENV_NAME } from '../../../shared/traffic-ipc.js'
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
  const releasing = owned !== null && memory?.[owned.env.name] === owned.env.value ? owned : null
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value)

const parseJson = (raw: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed
  } catch {
    return undefined
  }
}

const sameEntries = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const names = Object.keys(a)
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && b[name] === a[name])
  )
}

const ISSUED_VERSION = 1

const wasIssued = (
  issued: readonly WorkbenchTerminalEnv[],
  name: string,
  value: unknown
): boolean => issued.some((pair) => pair.name === name && pair.value === value)

export function issueTerminalEnv(
  issued: readonly WorkbenchTerminalEnv[],
  env: WorkbenchTerminalEnv
): readonly WorkbenchTerminalEnv[] {
  if (wasIssued(issued, env.name, env.value)) return issued
  return [...issued, { name: env.name, value: env.value }]
}

export function parseIssuedTerminalEnv(raw: string | undefined): readonly WorkbenchTerminalEnv[] {
  const parsed = raw === undefined ? undefined : parseJson(raw)
  if (!isRecord(parsed) || parsed['version'] !== ISSUED_VERSION) return []
  const pairs = parsed['pairs']
  if (!isList(pairs)) return []
  let issued: readonly WorkbenchTerminalEnv[] = []
  for (const pair of pairs) {
    if (!isRecord(pair)) continue
    const name = pair['name']
    const value = pair['value']
    if (typeof name !== 'string' || typeof value !== 'string') continue
    if (!TRAFFIC_ENV_NAME.test(name)) continue
    issued = issueTerminalEnv(issued, { name, value })
  }
  return issued
}

export function serializeIssuedTerminalEnv(issued: readonly WorkbenchTerminalEnv[]): string {
  return JSON.stringify({
    version: ISSUED_VERSION,
    pairs: issued.map(({ name, value }) => ({ name, value })),
  })
}

export function retainIssuedTerminalEnv(
  issued: readonly WorkbenchTerminalEnv[],
  cleaned: boolean,
  current: WorkbenchTerminalEnv | null
): readonly WorkbenchTerminalEnv[] {
  const kept = cleaned ? [] : issued
  return current === null ? kept : issueTerminalEnv(kept, current)
}

export function reviveTerminalEnv(
  raw: string | undefined,
  issued: readonly WorkbenchTerminalEnv[],
  current: WorkbenchTerminalEnv | null
): { readonly raw: string | undefined; readonly cleaned: boolean } {
  const parsed = raw === undefined ? undefined : parseJson(raw)
  if (!isRecord(parsed) || parsed['version'] !== 1) return { raw, cleaned: false }
  const revived = parsed['state']
  if (!isList(revived)) return { raw, cleaned: false }
  let complete = true
  let changed = false
  const state: unknown[] = []
  for (const terminal of revived) {
    const launch = isRecord(terminal) ? terminal['processLaunchConfig'] : undefined
    const variables = isRecord(launch) ? launch['env'] : undefined
    if (!isRecord(terminal) || !isRecord(launch) || !isRecord(variables)) {
      complete = false
      state.push(terminal)
      continue
    }
    const next: Record<string, unknown> = Object.fromEntries(
      Object.entries(variables).filter(([name, value]) => !wasIssued(issued, name, value))
    )
    if (current !== null) next[current.name] = current.value
    if (sameEntries(variables, next)) {
      state.push(terminal)
      continue
    }
    changed = true
    state.push({ ...terminal, processLaunchConfig: { ...launch, env: next } })
  }
  return { raw: changed ? JSON.stringify({ ...parsed, state }) : raw, cleaned: complete }
}

let wanted: WorkbenchTerminalEnv | null = null
let target: TerminalEnvTarget | null = null
let issue: ((env: WorkbenchTerminalEnv) => void) | null = null
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
  if (env !== null) issue?.(env)
  apply()
}

export function currentTerminalEnv(): WorkbenchTerminalEnv | null {
  return wanted
}

export function bindIssuedTerminalEnv(record: (env: WorkbenchTerminalEnv) => void): void {
  issue = record
  if (wanted !== null) record(wanted)
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
