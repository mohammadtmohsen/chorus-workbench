import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSession } from './codex-adapter.js'
import { JsonRpcClient } from './rpc.js'
import type { Transport } from './transport.js'

interface Request {
  readonly id: number
  readonly method: string
  readonly params: Record<string, unknown>
}

const sessions: CodexSession[] = []

function connected(): {
  session: CodexSession
  sent: Request[]
  reply: (method: string, result: unknown) => void
  notify: (method: string, params: unknown) => void
} {
  let receive: (line: string) => void = () => undefined
  let closed: Transport['onClose'] extends (handler: infer Handler) => void
    ? Handler
    : never = () => undefined
  const sent: Request[] = []
  const transport: Transport = {
    send: (line) => {
      sent.push(JSON.parse(line) as Request)
    },
    onLine: (handler) => {
      receive = handler
    },
    onClose: (handler) => {
      closed = handler
    },
    onStderr: () => undefined,
    close: () => {
      closed({ code: 0, signal: null })
    },
  }
  const rpc = new JsonRpcClient({ transport })
  const session = new CodexSession('main-thread', rpc, 30_000, () => 0)
  sessions.push(session)
  return {
    session,
    sent,
    reply: (method, result) => {
      const request = sent.findLast((entry) => entry.method === method)
      if (request === undefined) throw new Error(`No ${method} request`)
      receive(JSON.stringify({ id: request.id, result }))
    },
    notify: (method, params) => {
      receive(JSON.stringify({ method, params }))
    },
  }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

describe('Codex live steering', () => {
  it('serializes admission and steers a correction into the accepted turn', async () => {
    const wire = connected()
    const first = wire.session.send({ text: 'Build the feature.' })
    const correction = wire.session.send({ text: 'Keep the change small.' })
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(1)
    })
    wire.reply('turn/start', { turn: { id: 'turn-1' } })
    await first
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(2)
    })
    expect(wire.sent[1]).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: 'main-thread',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'Keep the change small.', text_elements: [] }],
      },
    })
    wire.reply('turn/steer', { turnId: 'turn-1' })
    await correction
  })

  it('starts a fresh turn after completion instead of steering a stale id', async () => {
    const wire = connected()
    const first = wire.session.send({ text: 'First task.' })
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(1)
    })
    wire.reply('turn/start', { turn: { id: 'turn-1' } })
    await first
    wire.notify('turn/completed', {
      threadId: 'main-thread',
      turn: { id: 'turn-1', status: 'completed' },
    })
    const next = wire.session.send({ text: 'Next task.' })
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(2)
    })
    expect(wire.sent[1]?.method).toBe('turn/start')
    wire.reply('turn/start', { turn: { id: 'turn-2' } })
    await next
  })

  it('covers a pending start with Stop and drops input queued before Stop', async () => {
    const wire = connected()
    const first = wire.session.send({ text: 'Build the feature.' })
    const correction = wire.session.send({ text: 'Then change the UI.' })
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(1)
    })
    const stop = wire.session.interrupt()
    wire.reply('turn/start', { turn: { id: 'turn-1' } })
    await vi.waitFor(() => {
      expect(wire.sent).toHaveLength(2)
    })
    expect(wire.sent[1]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'main-thread', turnId: 'turn-1' },
    })
    wire.reply('turn/interrupt', {})
    await Promise.all([first, correction, stop])
    expect(wire.sent.map((request) => request.method)).toEqual(['turn/start', 'turn/interrupt'])
  })
})
