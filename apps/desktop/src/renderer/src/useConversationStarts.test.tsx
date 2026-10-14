/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcRequest, IpcResponse } from '../../shared/ipc.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'
import type { SessionInfo } from './Session.js'
import { useConversationStarts, type StartOptions } from './useConversationStarts.js'

type Begun = IpcResponse<'conversation:begin'>
type Outcome = IpcResponse<'conversation:awaitStart'>
type Active = IpcResponse<'conversation:active'>
type OpenSession = Active['sessions'][number]

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const { store } = vi.hoisted(() => {
  const detached: Record<string, unknown> = {}
  return {
    store: {
      detached,
      openProject: vi.fn(),
      adoptConversation: vi.fn(),
      replaceConversation: vi.fn(() => true),
      clearConversationUnread: vi.fn(),
      removeSession: vi.fn(),
      clearDetached: vi.fn(),
    },
  }
})

vi.mock('./workspace/store.js', () => ({
  useWorkspaceStore: { getState: () => store },
}))

const begins: { request: IpcRequest<'conversation:begin'>; answer: Deferred<Begun> }[] = []
const awaits = new Map<string, Deferred<Outcome>>()
const reads: Deferred<Active>[] = []
const closes = new Map<string, Deferred<void>>()
let announce: () => void = () => undefined

const chorus = {
  beginConversation: vi.fn((request: IpcRequest<'conversation:begin'>) => {
    const answer = deferred<Begun>()
    begins.push({ request, answer })
    return answer.promise
  }),
  awaitStart: vi.fn((request: IpcRequest<'conversation:awaitStart'>) => {
    const answer = deferred<Outcome>()
    awaits.set(request.conversationId, answer)
    return answer.promise
  }),
  readActiveSessions: vi.fn(() => {
    const answer = deferred<Active>()
    reads.push(answer)
    return answer.promise
  }),
  onConversationsChanged: vi.fn((listener: () => void) => {
    announce = listener
    return () => {
      announce = () => undefined
    }
  }),
}

const begun = (conversationId: string, projectId = 'p1'): Begun => ({
  conversationId,
  participants: [],
  profileId: 'read-only',
  projectId,
  cwd: `/tmp/${projectId}`,
  title: projectId,
})

const listed = (
  conversationId: string,
  projectId = 'p1',
  extra: Partial<OpenSession> = {}
): OpenSession => ({
  ...begun(conversationId, projectId),
  unread: 0,
  pendingApprovalIds: [],
  pendingQuestionIds: [],
  draft: '',
  planning: false,
  ...extra,
})

const ready = (conversationId: string, participants: Begun['participants']): Outcome => ({
  status: 'ready',
  conversation: { ...begun(conversationId), participants },
})

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

function harness(role: WindowRole = { kind: 'main' }, existing: SessionInfo[] = []) {
  const sessionsRef = { current: existing }
  const revision = { current: 0 }
  const closedIds = { current: new Set<string>() }
  const updateSessions = (change: (current: SessionInfo[]) => SessionInfo[]): void => {
    sessionsRef.current = change(sessionsRef.current)
    revision.current += 1
  }
  const finishEnd = vi.fn((conversationId: string): Promise<void> => {
    const cancelling = view.result.current.cancelRestartOf(conversationId)
    closedIds.current.add(conversationId)
    updateSessions((current) =>
      current.filter((session) => session.conversationId !== conversationId)
    )
    const closed: Deferred<void> = deferred()
    closes.set(conversationId, closed)
    const ended = Promise.all([cancelling, closed.promise]).then(() => undefined)
    void ended.catch(reportError)
    return ended
  })
  const reportError = vi.fn()
  const view = renderHook(() =>
    useConversationStarts({
      role,
      profileId: 'read-only',
      sessionsRef,
      revision,
      closedIds,
      updateSessions,
      finishEnd,
      refreshProjects: () => Promise.resolve([]),
      reportError,
      clearError: () => undefined,
      forgetDetached: () => undefined,
    })
  )
  const startIn = (projectId: string, options?: StartOptions): void => {
    act(() => {
      view.result.current.startIn(projectId, options)
    })
  }
  const session = (conversationId: string): SessionInfo | undefined =>
    sessionsRef.current.find((candidate) => candidate.conversationId === conversationId)
  const elsewhere = (change: (current: SessionInfo[]) => SessionInfo[]): void => {
    act(() => {
      updateSessions(change)
    })
  }
  return { view, sessionsRef, closedIds, finishEnd, reportError, startIn, session, elsewhere }
}

