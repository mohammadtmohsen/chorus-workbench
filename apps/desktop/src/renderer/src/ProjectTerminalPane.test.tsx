/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponse, TerminalRefShape } from '../../shared/ipc.js'
import type { RunState } from '../../shared/run-ipc.js'
import { holdShellCloses } from './project-shell-closes.js'
import { ProjectTerminalPane } from './ProjectTerminalPane.js'

const { terms, FakeTerminal, FakeFit } = vi.hoisted(() => {
  const terms: FakeTerminal[] = []

  class FakeTerminal {
    readonly cols = 80
    readonly rows = 24
    readonly options: Record<string, unknown> = {}
    readonly written: string[] = []
    disposed = false
    focuses = 0

    constructor() {
      terms.push(this)
    }

    write(data: string): void {
      this.written.push(data)
    }

    dispose(): void {
      this.disposed = true
    }

    focus(): void {
      this.focuses += 1
    }

    readonly reset = (): void => undefined
    readonly clear = (): void => undefined
    readonly loadAddon = (): void => undefined
    readonly open = (): void => undefined
    readonly attachCustomKeyEventHandler = (): void => undefined
    readonly onData = (): { dispose: () => void } => ({ dispose: () => undefined })
    readonly onResize = (): { dispose: () => void } => ({ dispose: () => undefined })
  }

  class FakeFit {
    readonly fit = (): void => undefined
  }

  return { terms, FakeTerminal, FakeFit }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFit }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

class FakeObserver {
  readonly observe = (): void => undefined
  readonly disconnect = (): void => undefined
}

type Chorus = typeof window.chorus
type Described = IpcResponse<'terminal:describe'>
type PaneProps = React.ComponentProps<typeof ProjectTerminalPane>

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

const DEV = { id: 'script:dev', label: 'dev', command: 'npm run dev' }

const OUTPUT = 'Metro waiting on exp://192.168.1.23:8081\r\n'

const IDLE: Described = { running: true, foreground: 'zsh', busy: false, exitCode: null }
const BUSY: Described = { running: true, foreground: 'npm', busy: true, exitCode: null }

const MAIN = [{ id: 'main' }]
const TWO = [{ id: 'main' }, { id: 's2' }]

const run = (process: RunState['process']): RunState => ({
  process,
  cleanupPending: false,
  commands: null,
  available: true,
})

const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true as const })
const attachTerminal = vi.fn<Chorus['attachTerminal']>()
const detachTerminal = vi.fn<Chorus['detachTerminal']>(ok)
const killTerminal = vi.fn<Chorus['killTerminal']>(ok)
const disposeTerminal = vi.fn<Chorus['disposeTerminal']>(ok)
const describeTerminal = vi.fn<Chorus['describeTerminal']>()
const stopRun = vi.fn<Chorus['stopRun']>()
const addShell = vi.fn<PaneProps['onAddShell']>()
const removeShell = vi.fn<PaneProps['onRemoveShell']>()
const reveal = vi.fn<PaneProps['onReveal']>()

let epoch = 0

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver)
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    configurable: true,
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  epoch = 0
  terms.length = 0
  for (const spy of [
    attachTerminal,
    detachTerminal,
    killTerminal,
    disposeTerminal,
    describeTerminal,
    stopRun,
    addShell,
    removeShell,
    reveal,
  ]) {
    spy.mockReset()
  }
  detachTerminal.mockImplementation(ok)
  killTerminal.mockImplementation(ok)
  disposeTerminal.mockImplementation(ok)
  describeTerminal.mockResolvedValue(IDLE)
  attachTerminal.mockImplementation(() => {
    epoch += 1
    const opened: IpcResponse<'terminal:attach'> = {
      epoch,
      generation: 1,
      snapshot: OUTPUT,
      seq: 0,
      cols: 80,
      rows: 24,
      exitCode: null,
    }
    return Promise.resolve(opened)
  })
  const bridge: Partial<Chorus> = {
    attachTerminal,
    detachTerminal,
    killTerminal,
    disposeTerminal,
    describeTerminal,
    stopRun,
    ackTerminal: ok,
    onTerminalOutput: () => () => undefined,
    setWorkbenchVisible: () => Promise.resolve({ ok: true as const, stills: [] }),
  }
  Object.assign(window, { chorus: bridge })
})

