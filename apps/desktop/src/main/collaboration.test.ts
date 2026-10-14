import type { AgentAdapter } from '@chorus/agent-protocol'
import { FakeAdapter } from '@chorus/orchestrator'
import { AGENT_IDS, Logger, type AgentId } from '@chorus/shared'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isExpandedCollaboration, originalCollaborationText } from '../shared/collaboration.js'
import { IPC_CONTRACT } from '../shared/ipc.js'
import { applyMention, teamCommandOption } from '../renderer/src/mention-menu.js'
import { EMPTY_VIEW, reduceEvents } from '../renderer/src/transcript.js'
import { collaborationPrompt } from './collaboration-prompt.js'
import { ChorusRuntime, NAMER_INSTRUCTIONS } from './runtime.js'

let runtime: ChorusRuntime
let conversationId: string
let adapters: Map<AgentId, FakeAdapter>

const sentTo = (agent: AgentId): string[] =>
  adapters
    .get(agent)
    ?.sessions.filter((session) => session.startedWith?.instructions !== NAMER_INSTRUCTIONS)
    .flatMap((session) => session.sent.map((message) => message.text)) ?? []

const logged = (): string[] =>
  runtime.store
    .read(conversationId)
    .flatMap((event) => (event.payload.type === 'user.message' ? [event.payload.text] : []))

beforeEach(async () => {
  adapters = new Map(AGENT_IDS.map((id) => [id, new FakeAdapter({ id })]))
  runtime = ChorusRuntime.open(
    mkdtempSync(join(tmpdir(), 'chorus-collaboration-')),
    new Logger(),
    new Map<AgentId, AgentAdapter>(adapters)
  )
  const started = await runtime.startConversationIn({ agents: [...AGENT_IDS], cwd: process.cwd() })
  conversationId = started.conversationId
})

afterEach(async () => {
  await runtime.close()
})

describe('collaboration delivery', () => {
  it('logs the short task and delivers the workflow only to the first mentioned agent', async () => {
    const task = '@deepseek work with @codex on saved searches'
    const request = IPC_CONTRACT['conversation:send'].request.parse({
      conversationId,
      text: task,
      intent: 'collaborate',
    })
    const result = await runtime.send(request.conversationId, request.text, request.intent)

    expect(result.targets).toEqual(['deepseek'])
    expect(logged()).toEqual([task])
    expect(sentTo('codex')).toEqual([])
    expect(sentTo('claude')).toEqual([])
    expect(sentTo('deepseek')[0]).toContain(`# TASK\n\n${task}`)
    expect(sentTo('deepseek')[0]).toContain('Research only:')
    expect(sentTo('deepseek')[0]).toContain('Research and plan:')
    expect(sentTo('deepseek')[0]).toContain('Full build:')
  })

  it('keeps template-looking task text and attachments literal', async () => {
    const task = '@claude @codex research only: {{partner}} $t(example)\n\n"/tmp/image one.png"'
    await runtime.send(conversationId, task, 'collaborate')
    expect(logged()).toEqual([task])
    expect(sentTo('claude')[0]).toContain(`# TASK\n\n${task}\n\n# ROLES AND SCOPE`)
  })

  it('keeps a plain collaborator name as a solo task', async () => {
    const task = '@codex review what claude wrote'
    const result = await runtime.send(conversationId, task)
    expect(result.targets).toEqual(['codex'])
    expect(sentTo('codex')[0]).toContain('review what claude wrote')
    expect(sentTo('codex')[0]).not.toContain('# ROLES AND SCOPE')
    expect(sentTo('claude')).toEqual([])
  })

  it('does not introduce collaboration based on editor context without the draft intent', async () => {
    await runtime.send(conversationId, '@codex explain this file\n\nEditor context: @claude')
    expect(sentTo('codex')[0]).not.toContain('# ROLES AND SCOPE')
    expect(sentTo('claude')).toEqual([])
  })

  it('recovers an old prompt in the transcript and resends without nesting it', async () => {
    const task = '@codex @claude research and plan: saved searches'
    const extra = '\n\n"/tmp/example.png"'
    const old = collaborationPrompt({ leader: 'codex', partner: 'claude' }, task) + extra
    runtime.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: old },
    })
    const events = runtime.store.read(conversationId).map((event) => ({
      ...event,
      type: event.payload.type,
    }))
    const history = reduceEvents(EMPTY_VIEW, events)
      .messages.filter((message) => message.actor === 'user')
      .map((message) => message.text)
    expect(history).toEqual([task + extra])
    expect(logged()).toEqual([old])

    await runtime.send(conversationId, old, 'collaborate')
    expect(logged()).toEqual([old, task + extra])
    expect(sentTo('codex')[0]).toContain(`# TASK\n\n${task + extra}\n\n# ROLES AND SCOPE`)
    expect(sentTo('codex')[0]).not.toContain('# TASK\n\n@codex Run this task collaboratively')
  })

  it('preserves an unrecognized old envelope without adding another wrapper', async () => {
    const old = collaborationPrompt(
      { leader: 'codex', partner: 'claude' },
      '@codex @claude fix saved searches'
    ).replace('# ROLES AND SCOPE', '# ROLES')
    await runtime.send(conversationId, old, 'collaborate')
    expect(logged()).toEqual([old])
    expect(sentTo('codex')[0]).not.toContain('# ROLES AND SCOPE')
  })
})

