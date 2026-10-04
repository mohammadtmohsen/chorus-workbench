import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'

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

describe('CodexAdapter version probe', () => {
  it('reuses a version for thirty seconds after its probe finished', async () => {
    const adapter = new CodexAdapter({ command: 'codex-test', now: () => clock })
    const first = adapter.health()
    await flush()
    expect(probe(0).file).toBe('codex-test')
    expect(probe(0).args).toEqual(['--version'])
    clock = 2_000
    probe(0).succeed('codex-cli 0.50.0')
    expect(await first).toEqual(ready('0.50.0'))

    clock = 31_999
    expect(await adapter.health()).toEqual(ready('0.50.0'))
    expect(probes.pending).toHaveLength(1)

    clock = 32_000
    const later = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('codex-cli 0.51.0')
    expect(await later).toEqual(ready('0.51.0'))
  })

  it('probes again when the clock moves back before the last probe finished', async () => {
    const adapter = new CodexAdapter({ command: 'codex-test', now: () => clock })
    clock = 10_000
    const first = adapter.health()
    await flush()
    probe(0).succeed('codex-cli 0.50.0')
    expect(await first).toEqual(ready('0.50.0'))

    clock = 9_999
    const rewound = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('codex-cli 0.51.0')
    expect(await rewound).toEqual(ready('0.51.0'))
  })

  it('shares one probe between calls that arrive while it runs', async () => {
    const adapter = new CodexAdapter({ command: 'codex-test', now: () => clock })
    const calls = [adapter.health(), adapter.health()]
    await flush()
    expect(probes.pending).toHaveLength(1)
    probe(0).succeed('codex-cli 0.50.0')
    expect(await Promise.all(calls)).toEqual([ready('0.50.0'), ready('0.50.0')])
  })

  it('keeps neither a failed nor an unreadable probe', async () => {
    const adapter = new CodexAdapter({ command: 'codex-test', now: () => clock })
    const failed = adapter.health()
    await flush()
    probe(0).fail(new Error('Command failed: codex-test --version'))
    expect(await failed).toEqual({
      state: 'unavailable',
      reason: 'Command failed: codex-test --version',
    })

    const unreadable = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(2)
    probe(1).succeed('codex-cli')
    expect(await unreadable).toEqual({
      state: 'unavailable',
      reason: 'could not parse version from "codex-cli"',
    })

    const recovered = adapter.health()
    await flush()
    expect(probes.pending).toHaveLength(3)
    probe(2).succeed('codex-cli 0.50.0')
    expect(await recovered).toEqual(ready('0.50.0'))
  })

  it('probes a newly resolved command, and an older failing probe cannot undo it', async () => {
    const resolveCommand = vi
      .fn<() => Promise<{ readonly file: string; readonly args: readonly string[] } | null>>()
      .mockRejectedValueOnce(new Error('shell lookup timed out'))
      .mockResolvedValue({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'codex.cmd'] })
    const adapter = new CodexAdapter({ command: 'codex-test', now: () => clock, resolveCommand })

    const before = adapter.health()
    await flush()
    const after = adapter.health()
    await flush()
    expect(probes.pending.map((entry) => [entry.file, entry.args])).toEqual([
      ['codex-test', ['--version']],
      ['cmd.exe', ['/d', '/s', '/c', 'codex.cmd', '--version']],
    ])

    probe(0).fail(new Error('spawn codex-test ENOENT'))
    expect(await before).toEqual({ state: 'unavailable', reason: 'spawn codex-test ENOENT' })
    probe(1).succeed('codex-cli 0.50.0')
    expect(await after).toEqual(ready('0.50.0'))

    expect(await adapter.health()).toEqual(ready('0.50.0'))
    expect(probes.pending).toHaveLength(2)
  })
})
