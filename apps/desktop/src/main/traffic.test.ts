import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { connect as netConnect, createServer as createTcpServer } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { Frame } from './terminal.js'
import {
  CaptureStore,
  CapturedBody,
  TrafficService,
  type TrafficHttpRow,
  type TrafficPush,
  type TrafficServiceOptions,
} from './traffic.js'

interface Upstream {
  readonly port: number
  readonly close: () => Promise<void>
}

const startUpstream = (
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Upstream> =>
  new Promise<Upstream>((resolve) => {
    const server = createServer(handler)
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done()
            })
            server.closeAllConnections()
          }),
      })
    })
  })

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

const through = (
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {}
): Promise<Reply> =>
  new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: proxyPort, path: url, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })

/**
 * Resolves on the response head, not on the end.
 *
 * `through` waits for the whole body, which is exactly what a truncated one
 * never delivers — so a test that has to act *after* the headers and *before*
 * the end needs the head on its own.
 */
const headersOf = (proxyPort: number, url: string): Promise<IncomingMessage> =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' },
      (res) => {
        resolve(res)
      }
    )
    req.on('error', reject)
    req.end()
  })

const post = (
  proxyPort: number,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {}
): Promise<Reply> =>
  new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path,
        method: 'POST',
        headers: { 'content-length': String(body.length), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })

const until = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error('the condition never held')
}

const httpRow = (service: TrafficService, at = 0): TrafficHttpRow => {
  const row = service.snapshot()[at]
  if (row?.source !== 'http') throw new Error('expected an http row')
  return row
}

/**
 * A TCP target that counts what dials it.
 *
 * The count is the assertion that matters, not the reply: a refused CONNECT has
 * to *not dial*, and no amount of correct-looking status text proves that on its
 * own. An echo server would report the relay working, which is the behaviour
 * this replaced.
 */
const startTarget = async (): Promise<{
  port: number
  dialled: () => number
  close: () => Promise<void>
}> => {
  let dialled = 0
  const server = createTcpServer((socket) => {
    dialled += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, resolve)
  })
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    dialled: () => dialled,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

/** A CONNECT, and whatever the proxy answers before it closes. */
const attemptConnect = (proxyPort: number, target: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const client = netConnect(proxyPort, '127.0.0.1', () => {
      client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
    })
    let text = ''
    client.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    /* `close`, not `end`: a socket the proxy destroys answers with nothing. */
    client.on('close', () => {
      resolve(text)
    })
    client.on('error', reject)
  })

const manualFrame = (): { frame: Frame; flush: () => void } => {
  let pending: (() => void) | null = null
  return {
    frame: (run) => {
      pending = run
      return () => {
        pending = null
      }
    },
    flush: () => {
      const run = pending
      pending = null
      run?.()
    },
  }
}

const running: TrafficService[] = []
const upstreams: Upstream[] = []

const proxy = async (options: TrafficServiceOptions = {}, wanted = 0) => {
  const service = new TrafficService(options)
  const port = await service.listen(wanted)
  running.push(service)
  return { service, port }
}

const upstream = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Upstream> => {
  const started = await startUpstream(handler)
  upstreams.push(started)
  return started
}

const answering = async (body: string): Promise<Upstream> =>
  upstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })

afterEach(async () => {
  for (const service of running.splice(0)) await service.close()
  for (const server of upstreams.splice(0)) await server.close()
})

