import {
  CONFORMANCE_CHECKS,
  CONFORMANCE_OPTS,
  collectEvents,
  type ConformanceTarget,
} from '@chorus/agent-protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification.js'
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification.js'
import type { CommandExecutionOutputDeltaNotification } from './generated/v2/CommandExecutionOutputDeltaNotification.js'
import type { ErrorNotification } from './generated/v2/ErrorNotification.js'
import type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.js'
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification.js'
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification.js'
import type { ReasoningSummaryTextDeltaNotification } from './generated/v2/ReasoningSummaryTextDeltaNotification.js'
import type { ReasoningTextDeltaNotification } from './generated/v2/ReasoningTextDeltaNotification.js'
import type { ThreadItem } from './generated/v2/ThreadItem.js'
import type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification.js'
import type { Turn } from './generated/v2/Turn.js'
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification.js'
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification.js'
import type { WarningNotification } from './generated/v2/WarningNotification.js'
import type { Transport } from './transport.js'

/**
 * The shared conformance suite, run against the real `CodexAdapter` over a fake
 * transport.
 *
 * With this, all three implementations — `FakeAdapter`, `ClaudeAdapter` and
 * `CodexAdapter` — run the same assertions. That is what makes the
 * `AgentAdapter` port a contract rather than a shape (plan §8), and it is the
 * half that was missing when M3 first landed.
 */

interface Wire {
  /** Push a server notification, as the app-server would. */
  notify: (method: string, params: unknown) => void
  /** Push a server-initiated request (an approval). */
  request: (id: number, method: string, params: unknown) => void
  /** Ends the connection without a clean close — a dead app-server. */
  kill: () => void
  sent: Record<string, unknown>[]
}

/**
 * Answers the handshake and `thread/start` the way the real server does, so the
 * adapter under test is exercised rather than stubbed out.
 */
function fakeTransport(): { transport: Transport; wire: Wire } {
  let onLine: ((line: string) => void) | null = null
  let onClose: ((i: { code: number | null; signal: string | null }) => void) | null = null
  const sent: Record<string, unknown>[] = []

  const deliver = (message: unknown): void => {
    onLine?.(JSON.stringify(message))
  }

  const transport: Transport = {
    send: (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      sent.push(msg)
      const id = msg['id']
      if (typeof id !== 'number') return

      const reply = (result: unknown): void => {
        queueMicrotask(() => {
          deliver({ id, result })
        })
      }

      switch (msg['method']) {
        case 'initialize':
          reply({ userAgent: 'fake' })
          break
        case 'thread/start':
          reply({ thread: { id: 'thr_conformance' }, model: 'fake-model' })
          break
        case 'thread/resume':
          reply({ thread: { id: 'thr_conformance' } })
          break
        default:
          reply({})
      }
    },
    onLine: (h) => {
      onLine = h
    },
    onClose: (h) => {
      onClose = h
    },
    onStderr: () => undefined,
    close: () => {
      onClose?.({ code: 0, signal: null })
    },
  }

  return {
    transport,
    wire: {
      notify: (method, params) => {
        deliver({ method, params })
      },
      request: (id, method, params) => {
        deliver({ id, method, params })
      },
      kill: () => {
        onClose?.({ code: 137, signal: 'SIGKILL' })
      },
      sent,
    },
  }
}

function codexTarget(): ConformanceTarget & { wire: () => Wire } {
  const wires: Wire[] = []
  const adapter = new CodexAdapter({
    now: () => 1_000,
    createTransport: () => {
      const { transport, wire } = fakeTransport()
      wires.push(wire)
      return transport
    },
  })

  const latest = (): Wire => {
    const w = wires.at(-1)
    if (w === undefined) throw new Error('no transport created')
    return w
  }

  return {
    adapter,
    wire: latest,
    emitMessage: (_session, text) => {
      latest().notify('item/agentMessage/delta', { itemId: 'm1', delta: text })
    },
    killProvider: () => {
      latest().kill()
    },
  }
}

