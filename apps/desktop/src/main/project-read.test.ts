import { describe, expect, it } from 'vitest'
import type {
  TrafficBodyDescriptor,
  TrafficDetail,
  TrafficReadResult,
} from '../shared/traffic-ipc.js'
import {
  BODY_BYTES,
  HEADER_VALUE_BYTES,
  HEADERS_PER_LIST,
  PROJECT_GONE,
  REQUEST_BYTES,
  TERMINAL_BYTES,
  TRAFFIC_BYTES,
  projectReader,
  type ProjectReadDeps,
} from './project-read.js'
import type { RunSnapshot } from './project-run.js'
import type { ProjectTrafficState } from './project-traffic.js'
import type { ProjectTerminalRef } from './terminal.js'
import type { TrafficHttpRow, TrafficRow } from './traffic.js'

const MASK = '••••••••'

const descriptor = (over: Partial<TrafficBodyDescriptor> = {}): TrafficBodyDescriptor => ({
  state: 'complete',
  truncation: null,
  observedBytes: 0,
  capturedBytes: 0,
  contentType: 'application/json',
  contentEncoding: null,
  decoding: 'ready',
  ...over,
})

const STATE: ProjectTrafficState = {
  capturing: true,
  port: 30_100,
  wantedPort: null,
  address: null,
  origin: 'http://api.test',
  access: 'lan',
  envVar: 'EXPO_PUBLIC_API_BASE_URL',
  source: { kind: 'off' },
  failure: null,
  forwardedDevices: 0,
}

const httpRow = (seq: number, over: Partial<TrafficHttpRow> = {}): TrafficHttpRow => ({
  source: 'http',
  seq,
  requestId: `req-${String(seq)}`,
  m: 'GET',
  u: `http://api.test/items/${String(seq)}?page=1`,
  dpop: false,
  status: 200,
  aborted: false,
  parsed: true,
  code: null,
  nextAction: null,
  transport: null,
  ...over,
})

interface Stored {
  readonly detail: TrafficDetail
  readonly request: Buffer
  readonly response: Buffer
  readonly unsupported?: boolean
}

interface Call {
  readonly method: string
  readonly projectId: string
  readonly captureId?: string
}

class FakeWorld {
  local = new Set(['p1', 'p2'])
  captureId = 'cap-1'
  rows: TrafficRow[] = []
  terminal = new Map<string, string>()
  snapshot: RunSnapshot = { process: { kind: 'idle' }, cleanupPending: false }
  stored = new Map<string, Stored>()
  evicted = new Set<string>()
  calls: Call[] = []
  textCalls: { ref: ProjectTerminalRef; lines: number; bytes: number }[] = []
  duringDecode: (() => void) | null = null

  deps(): ProjectReadDeps {
    return {
      local: (projectId) => this.local.has(projectId),
      runner: {
        snapshot: (projectId) => {
          this.calls.push({ method: 'snapshot', projectId })
          return this.snapshot
        },
      },
      terminals: {
        readText: (ref, lines, bytes) => {
          this.textCalls.push({ ref, lines, bytes })
          const text = this.terminal.get(ref.projectId)
          if (text === undefined) return null
          const kept = text.split('\n').slice(-lines).join('\n')
          const encoded = Buffer.from(kept, 'utf8')
          if (encoded.length <= bytes) return kept
          let start = encoded.length - bytes
          while (start < encoded.length && ((encoded[start] ?? 0) & 0xc0) === 0x80) start += 1
          return encoded.subarray(start).toString('utf8')
        },
      },
      traffic: {
        journal: (projectId) => {
          this.calls.push({ method: 'journal', projectId })
          if (projectId !== 'p1') return null
          return { captureId: this.captureId, seq: this.rows.length, rows: [...this.rows] }
        },
        state: (projectId) => {
          this.calls.push({ method: 'state', projectId })
          return projectId === 'p1' ? STATE : null
        },
        detail: (projectId, captureId, requestId) => {
          this.calls.push({ method: 'detail', projectId, captureId })
          if (projectId !== 'p1' || captureId !== this.captureId) return null
          return this.stored.get(requestId)?.detail ?? null
        },
        decodedReady: (projectId, captureId) => {
          this.calls.push({ method: 'decodedReady', projectId, captureId })
          const during = this.duringDecode
          this.duringDecode = null
          during?.()
          return Promise.resolve()
        },
        bodyPage: (projectId, captureId, requestId, side, representation, offset, length) => {
          this.calls.push({ method: 'bodyPage', projectId, captureId })
          const key = { projectId, captureId, requestId }
          if (projectId !== 'p1') return { kind: 'not-found', key }
          if (captureId !== this.captureId) return { kind: 'cleared', key }
          const stored = this.stored.get(requestId)
          if (stored === undefined) {
            return { kind: this.evicted.has(requestId) ? 'evicted' : 'not-found', key }
          }
          if (representation === 'decoded' && stored.unsupported === true) {
            return { kind: 'unsupported', key }
          }
          const bytes = side === 'request' ? stored.request : stored.response
          const page = bytes.subarray(offset, offset + Math.min(length, 65_536))
          const result: TrafficReadResult = {
            kind: 'page',
            key,
            offset,
            dataBase64: page.toString('base64'),
            body: side === 'request' ? stored.detail.requestBody : stored.detail.responseBody,
          }
          return result
        },
      },
    }
  }

