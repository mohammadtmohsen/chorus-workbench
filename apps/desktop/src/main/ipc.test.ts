import { describe, expect, it, vi } from 'vitest'
import type { ChorusRuntime } from './runtime.js'

const showOpenDialog = vi.fn()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp/chorus-test' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  // `settings:write` applies the appearance as it writes, because
  // `themeSource` is what `prefers-color-scheme` answers from. A plain object
  // is enough: the assignment is the whole behaviour.
  nativeTheme: { themeSource: 'system' },
  /*
   * A keychain that works, so the secret store takes its real path rather than
   * its refuse-to-store one. Base64 stands in for encryption: what is asserted
   * below is that the value never crosses back to a renderer, and a reversible
   * stand-in makes a leak *easier* to detect, not harder.
   */
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

const { buildHandlers } = await import('./ipc.js')

/**
 * Which paths a transcript row may open, decided in main.
 *
 * The path comes off agent output by way of the renderer, and is about to be
 * handed to `code -g`. `isInside` is segment-wise on purpose — `/p/a-old` is not
 * inside `/p/a` — and these are the cases that would otherwise be found by a
 * user opening someone else's file.
 */
describe('ide:openFile', () => {
  const open = async (cwd: string, path: string) => {
    const runtime = { projectDirectory: () => cwd } as unknown as ChorusRuntime
    return (await (buildHandlers(runtime)['ide:openFile'] as (r: unknown) => Promise<unknown>)({
      conversationId: 'c1',
      path,
    })) as { ok: boolean; reason: string | null }
  }

  /*
   * `toMatchObject`, not `toEqual`: the refusal now carries the path it refused
   * and the folder it measured against, so the message can name them. What these
   * guard is the *reason*, which is unchanged.
   */
  it('refuses a path outside the project', async () => {
    expect(await open('/p/a', '/p/b/secret.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses a sibling whose name merely starts the same', async () => {
    expect(await open('/p/a', '/p/a-old/rate.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses an escape through ..', async () => {
    expect(await open('/p/a', '../b/secret.ts')).toMatchObject({
      ok: false,
      reason: 'outside-project',
    })
  })

  it('refuses everything when the conversation has no project folder', async () => {
    expect(await open('', '/p/a/rate.ts')).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  it('refuses when the conversation is no longer open', async () => {
    const runtime = {
      projectDirectory: () => {
        throw new Error('Conversation "c1" is not active')
      },
    } as unknown as ChorusRuntime
    const result = await (
      buildHandlers(runtime)['ide:openFile'] as (r: unknown) => Promise<unknown>
    )({ conversationId: 'c1', path: '/p/a/rate.ts' })
    expect(result).toMatchObject({ ok: false, reason: 'outside-project' })
  })

  /*
   * **Only refusals are asserted here, deliberately.** A contained path reaches
   * `code -g` for real — there is no seam between this handler and
   * `extensionDeps()` — so a "lets it through" test spawns VS Code on whoever
   * runs `pnpm check`. It did, twice, before this comment replaced it.
   *
   * Nothing is lost that matters. The refusals are the half with teeth, the
   * segment-wise comparison behind them has its own tests in
   * `ide-protocol/src/paths.test.ts`, and the positive path is what driving the
   * app checks.
   */
})

/*
 * `conversation:chooseCwd` had five tests here and they are gone with the
 * channel. They asserted that picking a folder repointed a conversation, which
 * is the operation Phase 2 removed: a Conversation belongs to exactly one
 * Project, and moving a project moves every conversation in it at once.
 *
 * What replaces them tests the two halves of that: a conversation starts inside
 * a project it is given, and the channels that could move a room no longer
 * exist.
 *
 * **These three used to assert the opposite, and were left behind by Phase 9.**
 * They required `conversation:start` to route through `startConversationIn` and
 * carry a `cwd`, adopting the directory on the way past — with a comment calling
 * the projectId route "the bug this routing exists to prevent". That was true
 * while a conversation was the thing a person created first. Phase 9 made the
 * Project the unit: `project:adopt` above turns a folder into a project, and a
 * conversation is then started *inside* one and can no longer name a directory
 * at all. So the old assertion had inverted into a test demanding the behaviour
 * the architecture forbids — and because the fake runtime only carried the
 * method the test expected, it failed as `startConversation is not a function`
 * rather than as a disagreement about the contract.
 */
describe('conversation:start', () => {
  const started = {
    conversationId: 'c1',
    participants: ['claude'] as const,
    profileId: 'read-only',
    cwd: '/tmp/repo',
    title: 'repo',
  }

  const startWith = async (request: unknown) => {
    const startConversation = vi.fn((_options: Record<string, unknown>) => Promise.resolve(started))
    const runtime = { startConversation } as unknown as ChorusRuntime
    await (buildHandlers(runtime)['conversation:start'] as (r: unknown) => Promise<unknown>)(
      request
    )
    return startConversation
  }

  it('starts inside the project it was given, and passes no directory', async () => {
    /*
     * The Phase 9 invariant at the IPC boundary. `project:adopt` is the only
     * thing that turns a folder into a project, so by the time this channel is
     * reached the id exists and the room is being placed inside it. A `cwd`
     * arriving here would mean a conversation choosing its own directory, which
     * is precisely what the Project-as-unit hierarchy removes.
     */
    const startConversation = await startWith({ projectId: 'p1' })
    expect(startConversation).toHaveBeenCalledWith({ projectId: 'p1' })
    expect(Object.keys(startConversation.mock.calls[0]?.[0] ?? {})).not.toContain('cwd')
  })

  it('passes no cast, even when one is sent', async () => {
    /*
     * The cast is main's, and this is the channel where it stopped being the
     * renderer's. It used to forward `agents` — filled from `settings.json` —
     * so a new conversation opened with whatever that file held and a project
     * showing three agents got two. Asserted by sending one anyway: dropping
     * the field from the schema is not the same as the handler ignoring it,
     * and only the second is what makes the cast un-gettable-wrong.
     */
    const startConversation = await startWith({ agents: ['claude'], projectId: 'p1' })
    expect(Object.keys(startConversation.mock.calls[0]?.[0] ?? {})).not.toContain('agents')
  })

  it('omits an absent profile rather than passing undefined through', async () => {
    const startConversation = await startWith({ projectId: 'p1' })
    expect(Object.keys(startConversation.mock.calls[0]?.[0] ?? {})).not.toContain('profileId')
  })

  it('passes a profile when one is given', async () => {
    const startConversation = await startWith({
      projectId: 'p1',
      profileId: 'trusted',
    })
    expect(startConversation).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'trusted' })
    )
  })
})

describe('the channels that could move a conversation', () => {
  /*
   * A guard rather than a formality. The renderer's controls are gone, but a
   * live handler would let anything with the preload bridge repoint a room —
   * and the whole invariant is that this is not expressible, not that nothing
   * currently asks for it.
   */
  it('are not registered at all', () => {
    const handlers = buildHandlers({} as unknown as ChorusRuntime) as Record<string, unknown>
    expect(handlers['conversation:setCwd']).toBeUndefined()
    expect(handlers['conversation:chooseCwd']).toBeUndefined()
  })
})

/**
 * The credential goes in and never comes out.
 *
 * This is the whole reason `agent-secrets.ts` exists as its own module rather
 * than reusing `workbench-secrets.ts`: that store is reachable by name from any
 * workbench surface through a generic `readSecret(key)`. Nothing asserts the
 * absence of a channel, so what is asserted here is the property that channel
 * would break — the key is not in anything main hands back.
 */
describe('the DeepSeek key', () => {
  const KEY = 'sk-do-not-echo-this-anywhere'

  const handlers = () => buildHandlers({} as unknown as ChorusRuntime)
  const write = async (patch: unknown): Promise<Record<string, unknown>> =>
    (handlers()['settings:write'] as unknown as (r: unknown) => Promise<Record<string, unknown>>)(
      patch
    )
  const read = async (): Promise<Record<string, unknown>> =>
    (handlers()['settings:read'] as unknown as () => Promise<Record<string, unknown>>)()

  it('is never in the answer to the write that set it', async () => {
    const after = await write({ deepseekApiKey: KEY })
    expect(after['deepseekKeySet']).toBe(true)
    expect(after['deepseekApiKey']).toBeUndefined()
    // The whole payload, not just the fields we thought to name.
    expect(JSON.stringify(after)).not.toContain(KEY)
  })

  it('is never in a later read either', async () => {
    await write({ deepseekApiKey: KEY })
    const settings = await read()
    expect(settings['deepseekKeySet']).toBe(true)
    expect(JSON.stringify(settings)).not.toContain(KEY)
  })

  /*
   * The control. Without it the two assertions above pass on a store that never
   * saved anything — "the key is not in the payload" is trivially true of a key
   * that was dropped on the floor.
   */
  it('reports no key once it is cleared, and reports one while it is set', async () => {
    await write({ deepseekApiKey: KEY })
    expect((await read())['deepseekKeySet']).toBe(true)
    const cleared = await write({ deepseekApiKey: '' })
    expect(cleared['deepseekKeySet']).toBe(false)
    expect((await read())['deepseekKeySet']).toBe(false)
  })

  it('leaves a stored key alone when the patch does not mention it', async () => {
    await write({ deepseekApiKey: KEY })
    const after = await write({ cwd: '/tmp/elsewhere' })
    expect(after['deepseekKeySet']).toBe(true)
  })
})

describe('settings:write and the per-agent maps', () => {
  const write = async (patch: unknown): Promise<{ models: Record<string, string> }> => {
    const handler = buildHandlers({} as unknown as ChorusRuntime)['settings:write'] as unknown as (
      r: unknown
    ) => Promise<{ models: Record<string, string> }>
    return handler(patch)
  }

  it('keeps the other agent’s model when only one is sent', async () => {
    /*
     * The shape of the bug: `{ ...current, ...request }` is shallow, so a patch
     * naming one agent replaces the whole map and clears the other's value —
     * with nothing on screen to show it had happened.
     */
    await write({ models: { claude: 'opus' } })
    await write({ models: { codex: 'gpt-5.6-sol' } })
    const after = await write({})
    expect(after.models).toEqual({ claude: 'opus', codex: 'gpt-5.6-sol', deepseek: '' })
  })

  it('keeps the other agent’s effort too', async () => {
    await write({ efforts: { claude: 'high' } })
    const after = await write({ efforts: { codex: 'ultra' } })
    expect(after).toMatchObject({ efforts: { claude: 'high', codex: 'ultra' } })
  })
})

/**
 * The transcript read, and the one ordering that makes it correct.
 *
 * `throughSeq` is taken **before** the rows are read. That is not incidental: it
 * is the value the renderer advances `lastSeq` to, and it is what stops a
 * conversation whose newest events are all ignored types from re-querying the
 * same range on every push, forever.
 *
 * Taking it *after* the read would be the tempting simplification and is wrong
 * in the other direction — it would claim to have covered an event appended
 * during the read that the read did not return, and that event would then never
 * be fetched. Before-the-read can only ever under-claim, and under-claiming
 * costs one redundant query rather than a missing message.
 */
describe('conversation:transcript', () => {
  const EVENTS = [
    {
      seq: 1,
      id: 'e1',
      conversationId: 'c1',
      actor: 'claude',
      type: 'user.message',
      payload: {},
      createdAt: 1,
    },
    {
      seq: 2,
      id: 'e2',
      conversationId: 'c1',
      actor: 'claude',
      type: 'agent.message.completed',
      payload: {},
      createdAt: 2,
    },
  ]

  const EMPTY_STATE = { approvals: [], questions: [], working: [], usageByActor: {} }

  function runtimeFor(lastSeq: number) {
    const calls: {
      kind: 'history' | 'page'
      conversationId: string
      afterSeq?: number
      beforeSeq?: number
      limit?: number
      at: number
    }[] = []
    let position = lastSeq
    const runtime = {
      // Reading moves the log on, so a handler that asked for the position
      // afterwards would get a different — and wrong — answer.
      transcriptHistory: (conversationId: string, afterSeq?: number) => {
        calls.push({
          kind: 'history',
          conversationId,
          ...(afterSeq === undefined ? {} : { afterSeq }),
          at: position,
        })
        position += 5
        return EVENTS
      },
      transcriptPage: (conversationId: string, limit: number, beforeSeq?: number) => {
        calls.push({
          kind: 'page',
          conversationId,
          limit,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          at: position,
        })
        position += 5
        return EVENTS
      },
      transcriptState: () => EMPTY_STATE,
      logPosition: () => position,
    } as unknown as ChorusRuntime
    return { runtime, calls }
  }

  const read = async (runtime: ChorusRuntime, request: unknown) =>
    (await (buildHandlers(runtime)['conversation:transcript'] as (r: unknown) => Promise<unknown>)(
      request
    )) as { events: { seq: number }[]; throughSeq: number }

  it('reports the log position from before the read, not after', async () => {
    const { runtime } = runtimeFor(42)
    const result = await read(runtime, { conversationId: 'c1' })
    // 42, not 47: the read moved the log on and the mark predates it.
    expect(result.throughSeq).toBe(42)
  })

  it('returns the conversation the caller asked for', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c9', afterSeq: 3 })
    expect(calls).toEqual([{ kind: 'history', conversationId: 'c9', afterSeq: 3, at: 10 }])
  })

  it('omits afterSeq entirely on a first read rather than sending zero', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1' })
    expect(calls[0]).not.toHaveProperty('afterSeq')
  })

  /*
   * Three questions on one channel, and they must not blur into each other.
   * `afterSeq` is "what has happened since"; `limit` is "the newest page";
   * neither is "the whole conversation", which is what no `limit` still means.
   */
  it('reads a page when asked for one, not the whole conversation', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1', limit: 400 })
    expect(calls).toEqual([{ kind: 'page', conversationId: 'c1', limit: 400, at: 10 }])
  })

  it('walks backwards with beforeSeq', async () => {
    const { runtime, calls } = runtimeFor(10)
    await read(runtime, { conversationId: 'c1', beforeSeq: 900, limit: 400 })
    expect(calls[0]).toMatchObject({ kind: 'page', beforeSeq: 900, limit: 400 })
  })

  it('sends state on a cold read, because a page cannot contain it', async () => {
    const { runtime } = runtimeFor(10)
    const result = (await read(runtime, { conversationId: 'c1', limit: 400 })) as unknown as {
      state?: unknown
    }
    expect(result.state).toEqual(EMPTY_STATE)
  })

  it('withholds state from a catch-up, which would overwrite live cards', async () => {
    /*
     * An incremental read is folded into a view that already holds the state,
     * and the queried snapshot is from a moment ago — re-applying it would put
     * back an approval the user has just decided.
     */
    const { runtime } = runtimeFor(10)
    const result = (await read(runtime, { conversationId: 'c1', afterSeq: 3 })) as unknown as {
      state?: unknown
    }
    expect(result.state).toBeUndefined()
  })

  it('flattens the rows the renderer draws', async () => {
    const { runtime } = runtimeFor(10)
    const result = await read(runtime, { conversationId: 'c1' })
    expect(result.events.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('project:adoptRemote', () => {
  const ROOT = 'C:/TPA-MEDEXA/MasterTPABackend'
  const adopted = { id: 'p1', name: 'MasterTPABackend', root: ROOT }

  const handlerWith = (): {
    readonly adoptRemote: ReturnType<typeof vi.fn>
    readonly adopt: (request: unknown) => Promise<unknown>
  } => {
    showOpenDialog.mockReset()
    const adoptRemote = vi.fn(() => ({ project: adopted, created: true }))
    const runtime = { projects: { adoptRemote } } as unknown as ChorusRuntime
    const adopt = buildHandlers(runtime)['project:adoptRemote'] as (r: unknown) => Promise<unknown>
    return { adoptRemote, adopt }
  }

  it('asks where the agents run, then adopts the remote root with that folder', async () => {
    const { adoptRemote, adopt } = handlerWith()
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/me/tpa-be'] })

    await expect(adopt({ host: 'TPA-BE', root: ROOT })).resolves.toEqual({
      project: { ...adopted, created: true },
    })
    expect(adoptRemote).toHaveBeenCalledWith({
      host: 'tpa-be',
      root: ROOT,
      agentCwd: '/Users/me/tpa-be',
    })
  })

  it('adopts nothing when the folder dialog is cancelled', async () => {
    const { adoptRemote, adopt } = handlerWith()
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    await expect(adopt({ host: 'tpa-be', root: ROOT })).resolves.toEqual({ project: null })
    expect(adoptRemote).not.toHaveBeenCalled()
  })

  it('refuses a bad host or an unanchored root before any dialog opens', async () => {
    const { adoptRemote, adopt } = handlerWith()

    await expect(adopt({ host: '', root: ROOT })).rejects.toThrow('Not a usable remote host')
    await expect(adopt({ host: '-oProxyCommand=x', root: ROOT })).rejects.toThrow(
      'Not a usable remote host'
    )
    await expect(adopt({ host: 'tpa-be', root: 'MasterTPABackend' })).rejects.toThrow(
      'A remote project root must be an absolute path'
    )
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(adoptRemote).not.toHaveBeenCalled()
  })
})

describe('project:checkRemoteHost', () => {
  it('refuses the host string itself before any ssh runs', async () => {
    const handlers = buildHandlers({} as unknown as ChorusRuntime)
    const check = handlers['project:checkRemoteHost'] as (r: unknown) => Promise<unknown>
    await expect(check({ host: '' })).rejects.toThrow('Not a usable remote host')
    await expect(check({ host: '-oProxyCommand=x' })).rejects.toThrow('Not a usable remote host')
  })
})
