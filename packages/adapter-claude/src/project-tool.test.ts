import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectReader, SessionOpts, TranscriptRequest } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'
import { PROJECT_TOOL_IDS, projectTools } from './project-tool.js'
import { READ_TRANSCRIPT_TOOL, transcriptTools } from './transcript-tool.js'

const BASE: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

describe('Discussion tool restrictions', () => {
  it('isolates inherited tools while allowing file inspection', async () => {
    const options = await optionsFor({ ...BASE, toolPolicy: 'readOnly' })
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    for (const name of ['Read', 'Glob', 'Grep']) {
      expect(await ask(options, name)).toMatchObject({ behavior: 'allow' })
    }
    for (const name of [
      'Edit',
      'Write',
      'NotebookEdit',
      'Bash',
      'Agent',
      'Task',
      'ExitPlanMode',
      'mcp__external__write',
    ]) {
      expect(await ask(options, name), name).toMatchObject({ behavior: 'deny' })
    }
  })

  it('blocks a plan-file write even when provider permissions would bypass the callback', async () => {
    const options = await optionsFor({ ...BASE, toolPolicy: 'readOnly' })
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
    if (hook === undefined) throw new Error('Missing read-only tool hook')
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'discussion',
        transcript_path: '/tmp/discussion.jsonl',
        cwd: process.cwd(),
        permission_mode: 'bypassPermissions',
        tool_name: 'Write',
        tool_use_id: 'write-plan',
        tool_input: { file_path: 'docs/plans/feature.md', content: 'Plan' },
      },
      'write-plan',
      { signal: new AbortController().signal }
    )
    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    })
  })
})

interface Asked {
  readonly terminal: number[]
  readonly traffic: [number, number][]
  readonly request: [string, string][]
}

const readerOf = (asked: Asked): ProjectReader => ({
  terminal: ({ lines }) => {
    asked.terminal.push(lines)
    return Promise.resolve(`terminal ${String(lines)}`)
  },
  traffic: ({ count, skip }) => {
    asked.traffic.push([count, skip])
    return Promise.resolve('traffic')
  },
  request: ({ captureId, requestId }) => {
    asked.request.push([captureId, requestId])
    return Promise.reject(new Error('cleared'))
  },
})

const fresh = (): Asked => ({ terminal: [], traffic: [], request: [] })

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

const ask = (options: Options, name: string): Promise<PermissionResult | null> => {
  const canUseTool = options.canUseTool
  if (canUseTool === undefined) throw new Error('no permission callback')
  return canUseTool(
    name,
    { lines: 5 },
    {
      signal: new AbortController().signal,
      toolUseID: `tu-${name}`,
      requestId: `request-${name}`,
    }
  )
}

const settledWithin = (
  result: Promise<PermissionResult | null>
): Promise<PermissionResult | null | 'pending'> =>
  Promise.race([
    result,
    new Promise<'pending'>((resolve) => {
      setTimeout(() => {
        resolve('pending')
      }, 20)
    }),
  ])

describe('the chorus_project server', () => {
  it('is registered on start, resume and fork when the session has a reader', async () => {
    for (const how of ['start', 'resume', 'fork'] as const) {
      const options = await optionsFor({ ...BASE, project: readerOf(fresh()) }, how)
      expect(Object.keys(options.mcpServers ?? {}), how).toContain('chorus_project')
    }
  })

  it('is absent without a reader, and leaves the other servers as they were', async () => {
    const without = await optionsFor(BASE)
    expect(Object.keys(without.mcpServers ?? {})).not.toContain('chorus_project')
    const withTranscript = await optionsFor({ ...BASE, transcript: () => 'history' })
    expect(Object.keys(withTranscript.mcpServers ?? {})).toEqual(['chorus_transcript'])
  })
})

