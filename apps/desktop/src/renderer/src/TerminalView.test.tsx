/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponse, TerminalPush, TerminalRefShape } from '../../shared/ipc.js'
import { TerminalView } from './TerminalView.js'

const { terms, links, FakeTerminal, FakeFit, FakeLinks } = vi.hoisted(() => {
  const RESET = '\x1bc'
  const terms: FakeTerminal[] = []
  const links: FakeLinks[] = []

  type Open = (event: MouseEvent, uri: string) => void

  class FakeTerminal {
    readonly cols = 80
    readonly rows = 24
    readonly options: Record<string, unknown> = {}
    readonly queue: { readonly data: string; readonly done: (() => void) | undefined }[] = []
    screen = ''
    disposed = false

    constructor(readonly init: { readonly linkHandler?: { readonly activate: Open } } = {}) {
      terms.push(this)
    }

    write(data: string, done?: () => void): void {
      this.queue.push({ data, done })
    }

    flush(): void {
      for (const { data, done } of this.queue.splice(0)) {
        const at = data.lastIndexOf(RESET)
        this.screen = at === -1 ? `${this.screen}${data}` : data.slice(at + RESET.length)
        done?.()
      }
    }

    reset(): void {
      this.screen = ''
    }

    clear(): void {
      this.screen = ''
    }

    dispose(): void {
      this.disposed = true
    }

    readonly loadAddon = (): void => undefined
    readonly open = (): void => undefined
    readonly focus = (): void => undefined
    readonly attachCustomKeyEventHandler = (): void => undefined
    readonly onData = (): { dispose: () => void } => ({ dispose: () => undefined })
    readonly onResize = (): { dispose: () => void } => ({ dispose: () => undefined })
  }

  class FakeFit {
    readonly fit = (): void => undefined
  }

  class FakeLinks {
    constructor(readonly open: Open) {
      links.push(this)
    }
  }

  return { terms, links, FakeTerminal, FakeFit, FakeLinks }
})

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFit }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: FakeLinks }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

class FakeObserver {
  readonly observe = (): void => undefined
  readonly disconnect = (): void => undefined
}

type Chorus = typeof window.chorus
type Opened = IpcResponse<'terminal:attach'>

const RUN: TerminalRefShape = { scope: 'project', projectId: 'p1', id: 'run' }
const OTHER_RUN: TerminalRefShape = { scope: 'project', projectId: 'p2', id: 'run' }

const attaches: ((opened: Opened) => void)[] = []
const asked: TerminalRefShape[] = []
let listener: ((push: TerminalPush) => void) | null = null

const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true as const })
const detachTerminal = vi.fn<Chorus['detachTerminal']>(ok)
const killTerminal = vi.fn<Chorus['killTerminal']>(ok)
const disposeTerminal = vi.fn<Chorus['disposeTerminal']>(ok)

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
  terms.length = 0
  links.length = 0
  attaches.length = 0
  asked.length = 0
  listener = null
  detachTerminal.mockClear()
  killTerminal.mockClear()
  disposeTerminal.mockClear()
  const bridge: Partial<Chorus> = {
    attachTerminal: (request) => {
      asked.push(request.ref)
      return new Promise<Opened>((resolve) => {
        attaches.push(resolve)
      })
    },
    detachTerminal,
    killTerminal,
    disposeTerminal,
    ackTerminal: ok,
    onTerminalOutput: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  Object.assign(window, { chorus: bridge })
})

afterEach(() => {
  cleanup()
})

const opened = (generation: number, epoch: number, snapshot: string): NonNullable<Opened> => ({
  epoch,
  generation,
  snapshot,
  seq: 0,
  cols: 80,
  rows: 24,
  exitCode: null,
})

const answer = async (index: number, value: Opened): Promise<void> => {
  const resolve = attaches[index]
  if (resolve === undefined) throw new Error(`attach ${String(index)} was never asked for`)
  resolve(value)
  await act(() => Promise.resolve())
}

const emit = (push: TerminalPush): void => {
  listener?.(push)
}

const term = (): InstanceType<typeof FakeTerminal> => {
  const current = terms.at(-1)
  if (current === undefined) throw new Error('no terminal was opened')
  return current
}

const queuedText = (): string =>
  term()
    .queue.map((write) => write.data)
    .join('')

const drawn = (): string => {
  term().flush()
  return term().screen
}

