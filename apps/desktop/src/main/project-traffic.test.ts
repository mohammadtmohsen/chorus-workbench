import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectTrafficRegistry,
  terminalEnvOf,
  type ProjectTrafficConfig,
} from './project-traffic.js'
import { BODY_LIMIT, type TrafficHttpRow } from './traffic.js'

const PROJECT = 'p1'

/*
 * More bodies than a project's own ceiling can hold, deliberately.
 *
 * The ceiling is private to the registry and writing it here would make the test
 * agree with today's constant rather than find the ledger full — so the fill is
 * simply over-long, and everything asserted happens *after* it: what a second
 * start is allowed to retain once the first one has stopped.
 */
const FILL = 24

const servers: Server[] = []

const serving = (body: Buffer): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(body)
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address === 'object' ? address.port : 0)
    })
  })

/*
 * `port: null` so the registry binds an ephemeral one and remembers it, which is
 * the same path a real project takes the first time it is started — and it saves
 * a test from racing for a free port of its own.
 */
/*
 * One origin that holds `/slow` open and answers everything else at once.
 *
 * The path that can put the list out of order needs a request still in flight
 * when the window has moved past it — and the window belongs to the service, so
 * the requests that fill it have to go to the same origin and be answered
 * immediately. Two servers would be two origins, and the slow request would
 * never share a window with the fast ones.
 */
const slowFirst = (): Promise<{ port: number; release: () => void }> =>
  new Promise((resolve) => {
    let pending: (() => void) | null = null
    const server = createServer((request, response) => {
      if ((request.url ?? '').startsWith('/slow')) {
        pending = () => {
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('late')
        }
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: address !== null && typeof address === 'object' ? address.port : 0,
        release: () => {
          pending?.()
        },
      })
    })
  })

const heldGzip = (text: string): Promise<{ port: number; release: () => void }> =>
  new Promise((resolve) => {
    let pending: (() => void) | null = null
    const server = createServer((_request, response) => {
      const gzipped = gzipSync(Buffer.from(text))
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      })
      response.flushHeaders()
      pending = () => {
        response.end(gzipped)
      }
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: address !== null && typeof address === 'object' ? address.port : 0,
        release: () => {
          pending?.()
        },
      })
    })
  })

const registryFor = (origin: number, capture: number): ProjectTrafficRegistry =>
  new ProjectTrafficRegistry({
    config: () => ({
      origin: `http://127.0.0.1:${String(origin)}`,
      port: null,
      access: 'loopback',
      envVar: null,
    }),
    nextPort: () => 0,
    remember: () => undefined,
    address: () => '127.0.0.1',
    capture,
  })

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/*
 * A row is one of three shapes and only the http one carries a url and a request
 * id, so the narrowing is the caller's — the same helper `traffic.test.ts` keeps
 * for the same reason.
 */
const lastHttpRow = (registry: ProjectTrafficRegistry): TrafficHttpRow => {
  const row = registry.journal(PROJECT)?.rows.at(-1)
  if (row?.source !== 'http') throw new Error('the capture produced no http row')
  return row
}

describe('the retained-byte budget across a stop', () => {
  /*
   * `stop` cleared the entry's service and closed it, and released nothing the
   * service had been charged for. `dispose` discharged the project; `stop` did
   * not — so every body a stopped capture had retained went on counting against
   * the ceiling that exists to bound it.
   *
   * **The bytes are already unreachable when the leak happens**, which is what
   * makes releasing them a correction rather than a loss: `detail` and
   * `bodyPage` both answer `null` once `service === null`, so nothing can read
   * what the ledger is still holding.
   */
  it('gives a project its bytes back, so a second start can retain again', async () => {
    const origin = await serving(Buffer.alloc(BODY_LIMIT, 97))
    /*
     * Room for every fill capture at once, so the ring never evicts one out from
     * under the test — what frees bytes here must be the stop, not the bound.
     */
    const registry = registryFor(origin, FILL * 2)
    registry.configure(PROJECT, {})

    await registry.start(PROJECT)
    const before = registry.state(PROJECT)?.port ?? 0
    for (let sent = 0; sent < FILL; sent += 1) {
      const answer = await fetch(`http://127.0.0.1:${String(before)}/fill/${String(sent)}`)
      expect(answer.status).toBe(200)
      await answer.arrayBuffer()
    }

    await registry.stop(PROJECT)
    await registry.start(PROJECT)

    const after = registry.state(PROJECT)?.port ?? 0
    const answer = await fetch(`http://127.0.0.1:${String(after)}/after`)
    expect(answer.status).toBe(200)
    await answer.arrayBuffer()

    /* The request line is absolute through a proxy, so the path is a suffix. */
    await vi.waitFor(() => {
      expect(lastHttpRow(registry).u.endsWith('/after')).toBe(true)
    })
    const journal = registry.journal(PROJECT)
    const detail = registry.detail(
      PROJECT,
      journal?.captureId ?? '',
      lastHttpRow(registry).requestId
    )

    expect(detail?.responseBody.truncation).toBeNull()
    expect(detail?.responseBody.capturedBytes).toBe(BODY_LIMIT)
  })
})