describe('TrafficService', () => {
  it('reports an ephemeral port rather than a constant', async () => {
    const { port } = await proxy()
    expect(port).toBeGreaterThan(0)
  })

  it('binds the port it was given, not an ephemeral one', async () => {
    const probe = new TrafficService()
    const free = await probe.listen()
    await probe.close()

    const { port } = await proxy({}, free)
    expect(port).toBe(free)
  })

  it('still takes an ephemeral port when asked for zero', async () => {
    const first = await proxy({}, 0)
    const second = await proxy({}, 0)
    expect(first.port).toBeGreaterThan(0)
    expect(second.port).not.toBe(first.port)
  })

  it('reports the port it could not bind rather than failing anonymously', async () => {
    const held = await proxy()
    const second = new TrafficService()
    await expect(second.listen(held.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('forwards a plain response byte-identical and reads its envelope', async () => {
    const body = JSON.stringify({ code: 'REGISTER', data: { nextAction: 'ASK_PASSWORD' } })
    const source = await answering(body)
    const { service, port } = await proxy()
    const url = `http://127.0.0.1:${String(source.port)}/api/mobile/v1/auth/identify`

    const reply = await through(port, url)

    expect(reply.status).toBe(200)
    expect(reply.body.toString('utf8')).toBe(body)
    await until(() => service.snapshot().length === 1)
    const row = httpRow(service)
    expect(row.m).toBe('GET')
    expect(row.u).toBe(url)
    expect(row.dpop).toBe(false)
    expect(row.status).toBe(200)
    expect(row.aborted).toBe(false)
    expect(row.parsed).toBe(true)
    expect(row.code).toBe('REGISTER')
    expect(row.nextAction).toBe('ASK_PASSWORD')
  })

  it('records whether a proof was attached, never the proof', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const { service, port } = await proxy()
    await through(port, `http://127.0.0.1:${String(source.port)}/api/mobile/v1/me`, {
      dpop: 'eyJhbGciOiJFUzI1NiJ9.proof',
      authorization: 'DPoP eyJhbGciOiJFUzI1NiJ9.token',
    })

    await until(() => service.snapshot().length === 1)
    const row = httpRow(service)
    expect(row.dpop).toBe(true)
    expect(JSON.stringify(row)).not.toContain('proof')
    expect(JSON.stringify(row)).not.toContain('token')
  })

  it('reads a gzipped envelope without touching the wire', async () => {
    const plain = JSON.stringify({ code: 'APP_DEVICE_PROOF_INVALID', data: { nextAction: null } })
    const compressed = gzipSync(plain)
    const source = await upstream((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(compressed)
    })
    const { service, port } = await proxy()

    const reply = await through(
      port,
      `http://127.0.0.1:${String(source.port)}/api/mobile/v1/auth/identify`,
      {
        'accept-encoding': 'gzip',
      }
    )

    expect(reply.headers['content-encoding']).toBe('gzip')
    expect(Buffer.compare(reply.body, compressed)).toBe(0)
    // Waiting on the count is not enough any more: the row exists from the
    // moment the request does, so what says "answered" is a status.
    await until(() => httpRow(service).status !== null)
    const row = httpRow(service)
    expect(row.status).toBe(401)
    expect(row.parsed).toBe(true)
    expect(row.code).toBe('APP_DEVICE_PROOF_INVALID')
  })

  it('marks a body it cannot read rather than reporting an empty envelope', async () => {
    const source = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>not json</html>')
    })
    const { service, port } = await proxy()

    await through(port, `http://127.0.0.1:${String(source.port)}/health`)
    await until(() => service.snapshot().length === 1)
    expect(httpRow(service).parsed).toBe(false)
    expect(httpRow(service).code).toBeNull()
  })

  it('records a 502 that names why the upstream could not be reached', async () => {
    const { service, port } = await proxy()
    const dead = await answering('{}')
    const deadPort = dead.port
    await dead.close()

    const reply = await through(port, `http://127.0.0.1:${String(deadPort)}/gone`)
    expect(reply.status).toBe(502)
    await until(() => service.snapshot().length === 1)
    const row = httpRow(service)
    expect(row.status).toBe(502)
    expect(row.aborted).toBe(false)
    expect(row.parsed).toBe(false)

    /*
     * The half that used to be thrown away, and the reason the person had
     * nowhere to look. A 502 is this side's own verdict and says nothing about
     * *why* — a shut port, a name that would not resolve and a host that does
     * not exist all arrive as the same row. Node is standing on the connection
     * and holds the difference; `up.on('error')` discarded it unbound.
     *
     * `code` rather than the message, because `ECONNREFUSED` is the token a
     * person searches for and it does not vary with the address. Asserting it on
     * the snapshot is what says the reason travels all the way to the row the
     * panel draws, rather than only as far as the capture.
     */
    expect(row.transport).toBe('ECONNREFUSED')
    /* It is not an envelope's code, and a reader must not be able to mistake it for one. */
    expect(row.code).toBeNull()
    /* And the same reason reaches the detail, which is what draws the Response pane. */
    expect(service.captured(row.requestId)?.transport).toBe('ECONNREFUSED')
  })

  /*
   * The other half of the same question, and the one a 502 cannot express.
   *
   * Here the headers are already through, so `sentStatus()` answers with the
   * upstream's own 200 and the row is *not* a backend failure by status. The
   * exchange still failed — the body stopped four bytes into a promised
   * sixty-four — and before the reason was carried that row was indistinguishable
   * from a complete one whose body merely looked short.
   */
  /*
   * The other half of the same question, and the one a 502 cannot express: here
   * the headers are through, so this side answers with the upstream's own status
   * and the row is not a backend failure by status at all. The exchange failed
   * anyway — the body stopped four bytes into a chunked stream that never ended —
   * and before the reason was carried, that row was indistinguishable from a
   * complete one whose body merely looked short.
   *
   * **The kill waits for the headers to arrive at the test's own client.** A
   * `destroy()` inside the handler races the flush: on this machine it produced a
   * 502, because the reset beat the headers and the proxy never got a status.
   * Waiting for them at the far end is what makes "headers were already sent" a
   * fact rather than a hope, and it is the whole difference between this test and
   * the refusal one above it.
   */
  it('names the reason when the upstream dies part-way through the body', async () => {
    /*
     * A holder rather than a `let`: the assignment happens inside the upstream's
     * request handler, which the compiler cannot see run, so it narrows a bare
     * `let` to its initial `null` and the call below stops compiling.
     */
    const killer: { kill: (() => void) | null } = { kill: null }
    const source = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('half')
      killer.kill = () => {
        res.socket?.destroy()
      }
    })
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(source.port)}` })

    const answered = await headersOf(port, '/api/mobile/v1/truncated')
    expect(answered.statusCode).toBe(200)
    killer.kill?.()
    answered.resume()

    await until(() => service.snapshot().length === 1 && httpRow(service).transport !== null)
    const row = httpRow(service)
    /* The upstream's status, not this side's 502 — the reason is the only thing that says so. */
    expect(row.status).toBe(200)
    expect(row.transport).toBe('ECONNRESET')
    expect(row.code).toBeNull()
  })

  it('resolves an origin-form request against the upstream and records where it went', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const base = `http://127.0.0.1:${String(source.port)}`
    const { service, port } = await proxy({ origin: base })

    const reply = await through(port, '/api/mobile/v1/auth/identify')

    expect(reply.status).toBe(200)
    await until(() => service.snapshot().length === 1)
    const row = httpRow(service)
    expect(row.u).toBe(`${base}/api/mobile/v1/auth/identify`)
    expect(row.code).toBe('OK')
  })

  it('gives the upstream its own authority in Host, not the proxy address', async () => {
    let host: string | undefined
    const source = await upstream((req, res) => {
      host = req.headers.host
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'OK' }))
    })
    const authority = `127.0.0.1:${String(source.port)}`
    const { service, port } = await proxy({ origin: `http://${authority}` })

    await through(port, '/api/mobile/v1/me')
    await until(() => service.snapshot().length === 1)
    expect(host).toBe(authority)
  })

  it('still honours an absolute request line while an upstream is set', async () => {
    const direct = await answering(JSON.stringify({ code: 'DIRECT' }))
    const other = await answering(JSON.stringify({ code: 'SHOULD_NOT' }))
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(other.port)}` })

    await through(port, `http://127.0.0.1:${String(direct.port)}/x`)
    await until(() => service.snapshot().length === 1)
    expect(httpRow(service).code).toBe('DIRECT')
  })

  it('rejects a request that resolves nowhere, and records it', async () => {
    const { service, port } = await proxy()
    const reply = await through(port, '/origin-form')
    expect(reply.status).toBe(400)

    await until(() => service.snapshot().length === 1)
    const row = httpRow(service)
    expect(row.status).toBe(400)
    expect(row.u).toBe('/origin-form')
    expect(row.parsed).toBe(false)
    expect(row.aborted).toBe(false)
  })

  it('takes a log line into the same ring, sharing its sequence', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const { service, port } = await proxy()

    await through(port, `http://127.0.0.1:${String(source.port)}/one`)
    service.logLine({ scope: 'global', id: 't1' }, 'metro is listening')

    await until(() => service.snapshot().length === 2)
    expect(httpRow(service, 0).seq).toBe(1)
    const log = service.snapshot()[1]
    expect(log?.source).toBe('log')
    expect(log?.seq).toBe(2)
    expect(log?.source === 'log' ? log.line : null).toBe('metro is listening')
    expect(log?.source === 'log' ? log.exit : undefined).toBeNull()
  })

  it('records an exit as a row of its own', async () => {
    const { service } = await proxy()
    service.logLine({ scope: 'global', id: 't1' }, '', 7)

    expect(service.snapshot()).toHaveLength(1)
    const log = service.snapshot()[0]
    expect(log?.source).toBe('log')
    expect(log?.source === 'log' ? log.exit : undefined).toBe(7)
    expect(log?.source === 'log' ? log.line : undefined).toBe('')
  })

  it('evicts log lines and http rows against one bound', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const { service, port } = await proxy({ capture: 3 })

    for (let i = 0; i < 2; i += 1) {
      await through(port, `http://127.0.0.1:${String(source.port)}/n/${String(i)}`)
    }
    service.logLine({ scope: 'global', id: 't1' }, 'one')
    service.logLine({ scope: 'global', id: 't1' }, 'two')

    expect(service.snapshot()).toHaveLength(3)
    expect(service.snapshot()[0]?.seq).toBe(2)
    expect(service.snapshot()[2]?.source).toBe('log')
  })

  /*
   * The tunnel relayed blind, and that is what this replaces.
   *
   * It opened a socket to whatever host the request named — the port was checked
   * and the host never was — and wrote no row whether it relayed or dropped. On
   * `access: 'lan'`, where the listener is on every interface, that is an open
   * TLS relay for the network; everywhere it is an egress path that the panel
   * built to show traffic cannot show.
   *
   * **The CONNECT names the configured origin on purpose.** Restricting the
   * tunnel to that host was the alternative to refusing it, so the test has to
   * pin the decision rather than the limitation: even the host the proxy is
   * configured to forward to is not dialled. Nothing about it can be captured —
   * CONNECT is opaque TLS — so a tunnel there would still be a relay producing
   * no rows, which is the whole argument for removing the capability instead of
   * narrowing it.
   */
  it('refuses a CONNECT instead of relaying blind, and records the refusal', async () => {
    const target = await startTarget()
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(target.port)}` })

    const answer = await attemptConnect(port, `127.0.0.1:${String(target.port)}`)

    expect(target.dialled()).toBe(0)
    expect(answer.startsWith('HTTP/1.1 501')).toBe(true)
    await until(() => service.snapshot().length > 0)
    expect(httpRow(service).status).toBe(501)
    expect(httpRow(service).m).toBe('CONNECT')
    await target.close()
  })

  it('reports an envelope it could not read when the body outruns the tap', async () => {
    const body = JSON.stringify({ code: 'REGISTER', pad: 'x'.repeat(500) })
    const source = await answering(body)
    const { service, port } = await proxy({ tap: 64 })

    const reply = await through(
      port,
      `http://127.0.0.1:${String(source.port)}/api/mobile/v1/auth/identify`
    )

    expect(reply.body.toString('utf8')).toBe(body)
    await until(() => service.snapshot().length === 1)
    expect(httpRow(service).status).toBe(200)
    expect(httpRow(service).parsed).toBe(false)
    expect(httpRow(service).code).toBeNull()
  })

  it('survives a client that disconnects mid-response', async () => {
    const source = await upstream((req, res) => {
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"code":"PART')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'OK' }))
    })
    const { service, port } = await proxy()

    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `http://127.0.0.1:${String(source.port)}/slow`,
          method: 'GET',
        },
        () => {
          req.destroy()
          resolve()
        }
      )
      req.on('error', () => undefined)
      req.end()
    })

    await until(() => httpRow(service).status !== null)
    const row = httpRow(service)
    expect(row.status).toBe(200)
    expect(row.aborted).toBe(true)
    expect(row.parsed).toBe(false)

    const reply = await through(port, `http://127.0.0.1:${String(source.port)}/fast`)
    expect(reply.status).toBe(200)
    await until(() => httpRow(service, 1).status !== null)
    expect(httpRow(service, 1).code).toBe('OK')
  })
})

