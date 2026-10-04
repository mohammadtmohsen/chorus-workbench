import type { AgentAdapter } from '@chorus/agent-protocol'
import { FakeAdapter } from '@chorus/orchestrator'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChorusRuntime } from './runtime.js'
import type { TerminalRef } from './terminal.js'

const { spawnRequested } = vi.hoisted(() => ({
  spawnRequested: vi.fn(() => {
    throw new Error('a native shell was about to spawn')
  }),
}))

vi.mock('./shell.js', () => ({ resolveShell: spawnRequested }))

const PROFILING = 'CHORUS_PROFILE_READONLY'

let runtime: ChorusRuntime
let quit: Promise<void> | null
let profiling: string | undefined

beforeEach(() => {
  profiling = process.env[PROFILING]
  delete process.env[PROFILING]
  spawnRequested.mockClear()
  quit = null
  runtime = ChorusRuntime.open(
    mkdtempSync(join(tmpdir(), 'chorus-shells-')),
    new Logger(),
    new Map<AgentId, AgentAdapter>([
      ['claude', new FakeAdapter({ id: 'claude' })],
      ['codex', new FakeAdapter({ id: 'codex' })],
    ])
  )
})

afterEach(async () => {
  if (profiling === undefined) {
    delete process.env[PROFILING]
  } else {
    process.env[PROFILING] = profiling
  }
  await (quit ?? runtime.close())
})

const shell = (projectId: string): TerminalRef => ({ scope: 'shell', projectId, id: 'main' })

const localProject = (prefix: string): string =>
  runtime.projects.adopt(mkdtempSync(join(tmpdir(), prefix))).project.id

describe('project shells through the runtime', () => {
  it('opens none for a project it does not know', async () => {
    expect(await runtime.attachTerminal(shell('missing'))).toBeNull()
    expect(runtime.describeTerminal(shell('missing'))).toBeNull()
  })

  it('opens none for a remote project', async () => {
    const agentCwd = mkdtempSync(join(tmpdir(), 'chorus-shells-remote-'))
    const { project } = runtime.projects.adoptRemote({ host: 'tpa-be', root: 'C:/api', agentCwd })
    expect(await runtime.attachTerminal(shell(project.id))).toBeNull()
    expect(runtime.describeTerminal(shell(project.id))).toBeNull()
  })

  it('opens none once its traffic is disposed, while the project still exists', async () => {
    const projectId = localProject('chorus-shells-local-')
    await runtime.disposeProjectTraffic(projectId)
    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(await runtime.attachTerminal(shell(projectId))).toBeNull()
    expect(runtime.describeTerminal(shell(projectId))).toBeNull()
  })

  it('opens none in read-only profiling, though the project is local and present', async () => {
    const projectId = localProject('chorus-shells-profiling-')
    process.env[PROFILING] = '1'
    expect(await runtime.attachTerminal(shell(projectId))).toBeNull()
    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(spawnRequested).not.toHaveBeenCalled()
  })

  it('opens none once the project is forgotten', async () => {
    const projectId = localProject('chorus-shells-gone-')
    await runtime.forgetProject(projectId)
    expect(await runtime.attachTerminal(shell(projectId))).toBeNull()
  })
})

describe('project shells while teardown is still under way', () => {
  it('refuses a first shell as soon as removal starts, with the project still there', async () => {
    const projectId = localProject('chorus-shells-removing-')
    const removal = runtime.forgetProject(projectId)
    const attach = runtime.attachTerminal(shell(projectId))
    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(await attach).toBeNull()
    expect(spawnRequested).not.toHaveBeenCalled()
    await removal
  })

  it('refuses a first shell as soon as traffic disposal starts', async () => {
    const projectId = localProject('chorus-shells-disposing-')
    const disposal = runtime.disposeProjectTraffic(projectId)
    const attach = runtime.attachTerminal(shell(projectId))
    expect(runtime.projects.get(projectId)).not.toBeNull()
    expect(await attach).toBeNull()
    expect(spawnRequested).not.toHaveBeenCalled()
    await disposal
  })

  it('refuses a first shell as soon as quit starts', async () => {
    const projectId = localProject('chorus-shells-quitting-')
    quit = runtime.close()
    const attach = runtime.attachTerminal(shell(projectId))
    expect(await attach).toBeNull()
    expect(spawnRequested).not.toHaveBeenCalled()
    await quit
  })
})
