import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_NOTE_ACCESS,
  NOTE_READ_ONLY,
  type AgentSession,
  type NoteAccess,
  type SessionOpts,
} from '@chorus/agent-protocol'
import { EMPTY_CONVERSATION_NOTE, type ConversationNote } from '@chorus/shared'
import { describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex-adapter.js'
import type { Transport } from './transport.js'

const CWD = mkdtempSync(join(tmpdir(), 'chorus-note-tools-'))
const BASE: SessionOpts = {
  cwd: CWD,
  sandbox: { mode: 'workspaceWrite', writableRoots: [CWD], networkAccess: false },
}
const READ_ONLY: SessionOpts = {
  cwd: CWD,
  sandbox: { mode: 'readOnly', writableRoots: [], networkAccess: false },
  toolPolicy: 'readOnly',
}

type Message = Record<string, unknown>

interface Connection {
  readonly sent: Message[]
  push: (message: Message) => void
}

function fakeCodex(): { adapter: CodexAdapter; connections: Connection[] } {
  const connections: Connection[] = []
  const createTransport = (): Transport => {
    let onLine: ((line: string) => void) | null = null
    const connection: Connection = {
      sent: [],
      push: (message) => {
        onLine?.(JSON.stringify(message))
      },
    }
    connections.push(connection)
    return {
      send: (line) => {
        const message = JSON.parse(line) as Message
        connection.sent.push(message)
        const id = message['id']
        const method = message['method']
        if (typeof id !== 'number' || typeof method !== 'string') return
        const params = (message['params'] ?? {}) as Message
        const result =
          method === 'thread/start'
            ? { thread: { id: 'thr_new' } }
            : method === 'thread/resume'
              ? { thread: { id: params['threadId'] } }
              : method === 'thread/fork'
                ? { thread: { id: 'thr_fork' } }
                : method === 'config/read'
                  ? { config: {} }
                  : {}
        queueMicrotask(() => {
          onLine?.(JSON.stringify({ id, result }))
        })
      },
      onLine: (handler) => {
        onLine = handler
      },
      onClose: () => undefined,
      onStderr: () => undefined,
      close: () => undefined,
    }
  }
  return { adapter: new CodexAdapter({ now: () => 1_000, createTransport }), connections }
}

const requests = (connection: Connection | undefined, method: string): Message[] =>
  (connection?.sent ?? [])
    .filter((message) => message['method'] === method)
    .map((message) => (message['params'] ?? {}) as Message)

const noteTools = (connection: Connection | undefined): unknown[] => {
  const namespaces = (requests(connection, 'thread/start')[0]?.['dynamicTools'] ?? []) as Message[]
  const note = namespaces.find((namespace) => namespace['name'] === 'chorus_note')
  return ((note?.['tools'] ?? []) as Message[]).map((tool) => tool['name'])
}

const note: ConversationNote = {
  ...EMPTY_CONVERSATION_NOTE,
  body: 'Keep the migration additive.',
  revision: 2,
  version: 2,
  updatedBy: 'user',
  updatedAt: 10,
}

function bound(writes: { text: string; expectedRevision: number }[]): NoteAccess {
  return {
    read: () => note,
    write: (text, expectedRevision) => {
      writes.push({ text, expectedRevision })
      return {
        status: 'saved',
        note: { ...note, body: text, revision: note.revision + 1, updatedBy: 'codex' },
      }
    },
  }
}

async function reply(connection: Connection | undefined, params: Message): Promise<Message> {
  if (connection === undefined) throw new Error('no connection')
  connection.push({ id: 9_301, method: 'item/tool/call', params })
  const answered = await vi.waitFor(() => {
    const found = connection.sent.find(
      (message) => message['id'] === 9_301 && message['method'] === undefined
    )
    if (found === undefined) throw new Error('not answered yet')
    return found
  })
  return answered['result'] as Message
}

const call = (threadId: string, tool: string, args: Message): Message => ({
  threadId,
  turnId: 'turn_1',
  callId: 'call_1',
  namespace: 'chorus_note',
  tool,
  arguments: args,
})

const text = (result: Message): string =>
  ((result['contentItems'] as Message[])[0]?.['text'] ?? '') as string

describe('registering the note tools', () => {
  it('offers read_note and write_note on a fresh Work thread', async () => {
    const { adapter, connections } = fakeCodex()
    await adapter.start({ ...BASE, note: bound([]) })
    expect(noteTools(connections[0])).toEqual(['read_note', 'write_note'])
  })

  it('offers read_note alone to a read-only discussion session', async () => {
    const { adapter, connections } = fakeCodex()
    await adapter.start({ ...READ_ONLY, note: bound([]) })
    expect(noteTools(connections[0])).toEqual(['read_note'])
  })

  it('offers read_note alone when the binding has no writer', async () => {
    const { adapter, connections } = fakeCodex()
    await adapter.start({ ...BASE, note: { read: () => note } })
    expect(noteTools(connections[0])).toEqual(['read_note'])
  })

  it('resumes the same thread without sending a catalog, and still answers the tools', async () => {
    const writes: { text: string; expectedRevision: number }[] = []
    const { adapter, connections } = fakeCodex()
    await adapter.resume('thr_saved', { ...BASE, note: bound(writes) })
    expect(requests(connections[0], 'thread/resume')[0]).not.toHaveProperty('dynamicTools')
    const result = await reply(
      connections[0],
      call('thr_saved', 'write_note', { text: 'Resumed edit', expectedRevision: 2 })
    )
    expect(result['success']).toBe(true)
    expect(writes).toEqual([{ text: 'Resumed edit', expectedRevision: 2 }])
  })
})

describe('answering note tool calls', () => {
  const started = async (
    opts: SessionOpts
  ): Promise<{ session: AgentSession; connection: Connection | undefined }> => {
    const { adapter, connections } = fakeCodex()
    const session = await adapter.start(opts)
    return { session, connection: connections[0] }
  }

  it('reads the bound note', async () => {
    const { connection } = await started({ ...BASE, note: bound([]) })
    const result = await reply(connection, call('thr_new', 'read_note', {}))
    expect(result['success']).toBe(true)
    expect(text(result)).toContain('Keep the migration additive.')
  })

  it('refuses a call naming another thread, without writing', async () => {
    const writes: { text: string; expectedRevision: number }[] = []
    const { connection } = await started({ ...BASE, note: bound(writes) })
    const result = await reply(
      connection,
      call('thr_other', 'write_note', { text: 'x', expectedRevision: 2 })
    )
    expect(result['success']).toBe(false)
    expect(writes).toEqual([])
  })

  it('denies a write attempted in a read-only discussion session', async () => {
    const writes: { text: string; expectedRevision: number }[] = []
    const { connection } = await started({ ...READ_ONLY, note: bound(writes) })
    const result = await reply(
      connection,
      call('thr_new', 'write_note', { text: 'x', expectedRevision: 2 })
    )
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: NOTE_READ_ONLY }],
      success: false,
    })
    expect(writes).toEqual([])
  })

  it('denies a write from an ephemeral fork and allows it from a kept one', async () => {
    const ephemeralWrites: { text: string; expectedRevision: number }[] = []
    const ephemeral = fakeCodex()
    await ephemeral.adapter.fork('thr_parent', {
      ...BASE,
      note: bound(ephemeralWrites),
      inherits: 'config',
    })
    const denied = await reply(
      ephemeral.connections[0],
      call('thr_fork', 'write_note', { text: 'x', expectedRevision: 2 })
    )
    expect(denied['success']).toBe(false)
    expect(ephemeralWrites).toEqual([])

    const keptWrites: { text: string; expectedRevision: number }[] = []
    const kept = fakeCodex()
    await kept.adapter.fork('thr_parent', {
      ...BASE,
      note: bound(keptWrites),
      inherits: 'config',
      persist: true,
    })
    const allowed = await reply(
      kept.connections[0],
      call('thr_fork', 'write_note', { text: 'Kept edit', expectedRevision: 2 })
    )
    expect(allowed['success']).toBe(true)
    expect(keptWrites).toEqual([{ text: 'Kept edit', expectedRevision: 2 }])
  })

  it('answers plainly when the session has no note', async () => {
    const { connection } = await started(BASE)
    const result = await reply(connection, call('thr_new', 'read_note', {}))
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: NO_NOTE_ACCESS }],
      success: false,
    })
  })

  it('refuses arguments that try to name a target conversation', async () => {
    const writes: { text: string; expectedRevision: number }[] = []
    const { connection } = await started({ ...BASE, note: bound(writes) })
    const result = await reply(
      connection,
      call('thr_new', 'write_note', { text: 'x', expectedRevision: 2, conversationId: 'c2' })
    )
    expect(result['success']).toBe(false)
    expect(writes).toEqual([])
  })
})