describe('auto-allowing the project tools', () => {
  it('names exactly the three read tools', () => {
    expect([...PROJECT_TOOL_IDS].sort()).toEqual([
      'mcp__chorus_project__read_request',
      'mcp__chorus_project__read_terminal',
      'mcp__chorus_project__read_traffic',
    ])
  })

  it('allows the three without asking', async () => {
    const options = await optionsFor({ ...BASE, project: readerOf(fresh()) })
    for (const name of PROJECT_TOOL_IDS) {
      expect(await settledWithin(ask(options, name))).toEqual({
        behavior: 'allow',
        updatedInput: { lines: 5 },
      })
    }
  })

  it('still asks for anything else in the namespace and for every other tool', async () => {
    const options = await optionsFor({ ...BASE, project: readerOf(fresh()) })
    for (const name of [
      'mcp__chorus_project__run',
      'mcp__chorus_project__stop',
      'mcp__chorus_project__read_terminal_all',
      'mcp__other__read_terminal',
      'Bash',
    ]) {
      expect(await settledWithin(ask(options, name)), name).toBe('pending')
    }
  })

  it('does not allow the names when this session registered no project server', async () => {
    const options = await optionsFor(BASE)
    for (const name of PROJECT_TOOL_IDS) {
      expect(await settledWithin(ask(options, name)), name).toBe('pending')
    }
  })
})

describe('the tool handlers', () => {
  const handler = (asked: Asked, name: string) => {
    const found = projectTools(readerOf(asked)).find((each) => each.name === name)
    if (found === undefined) throw new Error(`no ${name}`)
    return found.handler as (
      args: unknown,
      extra: unknown
    ) => ReturnType<NonNullable<typeof found>['handler']>
  }

  it('reads through the session reader with the defaults applied', async () => {
    const asked = fresh()
    const terminal = await handler(asked, 'read_terminal')({}, undefined)
    const traffic = await handler(asked, 'read_traffic')({ skip: 3 }, undefined)
    expect(terminal).toEqual({ content: [{ type: 'text', text: 'terminal 200' }] })
    expect(traffic).toEqual({ content: [{ type: 'text', text: 'traffic' }] })
    expect(asked.terminal).toEqual([200])
    expect(asked.traffic).toEqual([[20, 3]])
  })

  it('reports a failed read as an error result', async () => {
    const asked = fresh()
    const result = await handler(asked, 'read_request')(
      { captureId: 'c1', requestId: 'r1' },
      undefined
    )
    expect(result).toEqual({ content: [{ type: 'text', text: 'cleared' }], isError: true })
    expect(asked.request).toEqual([['c1', 'r1']])
  })

  it('refuses invalid arguments without reading', async () => {
    const asked = fresh()
    const result = await handler(asked, 'read_terminal')({ lines: 401 }, undefined)
    expect(result.isError).toBe(true)
    expect(asked.terminal).toEqual([])
  })
})

describe('the chorus_transcript server', () => {
  const quietAdapter = (): ClaudeAdapter =>
    new ClaudeAdapter({
      createQuery: () => {
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

  const readHandler = (asked: TranscriptRequest[]) => {
    const found = transcriptTools((request) => {
      asked.push(request)
      return 'records'
    }).find((each) => each.name === 'read_transcript')
    if (found === undefined) throw new Error('no read_transcript')
    return found.handler as (
      args: unknown,
      extra: unknown
    ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>
  }

  it('reads with every field of the request', async () => {
    const asked: TranscriptRequest[] = []
    const request = {
      skip: 2,
      count: 5,
      conversationId: 'conv-1',
      query: 'retry',
      eventId: 'evt-9',
      offset: 10,
      scope: 'snapshot' as const,
    }
    expect(await readHandler(asked)(request, {})).toEqual({
      content: [{ type: 'text', text: 'records' }],
    })
    expect(asked).toEqual([request])
  })

  it('reports invalid arguments as an error without reading', async () => {
    const asked: TranscriptRequest[] = []
    const result = await readHandler(asked)({ count: 99 }, {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/^Invalid arguments: /)
    expect(asked).toEqual([])
  })

  it('allows the read without asking', async () => {
    const options = await optionsFor({ ...BASE, transcript: () => 'history' })
    expect(await settledWithin(ask(options, READ_TRANSCRIPT_TOOL))).toEqual({
      behavior: 'allow',
      updatedInput: { lines: 5 },
    })
  })

  it('marks a session registered only when it was given a reader', async () => {
    const adapter = quietAdapter()
    expect((await adapter.start({ ...BASE, transcript: () => 'history' })).transcriptTool).toBe(
      'registered'
    )
    expect((await adapter.start(BASE)).transcriptTool).toBeUndefined()
  })
})
