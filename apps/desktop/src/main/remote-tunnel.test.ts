import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireTunnel,
  lastMeaningfulLine,
  LISTEN_POLL_MS,
  releaseTunnel,
  stopAllTunnels,
  type TunnelDependencies,
  type TunnelProcess,
  type TunnelState,
  TunnelSupervisor,
  tunnelRetryDelay,
} from './remote-tunnel.js'

const TARGET = { host: 'officepc', localPort: 48_000, remotePort: 47_500 }

interface FakeTunnel {
  readonly process: TunnelProcess
  readonly argv: readonly string[]
  exit(said?: string): void
  killed(): boolean
}

function fakeSsh(accepting: () => boolean): {
  readonly deps: TunnelDependencies
  readonly started: FakeTunnel[]
  readonly delays: number[]
} {
  const started: FakeTunnel[] = []
  const delays: number[] = []
  const deps: TunnelDependencies = {
    start: (argv) => {
      const control = { exit: (_said: string): void => undefined, killed: false }
      const exited = new Promise<string>((resolve) => {
        control.exit = resolve
      })
      const tunnel: FakeTunnel = {
        argv,
        process: {
          exited,
          kill: () => {
            control.killed = true
            control.exit('')
          },
        },
        exit: (said = '') => {
          control.exit(said)
        },
        killed: () => control.killed,
      }
      started.push(tunnel)
      return tunnel.process
    },
    listening: () => Promise.resolve(accepting()),
    wait: (ms) => {
      if (ms !== LISTEN_POLL_MS) delays.push(ms)
      return new Promise((resolve) => setImmediate(resolve))
    },
  }
  return { deps, started, delays }
}

afterEach(async () => {
  await stopAllTunnels()
})

describe('tunnelRetryDelay', () => {
  it('backs off to 15 s, so many retries land inside the 120 s grace', () => {
    expect([0, 1, 2, 3, 4, 9].map(tunnelRetryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ])
    let elapsed = 0
    let attempts = 0
    while (elapsed + tunnelRetryDelay(attempts) <= 120_000) {
      elapsed += tunnelRetryDelay(attempts)
      attempts += 1
    }
    expect(attempts).toBeGreaterThanOrEqual(10)
  })
})

describe('TunnelSupervisor', () => {
  it('restarts a dropped tunnel with backoff, and resets the backoff once it is up', async () => {
    let accepting = false
    const { deps, started, delays } = fakeSsh(() => accepting)
    const states: TunnelState[] = []
    const supervisor = new TunnelSupervisor(TARGET, deps, (state) => states.push(state))

    started[0]?.exit()
    await vi.waitFor(() => {
      expect(started).toHaveLength(2)
    })
    started[1]?.exit()
    await vi.waitFor(() => {
      expect(started).toHaveLength(3)
    })
    accepting = true
    await supervisor.firstUp
    started[2]?.exit()
    await vi.waitFor(() => {
      expect(started).toHaveLength(4)
    })

    expect(delays).toEqual([1_000, 2_000, 1_000])
    expect(started[0]?.argv).toContain('127.0.0.1:48000:127.0.0.1:47500')
    expect(states).toContain('up')

    await supervisor.stop()
    expect(started[3]?.killed()).toBe(true)
    expect(started).toHaveLength(4)
    expect(states[states.length - 1]).toBe('stopped')
  })

  it('says why a tunnel went down, in the words ssh used', async () => {
    const { deps, started } = fakeSsh(() => false)
    const downs: string[] = []
    const supervisor = new TunnelSupervisor(TARGET, deps, (state, detail) => {
      if (state === 'down') downs.push(detail)
    })
    started[0]?.exit('user@officepc: Permission denied (publickey).')
    await vi.waitFor(() => {
      expect(started).toHaveLength(2)
    })
    expect(downs).toEqual(['user@officepc: Permission denied (publickey).'])
    expect(supervisor.lastFailure).toBe('user@officepc: Permission denied (publickey).')
    await supervisor.stop()
  })
})

describe('lastMeaningfulLine', () => {
  it('skips the post-quantum warning and blank lines to reach the real reason', () => {
    const stderr = [
      '** WARNING: connection is not using a post-quantum key exchange algorithm.',
      'user@officepc: Permission denied (publickey).',
      '** The server may need to be upgraded. See https://openssh.com/pq.html',
      '',
    ].join('\r\n')
    expect(lastMeaningfulLine(stderr)).toBe('user@officepc: Permission denied (publickey).')
    expect(lastMeaningfulLine('')).toBe('')
  })
})

describe('acquireTunnel', () => {
  it('shares one tunnel per host and stops it when the last holder lets go', async () => {
    const { deps, started } = fakeSsh(() => true)
    const first = acquireTunnel(TARGET, '/projects/a', deps)
    const second = acquireTunnel(TARGET, '/projects/b', deps)
    expect(second).toBe(first)
    await first.firstUp

    await releaseTunnel('officepc', '/projects/a')
    expect(started[0]?.killed()).toBe(false)
    await releaseTunnel('officepc', '/projects/b')
    expect(started[0]?.killed()).toBe(true)
    expect(started).toHaveLength(1)
  })

  it('refuses a second tunnel to the same host on other ports', () => {
    const { deps } = fakeSsh(() => true)
    acquireTunnel(TARGET, '/projects/a', deps)
    expect(() => acquireTunnel({ ...TARGET, localPort: 48_001 }, '/projects/b', deps)).toThrow(
      'already open on other ports'
    )
  })

  it('stops every tunnel on quit, whoever still holds it', async () => {
    const { deps, started } = fakeSsh(() => true)
    acquireTunnel(TARGET, '/projects/a', deps)
    acquireTunnel({ ...TARGET, host: 'tpa-be' }, '/projects/b', deps)
    await stopAllTunnels()
    expect(started.map((tunnel) => tunnel.killed())).toEqual([true, true])
  })
})
