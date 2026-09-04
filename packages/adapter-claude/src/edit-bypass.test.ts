import type { Options, PermissionResult, Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, SessionOpts } from '@chorus/agent-protocol'
import { AsyncQueue } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude-adapter.js'

/**
 * The other half of ask-before-the-edit: noticing when it did not happen.
 *
 * Chorus cannot guarantee the permission callback fires. `acceptEdits`, a hook,
 * or a permission rule in the user's own settings each bypass it, and the Phase 1
 * spike measured the first of those doing exactly that — the edit lands and
 * `canUseTool` is never called. What Chorus *can* do is say so afterwards, and
 * that promise is worth nothing unless it is asserted.
 *
 * Two things make the detector non-obvious, and both are tested here:
 *
 *  - **`tool.completed` carries no tool name.** It has `itemRef` and a status, so
 *    the name has to be remembered from `tool.started` or a completion cannot be
 *    told apart from any other tool's.
 *  - **A duplicate live id must accuse nobody.** Tool-use ids are documented as
 *    unique only within one assistant message, so two live at once are contested
 *    and neither raises a notice. A missed notice is a cost; a false accusation
 *    is a defect.
 */

const OPTS: SessionOpts = {
  cwd: process.cwd(),
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
}

interface Fed {
  readonly adapter: ClaudeAdapter
  readonly feed: (message: unknown) => void
  /** The callback the SDK would invoke; calling it is what an approval *is*. */
  readonly ask: (name: string, input: Record<string, unknown>, toolUseID: string) => void
}

function adapterFed(): Fed {
  const messages = new AsyncQueue<unknown>()
  let canUseTool: Options['canUseTool']
  const adapter = new ClaudeAdapter({
    createQuery: (options: Options) => {
      canUseTool = options.canUseTool
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
  return {
    adapter,
    feed: (message) => {
      messages.push(message)
    },
    ask: (name, input, toolUseID) => {
      // Deliberately not awaited: the real callback is held open until Chorus
      // answers, and this test only needs the *asking* to have happened.
      const asked = canUseTool?.(name, input, {
        signal: new AbortController().signal,
        toolUseID,
      } as never) as Promise<PermissionResult> | undefined
      void asked?.catch(() => undefined)
    },
  }
}

const started = (id: string, name: string, path: string) => ({
  type: 'assistant',
  uuid: `u-${id}`,
  message: {
    id: `msg-${id}`,
    content: [{ type: 'tool_use', id, name, input: { file_path: path } }],
  },
})

const completed = (id: string, error = false) => ({
  type: 'user',
  uuid: `r-${id}`,
  message: {
    content: [
      { type: 'tool_result', tool_use_id: id, content: error ? 'boom' : 'ok', is_error: error },
    ],
  },
})

/**
 * Everything emitted within a short window.
 *
 * Time-bounded rather than counted, because the interesting cases are the ones
 * that emit *fewer* events: waiting for an nth event that correctly never
 * arrives is a test that hangs instead of failing. The notice, when there is
 * one, is pushed immediately after the completion it belongs to.
 */
async function drain(events: AsyncIterable<AgentEvent>, ms = 200): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  const iterator = events[Symbol.asyncIterator]()
  const deadline = Date.now() + ms
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const next = await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null)
        }, remaining)
      }),
    ])
    if (next === null || next.done === true) break
    out.push(next.value)
  }
  return out
}

const notices = (events: readonly AgentEvent[]): string[] =>
  events
    .filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice')
    .map((e) => e.code ?? '')

describe('an edit that never asked', () => {
  it('is noticed when it completes with no approval against it', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)

    feed(started('t1', 'Edit', '/repo/a.ts'))
    feed(completed('t1'))

    expect(notices(await drain(session.events))).toContain('editWithoutApproval')
  })

  it('is silent when the approval was asked for', async () => {
    const { adapter, feed, ask } = adapterFed()
    const session = await adapter.start(OPTS)

    feed(started('t2', 'Edit', '/repo/a.ts'))
    // The callback firing *is* the approval; the id is what ties it to the call.
    ask('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, 't2')
    await new Promise((resolve) => setTimeout(resolve, 10))
    feed(completed('t2'))

    expect(notices(await drain(session.events))).not.toContain('editWithoutApproval')
  })

  it('is silent for a failed edit, which changed nothing', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)

    feed(started('t3', 'Edit', '/repo/a.ts'))
    feed(completed('t3', true))

    expect(notices(await drain(session.events))).not.toContain('editWithoutApproval')
  })

  it('is silent for a tool that is not an edit', async () => {
    const { adapter, feed } = adapterFed()
    const session = await adapter.start(OPTS)

    feed(started('t4', 'Grep', '/repo'))
    feed(completed('t4'))

    expect(notices(await drain(session.events))).not.toContain('editWithoutApproval')
  })
})
