import { collectEvents } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * One class, more than one agent.
 *
 * `ClaudeAdapter` drives DeepSeek as well as Claude — the same `claude` binary
 * with `ANTHROPIC_BASE_URL` pointed elsewhere — so every event it emits has to
 * carry the id of the instance that produced it. Twelve sites named Claude
 * directly before this, ten of them inline in `ClaudeSession` and never reaching
 * `mapping.ts` at all.
 *
 * **The existing `stampsAgentId` conformance check could not have caught them.**
 * It asserts over the events it is handed, and a recorded happy path never
 * produces the error, interrupt, usage or compaction emissions. So this drives
 * every path it can reach under a non-default id and asserts over all of it.
 */

interface Stub {
  push: (message: unknown) => void
  close: () => void
}

function driveable(
  id: 'deepseek',
  env?: Record<string, string | undefined>,
  precondition?: () => string | null,
  models?: readonly { value: string; label: string }[]
) {
  const stubs: Stub[] = []
  let captured: Options | undefined

  const adapter = new ClaudeAdapter({
    id,
    now: () => 1_000,
    ...(env === undefined ? {} : { env: () => env }),
    ...(precondition === undefined ? {} : { precondition }),
    ...(models === undefined ? {} : { models }),
    createQuery: (options) => {
      captured = options
      const messages = new AsyncQueue<unknown>()
      stubs.push({
        push: (m) => {
          messages.push(m)
        },
        close: () => {
          messages.close()
        },
      })
      return {
        [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
        interrupt: () => Promise.resolve({ still_queued: ['a queued message'] }),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      } as unknown as Query
    },
  })

  const latest = (): Stub => {
    const s = stubs.at(-1)
    if (s === undefined) throw new Error('no query created')
    return s
  }

  return { adapter, latest, options: () => captured }
}

const OPTS = {
  cwd: mkdtempSync(join(tmpdir(), 'chorus-identity-')),
  profile: { id: 'read-only', rules: [] },
}

describe('an adapter under a non-default id', () => {
  it('stamps every event it emits, down every path', async () => {
    const { adapter, latest } = driveable('deepseek')
    const session = await adapter.start(OPTS as never)

    // `send` opens the turn, which is its own emission and not a mapped one.
    await session.send({ text: 'go' })
    // Queued work surviving an interrupt is a second inline emission.
    await session.interrupt()

    const stub = latest()
    stub.push({
      type: 'assistant',
      uuid: 'u1',
      session_id: 's1',
      message: { content: [{ type: 'text', text: 'hello' }] },
    })
    stub.push({
      type: 'stream_event',
      uuid: 'u2',
      event: { index: 0, delta: { type: 'text_delta', text: 'hi' } },
    })
    stub.push({
      type: 'assistant',
      uuid: 'u3',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    })
    stub.push({ type: 'result', subtype: 'error_during_execution', uuid: 'r1', session_id: 's1' })
    stub.close()

    const events = await collectEvents(session, 40)

    /*
     * The control. Without it this test passes on an empty stream, which is
     * exactly the shape of assertion C-027 is about — "no event said claude" is
     * trivially true when no event was produced.
     */
    expect(events.length).toBeGreaterThan(3)
    expect(new Set(events.map((e) => e.type)).size).toBeGreaterThan(2)

    expect(events.filter((e) => e.agentId !== 'deepseek')).toEqual([])
  })

  it('sends the injected environment, with ours spread underneath it', async () => {
    const { adapter, options } = driveable('deepseek', {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'ds-test',
    })
    await adapter.start(OPTS as never)

    const env = options()?.env
    expect(env?.['ANTHROPIC_BASE_URL']).toBe('https://api.deepseek.com/anthropic')
    /*
     * `Options.env` REPLACES the child's environment rather than merging with
     * it, so a partial map hands the CLI a process with no PATH and the failure
     * blames the binary.
     */
    expect(env?.['PATH']).toBe(process.env['PATH'])
  })

  it('scrubs an inherited credential rather than letting it win', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'the-users-own-claude-key'
    const { adapter, options } = driveable('deepseek', {
      ANTHROPIC_AUTH_TOKEN: 'ds-test',
    })
    await adapter.start(OPTS as never)

    /*
     * The bug this prevents: `ANTHROPIC_API_KEY` takes precedence over a saved
     * login, so an inherited one would make a DeepSeek session authenticate —
     * and bill — as the user's own Claude account.
     */
    expect(options()?.env?.['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(options()?.env?.['ANTHROPIC_AUTH_TOKEN']).toBe('ds-test')
  })

  it('leaves the environment alone when no override was given', async () => {
    const { adapter, options } = driveable('deepseek')
    await adapter.start(OPTS as never)
    // Omitted entirely, which is how Claude keeps behaving exactly as before.
    expect(options()?.env).toBeUndefined()
  })

  it('answers with a known catalogue instead of asking the CLI', async () => {
    /*
     * The stub's query has no `supportedModels` at all, which is what a CLI too
     * old to be asked looks like — the path that throws "this CLI cannot report
     * its models". Getting the list back proves it was never consulted.
     */
    const KNOWN = [{ value: 'deepseek-flash[1m]', label: 'V4.1 Flash (1M context)' }]
    const { adapter } = driveable('deepseek', undefined, undefined, KNOWN)
    const session = await adapter.start(OPTS as never)
    await expect(session.supportedModels?.()).resolves.toEqual(KNOWN)
  })

  it('still asks the CLI when no catalogue was given', async () => {
    // The control: without this, the test above would pass against an adapter
    // that had stopped asking anyone anything.
    const { adapter } = driveable('deepseek')
    const session = await adapter.start(OPTS as never)
    await expect(session.supportedModels?.()).rejects.toThrow('cannot report its models')
  })

  it('refuses to start at all when a precondition is unmet', async () => {
    const { adapter } = driveable('deepseek', undefined, () => 'DeepSeek needs an API key.')
    /*
     * Refused here rather than left to the CLI. Without it the session starts,
     * the first turn reaches the provider with no credential, and the user meets
     * an authentication error naming neither the cause nor the fix.
     */
    await expect(adapter.start(OPTS as never)).rejects.toThrow('needs an API key')
  })

  it('starts normally once the precondition is met', async () => {
    const { adapter } = driveable('deepseek', undefined, () => null)
    await expect(adapter.start(OPTS as never)).resolves.toBeDefined()
  })

  it('appends a standing instruction instead of replacing the prompt', async () => {
    /*
     * The missing half of a documented pair. `adapter.ts` says "append, in both
     * adapters, or the option means two different things" — Codex implemented
     * it and this did not, so a bilingual conversation was bilingual only when
     * Codex answered, and DeepSeek never saw the instruction at all.
     */
    const { adapter, options } = driveable('deepseek')
    await adapter.start({ ...OPTS, instructions: 'Answer in two languages.' } as never)

    expect(options()?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Answer in two languages.',
    })
  })

  it('omits the field entirely rather than sending a blank one', async () => {
    /*
     * Absent is not the same as empty. A conversation with no instruction has
     * to be byte-for-byte the session it was before this existed, so the
     * provider field is not sent at all.
     */
    const { adapter: none, options: withoutIt } = driveable('deepseek')
    await none.start(OPTS as never)
    expect(withoutIt()?.systemPrompt).toBeUndefined()

    const { adapter: blank, options: withBlank } = driveable('deepseek')
    await blank.start({ ...OPTS, instructions: '' } as never)
    expect(withBlank()?.systemPrompt).toBeUndefined()
  })

  it('does not let a fork inherit it', async () => {
    /*
     * `ForkOpts` extends `SessionOpts`, so the field is reachable from an aside
     * — and an aside already carries its own language prompt. Two instructions
     * about how to write, in one context, argue.
     */
    const { adapter, options } = driveable('deepseek')
    const session = await adapter.start({ ...OPTS, instructions: 'Two languages.' } as never)
    expect(options()?.systemPrompt).toBeDefined()

    await adapter.fork(session.sessionRef === '' ? 'sess-1' : session.sessionRef, {
      ...OPTS,
      instructions: 'Two languages.',
    } as never)
    expect(options()?.systemPrompt).toBeUndefined()
  })

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY']
  })
})

/**
 * The guard the next emission needs.
 *
 * Threading the id through fixes today's sites; it does nothing about the
 * eleventh emission somebody adds next month by copying the tenth. A literal in
 * an `agentId:` position is always wrong in this package now, and that is a
 * thing a file can be read for.
 */
describe('the source itself', () => {
  it('names no agent in an agentId position', () => {
    const src = dirname(fileURLToPath(import.meta.url))
    const offenders = readdirSync(src)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) =>
        readFileSync(join(src, name), 'utf8')
          .split('\n')
          .map((line, i) => ({ name, line, at: i + 1 }))
          .filter(({ line }) => /agentId:\s*'[a-z]+'/.test(line))
          .map(({ name: n, at, line }) => `${n}:${String(at)} ${line.trim()}`)
      )
    expect(offenders).toEqual([])
  })
})
