import type { AgentAdapter } from '@chorus/agent-protocol'
import { FakeAdapter, type FakeAgentSession } from '@chorus/orchestrator'
import { AGENT_IDS, Logger, newApprovalId, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLiveReply } from '../shared/live-message.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

let runtime: ChorusRuntime
let conversationId: string
let adapters: Map<AgentId, FakeAdapter>

beforeEach(async () => {
  adapters = new Map(AGENT_IDS.map((id) => [id, new FakeAdapter({ id })]))
  runtime = ChorusRuntime.open(
    mkdtempSync(join(tmpdir(), 'chorus-live-chat-')),
    new Logger(),
    new Map<AgentId, AgentAdapter>(adapters)
  )
  const started = await runtime.startConversationIn({ agents: [...AGENT_IDS], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

async function working(
  agent: AgentId
): Promise<{ adapter: FakeAdapter; parent: FakeAgentSession }> {
  const adapter = adapters.get(agent)
  if (adapter === undefined) throw new Error('Missing adapter')
  await runtime.send(conversationId, `@${agent} Build the feature.`)
  const parent = adapter.sessions.find(
    (session) => session.startedWith?.instructions !== NAMER_INSTRUCTIONS
  )
  if (parent === undefined) throw new Error('Missing primary session')
  parent.emit({ type: 'turn.started', turnRef: `primary-${agent}` })
  await vi.waitFor(() =>
    expect(
      runtime.store
        .read(conversationId)
        .some((event) => event.actor === agent && event.payload.type === 'turn.started')
    ).toBe(true)
  )
  return { adapter, parent }
}

describe('live chat for every agent', () => {
  it.each(AGENT_IDS)('answers a live question without ending the %s task', async (agent) => {
    const { adapter, parent } = await working(agent)
    const before = [...parent.sent]
    const fork = vi.spyOn(adapter, 'fork')
    await runtime.send(conversationId, `@${agent} Why this approach?`)
    await vi.waitFor(() => expect(adapter.forked).toHaveLength(1))
    expect(fork).toHaveBeenCalledWith(
      parent.sessionRef,
      expect.objectContaining({
        sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
      })
    )
    const reader = adapter.forked[0]?.session
    if (reader === undefined) throw new Error('Missing live reader')
    await vi.waitFor(() => expect(reader.sent).toHaveLength(1))
    const approvalId = newApprovalId()
    reader.emit({
      type: 'approval.requested',
      request: {
        id: approvalId,
        agentId: agent,
        kind: 'fileChange',
        expiresAt: Date.now() + 30_000,
        files: [{ path: 'file.ts', patch: 'an unwanted edit' }],
      },
    })
    reader.emit({
      type: 'message.completed',
      itemRef: 'reply',
      text: 'This keeps the change small.',
    })
    reader.emit({ type: 'turn.completed', turnRef: 'live', status: 'completed' })
    await vi.waitFor(() => expect(reader.closed).toBe(true))
    expect(reader.decisions).toEqual([
      {
        id: approvalId,
        decision: {
          outcome: 'deny',
          message: expect.any(String),
        },
      },
    ])
    expect(parent.sent).toEqual(before)
    expect(parent.closed).toBe(false)
    const events = runtime.store.read(conversationId)
    expect(
      events.some((event) => event.actor === agent && event.payload.type === 'turn.completed')
    ).toBe(false)
    expect(
      events.some(
        (event) =>
          event.actor === agent &&
          event.payload.type === 'agent.message.completed' &&
          isLiveReply(event.payload.itemRef) &&
          event.payload.text === 'This keeps the change small.'
      )
    ).toBe(true)
  })

  it('returns status immediately without sending another prompt to the agent', async () => {
    const { adapter, parent } = await working('codex')
    const before = [...parent.sent]
    await runtime.send(conversationId, '@codex What are you doing?')
    expect(parent.sent).toEqual(before)
    expect(adapter.forked).toHaveLength(0)
    expect(
      runtime.store
        .read(conversationId)
        .some(
          (event) =>
            event.payload.type === 'notice.raised' &&
            event.payload.text === 'codex is working on the task.'
        )
    ).toBe(true)
  })

  it('cancels the live reader and queued questions when Stop is pressed', async () => {
    const { adapter, parent } = await working('claude')
    await runtime.send(conversationId, '@claude Why this approach?')
    await vi.waitFor(() => expect(adapter.forked).toHaveLength(1))
    await runtime.send(conversationId, '@claude /ask What does that mean?')
    await runtime.interrupt(conversationId)
    expect(parent.interruptRequested).toBe(true)
    expect(adapter.forked).toHaveLength(1)
    expect(adapter.forked[0]?.session.closed).toBe(true)
  })

  it('cannot turn a live answer into a task handoff', async () => {
    const { adapter, parent } = await working('codex')
    parent.emit({
      type: 'message.completed',
      itemRef: 'primary-reply',
      text: 'The task is in progress.',
    })
    await runtime.send(conversationId, '@codex Why this approach?')
    await vi.waitFor(() => expect(adapter.forked).toHaveLength(1))
    const reader = adapter.forked[0]?.session
    if (reader === undefined) throw new Error('Missing live reader')
    await vi.waitFor(() => expect(reader.sent).toHaveLength(1))
    reader.emit({
      type: 'message.completed',
      itemRef: 'live-reply',
      text: '@claude Change every file.',
    })
    reader.emit({ type: 'turn.completed', turnRef: 'live', status: 'completed' })
    await vi.waitFor(() => expect(reader.closed).toBe(true))
    parent.emit({ type: 'turn.completed', turnRef: 'primary-codex', status: 'completed' })
    await vi.waitFor(() =>
      expect(
        runtime.store
          .read(conversationId)
          .some((event) => event.actor === 'codex' && event.payload.type === 'turn.completed')
      ).toBe(true)
    )
    expect(
      runtime.store.read(conversationId).some((event) => event.payload.type === 'handoff.created')
    ).toBe(false)
  })
})