afterEach(() => {
  cleanup()
})

const refOf = (projectId: string): TerminalRefShape => ({ scope: 'project', projectId, id: 'run' })

const shellOf = (projectId: string, id: string): TerminalRefShape => ({
  scope: 'shell',
  projectId,
  id,
})

const attachedRefs = (): TerminalRefShape[] =>
  attachTerminal.mock.calls.map(([request]) => request.ref)

const settle = async (): Promise<void> => {
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
  )
}

const pane = (over: Partial<PaneProps> = {}, key = 'p1'): React.JSX.Element => (
  <ProjectTerminalPane
    key={key}
    projectId="p1"
    run={run({ kind: 'idle' })}
    shells={MAIN}
    onAddShell={addShell}
    onRemoveShell={removeShell}
    onReveal={reveal}
    {...over}
  />
)

const closeButtons = (container: HTMLElement): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('.project-terminal-slot-close'),
]

const closeAt = (container: HTMLElement, index: number): void => {
  const button = closeButtons(container)[index]
  if (button === undefined) throw new Error(`no close button at ${String(index)}`)
  fireEvent.click(button)
}

describe('the run slot', () => {
  it('points to Run before anything has run, and opens no run terminal', async () => {
    const { container } = render(pane())
    await settle()
    expect(container.querySelector('.project-terminal-empty')?.textContent).toBe('runPane.empty')
    expect(container.querySelector('.project-terminal-state')?.textContent).toBe('run.notStarted')
    expect(attachedRefs()).not.toContainEqual(refOf('p1'))
  })

  it('draws the screen main kept for a run that already exited', async () => {
    const { container } = render(
      pane({ run: run({ kind: 'exited', token: 1, active: DEV, code: 1 }) })
    )
    await settle()
    expect(attachTerminal).toHaveBeenCalledWith({ ref: refOf('p1'), cols: 80, rows: 24 })
    expect(terms[0]?.written).toContain(OUTPUT)
    expect(container.querySelector('.project-terminal-empty')).toBeNull()
    expect(container.querySelector('.project-terminal-state')?.textContent).toBe('run.exited')
  })

  it('keeps the run’s view and output when it exits, beside an untouched shell', async () => {
    const { container, rerender } = render(
      pane({ run: run({ kind: 'running', token: 1, active: DEV, pgid: 7 }) })
    )
    await settle()
    rerender(pane({ run: run({ kind: 'exited', token: 1, active: DEV, code: 130 }) }))
    await settle()

    expect(attachedRefs()).toEqual([refOf('p1'), shellOf('p1', 'main')])
    expect(terms).toHaveLength(2)
    expect(terms.map((term) => term.disposed)).toEqual([false, false])
    expect(terms[0]?.written).toEqual([OUTPUT])
    expect(detachTerminal).not.toHaveBeenCalled()
    expect(container.querySelector('.project-terminal-state')?.textContent).toBe('run.exited')
  })
})

