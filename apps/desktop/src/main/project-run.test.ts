import { LOCAL_HOST, type RunCommands } from '@chorus/event-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectRunner,
  type ActiveCommand,
  type RunChange,
  type RunFailure,
  type RunProject,
} from './project-run.js'
import type { ProjectTrafficState } from './project-traffic.js'
import type {
  LaunchResult,
  LaunchSpec,
  ProjectTerminalRef,
  TerminalRef,
  TerminalTap,
} from './terminal.js'

const VARIABLE = 'EXPO_PUBLIC_API_BASE_URL'
const REDIRECT = 'http://127.0.0.1:30100'
const RUN_REF: ProjectTerminalRef = { scope: 'project', projectId: 'p1', id: 'run' }

const DEV: ActiveCommand = { id: 'dev', label: 'dev', command: 'npm run dev' }
const DEV_CLEAN: ActiveCommand = {
  id: 'dev-clean',
  label: 'dev:clean',
  command: 'npm run dev:clean',
}
const COMMANDS: RunCommands = { version: 1, defaultId: DEV_CLEAN.id, commands: [DEV, DEV_CLEAN] }

const scriptFor = (command: string): string =>
  `set +m; export ${VARIABLE}='${REDIRECT}'; ${command}`

const project = (over: Partial<RunProject> = {}): RunProject => ({
  host: LOCAL_HOST,
  canonicalRoot: '/repo/p1',
  runCommands: COMMANDS,
  trafficOrigin: 'http://10.0.0.5:8080',
  trafficEnvVar: VARIABLE,
  ...over,
})

const trafficState = (over: Partial<ProjectTrafficState>): ProjectTrafficState => ({
  capturing: false,
  port: null,
  wantedPort: 30_100,
  address: null,
  origin: 'http://10.0.0.5:8080',
  access: 'lan',
  envVar: VARIABLE,
  source: { kind: 'off' },
  failure: null,
  forwardedDevices: 0,
  ...over,
})

const errno = (code: string): Error => Object.assign(new Error(code), { code })

interface Behaviour {
  readonly interrupted: 'all' | 'leader' | 'nothing'
  readonly fatal: 'SIGTERM' | 'SIGKILL' | 'nothing'
  readonly failure: string | null
}

const STUBBORN: Behaviour = { interrupted: 'nothing', fatal: 'nothing', failure: null }

interface Group {
  readonly projectId: string
  readonly generation: number
  alive: boolean
  leader: boolean
  behaviour: Behaviour
}

class FakeProcesses {
  readonly groups = new Map<number, Group>()
  readonly signals: [number, NodeJS.Signals | 0][] = []
  behaviour: Behaviour = { interrupted: 'all', fatal: 'SIGTERM', failure: null }
  leaderExit: (group: Group, code: number) => void = () => undefined

  spawn(pid: number, projectId: string, generation: number): void {
    this.groups.set(pid, {
      projectId,
      generation,
      alive: true,
      leader: true,
      behaviour: this.behaviour,
    })
  }

  group(pid: number): Group {
    const found = this.groups.get(pid)
    if (found === undefined) throw new Error(`no group ${String(pid)}`)
    return found
  }

  kill(pid: number, signal: NodeJS.Signals | 0): void {
    this.signals.push([pid, signal])
    const group = this.groups.get(-pid)
    if (!group?.alive) throw errno('ESRCH')
    if (group.behaviour.failure !== null) throw errno(group.behaviour.failure)
    if (signal === 0 || group.behaviour.fatal === 'nothing') return
    if (signal === 'SIGKILL') this.end(group, 137)
    else if (signal === group.behaviour.fatal) this.end(group, 143)
  }

  interrupt(pid: number): boolean {
    const group = this.group(pid)
    if (!group.leader) return false
    if (group.behaviour.interrupted === 'all') this.end(group, 130)
    else if (group.behaviour.interrupted === 'leader') this.leaderOnly(group, 130)
    return true
  }

  leaderOnly(group: Group, code: number): void {
    if (!group.leader) return
    group.leader = false
    this.leaderExit(group, code)
  }

  end(group: Group, code: number): void {
    group.alive = false
    this.leaderOnly(group, code)
  }
}

interface Launch {
  readonly ref: ProjectTerminalRef
  readonly spec: LaunchSpec
  readonly pid: number
}

class FakeTerminals {
  readonly launches: Launch[] = []
  readonly interrupts: [string, number][] = []
  readonly disposed: TerminalRef[] = []
  readonly taps = new Set<TerminalTap>()
  throws = false
  refuses = false
  early: number | null = null
  private pid = 100

  constructor(
    private readonly processes: FakeProcesses,
    private readonly events: string[]
  ) {}

  launch(ref: ProjectTerminalRef, spec: LaunchSpec): LaunchResult {
    this.events.push(`launch ${ref.projectId}`)
    if (this.throws) throw new Error('posix_spawnp failed.')
    if (this.refuses) return { kind: 'refused', reason: 'live-run' }
    const pid = this.pid
    this.pid += 1
    this.launches.push({ ref, spec, pid })
    this.processes.spawn(pid, ref.projectId, spec.generation)
    if (this.early !== null) this.processes.end(this.processes.group(pid), this.early)
    return { kind: 'launched', pid }
  }

