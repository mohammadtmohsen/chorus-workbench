import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_CONVERSATION_NOTE,
  type ConversationNote,
  type ConversationNoteView,
  type ConversationNoteWrite,
} from '@chorus/shared'
import {
  NoteSync,
  noteText,
  noteView,
  type JournalBackend,
  type NoteApi,
} from './useConversationNote.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

interface FakeNoteApi {
  readonly api: NoteApi
  readonly loads: Deferred<ConversationNote>[]
  readonly texts: { readonly text: string; readonly reply: Deferred<ConversationNoteWrite> }[]
  readonly views: {
    readonly view: ConversationNoteView
    readonly reply: Deferred<ConversationNote>
  }[]
  readonly compares: (string | null)[]
}

function fakeNoteApi(): FakeNoteApi {
  let stored: string | null = null
  const fake: FakeNoteApi = {
    loads: [],
    texts: [],
    views: [],
    compares: [],
    api: {
      load: () => {
        const reply = deferred<ConversationNote>()
        fake.loads.push(reply)
        return reply.promise
      },
      saveText: (_conversationId, text) => {
        const reply = deferred<ConversationNoteWrite>()
        fake.texts.push({ text, reply })
        return reply.promise
      },
      saveView: (_conversationId, view) => {
        const reply = deferred<ConversationNote>()
        fake.views.push({ view, reply })
        return reply.promise
      },
      journal: (): JournalBackend => ({
        read: () => ({ ok: true, matched: true, current: stored }),
        compare: (expected, next) => {
          fake.compares.push(next)
          if (stored !== expected) return { ok: true, matched: false, current: stored }
          stored = next
          return { ok: true, matched: true, current: next }
        },
      }),
    },
  }
  return fake
}

const saved: ConversationNote = {
  ...EMPTY_CONVERSATION_NOTE,
  body: 'saved',
  revision: 1,
  version: 1,
  updatedBy: 'user',
  updatedAt: 1,
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function loaded(fake: FakeNoteApi): Promise<NoteSync> {
  const sync = new NoteSync('c1', fake.api, 'me')
  sync.load()
  fake.loads[0]?.resolve(saved)
  await settle()
  return sync
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a chat note after its chat is closed', () => {
  it('cancels a pending save so its timer never sends', async () => {
    const fake = fakeNoteApi()
    const sync = await loaded(fake)
    sync.edit('typed')
    sync.dispose()
    vi.advanceTimersByTime(5_000)
    expect(fake.texts).toHaveLength(0)
  })

  it('treats a load reply that arrives after disposal as inert', async () => {
    const fake = fakeNoteApi()
    const sync = new NoteSync('c1', fake.api, 'me')
    const listener = vi.fn()
    sync.subscribe(listener)
    sync.load()
    expect(fake.loads).toHaveLength(1)
    const notified = listener.mock.calls.length
    const comparesBefore = fake.compares.length

    sync.dispose()
    expect(listener).toHaveBeenCalledTimes(notified + 1)
    fake.loads[0]?.resolve({ ...saved, body: 'late load', visible: true, x: 0.4 })
    await settle()

    expect(listener).toHaveBeenCalledTimes(notified + 1)
    expect(sync.snapshot().load).toBe('waiting')
    expect(sync.snapshot().saved).toBeNull()
    expect(noteText(sync.snapshot())).toBe('')
    expect(noteView(sync.snapshot())).toMatchObject({ visible: false, x: null })
    expect(fake.compares).toHaveLength(comparesBefore)
    expect(fake.loads).toHaveLength(1)
  })

  it('treats late text and view replies as inert and clears what it held', async () => {
    const fake = fakeNoteApi()
    const sync = await loaded(fake)
    sync.edit('typed')
    vi.advanceTimersByTime(400)
    sync.changeView({ visible: true, x: 0.3 })
    expect(fake.texts).toHaveLength(1)
    expect(fake.views).toHaveLength(1)
    const listener = vi.fn()
    sync.subscribe(listener)
    const comparesBefore = fake.compares.length

    sync.dispose()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(sync.isDisposed()).toBe(true)
    expect(noteText(sync.snapshot())).toBe('')
    expect(noteView(sync.snapshot()).visible).toBe(false)
    expect(sync.snapshot().pending).toBeNull()
    expect(sync.snapshot().pendingView).toBeNull()

    fake.texts[0]?.reply.resolve({
      status: 'saved',
      note: { ...saved, body: 'typed', revision: 2, version: 2 },
    })
    fake.views[0]?.reply.resolve({ ...saved, version: 3, visible: true, x: 0.3 })
    await settle()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(noteText(sync.snapshot())).toBe('')
    expect(sync.snapshot().saved).toBeNull()
    expect(fake.compares).toHaveLength(comparesBefore)
  })

  it('ignores every action and push once disposed', async () => {
    const fake = fakeNoteApi()
    const sync = await loaded(fake)
    sync.dispose()
    sync.load()
    sync.edit('after close')
    sync.changeView({ visible: true })
    sync.toggle()
    sync.keepMine()
    sync.useSaved()
    sync.retry()
    sync.pushed({ ...saved, body: 'late push', version: 9 })
    vi.advanceTimersByTime(5_000)
    await settle()
    expect(fake.loads).toHaveLength(1)
    expect(fake.texts).toHaveLength(0)
    expect(fake.views).toHaveLength(0)
    expect(noteText(sync.snapshot())).toBe('')
  })
})

describe('a chat note while its chat stays open', () => {
  it('keeps saving after its view unmounts, as on a tab switch', async () => {
    const fake = fakeNoteApi()
    const sync = await loaded(fake)
    const unsubscribe = sync.subscribe(vi.fn())
    sync.edit('typed before switching tabs')
    unsubscribe()
    vi.advanceTimersByTime(400)
    expect(sync.isDisposed()).toBe(false)
    expect(fake.texts.map((entry) => entry.text)).toEqual(['typed before switching tabs'])
  })

  it('keeps the draft and view when the note is hidden', async () => {
    const fake = fakeNoteApi()
    const sync = await loaded(fake)
    sync.changeView({ visible: true, x: 0.2 })
    sync.edit('kept while hidden')
    sync.changeView({ visible: false })
    expect(noteText(sync.snapshot())).toBe('kept while hidden')
    expect(noteView(sync.snapshot())).toMatchObject({ visible: false, x: 0.2 })
    expect(sync.isDisposed()).toBe(false)
  })
})