describe('project shells', () => {
  it('opens a writable shell before any run, without taking the focus', async () => {
    render(pane())
    await settle()
    expect(attachedRefs()).toEqual([shellOf('p1', 'main')])
    expect(terms[0]?.focuses).toBe(0)
  })

  it('keeps the managed run apart from a shell persisted under the id run', async () => {
    const { container } = render(
      pane({
        run: run({ kind: 'running', token: 1, active: DEV, pgid: 7 }),
        shells: [{ id: 'run' }],
      })
    )
    await settle()
    expect(attachedRefs()).toEqual([refOf('p1'), shellOf('p1', 'run')])
    expect(container.querySelectorAll('.project-terminal-slot')).toHaveLength(2)
    const floored = [...container.querySelectorAll('.project-terminal-slot--run')]
    expect(floored.map((slot) => slot.getAttribute('data-shell-id'))).toEqual([null])
  })

  it('splits again and again, focusing and revealing only each new shell', async () => {
    addShell.mockReturnValueOnce('s2').mockReturnValueOnce('s3')
    const { getByRole, rerender } = render(pane())
    await settle()

    fireEvent.click(getByRole('button', { name: 'runPane.split' }))
    rerender(pane({ shells: TWO }))
    await settle()
    fireEvent.click(getByRole('button', { name: 'runPane.split' }))
    rerender(pane({ shells: [...TWO, { id: 's3' }] }))
    await settle()

    expect(addShell.mock.calls).toEqual([['p1'], ['p1']])
    expect(attachedRefs()).toEqual([
      shellOf('p1', 'main'),
      shellOf('p1', 's2'),
      shellOf('p1', 's3'),
    ])
    expect(terms.map((term) => term.disposed)).toEqual([false, false, false])
    expect(detachTerminal).not.toHaveBeenCalled()
    expect(terms.map((term) => term.focuses)).toEqual([0, 1, 1])
    expect(reveal.mock.calls.map(([slot]) => slot.dataset['shellId'])).toEqual(['s2', 's3'])
  })

  it('offers no close on the last shell', async () => {
    const { container, rerender } = render(pane())
    await settle()
    expect(closeButtons(container)).toHaveLength(0)
    rerender(pane({ shells: TWO }))
    expect(closeButtons(container)).toHaveLength(2)
  })

  it('never carries one project’s terminals into another', async () => {
    const running = run({ kind: 'running', token: 1, active: DEV, pgid: 7 })
    const { rerender } = render(pane({ run: running }))
    await settle()
    rerender(pane({ projectId: 'p2', run: running }, 'p2'))
    await settle()

    expect(attachedRefs()).toEqual([
      refOf('p1'),
      shellOf('p1', 'main'),
      refOf('p2'),
      shellOf('p2', 'main'),
    ])
    expect(detachTerminal).toHaveBeenCalledWith({ ref: refOf('p1'), epoch: 1 })
    expect(detachTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 'main'), epoch: 2 })
  })

  it('only lets go of the views when it goes away, and never stops or kills anything', async () => {
    const running = run({ kind: 'running', token: 1, active: DEV, pgid: 7 })
    const { unmount } = render(pane({ run: running }))
    await settle()
    unmount()

    expect(detachTerminal).toHaveBeenCalledWith({ ref: refOf('p1'), epoch: 1 })
    expect(detachTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 'main'), epoch: 2 })
    expect(killTerminal).not.toHaveBeenCalled()
    expect(disposeTerminal).not.toHaveBeenCalled()
    expect(stopRun).not.toHaveBeenCalled()
  })
})

describe('closing a shell', () => {
  it('kills an idle shell at once, and forgets it only once the kill succeeded', async () => {
    const kill = deferred<{ ok: true }>()
    killTerminal.mockImplementationOnce(() => kill.promise)
    const { container } = render(pane({ shells: TWO }))
    await settle()

    closeAt(container, 1)
    await settle()
    expect(describeTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 's2') })
    expect(killTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 's2') })
    expect(removeShell).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    kill.resolve({ ok: true })
    await settle()
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })

  it('asks before killing a busy shell, and kills only on confirm', async () => {
    describeTerminal.mockResolvedValueOnce(BUSY)
    const { container, getByRole } = render(pane({ shells: TWO }))
    await settle()

    closeAt(container, 1)
    await settle()
    expect(getByRole('dialog')).not.toBeNull()
    expect(killTerminal).not.toHaveBeenCalled()

    fireEvent.click(getByRole('button', { name: 'terminal.confirmKill' }))
    await settle()
    expect(killTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 's2') })
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })

  it('asks when main cannot say, and a cancel leaves the shell closable later', async () => {
    describeTerminal.mockRejectedValueOnce(new Error('no answer'))
    const { container, getByRole, queryByRole } = render(pane({ shells: TWO }))
    await settle()

    closeAt(container, 1)
    await settle()
    fireEvent.click(getByRole('button', { name: 'terminal.confirmKillCancel' }))
    await settle()
    expect(queryByRole('dialog')).toBeNull()
    expect(killTerminal).not.toHaveBeenCalled()

    closeAt(container, 1)
    await settle()
    expect(describeTerminal).toHaveBeenCalledTimes(2)
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })

  it('keeps a shell whose kill failed, and lets it be closed again', async () => {
    killTerminal.mockRejectedValueOnce(new Error('kill failed'))
    const { container } = render(pane({ shells: TWO }))
    await settle()

    closeAt(container, 1)
    await settle()
    expect(removeShell).not.toHaveBeenCalled()
    expect(closeButtons(container)).toHaveLength(2)

    closeAt(container, 1)
    await settle()
    expect(killTerminal).toHaveBeenCalledTimes(2)
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })

  it('never kills both of the last two shells when their closes overlap', async () => {
    const asked = deferred<Described>()
    describeTerminal.mockImplementationOnce(() => asked.promise)
    const { container } = render(pane({ shells: TWO }))
    await settle()

    closeAt(container, 0)
    closeAt(container, 1)
    asked.resolve(IDLE)
    await settle()

    expect(describeTerminal).toHaveBeenCalledTimes(1)
    expect(killTerminal.mock.calls).toEqual([[{ ref: shellOf('p1', 'main') }]])
    expect(removeShell.mock.calls).toEqual([['p1', 'main']])
  })

  it('finishes an allowed close after the pane went away, for its own project', async () => {
    const asked = deferred<Described>()
    describeTerminal.mockImplementationOnce(() => asked.promise)
    const { container, unmount } = render(pane({ shells: TWO }))
    await settle()

    closeAt(container, 1)
    unmount()
    asked.resolve(IDLE)
    await settle()

    expect(killTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 's2') })
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })
})