describe('a project run view across a replacement', () => {
  it('clears the old run’s queued screen and output before drawing the new one', async () => {
    render(<TerminalView terminal={RUN} label="Run" />)
    await answer(0, opened(1, 1, 'old screen'))
    emit({ kind: 'data', ref: RUN, epoch: 1, generation: 1, seq: 1, data: ' old output' })
    expect(queuedText()).toBe('old screen old output')

    emit({ kind: 'replaced', ref: RUN, generation: 2 })
    await answer(1, opened(2, 2, 'new screen'))

    expect(drawn()).toBe('new screen')
    expect(detachTerminal).toHaveBeenCalledWith({ ref: RUN, epoch: 1 })
  })

  it('clears the not-started notice once a run begins', async () => {
    render(<TerminalView terminal={RUN} label="Run" />)
    await answer(0, null)
    expect(queuedText()).toContain('terminal.notStarted')

    emit({ kind: 'replaced', ref: RUN, generation: 1 })
    await answer(1, opened(1, 1, 'first run'))

    expect(drawn()).toBe('first run')
  })

  it('discards an attach the replacement overtook, and releases it', async () => {
    render(<TerminalView terminal={RUN} label="Run" />)
    emit({ kind: 'replaced', ref: RUN, generation: 2 })
    await answer(0, opened(1, 1, 'old screen'))
    await answer(1, opened(2, 2, 'new screen'))

    expect(drawn()).toBe('new screen')
    expect(detachTerminal).toHaveBeenCalledTimes(1)
    expect(detachTerminal).toHaveBeenCalledWith({ ref: RUN, epoch: 1 })
  })

  it('ignores another project’s replacement and one it has already drawn', async () => {
    render(<TerminalView terminal={RUN} label="Run" />)
    await answer(0, opened(1, 1, 'mine'))

    emit({ kind: 'replaced', ref: OTHER_RUN, generation: 2 })
    emit({ kind: 'replaced', ref: RUN, generation: 1 })

    expect(attaches).toHaveLength(1)
    expect(drawn()).toBe('mine')
    expect(detachTerminal).not.toHaveBeenCalled()
  })
})

describe('a project run view going away', () => {
  it('detaches on unmount and never kills the run', async () => {
    const { unmount } = render(<TerminalView terminal={RUN} label="Run" />)
    await answer(0, opened(1, 5, 'running'))

    unmount()

    expect(detachTerminal).toHaveBeenCalledWith({ ref: RUN, epoch: 5 })
    expect(killTerminal).not.toHaveBeenCalled()
    expect(disposeTerminal).not.toHaveBeenCalled()
    expect(term().disposed).toBe(true)
  })

  it('releases an attach that lands after it unmounted, without killing', async () => {
    const { unmount } = render(<TerminalView terminal={RUN} label="Run" />)
    unmount()
    await answer(0, opened(1, 3, 'late'))

    expect(detachTerminal).toHaveBeenCalledWith({ ref: RUN, epoch: 3 })
    expect(killTerminal).not.toHaveBeenCalled()
    expect(disposeTerminal).not.toHaveBeenCalled()
    expect(queuedText()).toBe('')
  })
})

describe('a project shell view', () => {
  const SHELL: TerminalRefShape = { scope: 'shell', projectId: 'p1', id: 'main' }

  const output = (ref: TerminalRefShape, data: string): TerminalPush => ({
    kind: 'data',
    ref,
    epoch: 4,
    generation: 0,
    seq: 1,
    data,
  })

  it('attaches, draws and detaches under its exact ref, never a global one', async () => {
    const { unmount } = render(<TerminalView terminal={SHELL} label="Shell" />)
    expect(asked).toEqual([SHELL])
    await answer(0, opened(0, 4, 'prompt$ '))

    emit(output({ scope: 'global', id: 'main' }, 'global'))
    emit(output({ scope: 'shell', projectId: 'p2', id: 'main' }, 'other project'))
    emit(output(RUN, 'run'))
    emit(output(SHELL, 'ls'))
    expect(drawn()).toBe('prompt$ ls')

    unmount()
    expect(detachTerminal).toHaveBeenCalledWith({ ref: SHELL, epoch: 4 })
    expect(killTerminal).not.toHaveBeenCalled()
    expect(disposeTerminal).not.toHaveBeenCalled()
  })

  it('says it could not open, rather than that nothing has started', async () => {
    render(<TerminalView terminal={SHELL} label="Shell" />)
    await answer(0, null)
    expect(queuedText()).toContain('terminal.openFailed')
    expect(queuedText()).not.toContain('terminal.notStarted')
  })
})

describe('links in a terminal', () => {
  const SHELL: TerminalRefShape = { scope: 'shell', projectId: 'p1', id: 'main' }
  const click = new MouseEvent('click')

  const opened = (follow: () => void): unknown[][] => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    try {
      follow()
      return open.mock.calls.map((call) => [...call])
    } finally {
      open.mockRestore()
    }
  }

  const detected = (): ((event: MouseEvent, uri: string) => void) => {
    const addon = links.at(-1)
    if (addon === undefined) throw new Error('no link addon was loaded')
    return addon.open
  }

  it('opens a detected address through the new-window route main sends to the browser', () => {
    render(<TerminalView terminal={SHELL} label="Shell" />)
    const follow = detected()

    expect(
      opened(() => {
        follow(click, 'http://localhost:30010')
        follow(click, 'http://192.168.1.15:30010')
        follow(click, 'https://expo.dev/accounts')
      })
    ).toEqual([
      ['http://localhost:30010', '_blank', 'noopener,noreferrer'],
      ['http://192.168.1.15:30010', '_blank', 'noopener,noreferrer'],
      ['https://expo.dev/accounts', '_blank', 'noopener,noreferrer'],
    ])
  })

  it('sends an explicit OSC 8 link the same way, and never a script or a file', () => {
    render(<TerminalView terminal={SHELL} label="Shell" />)
    const activate = term().init.linkHandler?.activate
    if (activate === undefined) throw new Error('no link handler was configured')

    expect(
      opened(() => {
        activate(click, 'https://nextjs.org/docs')
        activate(click, 'javascript:alert(1)')
        detected()(click, 'file:///etc/passwd')
      })
    ).toEqual([['https://nextjs.org/docs', '_blank', 'noopener,noreferrer']])
  })
})
