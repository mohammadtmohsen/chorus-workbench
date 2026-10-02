import {
  request as upstreamRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { randomUUID } from 'node:crypto'
import { request as secureRequest } from 'node:https'
import type { Socket } from 'node:net'
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createUnzip,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
} from 'node:zlib'
import { TRAFFIC_CAPTURE } from '../shared/ipc.js'
import type { Frame, TerminalRef } from './terminal.js'

export interface TrafficHttpRow {
  readonly source: 'http'
  readonly seq: number
  /** The capture this row names, for the detail and body reads that follow it. */
  readonly requestId: string
  readonly m: string
  readonly u: string
  readonly dpop: boolean
  /** Null until upstream answered: the row exists from the moment the request does. */
  readonly status: number | null
  readonly aborted: boolean
  readonly parsed: boolean
  readonly code: string | null
  readonly nextAction: string | null
  /**
   * Why the exchange failed to happen, when it did not happen.
   *
   * Separate from `code`, and the separation is the point. `code` is parsed out
   * of a response body — a thing the backend *said*, and it is null precisely
   * when there was no body to parse. A transport failure is the opposite fact:
   * there was no answer, and this is why. One field holding both would make
   * `ECONNREFUSED` and `APP_SESSION_REVOKED` indistinguishable to every reader
   * downstream, which is the blank this exists to replace with provenance rather
   * than without it.
   */
  readonly transport: string | null
}

export interface TrafficLogRow {
  readonly source: 'log'
  readonly seq: number
  readonly ref: TerminalRef
  readonly line: string
  readonly exit: number | null
}

export interface TrafficLogcatRow {
  readonly source: 'logcat'
  readonly seq: number
  readonly line: string
}

export type TrafficRow = TrafficHttpRow | TrafficLogRow | TrafficLogcatRow

export type TrafficEntry =
  Omit<TrafficHttpRow, 'seq'> | Omit<TrafficLogRow, 'seq'> | Omit<TrafficLogcatRow, 'seq'>

export interface TrafficPush {
  readonly kind: 'rows'
  readonly epoch: number
  readonly seq: number
  readonly rows: readonly TrafficRow[]
}

export interface TrafficAttachment {
  readonly epoch: number
  readonly seq: number
  readonly rows: readonly TrafficRow[]
}

export interface TrafficServiceOptions {
  readonly capture?: number
  readonly tap?: number
  readonly frame?: Frame
  readonly origin?: string
  readonly budget?: CaptureBudget | null
  readonly now?: () => number
  /** How much of one body to keep, per direction. A seam for tests, not a knob. */
  readonly bodyLimit?: number
}

const TAP = 8_192
const UPSTREAM_TIMEOUT_MS = 30_000
const UPSTREAM_TIMEOUT = 'upstream timeout'

/**
 * What a listener binds when no host is named.
 *
 * Loopback, and the argument is what this process is: a proxy that forwards the
 * project's credentials to an origin. Binding every interface is a decision
 * somebody makes for a reason — `access: 'lan'` is exactly that reason — and it
 * belongs at the call site rather than in a default nobody reads.
 */
const LOOPBACK = '127.0.0.1'

const frameTimer: Frame = (run) => {
  const handle = setTimeout(run, 8)
  return () => {
    clearTimeout(handle)
  }
}

interface Envelope {
  readonly parsed: boolean
  readonly code: string | null
  readonly nextAction: string | null
}

const UNREAD: Envelope = { parsed: false, code: null, nextAction: null }

/**
 * The shortest true name for a failed exchange.
 *
 * `code` first, because `ECONNREFUSED` is the token people search for and it
 * does not vary with the address. A `destroy` given a hand-made Error — the
 * timeout — carries none, so its message is the name; and a message that is
 * somehow empty is no name at all rather than a blank one.
 */
const reasonOf = (error: NodeJS.ErrnoException): string | null => {
  const named = error.code ?? error.message
  return named === '' ? null : named
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const envelopeOf = (text: string): Envelope => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return UNREAD
  }
  if (!isPlainObject(body)) return UNREAD
  const data = isPlainObject(body['data']) ? body['data'] : null
  return {
    parsed: true,
    code: typeof body['code'] === 'string' ? body['code'] : null,
    nextAction: typeof data?.['nextAction'] === 'string' ? data['nextAction'] : null,
  }
}