describe('TrafficService bounds', () => {
  it('evicts from the ring in main, keeping the newest', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const { service, port } = await proxy({ capture: 10 })

    for (let i = 0; i < 25; i += 1) {
      await through(port, `http://127.0.0.1:${String(source.port)}/n/${String(i)}`)
    }

    expect(service.snapshot()).toHaveLength(10)
    expect(httpRow(service, 9).u).toBe(`http://127.0.0.1:${String(source.port)}/n/24`)
  })

  it('delivers every row of a burst the view has not caught up with', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const frame = manualFrame()
    const { service, port } = await proxy({ frame: frame.frame })
    const pushes: TrafficPush[] = []
    service.subscribe((push) => {
      pushes.push(push)
    })

    service.attach()
    for (let i = 0; i < 100; i += 1) {
      await through(port, `http://127.0.0.1:${String(source.port)}/n/${String(i)}`)
    }
    frame.flush()

    const lastBySeq = new Map<number, TrafficHttpRow>()
    for (const push of pushes) {
      for (const row of push.rows) {
        if (row.source === 'http') lastBySeq.set(row.seq, row)
      }
    }
    const settled = [...lastBySeq.values()]

    expect(settled).toHaveLength(100)
    expect(settled.filter((row) => row.status !== 200)).toEqual([])
    expect(service.snapshot()).toHaveLength(100)
  })

  it('sends every row when the view keeps up', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const frame = manualFrame()
    const { service, port } = await proxy({ frame: frame.frame })
    const pushes: TrafficPush[] = []
    service.subscribe((push) => {
      pushes.push(push)
    })

    service.attach()
    for (let i = 0; i < 3; i += 1) {
      await through(port, `http://127.0.0.1:${String(source.port)}/n/${String(i)}`)
    }
    frame.flush()

    expect(pushes).toHaveLength(1)
    /*
     * Six emissions, three requests: each one writes its row when it starts and
     * rewrites it when it settles, under one sequence. What the view ends up
     * with is three rows, which is why the assertion counts sequences rather
     * than emissions — counting emissions would pin the number of times a
     * request is *reported* instead of the number of requests.
     */
    const rows = pushes[0]?.rows ?? []
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map((row) => row.seq)).size).toBe(3)
  })

  it('replays the ring on every attach, under a rising epoch', async () => {
    const source = await answering(JSON.stringify({ code: 'OK' }))
    const { service, port } = await proxy()
    await through(port, `http://127.0.0.1:${String(source.port)}/first`)

    const first = service.attach()
    const second = service.attach()

    expect(second.rows).toHaveLength(1)
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(service.attach().rows).toHaveLength(1)
  })

  it('delivers every row absorbed in one frame, however far behind the view is', () => {
    const frame = manualFrame()
    const service = new TrafficService({ frame: frame.frame })
    const pushes: TrafficPush[] = []
    service.subscribe((push) => {
      pushes.push(push)
    })
    service.attach()

    for (let i = 0; i < 64; i += 1) service.logcatLine(`filler ${String(i)}`)
    frame.flush()
    pushes.length = 0

    service.logcatLine('first')
    service.logcatLine('second')
    frame.flush()

    const delivered: string[] = []
    for (const push of pushes) {
      for (const row of push.rows) {
        if (row.source === 'logcat') delivered.push(row.line)
      }
    }

    expect(delivered).toEqual(['first', 'second'])
    expect(service.snapshot()).toHaveLength(66)
  })
})

