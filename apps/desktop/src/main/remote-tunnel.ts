import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { sshTunnelArgv } from './remote-host.js'

export interface TunnelTarget {
  readonly host: string
  readonly localPort: number
  readonly remotePort: number
}

export type TunnelState = 'connecting' | 'up' | 'down' | 'stopped'

export interface TunnelProcess {
  readonly exited: Promise<string>
  kill(): void
}

export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('**'))
  return lines[lines.length - 1] ?? ''
}

export interface TunnelDependencies {
  readonly start: (argv: readonly string[]) => TunnelProcess
  readonly listening: (port: number) => Promise<boolean>
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
}

export const LISTEN_POLL_MS = 250

export function tunnelRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 15_000)
}

export class TunnelSupervisor {
  private current: TunnelProcess | null = null
  private stopping = false
  private readonly abort = new AbortController()
  private readonly done: Promise<void>
  private reportUp: () => void = () => undefined
  private failure = ''
  readonly firstUp: Promise<void>

  constructor(
    readonly target: TunnelTarget,
    private readonly deps: TunnelDependencies,
    private readonly onState: (state: TunnelState, detail: string) => void
  ) {
    this.firstUp = new Promise((resolve) => {
      this.reportUp = resolve
    })
    this.done = this.run()
  }

  private isStopping(): boolean {
    return this.stopping
  }

  get lastFailure(): string {
    return this.failure
  }

  private async becameListening(exited: Promise<string>): Promise<boolean> {
    const tunnel = { gone: false }
    void exited.then(() => {
      tunnel.gone = true
    })
    while (!tunnel.gone && !this.isStopping()) {
      if (await this.deps.listening(this.target.localPort)) return true
      await this.deps.wait(LISTEN_POLL_MS, this.abort.signal)
    }
    return false
  }

  private async run(): Promise<void> {
    const argv = sshTunnelArgv(this.target.host, this.target.localPort, this.target.remotePort)
    let attempt = 0
    while (!this.isStopping()) {
      const tunnel = this.deps.start(argv)
      this.current = tunnel
      this.onState('connecting', '')
      if (await this.becameListening(tunnel.exited)) {
        attempt = 0
        this.onState('up', '')
        this.reportUp()
      }
      const said = await tunnel.exited
      this.current = null
      if (this.isStopping()) break
      this.failure = said
      this.onState('down', said)
      await this.deps.wait(tunnelRetryDelay(attempt), this.abort.signal)
      attempt += 1
    }
    this.onState('stopped', '')
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.abort.abort()
    this.current?.kill()
    await this.done
  }
}

function startSsh(argv: readonly string[]): TunnelProcess {
  const child = spawn('ssh', argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const stderr = { tail: '' }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr.tail = `${stderr.tail}${chunk}`.slice(-4_096)
  })
  const exited = new Promise<string>((resolve) => {
    child.once('close', () => {
      resolve(lastMeaningfulLine(stderr.tail))
    })
    child.once('error', (error) => {
      resolve(error.message)
    })
  })
  return {
    exited,
    kill: () => {
      child.kill()
    },
  }
}

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

export const SSH_TUNNEL: TunnelDependencies = {
  start: startSsh,
  listening: acceptsConnections,
  wait: abortableWait,
}

interface LeasedTunnel {
  readonly supervisor: TunnelSupervisor
  readonly holders: Set<string>
}

const leased = new Map<string, LeasedTunnel>()

export function acquireTunnel(
  target: TunnelTarget,
  holder: string,
  deps: TunnelDependencies = SSH_TUNNEL,
  onState: (state: TunnelState, detail: string) => void = () => undefined
): TunnelSupervisor {
  const existing = leased.get(target.host)
  if (existing !== undefined) {
    const held = existing.supervisor.target
    if (held.localPort !== target.localPort || held.remotePort !== target.remotePort) {
      throw new Error(`A tunnel to ${target.host} is already open on other ports`)
    }
    existing.holders.add(holder)
    return existing.supervisor
  }
  const supervisor = new TunnelSupervisor(target, deps, onState)
  leased.set(target.host, { supervisor, holders: new Set([holder]) })
  return supervisor
}

export async function releaseTunnel(host: string, holder: string): Promise<void> {
  const entry = leased.get(host)
  if (entry === undefined) return
  entry.holders.delete(holder)
  if (entry.holders.size > 0) return
  leased.delete(host)
  await entry.supervisor.stop()
}

export async function stopAllTunnels(): Promise<void> {
  const entries = [...leased.values()]
  leased.clear()
  await Promise.all(entries.map((entry) => entry.supervisor.stop()))
}