const answerBegin = async (index: number, conversationId: string, projectId = 'p1') => {
  begins[index]?.answer.resolve(begun(conversationId, projectId))
  await settle()
}

const answerStart = async (conversationId: string, outcome: Outcome) => {
  awaits.get(conversationId)?.resolve(outcome)
  await settle()
}

beforeEach(() => {
  begins.length = 0
  awaits.clear()
  reads.length = 0
  closes.clear()
  store.detached = {}
  vi.clearAllMocks()
  Object.assign(window, { chorus })
})

afterEach(() => {
  cleanup()
})

describe('opening a chat', () => {
  it('shows it as soon as main answers, before any agent is ready', async () => {
    const h = harness()
    h.startIn('p1')

    expect(chorus.beginConversation).toHaveBeenCalledWith({
      projectId: 'p1',
      profileId: 'read-only',
    })
    expect(h.view.result.current.starting).toBe(true)

    await answerBegin(0, 'c1')
    expect(h.session('c1')).toMatchObject({ participants: [], starting: true })
    expect(store.openProject).toHaveBeenCalledWith('p1')
    expect(store.adoptConversation).toHaveBeenCalledWith('p1', 'c1')
    expect(chorus.awaitStart).toHaveBeenCalledWith({ conversationId: 'c1' })
    expect(h.view.result.current.starting).toBe(true)

    await answerStart('c1', ready('c1', ['claude', 'codex']))
    expect(h.session('c1')).toMatchObject({ participants: ['claude', 'codex'], starting: false })
    expect(h.view.result.current.starting).toBe(false)
  })

  it('marks it ready without replacing any other chat', async () => {
    const other: SessionInfo = { ...begun('c0'), participants: ['claude'] }
    const h = harness({ kind: 'main' }, [other])
    h.startIn('p1')
    await answerBegin(0, 'c1')
    await answerStart('c1', ready('c1', ['claude']))

    expect(h.sessionsRef.current[0]).toBe(other)
    expect(h.session('c1')?.starting).toBe(false)
  })

  it('keeps a ready answer that beat the begin reply', async () => {
    const h = harness()
    h.startIn('p1')
    act(() => {
      announce()
    })
    reads[0]?.resolve({ sessions: [listed('c1', 'p1', { participants: ['claude'] })] })
    await settle()
    expect(h.session('c1')).toBeUndefined()
    expect(reads).toHaveLength(1)

    await answerBegin(0, 'c1')
    reads.at(-1)?.resolve({ sessions: [listed('c1', 'p1', { participants: ['claude'] })] })
    await settle()

    expect(h.session('c1')).toMatchObject({ participants: ['claude'] })
    expect(h.session('c1')?.starting).not.toBe(true)
    expect(store.adoptConversation).toHaveBeenCalledTimes(1)
    expect(store.adoptConversation).toHaveBeenCalledWith('p1', 'c1')
  })

  it('reads again after a refused begin that held a snapshot back', async () => {
    const h = harness()
    h.startIn('p1')
    act(() => {
      announce()
    })
    reads[0]?.resolve({ sessions: [listed('h1', 'p1', { participants: ['claude'] })] })
    await settle()
    expect(h.session('h1')).toBeUndefined()
    expect(reads).toHaveLength(1)

    begins[0]?.answer.reject(new Error('That project folder is missing'))
    await settle()
    expect(reads).toHaveLength(2)

    reads[1]?.resolve({ sessions: [listed('h1', 'p1', { participants: ['claude'] })] })
    await settle()
    expect(h.session('h1')).toMatchObject({ participants: ['claude'] })
  })

  it('keeps two gestures independent, and counts both', async () => {
    const h = harness()
    h.startIn('p1')
    h.startIn('p1')
    expect(chorus.beginConversation).toHaveBeenCalledTimes(2)

    await answerBegin(0, 'c1')
    await answerBegin(1, 'c2')
    await answerStart('c1', ready('c1', ['claude']))
    expect(h.view.result.current.starting).toBe(true)

    await answerStart('c2', ready('c2', ['claude']))
    expect(h.view.result.current.starting).toBe(false)
    expect(h.session('c1')).toBeDefined()
    expect(h.session('c2')).toBeDefined()
  })

  it('reports a refused begin and stops counting it', async () => {
    const h = harness()
    h.startIn('p1')
    begins[0]?.answer.reject(new Error('That project folder is missing'))
    await settle()

    expect(h.reportError).toHaveBeenCalledWith(new Error('That project folder is missing'))
    expect(h.view.result.current.starting).toBe(false)
    expect(h.sessionsRef.current).toEqual([])
  })

  it('removes a failed chat and reports why', async () => {
    const h = harness()
    h.startIn('p1')
    await answerBegin(0, 'c1')
    await answerStart('c1', { status: 'failed', message: 'claude fell over' })

    expect(h.session('c1')).toBeUndefined()
    expect(store.removeSession).toHaveBeenCalledWith('c1')
    expect(h.reportError).toHaveBeenCalledWith(new Error('claude fell over'))
    expect(h.view.result.current.starting).toBe(false)
  })

  it('carries a forwarded chat and leaves its source open', async () => {
    const source: SessionInfo = begun('s1')
    const h = harness({ kind: 'main' }, [source])
    h.startIn('p1', { continueFrom: 's1' })

    expect(chorus.beginConversation).toHaveBeenCalledWith({
      projectId: 'p1',
      profileId: 'read-only',
      continueFrom: 's1',
    })
    await answerBegin(0, 'c1')
    expect(store.adoptConversation).toHaveBeenCalledWith('p1', 'c1')
    await answerStart('c1', ready('c1', ['claude']))
    expect(h.finishEnd).not.toHaveBeenCalled()
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(h.session('s1')).toBe(source)
  })
})