  store(
    requestId: string,
    over: {
      readonly detail?: Partial<TrafficDetail>
      readonly request?: Buffer
      readonly response?: Buffer
      readonly unsupported?: boolean
    } = {}
  ): void {
    const request = over.request ?? Buffer.from('{"name":"a"}')
    const response = over.response ?? Buffer.from('{"ok":true}')
    this.stored.set(requestId, {
      detail: {
        key: { projectId: 'p1', captureId: this.captureId, requestId },
        method: 'POST',
        url: 'http://127.0.0.1:30100/items',
        forwardedUrl: 'http://api.test/items',
        requestHeaders: [
          ['content-type', 'application/json'],
          ['authorization', 'Bearer live-token'],
          ['cookie', 'session=abc'],
        ],
        forwardedHeaders: [],
        responseHeaders: [['set-cookie', 'session=def']],
        trailers: [],
        status: 201,
        transport: null,
        timing: { startedAt: 1, upstreamAt: 2, upstreamDoneAt: 3, settledAt: 4 },
        requestBody: descriptor({ observedBytes: request.length, capturedBytes: request.length }),
        responseBody: descriptor({
          observedBytes: response.length,
          capturedBytes: response.length,
        }),
        ...over.detail,
      },
      request,
      response,
      ...(over.unsupported === undefined ? {} : { unsupported: over.unsupported }),
    })
  }
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')

const parsed = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>

const terminalHeader = (text: string): Record<string, unknown> =>
  parsed(text.slice(0, text.indexOf('\n')))

describe('one project per reader', () => {
  it('reads only the project it was built for, whatever the other project holds', async () => {
    const world = new FakeWorld()
    world.terminal.set('p1', 'p1 output')
    world.terminal.set('p2', 'p2 secret output')
    world.rows = [httpRow(1)]
    world.store('req-1')
    const reader = projectReader('p1', world.deps())

    expect(await reader.terminal({ lines: 10 })).toContain('p1 output')
    await reader.traffic({ count: 5, skip: 0 })
    await reader.request({ captureId: 'cap-1', requestId: 'req-1' })

    expect(world.textCalls.map((call) => call.ref)).toEqual([
      { scope: 'project', projectId: 'p1', id: 'run' },
    ])
    expect(new Set(world.calls.map((call) => call.projectId))).toEqual(new Set(['p1']))
  })

  it('gives the other project its own, separate answers', async () => {
    const world = new FakeWorld()
    world.terminal.set('p2', 'p2 output')
    const reader = projectReader('p2', world.deps())
    expect(await reader.terminal({ lines: 10 })).toContain('p2 output')
    expect(parsed(await reader.traffic({ count: 5, skip: 0 }))).toMatchObject({
      captureId: null,
      recording: false,
      total: 0,
      rows: [],
    })
  })
})

describe('a project that is no longer local', () => {
  it('refuses every read and starts no terminal or capture work', async () => {
    const world = new FakeWorld()
    world.local.delete('p1')
    world.terminal.set('p1', 'stale output')
    const reader = projectReader('p1', world.deps())
    await expect(reader.terminal({ lines: 10 })).rejects.toThrow(PROJECT_GONE)
    await expect(reader.traffic({ count: 5, skip: 0 })).rejects.toThrow(PROJECT_GONE)
    await expect(reader.request({ captureId: 'cap-1', requestId: 'req-1' })).rejects.toThrow(
      PROJECT_GONE
    )
    expect(world.calls).toEqual([])
    expect(world.textCalls).toEqual([])
  })

  it('stops a request read that the removal overtook while it was decoding', async () => {
    const world = new FakeWorld()
    world.store('req-1')
    world.duringDecode = () => {
      world.local.delete('p1')
    }
    const reader = projectReader('p1', world.deps())
    await expect(reader.request({ captureId: 'cap-1', requestId: 'req-1' })).rejects.toThrow(
      PROJECT_GONE
    )
    expect(world.calls.some((call) => call.method === 'detail' || call.method === 'bodyPage')).toBe(
      false
    )
  })
})

describe('capture identity', () => {
  it('answers cleared for an old capture id and never reads the new capture', async () => {
    const world = new FakeWorld()
    world.captureId = 'cap-2'
    world.store('req-1')
    const reader = projectReader('p1', world.deps())
    expect(parsed(await reader.request({ captureId: 'cap-1', requestId: 'req-1' }))).toEqual({
      state: 'cleared',
      captureId: 'cap-1',
      requestId: 'req-1',
    })
    expect(world.calls.map((call) => call.method)).toEqual(['journal'])
  })

  it('answers cleared when the capture is replaced while the bodies decode', async () => {
    const world = new FakeWorld()
    world.store('req-1')
    world.duringDecode = () => {
      world.captureId = 'cap-2'
      world.store('req-1')
    }
    const reader = projectReader('p1', world.deps())
    expect(parsed(await reader.request({ captureId: 'cap-1', requestId: 'req-1' }))).toEqual({
      state: 'cleared',
      captureId: 'cap-1',
      requestId: 'req-1',
    })
    const scoped = world.calls.filter((call) => call.captureId !== undefined)
    expect(scoped.every((call) => call.captureId === 'cap-1')).toBe(true)
  })

  it('tells evicted from never captured', async () => {
    const world = new FakeWorld()
    world.evicted.add('req-gone')
    const reader = projectReader('p1', world.deps())
    expect(parsed(await reader.request({ captureId: 'cap-1', requestId: 'req-gone' }))).toEqual({
      state: 'evicted',
      captureId: 'cap-1',
      requestId: 'req-gone',
    })
    expect(parsed(await reader.request({ captureId: 'cap-1', requestId: 'req-none' }))).toEqual({
      state: 'not-found',
      captureId: 'cap-1',
      requestId: 'req-none',
    })
  })

  it('answers not-found for a project that has never captured', async () => {
    const world = new FakeWorld()
    const reader = projectReader('p2', world.deps())
    expect(parsed(await reader.request({ captureId: 'cap-1', requestId: 'req-1' }))).toEqual({
      state: 'not-found',
      captureId: 'cap-1',
      requestId: 'req-1',
    })
  })
})

describe('read_terminal', () => {
  it('leads with the run state, label and exit code, then the last lines', async () => {
    const world = new FakeWorld()
    world.snapshot = {
      process: {
        kind: 'exited',
        token: 3,
        active: { id: 'dev', label: 'dev:clean', command: 'npm run dev:clean' },
        code: 1,
      },
      cleanupPending: true,
    }
    world.terminal.set('p1', 'one\ntwo\nthree')
    const text = await projectReader('p1', world.deps()).terminal({ lines: 2 })
    expect(terminalHeader(text)).toEqual({
      run: 'exited',
      label: 'dev:clean',
      exitCode: 1,
      failure: null,
      cleanupPending: true,
      lines: 2,
      cut: false,
    })
    expect(text.slice(text.indexOf('\n') + 1)).toBe('two\nthree')
  })

  it('says idle with no lines when nothing has run', async () => {
    const world = new FakeWorld()
    const text = await projectReader('p1', world.deps()).terminal({ lines: 50 })
    expect(terminalHeader(text)).toMatchObject({ run: 'idle', label: null, lines: 0, cut: false })
    expect(text.endsWith('\n')).toBe(true)
  })

  it('stays within 64 KiB with the header counted, cutting on a character boundary', async () => {
    const world = new FakeWorld()
    world.snapshot = {
      process: {
        kind: 'running',
        token: 1,
        active: { id: 'dev', label: 'dev', command: 'npm run dev' },
        pgid: 9,
      },
      cleanupPending: false,
    }
    world.terminal.set('p1', Array.from({ length: 400 }, () => '€'.repeat(100)).join('\n'))
    const text = await projectReader('p1', world.deps()).terminal({ lines: 400 })
    expect(bytesOf(text)).toBeLessThanOrEqual(TERMINAL_BYTES)
    expect(text).not.toContain('�')
    expect(terminalHeader(text)).toMatchObject({ run: 'running', cut: true })
    expect(text.endsWith('€'.repeat(100))).toBe(true)
  })

  it('clamps a line count it was handed out of range', async () => {
    const world = new FakeWorld()
    const reader = projectReader('p1', world.deps())
    await reader.terminal({ lines: 10_000 })
    await reader.terminal({ lines: Number.NaN })
    expect(world.textCalls.map((call) => call.lines)).toEqual([400, 1])
  })
})

describe('read_traffic', () => {
  it('lists HTTP rows newest first with their outcome, skipping log lines', async () => {
    const world = new FakeWorld()
    world.rows = [
      httpRow(1),
      { source: 'log', seq: 2, ref: { scope: 'global', id: 't' }, line: 'hello', exit: null },
      httpRow(3, { status: null, transport: 'ECONNREFUSED' }),
      httpRow(4, { status: null }),
      httpRow(5, { aborted: true, status: null }),
      httpRow(6, { status: 500, code: 'APP_SESSION_REVOKED', nextAction: 'sign-in' }),
    ]
    const doc = parsed(await projectReader('p1', world.deps()).traffic({ count: 3, skip: 1 }))
    expect(doc).toMatchObject({
      captureId: 'cap-1',
      recording: true,
      total: 5,
      skip: 1,
      cut: false,
    })
    expect(doc['rows']).toEqual([
      {
        requestId: 'req-5',
        method: 'GET',
        path: '/items/5?page=1',
        status: null,
        outcome: 'aborted',
        code: null,
        nextAction: null,
        transport: null,
      },
      expect.objectContaining({ requestId: 'req-4', outcome: 'pending' }),
      expect.objectContaining({ requestId: 'req-3', outcome: 'failed', transport: 'ECONNREFUSED' }),
    ])
  })

  it('names a row with no capture behind it as having no request id', async () => {
    const world = new FakeWorld()
    world.rows = [httpRow(1, { requestId: '', status: 400, u: 'GET / HTTP/1.1' })]
    const doc = parsed(await projectReader('p1', world.deps()).traffic({ count: 5, skip: 0 }))
    expect(doc['rows']).toEqual([
      expect.objectContaining({ requestId: null, path: 'GET / HTTP/1.1', outcome: 'answered' }),
    ])
  })

  it('stays within 64 KiB, marking the cut, and bounds each path', async () => {
    const world = new FakeWorld()
    world.rows = Array.from({ length: 50 }, (_, index) =>
      httpRow(index + 1, { u: `http://api.test/${'p'.repeat(5_000)}` })
    )
    const text = await projectReader('p1', world.deps()).traffic({ count: 50, skip: 0 })
    const doc = parsed(text)
    const rows = doc['rows'] as Record<string, unknown>[]
    expect(bytesOf(text)).toBeLessThanOrEqual(TRAFFIC_BYTES)
    expect(doc['cut']).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(50)
    for (const row of rows) {
      expect(row['pathCut']).toBe(true)
      expect(bytesOf(JSON.stringify(row['path']))).toBeLessThanOrEqual(2_048)
    }
  })
})

describe('read_request', () => {
  it('returns the exchange with credential headers masked', async () => {
    const world = new FakeWorld()
    world.store('req-1')
    const doc = parsed(
      await projectReader('p1', world.deps()).request({ captureId: 'cap-1', requestId: 'req-1' })
    )
    expect(doc).toMatchObject({
      state: 'found',
      captureId: 'cap-1',
      requestId: 'req-1',
      method: 'POST',
      url: 'http://127.0.0.1:30100/items',
      forwardedUrl: 'http://api.test/items',
      status: 201,
      cut: [],
    })
    expect(doc['requestHeaders']).toEqual({
      total: 3,
      shown: [
        ['content-type', 'application/json'],
        ['authorization', MASK],
        ['cookie', MASK],
      ],
    })
    expect(doc['responseHeaders']).toEqual({ total: 1, shown: [['set-cookie', MASK]] })
    expect(doc['requestBody']).toMatchObject({ state: 'complete', text: '{"name":"a"}' })
    expect(doc['responseBody']).toMatchObject({ state: 'complete', text: '{"ok":true}' })
    expect(JSON.stringify(doc)).not.toContain('live-token')
  })

  it('cuts a long body to 8 KiB on a character boundary and says so', async () => {
    const world = new FakeWorld()
    world.store('req-1', { response: Buffer.from('€'.repeat(3_000)) })
    const doc = parsed(
      await projectReader('p1', world.deps()).request({ captureId: 'cap-1', requestId: 'req-1' })
    )
    const body = doc['responseBody'] as Record<string, unknown>
    expect(body['state']).toBe('complete')
    expect(body['text']).toBe('€'.repeat(Math.floor(BODY_BYTES / 3)))
    expect(doc['cut']).toEqual(['responseBody'])
  })

  it('reports a capture-truncated body with its reason and no broken last character', async () => {
    const world = new FakeWorld()
    const cutMidCharacter = Buffer.from('ab€').subarray(0, 4)
    world.store('req-1', {
      response: cutMidCharacter,
      detail: { responseBody: descriptor({ truncation: 'body-limit', capturedBytes: 4 }) },
    })
    const doc = parsed(
      await projectReader('p1', world.deps()).request({ captureId: 'cap-1', requestId: 'req-1' })
    )
    expect(doc['responseBody']).toMatchObject({
      state: 'truncated',
      reason: 'body-limit',
      text: 'ab',
      binary: false,
    })
  })

  it('reports binary, pending and undecodable bodies without text', async () => {
    const world = new FakeWorld()
    world.store('req-bin', { response: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) })
    world.store('req-pending', {
      detail: { responseBody: descriptor({ state: 'streaming' }) },
      unsupported: true,
    })
    world.store('req-gzip', {
      detail: { responseBody: descriptor({ contentEncoding: 'zstd', decoding: 'unsupported' }) },
      unsupported: true,
    })
    const reader = projectReader('p1', world.deps())
    const read = async (requestId: string): Promise<Record<string, unknown>> =>
      parsed(await reader.request({ captureId: 'cap-1', requestId }))['responseBody'] as Record<
        string,
        unknown
      >
    expect(await read('req-bin')).toMatchObject({ state: 'complete', binary: true, text: null })
    expect(await read('req-pending')).toMatchObject({ state: 'pending', text: null })
    expect(await read('req-gzip')).toMatchObject({
      state: 'unsupported',
      decoding: 'unsupported',
      contentEncoding: 'zstd',
      text: null,
    })
  })

  it('holds 32 KiB with headers and metadata counted, and bounds each header', async () => {
    const world = new FakeWorld()
    const many = Array.from({ length: 150 }, (_, index): [string, string] => [
      `x-header-${String(index)}`,
      'v'.repeat(2_000),
    ])
    world.store('req-1', {
      detail: {
        url: `http://127.0.0.1:30100/${'u'.repeat(5_000)}`,
        requestHeaders: [['authorization', 'Bearer live-token'], ...many],
        responseHeaders: many,
      },
      request: Buffer.from('"'.repeat(BODY_BYTES * 2)),
      response: Buffer.from('r'.repeat(BODY_BYTES * 2)),
    })
    const text = await projectReader('p1', world.deps()).request({
      captureId: 'cap-1',
      requestId: 'req-1',
    })
    const doc = parsed(text)
    expect(bytesOf(text)).toBeLessThanOrEqual(REQUEST_BYTES)
    expect(text).not.toContain('live-token')
    expect(doc['cut']).toEqual(
      expect.arrayContaining(['url', 'responseBody', 'requestBody', 'responseHeaders'])
    )
    const response = doc['responseHeaders'] as { total: number; shown: [string, string][] }
    expect(response.total).toBe(150)
    expect(response.shown.length).toBeLessThanOrEqual(HEADERS_PER_LIST)
    for (const [, value] of response.shown) {
      expect(bytesOf(JSON.stringify(value))).toBeLessThanOrEqual(HEADER_VALUE_BYTES)
    }
  })

  it('stops at 100 headers per list even when there is room for more', async () => {
    const world = new FakeWorld()
    world.store('req-1', {
      detail: {
        responseHeaders: Array.from({ length: 120 }, (_, index): [string, string] => [
          `h${String(index)}`,
          'v',
        ]),
      },
    })
    const doc = parsed(
      await projectReader('p1', world.deps()).request({ captureId: 'cap-1', requestId: 'req-1' })
    )
    const response = doc['responseHeaders'] as { total: number; shown: [string, string][] }
    expect(response.total).toBe(120)
    expect(response.shown).toHaveLength(HEADERS_PER_LIST)
    expect(doc['cut']).toEqual(['responseHeaders'])
  })
})
