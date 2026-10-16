import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ProgressReport, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'
import { mapSdkMessage } from './mapping.js'
import { REPORT_PROGRESS_TOOL, progressTools } from './progress-tool.js'

const BASE: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false },
}

const reporter = (seen: ProgressReport[]) => (report: ProgressReport) => {
  seen.push(report)
  return { ok: true, text: 'recorded' }
}

type Opened = 'start' | 'resume' | 'fork'

async function optionsFor(opts: SessionOpts, how: Opened = 'start'): Promise<Options> {
  let captured: Options | undefined
  const adapter = new ClaudeAdapter({
    createQuery: (options: Options) => {
      captured = options
      const messages = new AsyncQueue<unknown>()
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt: () => Promise.resolve(undefined),
        setModel: () => Promise.resolve(),
        close: () => {
          messages.close()
        },
      } as unknown as Query
    },
  })
  if (how === 'start') await adapter.start(opts)
  else if (how === 'resume') await adapter.resume('session-1', opts)
  else await adapter.fork('session-1', { ...opts, inherits: 'config' })
  if (captured === undefined) throw new Error('no query was opened')
  return captured
}

const ask = (options: Options, name: string): Promise<PermissionResult | null | 'pending'> => {
  const canUseTool = options.canUseTool
  if (canUseTool === undefined) throw new Error('no permission callback')
  return Promise.race([
    canUseTool(
      name,
      { steps: [] },
      { signal: new AbortController().signal, toolUseID: `tu-${name}`, requestId: `r-${name}` }
    ),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => {
        resolve('pending')
      }, 20)
    }),
  ])
}

describe('the chorus_progress server', () => {
  it('is registered on start and resume when the session has a reporter', async () => {
    for (const how of ['start', 'resume'] as const) {
      const options = await optionsFor({ ...BASE, progress: reporter([]) }, how)
      expect(Object.keys(options.mcpServers ?? {}), how).toContain('chorus_progress')
    }
  })

  it('is absent without a reporter, in a discussion session and in a throwaway fork', async () => {
    const cases: [SessionOpts, Opened][] = [
      [BASE, 'start'],
      [{ ...BASE, progress: reporter([]), toolPolicy: 'readOnly' }, 'start'],
      [{ ...BASE, progress: reporter([]) }, 'fork'],
    ]
    for (const [opts, how] of cases) {
      const options = await optionsFor(opts, how)
      expect(Object.keys(options.mcpServers ?? {}), how).not.toContain('chorus_progress')
    }
  })

  it('allows its own tool without asking, and only when it was registered', async () => {
    const registered = await optionsFor({ ...BASE, progress: reporter([]) })
    expect(await ask(registered, REPORT_PROGRESS_TOOL)).toEqual({
      behavior: 'allow',
      updatedInput: { steps: [] },
    })
    for (const name of ['mcp__chorus_progress__clear', 'mcp__other__report_progress']) {
      expect(await ask(registered, name), name).toBe('pending')
    }
    const without = await optionsFor(BASE)
    expect(await ask(without, REPORT_PROGRESS_TOOL)).toBe('pending')
  })
})

describe('the report_progress handler', () => {
  const handler = (seen: ProgressReport[]) => {
    const found = progressTools(reporter(seen)).find((each) => each.name === 'report_progress')
    if (found === undefined) throw new Error('no report_progress')
    return found.handler as (
      args: unknown,
      extra: unknown
    ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  }

  it('hands a valid plan to the session reporter', async () => {
    const seen: ProgressReport[] = []
    const result = await handler(seen)(
      { steps: [{ id: 'a', label: '1', title: 'Read', status: 'active', estimateMinutes: 5 }] },
      {}
    )
    expect(result).toEqual({ content: [{ type: 'text', text: 'recorded' }] })
    expect(seen[0]?.steps[0]).toMatchObject({ id: 'a', label: '1', estimateMinutes: 5 })
  })

  it('refuses an invalid plan as an error without reporting it', async () => {
    const seen: ProgressReport[] = []
    const result = await handler(seen)(
      { steps: [{ id: 'a', title: 'Read', status: 'active', dependsOn: ['a'] }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(seen).toEqual([])
  })
})

const CTX = { seq: 1, now: 1_000, agentId: 'claude' as const, approvalTtlMs: 60_000 }

describe('a todo list as the fallback plan', () => {
  const todos = [
    { content: 'Read the types', activeForm: 'Reading the types', status: 'completed' },
    { content: 'Fix the parser', activeForm: 'Fixing the parser', status: 'in_progress' },
    { content: 'Write a test', activeForm: 'Writing a test', status: 'pending' },
  ]

  const write = (parent: string | null) =>
    mapSdkMessage(
      {
        type: 'assistant',
        uuid: 'u-todo',
        parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_use', id: 'tt', name: 'TodoWrite', input: { todos } }] },
      },
      CTX
    )

  it('publishes the agent’s own checklist as a plan, after the tool row', () => {
    const events = write(null)
    expect(events.map((event) => event.type)).toEqual(['tool.started', 'plan.updated'])
    expect(events[1]).toMatchObject({
      steps: [
        { text: 'Read the types', done: true, active: false },
        { text: 'Fix the parser', done: false, active: true },
        { text: 'Write a test', done: false, active: false },
      ],
    })
  })

  it('leaves a sub-agent’s checklist out of the task plan', () => {
    expect(write('task-1').map((event) => event.type)).toEqual(['tool.started'])
  })
})

describe('a usage limit', () => {
  const event = (status: string) =>
    mapSdkMessage(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status,
          resetsAt: 1_800_000_000,
          rateLimitType: 'five_hour',
          utilization: 1,
        },
      },
      CTX
    )

  it('reports a rejection as a block, with when the limit resets', () => {
    expect(event('rejected').at(-1)).toMatchObject({
      type: 'usage.blocked',
      resetsAt: 1_800_000_000_000,
    })
  })

  it('reads a warning as usage, not as a block', () => {
    expect(event('allowed_warning').map((each) => each.type)).not.toContain('usage.blocked')
  })
})