describe('restarting a chat', () => {
  it('ends the source only once the replacement is ready', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    expect(h.finishEnd).not.toHaveBeenCalled()

    await answerStart('c1', ready('c1', ['claude']))
    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).toHaveBeenCalledWith('s1')
  })

  it('keeps the source in its box while booting, then swaps into that same box', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')

    expect(h.session('s1')).toBeDefined()
    expect(h.session('c1')?.starting).toBe(true)
    expect(store.openProject).not.toHaveBeenCalled()
    expect(store.adoptConversation).not.toHaveBeenCalled()
    expect(store.replaceConversation).not.toHaveBeenCalled()

    await answerStart('c1', ready('c1', ['claude']))
    expect(store.replaceConversation).toHaveBeenCalledTimes(1)
    expect(store.replaceConversation).toHaveBeenCalledWith('p1', 's1', 'c1')
    expect(store.adoptConversation).not.toHaveBeenCalled()
    expect(store.openProject).not.toHaveBeenCalled()
    const swapped = store.replaceConversation.mock.invocationCallOrder.at(0) ?? 0
    const ended = h.finishEnd.mock.invocationCallOrder.at(0) ?? 0
    expect(swapped).toBeGreaterThan(0)
    expect(swapped).toBeLessThan(ended)
    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).not.toHaveBeenCalledWith('c1')
    expect(h.session('c1')).toMatchObject({ participants: ['claude'], starting: false })
    expect(h.session('s1')).toBeUndefined()
  })

  it('gives the replacement a box of its own when the source had none', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    store.replaceConversation.mockReturnValueOnce(false)
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    await answerStart('c1', ready('c1', ['claude']))

    expect(store.adoptConversation).toHaveBeenCalledWith('p1', 'c1')
    expect(h.finishEnd).toHaveBeenCalledWith('s1')
  })

  it('leaves placement to the detached window when the project is detached', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    store.detached = { p1: { paneId: 'pane-1', index: 0 } }
    store.replaceConversation.mockReturnValueOnce(false)
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    await answerStart('c1', ready('c1', ['claude']))

    expect(store.adoptConversation).not.toHaveBeenCalled()
    expect(h.finishEnd).toHaveBeenCalledWith('s1')
    expect(h.session('c1')?.starting).toBe(false)
  })

  it('keeps the source when the replacement fails', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    await answerStart('c1', { status: 'failed', message: 'claude fell over' })

    expect(h.finishEnd).not.toHaveBeenCalled()
    expect(h.session('s1')).toBeDefined()
    expect(h.session('c1')).toBeUndefined()
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(store.adoptConversation).not.toHaveBeenCalled()
  })

  it('closes the replacement when its start request is lost, and keeps the source', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    awaits.get('c1')?.reject(new Error('the window lost main'))
    await settle()

    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).toHaveBeenCalledWith('c1')
    expect(h.session('c1')).toBeUndefined()
    expect(h.session('s1')).toBeDefined()
    expect(h.reportError).toHaveBeenCalledWith(new Error('the window lost main'))
    expect(h.view.result.current.starting).toBe(false)

    h.startIn('p1', { replacing: 's1' })
    expect(chorus.beginConversation).toHaveBeenCalledTimes(2)
  })

  it('closes the replacement when the source was closed before the begin reply', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    act(() => {
      void h.finishEnd('s1')
    })
    h.finishEnd.mockClear()
    await answerBegin(0, 'c1')

    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).toHaveBeenCalledWith('c1')
    expect(chorus.awaitStart).not.toHaveBeenCalled()
    expect(store.adoptConversation).not.toHaveBeenCalled()
    expect(h.session('c1')).toBeUndefined()
    expect(h.view.result.current.starting).toBe(false)
  })

  it('closes the replacement as soon as its source closes, not when it is ready', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    let ended = false
    act(() => {
      void h.finishEnd('s1').then(() => {
        ended = true
      })
    })
    expect(h.finishEnd).toHaveBeenCalledWith('c1')
    expect(h.session('c1')).toBeUndefined()

    closes.get('s1')?.resolve()
    await settle()
    expect(ended).toBe(false)
    closes.get('c1')?.resolve()
    await settle()
    expect(ended).toBe(true)

    h.finishEnd.mockClear()
    await answerStart('c1', ready('c1', ['claude']))
    expect(h.finishEnd).not.toHaveBeenCalled()
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(store.adoptConversation).not.toHaveBeenCalled()

    act(() => {
      announce()
    })
    reads.at(-1)?.resolve({
      sessions: [
        listed('s1', 'p1', { participants: ['claude'] }),
        listed('c1', 'p1', { participants: ['claude'] }),
      ],
    })
    await settle()
    expect(h.session('s1')).toBeUndefined()
    expect(h.session('c1')).toBeUndefined()
  })

  it('holds a project move until an unanswered begin is closed, keeping the source', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    let moved = false
    void h.view.result.current.holdRestarts('p1').then(() => {
      moved = true
    })
    await settle()
    expect(moved).toBe(false)

    await answerBegin(0, 'c1')
    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).toHaveBeenCalledWith('c1')
    expect(chorus.awaitStart).not.toHaveBeenCalled()
    expect(moved).toBe(false)

    closes.get('c1')?.resolve()
    await settle()
    expect(moved).toBe(true)
    expect(h.session('s1')).toBeDefined()
    expect(h.session('c1')).toBeUndefined()
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(store.adoptConversation).not.toHaveBeenCalled()
  })

  it('holds a project move for the close, not the boot, and ignores late ready', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    let moved = false
    void h.view.result.current.holdRestarts('p1').then(() => {
      moved = true
    })
    expect(h.finishEnd).toHaveBeenCalledWith('c1')
    expect(h.session('c1')).toBeUndefined()

    closes.get('c1')?.resolve()
    await settle()
    expect(moved).toBe(true)

    await answerStart('c1', ready('c1', ['claude']))
    expect(h.finishEnd).not.toHaveBeenCalledWith('s1')
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(h.session('s1')).toBeDefined()
  })

  it('refuses a project move when the replacement will not close, then unlocks', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    let failure: unknown = null
    void h.view.result.current.holdRestarts('p1').then(
      () => undefined,
      (error: unknown) => {
        failure = error
      }
    )
    expect(h.finishEnd).toHaveBeenCalledWith('c1')

    closes.get('c1')?.reject(new Error('the agent would not stop'))
    await settle()
    expect(failure).toEqual(new Error('the agent would not stop'))
    expect(h.reportError).toHaveBeenCalledWith(new Error('the agent would not stop'))
    expect(h.session('s1')).toBeDefined()
    expect(h.finishEnd).not.toHaveBeenCalledWith('s1')

    await answerStart('c1', { status: 'cancelled' })
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(h.finishEnd).not.toHaveBeenCalledWith('s1')
    expect(h.session('s1')).toBeDefined()

    h.startIn('p1', { replacing: 's1' })
    expect(chorus.beginConversation).toHaveBeenCalledTimes(2)
  })

  it('keeps the source when a cancelled restart later fails', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    void h.view.result.current.holdRestarts('p1')
    await answerStart('c1', { status: 'failed', message: 'claude fell over' })

    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).toHaveBeenCalledWith('c1')
    expect(h.session('s1')).toBeDefined()
    expect(store.replaceConversation).not.toHaveBeenCalled()
  })

  it('cancels only pending restarts in the project that moves', async () => {
    const h = harness({ kind: 'main' }, [begun('s1'), begun('s2', 'p2')])
    h.startIn('p1', { replacing: 's1' })
    h.startIn('p2', { replacing: 's2' })
    h.startIn('p1')
    await answerBegin(0, 'c1')
    await answerBegin(1, 'c2', 'p2')
    await answerBegin(2, 'c3')

    void h.view.result.current.holdRestarts('p1')
    expect(h.finishEnd).toHaveBeenCalledTimes(1)
    expect(h.finishEnd).toHaveBeenCalledWith('c1')

    await answerStart('c2', ready('c2', ['claude']))
    expect(store.replaceConversation).toHaveBeenCalledWith('p2', 's2', 'c2')
    expect(h.finishEnd).toHaveBeenCalledWith('s2')

    await answerStart('c3', ready('c3', ['claude']))
    expect(store.adoptConversation).toHaveBeenCalledWith('p1', 'c3')
    expect(h.session('c3')?.starting).toBe(false)
    expect(h.session('s1')).toBeDefined()
  })

  it('ignores a restart asked for while its project is moving, and allows it after', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    let release = (): void => undefined
    await act(async () => {
      release = await h.view.result.current.holdRestarts('p1')
    })

    h.startIn('p1', { replacing: 's1' })
    expect(chorus.beginConversation).not.toHaveBeenCalled()
    h.startIn('p1')
    expect(chorus.beginConversation).toHaveBeenCalledTimes(1)

    release()
    h.startIn('p1', { replacing: 's1' })
    expect(chorus.beginConversation).toHaveBeenCalledTimes(2)
  })

  it('keeps the source when the replacement was closed or cancelled', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    await answerBegin(0, 'c1')
    act(() => {
      void h.finishEnd('c1')
    })
    h.finishEnd.mockClear()

    await answerStart('c1', ready('c1', ['claude']))
    expect(h.finishEnd).not.toHaveBeenCalled()

    h.startIn('p1', { replacing: 's1' })
    await answerBegin(1, 'c2')
    expect(h.session('c2')?.starting).toBe(true)
    await answerStart('c2', { status: 'cancelled' })
    expect(h.finishEnd).not.toHaveBeenCalled()
    expect(h.reportError).not.toHaveBeenCalled()
    expect(h.session('s1')).toBeDefined()
    expect(h.session('c2')).toBeUndefined()
    expect(store.removeSession).toHaveBeenCalledWith('c2')
    expect(store.replaceConversation).not.toHaveBeenCalled()
    expect(store.adoptConversation).not.toHaveBeenCalled()
  })

  it('ignores a second restart of the same source while one is pending', async () => {
    const h = harness({ kind: 'main' }, [begun('s1')])
    h.startIn('p1', { replacing: 's1' })
    h.startIn('p1', { replacing: 's1' })
    expect(chorus.beginConversation).toHaveBeenCalledTimes(1)

    await answerBegin(0, 'c1')
    await answerStart('c1', { status: 'failed', message: 'claude fell over' })
    h.startIn('p1', { replacing: 's1' })
    expect(chorus.beginConversation).toHaveBeenCalledTimes(2)
  })
})