describe('bounded capture', () => {
  it('names the capture on the row, so the detail can be asked for by id', async () => {
    const source = await answering('{"code":"OK"}')
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(source.port)}` })
    await through(port, '/thing')
    await until(() => service.snapshot().length > 0)

    const row = httpRow(service)
    expect(row.requestId).not.toBe('')
    expect(service.captured(row.requestId)).not.toBeNull()
  })

  it('keeps both bodies byte for byte while forwarding them unchanged', async () => {
    const payload = Buffer.from('abcdef'.repeat(700))
    const source = await upstream((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/octet-stream' })
        res.end(payload)
      })
    })
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(source.port)}` })
    const reply = await post(port, '/upload', payload)
    await until(() => service.snapshot().length > 0)

    // The client's copy is the unchanged one; the capture is a second reader.
    expect(reply.body.equals(payload)).toBe(true)

    const captured = service.captured(httpRow(service).requestId)
    expect(captured?.request.encodedPage(0, payload.length * 2)?.equals(payload)).toBe(true)
    expect(captured?.response.encodedPage(0, payload.length * 2)?.equals(payload)).toBe(true)
  })

  it('reports what it saw and what it kept separately when a body is past the cap', async () => {
    const payload = Buffer.alloc(3_000, 7)
    const source = await upstream((_req, res) => {
      res.writeHead(200)
      res.end(payload)
    })
    const { service, port } = await proxy({
      origin: `http://127.0.0.1:${String(source.port)}`,
      bodyLimit: 1_000,
    })
    const reply = await through(port, '/big')
    await until(() => service.snapshot().length > 0)

    // A cap on retention is not a cap on forwarding.
    expect(reply.body.equals(payload)).toBe(true)

    const descriptor = service.captured(httpRow(service).requestId)?.response.descriptor()
    expect(descriptor?.observedBytes).toBe(3_000)
    expect(descriptor?.capturedBytes).toBe(1_000)
    expect(descriptor?.truncation).toBe('body-limit')
  })

  it('stops retaining, and names the budget, when the project will not admit the bytes', async () => {
    const payload = Buffer.alloc(2_000, 3)
    const source = await upstream((_req, res) => {
      res.writeHead(200)
      res.end(payload)
    })
    const { service, port } = await proxy({
      origin: `http://127.0.0.1:${String(source.port)}`,
      budget: { retain: () => 'project-budget', release: () => undefined },
    })
    await through(port, '/big')
    await until(() => service.snapshot().length > 0)

    const descriptor = service.captured(httpRow(service).requestId)?.response.descriptor()
    expect(descriptor?.capturedBytes).toBe(0)
    expect(descriptor?.observedBytes).toBe(2_000)
    expect(descriptor?.truncation).toBe('project-budget')
  })

  it('decodes what it can and refuses to guess at what it cannot', async () => {
    const plain = Buffer.from('{"code":"OK"}')
    const source = await upstream((req, res) => {
      if (req.url === '/gz') {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' })
        res.end(gzipSync(plain))
        return
      }
      res.writeHead(200, { 'content-encoding': 'zstd' })
      res.end(Buffer.from('nope'))
    })
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(source.port)}` })

    await through(port, '/gz')
    await until(() => service.snapshot().length > 0)
    const gzipped = service.captured(httpRow(service).requestId)
    await until(() => gzipped?.response.descriptor().decoding === 'ready')
    expect(gzipped?.response.decodedPage(0, 64)?.toString('utf8')).toBe(plain.toString('utf8'))

    await through(port, '/other')
    await until(() => service.snapshot().length > 1)
    const unknown = service.captured(httpRow(service, 1).requestId)
    await until(() => unknown?.response.descriptor().decoding === 'unsupported')
  })

  it('drops every retained body on clear', async () => {
    const source = await answering('{"code":"OK"}')
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(source.port)}` })
    await through(port, '/thing')
    await until(() => service.snapshot().length > 0)
    const id = httpRow(service).requestId
    expect(service.captured(id)).not.toBeNull()

    service.clearCaptures()
    expect(service.captured(id)).toBeNull()
  })

  it('answers an upgrade with 501 and records it, rather than dropping the socket', async () => {
    const { service, port } = await proxy()
    const answer = await new Promise<string>((resolve, reject) => {
      const client = netConnect(port, '127.0.0.1', () => {
        client.write(
          'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
        )
      })
      let text = ''
      client.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
      })
      client.on('end', () => {
        resolve(text)
      })
      client.on('error', reject)
    })

    expect(answer.startsWith('HTTP/1.1 501')).toBe(true)
    expect(httpRow(service).status).toBe(501)
  })
})