// A real adapter needs a directory that exists; several validate it.
const OPTS = { ...CONFORMANCE_OPTS, cwd: mkdtempSync(join(tmpdir(), 'chorus-conformance-')) }
describe('conformance: CodexAdapter', () => {
  it('declares its capabilities', () => {
    expect(CONFORMANCE_CHECKS.declaresCapabilities(codexTarget().adapter)).toBeNull()
  })

  it('backs every declared capability with a method', () => {
    expect(CONFORMANCE_CHECKS.backsCapabilitiesWithMethods(codexTarget().adapter)).toBeNull()
  })

  it('exposes a resumable session reference', async () => {
    const session = await codexTarget().adapter.start(OPTS)
    expect(CONFORMANCE_CHECKS.exposesSessionRef(session)).toBeNull()
    expect(session.sessionRef).toBe('thr_conformance')
  })

  it('emits events with monotonic seq and its own agent id', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    for (const text of ['a', 'b', 'c']) await target.emitMessage(session, text)
    await target.killProvider(session)

    const events = await collectEvents(session, 10)
    expect(events.length).toBeGreaterThan(0)
    expect(CONFORMANCE_CHECKS.monotonicSeq(events)).toBeNull()
    expect(CONFORMANCE_CHECKS.stampsAgentId(target.adapter, events)).toBeNull()
  })

  it('ends its event stream when the provider dies', async () => {
    // The M2 bug in its original form: JsonRpcClient failed its promises but
    // nothing closed the session stream, so the supervisor never restarted it.
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    await target.emitMessage(session, 'before the crash')
    await target.killProvider(session)

    for await (const _event of session.events) {
      // Drains to completion; a stream that never ends hangs, which vitest
      // reports as a timeout.
    }
    expect(CONFORMANCE_CHECKS.endsStreamWhenProviderDies(true)).toBeNull()
  })

  it('resumes onto the same provider reference', async () => {
    const target = codexTarget()
    const first = await target.adapter.start(OPTS)
    const resumed = await target.adapter.resume(first.sessionRef, OPTS)
    expect(resumed.sessionRef).toBe(first.sessionRef)
  })

  it('completes the handshake before starting a thread', async () => {
    // The server rejects everything sent before `initialized` (plan §2.1).
    const target = codexTarget()
    await target.adapter.start(OPTS)
    const methods = target.wire().sent.map((m) => m['method'])
    expect(methods.slice(0, 3)).toEqual(['initialize', 'initialized', 'thread/start'])
  })

  it('sends the sandbox as the kebab-case string enum thread/start accepts', async () => {
    const target = codexTarget()
    await target.adapter.start(OPTS)
    const start = target.wire().sent.find((m) => m['method'] === 'thread/start')
    expect((start?.['params'] as { sandbox?: unknown }).sandbox).toBe('read-only')
  })

  it('surfaces an approval request as an event', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    target.wire().request(99, 'item/commandExecution/requestApproval', {
      itemId: 'i1',
      command: 'git status',
      cwd: '/repo',
    })

    const events = await collectEvents(session, 1)
    expect(events[0]).toMatchObject({
      type: 'approval.requested',
      request: { kind: 'command', command: ['git status'] },
    })
  })

  it('answers the pending approval request on the wire', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    target.wire().request(99, 'item/commandExecution/requestApproval', { itemId: 'i1' })

    const [event] = await collectEvents(session, 1)
    if (event?.type !== 'approval.requested') throw new Error('expected an approval')
    await session.respondToApproval(event.request.id, { outcome: 'allow', scope: 'session' })

    await new Promise((r) => setTimeout(r, 0))
    const reply = target.wire().sent.find((m) => m['id'] === 99 && m['result'] !== undefined)
    expect(reply?.['result']).toEqual({ decision: 'acceptForSession' })
  })
})