const inflate = (prefix: Buffer): Promise<string> =>
  new Promise((resolve) => {
    const parts: Buffer[] = []
    const settle = (): void => {
      resolve(Buffer.concat(parts).toString('utf8'))
    }
    const unzip = createUnzip()
    unzip.on('data', (chunk: Buffer) => {
      parts.push(chunk)
    })
    unzip.on('end', settle)
    unzip.on('error', settle)
    unzip.end(prefix)
  })

const decode = async (prefix: Buffer, encoding: string | undefined): Promise<string | null> => {
  const kind = (encoding ?? 'identity').trim().toLowerCase()
  if (kind === '' || kind === 'identity') return prefix.toString('utf8')
  if (kind !== 'gzip' && kind !== 'x-gzip' && kind !== 'deflate') return null
  return inflate(prefix)
}

export const BODY_LIMIT = 1_048_576

export type BodyState = 'pending' | 'streaming' | 'complete' | 'aborted' | 'unavailable' | 'evicted'

export type BodyTruncation = 'body-limit' | 'project-budget' | 'global-budget'

export type BodyDecoding = 'not-requested' | 'ready' | 'unsupported' | 'invalid' | 'limit'

export type RetentionRefusal = 'project-budget' | 'global-budget'

export interface CaptureBudget {
  readonly retain: (captureId: string, bytes: number) => RetentionRefusal | null
  readonly release: (captureId: string, bytes: number) => void
}

export type HeaderPair = [string, string]

export interface BodyDescriptor {
  readonly state: BodyState
  readonly truncation: BodyTruncation | null
  readonly observedBytes: number
  readonly capturedBytes: number
  readonly contentType: string | null
  readonly contentEncoding: string | null
  readonly decoding: BodyDecoding
}

export interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly forwardedUrl: string
  readonly requestHeaders: readonly HeaderPair[]
  readonly forwardedHeaders: readonly HeaderPair[]
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function trailerPairs(trailers: NodeJS.Dict<string | string[]>): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (const [name, value] of Object.entries(trailers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const each of value) pairs.push([name, each])
    } else {
      pairs.push([name, value])
    }
  }
  return pairs
}

export function headerPairs(flat: readonly string[]): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([flat[index] ?? '', flat[index + 1] ?? ''])
  }
  return pairs
}

const heldBack = (pairs: readonly HeaderPair[]): HeaderPair[] =>
  pairs.filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()))

/**
 * One direction of one exchange, as it passed.
 *
 * **Two counters, never one.** `observedBytes` is what the wire carried and
 * `capturedBytes` is what was kept; a body that was past the cap has an honest
 * observed size and a smaller retained size, and collapsing them would make
 * truncation invisible — which is the failure this whole type exists to avoid.
 *
 * Retention asks the budget before it keeps anything, so a project at its limit
 * stops storing rather than storing and then being told it should not have.
 */
export class CapturedBody {
  private readonly parts: Buffer[] = []
  private readonly limit: number
  private readonly budget: CaptureBudget | null
  private readonly captureId: () => string
  private decoded: Buffer | null = null
  private decodeRun: Promise<BodyDecoding> | null = null

  /*
   * Declared rather than initialised in place, deliberately. A field written
   * `truncation: X | null = null` narrows to `null` for the compiler until
   * something in the same function reassigns it, so a later `!== null` reads as
   * an impossible comparison — and the counter that proves a body was truncated
   * is exactly the one that must not be simplified away.
   */
  observedBytes: number
  capturedBytes: number
  decodedBytes: number
  truncation: BodyTruncation | null
  decoding: BodyDecoding
  state: BodyState
  contentType: string | null
  contentEncoding: string | null

