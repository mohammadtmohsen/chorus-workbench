/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponse } from '../../shared/ipc.js'
import type { ProjectLayoutSlice } from '../../shared/workspace-layout.js'
import { holdShellCloses, requestShellClose, type ShellRef } from './project-shell-closes.js'
import { detachedSnapshot, EMPTY_WORKSPACE, mergeSlice, sliceOf } from './workspace/layout.js'
import { useWorkspaceStore } from './workspace/store.js'

type Chorus = typeof window.chorus

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const IDLE: IpcResponse<'terminal:describe'> = {
  running: true,
  foreground: 'zsh',
  busy: false,
  exitCode: null,
}

const TWO = [{ id: 'main' }, { id: 's2' }]

const describeTerminal = vi.fn<Chorus['describeTerminal']>()
const killTerminal = vi.fn<Chorus['killTerminal']>()

const shell = (projectId: string, id: string): ShellRef => ({ scope: 'shell', projectId, id })

const remove = (projectId: string, id: string): void => {
  useWorkspaceStore.getState().removeProjectShell(projectId, id)
}

const drained = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

beforeEach(() => {
  describeTerminal.mockReset()
  killTerminal.mockReset()
  describeTerminal.mockResolvedValue(IDLE)
  killTerminal.mockResolvedValue({ ok: true })
  const bridge: Partial<Chorus> = { describeTerminal, killTerminal }
  Object.assign(window, { chorus: bridge })
  useWorkspaceStore.setState({ projectTerminals: { p1: { width: 960, shells: TWO } } })
})

async function sliceAfterClose(kill: Promise<{ ok: true }>): Promise<ProjectLayoutSlice> {
  killTerminal.mockImplementationOnce(() => kill)
  expect(requestShellClose(shell('p1', 's2'), 'Shell 2', remove)).toBe(true)
  await drained()
  const release = await holdShellCloses('p1')
  try {
    return sliceOf(useWorkspaceStore.getState(), 'p1')
  } finally {
    release()
  }
}

describe('handing a project to another window', () => {
  it('captures the detached slice only once an authorized close has landed', async () => {
    const kill = deferred<{ ok: true }>()
    const moving = sliceAfterClose(kill.promise)
    await drained()
    expect(requestShellClose(shell('p1', 'main'), 'Shell 1', remove)).toBe(false)

    kill.resolve({ ok: true })
    const slice = await moving

    expect(slice.projectTerminal?.shells).toEqual([{ id: 'main' }])
    expect(detachedSnapshot('p1', slice).projectTerminals['p1']?.shells).toEqual([{ id: 'main' }])
    expect(killTerminal).toHaveBeenCalledTimes(1)
  })

  it('returns the project without the closed shell, over the stale copy main held', async () => {
    const kill = deferred<{ ok: true }>()
    const moving = sliceAfterClose(kill.promise)
    kill.resolve({ ok: true })
    const slice = await moving

    const stale = { ...EMPTY_WORKSPACE, projectTerminals: { p1: { width: 960, shells: TWO } } }
    expect(mergeSlice(stale, 'p1', slice).projectTerminals['p1']?.shells).toEqual([{ id: 'main' }])
  })

  it('carries a shell whose kill failed, since it is still running', async () => {
    const kill = deferred<{ ok: true }>()
    const moving = sliceAfterClose(kill.promise)
    await drained()
    kill.reject(new Error('kill failed'))

    expect((await moving).projectTerminal?.shells).toEqual(TWO)
  })

  it('refuses closes only for the project being moved, and only while it moves', async () => {
    const release = await holdShellCloses('p1')
    expect(requestShellClose(shell('p1', 's2'), 'Shell 2', remove)).toBe(false)
    expect(requestShellClose(shell('p2', 's2'), 'Shell 2', remove)).toBe(true)
    release()
    expect(requestShellClose(shell('p1', 's2'), 'Shell 2', remove)).toBe(true)
    await drained()

    expect(killTerminal.mock.calls).toEqual([
      [{ ref: shell('p2', 's2') }],
      [{ ref: shell('p1', 's2') }],
    ])
    expect(useWorkspaceStore.getState().projectTerminals['p1']?.shells).toEqual([{ id: 'main' }])
  })
})
