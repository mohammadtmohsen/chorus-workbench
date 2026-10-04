import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchTerminalEnv } from '../../../shared/workbench-ipc.js'
import {
  issueTerminalEnv,
  overlayTerminalEnv,
  parseIssuedTerminalEnv,
  retainIssuedTerminalEnv,
  reviveTerminalEnv,
  serializeIssuedTerminalEnv,
  type TerminalEnvMemory,
  type TerminalEnvTarget,
} from './terminal-env.js'

const CAPTURE = { name: 'EXPO_PUBLIC_API_BASE_URL', value: 'http://127.0.0.1:30100' }
const OSX = 'terminal.integrated.env.osx'
const LINUX = 'terminal.integrated.env.linux'
const WINDOWS = 'terminal.integrated.env.windows'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('overlaying the capture variable on the memory layer', () => {
  it('keeps every other memory entry, and gives back a value it shadowed', () => {
    const before = { FOO: 'bar', EXPO_PUBLIC_API_BASE_URL: 'mine' }
    const on = overlayTerminalEnv(before, null, CAPTURE)
    expect(on.memory).toEqual({ FOO: 'bar', EXPO_PUBLIC_API_BASE_URL: CAPTURE.value })

    const off = overlayTerminalEnv(on.memory, on.owned, null)
    expect(off.memory).toEqual(before)
    expect(off.owned).toBeNull()
  })

  it('leaves the memory layer empty when it started empty', () => {
    const on = overlayTerminalEnv(undefined, null, CAPTURE)
    expect(overlayTerminalEnv(on.memory, on.owned, null).memory).toBeUndefined()
  })

  it('drops the old name on a rename and keeps an entry added while capturing', () => {
    const on = overlayTerminalEnv({ FOO: 'bar' }, null, CAPTURE)
    const renamed = overlayTerminalEnv({ ...on.memory, ADDED: 'later' }, on.owned, {
      name: 'JAVA_API_BASE_URL',
      value: CAPTURE.value,
    })
    expect(renamed.memory).toEqual({ FOO: 'bar', ADDED: 'later', JAVA_API_BASE_URL: CAPTURE.value })
  })

  it('does not take back a value someone else set over it while capturing', () => {
    const on = overlayTerminalEnv(undefined, null, CAPTURE)
    const off = overlayTerminalEnv({ EXPO_PUBLIC_API_BASE_URL: 'theirs' }, on.owned, null)
    expect(off.memory).toEqual({ EXPO_PUBLIC_API_BASE_URL: 'theirs' })
  })
})