describe('a settle whose row the window has already trimmed', () => {
  /*
   * The one path that puts the list out of order, and it needs a *small* window
   * to reach — which is why nothing found it: the fixture every other test uses
   * holds a thousand rows, and a request has to outlive the whole window to be
   * trimmed before its answer arrives. Three is enough, and the whole run is
   * about a second.
   *
   * Three layers answer this one event and used to disagree: the service
   * appended, the registry appended, and the renderer dropped. Appending puts
   * the oldest sequence in the newest position — a list that lies about its own
   * order — so the renderer was right and the two below it now agree with it.
   */
  it('drops it rather than appending it out of order', async () => {
    const held = await slowFirst()
    const registry = registryFor(held.port, 3)
    registry.configure(PROJECT, {})
    await registry.start(PROJECT)
    const port = registry.state(PROJECT)?.port ?? 0

    /* Started first, answered last: this is the row the window will pass. */
    const slow = fetch(`http://127.0.0.1:${String(port)}/slow`).catch(() => undefined)
    await vi.waitFor(() => {
      expect(registry.journal(PROJECT)?.rows.length).toBe(1)
    })

    for (const path of ['/a', '/b', '/c']) {
      const answer = await fetch(`http://127.0.0.1:${String(port)}${path}`)
      await answer.arrayBuffer()
    }
    await vi.waitFor(() => {
      expect(registry.journal(PROJECT)?.rows.length).toBe(3)
    })

    held.release()
    await slow
    /*
     * The settle runs on a microtask after the body is buffered, so a bare
     * assertion here would race it — and racing it means asserting before the
     * thing under test has happened, which passes for the wrong reason.
     */
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })

    const rows = registry.journal(PROJECT)?.rows ?? []
    const seqs = rows.map((row) => row.seq)
    expect(rows.length).toBe(3)
    /* Ascending is the invariant the whole list rests on. */
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    /* And the trimmed row is gone rather than sitting at the end. */
    expect(rows.some((row) => row.source === 'http' && row.u.endsWith('/slow'))).toBe(false)
  })
})

describe('the access setting while capturing', () => {
  /*
   * `access` is read once, in `start`, to choose the bind host, and nothing
   * rebinds afterwards. Taken mid-capture it would persist and surface — the
   * panel would offer "Anything on this network" beside a socket still on
   * `127.0.0.1` — and the person whose phone cannot reach it would have nothing
   * on screen saying the change waits for a restart.
   *
   * The `loopback` assertion is the one that matters and the one a guard alone
   * would satisfy: refusing without also leaving the stored value alone would
   * move the label and keep the refusal.
   */
  it('refuses a change while capturing, and takes it once stopped', async () => {
    const origin = await serving(Buffer.alloc(8, 97))
    const registry = registryFor(origin, 1)
    registry.configure(PROJECT, {})

    await registry.start(PROJECT)
    const refused = registry.configure(PROJECT, { access: 'lan' })
    expect(refused.failure).toBe('capturing')
    expect(refused.access).toBe('loopback')

    await registry.stop(PROJECT)
    const taken = registry.configure(PROJECT, { access: 'lan' })
    expect(taken.failure).toBeNull()
    expect(taken.access).toBe('lan')
  })
})