describe('turn boundaries: CodexAdapter', () => {
  const delta = (turnId: string) => ({
    threadId: 'thr_conformance',
    turnId,
    itemId: 'm1',
    delta: 'hi',
  })

  it('opens the turn its server never announced', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    target.wire().notify('item/agentMessage/delta', delta('t1'))
    target.wire().notify('turn/completed', { turn: { id: 't1', status: 'completed' } })

    const events = await collectEvents(session, 3)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'message.delta',
      'turn.completed',
    ])
    expect(events[0]).toMatchObject({ type: 'turn.started', turnRef: 't1' })
  })

  it('does not reopen a turn for a straggler from the turn that just completed', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    target.wire().notify('turn/started', { turn: { id: 't1' } })
    target.wire().notify('turn/completed', { turn: { id: 't1', status: 'completed' } })
    target.wire().notify('item/agentMessage/delta', delta('t1'))

    const events = await collectEvents(session, 3)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'turn.completed',
      'message.delta',
    ])
  })

  it('absorbs the real start of a turn it already opened', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)

    target.wire().notify('item/agentMessage/delta', delta('t2'))
    target.wire().notify('turn/started', { turn: { id: 't2' } })
    target.wire().notify('turn/completed', { turn: { id: 't2', status: 'completed' } })

    const events = await collectEvents(session, 3)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'message.delta',
      'turn.completed',
    ])
  })
})