  interrupt(ref: ProjectTerminalRef, generation: number): boolean {
    this.interrupts.push([ref.projectId, generation])
    const launched = this.launches.findLast((each) => each.ref.projectId === ref.projectId)
    if (launched?.spec.generation !== generation) return false
    return this.processes.interrupt(launched.pid)
  }

  tap(listener: TerminalTap): () => void {
    this.taps.add(listener)
    return () => {
      this.taps.delete(listener)
    }
  }

  dispose(ref: TerminalRef): void {
    this.disposed.push(ref)
  }

  exit(projectId: string, generation: number, code: number): void {
    const ref: TerminalRef = { scope: 'project', projectId, id: 'run' }
    for (const listener of this.taps) listener(ref, { kind: 'exit', code }, generation)
  }
}

class FakeTraffic {
  readonly recording = new Set<string>()
  outcome: 'ok' | 'refused' | 'throws' | 'no-port' = 'ok'
  envVar: string | null = VARIABLE
  hold = false
  holdStops = false
  starts = 0
  stops = 0
  private readonly held: (() => void)[] = []
  private readonly heldStops: (() => void)[] = []

  constructor(private readonly events: string[]) {}

  state(projectId: string): ProjectTrafficState | null {
    const capturing = this.recording.has(projectId)
    return trafficState({ capturing, port: capturing ? 30_100 : null, envVar: this.envVar })
  }

  async start(projectId: string): Promise<ProjectTrafficState> {
    this.starts += 1
    this.events.push(`start ${projectId}`)
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.held.push(resolve)
      })
    }
    if (this.outcome === 'throws') throw new Error('listen EADDRINUSE')
    if (this.outcome === 'refused') return trafficState({ failure: 'in-use', envVar: this.envVar })
    this.recording.add(projectId)
    const port = this.outcome === 'no-port' ? null : 30_100
    return trafficState({ capturing: true, port, envVar: this.envVar })
  }

  async stop(projectId: string): Promise<ProjectTrafficState> {
    this.stops += 1
    if (this.holdStops) {
      await new Promise<void>((resolve) => {
        this.heldStops.push(resolve)
      })
    }
    this.events.push(`stop ${projectId}`)
    this.recording.delete(projectId)
    return trafficState({ envVar: this.envVar })
  }

  release(): void {
    for (const resolve of this.held.splice(0)) resolve()
  }

  releaseStops(): void {
    this.holdStops = false
    for (const resolve of this.heldStops.splice(0)) resolve()
  }
}

interface Harness {
  readonly runner: ProjectRunner
  readonly projects: Map<string, RunProject>
  readonly processes: FakeProcesses
  readonly terminals: FakeTerminals
  readonly traffic: FakeTraffic
  readonly changes: RunChange[]
  readonly events: string[]
  readonly warnings: (Record<string, unknown> | undefined)[]
}

interface Options {
  readonly platform?: NodeJS.Platform
  readonly shell?: string
}

