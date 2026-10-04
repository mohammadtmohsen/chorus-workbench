import { FakeAdapter, FakeAgentSession } from '@chorus/orchestrator'
import type { AgentAdapter, AgentSession, SessionOpts } from '@chorus/agent-protocol'
import { Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChorusRuntime } from './runtime.js'
import { DEFAULT_SETTINGS, writeSettings } from './settings.js'
import { readOpenProjects } from './open-projects.js'

class GatedAdapter extends FakeAdapter {
  starts = 0
  failure: Error | null = null
  private gate: Promise<void> | null = null
  private open: () => void = () => undefined
  private closeGate: Promise<void> | null = null
  private openClose: () => void = () => undefined

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve
    })
  }

  release(): void {
    this.open()
  }

  holdClose(): void {
    this.closeGate = new Promise((resolve) => {
      this.openClose = resolve
    })
  }

  releaseClose(): void {
    this.openClose()
  }

  override async start(opts: SessionOpts): Promise<AgentSession> {
    this.starts += 1
    if (this.gate !== null) await this.gate
    if (this.failure !== null) throw this.failure
    const session = await super.start(opts)
    const gate = this.closeGate
    const fake = this.sessions.at(-1)
    if (gate !== null && fake !== undefined) {
      const close = fake.close.bind(fake)
      fake.close = async () => {
        await gate
        await close()
      }
    }
    return session
  }
}

const silent = new Logger()
const CWD = process.cwd()
const BOTH: readonly AgentId[] = ['claude', 'codex']

let runtime: ChorusRuntime
let claude: GatedAdapter
let codex: GatedAdapter
let dataPath: string
let projectId: string
let shutDown: boolean

const turn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

const eventTypes = (conversationId: string): string[] =>
  runtime.store.read(conversationId).map((event) => event.payload.type)

beforeEach(() => {
  dataPath = mkdtempSync(join(tmpdir(), 'chorus-start-'))
  claude = new GatedAdapter({ id: 'claude' })
  codex = new GatedAdapter({ id: 'codex' })
  runtime = ChorusRuntime.open(
    dataPath,
    silent,
    new Map<AgentId, AgentAdapter>([
      ['claude', claude],
      ['codex', codex],
    ])
  )
  projectId = runtime.projects.adopt(CWD).project.id
  shutDown = false
})

afterEach(async () => {
  vi.restoreAllMocks()
  claude.release()
  codex.release()
  claude.releaseClose()
  codex.releaseClose()
  delete process.env['CHORUS_PROFILE_READONLY']
  if (!shutDown) await runtime.close()
})

describe('beginning a conversation', () => {
  it('answers with the permanent id before any event is written or agent started', async () => {
    claude.hold()
    codex.hold()
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(begun).toMatchObject({ projectId, cwd: expect.any(String), participants: [] })
    expect(runtime.store.read(begun.conversationId)).toEqual([])
    expect(claude.starts + codex.starts).toBe(0)
    expect(runtime.activeSessions()).toEqual([
      expect.objectContaining({
        conversationId: begun.conversationId,
        participants: [],
        starting: true,
      }),
    ])

    await vi.waitFor(() => {
      expect(claude.starts).toBe(1)
      expect(codex.starts).toBe(1)
    })
    expect(eventTypes(begun.conversationId)).toEqual(['conversation.created'])
    expect(runtime.activeSessions()[0]?.starting).toBe(true)

    claude.release()
    codex.release()
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'ready',
      conversation: { ...begun, participants: ['claude', 'codex'] },
    })
    expect(runtime.activeSessions()).toHaveLength(1)
    expect(runtime.activeSessions()[0]?.starting).toBeUndefined()
  })

  it('composes a carried room after answering, and records it only once composed', async () => {
    const source = await runtime.startConversation({ projectId, agents: ['claude'] })
    await runtime.send(source.conversationId, 'remember the blue door')

    const begun = runtime.beginConversation({
      projectId,
      agents: ['claude'],
      continueFrom: source.conversationId,
    })
    expect(runtime.store.read(begun.conversationId)).toEqual([])

    expect(await runtime.awaitStart(begun.conversationId)).toMatchObject({ status: 'ready' })
    const created = runtime.store
      .read(begun.conversationId)
      .find((event) => event.payload.type === 'conversation.created')
    expect(created?.payload).toMatchObject({ continuedFrom: source.conversationId })
    expect(
      runtime.store
        .read(begun.conversationId)
        .some(
          (event) =>
            event.payload.type === 'notice.raised' && event.payload.code === 'contextCarried'
        )
    ).toBe(true)

    await runtime.send(begun.conversationId, 'carry on')
    const joined = runtime.store
      .read(begun.conversationId)
      .find(
        (event) => event.payload.type === 'session.started' && event.payload.agentId === 'claude'
      )
    const ref = joined?.payload.type === 'session.started' ? joined.payload.sessionRef : undefined
    const participant = claude.sessions.find((session) => session.sessionRef === ref)
    expect(ref).toBeDefined()
    expect(participant?.sent[0]?.text).toContain('remember the blue door')
  })

  it('names no source when the room it continues has nothing to carry', async () => {
    const begun = runtime.beginConversation({
      projectId,
      agents: ['claude'],
      continueFrom: 'a-room-that-never-was',
    })
    await runtime.awaitStart(begun.conversationId)

    const created = runtime.store
      .read(begun.conversationId)
      .find((event) => event.payload.type === 'conversation.created')
    expect(created?.payload).not.toHaveProperty('continuedFrom')
    expect(eventTypes(begun.conversationId)).not.toContain('notice.raised')
  })

  it('refuses under the read-only flag before minting anything', () => {
    process.env['CHORUS_PROFILE_READONLY'] = '1'
    const before = runtime.store.lastSeq()

    expect(() => runtime.beginConversation({ projectId, agents: BOTH })).toThrow(
      /CHORUS_PROFILE_READONLY/
    )
    expect(runtime.activeSessions()).toEqual([])
    expect(runtime.store.lastSeq()).toBe(before)
  })

  it('answers the style captured when the room was opened', () => {
    writeSettings(dataPath, { ...DEFAULT_SETTINGS, styleOnByDefault: true })
    claude.hold()
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })

    expect(runtime.answerStyle(begun.conversationId)).toBe(true)
  })
})

