import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchTerminalEnv } from '../../../shared/workbench-ipc.js'
import {
  overlayTerminalEnv,
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