describe('what other windows and late answers say', () => {
  it('does not bring back a chat closed before its begin reply arrived', async () => {
    const h = harness()
    h.startIn('p1')
    act(() => {
      announce()
    })
    reads[0]?.resolve({ sessions: [listed('c1', 'p1', { starting: true })] })
    await settle()
    expect(h.session('c1')).toBeUndefined()

    act(() => {
      void h.finishEnd('c1')
    })
    act(() => {
      announce()
    })
    reads[1]?.resolve({ sessions: [] })
    await settle()
    await answerBegin(0, 'c1')

    expect(h.session('c1')).toBeUndefined()
    expect(store.adoptConversation).not.toHaveBeenCalled()
    expect(chorus.awaitStart).not.toHaveBeenCalled()
    expect(h.view.result.current.starting).toBe(false)

    expect(reads).toHaveLength(3)
    reads[2]?.resolve({ sessions: [listed('c1', 'p1', { starting: true })] })
    await settle()
    expect(h.session('c1')).toBeUndefined()
  })

  it('gives a detached restart no second box when a snapshot beats begin', async () => {
    const source: SessionInfo = { ...begun('s1'), participants: ['claude'] }
    const h = harness({ kind: 'detached', projectId: 'p1' }, [source])
    const snapshot = {
      sessions: [
        listed('s1', 'p1', { participants: ['claude'] }),
        listed('c1', 'p1', { starting: true }),
      ],
    }
    h.startIn('p1', { replacing: 's1' })
    act(() => {
      announce()
    })
    reads[0]?.resolve(snapshot)
    await settle()
    expect(h.session('c1')).toBeUndefined()
    expect(store.adoptConversation).not.toHaveBeenCalled()

    await answerBegin(0, 'c1')
    reads.at(-1)?.resolve(snapshot)
    await settle()
    expect(h.session('c1')?.starting).toBe(true)
    expect(h.session('s1')).toBe(source)
    expect(store.adoptConversation).not.toHaveBeenCalled()

    await answerStart('c1', ready('c1', ['claude']))
    expect(store.replaceConversation).toHaveBeenCalledWith('p1', 's1', 'c1')
    expect(store.adoptConversation).not.toHaveBeenCalled()
    expect(h.finishEnd).toHaveBeenCalledWith('s1')
  })

  it('ignores a snapshot that answers after a newer one', async () => {
    const h = harness()
    act(() => {
      announce()
      announce()
    })
    reads[1]?.resolve({ sessions: [listed('c1')] })
    await settle()
    reads[0]?.resolve({ sessions: [] })
    await settle()

    expect(h.session('c1')).toBeDefined()
  })

  it('never turns a ready chat back into a starting one', async () => {
    const h = harness()
    h.startIn('p1')
    await answerBegin(0, 'c1')
    await answerStart('c1', ready('c1', ['claude']))
    const readyChat = h.session('c1')

    const stale = reads.at(0)
    stale?.resolve({ sessions: [listed('c1', 'p1', { starting: true })] })
    await settle()
    act(() => {
      announce()
    })
    reads.at(-1)?.resolve({ sessions: [listed('c1', 'p1', { starting: true })] })
    await settle()

    expect(h.session('c1')).toBe(readyChat)
    expect(readyChat?.starting).toBe(false)
  })

  it('updates a starting chat to ready from a snapshot, and leaves the rest alone', async () => {
    const other: SessionInfo = { ...begun('c0'), participants: ['claude'] }
    const h = harness({ kind: 'main' }, [other])
    h.startIn('p1')
    await answerBegin(0, 'c1')
    act(() => {
      announce()
    })
    reads.at(-1)?.resolve({
      sessions: [
        listed('c0', 'p1', { participants: ['claude'] }),
        listed('c1', 'p1', { participants: ['codex'] }),
      ],
    })
    await settle()

    expect(h.sessionsRef.current[0]).toBe(other)
    expect(h.session('c1')).toMatchObject({ participants: ['codex'], starting: false })
  })

  it('shows and adopts only its own project in a detached window', async () => {
    const h = harness({ kind: 'detached', projectId: 'p1' })
    act(() => {
      announce()
    })
    reads[0]?.resolve({
      sessions: [listed('a', 'p1', { starting: true }), listed('b', 'p2')],
    })
    await settle()

    expect(h.session('a')?.starting).toBe(true)
    expect(h.session('b')).toBeUndefined()
    expect(store.adoptConversation).toHaveBeenCalledWith('p1', 'a')
    expect(store.adoptConversation).not.toHaveBeenCalledWith('p2', 'b')
  })

  it('removes a chat main cancelled while it was still showing, and keeps it gone', async () => {
    const h = harness()
    h.startIn('p1')
    await answerBegin(0, 'c1')
    expect(h.session('c1')?.starting).toBe(true)
    const asked = reads.length

    await answerStart('c1', { status: 'cancelled' })
    expect(h.session('c1')).toBeUndefined()
    expect(store.removeSession).toHaveBeenCalledWith('c1')
    expect(h.reportError).not.toHaveBeenCalled()
    expect(h.finishEnd).not.toHaveBeenCalled()
    expect(reads.length).toBeGreaterThan(asked)

    reads[0]?.resolve({ sessions: [listed('c1', 'p1', { starting: true })] })
    await settle()
    reads.at(-1)?.resolve({ sessions: [listed('c1', 'p1', { starting: true })] })
    await settle()
    expect(h.session('c1')).toBeUndefined()
    expect(h.view.result.current.starting).toBe(false)
  })

  it('drops a read that began before App added a chat elsewhere, then reads again', async () => {
    const h = harness()
    act(() => {
      announce()
    })
    const reopened: SessionInfo = { ...begun('h1'), participants: ['claude'] }
    h.elsewhere((current) => [...current, reopened])

    reads[0]?.resolve({ sessions: [] })
    await settle()
    expect(h.session('h1')).toBe(reopened)
    expect(store.removeSession).not.toHaveBeenCalled()
    expect(reads).toHaveLength(2)

    reads[1]?.resolve({ sessions: [listed('h1', 'p1', { participants: ['claude'] })] })
    await settle()
    expect(h.session('h1')).toBe(reopened)
  })

  it('drops a read that began before App updated a chat elsewhere', async () => {
    const h = harness({ kind: 'main' }, [{ ...begun('s1'), participants: ['claude'] }])
    act(() => {
      announce()
    })
    h.elsewhere((current) => current.map((session) => ({ ...session, title: 'renamed' })))
    const renamed = h.session('s1')

    reads[0]?.resolve({ sessions: [listed('s1', 'p1', { participants: ['codex'] })] })
    await settle()
    expect(h.session('s1')).toBe(renamed)
    expect(renamed?.title).toBe('renamed')
    expect(reads).toHaveLength(2)
  })
})
