import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_PROGRESS_REPORTER,
  type ProgressReport,
  type ProgressReporter,
  type SessionOpts,
} from '@chorus/agent-protocol'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import { mapNotification, usageBlockOf } from './mapping.js'
import type { Transport } from './transport.js'

const CWD = mkdtempSync(join(tmpdir(), 'chorus-progress-tool-'))
const BASE: SessionOpts = {
  cwd: CWD,
  sandbox: { mode: 'workspaceWrite', writableRoots: [CWD], networkAccess: false },
}
const READ_ONLY: SessionOpts = {
  cwd: CWD,
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
  toolPolicy: 'readOnly',
}

type Message = Record<string, unknown>

interface Connection {
  readonly sent: Message[]
  push: (message: Message) => void
}

function fakeCodex(): { adapter: CodexAdapter; connections: Connection[] } {
  const connections: Connection[] = []
  const createTransport = (): Transport => {
    let onLine: ((line: string) => void) | null = null
    const connection: Connection = {
      sent: [],
      push: (message) => {
        onLine?.(JSON.stringify(message))
      },
    }
    connections.push(connection)
    return {
      send: (line) => {
        const message = JSON.parse(line) as Message
        connection.sent.push(message)
        const id = message['id']
        const method = message['method']
        if (typeof id !== 'number' || typeof method !== 'string') return
        const params = (message['params'] ?? {}) as Message
        const result =
          method === 'thread/start'
            ? { thread: { id: 'thr_new' } }
            : method === 'thread/resume'
              ? { thread: { id: params['threadId'] } }
              : method === 'config/read'
                ? { config: {} }
                : {}
        queueMicrotask(() => {
          onLine?.(JSON.stringify({ id, result }))
        })
      },
      onLine: (handler) => {
        onLine = handler
      },
      onClose: () => undefined,
      onStderr: () => undefined,
      close: () => undefined,
    }
  }
  return { adapter: new CodexAdapter({ now: () => 1_000, createTransport }), connections }
}

const requests = (connection: Connection | undefined, method: string): Message[] =>
  (connection?.sent ?? [])
    .filter((message) => message['method'] === method)
    .map((message) => (message['params'] ?? {}) as Message)

const namespaces = (connection: Connection | undefined): unknown[] =>
  ((requests(connection, 'thread/start')[0]?.['dynamicTools'] ?? []) as Message[]).map(
    (tool) => tool['name']
  )

const recording =
  (seen: ProgressReport[]): ProgressReporter =>
  (report) => {
    seen.push(report)
    return { ok: true, text: 'recorded' }
  }

describe('registering report_progress', () => {
  it('adds the chorus_progress namespace when the session has a reporter', async () => {
    const { adapter, connections } = fakeCodex()
    await adapter.start({ ...BASE, progress: recording([]) })
    expect(namespaces(connections[0])).toEqual(['chorus_progress'])
    const tools = (requests(connections[0], 'thread/start')[0]?.['dynamicTools'] as Message[])[0]
    expect((tools?.['tools'] as Message[]).map((tool) => tool['name'])).toEqual(['report_progress'])
  })

  it('leaves it out without a reporter and from a discussion session', async () => {
    const plain = fakeCodex()
    await plain.adapter.start(BASE)
    expect(requests(plain.connections[0], 'thread/start')[0]).not.toHaveProperty('dynamicTools')

    const discussion = fakeCodex()
    await discussion.adapter.start({ ...READ_ONLY, progress: recording([]) })
    expect(namespaces(discussion.connections[0])).not.toContain('chorus_progress')
  })
})

