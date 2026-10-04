import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ProjectReader, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'
import { PROJECT_TOOL_IDS, projectTools } from './project-tool.js'

const BASE: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

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

const ask = (options: Options, name: string): Promise<PermissionResult> => {
  const canUseTool = options.canUseTool
  if (canUseTool === undefined) throw new Error('no permission callback')
  return canUseTool(name, { lines: 5 }, {
    signal: new AbortController().signal,
    toolUseID: `tu-${name}`,
  } as never)
}

const settledWithin = (result: Promise<PermissionResult>): Promise<PermissionResult | 'pending'> =>
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
    return found.handler as (args: unknown, extra: unknown) => ReturnType<typeof found.handler>
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