describe('how a start ends', () => {
  it('fails with every reason when no agent starts, and gives the failure out once', async () => {
    claude.failure = new Error('claude fell over')
    codex.failure = new Error('codex fell over')
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'claude fell over; codex fell over',
    })
    expect(runtime.activeSessions()).toEqual([])
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('keeps the agents that started and says why the other is missing', async () => {
    codex.failure = new Error('codex fell over')
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(await runtime.awaitStart(begun.conversationId)).toMatchObject({
      status: 'ready',
      conversation: { participants: ['claude'] },
    })
    expect(
      runtime.store
        .read(begun.conversationId)
        .some(
          (event) =>
            event.payload.type === 'error.raised' && event.payload.message === 'codex fell over'
        )
    ).toBe(true)
  })

  it('answers an await that arrives after the start already settled', async () => {
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    await vi.waitFor(() => {
      expect(runtime.activeSessions()[0]?.starting).toBeUndefined()
    })

    expect(await runtime.awaitStart(begun.conversationId)).toMatchObject({
      status: 'ready',
      conversation: { conversationId: begun.conversationId, participants: ['claude'] },
    })
  })

  it('answers a late await for a failure, then forgets it', async () => {
    claude.failure = new Error('claude fell over')
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    await vi.waitFor(() => {
      expect(runtime.activeSessions()).toEqual([])
    })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'claude fell over',
    })
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('keeps only the newest sixty-four unclaimed failures', async () => {
    claude.failure = new Error('claude fell over')
    const ids = Array.from(
      { length: 65 },
      () => runtime.beginConversation({ projectId, agents: ['claude'] }).conversationId
    )
    await vi.waitFor(() => {
      expect(runtime.activeSessions()).toEqual([])
    })

    expect(await runtime.awaitStart(ids[0] ?? '')).toEqual({ status: 'cancelled' })
    expect(await runtime.awaitStart(ids[1] ?? '')).toMatchObject({ status: 'failed' })
    expect(await runtime.awaitStart(ids[64] ?? '')).toMatchObject({ status: 'failed' })
  })

  it('closes a session whose attachment threw, once, and keeps the original error', async () => {
    const append = runtime.store.append.bind(runtime.store)
    vi.spyOn(runtime.store, 'append').mockImplementation((input, now) => {
      if (input.payload.type === 'session.started') throw new Error('the log fell over')
      return append(input, now)
    })
    const closes = vi.spyOn(FakeAgentSession.prototype, 'close')
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'the log fell over',
    })
    expect(claude.sessions[0]?.closed).toBe(true)
    expect(closes).toHaveBeenCalledTimes(1)
    expect(runtime.activeSessions()).toEqual([])
  })

  it('closes the agents it started when preparing the room fails afterwards', async () => {
    codex.failure = new Error('codex fell over')
    const append = runtime.store.append.bind(runtime.store)
    vi.spyOn(runtime.store, 'append').mockImplementation((input, now) => {
      if (input.payload.type === 'error.raised') throw new Error('the log fell over')
      return append(input, now)
    })
    const begun = runtime.beginConversation({ projectId, agents: BOTH })

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'the log fell over',
    })
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
  })

  it('rolls back a room whose registration failed, and closes its agents', async () => {
    let armed = false
    runtime.onConversationsChanged(() => {
      if (!armed) return
      armed = false
      throw new Error('the listener fell over')
    })
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    armed = true

    expect(await runtime.awaitStart(begun.conversationId)).toEqual({
      status: 'failed',
      message: 'the listener fell over',
    })
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
    expect(readOpenProjects(dataPath).projects).toEqual([])
  })

  it('still resolves and rejects the awaited start the way existing callers expect', async () => {
    expect(await runtime.startConversation({ projectId, agents: ['claude'] })).toMatchObject({
      participants: ['claude'],
      projectId,
    })

    claude.failure = new Error('claude fell over')
    await expect(runtime.startConversation({ projectId, agents: ['claude'] })).rejects.toThrow(
      'claude fell over'
    )
  })
})