function build(options: Options = {}): Harness {
  const events: string[] = []
  const projects = new Map<string, RunProject>([
    ['p1', project()],
    ['p2', project({ canonicalRoot: '/repo/p2' })],
  ])
  const processes = new FakeProcesses()
  const terminals = new FakeTerminals(processes, events)
  const traffic = new FakeTraffic(events)
  processes.leaderExit = (group, code) => {
    terminals.exit(group.projectId, group.generation, code)
  }
  const changes: RunChange[] = []
  const warnings: (Record<string, unknown> | undefined)[] = []
  const runner = new ProjectRunner({
    project: (projectId) => projects.get(projectId) ?? null,
    traffic,
    terminals,
    shell: () => ({ file: options.shell ?? '/bin/zsh', args: ['-l'] }),
    env: () => ({ PATH: '/usr/bin:/bin' }),
    platform: options.platform ?? 'darwin',
    kill: (pid, signal) => {
      processes.kill(pid, signal)
    },
    log: {
      warn: (_message, fields) => {
        warnings.push(fields)
      },
    },
  })
  runner.subscribe((change) => changes.push(change))
  return { runner, projects, processes, terminals, traffic, changes, events, warnings }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

const elapse = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('starting a run', () => {
  it('reserves the run before anything is awaited and refuses a duplicate', async () => {
    const { runner, traffic, terminals } = build()
    traffic.hold = true
    const first = runner.run('p1')
    expect(runner.state('p1')).toEqual({ kind: 'starting', token: 1, active: DEV_CLEAN })

    expect((await runner.run('p1')).process).toEqual({
      kind: 'starting',
      token: 1,
      active: DEV_CLEAN,
    })
    expect((await runner.restart('p1')).process.kind).toBe('starting')
    expect(traffic.starts).toBe(1)

    traffic.release()
    await first
    expect(terminals.launches).toHaveLength(1)
    expect(runner.state('p1')).toMatchObject({ kind: 'running', token: 1 })
  })

  it('spawns only once the capture has answered', async () => {
    const { runner, traffic, terminals, events } = build()
    traffic.hold = true
    const pending = runner.run('p1')
    await flush()
    expect(events).toEqual(['start p1'])
    expect(terminals.launches).toHaveLength(0)

    traffic.release()
    await pending
    expect(events).toEqual(['start p1', 'launch p1'])
  })

  it('runs the default in a login shell that exports the redirect after startup', async () => {
    const { runner, terminals } = build()
    const { process, cleanupPending } = await runner.run('p1')
    expect(terminals.launches[0]?.ref).toEqual(RUN_REF)
    expect(terminals.launches[0]?.spec).toEqual({
      cwd: '/repo/p1',
      env: { PATH: '/usr/bin:/bin', [VARIABLE]: REDIRECT },
      file: '/bin/zsh',
      args: ['-l', '-i', '-c', scriptFor('npm run dev:clean')],
      generation: 1,
    })
    expect(process).toEqual({ kind: 'running', token: 1, active: DEV_CLEAN, pgid: 100 })
    expect(cleanupPending).toBe(false)
  })

  it('runs a named command instead of the default', async () => {
    const { runner, terminals } = build()
    await runner.run('p1', 'dev')
    expect(terminals.launches[0]?.spec.args.at(-1)).toBe(scriptFor('npm run dev'))
    expect(runner.state('p1')).toMatchObject({ active: DEV })
  })

  const withoutCapture: readonly {
    readonly name: string
    readonly edit: Partial<RunProject>
  }[] = [
    { name: 'both settings', edit: { trafficOrigin: null, trafficEnvVar: null } },
    { name: 'the backend URL', edit: { trafficOrigin: null } },
    { name: 'the variable', edit: { trafficEnvVar: null } },
  ]

  it.each(withoutCapture)('runs without HTTP capture with $name missing', async ({ edit }) => {
    const { runner, projects, terminals, traffic } = build()
    projects.set('p1', project(edit))

    expect((await runner.run('p1')).process).toEqual({
      kind: 'running',
      token: 1,
      active: DEV_CLEAN,
      pgid: 100,
    })
    expect(traffic.starts).toBe(0)
    expect(terminals.launches[0]?.spec).toEqual({
      cwd: '/repo/p1',
      env: { PATH: '/usr/bin:/bin' },
      file: '/bin/zsh',
      args: ['-l', '-i', '-c', 'set +m; npm run dev:clean'],
      generation: 1,
    })
  })

  it('restarts and stops a plain command without touching an independent recording', async () => {
    const { runner, projects, terminals, traffic } = build()
    projects.set('p1', project({ trafficOrigin: null, trafficEnvVar: null }))
    traffic.recording.add('p1')

    await runner.run('p1')
    expect((await runner.restart('p1')).process.kind).toBe('running')
    expect(terminals.launches).toHaveLength(2)
    expect(terminals.launches[1]?.spec.args.at(-1)).toBe('set +m; npm run dev:clean')
    expect((await runner.stop('p1')).process.kind).toBe('exited')
    expect(terminals.interrupts).toEqual([
      ['p1', 1],
      ['p1', 2],
    ])
    expect(traffic.starts).toBe(0)
    expect(traffic.stops).toBe(0)
    expect(traffic.recording.has('p1')).toBe(true)
  })

  it.each(['throws', 'refuses'] as const)(
    'reports a plain command spawn failure when the terminal %s',
    async (flag) => {
      const { runner, projects, terminals, traffic } = build()
      projects.set('p1', project({ trafficOrigin: null, trafficEnvVar: null }))
      terminals[flag] = true

      expect((await runner.run('p1')).process).toEqual({
        kind: 'failed',
        reason: 'spawn-failed',
        active: DEV_CLEAN,
      })
      expect(traffic.starts).toBe(0)
      expect(traffic.stops).toBe(0)
    }
  )

  const refusals: readonly {
    readonly name: string
    readonly reason: RunFailure
    readonly options?: Options
    readonly edit?: Partial<RunProject>
    readonly commandId?: string
  }[] = [
    { name: 'a remote project', reason: 'not-local', edit: { host: 'devbox' } },
    { name: 'Windows', reason: 'unsupported-platform', options: { platform: 'win32' } },
    { name: 'no saved commands', reason: 'no-command', edit: { runCommands: null } },
    { name: 'an unknown command', reason: 'no-command', commandId: 'missing' },
    { name: 'an unexportable variable', reason: 'no-variable', edit: { trafficEnvVar: 'A-B' } },
    { name: 'fish', reason: 'unsupported-shell', options: { shell: '/opt/homebrew/bin/fish' } },
  ]

  it.each(refusals)(
    'refuses $name before capturing or spawning',
    async ({ reason, options, edit, commandId }) => {
      const { runner, projects, traffic, terminals } = build(options)
      projects.set('p1', project(edit))
      expect((await runner.run('p1', commandId)).process).toMatchObject({ kind: 'failed', reason })
      expect(traffic.starts).toBe(0)
      expect(terminals.launches).toHaveLength(0)
    }
  )

  const captureFailures = [
    { name: 'a refused capture', outcome: 'refused', envVar: VARIABLE, reason: 'capture-failed' },
    { name: 'a throwing capture', outcome: 'throws', envVar: VARIABLE, reason: 'capture-failed' },
    { name: 'a portless capture', outcome: 'no-port', envVar: VARIABLE, reason: 'capture-failed' },
    { name: 'a capture with no redirect', outcome: 'ok', envVar: null, reason: 'no-redirect' },
  ] as const

  it.each(captureFailures)('never spawns after $name', async ({ outcome, envVar, reason }) => {
    const { runner, traffic, terminals } = build()
    traffic.outcome = outcome
    traffic.envVar = envVar
    expect((await runner.run('p1')).process).toEqual({ kind: 'failed', reason, active: DEV_CLEAN })
    expect(terminals.launches).toHaveLength(0)
    expect(traffic.recording.has('p1')).toBe(false)
  })

  it.each(['throws', 'refuses'] as const)(
    'gives back the recording it started when the spawn %s',
    async (flag) => {
      const { runner, traffic, terminals } = build()
      terminals[flag] = true
      expect((await runner.run('p1')).process).toEqual({
        kind: 'failed',
        reason: 'spawn-failed',
        active: DEV_CLEAN,
      })
      expect(traffic.stops).toBe(1)
      expect(traffic.recording.has('p1')).toBe(false)
    }
  )
})

describe('cancelling while starting', () => {
  it.each([
    { before: false, stops: 1 },
    { before: true, stops: 0 },
  ])(
    'spawns nothing and gives back only what it started (recording before: $before)',
    async ({ before, stops }) => {
      const { runner, traffic, terminals } = build()
      if (before) traffic.recording.add('p1')
      traffic.hold = true
      const running = runner.run('p1')
      await flush()
      expect(traffic.starts).toBe(1)
      const stopping = runner.stop('p1')
      expect(runner.state('p1').kind).toBe('starting')

      traffic.release()
      expect((await stopping).process).toEqual({
        kind: 'failed',
        reason: 'cancelled',
        active: DEV_CLEAN,
      })
      await running
      expect(terminals.launches).toHaveLength(0)
      expect(traffic.stops).toBe(stops)
      expect(traffic.recording.has('p1')).toBe(before)
    }
  )
})

describe('tokens', () => {
  it('never reuses one, whatever happened to the run that held it', async () => {
    const { runner, traffic, terminals } = build()
    traffic.outcome = 'refused'
    await runner.run('p1')

    traffic.outcome = 'ok'
    traffic.hold = true
    const cancelled = runner.run('p1')
    void runner.stop('p1')
    traffic.release()
    await cancelled
    traffic.hold = false

    await runner.run('p1')
    await runner.restart('p1')
    expect(terminals.launches.map((each) => each.spec.generation)).toEqual([3, 4])
    expect(runner.state('p1')).toMatchObject({ kind: 'running', token: 4 })
  })
})

describe('a leader that exits on its own', () => {
  it('keeps an exit that comes before the launch returns instead of running', async () => {
    const { runner, terminals } = build()
    terminals.early = 1
    expect(await runner.run('p1')).toEqual({
      process: { kind: 'exited', token: 1, active: DEV_CLEAN, code: 1 },
      cleanupPending: true,
    })
    await elapse(500)
    expect(runner.snapshot('p1').cleanupPending).toBe(false)
  })

  it('confirms the group is gone with one probe, then enables Run without a Stop', async () => {
    const { runner, processes, terminals, traffic, changes } = build()
    await runner.run('p1')
    processes.end(processes.group(100), 0)
    const exited = { kind: 'exited', token: 1, active: DEV_CLEAN, code: 0 }
    expect(runner.snapshot('p1')).toEqual({ process: exited, cleanupPending: true })

    await elapse(500)
    expect(changes.at(-1)).toEqual({ projectId: 'p1', process: exited, cleanupPending: false })
    expect(processes.signals).toEqual([[-100, 0]])
    expect(traffic.recording.has('p1')).toBe(true)

    await runner.run('p1')
    expect(terminals.launches).toHaveLength(2)
  })

  it('keeps ownership while workers outlive the leader, and blocks Run', async () => {
    const { runner, processes, terminals } = build()
    await runner.run('p1')
    processes.leaderOnly(processes.group(100), 0)
    await elapse(500)
    expect(runner.snapshot('p1').cleanupPending).toBe(true)

    expect((await runner.run('p1')).process.kind).toBe('exited')
    expect(terminals.launches).toHaveLength(1)
    await elapse(10_000)
    expect(processes.signals).toEqual([[-100, 0]])
  })

  it('treats a probe it is not allowed to make as not gone', async () => {
    const { runner, processes } = build()
    processes.behaviour = { ...processes.behaviour, failure: 'EPERM' }
    await runner.run('p1')
    processes.leaderOnly(processes.group(100), 0)
    await elapse(500)
    expect(runner.snapshot('p1').cleanupPending).toBe(true)
  })
})

describe('stopping', () => {
  it('interrupts, confirms the group is gone, stops recording, and keeps the output', async () => {
    const { runner, processes, terminals, traffic } = build()
    await runner.run('p1')
    expect(await runner.stop('p1')).toEqual({
      process: { kind: 'exited', token: 1, active: DEV_CLEAN, code: 130 },
      cleanupPending: false,
    })
    expect(terminals.interrupts).toEqual([['p1', 1]])
    expect(processes.signals).toEqual([[-100, 0]])
    expect(traffic.recording.has('p1')).toBe(false)
    expect(terminals.disposed).toEqual([])
  })

  it('cleans a group whose leader already exited, without interrupting', async () => {
    const { runner, processes, terminals } = build()
    await runner.run('p1')
    processes.leaderOnly(processes.group(100), 0)
    await elapse(500)

    expect(await runner.stop('p1')).toEqual({
      process: { kind: 'exited', token: 1, active: DEV_CLEAN, code: 0 },
      cleanupPending: false,
    })
    expect(terminals.interrupts).toEqual([])
    expect(processes.signals).toEqual([
      [-100, 0],
      [-100, 0],
      [-100, 'SIGTERM'],
      [-100, 0],
    ])
  })

  it('escalates from interrupt to TERM to KILL, and never signals after ESRCH', async () => {
    const { runner, processes } = build()
    processes.behaviour = { interrupted: 'nothing', fatal: 'SIGKILL', failure: null }
    await runner.run('p1')
    const stopping = runner.stop('p1')
    expect(runner.state('p1').kind).toBe('stopping')

    await elapse(5_000)
    expect(processes.signals.map(([, signal]) => signal)).toEqual([0, 'SIGTERM', 0])
    await elapse(2_000)
    expect((await stopping).process).toMatchObject({ kind: 'exited', code: 137 })
    expect(processes.signals.at(-2)).toEqual([-100, 'SIGKILL'])
    expect(processes.signals.at(-1)).toEqual([-100, 0])

    const count = processes.signals.length
    await runner.stop('p1')
    await elapse(10_000)
    expect(processes.signals).toHaveLength(count)
  })

  it('ends in stop-incomplete when the group survives KILL, and lets Stop retry', async () => {
    const { runner, processes, terminals } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    const stopping = runner.stop('p1')
    await elapse(8_000)
    expect(await stopping).toEqual({
      process: { kind: 'failed', reason: 'stop-incomplete', active: DEV_CLEAN },
      cleanupPending: true,
    })
    expect((await runner.run('p1')).process.kind).toBe('failed')
    expect(terminals.launches).toHaveLength(1)

    processes.group(100).behaviour = { interrupted: 'all', fatal: 'SIGTERM', failure: null }
    expect(await runner.stop('p1')).toEqual({
      process: { kind: 'exited', token: 1, active: DEV_CLEAN, code: 130 },
      cleanupPending: false,
    })
  })
})

describe('restarting', () => {
  it('relaunches the command it launched, not the edited one, and keeps recording', async () => {
    const { runner, projects, terminals, traffic } = build()
    await runner.run('p1')
    const edited = { id: DEV_CLEAN.id, label: 'renamed', command: 'npm run something-else' }
    projects.set('p1', project({ runCommands: { ...COMMANDS, commands: [edited] } }))

    expect((await runner.restart('p1')).process).toEqual({
      kind: 'running',
      token: 2,
      active: DEV_CLEAN,
      pgid: 101,
    })
    expect(terminals.launches[1]?.spec.args.at(-1)).toBe(scriptFor('npm run dev:clean'))
    expect(traffic.stops).toBe(0)
    expect(traffic.recording.has('p1')).toBe(true)
  })

  it('checks the current settings before it relaunches', async () => {
    const { runner, projects, terminals } = build()
    await runner.run('p1')
    projects.set('p1', project({ trafficEnvVar: 'A-B' }))
    expect((await runner.restart('p1')).process).toEqual({
      kind: 'failed',
      reason: 'no-variable',
      active: DEV_CLEAN,
    })
    expect(terminals.launches).toHaveLength(1)
  })

  it('finishes an incomplete cleanup first, then relaunches', async () => {
    const { runner, processes, terminals } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    const stopping = runner.stop('p1')
    await elapse(8_000)
    await stopping

    processes.group(100).behaviour = { interrupted: 'all', fatal: 'SIGTERM', failure: null }
    expect((await runner.restart('p1')).process).toEqual({
      kind: 'running',
      token: 2,
      active: DEV_CLEAN,
      pgid: 101,
    })
    expect(terminals.launches.map((each) => each.spec.generation)).toEqual([1, 2])
  })

  it('launches nothing when it cannot finish the cleanup', async () => {
    const { runner, processes, terminals } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    const restarting = runner.restart('p1')
    await elapse(8_000)
    expect((await restarting).process).toEqual({
      kind: 'failed',
      reason: 'stop-incomplete',
      active: DEV_CLEAN,
    })
    expect(terminals.launches).toHaveLength(1)
  })

  it('gives way to a Stop pressed during its cleanup', async () => {
    const { runner, processes, terminals, traffic } = build()
    processes.behaviour = { interrupted: 'nothing', fatal: 'SIGTERM', failure: null }
    await runner.run('p1')
    const restarting = runner.restart('p1')
    const stopping = runner.stop('p1')
    await elapse(5_000)
    await Promise.all([restarting, stopping])

    expect(runner.state('p1')).toMatchObject({ kind: 'exited', code: 143 })
    expect(terminals.launches).toHaveLength(1)
    expect(traffic.recording.has('p1')).toBe(false)
  })
})

describe('capture changes', () => {
  it.each(['run', 'restart'] as const)(
    'keep Stop reserved until recording has stopped, so a later %s keeps its recording',
    async (action) => {
      const { runner, traffic, events } = build()
      await runner.run('p1')
      traffic.holdStops = true
      const stopping = runner.stop('p1')
      await flush()
      expect(runner.state('p1').kind).toBe('stopping')
      expect((await runner[action]('p1')).process.kind).toBe('stopping')
      expect(traffic.starts).toBe(1)

      traffic.releaseStops()
      expect((await stopping).process.kind).toBe('exited')
      await runner[action]('p1')
      expect(runner.state('p1')).toMatchObject({ kind: 'running', token: 2 })
      expect(traffic.recording.has('p1')).toBe(true)
      expect(events).toEqual(['start p1', 'launch p1', 'stop p1', 'start p1', 'launch p1'])
    }
  )

  it('reads recording after a pending Stop recording, so Cancel undoes only Run', async () => {
    const { runner, traffic, terminals, events } = build()
    traffic.recording.add('p1')
    traffic.holdStops = true
    const stoppingRecording = runner.stopRecording('p1')
    traffic.hold = true
    const running = runner.run('p1')
    await flush()
    expect(events).toEqual([])

    traffic.releaseStops()
    await flush()
    expect(events).toEqual(['stop p1', 'start p1'])
    const cancelling = runner.stop('p1')
    traffic.release()
    await Promise.all([stoppingRecording, running, cancelling])

    expect(terminals.launches).toHaveLength(0)
    expect(events).toEqual(['stop p1', 'start p1', 'stop p1'])
    expect(traffic.recording.has('p1')).toBe(false)
  })
})

describe('Capture only beside a managed run', () => {
  it('refuses a manual toggle while a run is starting, running or stopping', async () => {
    const { runner, traffic } = build()
    traffic.hold = true
    const running = runner.run('p1')
    await flush()
    await expect(runner.captureOnly('p1', 'stop')).rejects.toThrow('running command')

    traffic.release()
    await running
    await expect(runner.captureOnly('p1', 'stop')).rejects.toThrow('running command')
    expect(traffic.stops).toBe(0)
    expect(traffic.recording.has('p1')).toBe(true)

    traffic.holdStops = true
    const stopping = runner.stop('p1')
    await flush()
    expect(runner.state('p1').kind).toBe('stopping')
    await expect(runner.captureOnly('p1', 'start')).rejects.toThrow('running command')
    traffic.releaseStops()
    await stopping
    expect(traffic.starts).toBe(1)
  })

  it('lets a manual Stop pending before Run apply first, so Cancel undoes only Run', async () => {
    const { runner, traffic, terminals, events } = build()
    traffic.recording.add('p1')
    traffic.holdStops = true
    const manual = runner.captureOnly('p1', 'stop')
    traffic.hold = true
    const running = runner.run('p1')
    await flush()
    expect(events).toEqual([])

    traffic.releaseStops()
    await flush()
    expect(events).toEqual(['stop p1', 'start p1'])
    const cancelling = runner.stop('p1')
    traffic.release()
    await Promise.all([manual, running, cancelling])

    expect(terminals.launches).toHaveLength(0)
    expect(events).toEqual(['stop p1', 'start p1', 'stop p1'])
    expect(traffic.recording.has('p1')).toBe(false)
  })

  it('keeps a manual Start pending before Run, so Cancel leaves recording on', async () => {
    const { runner, traffic, terminals, events } = build()
    traffic.hold = true
    const manual = runner.captureOnly('p1', 'start')
    const running = runner.run('p1')
    await flush()
    expect(events).toEqual(['start p1'])

    traffic.release()
    await flush()
    expect(events).toEqual(['start p1', 'start p1'])
    const cancelling = runner.stop('p1')
    traffic.release()
    await Promise.all([manual, running, cancelling])

    expect(terminals.launches).toHaveLength(0)
    expect(traffic.stops).toBe(0)
    expect(traffic.recording.has('p1')).toBe(true)
  })

  it.each(['dispose', 'close'] as const)(
    'refuses manual capture once the project is going away (%s)',
    async (ending) => {
      const { runner, traffic } = build()
      await (ending === 'dispose' ? runner.dispose('p1') : runner.close())
      await expect(runner.captureOnly('p1', 'start')).rejects.toThrow('going away')
      await expect(runner.captureOnly('p1', 'stop')).rejects.toThrow('going away')
      expect(traffic.starts).toBe(0)
      expect(traffic.stops).toBe(0)
    }
  )

  it.each(['dispose', 'close'] as const)(
    'drops a queued manual change that removal or quit overtakes (%s)',
    async (ending) => {
      const { runner, traffic } = build()
      traffic.recording.add('p1')
      traffic.holdStops = true
      const first = runner.captureOnly('p1', 'stop')
      const queued = runner.captureOnly('p1', 'start')
      await flush()
      expect(traffic.stops).toBe(1)

      const going = ending === 'dispose' ? runner.dispose('p1') : runner.close()
      traffic.releaseStops()
      await first
      await expect(queued).rejects.toThrow('going away')
      await going
      expect(traffic.starts).toBe(0)
      expect(traffic.stops).toBe(1)
    }
  )

  it('leaves manual capture alone when nothing is running', async () => {
    const { runner, traffic } = build()
    await runner.captureOnly('p1', 'start')
    expect(traffic.recording.has('p1')).toBe(true)
    await runner.captureOnly('p1', 'stop')
    expect(traffic.recording.has('p1')).toBe(false)
  })
})

describe('stopping recording', () => {
  it('stops recording on its own while nothing runs', async () => {
    const { runner, traffic } = build()
    traffic.recording.add('p1')
    await runner.stopRecording('p1')
    expect(traffic.recording.has('p1')).toBe(false)
  })

  it('leaves a running command’s recording alone', async () => {
    const { runner, traffic } = build()
    await runner.run('p1')
    await runner.stopRecording('p1')
    expect(traffic.stops).toBe(0)
    expect(traffic.recording.has('p1')).toBe(true)
  })
})

describe('removing a project', () => {
  it('cancels a pending launch, and the late capture neither spawns nor publishes', async () => {
    const { runner, traffic, terminals, changes } = build()
    traffic.hold = true
    void runner.run('p1')
    await flush()
    expect(traffic.starts).toBe(1)
    const seen = changes.length
    const disposing = runner.dispose('p1')
    traffic.release()
    await disposing

    expect(terminals.launches).toHaveLength(0)
    expect(changes).toHaveLength(seen)
    expect(terminals.disposed).toEqual([RUN_REF])
    expect(runner.state('p1')).toEqual({ kind: 'idle' })
  })

  it('cleans the running group, then ignores its late exit', async () => {
    const { runner, processes, terminals, changes } = build()
    await runner.run('p1')
    await runner.dispose('p1')
    expect(processes.group(100).alive).toBe(false)

    const seen = changes.length
    terminals.exit('p1', 1, 0)
    expect(changes).toHaveLength(seen)
    expect(runner.state('p1')).toEqual({ kind: 'idle' })
  })

  it.each([false, true])(
    'refuses a removed project while the store still has it (it ran before: %s)',
    async (ranBefore) => {
      const { runner, traffic, terminals } = build()
      if (ranBefore) await runner.run('p1')
      await runner.dispose('p1')
      const starts = traffic.starts
      traffic.recording.add('p1')

      expect(await runner.run('p1')).toEqual({ process: { kind: 'idle' }, cleanupPending: false })
      expect((await runner.restart('p1')).process).toEqual({ kind: 'idle' })
      await runner.stopRecording('p1')
      expect(traffic.starts).toBe(starts)
      expect(terminals.launches).toHaveLength(ranBefore ? 1 : 0)
      expect(traffic.recording.has('p1')).toBe(true)
      expect(terminals.disposed).toEqual([RUN_REF])
    }
  )

  it('stops waiting on a capture that never answers at the removal deadline', async () => {
    const { runner, traffic, terminals } = build()
    traffic.hold = true
    void runner.run('p1')
    await flush()
    expect(traffic.starts).toBe(1)
    let removed = false
    void runner.dispose('p1').then(() => {
      removed = true
    })
    await elapse(9_999)
    expect(removed).toBe(false)
    await elapse(1)
    expect(removed).toBe(true)

    traffic.release()
    await flush()
    expect(terminals.launches).toHaveLength(0)
  })

  it('takes over a Stop already cleaning, and nothing runs on after removal', async () => {
    const { runner, processes, warnings } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    const stopping = runner.stop('p1')
    await elapse(1_000)
    const disposing = runner.dispose('p1')
    await elapse(10_000)
    await Promise.all([disposing, stopping])

    expect(warnings).toEqual([{ projectId: 'p1', cause: 'removal', label: 'dev:clean', pgid: 100 }])
    const calls = processes.signals.length
    await elapse(20_000)
    expect(processes.signals).toHaveLength(calls)
  })

  it('joins a repeated removal to the one in progress', async () => {
    const { runner, processes, terminals } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    const first = runner.dispose('p1')
    expect(runner.dispose('p1')).toBe(first)
    let joined = false
    const again = runner.dispose('p1').then(() => {
      joined = true
    })

    await elapse(7_900)
    expect(joined).toBe(false)
    expect(terminals.disposed).toEqual([])
    await elapse(100)
    await Promise.all([first, again])
    expect(joined).toBe(true)
    expect(terminals.disposed).toEqual([RUN_REF])
  })

  it('records a group that outlived removal before letting it go', async () => {
    const { runner, processes, terminals, warnings } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    const disposing = runner.dispose('p1')
    await elapse(8_000)
    await disposing

    expect(warnings).toEqual([{ projectId: 'p1', cause: 'removal', label: 'dev:clean', pgid: 100 }])
    expect(terminals.disposed).toEqual([RUN_REF])
  })
})

describe('quitting', () => {
  it('does not wait on a capture that never answers, which cannot spawn afterwards', async () => {
    const { runner, traffic, terminals, changes } = build()
    traffic.hold = true
    void runner.run('p1')
    await flush()
    expect(traffic.starts).toBe(1)
    const seen = changes.length
    let closed = false
    void runner.close().then(() => {
      closed = true
    })
    await elapse(2_000)
    expect(closed).toBe(true)

    traffic.release()
    await flush()
    expect(terminals.launches).toHaveLength(0)
    expect(changes).toHaveLength(seen)
  })

  it('cleans every project together inside two seconds, and records the survivors', async () => {
    const { runner, processes, warnings } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    await runner.run('p2')
    let closed = false
    void runner.close().then(() => {
      closed = true
    })

    await elapse(1_900)
    expect(closed).toBe(false)
    await elapse(100)
    expect(closed).toBe(true)
    expect(warnings).toHaveLength(2)
    expect(warnings).toEqual(
      expect.arrayContaining([
        { projectId: 'p1', cause: 'quit', label: 'dev:clean', pgid: 100 },
        { projectId: 'p2', cause: 'quit', label: 'dev:clean', pgid: 101 },
      ])
    )
    for (const pgid of [100, 101]) {
      expect(processes.signals).toContainEqual([-pgid, 'SIGTERM'])
      expect(processes.signals).toContainEqual([-pgid, 'SIGKILL'])
    }
  })

  it.each(['stop', 'restart'] as const)(
    'takes over a %s already cleaning, inside the deadline, and nothing runs on after',
    async (action) => {
      const { runner, processes, terminals } = build()
      processes.behaviour = STUBBORN
      await runner.run('p1')
      const acting = runner[action]('p1')
      await elapse(1_000)
      let closed = false
      void runner.close().then(() => {
        closed = true
      })
      await elapse(2_000)
      expect(closed).toBe(true)
      await acting

      const calls = processes.signals.length
      const interrupts = terminals.interrupts.length
      await elapse(20_000)
      expect(processes.signals).toHaveLength(calls)
      expect(terminals.interrupts).toHaveLength(interrupts)
      expect(terminals.launches).toHaveLength(1)
    }
  )

  it('makes a removal asked for during quit wait for the quit', async () => {
    const { runner, processes, terminals, warnings } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    let closed = false
    let removed = false
    const closing = runner.close().then(() => {
      closed = true
    })
    const removing = runner.dispose('p1').then(() => {
      removed = true
    })
    await elapse(1_900)
    expect(closed).toBe(false)
    expect(removed).toBe(false)
    expect(terminals.disposed).toEqual([])

    await elapse(100)
    await Promise.all([closing, removing])
    expect(closed).toBe(true)
    expect(removed).toBe(true)
    expect(terminals.disposed).toEqual([RUN_REF])
    expect(warnings).toEqual([{ projectId: 'p1', cause: 'quit', label: 'dev:clean', pgid: 100 }])

    const calls = processes.signals.length
    await elapse(20_000)
    expect(processes.signals).toHaveLength(calls)
  })

  it('lets a quit that takes over a removal finish before the terminal goes', async () => {
    const { runner, processes, terminals, warnings } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    let removed = false
    let closed = false
    const removing = runner.dispose('p1').then(() => {
      removed = true
    })
    await elapse(1_000)
    const closing = runner.close().then(() => {
      closed = true
    })

    await elapse(1_900)
    expect(removed).toBe(false)
    expect(closed).toBe(false)
    expect(terminals.disposed).toEqual([])
    expect(terminals.taps.size).toBe(1)

    await elapse(100)
    await Promise.all([removing, closing])
    expect(removed).toBe(true)
    expect(closed).toBe(true)
    expect(terminals.disposed).toEqual([RUN_REF])
    expect(terminals.taps.size).toBe(0)
    expect(warnings).toEqual([{ projectId: 'p1', cause: 'quit', label: 'dev:clean', pgid: 100 }])

    const calls = processes.signals.length
    const interrupts = terminals.interrupts.length
    await elapse(20_000)
    expect(processes.signals).toHaveLength(calls)
    expect(terminals.interrupts).toHaveLength(interrupts)
    expect(terminals.disposed).toEqual([RUN_REF])
  })

  it('ends a removal waiting on a capture when quit takes it over', async () => {
    const { runner, traffic, terminals } = build()
    traffic.hold = true
    void runner.run('p1')
    await flush()
    expect(traffic.starts).toBe(1)
    let removed = false
    const removing = runner.dispose('p1').then(() => {
      removed = true
    })
    await elapse(1_000)
    const closing = runner.close()

    await elapse(1_999)
    expect(removed).toBe(false)
    await elapse(1)
    await Promise.all([removing, closing])
    expect(removed).toBe(true)
    expect(terminals.disposed).toEqual([RUN_REF])

    traffic.release()
    await flush()
    expect(terminals.launches).toHaveLength(0)
  })

  it('joins a repeated quit to the first, with one deadline and one of everything', async () => {
    const { runner, processes, terminals, warnings } = build()
    processes.behaviour = STUBBORN
    await runner.run('p1')
    let closed = false
    const first = runner.close()
    void first.then(() => {
      closed = true
    })
    await elapse(1_500)
    const second = runner.close()
    expect(second).toBe(first)

    await elapse(500)
    expect(closed).toBe(true)
    await second
    expect(warnings).toHaveLength(1)
    expect(terminals.disposed).toEqual([RUN_REF])
    expect(terminals.taps.size).toBe(0)
  })

  it('starts nothing once quitting has begun', async () => {
    const { runner, traffic } = build()
    const closing = runner.close()
    expect((await runner.run('p1')).process).toEqual({ kind: 'idle' })
    await closing
    expect(traffic.starts).toBe(0)
  })
})
