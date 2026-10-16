import type { AgentEvent } from '@chorus/agent-protocol'
import { EventStore, openSqlite, type SqliteHandle } from '@chorus/event-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationService } from './conversation-service.js'
import type { Scheduler } from './delta-buffer.js'
import { FakeAdapter, type FakeAgentSession } from './testing/fake-adapter.js'

const CONV = 'conv-progress'
const OPTS = {
  cwd: '/tmp/project',
  sandbox: { mode: 'readOnly' as const, writableRoots: [], networkAccess: false },
}

const idle: Scheduler = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  now: () => 0,
}

type Plan = Extract<AgentEvent, { type: 'plan.updated' }>['steps']

let db: SqliteHandle
let store: EventStore
let adapter: FakeAdapter
let plans: Plan[]
let service: ConversationService

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const types = (): string[] => store.read(CONV).map((event) => event.payload.type)
const session = (): FakeAgentSession => {
  const found = adapter.sessions[0]
  if (found === undefined) throw new Error('no session')
  return found
}

beforeEach(async () => {
  db = openSqlite({ path: ':memory:' })
  store = EventStore.open(db).store
  adapter = new FakeAdapter({ id: 'codex' })
  plans = []
  service = new ConversationService({
    store,
    conversationId: CONV,
    adapter,
    scheduler: idle,
    maxChars: 10_000,
    onPlan: (steps) => {
      plans.push(steps)
    },
  })
  await service.start(OPTS)
})

afterEach(() => {
  db.close()
})

describe('a provider plan', () => {
  it('is handed to the caller rather than discarded, and never logged by the service', async () => {
    session().emit({
      type: 'plan.updated',
      steps: [
        { text: 'Read', done: true },
        { text: 'Write', done: false, active: true },
      ],
    })
    await tick()
    expect(plans).toEqual([
      [
        { text: 'Read', done: true },
        { text: 'Write', done: false, active: true },
      ],
    ])
    expect(types()).not.toContain('task.revised')
  })

  it('keeps the pump running when the caller throws', async () => {
    const throwing = new ConversationService({
      store,
      conversationId: CONV,
      adapter,
      scheduler: idle,
      onPlan: () => {
        throw new Error('no task')
      },
    })
    await throwing.start(OPTS)
    const own = adapter.sessions[1]
    own?.emit({ type: 'plan.updated', steps: [{ text: 'Read', done: false }] })
    own?.emit({ type: 'turn.started', turnRef: 't1' })
    await tick()
    expect(types()).toContain('turn.started')
  })
})

describe('recording a task event', () => {
  it('flushes the text that came before it, so the log keeps its order', async () => {
    session().emit({ type: 'message.delta', itemRef: 'm1', text: 'Planning first.' })
    await tick()
    expect(types()).not.toContain('agent.message.delta')
    service.recordTask({
      type: 'task.revised',
      taskId: 't1',
      agentId: 'codex',
      revision: 1,
      source: 'chorus',
      steps: [{ id: 'a', title: 'A', status: 'active' }],
    })
    const order = types()
    expect(order.indexOf('agent.message.delta')).toBeLessThan(order.indexOf('task.revised'))
    expect(store.read(CONV).find((event) => event.type === 'task.revised')?.actor).toBe('codex')
  })
})

describe('a usage limit', () => {
  it('is recorded once per turn, however often the provider says it', async () => {
    session().emit({ type: 'turn.started', turnRef: 't1' })
    session().emit({ type: 'usage.blocked', resetsAt: 5_000 })
    session().emit({ type: 'usage.blocked', resetsAt: 5_000 })
    session().emit({ type: 'turn.completed', turnRef: 't1', status: 'failed' })
    session().emit({ type: 'turn.started', turnRef: 't2' })
    session().emit({ type: 'usage.blocked', resetsAt: null })
    await tick()
    const blocks = store
      .read(CONV)
      .flatMap((event) => (event.payload.type === 'usage.blocked' ? [event.payload.resetsAt] : []))
    expect(blocks).toEqual([5_000, null])
  })
})