describe('CaptureStore', () => {
  const input = {
    method: 'GET',
    url: '/x',
    forwardedUrl: 'http://up/x',
    requestHeaders: [] as [string, string][],
    forwardedHeaders: [] as [string, string][],
  }

  it('drops the least recently read capture first, not the oldest written', () => {
    const store = new CaptureStore({ entries: 2 })
    const first = store.start(input, 1)
    const second = store.start(input, 2)
    first.response.push(Buffer.alloc(10))
    second.response.push(Buffer.alloc(20))

    // Reading the older one is what makes it the more valuable of the two.
    expect(store.get(first.id)).not.toBeNull()

    expect(store.evictLeastRecent(20)).toBe(20)
    expect(store.get(first.id)).not.toBeNull()
    expect(store.get(second.id)).toBeNull()
    expect(store.wasEvicted(second.id)).toBe(true)
  })

  it('never evicts the capture it is making room for', () => {
    const store = new CaptureStore({ entries: 2 })
    const only = store.start(input, 1)
    only.response.push(Buffer.alloc(5))

    expect(store.evictLeastRecent(100, only.id)).toBe(0)
    expect(store.get(only.id)).not.toBeNull()
  })

  it('keeps only the newest entries when the count is what is over', () => {
    const store = new CaptureStore({ entries: 1 })
    const first = store.start(input, 1)
    store.start(input, 2)
    expect(store.get(first.id)).toBeNull()
    expect(store.wasEvicted(first.id)).toBe(true)
  })
})

