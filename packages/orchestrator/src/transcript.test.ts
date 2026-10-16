import type { StoredEvent } from '@chorus/event-store'
import { describe, expect, it } from 'vitest'
import { CONTEXT_DEFERRED_PREFIX } from './transcript-lines.js'
import {
  TRANSCRIPT_FORWARDED_ELSEWHERE,
  TRANSCRIPT_NO_ROOM,
  composeCarryover,
  composeTranscript,
  type CarryoverSource,
} from './transcript.js'

let seq = 0

const bytesOf = (text: string | null): number => new TextEncoder().encode(text ?? '').length

const LONE_SURROGATE = /[\uD800-\uDFFF]/u

function said(
  conversationId: string,
  actor: 'user' | 'codex' | 'claude',
  text: string
): StoredEvent {
  seq += 1
  return {
    seq,
    id: `${conversationId}-e${String(seq)}`,
    conversationId,
    actor,
    type: actor === 'user' ? 'user.message' : 'agent.message.completed',
    payload:
      actor === 'user'
        ? { type: 'user.message', text }
        : { type: 'agent.message.completed', itemRef: `i${String(seq)}`, text },
    createdAt: seq,
    schemaVersion: 1,
  }
}

function thought(conversationId: string): StoredEvent {
  seq += 1
  return {
    seq,
    id: `${conversationId}-e${String(seq)}`,
    conversationId,
    actor: 'claude',
    type: 'agent.reasoning.delta',
    payload: { type: 'agent.reasoning.delta', itemRef: `i${String(seq)}`, text: 'private working' },
    createdAt: seq,
    schemaVersion: 1,
  }
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`No item at ${String(index)}`)
  return item
}

const textOf = (event: StoredEvent): string =>
  event.payload.type === 'user.message' || event.payload.type === 'agent.message.completed'
    ? event.payload.text
    : ''