describe('the capture variable in terminals the editor revives', () => {
  const terminal = (env: unknown): Record<string, unknown> => ({
    id: 3,
    shellLaunchConfig: { name: 'zsh', env: { FROM_PROFILE: '1' } },
    processDetails: { cwd: '/repo', title: 'zsh' },
    processLaunchConfig: { env, executableEnv: { PATH: '/bin' }, options: { cols: 80 } },
    replayEvent: { events: [{ cols: 80, rows: 24, data: 'npm run dev:clean\r\n' }] },
    timestamp: 1,
  })
  const saved = (...state: unknown[]): string => JSON.stringify({ version: 1, state })
  const read = (raw: string | undefined): unknown => {
    const value: unknown = JSON.parse(raw ?? 'null')
    return value
  }
  const NAME = CAPTURE.name
  const at = (port: number): WorkbenchTerminalEnv => ({
    name: NAME,
    value: `http://127.0.0.1:${String(port)}`,
  })

  it('removes a URL Chorus handed out when it has nothing to hand out now', () => {
    const raw = saved(terminal({ HOME: '/Users/me', [NAME]: at(30100).value }))

    const revived = reviveTerminalEnv(raw, [at(30100)], null)

    expect(read(revived.raw)).toEqual({ version: 1, state: [terminal({ HOME: '/Users/me' })] })
    expect(revived.cleaned).toBe(true)
  })

  it('replaces a port from earlier in the session with the current one', () => {
    const raw = saved(terminal({ HOME: '/', [NAME]: at(30100).value }))

    const revived = reviveTerminalEnv(raw, [at(30100), at(30105)], at(30105))

    expect(read(revived.raw)).toEqual({
      version: 1,
      state: [terminal({ HOME: '/', [NAME]: at(30105).value })],
    })
  })

  it('moves the value from a renamed variable to the current name', () => {
    const old = { name: 'OLD_API_URL', value: at(30100).value }
    const raw = saved(terminal({ HOME: '/', OLD_API_URL: old.value }))

    const revived = reviveTerminalEnv(raw, [old], at(30100))

    expect(read(revived.raw)).toEqual({
      version: 1,
      state: [terminal({ HOME: '/', [NAME]: at(30100).value })],
    })
  })

  it('keeps a value of the same name that Chorus never handed out', () => {
    const raw = saved(terminal({ HOME: '/', [NAME]: 'https://staging.example' }))

    const revived = reviveTerminalEnv(raw, [at(30100)], null)

    expect(revived.raw).toBe(raw)
    expect(revived.cleaned).toBe(true)
  })

  it('returns the saved text itself when removing and reapplying gives the same value', () => {
    const raw = saved(terminal({ HOME: '/', [NAME]: at(30100).value }))

    expect(reviveTerminalEnv(raw, [at(30100)], at(30100)).raw).toBe(raw)
    expect(reviveTerminalEnv(raw, [], at(30100)).raw).toBe(raw)
  })

  it('still recognises a URL handed out more than thirty-two changes ago', () => {
    let issued: readonly WorkbenchTerminalEnv[] = []
    for (let port = 30100; port < 30140; port += 1) issued = issueTerminalEnv(issued, at(port))
    const stored = parseIssuedTerminalEnv(serializeIssuedTerminalEnv(issued))
    const raw = saved(terminal({ HOME: '/', [NAME]: at(30100).value }))

    const revived = reviveTerminalEnv(raw, stored, at(30139))

    expect(stored).toHaveLength(40)
    expect(read(revived.raw)).toEqual({
      version: 1,
      state: [terminal({ HOME: '/', [NAME]: at(30139).value })],
    })
  })

  it('cleans what it can read and says the state was incomplete', () => {
    const raw = saved(terminal({ [NAME]: at(30100).value }), terminal(undefined), 'not a terminal')

    const revived = reviveTerminalEnv(raw, [at(30100)], null)

    expect(revived.cleaned).toBe(false)
    expect(read(revived.raw)).toEqual({
      version: 1,
      state: [terminal({}), terminal(undefined), 'not a terminal'],
    })
  })

  it('leaves anything it does not recognise exactly as it found it', () => {
    const shapes = [
      '{not json',
      JSON.stringify({ version: 2, state: [terminal({})] }),
      JSON.stringify({ version: 1, state: {} }),
      JSON.stringify([terminal({})]),
      JSON.stringify(saved(terminal({}))),
    ]
    for (const raw of shapes) {
      expect(reviveTerminalEnv(raw, [at(30100)], CAPTURE)).toEqual({ raw, cleaned: false })
    }
    expect(reviveTerminalEnv(undefined, [at(30100)], CAPTURE)).toEqual({
      raw: undefined,
      cleaned: false,
    })
  })
})

describe('the record of what Chorus handed to terminals', () => {
  const pair = { name: 'EXPO_PUBLIC_API_BASE_URL', value: 'http://127.0.0.1:30100' }
  const other = { name: 'EXPO_PUBLIC_API_BASE_URL', value: 'http://127.0.0.1:30105' }

  it('reads back what it wrote, and nothing it cannot trust', () => {
    expect(parseIssuedTerminalEnv(serializeIssuedTerminalEnv([pair, other]))).toEqual([pair, other])
    expect(
      parseIssuedTerminalEnv(
        JSON.stringify({
          version: 1,
          pairs: [pair, pair, { name: 'MY VAR', value: 'x' }, { name: 'OK', value: 3 }, 'x'],
        })
      )
    ).toEqual([pair])
    for (const raw of [undefined, '{not json', JSON.stringify({ version: 2, pairs: [pair] })]) {
      expect(parseIssuedTerminalEnv(raw)).toEqual([])
    }
    expect(parseIssuedTerminalEnv(JSON.stringify({ version: 1, pairs: {} }))).toEqual([])
  })

  it('does not grow when the same value is handed out again', () => {
    const issued = issueTerminalEnv([], pair)

    expect(issueTerminalEnv(issued, { ...pair })).toBe(issued)
    expect(issueTerminalEnv(issued, other)).toEqual([pair, other])
  })

  it('keeps every pair across a reload, and retires them only after a complete cleanup', () => {
    const issued = [pair, other]

    expect(retainIssuedTerminalEnv(issued, false, null)).toBe(issued)
    expect(retainIssuedTerminalEnv(issued, false, other)).toBe(issued)
    expect(retainIssuedTerminalEnv([pair], false, other)).toEqual([pair, other])
    expect(retainIssuedTerminalEnv(issued, true, null)).toEqual([])
    expect(retainIssuedTerminalEnv(issued, true, other)).toEqual([other])
  })
})