  constructor(limit: number, budget: CaptureBudget | null, captureId: () => string) {
    this.limit = limit
    this.budget = budget
    this.captureId = captureId
    this.observedBytes = 0
    this.capturedBytes = 0
    this.decodedBytes = 0
    this.truncation = null
    this.decoding = 'not-requested'
    this.state = 'pending'
    this.contentType = null
    this.contentEncoding = null
  }

  push(chunk: Buffer): void {
    this.observedBytes += chunk.length
    if (this.state === 'pending') this.state = 'streaming'

    const room = this.limit - this.capturedBytes
    if (room <= 0) {
      this.truncation ??= 'body-limit'
      return
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (kept.length < chunk.length) this.truncation ??= 'body-limit'

    if (this.budget !== null) {
      const refused = this.budget.retain(this.captureId(), kept.length)
      if (refused !== null) {
        this.truncation ??= refused
        return
      }
    }
    this.parts.push(kept)
    this.capturedBytes += kept.length
  }

  settle(state: BodyState): void {
    if (this.state === 'pending') this.state = state === 'complete' ? 'unavailable' : state
    else this.state = state
  }

  /**
   * The decoded body, or why there is not one.
   *
   * Bounded by counting output rather than by leaving it to a library default:
   * a decompression bomb is a small encoded body that expands past any budget
   * the encoded side measured, so the decoded cap has to be its own.
   */
  async decode(): Promise<BodyDecoding> {
    if (this.decoding === 'ready') return this.decoding
    this.decodeRun ??= withDecodeSlot(async () => await this.decodeWithinSlot())
    return this.decodeRun
  }

  private async decodeWithinSlot(): Promise<BodyDecoding> {
    const encoding = (this.contentEncoding ?? '').trim().toLowerCase()
    if (encoding === '' || encoding === 'identity') {
      // No second copy: an identity body is already its own decoded form, and
      // holding the same bytes twice would charge the budget twice for one
      // answer. `decodedPage` reads through to the encoded parts.
      this.decoding = this.truncationReason() === null ? 'ready' : 'limit'
      return this.decoding
    }
    const unzip = decompressor(encoding)
    if (unzip === null) {
      this.decoding = 'unsupported'
      return this.decoding
    }

    const parts: Buffer[] = []
    let total = 0
    const outcome = await new Promise<'ok' | 'over' | 'bad'>((resolve) => {
      unzip.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > this.limit) {
          unzip.destroy()
          resolve('over')
          return
        }
        parts.push(chunk)
      })
      unzip.on('end', () => {
        resolve('ok')
      })
      unzip.on('error', () => {
        resolve('bad')
      })
      unzip.end(Buffer.concat(this.parts))
    })

    if (this.truncationReason() !== null) {
      this.decoding = 'limit'
      return this.decoding
    }
    if (outcome !== 'ok') {
      this.decoding = outcome === 'over' ? 'limit' : 'invalid'
      return this.decoding
    }
    const whole = Buffer.concat(parts)
    if (this.budget !== null && whole.length > 0) {
      const refused = this.budget.retain(decodedKey(this.captureId()), whole.length)
      if (refused !== null) {
        // The budget refused the decoded copy specifically, so it is dropped
        // and said so. The encoded body is still there and still honest.
        this.decoding = 'limit'
        return this.decoding
      }
    }
    this.decoded = whole
    this.decodedBytes = whole.length
    this.decoding = 'ready'
    return this.decoding
  }

  /*
   * Read through a call rather than the field.
   *
   * A direct `this.truncation !== null` is reported by the linter as an
   * impossible comparison, because the field is initialised to `null` in the
   * constructor and the analysis does not follow the reassignment inside
   * `push`. `tsc` is happy either way; this keeps the deliberate check without
   * switching the rule off for the file that most needs it.
   */
  truncationReason(): BodyTruncation | null {
    return this.truncation
  }

  encodedPage(offset: number, length: number): Buffer | null {
    const whole = Buffer.concat(this.parts)
    if (offset >= whole.length) return Buffer.alloc(0)
    return whole.subarray(offset, Math.min(offset + length, whole.length))
  }

  decodedPage(offset: number, length: number): Buffer | null {
    if (this.decoded === null) {
      const encoding = (this.contentEncoding ?? '').trim().toLowerCase()
      if (encoding === '' || encoding === 'identity') return this.encodedPage(offset, length)
      return null
    }
    if (offset >= this.decoded.length) return Buffer.alloc(0)
    return this.decoded.subarray(offset, Math.min(offset + length, this.decoded.length))
  }

  descriptor(): BodyDescriptor {
    return {
      state: this.state,
      truncation: this.truncation,
      observedBytes: this.observedBytes,
      capturedBytes: this.capturedBytes,
      contentType: this.contentType,
      contentEncoding: this.contentEncoding,
      decoding: this.decoding,
    }
  }

  /** Releases what it kept, so the budget is not charged for what is gone. */
  release(): void {
    if (this.budget !== null) {
      if (this.capturedBytes > 0) this.budget.release(this.captureId(), this.capturedBytes)
      if (this.decodedBytes > 0) {
        this.budget.release(decodedKey(this.captureId()), this.decodedBytes)
      }
    }
    this.parts.length = 0
    this.decoded = null
    this.capturedBytes = 0
    this.decodedBytes = 0
  }
}