describe('answering a report_progress call', () => {
  const call = async (
    progress: ProgressReporter | undefined,
    params: Message
  ): Promise<Message> => {
    const { adapter, connections } = fakeCodex()
    await adapter.start(progress === undefined ? BASE : { ...BASE, progress })
    const connection = connections[0]
    if (connection === undefined) throw new Error('no connection')
    connection.push({ id: 9_201, method: 'item/tool/call', params })
    return vi.waitFor(() => {
      const reply = connection.sent.find(
        (message) => message['id'] === 9_201 && message['method'] === undefined
      )
      if (reply === undefined) throw new Error('not answered yet')
      return reply
    })
  }

  const valid = {
    threadId: 'thr_new',
    turnId: 'turn_1',
    callId: 'call_1',
    namespace: 'chorus_progress',
    tool: 'report_progress',
    arguments: {
      steps: [{ id: 'a', label: '1', title: 'Persist the task', status: 'active' }],
    },
  }

  it('records a valid plan through the session reporter', async () => {
    const seen: ProgressReport[] = []
    const reply = await call(recording(seen), valid)
    expect(reply['result']).toEqual({
      contentItems: [{ type: 'inputText', text: 'recorded' }],
      success: true,
    })
    expect(seen[0]?.steps[0]).toMatchObject({ id: 'a', label: '1' })
  })

  it('refuses a call that names another thread, without recording', async () => {
    const seen: ProgressReport[] = []
    const reply = await call(recording(seen), { ...valid, threadId: 'thr_other' })
    expect((reply['result'] as Message)['success']).toBe(false)
    expect(seen).toEqual([])
  })

  it('refuses an invalid plan, without recording', async () => {
    const seen: ProgressReport[] = []
    const reply = await call(recording(seen), {
      ...valid,
      arguments: { steps: [{ id: 'a', title: 'A', status: 'pending', parentId: 'missing' }] },
    })
    expect((reply['result'] as Message)['success']).toBe(false)
    expect(seen).toEqual([])
  })

  it('answers plainly when this session has no reporter', async () => {
    const reply = await call(undefined, valid)
    expect(reply['result']).toEqual({
      contentItems: [{ type: 'inputText', text: NO_PROGRESS_REPORTER }],
      success: false,
    })
  })
})

describe('the native plan as a fallback', () => {
  const ctx = { seq: 1, now: 1_000, approvalTtlMs: 60_000 }

  it('reads turn/plan/updated in the shape the protocol defines', () => {
    const event = mapNotification(
      {
        method: 'turn/plan/updated',
        params: {
          threadId: 'thr_new',
          turnId: 'turn_1',
          explanation: null,
          plan: [
            { step: 'Read the protocol', status: 'completed' },
            { step: 'Map the plan', status: 'inProgress' },
            { step: 'Write a test', status: 'pending' },
          ],
        },
      },
      ctx
    )
    expect(event).toMatchObject({
      type: 'plan.updated',
      steps: [
        { text: 'Read the protocol', done: true, active: false },
        { text: 'Map the plan', done: false, active: true },
        { text: 'Write a test', done: false, active: false },
      ],
    })
  })
})

describe('a usage limit', () => {
  const failure = (codexErrorInfo: unknown) => ({
    message: 'You have hit your usage limit',
    codexErrorInfo,
    additionalDetails: null,
  })

  it('is read from a final error and from a failed turn, and nothing else', () => {
    expect(
      usageBlockOf('error', { error: failure('usageLimitExceeded'), willRetry: false })
    ).toEqual({ resetsAt: null })
    expect(
      usageBlockOf('turn/completed', {
        threadId: 'thr_new',
        turn: { id: 'turn_1', status: 'failed', error: failure('usageLimitExceeded') },
      })
    ).toEqual({ resetsAt: null })
    const retrying = { error: failure('usageLimitExceeded'), willRetry: true }
    expect(usageBlockOf('error', retrying)).toBeNull()
    const overloaded = { error: failure('serverOverloaded'), willRetry: false }
    expect(usageBlockOf('error', overloaded)).toBeNull()
    expect(usageBlockOf('account/rateLimits/updated', { rateLimits: {} })).toBeNull()
  })
})