describe('a shell while it is being closed', () => {
  const surfaceOf = (container: HTMLElement, id: string): Element | null =>
    container.querySelector(`[data-shell-id="${id}"] .terminal-surface`)

  it('is never attached again, even after a remount, and goes once the kill answers', async () => {
    const kill = deferred<{ ok: true }>()
    killTerminal.mockImplementationOnce(() => kill.promise)
    let view = render(pane({ shells: TWO }))
    await settle()
    closeAt(view.container, 1)
    await settle()
    expect(killTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 's2') })
    expect(detachTerminal).toHaveBeenCalledWith({ ref: shellOf('p1', 's2'), epoch: 2 })
    expect(surfaceOf(view.container, 's2')).toBeNull()

    view.unmount()
    view = render(pane({ shells: TWO }))
    await settle()
    expect(surfaceOf(view.container, 's2')).toBeNull()
    expect(surfaceOf(view.container, 'main')).not.toBeNull()
    expect(closeButtons(view.container)).toHaveLength(2)

    removeShell.mockImplementation((projectId, id) => {
      view.rerender(pane({ projectId, shells: TWO.filter((shell) => shell.id !== id) }))
    })
    kill.resolve({ ok: true })
    await settle()

    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
    expect(attachedRefs()).toEqual([
      shellOf('p1', 'main'),
      shellOf('p1', 's2'),
      shellOf('p1', 'main'),
    ])
    expect(view.container.querySelector('[data-shell-id="s2"]')).toBeNull()
    expect(terms.at(-1)?.disposed).toBe(false)
  })

  it('attaches to the session main kept when the kill fails', async () => {
    killTerminal.mockRejectedValueOnce(new Error('kill failed'))
    const { container } = render(pane({ shells: TWO }))
    await settle()
    closeAt(container, 1)
    await settle()

    expect(removeShell).not.toHaveBeenCalled()
    expect(attachedRefs()).toEqual([
      shellOf('p1', 'main'),
      shellOf('p1', 's2'),
      shellOf('p1', 's2'),
    ])
    expect(surfaceOf(container, 's2')).not.toBeNull()
  })

  it('attaches to the session main kept when the close is cancelled', async () => {
    describeTerminal.mockResolvedValueOnce(BUSY)
    const { container, getByRole } = render(pane({ shells: TWO }))
    await settle()
    closeAt(container, 1)
    await settle()
    expect(surfaceOf(container, 's2')).toBeNull()

    fireEvent.click(getByRole('button', { name: 'terminal.confirmKillCancel' }))
    await settle()
    expect(killTerminal).not.toHaveBeenCalled()
    expect(attachedRefs()).toEqual([
      shellOf('p1', 'main'),
      shellOf('p1', 's2'),
      shellOf('p1', 's2'),
    ])
    expect(surfaceOf(container, 's2')).not.toBeNull()
  })
})

