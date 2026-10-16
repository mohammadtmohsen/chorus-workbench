import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import { composeCatchup, composeHistory, withCatchup } from './catchup.js'
import { CONTEXT_DEFERRED_PREFIX } from './transcript-lines.js'

let seq = 0

function said(actor: string, text: string): StoredEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor: actor as StoredEvent['actor'],
    type: actor === 'user' ? 'user.message' : 'agent.message.completed',
    payload:
      actor === 'user'
        ? { type: 'user.message', text }
        : { type: 'agent.message.completed', itemRef: `i${String(seq)}`, text },
    createdAt: seq,
    schemaVersion: 1,
  }
}

const bytesOf = (text: string | null): number => new TextEncoder().encode(text ?? '').length

describe('discussion context', () => {
  it("includes the same agent's other native session when requested for Chat updates", () => {
    const ownWork = said(
      'codex',
      'WORK_BEGIN\n' + 'Implementation details.\n'.repeat(2000) + 'WORK_END'
    )
    const input = {
      recipient: 'codex' as const,
      participants: ['codex'] as const,
      events: [ownWork],
    }
    expect(composeCatchup(input)).toBeNull()
    const context = composeCatchup({ ...input, includeOwnMessages: true })
    expect(context).toContain('WORK_BEGIN')
    expect(context).toContain('WORK_END')
    expect(context).toContain(`[#${String(ownWork.seq)} ${ownWork.id}]`)
    expect(context).not.toContain('continuing an earlier conversation')
    expect(bytesOf(context)).toBeLessThanOrEqual(12_000)
  })

  it('delivers the own Discussion answer to Work within the byte ceiling, with a way back to all of it', () => {
    const ownWork = said('codex', 'This Work reply is already in the primary session.')
    const ownChat = said(
      'codex',
      `CHAT_PLAN_BEGIN\n${'Full plan detail.\n'.repeat(2500)}CHAT_PLAN_END`
    )
    if (ownChat.payload.type !== 'agent.message.completed') throw new Error('Unexpected event')
    const events: StoredEvent[] = [
      ownWork,
      { ...ownChat, payload: { ...ownChat.payload, mode: 'discussion' } },
    ]
    const input = { recipient: 'codex' as const, participants: ['codex'] as const, events }
    const context = composeCatchup({ ...input, includeOwnDiscussion: true })
    expect(context).toContain('CHAT_PLAN_BEGIN')
    expect(context).toContain('CHAT_PLAN_END')
    expect(context).toContain('[trimmed]')
    expect(context).toContain(`read_transcript eventId ${ownChat.id}`)
    expect(context).not.toContain('This Work reply is already in the primary session.')
    expect(bytesOf(context)).toBeLessThanOrEqual(12_000)
    expect(composeCatchup(input)).toBeNull()
  })

  it('never lets a Discussion exchange lift the ceiling, headers included', () => {
    const turns = Array.from({ length: 30 }, (_, index) => {
      const event = said(
        index % 2 === 0 ? 'user' : 'claude',
        `نقاش ${String(index)} ${'تفصيل '.repeat(900)}`
      )
      if (
        event.payload.type === 'user.message' ||
        event.payload.type === 'agent.message.completed'
      ) {
        return { ...event, payload: { ...event.payload, mode: 'discussion' as const } }
      }
      return event
    })
    for (const maxTotalBytes of [12_000, 3_000, 900]) {
      const context = composeCatchup({
        recipient: 'codex',
        participants: PARTICIPANTS,
        events: turns,
        includeOwnDiscussion: true,
        maxTotalBytes,
      })
      expect(bytesOf(context), String(maxTotalBytes)).toBeLessThanOrEqual(maxTotalBytes)
      expect(context).toContain('--- transcript ---')
    }
  })

  it('still says what was missed when there is no room to show it', () => {
    const missed = [said('claude', 'decided to keep the retry'), said('user', 'agreed')]
    for (const maxTotalBytes of [0, 120]) {
      const readable = composeCatchup({
        recipient: 'codex',
        participants: PARTICIPANTS,
        events: missed,
        maxTotalBytes,
      })
      expect(readable, String(maxTotalBytes)).toContain('2 entries were added')
      expect(readable?.startsWith(CONTEXT_DEFERRED_PREFIX)).toBe(true)
      expect(readable).toContain('read_transcript')
      const unreadable = composeCatchup({
        recipient: 'codex',
        participants: PARTICIPANTS,
        events: missed,
        maxTotalBytes,
        retrieval: false,
      })
      expect(unreadable).toContain('2 entries were added')
      expect(unreadable?.startsWith(CONTEXT_DEFERRED_PREFIX)).toBe(true)
      expect(unreadable).not.toContain('read_transcript')
    }
  })

  it('leaves out the transcript hint when the session cannot read the transcript', () => {
    const long = said('claude', `START${'x'.repeat(5_000)}END`)
    const context = composeCatchup({
      recipient: 'codex',
      participants: PARTICIPANTS,
      events: [long],
      retrieval: false,
    })
    expect(context).toContain('[trimmed]')
    expect(context).not.toContain('read_transcript')
  })

  it('keeps discussion prompts distinct from instructions to implement', () => {
    const question = said('user', 'Write a plan file.')
    const answer = said('claude', 'Here is a plan in chat.')
    if (
      question.payload.type !== 'user.message' ||
      answer.payload.type !== 'agent.message.completed'
    ) {
      throw new Error('Unexpected fixture event')
    }
    const events: StoredEvent[] = [
      { ...question, payload: { ...question.payload, mode: 'discussion' } },
      { ...answer, payload: { ...answer.payload, mode: 'discussion' } },
    ]
    const history = composeHistory(events, { skip: 0, count: 20 })
    expect(history).toContain(
      'user (read-only discussion, not an implementation instruction): Write a plan file.'
    )
    expect(history).toContain('claude (read-only discussion): Here is a plan in chat.')
  })
})