describe('closing a room that is still starting', () => {
  it('writes nothing and starts nothing when closed before preparation', async () => {
    const begun = runtime.beginConversation({ projectId, agents: BOTH })
    await runtime.closeConversation(begun.conversationId)
    await turn()
    await turn()

    expect(runtime.store.read(begun.conversationId)).toEqual([])
    expect(claude.starts + codex.starts).toBe(0)
    expect(runtime.activeSessions()).toEqual([])
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('closes an agent already started without waiting for the slow one', async () => {
    codex.hold()
    const begun = runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.sessions).toHaveLength(1)
    })
    await turn()
    await turn()

    await runtime.closeConversation(begun.conversationId)
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
    })
    expect(codex.sessions).toHaveLength(0)

    codex.release()
    await vi.waitFor(() => {
      expect(codex.sessions[0]?.closed).toBe(true)
    })
    expect(claude.sessions).toHaveLength(1)
    expect(runtime.activeSessions()).toEqual([])
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })
  })

  it('rejects the awaited start of a room closed while it was starting', async () => {
    claude.hold()
    const pending = runtime.startConversation({ projectId, agents: ['claude'] })
    const conversationId = runtime.activeSessions()[0]?.conversationId ?? ''

    await runtime.closeConversation(conversationId)
    await expect(pending).rejects.toThrow(/closed before its agents started/)
  })

  it('cancels the starting rooms of a project that is forgotten', async () => {
    claude.hold()
    codex.hold()
    const begun = runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.starts + codex.starts).toBe(2)
    })

    await runtime.forgetProject(projectId)
    expect(await runtime.awaitStart(begun.conversationId)).toEqual({ status: 'cancelled' })

    claude.release()
    codex.release()
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
      expect(codex.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
  })
})

describe('a room that is still starting, seen from elsewhere', () => {
  it('reopens without starting its agents a second time, and lists as open', async () => {
    claude.hold()
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    await vi.waitFor(() => {
      expect(claude.starts).toBe(1)
    })

    expect(await runtime.reopenConversation(begun.conversationId)).toMatchObject({
      conversationId: begun.conversationId,
      participants: [],
      starting: true,
    })
    expect(
      runtime
        .listConversations()
        .find((conversation) => conversation.conversationId === begun.conversationId)?.open
    ).toBe(true)

    claude.release()
    await runtime.awaitStart(begun.conversationId)
    expect(claude.starts).toBe(1)
  })

  it('refuses to move its project', () => {
    claude.hold()
    runtime.beginConversation({ projectId, agents: ['claude'] })

    expect(() => runtime.relocateProject(projectId, tmpdir())).toThrow(/open conversation/)
  })

  it('keeps a draft typed while starting, through to the reopen list', async () => {
    claude.hold()
    const begun = runtime.beginConversation({ projectId, agents: ['claude'] })
    runtime.rememberDraft(begun.conversationId, 'half a thought')
    expect(runtime.activeSessions()[0]?.draft).toBe('half a thought')

    claude.release()
    await runtime.awaitStart(begun.conversationId)
    expect(runtime.activeSessions()[0]?.draft).toBe('half a thought')
    expect(readOpenProjects(dataPath).projects[0]?.conversations[0]?.draft).toBe('half a thought')
  })
})

describe('shutting down while a room is starting', () => {
  it('waits a bounded time, then closes a late agent without registering it', async () => {
    codex.hold()
    runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.sessions).toHaveLength(1)
      expect(codex.starts).toBe(1)
    })

    const began = Date.now()
    await runtime.close()
    shutDown = true
    expect(Date.now() - began).toBeGreaterThanOrEqual(2_900)
    expect(claude.sessions[0]?.closed).toBe(true)
    expect(() => runtime.beginConversation({ projectId, agents: BOTH })).toThrow(/shutting down/)

    codex.release()
    await vi.waitFor(() => {
      expect(codex.sessions[0]?.closed).toBe(true)
    })
    expect(runtime.activeSessions()).toEqual([])
  }, 10_000)

  it('drops the writes of an agent whose cleanup finishes after the deadline', async () => {
    codex.hold()
    claude.holdClose()
    runtime.beginConversation({ projectId, agents: BOTH })
    await vi.waitFor(() => {
      expect(claude.sessions).toHaveLength(1)
      expect(codex.starts).toBe(1)
    })
    await turn()
    await turn()

    await runtime.close()
    shutDown = true
    expect(claude.sessions[0]?.closed).toBe(false)
    expect(runtime.store.droppedWrites()).toBe(0)

    claude.releaseClose()
    codex.release()
    await vi.waitFor(() => {
      expect(claude.sessions[0]?.closed).toBe(true)
      expect(codex.sessions[0]?.closed).toBe(true)
      expect(runtime.store.droppedWrites()).toBeGreaterThan(0)
    })
    expect(runtime.activeSessions()).toEqual([])
  }, 10_000)

  it('does not wait when nothing is starting', async () => {
    const began = Date.now()
    await runtime.close()
    shutDown = true
    expect(Date.now() - began).toBeLessThan(2_900)
  })
})