describe('composeCarryover', () => {
  const main = 'conv-main'
  const decision = said(
    main,
    'user',
    'Decision: API calls must retry three times with exponential backoff before surfacing an error.'
  )
  const noise = Array.from({ length: 300 }, (_, index) =>
    said(
      main,
      index % 2 === 0 ? 'user' : 'claude',
      `Traffic panel width tweak ${String(index)} ${'layout '.repeat(60)}`
    )
  )
  const history: CarryoverSource = {
    title: 'Main investigation',
    conversationId: main,
    events: [decision, ...noise],
  }

  it('keeps a transcript above 1 MiB within the default 24,000-byte ceiling', () => {
    const parent = 'conv-huge'
    const events = Array.from({ length: 600 }, (_, index) =>
      said(
        parent,
        index % 2 === 0 ? 'user' : 'codex',
        `Turn ${String(index)} ${'context '.repeat(250)}`
      )
    )
    expect(bytesOf(events.map(textOf).join(''))).toBeGreaterThan(1_048_576)

    const handover = composeCarryover([
      { title: 'Investigation', conversationId: parent, throughSeq: at(events, 599).seq, events },
    ])
    expect(bytesOf(handover)).toBeLessThanOrEqual(24_000)
    expect(handover).toContain(
      `(conversation ${parent}, records through #${String(at(events, 599).seq)})`
    )
    expect(handover).toMatch(/\(\d+ records omitted\)/)
    expect(handover).toContain('Turn 599')
    expect(handover).toContain('read_transcript')
  })

  it('stays within every ceiling with Arabic text, emoji, a long title and a long objective', () => {
    const conversation = 'conv-ar'
    const events = Array.from({ length: 80 }, (_, index) =>
      said(
        conversation,
        index % 2 === 0 ? 'user' : 'claude',
        `قرار ${String(index)} 🚀 ${'سياق طويل 🌙 '.repeat(400)}`
      )
    )
    const title = `عنوان ${'طويل جدا 🌟 '.repeat(500)}`
    for (const maxTotalBytes of [24_000, 6_000, 1_500]) {
      const handover = composeCarryover([{ title, conversationId: conversation, events }], {
        objective: `أصلح ${'المشكلة 🔧 '.repeat(600)}`,
        maxTotalBytes,
      })
      expect(bytesOf(handover), String(maxTotalBytes)).toBeLessThanOrEqual(maxTotalBytes)
      expect(handover, String(maxTotalBytes)).not.toMatch(LONE_SURROGATE)
    }
  })

  it('favours a relevant decision buried before recent unrelated messages', () => {
    const handover = composeCarryover([history], { objective: 'Fix the API calls retry behaviour' })
    expect(handover).toContain(
      `[#${String(decision.seq)} ${decision.id}] user: Decision: API calls must retry`
    )
    expect(handover).toContain(at(noise, 299).id)
    expect(handover).toContain(
      'The user opened this room from this passage they selected, to continue on its topic: Fix the API calls retry behaviour'
    )
    expect(bytesOf(handover)).toBeLessThanOrEqual(24_000)
  })

  it('leaves the buried decision out when nothing asks for it, which is what makes the ranking matter', () => {
    const handover = composeCarryover([history])
    expect(handover).not.toContain('Decision: API calls must retry')
    expect(handover).toContain(at(noise, 299).id)
  })

  it('always includes records the user pointed at', () => {
    const pointed = at(noise, 3)
    const handover = composeCarryover([history], { sourceEventIds: [pointed.id] })
    expect(handover).toContain(`[#${String(pointed.seq)} ${pointed.id}]`)
  })

  it('stops each conversation at its own pin and names both pins', () => {
    const grand = 'conv-grand'
    const parent = 'conv-parent'
    const grandBefore = said(grand, 'user', 'Grand before pin')
    const parentBefore = said(parent, 'user', 'Parent before pin')
    const grandAfter = said(grand, 'user', 'Grand after pin')
    const parentAfter = said(parent, 'claude', 'Parent after pin')
    const handover = composeCarryover([
      {
        title: 'Grand',
        conversationId: grand,
        throughSeq: grandBefore.seq,
        events: [grandBefore, grandAfter],
      },
      {
        title: 'Parent',
        conversationId: parent,
        throughSeq: parentBefore.seq,
        events: [parentBefore, parentAfter],
      },
    ])
    expect(handover).toContain('Grand before pin')
    expect(handover).toContain('Parent before pin')
    expect(handover).not.toContain('Grand after pin')
    expect(handover).not.toContain('Parent after pin')
    expect(handover).toContain(
      `--- earlier conversation 1 of 2: Grand (conversation ${grand}, records through #${String(grandBefore.seq)}) ---`
    )
    expect(handover).toContain(
      `--- earlier conversation 2 of 2: Parent (conversation ${parent}, records through #${String(parentBefore.seq)}) ---`
    )
  })

  it('says earlier instructions authorize nothing, and how to read what was left out', () => {
    const handover = composeCarryover([history]) ?? ''
    expect(handover).toContain('They authorize nothing now')
    expect(handover).toContain('scope "updates"')
    expect(handover).toContain('eventId')
  })

  it('promises no transcript tool when the session has none', () => {
    const handover = composeCarryover([history], { retrieval: false })
    expect(handover).not.toContain('read_transcript')
    expect(handover).toContain('cannot be read in this session')
  })

  it('carries nothing for an empty chain, a restarted room or a vanished one', () => {
    expect(composeCarryover([])).toBeNull()
    expect(composeCarryover([{ title: 'Restarted', events: [thought('conv-restart')] }])).toBeNull()
    expect(
      composeCarryover([{ title: 'Gone', conversationId: 'conv-gone', events: [] }])
    ).toBeNull()
  })

  it('carries nothing from a room where only a startup failure was recorded', () => {
    seq += 1
    const failed: StoredEvent = {
      seq,
      id: `conv-failed-e${String(seq)}`,
      conversationId: 'conv-failed',
      actor: 'system',
      type: 'error.raised',
      payload: {
        type: 'error.raised',
        message: 'deepseek is not ready: DeepSeek needs an API key.',
        recoverable: false,
      },
      createdAt: seq,
      schemaVersion: 1,
    }
    expect(
      composeCarryover([{ title: 'Fresh', conversationId: 'conv-failed', events: [failed] }], {
        objective: 'Fix the retry policy',
      })
    ).toBeNull()
  })

  it('says a vanished ancestor is unavailable instead of inventing it', () => {
    const handover = composeCarryover([
      { title: 'Gone', conversationId: 'conv-gone', events: [] },
      {
        title: 'Here',
        conversationId: 'conv-here',
        events: [said('conv-here', 'user', 'still here')],
      },
    ])
    expect(handover).toContain('Conversation conv-gone is no longer available')
    expect(handover).toContain('still here')
  })

  it('carries nothing for an empty parent even when the user named a task', () => {
    expect(composeCarryover([], { objective: 'Investigate the API calls' })).toBeNull()
    expect(
      composeCarryover(
        [{ title: 'Empty', conversationId: 'conv-empty', events: [thought('conv-empty')] }],
        {
          objective: 'Investigate the API calls',
        }
      )
    ).toBeNull()
  })

  it('reads a conversation once when a corrupt chain names it twice', () => {
    const once = said('conv-twice', 'user', 'only once')
    const source = { title: 'Twice', conversationId: 'conv-twice', events: [once] }
    const handover = composeCarryover([source, source]) ?? ''
    expect(handover).toContain('earlier conversation 1 of 1')
    expect(handover.split('only once')).toHaveLength(2)
  })

  it('lets evidence from an old ancestor in when many ancestors share a small budget', () => {
    const chain: CarryoverSource[] = Array.from({ length: 12 }, (_, hop) => {
      const id = `conv-hop-${String(hop)}`
      const events = Array.from({ length: 30 }, (_, index) =>
        said(
          id,
          index % 2 === 0 ? 'user' : 'claude',
          `Hop ${String(hop)} chatter ${String(index)} ${'filler '.repeat(40)}`
        )
      )
      return { title: `Hop ${String(hop)} ${'long title '.repeat(12)}`, conversationId: id, events }
    })
    const buried = said(
      'conv-hop-0',
      'user',
      'Decision: the ledger export must keep idempotency keys.'
    )
    const first = at(chain, 0)
    const hops = [{ ...first, events: [buried, ...first.events] }, ...chain.slice(1)]
    const handover =
      composeCarryover(hops, {
        objective: 'Fix the ledger export idempotency',
        maxTotalBytes: 6_000,
      }) ?? ''
    expect(bytesOf(handover)).toBeLessThanOrEqual(6_000)
    expect(handover).toContain(
      `[#${String(buried.seq)} ${buried.id}] user: Decision: the ledger export`
    )
    expect(handover).toMatch(/\(\d+ more earlier conversations are not excerpted here/u)
    expect(handover).not.toContain('earlier conversation 6 of 12')
  })

  it('says the records exist when a session has no room left for them', () => {
    for (const maxTotalBytes of [0, 300]) {
      const readable = composeCarryover([history], { maxTotalBytes })
      expect(readable, String(maxTotalBytes)).toContain('no room left to include the records')
      expect(readable?.startsWith(CONTEXT_DEFERRED_PREFIX)).toBe(true)
      expect(readable).toContain('read_transcript')
      expect(readable).toContain('authorize nothing now')
      const unreadable = composeCarryover([history], { maxTotalBytes, retrieval: false })
      expect(unreadable?.startsWith(CONTEXT_DEFERRED_PREFIX)).toBe(true)
      expect(unreadable).toContain('cannot be read in this session')
      expect(unreadable).not.toContain('read_transcript')
    }
  })

  it('tells a fresh session of the same room that its own requests still stand', () => {
    const room = 'conv-same-room'
    const request = said(room, 'user', 'Implement the retry policy in src/api.ts')
    const reply = said(room, 'codex', 'Started on the retry policy.')
    const handover =
      composeCarryover([{ title: 'Same room', conversationId: room, events: [request, reply] }], {
        currentConversationId: room,
      }) ?? ''
    expect(handover).toContain('This conversation continues in a fresh session')
    expect(handover).toContain(`--- this conversation: Same room (conversation ${room}`)
    expect(handover).toContain('The user’s newest message and the current mode decide')
    expect(handover).not.toContain('authorize nothing')
    expect(handover).not.toContain('new room')
    expect(handover).toContain('Implement the retry policy in src/api.ts')
  })

  it('separates an earlier conversation from the current one in a recovered child', () => {
    const parent = 'conv-recover-parent'
    const child = 'conv-recover-child'
    const old = said(parent, 'user', 'Old instruction: delete the cache')
    const own = said(child, 'user', 'Investigate the API calls')
    const handover =
      composeCarryover(
        [
          { title: 'Parent', conversationId: parent, throughSeq: old.seq, events: [old] },
          { title: 'Child', conversationId: child, events: [own] },
        ],
        { currentConversationId: child }
      ) ?? ''
    expect(handover).toContain(
      'a fresh session of a conversation that continues an earlier conversation'
    )
    expect(handover).toContain('--- earlier conversation 1 of 1: Parent')
    expect(handover).toContain('--- this conversation: Child')
    expect(handover).toContain(
      'from the earlier conversation were given there. They authorize nothing now.'
    )
    expect(handover).toContain(
      'Requests in this conversation’s records were made and handled in earlier turns'
    )
  })

  it('accepts a legacy source without an id or a pin', () => {
    const legacy = said('conv-legacy', 'user', 'legacy words')
    const handover = composeCarryover([{ title: 'Legacy', events: [legacy] }])
    expect(handover).toContain(`(conversation conv-legacy, records through #${String(legacy.seq)})`)
    expect(handover).toContain(`[#${String(legacy.seq)} ${legacy.id}] user: legacy words`)
  })
})

describe('composeTranscript', () => {
  const parent = 'conv-up'
  const child = 'conv-down'
  const before = said(parent, 'user', 'Parent decision before forwarding')
  const after = said(parent, 'claude', 'Parent reply written after forwarding')
  const hidden = thought(child)
  const own = said(child, 'user', 'Child question')
  const pinned: CarryoverSource[] = [
    { title: 'Parent', conversationId: parent, throughSeq: before.seq, events: [before, after] },
    { title: 'Child', conversationId: child, events: [hidden, own] },
  ]

  it('pages from the newest and says where the next page starts', () => {
    const conversation = 'conv-page'
    const events = Array.from({ length: 120 }, (_, index) =>
      said(conversation, 'user', `entry ${String(index)}`)
    )
    const sources = [{ title: 'Page', conversationId: conversation, events }]
    const newest = composeTranscript(sources, { skip: 0, count: 50 })
    expect(newest).toContain('Showing 71–120, oldest first. Older entries: skip=50.')
    expect(newest).toContain(`[#${String(at(events, 70).seq)} ${at(events, 70).id}] user: entry 70`)
    expect(newest).not.toContain('user: entry 69')
    expect(composeTranscript(sources, { skip: 100, count: 50 })).toContain(
      'Showing 1–20, oldest first. No older entries.'
    )
    expect(composeTranscript(sources, { skip: 500, count: 10 })).toContain(
      'Nothing there at skip=500.'
    )
  })

  it('searches literally and without regard to case', () => {
    const conversation = 'conv-search'
    const header = said(conversation, 'user', 'Use the Retry-After header')
    const parsed = said(conversation, 'codex', 'retry-after parsed (a.b+)')
    const other = said(conversation, 'claude', 'nothing relevant')
    const sources = [
      { title: 'Search', conversationId: conversation, events: [header, parsed, other] },
    ]
    const found = composeTranscript(sources, { skip: 0, count: 20, query: 'RETRY-AFTER' })
    expect(found).toContain('2 matching records')
    expect(found).toContain(header.id)
    expect(found).toContain(parsed.id)
    expect(found).not.toContain('nothing relevant')
    const literal = composeTranscript(sources, { skip: 0, count: 20, query: '(a.b+)' })
    expect(literal).toContain('1 matching records')
    expect(literal).toContain(parsed.id)
    expect(composeTranscript(sources, { skip: 0, count: 20, query: 'a.*b' })).toContain(
      '0 matching records'
    )
  })

  it('reads one huge multibyte record in parts that rebuild it exactly, each within the ceiling', () => {
    const conversation = 'conv-big'
    const huge = said(conversation, 'codex', `HUGE_BEGIN ${'نص طويل 🌙 '.repeat(20_000)} HUGE_END`)
    const sources = [{ title: 'Big', conversationId: conversation, events: [huge] }]
    const listing = composeTranscript(sources, { skip: 0, count: 20 })
    expect(bytesOf(listing)).toBeLessThanOrEqual(16_000)
    expect(listing).toContain(`read_transcript eventId ${huge.id}`)

    let offset = 0
    let rebuilt = ''
    for (let reads = 0; ; reads++) {
      if (reads > 200) throw new Error('The record never ended')
      const reply = composeTranscript(
        sources,
        { skip: 0, count: 1, eventId: huge.id, offset },
        { maxTotalBytes: 8_000 }
      )
      expect(bytesOf(reply)).toBeLessThanOrEqual(8_000)
      expect(reply).not.toMatch(LONE_SURROGATE)
      const split = reply.indexOf('\n\n')
      const head = reply.slice(0, split)
      rebuilt += reply.slice(split + 2)
      const next = /offset (\d+)\.$/mu.exec(head)
      if (next === null) {
        expect(head).toContain('End of record.')
        break
      }
      offset = Number(next[1])
    }
    expect(rebuilt).toBe(`codex: ${textOf(huge).trim()}`)
  })

  it('reads the snapshot by default and keeps later parent records out of it', () => {
    const snapshot = composeTranscript(pinned, { skip: 0, count: 20 })
    expect(snapshot).toContain('Parent decision before forwarding')
    expect(snapshot).toContain('Child question')
    expect(snapshot).not.toContain('Parent reply written after forwarding')
    expect(snapshot).toContain(`${parent} "Parent" (through #${String(before.seq)})`)
    expect(snapshot).toContain(`${child} "Child" (this conversation)`)
  })

  it('fails a snapshot lookup of a later record without showing it', () => {
    const lookup = composeTranscript(pinned, { skip: 0, count: 1, eventId: after.id })
    expect(lookup).toContain(`No readable record ${after.id} here.`)
    expect(lookup).not.toContain('Parent reply written after forwarding')
  })

  it('shows later parent records only when asked for updates, and labels them', () => {
    const updates = composeTranscript(pinned, { skip: 0, count: 20, scope: 'updates' })
    expect(updates).toContain('Parent reply written after forwarding')
    expect(updates).toContain('written in an earlier conversation after this one was opened')
    expect(updates).toContain(`(after #${String(before.seq)})`)
    expect(updates).not.toContain('Parent decision before forwarding')
    expect(updates).not.toContain('Child question')
    const record = composeTranscript(pinned, {
      skip: 0,
      count: 1,
      eventId: after.id,
      scope: 'updates',
    })
    expect(record).toContain('Parent reply written after forwarding')
    expect(record).toContain('written after this conversation was opened')
  })

  it('refuses the forwarded scope rather than reading it as ancestor access', () => {
    for (const request of [
      { skip: 0, count: 20, scope: 'forwarded' as const },
      { skip: 0, count: 20, scope: 'forwarded' as const, conversationId: parent },
      { skip: 0, count: 1, scope: 'forwarded' as const, eventId: after.id },
      { skip: 0, count: 20, scope: 'forwarded' as const, query: 'Parent' },
    ]) {
      const read = composeTranscript(pinned, request)
      expect(read).toBe(TRANSCRIPT_FORWARDED_ELSEWHERE)
      expect(read).not.toContain('Parent decision before forwarding')
      expect(read).not.toContain('Parent reply written after forwarding')
    }
    expect(
      composeTranscript(pinned, { skip: 0, count: 20, scope: 'forwarded' }, { maxTotalBytes: 40 })
    ).toBe(TRANSCRIPT_NO_ROOM)
  })

  it('has no updates to offer a conversation that continues nothing', () => {
    expect(
      composeTranscript([{ title: 'Alone', conversationId: child, events: [own] }], {
        skip: 0,
        count: 20,
        scope: 'updates',
      })
    ).toContain('There are no later records to read')
  })

  it('refuses an unrelated conversation and an unrelated record without exposing them', () => {
    const elsewhere = composeTranscript(pinned, {
      skip: 0,
      count: 20,
      conversationId: 'conv-elsewhere',
    })
    expect(elsewhere).toContain('No conversation conv-elsewhere is readable here.')
    expect(elsewhere).not.toContain('Parent decision before forwarding')
    expect(
      composeTranscript(pinned, { skip: 0, count: 1, eventId: 'conv-elsewhere-e1' })
    ).toContain('No readable record conv-elsewhere-e1 here.')
  })

  it('narrows to one authorized conversation', () => {
    const narrowed = composeTranscript(pinned, { skip: 0, count: 20, conversationId: child })
    expect(narrowed).toContain('Child question')
    expect(narrowed).not.toContain('Parent decision before forwarding')
  })

  it('says a record that exists holds nothing readable rather than inventing text', () => {
    const reply = composeTranscript(pinned, { skip: 0, count: 1, eventId: hidden.id })
    expect(reply).toContain('holds nothing readable')
    expect(reply).not.toContain('private working')
  })

  it('reads two forward hops, each up to its own pin', () => {
    const grand = 'conv-g2'
    const middle = 'conv-m2'
    const grandBefore = said(grand, 'user', 'grand early')
    const middleBefore = said(middle, 'user', 'middle early')
    const grandAfter = said(grand, 'user', 'grand late')
    const middleAfter = said(middle, 'user', 'middle late')
    const sources: CarryoverSource[] = [
      {
        title: 'Grand',
        conversationId: grand,
        throughSeq: grandBefore.seq,
        events: [grandBefore, grandAfter],
      },
      {
        title: 'Middle',
        conversationId: middle,
        throughSeq: middleBefore.seq,
        events: [middleBefore, middleAfter],
      },
      {
        title: 'Leaf',
        conversationId: 'conv-leaf',
        events: [said('conv-leaf', 'user', 'leaf now')],
      },
    ]
    const snapshot = composeTranscript(sources, { skip: 0, count: 20 })
    for (const text of ['grand early', 'middle early', 'leaf now']) expect(snapshot).toContain(text)
    for (const text of ['grand late', 'middle late']) expect(snapshot).not.toContain(text)
    const updates = composeTranscript(sources, { skip: 0, count: 20, scope: 'updates' })
    for (const text of ['grand late', 'middle late']) expect(updates).toContain(text)
    for (const text of ['grand early', 'middle early', 'leaf now'])
      expect(updates).not.toContain(text)
  })

  it('reports a vanished source as unavailable', () => {
    const sources: CarryoverSource[] = [
      { title: 'Gone', conversationId: 'conv-gone2', throughSeq: 1, events: [] },
      { title: 'Child', conversationId: child, events: [own] },
    ]
    expect(composeTranscript(sources, { skip: 0, count: 20 })).toContain(
      'No longer available, so nothing from it can be read: conv-gone2.'
    )
    expect(
      composeTranscript(sources, { skip: 0, count: 20, conversationId: 'conv-gone2' })
    ).toContain('No longer available, so nothing from it can be read: conv-gone2.')
  })

  it('retrieves original command evidence even when execution straddles the parent pin', () => {
    const conversation = 'conv-command-evidence'
    const recorded = (payload: StoredEvent['payload']): StoredEvent => ({
      ...said(conversation, 'codex', ''),
      type: payload.type,
      payload,
    })
    const start = recorded({
      type: 'command.started',
      itemRef: 'check-api',
      command: ['node', 'inspect-api.mjs'],
      cwd: '/project',
    })
    const output = recorded({
      type: 'command.output',
      itemRef: 'check-api',
      stream: 'stdout',
      chunk: 'API_PROOF: idempotency header was preserved.\n' + 'Complete evidence.\n'.repeat(100),
    })
    const complete = recorded({ type: 'command.completed', itemRef: 'check-api', exitCode: 0 })
    const sources = [
      {
        conversationId: conversation,
        title: 'API evidence',
        throughSeq: start.seq,
        events: [start, output, complete],
      },
    ]
    expect(composeTranscript(sources, { skip: 0, count: 20, query: 'API_PROOF' })).toContain(
      '0 matching records'
    )
    const found = composeTranscript(sources, {
      skip: 0,
      count: 20,
      query: 'API_PROOF',
      scope: 'updates',
    })
    expect(found).toContain(output.id)
    const raw = composeTranscript(sources, {
      skip: 0,
      count: 1,
      eventId: output.id,
      scope: 'updates',
    })
    expect(raw).toContain(JSON.stringify(output.payload))
    expect(raw).toContain('written after this conversation was opened')
    expect(
      composeTranscript(sources, { skip: 0, count: 1, eventId: complete.id, scope: 'updates' })
    ).toContain('"exitCode":0')
  })

  it('respects even a tiny session budget with Arabic titles and long records', () => {
    const conversation = 'conv-floor'
    const sources = [
      {
        title: `عنوان ${'طويل 🌟 '.repeat(500)}`,
        conversationId: conversation,
        events: Array.from({ length: 30 }, () =>
          said(conversation, 'claude', 'رد طويل 🚀 '.repeat(800))
        ),
      },
    ]
    for (const maxTotalBytes of [16_000, 4_000, 1_000]) {
      const reply = composeTranscript(sources, { skip: 0, count: 50 }, { maxTotalBytes })
      expect(bytesOf(reply), String(maxTotalBytes)).toBeLessThanOrEqual(maxTotalBytes)
      expect(reply, String(maxTotalBytes)).not.toMatch(LONE_SURROGATE)
    }
    for (const maxTotalBytes of [10, 0]) {
      expect(composeTranscript(sources, { skip: 0, count: 50 }, { maxTotalBytes })).toBe(
        TRANSCRIPT_NO_ROOM
      )
    }
  })

  it('never answers an exhausted budget with an empty or cut reply that reads as no history', () => {
    const conversation = 'conv-starved'
    const record = said(conversation, 'claude', `START ${'evidence '.repeat(400)}END`)
    const sources = [{ title: 'Starved', conversationId: conversation, events: [record] }]
    for (const maxTotalBytes of [0, 40, 120, 200]) {
      const listing = composeTranscript(sources, { skip: 0, count: 20 }, { maxTotalBytes })
      const lookup = composeTranscript(
        sources,
        { skip: 0, count: 1, eventId: record.id },
        { maxTotalBytes }
      )
      expect(listing, String(maxTotalBytes)).toBe(TRANSCRIPT_NO_ROOM)
      expect(lookup, String(maxTotalBytes)).toBe(TRANSCRIPT_NO_ROOM)
    }
  })

  it('never claims bytes it did not return, at any ceiling', () => {
    const conversation = 'conv-claims'
    const record = said(conversation, 'codex', `BEGIN ${'شاهد 🧾 '.repeat(300)}END`)
    const sources = [{ title: 'Claims', conversationId: conversation, events: [record] }]
    for (let maxTotalBytes = 0; maxTotalBytes <= 1_500; maxTotalBytes += 37) {
      let offset = 0
      let rebuilt = ''
      for (let reads = 0; ; reads++) {
        if (reads > 400) throw new Error(`No progress at ${String(maxTotalBytes)}`)
        const reply = composeTranscript(
          sources,
          { skip: 0, count: 1, eventId: record.id, offset },
          { maxTotalBytes }
        )
        if (reply === TRANSCRIPT_NO_ROOM) {
          expect(reads, String(maxTotalBytes)).toBe(0)
          break
        }
        expect(bytesOf(reply), String(maxTotalBytes)).toBeLessThanOrEqual(maxTotalBytes)
        const split = reply.indexOf('\n\n')
        const head = reply.slice(0, split)
        const shown = reply.slice(split + 2)
        const claimed = /Bytes (\d+)–(\d+) of/u.exec(head)
        expect(claimed, head).not.toBeNull()
        expect(bytesOf(shown)).toBe(Number(claimed?.[2]) - Number(claimed?.[1]))
        rebuilt += shown
        const next = /offset (\d+)\.$/mu.exec(head)
        if (next === null) {
          expect(rebuilt).toBe(`codex: ${textOf(record)}`)
          break
        }
        offset = Number(next[1])
      }
    }
  })

  it('keeps raw evidence out of the listing but finds it by search and reads a whole command', () => {
    const conversation = 'conv-build'
    const recorded = (payload: StoredEvent['payload']): StoredEvent => ({
      ...said(conversation, 'codex', ''),
      type: payload.type,
      payload,
    })
    const asked = said(conversation, 'user', 'run the build')
    const start = recorded({
      type: 'command.started',
      itemRef: 'build',
      command: ['pnpm', 'build'],
      cwd: '/project',
    })
    const chunks = Array.from({ length: 200 }, (_, index) =>
      recorded({
        type: 'command.output',
        itemRef: 'build',
        stream: 'stdout',
        chunk: `chunk ${String(index)} ${index === 150 ? 'NEEDLE_IN_OUTPUT ' : ''}compiled module\n`,
      })
    )
    const complete = recorded({ type: 'command.completed', itemRef: 'build', exitCode: 0 })
    const sources = [
      {
        title: 'Build',
        conversationId: conversation,
        events: [asked, start, ...chunks, complete],
      },
    ]

    const listing = composeTranscript(sources, { skip: 0, count: 50 })
    expect(listing).toContain('2 entries in total.')
    expect(listing).toContain(
      `[#${String(complete.seq)} ${complete.id}] · codex ran \`pnpm build\` → ok`
    )
    expect(listing).not.toContain('command.output')

    const found = composeTranscript(sources, { skip: 0, count: 20, query: 'needle_in_output' })
    expect(found).toContain('1 matching records')
    expect(found).toContain(at(chunks, 150).id)

    let offset = 0
    let whole = ''
    for (let reads = 0; ; reads++) {
      if (reads > 50) throw new Error('The command record never ended')
      const reply = composeTranscript(
        sources,
        { skip: 0, count: 1, eventId: complete.id, offset },
        { maxTotalBytes: 1_500 }
      )
      const split = reply.indexOf('\n\n')
      whole += reply.slice(split + 2)
      const next = /offset (\d+)\.$/mu.exec(reply.slice(0, split))
      if (next === null) break
      offset = Number(next[1])
    }
    expect(whole).toContain('ran `pnpm build` in /project → exit 0')
    expect(whole).toContain('chunk 0 compiled module')
    expect(whole).toContain('chunk 199 compiled module')
    expect(whole).toContain('NEEDLE_IN_OUTPUT')
  })
})