/** Anything claude did rather than said. */
function did(type: StoredEvent['type'], payload: StoredEvent['payload']): StoredEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor: 'claude',
    type,
    payload,
    createdAt: seq,
    schemaVersion: 1,
  }
}

function ran(ref: string, command: string[]): StoredEvent {
  return did('command.started', { type: 'command.started', itemRef: ref, command, cwd: '/tmp' })
}

function exited(ref: string, exitCode: number | null): StoredEvent {
  return did('command.completed', { type: 'command.completed', itemRef: ref, exitCode })
}

function printed(ref: string, chunk: string): StoredEvent {
  return did('command.output', { type: 'command.output', itemRef: ref, stream: 'stdout', chunk })
}

/** Files an agent actually changed, with how the patch ended. */
function changed(n: number, outcome: 'applied' | 'failed' | 'declined' = 'applied'): StoredEvent {
  return did('file.change.completed', {
    type: 'file.change.completed',
    itemRef: 'i1',
    files: Array.from({ length: n }, (_, i) => ({
      path: `src/f${String(i)}.ts`,
      change: 'modified' as const,
      added: 1,
      removed: 0,
      // Catch-up names files and never draws one, but the payload carries the
      // diff the card renders — so the fixture has to be a real payload.
      patch: `diff --git a/src/f${String(i)}.ts b/src/f${String(i)}.ts\n@@ -1 +1 @@\n-a\n+b\n`,
    })),
    outcome,
  })
}

const PARTICIPANTS: AgentId[] = ['codex', 'claude']

function catchup(
  events: StoredEvent[],
  overrides: Partial<Parameters<typeof composeCatchup>[0]> = {}
): string {
  return (
    composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events, ...overrides }) ?? ''
  )
}

/** The person editing a file themselves, in Chorus. */
function edited(path: string, added: number, removed: number): StoredEvent {
  seq += 1
  return {
    seq,
    id: `e${String(seq)}`,
    conversationId: 'c1',
    actor: 'user',
    type: 'file.edited.byUser',
    payload: { type: 'file.edited.byUser', path, added, removed },
    createdAt: seq,
    schemaVersion: 1,
  }
}