describe('a compressed request body', () => {
  it('is recorded with its encoding and read back decoded', async () => {
    const text = '{"username":"Admin"}'
    const origin = await serving(Buffer.from('{"code":"OK"}'))
    const registry = registryFor(origin, 8)
    registry.configure(PROJECT, {})
    await registry.start(PROJECT)
    const port = registry.state(PROJECT)?.port ?? 0

    const answer = await fetch(`http://127.0.0.1:${String(port)}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(text)),
    })
    await answer.arrayBuffer()
    await vi.waitFor(() => {
      expect(lastHttpRow(registry).status).toBe(200)
    })

    const row = lastHttpRow(registry)
    const captureId = registry.journal(PROJECT)?.captureId ?? ''
    const detail = registry.detail(PROJECT, captureId, row.requestId)
    expect(detail?.requestBody.contentEncoding).toBe('gzip')
    expect(detail?.requestBody.contentType).toBe('application/json')

    await registry.decodedReady(PROJECT, captureId, row.requestId, 'request')
    const page = registry.bodyPage(PROJECT, captureId, row.requestId, 'request', 'decoded', 0, 4096)
    if (page.kind !== 'page') throw new Error('the decoded request was answered without a page')
    expect(Buffer.from(page.dataBase64, 'base64').toString('utf8')).toBe(text)
  })
})

describe('a decoded read behind a decode that has not finished', () => {
  it('answers with the decoded bytes rather than the transient refusal', async () => {
    const text = '{"code":"OK","data":{"nextAction":"done"}}'
    const held = await heldGzip(text)
    const registry = registryFor(held.port, 8)
    registry.configure(PROJECT, {})
    await registry.start(PROJECT)
    const port = registry.state(PROJECT)?.port ?? 0

    const answer = fetch(`http://127.0.0.1:${String(port)}/held`).catch(() => undefined)
    await vi.waitFor(() => {
      expect(registry.journal(PROJECT)?.rows.length).toBe(1)
    })

    const row = lastHttpRow(registry)
    const captureId = registry.journal(PROJECT)?.captureId ?? ''
    await vi.waitFor(() => {
      expect(registry.detail(PROJECT, captureId, row.requestId)?.responseBody.contentEncoding).toBe(
        'gzip'
      )
    })

    expect(
      registry.bodyPage(PROJECT, captureId, row.requestId, 'response', 'decoded', 0, 64).kind
    ).toBe('unsupported')

    await registry.decodedReady(PROJECT, captureId, row.requestId, 'response')
    expect(registry.detail(PROJECT, captureId, row.requestId)?.responseBody.decoding).toBe(
      'not-requested'
    )

    held.release()
    const delivered = await answer
    await delivered?.arrayBuffer()
    await vi.waitFor(() => {
      expect(registry.detail(PROJECT, captureId, row.requestId)?.responseBody.state).toBe(
        'complete'
      )
    })

    await registry.decodedReady(PROJECT, captureId, row.requestId, 'response')
    const page = registry.bodyPage(
      PROJECT,
      captureId,
      row.requestId,
      'response',
      'decoded',
      0,
      4096
    )
    if (page.kind !== 'page') throw new Error('the decoded read was answered without a page')
    expect(Buffer.from(page.dataBase64, 'base64').toString('utf8')).toBe(text)
  })
})

describe('a burst absorbed in one tick', () => {
  it('reaches the journal whole, however many arrived at once', async () => {
    const origin = await serving(Buffer.from('ok'))
    const registry = registryFor(origin, 100)
    registry.configure(PROJECT, {})
    await registry.start(PROJECT)
    registry.selectSource(PROJECT, { kind: 'logcat', filters: 'ReactNativeJS:V' })

    for (let i = 0; i < 70; i += 1) registry.logcatLine(PROJECT, `line ${String(i)}`)

    await vi.waitFor(() => {
      expect(registry.journal(PROJECT)?.rows.length).toBeGreaterThan(0)
    })

    const lines: string[] = []
    for (const row of registry.journal(PROJECT)?.rows ?? []) {
      if (row.source === 'logcat') lines.push(row.line)
    }
    expect(lines).toHaveLength(70)

    await registry.stop(PROJECT)
  })
})

const remembering = (origin: number): ProjectTrafficRegistry => {
  let saved: ProjectTrafficConfig = {
    origin: `http://127.0.0.1:${String(origin)}`,
    port: null,
    access: 'loopback',
    envVar: null,
  }
  return new ProjectTrafficRegistry({
    config: () => saved,
    nextPort: () => 0,
    remember: (_projectId, config) => {
      saved = config
    },
    address: () => '127.0.0.1',
  })
}

describe('the terminal env a capture hands the editor', () => {
  it('names the loopback listener only while capturing, and follows a rename', async () => {
    const registry = remembering(await serving(Buffer.from('ok')))
    registry.configure(PROJECT, { envVar: 'EXPO_PUBLIC_API_BASE_URL' })
    expect(terminalEnvOf(registry.state(PROJECT))).toBeNull()

    await registry.start(PROJECT)
    const port = registry.state(PROJECT)?.port ?? null
    expect(port).not.toBeNull()
    expect(terminalEnvOf(registry.state(PROJECT))).toEqual({
      name: 'EXPO_PUBLIC_API_BASE_URL',
      value: `http://127.0.0.1:${String(port)}`,
    })

    registry.configure(PROJECT, { envVar: 'JAVA_API_BASE_URL' })
    expect(terminalEnvOf(registry.state(PROJECT))).toEqual({
      name: 'JAVA_API_BASE_URL',
      value: `http://127.0.0.1:${String(port)}`,
    })

    await registry.stop(PROJECT)
    expect(terminalEnvOf(registry.state(PROJECT))).toBeNull()
  })

  it('hands over nothing for a name saved before names were checked, or with no name', async () => {
    const registry = remembering(await serving(Buffer.from('ok')))
    registry.configure(PROJECT, { envVar: 'MY VAR' })
    await registry.start(PROJECT)
    expect(registry.state(PROJECT)?.capturing).toBe(true)
    expect(terminalEnvOf(registry.state(PROJECT))).toBeNull()

    registry.configure(PROJECT, { envVar: null })
    expect(terminalEnvOf(registry.state(PROJECT))).toBeNull()
    await registry.stop(PROJECT)
  })

  it('hands over nothing for a project the registry has never seen', () => {
    expect(terminalEnvOf(null)).toBeNull()
  })
})
