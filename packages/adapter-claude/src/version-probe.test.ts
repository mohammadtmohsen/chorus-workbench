import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter, type ResolvedExecutable } from './claude-adapter.js'

const probes = vi.hoisted(() => {
  const pending: {
    file: string
    args: readonly string[]
    succeed: (stdout: string) => void
    fail: (error: Error) => void
  }[] = []
  const execFile = Object.assign(
    () => {
      throw new Error('execFile was called without promisify')
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (file: string, args: readonly string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          pending.push({
            file,
            args,
            succeed: (stdout) => {
              resolve({ stdout, stderr: '' })
            },
            fail: reject,
          })
        }),
    }
  )
  return { pending, execFile }
})

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFile: probes.execFile,
}))

let clock = 0

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

const ready = (version: string) => ({ state: 'ready', version })

const probe = (index: number) => {
  const found = probes.pending[index]
  expect(found).toBeDefined()
  return found!
}

beforeEach(() => {
  probes.pending.length = 0
  clock = 0
})

describe('ClaudeAdapter version probe', () => {
  it('reuses a version for thirty seconds after its probe finished', async () => {
    const adapter = new ClaudeAdapter({ command: 'claude-test', now: () => clock })
    const first = adapter.health()
    await flush()
    expect(probe(0).file).toBe('claude-test')
    expect(probe(0).args).toEqual(['--version'])
    clock = 5_000
    probe(0).succeed('2.1.3 (Claude Code)')
    expect(await first).toEqual(ready('2.1.3'))

    clock = 34_999
    expect(await adapter.health()).toEqual(ready('2.1.3'))
    expect(probes.pending).toHaveLength(1)

    clock = 35_000
    const later = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('2.1.4')
    expect(await later).toEqual(ready('2.1.4'))
  })

  it('probes again when the clock moves back before the last probe finished', async () => {
    const adapter = new ClaudeAdapter({ command: 'claude-test', now: () => clock })
    clock = 10_000
    const first = adapter.health()
    await flush()
    probe(0).succeed('2.1.3')
    expect(await first).toEqual(ready('2.1.3'))

    clock = 9_999
    const rewound = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('2.1.4')
    expect(await rewound).toEqual(ready('2.1.4'))
  })

  it('shares one probe between calls that arrive while it runs', async () => {
    const adapter = new ClaudeAdapter({ command: 'claude-test', now: () => clock })
    const calls = [adapter.health(), adapter.health(), adapter.health()]
    await flush()
    expect(probes.pending).toHaveLength(1)
    probe(0).succeed('2.1.3')
    expect(await Promise.all(calls)).toEqual([ready('2.1.3'), ready('2.1.3'), ready('2.1.3')])
  })

  it('keeps neither a failed nor an unreadable probe', async () => {
    const adapter = new ClaudeAdapter({ command: 'claude-test', now: () => clock })
    const failed = adapter.health()
    await flush()
    probe(0).fail(new Error('spawn claude-test ENOENT'))
    expect(await failed).toEqual({ state: 'unavailable', reason: 'spawn claude-test ENOENT' })

    const unreadable = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('not a version')
    expect(await unreadable).toEqual({
      state: 'unavailable',
      reason: 'could not parse version from "not a version"',
    })

    const recovered = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(3)
    probe(2).succeed('2.1.3')
    expect(await recovered).toEqual(ready('2.1.3'))
  })

  it('asks the precondition on every call while the version is cached', async () => {
    const missingKey = 'Add a DeepSeek API key in Settings'
    let blocked: string | null = null
    const adapter = new ClaudeAdapter({
      command: 'claude-test',
      now: () => clock,
      precondition: () => blocked,
    })
    const first = adapter.health()
    await flush()
    probe(0).succeed('2.1.3')
    expect(await first).toEqual(ready('2.1.3'))

    blocked = missingKey
    expect(await adapter.health()).toEqual({ state: 'unavailable', reason: missingKey })
    blocked = null
    expect(await adapter.health()).toEqual(ready('2.1.3'))
    expect(probes.pending).toHaveLength(1)
  })

  it('keeps a probe to the adapter that ran it', async () => {
    const one = new ClaudeAdapter({ command: 'claude-test', now: () => clock })
    const two = new ClaudeAdapter({ command: 'claude-test', now: () => clock })
    const first = one.health()
    await flush()
    probe(0).succeed('2.1.3')
    await first

    const second = two.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('2.1.3')
    expect(await second).toEqual(ready('2.1.3'))
  })

  it('probes a new launch pair, and an older failing probe cannot undo it', async () => {
    const resolveExecutable = vi
      .fn<() => Promise<ResolvedExecutable | null>>()
      .mockRejectedValueOnce(new Error('shell lookup timed out'))
      .mockResolvedValue({
        sdkPath: '/opt/claude/cli.js',
        launch: { file: '/opt/claude/bin/claude', args: ['--launched'] },
      })
    const adapter = new ClaudeAdapter({
      command: 'claude-test',
      now: () => clock,
      resolveExecutable,
    })

    const before = adapter.health()
    await flush()
    const after = adapter.health()
    await flush()
    expect(probes.pending.map((entry) => [entry.file, entry.args])).toEqual([
      ['claude-test', ['--version']],
      ['/opt/claude/bin/claude', ['--launched', '--version']],
    ])

    probe(0).fail(new Error('spawn claude-test ENOENT'))
    expect(await before).toEqual({ state: 'unavailable', reason: 'spawn claude-test ENOENT' })
    probe(1).succeed('2.1.3')
    expect(await after).toEqual(ready('2.1.3'))

    expect(await adapter.health()).toEqual(ready('2.1.3'))
    expect(probes.pending).toHaveLength(2)
  })
})