const decodedKey = (captureId: string): string => `${captureId}:decoded`

const DECODE_SLOTS = 2
let decodesActive = 0
const decodeQueue: (() => void)[] = []

/**
 * At most two bodies decode at once, application-wide.
 *
 * Decoding is the one part of capture that is neither bounded by the wire nor
 * free: a compressed body expands past what the encoded caps measured, and a
 * burst of them would allocate faster than the ledger can refuse. A slot is
 * taken before the work starts and given back however it finishes, so a
 * throwing decoder cannot strand one.
 */
const withDecodeSlot = async <T>(run: () => Promise<T>): Promise<T> => {
  if (decodesActive >= DECODE_SLOTS) {
    await new Promise<void>((resolve) => {
      decodeQueue.push(resolve)
    })
  }
  decodesActive += 1
  try {
    return await run()
  } finally {
    decodesActive -= 1
    const next = decodeQueue.shift()
    next?.()
  }
}

const decompressor = (encoding: string): Gunzip | Inflate | BrotliDecompress | null => {
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip()
  if (encoding === 'deflate') return createInflate()
  if (encoding === 'br') return createBrotliDecompress()
  return null
}

export class TrafficCaptured {
  readonly request: CapturedBody
  readonly response: CapturedBody
  readonly startedAt: number

  responseHeaders: readonly HeaderPair[] = []
  trailers: readonly HeaderPair[] = []
  status: number | null = null
  transport: string | null = null
  outcome: BodyState = 'pending'
  upstreamAt: number | null = null
  upstreamDoneAt: number | null = null
  settledAt: number | null = null

  constructor(
    readonly id: string,
    readonly input: CapturedRequest,
    limit: number,
    budget: CaptureBudget | null,
    now: number
  ) {
    this.startedAt = now
    this.request = new CapturedBody(limit, budget, () => this.id)
    this.response = new CapturedBody(limit, budget, () => this.id)
  }
}

const EVICTED_MEMORY = 500

export class CaptureStore {
  private readonly entries = new Map<string, TrafficCaptured>()
  private readonly touched = new Map<string, number>()
  private readonly evicted = new Set<string>()
  private readonly budget: CaptureBudget | null
  private readonly limit: number
  private readonly maxEntries: number
  private clock = 0

  constructor(options: { budget?: CaptureBudget | null; limit?: number; entries?: number } = {}) {
    this.budget = options.budget ?? null
    this.limit = options.limit ?? BODY_LIMIT
    this.maxEntries = options.entries ?? 200
  }

  start(input: CapturedRequest, now: number): TrafficCaptured {
    const capture = new TrafficCaptured(randomUUID(), input, this.limit, this.budget, now)
    this.entries.set(capture.id, capture)
    this.touched.set(capture.id, this.tick())
    this.evicted.delete(capture.id)
    this.fitCount()
    return capture
  }