describe('composeCatchup', () => {
  it('replays what the other agent and the user said', () => {
    const text = catchup([
      said('user', 'what mcp do we have'),
      said('claude', 'You have 6 MCP servers connected.'),
    ])

    expect(text).toContain('user: what mcp do we have')
    expect(text).toContain('claude: You have 6 MCP servers connected.')
    // The agent has to be able to tell this from the user talking to it.
    expect(text).toContain('[Chorus]')
    expect(text).toContain('shared conversation')
  })

  /**
   * The reason `file.edited.byUser` is a log event at all.
   *
   * Without these lines an agent that read the file at the start of a turn
   * composes its patch against a version that no longer exists, overwrites the
   * person's fix, and nothing in the transcript explains why.
   */
  it('marks every entry with its sequence and event id, and names the conversation', () => {
    const asked = said('user', 'what mcp do we have')
    const answered = said('claude', 'You have 6 MCP servers connected.')
    const command = ran('ref-mark', ['pnpm', 'test'])
    const finished = exited('ref-mark', 0)
    const text = catchup([asked, answered, command, finished])
    expect(text).toContain('from conversation c1')
    expect(text).toContain(`[#${String(asked.seq)} ${asked.id}] user: what mcp do we have`)
    expect(text).toContain(`[#${String(answered.seq)} ${answered.id}] claude: You have 6 MCP`)
    expect(text).toContain(
      `[#${String(finished.seq)} ${finished.id}] · claude ran \`pnpm test\` → ok`
    )
  })

  it('tells the agent when the user edited a file', () => {
    const text = catchup([edited('src/auth.ts', 3, 1)])
    expect(text).toContain('src/auth.ts')
    expect(text).toMatch(/re-?read/i)
  })

  it('keeps a hand edit even when the budget drops activity', () => {
    // Activity is dropped before speech when the budget binds. "The file you
    // are editing is not the file you read" is not supporting detail — it
    // changes what the agent should do next — so it is carried as speech.
    const noise = Array.from({ length: 40 }, (_, i) =>
      ran(`r${String(i)}`, ['echo', 'x'.repeat(60)])
    )
    const text = catchup([...noise, edited('src/auth.ts', 3, 1)], { maxTotalChars: 600 })
    expect(text).toContain('src/auth.ts')
  })

  it('names who else is in the room', () => {
    const text = catchup([said('user', 'hi')])
    expect(text).toContain('and claude')
    expect(text).not.toContain('and codex')
  })

  it('returns null when nothing was missed', () => {
    expect(
      composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events: [] })
    ).toBeNull()
  })

  it("skips the recipient's own events", () => {
    // They are already in its own context; replaying pays twice for the words.
    const text = catchup([said('codex', 'I already said this'), said('claude', 'and I said this')])
    expect(text).not.toContain('I already said this')
    expect(text).toContain('and I said this')
  })

  it('ignores reasoning, approvals and bookkeeping', () => {
    // Private working and Chorus's own record-keeping are not the conversation.
    const events = [
      did('agent.reasoning.delta', { type: 'agent.reasoning.delta', itemRef: 'i1', text: 'hmm' }),
      did('approval.decided', {
        type: 'approval.decided',
        approvalId: 'a1',
        outcome: 'allow',
        scope: 'once',
        decidedBy: 'user',
        policyRuleId: null,
      }),
      did('usage.updated', {
        type: 'usage.updated',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
      }),
    ]
    expect(composeCatchup({ recipient: 'codex', participants: PARTICIPANTS, events })).toBeNull()
  })

  it('reports a command that succeeded as one line, without its output', () => {
    const text = catchup([
      ran('c1', ['pnpm', 'test']),
      printed('c1', 'all 400 tests passed'),
      exited('c1', 0),
    ])

    expect(text).toContain('· claude ran `pnpm test` → ok')
    // Nobody asks about the output of a command that worked.
    expect(text).not.toContain('all 400 tests passed')
  })

  it('carries the tail of the output when a command failed', () => {
    // "Why did that fail" is exactly the question the other agent gets asked.
    const text = catchup([
      ran('c1', ['pnpm', 'test']),
      printed('c1', 'TypeError: cannot read property id of undefined'),
      exited('c1', 1),
    ])

    expect(text).toContain('failed (exit 1)')
    expect(text).toContain('TypeError: cannot read property id of undefined')
  })

  it('keeps only the tail of a long output', () => {
    const text = catchup([
      ran('c1', ['pnpm', 'build']),
      printed('c1', `${'noise '.repeat(2_000)}the actual failure`),
      exited('c1', 2),
    ])

    expect(text).toContain('the actual failure')
    expect(text.length).toBeLessThan(1_500)
  })

  it('says a command ran even when no result was recorded', () => {
    // Silence would read as "never ran", which is the wrong thing to believe.
    expect(catchup([ran('c1', ['pnpm', 'build'])])).toContain(
      '· claude ran `pnpm build` (no result recorded)'
    )
  })

  it('lists changed files, and counts them once the list gets long', () => {
    expect(catchup([changed(2)])).toContain('· claude changed src/f0.ts, src/f1.ts')
    expect(catchup([changed(9)])).toContain('and 6 more')
  })

  it('reports what landed, not what was offered', () => {
    /*
     * `file.change.proposed` fires when the operation *starts*. Replaying it
     * sent the other agent looking for edits the user had declined and edits
     * that failed — both of which leave the file exactly as it was.
     */
    const proposed = did('file.change.proposed', {
      type: 'file.change.proposed',
      itemRef: 'i1',
      files: [{ path: 'src/only.ts', patch: '' }],
    })
    expect(catchup([proposed])).not.toContain('src/only.ts')
    expect(catchup([changed(1, 'declined')])).not.toContain('src/f0.ts')
    expect(catchup([changed(1, 'failed')])).not.toContain('src/f0.ts')
    expect(catchup([changed(1)])).toContain('· claude changed src/f0.ts')
  })

  it('replays a permission change, which is a fact about the room', () => {
    const text = catchup([
      did('policy.changed', {
        type: 'policy.changed',
        profileId: 'trusted',
        previousProfileId: 'read-only',
      }),
    ])
    expect(text).toContain('· the user changed permissions to "trusted"')
  })

  it('reports an error that stuck, not a restart it recovered from', () => {
    const text = catchup([
      did('error.raised', {
        type: 'error.raised',
        message: 'agent claude exited unexpectedly; restarting',
        recoverable: true,
      }),
      did('error.raised', {
        type: 'error.raised',
        message: 'That directory does not exist: /nope',
        recoverable: false,
      }),
    ])

    expect(text).toContain('· claude hit an error: That directory does not exist: /nope')
    expect(text).not.toContain('restarting')
  })

  it('keeps everything in the order it happened', () => {
    const text = catchup([
      said('user', 'run the tests'),
      ran('c1', ['pnpm', 'test']),
      exited('c1', 0),
      said('claude', 'all green'),
    ])

    expect(text.indexOf('run the tests')).toBeLessThan(text.indexOf('pnpm test'))
    expect(text.indexOf('pnpm test')).toBeLessThan(text.indexOf('all green'))
  })

  it('sheds activity before speech when the budget binds', () => {
    // Losing "claude ran the tests" costs less than losing what claude said.
    const events = [
      said('claude', 'here is the summary that matters'),
      ...Array.from({ length: 40 }, (_, i) => [
        ran(`c${String(i)}`, ['rg', `pattern-${String(i)}`]),
        exited(`c${String(i)}`, 0),
      ]).flat(),
    ]

    const text = catchup(events, { maxTotalChars: 600 })
    expect(text).toContain('here is the summary that matters')
    expect(text).not.toContain('pattern-0`')
  })

  it('keeps the most recent lines when over budget and says what it dropped', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      said('user', `message ${String(i)} `.repeat(20))
    )
    const text = catchup(events, { maxTotalBytes: 1_000 })

    expect(text).toContain('message 9')
    expect(text).not.toContain('message 0:')
    expect(text).toMatch(/\(\d+ earlier entries omitted\)/)
  })

  it('trims a very long message from the middle, keeping both ends', () => {
    const text = catchup([said('claude', `START${'x'.repeat(5_000)}END`)], { maxMessageChars: 200 })

    expect(text).toContain('START')
    expect(text).toContain('END')
    expect(text).toContain('[trimmed]')
    expect(text.length).toBeLessThan(1_000)
  })
})

describe('withCatchup', () => {
  it('leaves the message alone when nothing was missed', () => {
    // The single-agent case must cost exactly nothing.
    expect(
      withCatchup({ recipient: 'codex', participants: ['codex'], events: [] }, 'run the tests')
    ).toBe('run the tests')
  })

  it('puts the live message last, marked as the one to answer', () => {
    const out = withCatchup(
      {
        recipient: 'codex',
        participants: PARTICIPANTS,
        events: [said('claude', 'I finished the refactor')],
      },
      'review it'
    )
    expect(out.indexOf('I finished the refactor')).toBeLessThan(out.indexOf('review it'))
    expect(out).toContain('The user now says to you:')
    expect(out.endsWith('review it')).toBe(true)
  })
})
