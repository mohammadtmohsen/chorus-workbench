import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectTrafficRegistry } from './project-traffic.js'
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