describe('collaboration prompt', () => {
  const pairs = AGENT_IDS.flatMap((leader) =>
    AGENT_IDS.filter((partner) => partner !== leader).map((partner) => ({ leader, partner }))
  )

  it.each(pairs)('wraps, recovers and resends $leader leading $partner', async (pair) => {
    const { leader, partner } = pair
    const task = `@${leader} @${partner}: {{leader}} {{partner}} {{task}} $& $t(example)`
    const extra = '\n\n"/tmp/image one.png"'
    const prompt = collaborationPrompt(pair, task)
    const opening = [
      `@${leader} Run this task collaboratively with ${partner}.`,
      '# TASK',
      task,
      '# ROLES AND SCOPE',
      `You, ${leader}, are the lead and coordinator. ${partner} is your collaborator.`,
    ].join('\n\n')
    const closing = `- A reply whose next step belongs to ${partner} and which does not end with an @${partner} line stops the run.`

    expect(prompt.slice(0, opening.length)).toBe(opening)
    expect(prompt.slice(-closing.length)).toBe(closing)
    expect(isExpandedCollaboration(prompt)).toBe(true)
    expect(originalCollaborationText(prompt)).toBe(task)
    expect(originalCollaborationText(prompt + extra)).toBe(task + extra)
    expect(originalCollaborationText(collaborationPrompt(pair, prompt))).toBe(task)
    expect(prompt.length - task.length).toBeLessThan(10_000)

    const old = prompt + extra
    runtime.store.append({
      conversationId,
      actor: 'user',
      payload: { type: 'user.message', text: old },
    })
    const events = runtime.store.read(conversationId).map((event) => ({
      ...event,
      type: event.payload.type,
    }))
    const history = reduceEvents(EMPTY_VIEW, events)
      .messages.filter((message) => message.actor === 'user')
      .map((message) => message.text)
    expect(history).toEqual([task + extra])

    const result = await runtime.send(conversationId, old, 'collaborate')
    expect(result.targets).toEqual([leader])
    expect(logged()).toEqual([old, task + extra])
    expect(sentTo(leader)[0]).toContain(`# TASK\n\n${task + extra}\n\n# ROLES AND SCOPE`)
    for (const agent of AGENT_IDS.filter((id) => id !== leader)) {
      expect(sentTo(agent)).toEqual([])
    }
  })
})

describe('team introduction', () => {
  it('keeps the command in history and broadcasts the introduction on send and resend', async () => {
    const option = teamCommandOption(AGENT_IDS, 'te', { detail: 'Team' })[0]
    if (option === undefined) throw new Error('missing team option')
    const draft = applyMention(
      '/te',
      { trigger: '/', start: 0, query: 'te' },
      3,
      option
    ).text.trim()
    expect(draft).toBe('/team')

    const first = await runtime.send(conversationId, draft)
    const second = await runtime.send(conversationId, logged()[0] ?? '')
    expect(first.targets).toEqual(AGENT_IDS)
    expect(second.targets).toEqual(AGENT_IDS)
    expect(logged()).toEqual(['/team', '/team'])
    for (const agent of AGENT_IDS) {
      expect(sentTo(agent)).toHaveLength(2)
      expect(sentTo(agent)[0]).toContain('This conversation has')
      expect(sentTo(agent)[0]).not.toContain('# ROLES AND SCOPE')
    }
  })
})