const memoryTarget = (
  seeded: ReadonlyMap<string, TerminalEnvMemory> = new Map()
): {
  readonly layers: Map<string, TerminalEnvMemory | undefined>
  readonly failures: unknown[]
  readonly state: { failing: boolean; writes: number; skew: boolean }
  readonly target: TerminalEnvTarget
  readonly reset: () => void
} => {
  const layers = new Map<string, TerminalEnvMemory | undefined>(seeded)
  const failures: unknown[] = []
  const state = { failing: false, writes: 0, skew: false }
  const watchers: ((affects: (key: string) => boolean) => void)[] = []
  const notify = (keys: readonly string[]): void => {
    for (const watcher of watchers) watcher((key) => keys.includes(key))
  }
  const target: TerminalEnvTarget = {
    read: (key) => {
      const memory = layers.get(key)
      return state.skew && memory !== undefined ? { ...memory, SKEW: 'x' } : memory
    },
    write: (key, memory) => {
      if (state.failing) return Promise.reject(new Error('not ready'))
      state.writes += 1
      layers.set(key, memory)
      notify([key])
      return Promise.resolve()
    },
    watch: (listener) => {
      watchers.push(listener)
    },
    fail: (error) => {
      failures.push(error)
    },
  }
  const reset = (): void => {
    layers.clear()
    notify([OSX, LINUX, WINDOWS])
  }
  return { layers, failures, state, target, reset }
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

const ALL_KEYS = [OSX, LINUX, WINDOWS]

const workbench = (
  pull: () => Promise<WorkbenchTerminalEnv | null>
): { push: (env: WorkbenchTerminalEnv | null) => void } => {
  const held: { push: (env: WorkbenchTerminalEnv | null) => void } = { push: () => undefined }
  vi.stubGlobal('window', {
    chorusWorkbench: {
      onTerminalEnvChanged: (handler: (env: WorkbenchTerminalEnv | null) => void) => {
        held.push = handler
      },
      terminalEnv: pull,
    },
  })
  return held
}

describe('the capture variable in a live workbench', () => {
  it('keeps a push that arrived while the first pull was still in flight', async () => {
    vi.resetModules()
    const terminalEnv = await import('./terminal-env.js')
    let answer: (env: WorkbenchTerminalEnv | null) => void = () => undefined
    const main = workbench(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )

    const seeded = terminalEnv.seedTerminalEnv()
    main.push(CAPTURE)
    answer(null)
    await seeded

    const fake = memoryTarget()
    terminalEnv.bindTerminalEnv(fake.target)
    expect(fake.layers.get(OSX)).toEqual({ EXPO_PUBLIC_API_BASE_URL: CAPTURE.value })
    expect(terminalEnv.currentTerminalEnv()).toEqual(CAPTURE)
  })

  it('records the seeded value when the record binds, and each later value before applying it', async () => {
    vi.resetModules()
    const terminalEnv = await import('./terminal-env.js')
    const main = workbench(() => Promise.resolve(CAPTURE))
    await terminalEnv.seedTerminalEnv()
    const fake = memoryTarget()
    terminalEnv.bindTerminalEnv(fake.target)

    const recorded: [string, string | null][] = []
    terminalEnv.bindIssuedTerminalEnv((env) => {
      recorded.push([env.value, fake.layers.get(OSX)?.[env.name] ?? null])
    })
    const moved = { name: CAPTURE.name, value: 'http://127.0.0.1:30105' }
    main.push(moved)
    main.push(null)

    expect(recorded).toEqual([
      [CAPTURE.value, CAPTURE.value],
      [moved.value, CAPTURE.value],
    ])
    expect(fake.layers.get(OSX)).toBeUndefined()
  })

  it('knows the variable from the first pull before any service exists', async () => {
    vi.resetModules()
    const terminalEnv = await import('./terminal-env.js')
    workbench(() => Promise.resolve(CAPTURE))

    expect(terminalEnv.currentTerminalEnv()).toBeNull()
    await terminalEnv.seedTerminalEnv()
    expect(terminalEnv.currentTerminalEnv()).toEqual(CAPTURE)
  })

  it('restores the memory it found on every platform key when capture stops', async () => {
    vi.resetModules()
    const terminalEnv = await import('./terminal-env.js')
    const main = workbench(() => Promise.resolve(null))
    await terminalEnv.seedTerminalEnv()

    const fake = memoryTarget(new Map([[OSX, { FOO: 'bar' }]]))
    terminalEnv.bindTerminalEnv(fake.target)
    main.push(CAPTURE)
    expect(fake.layers.get(OSX)).toEqual({ FOO: 'bar', EXPO_PUBLIC_API_BASE_URL: CAPTURE.value })
    expect(fake.layers.get(LINUX)).toEqual({ EXPO_PUBLIC_API_BASE_URL: CAPTURE.value })

    main.push(null)
    expect(fake.layers.get(OSX)).toEqual({ FOO: 'bar' })
    expect(fake.layers.get(LINUX)).toBeUndefined()
  })

  it('reports a write that failed and does not count it as applied', async () => {
    vi.resetModules()
    const terminalEnv = await import('./terminal-env.js')
    const main = workbench(() => Promise.resolve(null))
    await terminalEnv.seedTerminalEnv()

    const fake = memoryTarget()
    fake.state.failing = true
    terminalEnv.bindTerminalEnv(fake.target)
    main.push(CAPTURE)
    await vi.waitFor(() => {
      expect(fake.failures).toHaveLength(3)
    })
    expect(fake.layers.size).toBe(0)

    fake.state.failing = false
    main.push(CAPTURE)
    expect(fake.layers.get(OSX)).toEqual({ EXPO_PUBLIC_API_BASE_URL: CAPTURE.value })
  })

  const live = async (
    seeded?: ReadonlyMap<string, TerminalEnvMemory>
  ): Promise<{
    readonly main: { push: (env: WorkbenchTerminalEnv | null) => void }
    readonly fake: ReturnType<typeof memoryTarget>
  }> => {
    vi.resetModules()
    const terminalEnv = await import('./terminal-env.js')
    const main = workbench(() => Promise.resolve(null))
    await terminalEnv.seedTerminalEnv()
    const fake = memoryTarget(seeded)
    terminalEnv.bindTerminalEnv(fake.target)
    return { main, fake }
  }

  it('puts the override back after the workbench drops its memory layer mid-capture', async () => {
    const { main, fake } = await live()
    main.push(CAPTURE)
    fake.reset()
    expect(fake.layers.size).toBe(0)

    await settle()
    for (const key of ALL_KEYS) {
      expect(fake.layers.get(key)).toEqual({ EXPO_PUBLIC_API_BASE_URL: CAPTURE.value })
    }

    main.push(null)
    for (const key of ALL_KEYS) expect(fake.layers.get(key)).toBeUndefined()
  })

  it('does not carry a value it shadowed across a memory reset', async () => {
    const { main, fake } = await live(new Map([[OSX, { EXPO_PUBLIC_API_BASE_URL: 'mine' }]]))
    main.push(CAPTURE)
    fake.reset()
    await settle()

    main.push(null)
    expect(fake.layers.get(OSX)).toBeUndefined()
  })

  it('lets a Stop that lands before the queued reapply win', async () => {
    const { main, fake } = await live()
    main.push(CAPTURE)
    fake.reset()
    main.push(null)

    await settle()
    for (const key of ALL_KEYS) expect(fake.layers.get(key)).toBeUndefined()
  })

  it('installs only the new name when a rename follows a reset', async () => {
    const { main, fake } = await live()
    main.push(CAPTURE)
    fake.reset()
    main.push({ name: 'JAVA_API_BASE_URL', value: CAPTURE.value })

    await settle()
    for (const key of ALL_KEYS) {
      expect(fake.layers.get(key)).toEqual({ JAVA_API_BASE_URL: CAPTURE.value })
    }
  })

  it('shadows the value it found, not its own, when its own write raises a change', async () => {
    const { main, fake } = await live(new Map([[OSX, { EXPO_PUBLIC_API_BASE_URL: 'mine' }]]))
    main.push(CAPTURE)
    await settle()
    expect(fake.state.writes).toBe(3)

    main.push(null)
    expect(fake.layers.get(OSX)).toEqual({ EXPO_PUBLIC_API_BASE_URL: 'mine' })
    expect(fake.layers.get(LINUX)).toBeUndefined()
  })

  it('does not loop when the layer reads back something other than what it wrote', async () => {
    const { main, fake } = await live()
    fake.state.skew = true
    main.push(CAPTURE)

    await settle()
    expect(fake.state.writes).toBe(3)
  })
})