describe('native subagents: CodexAdapter', () => {
  const parent = 'thr_conformance'
  const parentTurn = 'turn_parent'
  const worker = (n: number): string => `thr_worker_${String(n)}`
  const workerTurn = (n: number): string => `turn_worker_${String(n)}`
  const tokens = {
    totalTokens: 1_500,
    inputTokens: 1_200,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 300,
    reasoningOutputTokens: 0,
  }

  const turn = (id: string, status: Turn['status']): Turn => ({
    id,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: null,
    startedAt: 1_759_000_000,
    completedAt: status === 'inProgress' ? null : 1_759_000_060,
    durationMs: status === 'inProgress' ? null : 60_000,
  })
  const turnStarted = (threadId: string, id: string): TurnStartedNotification => ({
    threadId,
    turn: turn(id, 'inProgress'),
  })
  const turnCompleted = (threadId: string, id: string): TurnCompletedNotification => ({
    threadId,
    turn: turn(id, 'completed'),
  })
  const messageDelta = (threadId: string, turnId: string): AgentMessageDeltaNotification => ({
    threadId,
    turnId,
    itemId: `msg_${threadId}`,
    delta: 'working',
  })
  const itemStarted = (
    threadId: string,
    turnId: string,
    item: ThreadItem
  ): ItemStartedNotification => ({ item, threadId, turnId, startedAtMs: 1_000 })
  const itemCompleted = (
    threadId: string,
    turnId: string,
    item: ThreadItem
  ): ItemCompletedNotification => ({ item, threadId, turnId, completedAtMs: 1_000 })
  const agentMessage = (id: string): ThreadItem => ({
    type: 'agentMessage',
    id,
    text: 'done',
    phase: null,
    memoryCitation: null,
  })
  const command = (id: string, status: 'inProgress' | 'completed'): ThreadItem => ({
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: 'pnpm test',
    cwd: '/repo',
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: status === 'completed' ? 'ok\n' : null,
    exitCode: status === 'completed' ? 0 : null,
    durationMs: status === 'completed' ? 1_200 : null,
  })
  const work = (threadId: string, turnId: string): [string, unknown][] => [
    [
      'item/reasoning/summaryTextDelta',
      {
        threadId,
        turnId,
        itemId: `rs_${threadId}`,
        delta: 'planning',
        summaryIndex: 0,
      } satisfies ReasoningSummaryTextDeltaNotification,
    ],
    [
      'item/reasoning/textDelta',
      {
        threadId,
        turnId,
        itemId: `rs_${threadId}`,
        delta: 'reading',
        contentIndex: 0,
      } satisfies ReasoningTextDeltaNotification,
    ],
    ['item/started', itemStarted(threadId, turnId, command(`cmd_${threadId}`, 'inProgress'))],
    [
      'item/commandExecution/outputDelta',
      {
        threadId,
        turnId,
        itemId: `cmd_${threadId}`,
        delta: 'ok\n',
      } satisfies CommandExecutionOutputDeltaNotification,
    ],
    ['item/completed', itemCompleted(threadId, turnId, command(`cmd_${threadId}`, 'completed'))],
    ['item/agentMessage/delta', messageDelta(threadId, turnId)],
    ['item/completed', itemCompleted(threadId, turnId, agentMessage(`msg_${threadId}`))],
    [
      'error',
      {
        error: { message: 'stream disconnected', codexErrorInfo: null, additionalDetails: null },
        willRetry: true,
        threadId,
        turnId,
      } satisfies ErrorNotification,
    ],
    [
      'thread/tokenUsage/updated',
      {
        threadId,
        turnId,
        tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258_400 },
      } satisfies ThreadTokenUsageUpdatedNotification,
    ],
    ['warning', { threadId, message: 'tool is slow' } satisfies WarningNotification],
  ]

  it('reports one main turn while three workers start and finish inside it', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()

    wire.notify('turn/started', turnStarted(parent, parentTurn))
    wire.notify('turn/started', turnStarted(worker(1), workerTurn(1)))
    wire.notify('turn/started', turnStarted(worker(2), workerTurn(2)))
    wire.notify('item/agentMessage/delta', messageDelta(worker(1), workerTurn(1)))
    wire.notify('turn/started', turnStarted(worker(3), workerTurn(3)))
    wire.notify(
      'item/completed',
      itemCompleted(worker(2), workerTurn(2), agentMessage(`msg_${worker(2)}`))
    )
    wire.notify('turn/completed', turnCompleted(worker(1), workerTurn(1)))
    wire.notify('item/agentMessage/delta', messageDelta(parent, parentTurn))
    wire.notify(
      'item/started',
      itemStarted(worker(3), workerTurn(3), command(`cmd_${worker(3)}`, 'inProgress'))
    )
    wire.notify('turn/completed', turnCompleted(worker(2), workerTurn(2)))
    wire.notify('turn/completed', turnCompleted(worker(3), workerTurn(3)))
    wire.notify('item/completed', itemCompleted(parent, parentTurn, agentMessage(`msg_${parent}`)))
    wire.notify('turn/completed', turnCompleted(parent, parentTurn))
    await target.killProvider(session)

    const events = await collectEvents(session, 100)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'message.delta',
      'message.completed',
      'turn.completed',
    ])
    expect(events[0]).toMatchObject({ type: 'turn.started', turnRef: parentTurn })
    expect(events[3]).toMatchObject({
      type: 'turn.completed',
      turnRef: parentTurn,
      status: 'completed',
    })
  })

  it('interrupts the main agent turn, not the turn of the newest worker', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()

    wire.notify('turn/started', turnStarted(parent, parentTurn))
    wire.notify('turn/started', turnStarted(worker(1), workerTurn(1)))
    wire.notify('item/agentMessage/delta', messageDelta(worker(1), workerTurn(1)))
    wire.notify('turn/started', turnStarted(worker(2), workerTurn(2)))
    await session.interrupt()

    const interrupts = wire.sent.filter((m) => m['method'] === 'turn/interrupt')
    expect(interrupts.map((m) => m['params'])).toEqual([{ threadId: parent, turnId: parentTurn }])
  })

  it('emits nothing for the output of a worker thread', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()

    wire.notify('turn/started', turnStarted(parent, parentTurn))
    for (const [method, params] of work(worker(1), workerTurn(1))) {
      wire.notify(method, params)
    }
    wire.notify('turn/completed', turnCompleted(parent, parentTurn))
    await target.killProvider(session)

    const events = await collectEvents(session, 100)
    expect(events.map((event) => event.type)).toEqual(['turn.started', 'turn.completed'])
  })

  it('still maps the same output when the main agent sends it on its own thread', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()

    wire.notify('turn/started', turnStarted(parent, parentTurn))
    for (const [method, params] of work(parent, parentTurn)) {
      wire.notify(method, params)
    }
    wire.notify('turn/completed', turnCompleted(parent, parentTurn))
    await target.killProvider(session)

    const events = await collectEvents(session, 100)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'reasoning.delta',
      'reasoning.delta',
      'command.started',
      'command.output',
      'command.completed',
      'message.delta',
      'message.completed',
      'error',
      'usage.updated',
      'error',
      'turn.completed',
    ])
  })

  it('still reports account limits and warnings that belong to no thread', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()

    wire.notify('turn/started', turnStarted(parent, parentTurn))
    wire.notify('turn/started', turnStarted(worker(1), workerTurn(1)))
    wire.notify('item/agentMessage/delta', messageDelta(worker(1), workerTurn(1)))
    wire.notify('turn/completed', turnCompleted(worker(1), workerTurn(1)))
    wire.notify('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_759_018_000 },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: null,
        rateLimitReachedType: null,
      },
    } satisfies AccountRateLimitsUpdatedNotification)
    wire.notify('warning', {
      threadId: null,
      message: 'config key is deprecated',
    } satisfies WarningNotification)
    wire.notify('turn/completed', turnCompleted(parent, parentTurn))
    await target.killProvider(session)

    const events = await collectEvents(session, 100)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'limits',
      'error',
      'turn.completed',
    ])
    expect(events[1]).toMatchObject({
      type: 'limits',
      windows: [{ id: '300m', usedPercent: 42, windowMinutes: 300 }],
    })
    expect(events[2]).toMatchObject({
      type: 'error',
      message: 'config key is deprecated',
      recoverable: true,
    })
  })

  it('opens the main agent turn from its own work, never from a worker item', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()

    wire.notify(
      'item/started',
      itemStarted(worker(1), workerTurn(1), command(`cmd_${worker(1)}`, 'inProgress'))
    )
    wire.notify('item/agentMessage/delta', messageDelta(worker(1), workerTurn(1)))
    wire.notify('item/started', itemStarted(parent, parentTurn, command('cmd_main', 'inProgress')))
    wire.notify('turn/completed', turnCompleted(parent, parentTurn))
    await target.killProvider(session)

    const events = await collectEvents(session, 100)
    expect(events.map((event) => event.type)).toEqual([
      'turn.started',
      'command.started',
      'turn.completed',
    ])
    expect(events[0]).toMatchObject({ type: 'turn.started', turnRef: parentTurn })
    expect(events[1]).toMatchObject({ type: 'command.started', itemRef: 'cmd_main' })
  })

  it('keeps a worker file change on hand for the approval card that names it', async () => {
    const target = codexTarget()
    const session = await target.adapter.start(OPTS)
    const wire = target.wire()
    const diff = '@@ -1 +1 @@\n-old\n+new\n'

    wire.notify(
      'item/started',
      itemStarted(worker(1), workerTurn(1), {
        type: 'fileChange',
        id: 'fc_worker',
        changes: [{ path: 'src/worker.ts', kind: { type: 'update', move_path: null }, diff }],
        status: 'inProgress',
      })
    )
    wire.request(99, 'item/fileChange/requestApproval', {
      threadId: worker(1),
      turnId: workerTurn(1),
      itemId: 'fc_worker',
      startedAtMs: 1_000,
    } satisfies FileChangeRequestApprovalParams)

    const [event] = await collectEvents(session, 1)
    expect(event).toMatchObject({
      type: 'approval.requested',
      request: {
        id: 'fc_worker',
        kind: 'fileChange',
        files: [{ path: 'src/worker.ts', patch: diff }],
      },
    })
  })
})