describe('who owns a close', () => {
  it('keeps a close across a remount, so the other last shell cannot be closed too', async () => {
    const asked = deferred<Described>()
    describeTerminal.mockImplementationOnce(() => asked.promise)
    const first = render(pane({ shells: TWO }))
    await settle()
    closeAt(first.container, 0)
    first.unmount()

    const second = render(pane({ shells: TWO }))
    await settle()
    expect(closeButtons(second.container).map((button) => button.disabled)).toEqual([true, true])
    closeAt(second.container, 1)
    asked.resolve(IDLE)
    await settle()

    expect(describeTerminal).toHaveBeenCalledTimes(1)
    expect(killTerminal.mock.calls).toEqual([[{ ref: shellOf('p1', 'main') }]])
    expect(removeShell.mock.calls).toEqual([['p1', 'main']])
  })

  it('never lets a second close replace an open question, and frees it on cancel', async () => {
    const asked = deferred<Described>()
    describeTerminal.mockImplementationOnce(() => asked.promise)
    const { container, getByRole, queryByRole } = render(pane({ shells: [...TWO, { id: 's3' }] }))
    await settle()

    closeAt(container, 1)
    closeAt(container, 2)
    asked.resolve(BUSY)
    await settle()
    expect(describeTerminal).toHaveBeenCalledTimes(1)
    fireEvent.click(getByRole('button', { name: 'terminal.confirmKillCancel' }))
    await settle()
    expect(queryByRole('dialog')).toBeNull()

    closeAt(container, 2)
    await settle()
    expect(killTerminal.mock.calls).toEqual([[{ ref: shellOf('p1', 's3') }]])
    expect(removeShell.mock.calls).toEqual([['p1', 's3']])
  })

  it('drops a busy answer that arrives after the pane is gone, and stays closable', async () => {
    const asked = deferred<Described>()
    describeTerminal.mockImplementationOnce(() => asked.promise)
    const first = render(pane({ shells: TWO }))
    await settle()
    closeAt(first.container, 1)
    first.unmount()
    asked.resolve(BUSY)
    await settle()
    expect(killTerminal).not.toHaveBeenCalled()

    const second = render(pane({ shells: TWO }))
    await settle()
    expect(second.queryByRole('dialog')).toBeNull()
    closeAt(second.container, 1)
    await settle()
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })

  it('drops an open question when the project moves, blocking closes and splits', async () => {
    describeTerminal.mockResolvedValueOnce(BUSY)
    const { container, getByRole, queryByRole } = render(pane({ shells: TWO }))
    await settle()
    closeAt(container, 1)
    await settle()
    expect(getByRole('dialog')).not.toBeNull()

    let release = (): void => undefined
    await act(async () => {
      release = await holdShellCloses('p1')
    })
    expect(queryByRole('dialog')).toBeNull()
    const split = container.querySelector<HTMLButtonElement>('.conversation-dock-add')
    expect(split?.disabled).toBe(true)
    closeAt(container, 1)
    await settle()
    expect(describeTerminal).toHaveBeenCalledTimes(1)
    expect(killTerminal).not.toHaveBeenCalled()

    act(() => {
      release()
    })
    closeAt(container, 1)
    await settle()
    expect(removeShell.mock.calls).toEqual([['p1', 's2']])
  })

  it('keeps one project’s close from blocking another’s', async () => {
    const asked = deferred<Described>()
    describeTerminal.mockImplementationOnce(() => asked.promise)
    const one = render(pane({ shells: TWO }))
    const two = render(pane({ projectId: 'p2', shells: TWO }, 'p2'))
    await settle()

    closeAt(one.container, 1)
    closeAt(two.container, 1)
    await settle()
    expect(killTerminal.mock.calls).toEqual([[{ ref: shellOf('p2', 's2') }]])

    asked.resolve(IDLE)
    await settle()
    expect(removeShell.mock.calls).toEqual([
      ['p2', 's2'],
      ['p1', 's2'],
    ])
  })
})