  /**
   * Reading a capture is what makes it recent.
   *
   * The plan evicts the least-recently *used* detail, so the clock is advanced
   * by a read as much as by a write — a request somebody is looking at is worth
   * more than one nobody has opened, whatever order they arrived in.
   */
  get(id: string): TrafficCaptured | null {
    const capture = this.entries.get(id)
    if (capture === undefined) return null
    this.touched.set(id, this.tick())
    return capture
  }

  /** Whether this id was dropped to make room, as opposed to never existing. */
  wasEvicted(id: string): boolean {
    return this.evicted.has(id)
  }

  /**
   * Frees at least `needed` retained bytes, oldest read first.
   *
   * **Whole captures, not trimmed bodies.** Half a body answers no question
   * anyone has, and the row still says the detail was evicted — so the person
   * learns the truth instead of reading a prefix as if it were the whole thing.
   * A capture is never taken to make room for its own bytes.
   */
  evictLeastRecent(needed: number, keepId: string | null = null): number {
    let freed = 0
    while (freed < needed) {
      const oldest = this.oldest(keepId)
      if (oldest === null) break
      freed += this.drop(oldest)
    }
    return freed
  }

  clear(): void {
    for (const [id, capture] of this.entries) {
      capture.request.release()
      capture.response.release()
      this.touched.delete(id)
      this.evicted.add(id)
    }
    this.entries.clear()
  }

  private oldest(keepId: string | null): string | null {
    let chosen: string | null = null
    let chosenAt = Number.POSITIVE_INFINITY
    for (const id of this.entries.keys()) {
      if (id === keepId) continue
      const at = this.touched.get(id) ?? 0
      if (at < chosenAt) {
        chosenAt = at
        chosen = id
      }
    }
    return chosen
  }

  private drop(id: string): number {
    const capture = this.entries.get(id)
    if (capture === undefined) return 0
    const freed = capture.request.capturedBytes + capture.response.capturedBytes
    capture.request.release()
    capture.response.release()
    capture.outcome = 'evicted'
    capture.request.state = 'evicted'
    capture.response.state = 'evicted'
    this.entries.delete(id)
    this.touched.delete(id)
    this.evicted.add(id)
    if (this.evicted.size > EVICTED_MEMORY) {
      const first = this.evicted.values().next()
      if (!first.done) this.evicted.delete(first.value)
    }
    return freed
  }

  private fitCount(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.oldest(null)
      if (oldest === null) return
      this.drop(oldest)
    }
  }

  private tick(): number {
    this.clock += 1
    return this.clock
  }
}

export class TrafficService {
  private readonly rows: TrafficRow[] = []
  private readonly outbox: TrafficRow[] = []
  private readonly listeners = new Set<(push: TrafficPush) => void>()
  private readonly failures = new Set<(error: Error) => void>()

  private readonly capture: number
  private readonly tapBytes: number
  private readonly frame: Frame
  private origin: URL | null

  private server: Server | null = null
  private seq = 0
  private epoch = 0
  private attached = false
  private flush: (() => void) | null = null

  private readonly captures: CaptureStore
  private readonly now: () => number

  constructor(options: TrafficServiceOptions = {}) {
    this.capture = options.capture ?? TRAFFIC_CAPTURE
    this.tapBytes = options.tap ?? TAP
    this.frame = options.frame ?? frameTimer
    this.origin = options.origin === undefined ? null : new URL(options.origin)
    this.captures = new CaptureStore({
      budget: options.budget ?? null,
      limit: options.bodyLimit ?? BODY_LIMIT,
    })
    this.now = options.now ?? Date.now
  }

  /** One captured exchange's headers, bodies and timing, or null once it is gone. */
  captured(id: string): TrafficCaptured | null {
    return this.captures.get(id)
  }

  /** Drops every retained body and hands their bytes back to the budget. */
  clearCaptures(): void {
    this.captures.clear()
  }

  /**
   * Frees retained bytes for something else to use, oldest read first.
   *
   * The registry asks across every project before it tells a body its bytes
   * cannot be kept: a budget that only refuses turns one project's growth into
   * another project's silence, where freeing what nobody has looked at answers
   * the same question without losing anything anybody wanted.
   */
  evictLeastRecent(needed: number, keepId: string | null = null): number {
    return this.captures.evictLeastRecent(needed, keepId)
  }