describe('capture accounting', () => {
  it('charges the decoded copy to the budget, and gives it back', async () => {
    const charged: string[] = []
    const released: string[] = []
    const body = new CapturedBody(
      1_000,
      {
        retain: (captureId) => {
          charged.push(captureId)
          return null
        },
        release: (captureId) => {
          released.push(captureId)
        },
      },
      () => 'capture-1'
    )
    body.contentEncoding = 'gzip'
    body.push(gzipSync(Buffer.from('{"code":"OK"}')))

    expect(await body.decode()).toBe('ready')
    expect(charged.some((key) => key.endsWith(':decoded'))).toBe(true)
    expect(released).toHaveLength(0)

    body.release()
    expect(released).toHaveLength(2)
  })

  it('drops the decoded copy when the budget refuses it', async () => {
    const body = new CapturedBody(
      1_000,
      {
        retain: (captureId) => (captureId.endsWith(':decoded') ? 'global-budget' : null),
        release: () => undefined,
      },
      () => 'capture-1'
    )
    body.contentEncoding = 'gzip'
    body.push(gzipSync(Buffer.from('{"code":"OK"}')))

    expect(await body.decode()).toBe('limit')
    expect(body.decodedPage(0, 64)).toBeNull()
  })

  it('shares one decode between readers that arrive together, and charges once', async () => {
    const charged: string[] = []
    const body = new CapturedBody(
      1_000,
      {
        retain: (captureId) => {
          charged.push(captureId)
          return null
        },
        release: () => undefined,
      },
      () => 'capture-1'
    )
    body.contentEncoding = 'gzip'
    body.push(gzipSync(Buffer.from('{"code":"OK"}')))

    const [first, second] = await Promise.all([body.decode(), body.decode()])

    expect(first).toBe('ready')
    expect(second).toBe('ready')
    expect(charged.filter((key) => key.endsWith(':decoded'))).toHaveLength(1)
    expect(body.decodedPage(0, 64)?.toString('utf8')).toBe('{"code":"OK"}')
  })
})

describe('pending rows', () => {
  it('shows the request before it is answered, then fills the same row in', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const source = await upstream((_req, res) => {
      void held.then(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
    })
    const { service, port } = await proxy({ origin: `http://127.0.0.1:${String(source.port)}` })

    const answered = through(port, '/slow')
    await until(() => service.snapshot().length > 0)

    expect(service.snapshot()).toHaveLength(1)
    expect(httpRow(service).status).toBeNull()

    release()
    await answered
    await until(() => httpRow(service).status !== null)

    // The same row, not a second one: a request is one line that fills in.
    expect(service.snapshot()).toHaveLength(1)
    expect(httpRow(service).status).toBe(200)
  })
})