  /** Whether a capture was dropped to make room, as opposed to never existing. */
  wasEvicted(id: string): boolean {
    return this.captures.wasEvicted(id)
  }

  listen(port = 0, host: string | null = LOOPBACK): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer(this.handle)
      let open = false
      server.on('connect', this.tunnel)
      /*
       * An upgrade is refused in the open, not destroyed silently.
       *
       * The socket used to be dropped with nothing written and nothing
       * recorded, which reads to whoever is debugging as a vanished request
       * rather than an unsupported one. This build forwards no WebSocket
       * frames, so the honest answer is a status the client can act on and a
       * row the person can see.
       */
      server.on('upgrade', (request, socket) => {
        socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        this.absorb({
          source: 'http',
          m: request.method ?? 'GET',
          u: request.url ?? '',
          dpop: false,
          status: 501,
          aborted: false,
          requestId: '',
          parsed: false,
          code: null,
          nextAction: null,
          transport: null,
        })
      })
      server.on('error', (error: Error) => {
        if (open) this.fail(error)
        else reject(error)
      })
      server.listen(port, host ?? undefined, () => {
        const address = server.address()
        open = true
        this.server = server
        const port = typeof address === 'object' && address !== null ? address.port : 0
        resolve(port)
      })
    })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
      server.closeAllConnections()
    })
  }

  subscribe(listener: (push: TrafficPush) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener)
    return () => {
      this.failures.delete(listener)
    }
  }

  attach(): TrafficAttachment {
    this.epoch += 1
    this.attached = true
    this.outbox.length = 0
    if (this.flush !== null) {
      this.flush()
      this.flush = null
    }
    return { epoch: this.epoch, seq: this.seq, rows: [...this.rows] }
  }

  detach(epoch: number): void {
    if (epoch !== this.epoch) return
    this.attached = false
    this.outbox.length = 0
  }

  snapshot(): readonly TrafficRow[] {
    return [...this.rows]
  }

  logLine(ref: TerminalRef, line: string, exit: number | null = null): void {
    this.absorb({ source: 'log', ref, line, exit })
  }

  logcatLine(line: string): void {
    this.absorb({ source: 'logcat', line })
  }

  originUrl(): string | null {
    return this.origin?.toString() ?? null
  }

  setOrigin(origin: string | null): void {
    this.origin = origin === null ? null : new URL(origin)
  }

  private readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? 'GET'
    const line = req.url ?? ''
    const dpop = req.headers['dpop'] !== undefined
    const started = this.now()
    const target = this.targetOf(req.url)
    const requestHeaders = headerPairs(req.rawHeaders)
    const capture = this.captures.start(
      {
        method,
        url: line,
        forwardedUrl: target?.toString() ?? '',
        requestHeaders,
        forwardedHeaders: heldBack(requestHeaders),
      },
      started
    )
    capture.request.contentType = req.headers['content-type'] ?? null
    capture.request.contentEncoding = req.headers['content-encoding'] ?? null
    /*
     * The row goes up before the exchange happens, not after it.
     *
     * A pending row is the whole answer to "why is nothing happening": a
     * request that has not been answered is a fact about the app the person is
     * owed immediately, and one that appeared only at settle would make every
     * slow request look like no request at all.
     */
    const rowSeq = this.absorb({
      source: 'http',
      m: method,
      u: line,
      dpop,
      status: null,
      aborted: false,
      requestId: capture.id,
      parsed: false,
      code: null,
      nextAction: null,
      transport: null,
    })

    let recorded = false
    const record = (
      u: string,
      status: number,
      envelope: Envelope,
      aborted: boolean,
      transport: string | null
    ): void => {
      if (recorded) return
      recorded = true
      capture.status = status
      capture.transport = transport
      capture.settledAt = this.now()
      capture.outcome = aborted ? 'aborted' : 'complete'
      capture.request.settle(capture.request.state === 'pending' ? 'unavailable' : 'complete')
      capture.response.settle(aborted ? 'aborted' : 'complete')
      void capture.response.decode()
      this.absorb(
        {
          source: 'http',
          m: method,
          u,
          dpop,
          status,
          aborted,
          requestId: capture.id,
          transport,
          ...envelope,
        },
        rowSeq
      )
    }

    req.on('data', (chunk: Buffer) => {
      capture.request.push(chunk)
    })

    if (target === null) {
      res.on('error', () => undefined)
      res.writeHead(400)
      res.end()
      record(line, 400, UNREAD, false, null)
      return
    }
    const url = target.toString()
    const forward = target.protocol === 'https:' ? secureRequest : upstreamRequest

    const up = forward(
      {
        host: target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { ...req.headers, host: target.host },
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502
        capture.upstreamAt = this.now()
        capture.status = status
        capture.responseHeaders = headerPairs(upRes.rawHeaders)
        capture.response.contentType = upRes.headers['content-type'] ?? null
        capture.response.contentEncoding = upRes.headers['content-encoding'] ?? null
        res.writeHead(status, upRes.headers)
        upRes.pipe(res)
        upRes.on('data', (chunk: Buffer) => {
          capture.response.push(chunk)
        })
        upRes.on('end', () => {
          capture.upstreamDoneAt = this.now()
          capture.trailers = trailerPairs(upRes.trailers)
        })
        const envelope = this.tap(upRes)
        const settle = (read: Envelope, transport: string | null): void => {
          record(url, status, read, false, transport)
        }
        upRes.on('end', () => {
          void envelope.then((read) => {
            settle(read, null)
          })
        })
        /*
         * **A second failure path, and the one a status cannot describe.**
         *
         * `up` errors when the connection never establishes; this one errors when
         * the response stream dies *after* the headers are through — the upstream
         * process exiting mid-body, a reset. The status here is the upstream's
         * own, so the row is not a 502 and nothing else about it says the
         * exchange failed; without a reason it read as a complete response whose
         * body merely looked short.
         */
        upRes.on('error', (error: NodeJS.ErrnoException) => {
          void envelope.then((read) => {
            settle(read, reasonOf(error))
          })
        })
      }
    )

    const sentStatus = (): number => (res.headersSent ? res.statusCode : 502)
    const gone = (): boolean => res.writableEnded || res.destroyed
    const abandon = (): void => {
      record(url, sentStatus(), UNREAD, true, null)
      up.destroy()
    }

    up.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      up.destroy(new Error(UPSTREAM_TIMEOUT))
    })
    /*
     * The one moment this knows something the app under test cannot.
     *
     * The app is handed a bare 502 and cannot tell a refused socket from a
     * timeout from a DNS failure — it only sees that the call failed. Chorus is
     * standing on the connection and holds the reason, and it used to drop it
     * here: the error was not even bound. So every unreachable backend produced
     * a row with nothing behind it, and the person debugging had nowhere to
     * look, which is the whole thing this panel is for.
     *
     * `code` when Node gives one, because `ECONNREFUSED` is the token people
     * search for and it is stable. A `destroy` with a hand-made Error — the
     * timeout above — carries no code, so its message is the name.
     */
    up.on('error', (error: NodeJS.ErrnoException) => {
      record(url, sentStatus(), UNREAD, false, reasonOf(error))
      if (gone()) return
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.on('error', abandon)
    res.on('error', abandon)
    res.on('close', () => {
      if (res.writableFinished) return
      abandon()
    })
    req.pipe(up)
  }

  /**
   * A CONNECT is refused, and the argument is the row this feature cannot write.
   *
   * What stood here opened a socket to whatever host the request named and piped
   * bytes both ways. It checked the port and never the host, so on
   * `access: 'lan'` — the listener on every interface — it relayed for anyone on
   * the network, and it recorded nothing either way. A byte relay that is
   * invisible in the panel built to make traffic visible is the exact inverse of
   * this feature's job.
   *
   * **Restricting it to the configured origin was the alternative, and it does
   * not answer that.** A CONNECT is opaque TLS from the first byte after the
   * response, so even a tunnel to the right host produces nothing `tap` and
   * `decode` can read: no envelope, no code, no next action. The tunnel's entire
   * product is zero rows, and bounding *where* it relays leaves it relaying
   * invisibly — one string comparison away from the hole it is today, which is
   * how this arrived.
   *
   * So the capability is removed rather than narrowed, and refused the way an
   * upgrade already is a few lines above: a status the client can act on and a
   * row the person can see. A client that was being silently relayed is told
   * instead, and can be pointed at the plain-HTTP path that does get captured.
   */
  private readonly tunnel = (req: IncomingMessage, client: Socket): void => {
    client.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    this.absorb({
      source: 'http',
      m: 'CONNECT',
      u: req.url ?? '',
      dpop: false,
      status: 501,
      aborted: false,
      requestId: '',
      parsed: false,
      code: null,
      nextAction: null,
      transport: null,
    })
  }

  private tap(res: IncomingMessage): Promise<Envelope> {
    const parts: Buffer[] = []
    let held = 0
    res.on('data', (chunk: Buffer) => {
      const room = this.tapBytes - held
      if (room <= 0) return
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
      parts.push(kept)
      held += kept.length
    })
    return new Promise<Envelope>((resolve) => {
      res.on('error', () => {
        resolve(UNREAD)
      })
      res.on('end', () => {
        const prefix = Buffer.concat(parts)
        void decode(prefix, res.headers['content-encoding'])
          .then((text) => {
            resolve(text === null ? UNREAD : envelopeOf(text))
          })
          .catch(() => {
            resolve(UNREAD)
          })
      })
    })
  }

  private targetOf(raw: string | undefined): URL | null {
    if (raw === undefined) return null
    if (this.origin !== null) {
      try {
        return new URL(raw, this.origin)
      } catch {
        return null
      }
    }
    try {
      const url = new URL(raw)
      return url.protocol === 'http:' ? url : null
    } catch {
      return null
    }
  }

  /**
   * Writes a row, or rewrites one that is already there.
   *
   * An exchange is two facts, not one: it started, and it settled. The row is
   * the same row both times — the plan's "update row in place by request ID" —
   * so this upserts by sequence rather than appending, which is what lets a
   * request that takes thirty seconds appear at once and fill in later.
   */
  private absorb(entry: TrafficEntry, at: number | null = null): number {
    const seq = at ?? this.seq + 1
    if (at === null) this.seq = seq
    const row: TrafficRow = { ...entry, seq }
    const existing = this.rows.findIndex((each) => each.seq === seq)
    /*
     * **A settle for a row the window has already trimmed is dropped, not
     * appended.**
     *
     * `at` is the sequence the request was given when it started. A row is only
     * ever trimmed from the front, so a request slow enough to outlive the whole
     * window settles with no row left to rewrite — and pushing it here would put
     * the oldest sequence in the newest position, which is a list that lies
     * about its own order.
     *
     * Nothing is lost by dropping it. The window is a bound on what is *shown*,
     * and this row was already outside it: appending would undo the trim that
     * removed it. The exchange is still in the capture store while the service
     * lives, so the only thing given up is a listing that would have been in the
     * wrong place.
     */
    if (at !== null && existing === -1) return seq
    if (existing === -1) this.rows.push(row)
    else this.rows[existing] = row
    const overflow = this.rows.length - this.capture
    if (overflow > 0) this.rows.splice(0, overflow)

    if (!this.attached) return seq
    this.outbox.push(row)
    this.schedule()
    return seq
  }

  private schedule(): void {
    if (this.flush !== null) return
    this.flush = this.frame(() => {
      this.flush = null
      this.drain()
    })
  }

  private drain(): void {
    if (this.flush !== null) {
      this.flush()
      this.flush = null
    }
    if (this.outbox.length === 0) return
    const rows = [...this.outbox]
    this.outbox.length = 0
    const push: TrafficPush = { kind: 'rows', epoch: this.epoch, seq: this.seq, rows }
    for (const listener of this.listeners) listener(push)
  }

  private fail(error: Error): void {
    for (const listener of this.failures) listener(error)
  }
}
