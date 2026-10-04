import {
  PROJECT_TERMINAL_LINES,
  PROJECT_TRAFFIC_COUNT,
  PROJECT_TRAFFIC_SKIP,
  type ProjectReader,
} from '@chorus/agent-protocol'
import type {
  TrafficBodyDescriptor,
  TrafficDetail,
  TrafficReadResult,
} from '../shared/traffic-ipc.js'
import { maskHeaders } from '../shared/traffic-mask.js'
import { runRef, type ActiveCommand, type ProjectRunner, type RunProcess } from './project-run.js'
import type { ProjectTrafficRegistry } from './project-traffic.js'
import type { TerminalService } from './terminal.js'
import type { TrafficHttpRow } from './traffic.js'

export const TERMINAL_BYTES = 65_536
export const TRAFFIC_BYTES = 65_536
export const REQUEST_BYTES = 32_768
export const BODY_BYTES = 8_192
export const HEADERS_PER_LIST = 100
export const HEADER_VALUE_BYTES = 1_024
export const HEADER_NAME_BYTES = 256
export const URL_BYTES = 2_048
export const FIELD_BYTES = 256

export const PROJECT_GONE = 'This conversation’s project is no longer a local project in Chorus.'

export interface ProjectReadDeps {
  readonly local: (projectId: string) => boolean
  readonly runner: Pick<ProjectRunner, 'snapshot'>
  readonly terminals: Pick<TerminalService, 'readText'>
  readonly traffic: Pick<
    ProjectTrafficRegistry,
    'journal' | 'state' | 'detail' | 'decodedReady' | 'bodyPage'
  >
}

type BodyState =
  | 'complete'
  | 'truncated'
  | 'pending'
  | 'aborted'
  | 'unavailable'
  | 'evicted'
  | 'cleared'
  | 'not-found'
  | 'unsupported'

interface BodyRead {
  readonly state: BodyState
  readonly reason: TrafficBodyDescriptor['truncation']
  readonly contentType: string | null
  readonly contentEncoding: string | null
  readonly decoding: TrafficBodyDescriptor['decoding']
  readonly observedBytes: number
  readonly capturedBytes: number
  readonly binary: boolean
  text: string | null
}

interface HeaderList {
  readonly total: number
  readonly shown: (readonly [string, string])[]
}

const CUT_FIELDS = [
  'method',
  'url',
  'forwardedUrl',
  'transport',
  'requestBody',
  'responseBody',
  'requestHeaders',
  'responseHeaders',
  'trailers',
] as const

type CutField = (typeof CUT_FIELDS)[number]

interface TrafficRead {
  readonly requestId: string | null
  readonly method: string
  readonly path: string
  readonly pathCut?: true
  readonly status: number | null
  readonly outcome: 'aborted' | 'pending' | 'failed' | 'answered'
  readonly code: string | null
  readonly nextAction: string | null
  readonly transport: string | null
}

const NULL_BYTES = 4

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const fit = (text: string, room: number): string => {
  if (jsonBytes(text) <= room) return text
  const points = Array.from(text)
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (jsonBytes(points.slice(0, middle).join('')) <= room) low = middle
    else high = middle - 1
  }
  return points.slice(0, low).join('')
}

const clip = (text: string, room: number): { readonly text: string; readonly cut: boolean } => {
  const kept = fit(text, room)
  return { text: kept, cut: kept.length < text.length }
}

const boundary = (bytes: Uint8Array, end: number): number => {
  let lead = end
  while (lead > 0 && end - lead < 3 && ((bytes[lead - 1] ?? 0) & 0xc0) === 0x80) lead -= 1
  if (lead === 0) return end
  const first = bytes[lead - 1] ?? 0
  const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
  return end - (lead - 1) < width ? lead - 1 : end
}

const isControl = (byte: number): boolean => byte < 9 || (byte > 13 && byte < 32)

const textOf = (bytes: Uint8Array): string | null => {
  if (bytes.some(isControl)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const within = (value: number, bounds: { readonly min: number; readonly max: number }): number =>
  Number.isFinite(value)
    ? Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
    : bounds.min

const later = <T>(read: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(read())
  })

const ensure = (deps: ProjectReadDeps, projectId: string): void => {
  if (!deps.local(projectId)) throw new Error(PROJECT_GONE)
}

const labelOf = (active: ActiveCommand | null): string | null =>
  active === null ? null : fit(active.label, FIELD_BYTES)

const stateOf = (
  run: RunProcess
): {
  readonly run: RunProcess['kind']
  readonly label: string | null
  readonly exitCode: number | null
  readonly failure: string | null
} => {
  switch (run.kind) {
    case 'idle':
      return { run: run.kind, label: null, exitCode: null, failure: null }
    case 'starting':
    case 'running':
    case 'stopping':
      return { run: run.kind, label: labelOf(run.active), exitCode: null, failure: null }
    case 'exited':
      return { run: run.kind, label: labelOf(run.active), exitCode: run.code, failure: null }
    case 'failed':
      return { run: run.kind, label: labelOf(run.active), exitCode: null, failure: run.reason }
  }
}

const readTerminal = (deps: ProjectReadDeps, projectId: string, asked: number): string => {
  ensure(deps, projectId)
  const lines = within(asked, PROJECT_TERMINAL_LINES)
  const snapshot = deps.runner.snapshot(projectId)
  const header = (shown: number, cut: boolean): string =>
    JSON.stringify({
      ...stateOf(snapshot.process),
      cleanupPending: snapshot.cleanupPending,
      lines: shown,
      cut,
    })
  const room = TERMINAL_BYTES - Buffer.byteLength(header(lines, false), 'utf8') - 1
  const raw = deps.terminals.readText(runRef(projectId), lines, room + 4) ?? ''
  const bytes = Buffer.from(raw, 'utf8')
  let text = raw
  let cut = false
  if (bytes.length > room) {
    let start = bytes.length - room
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
    text = bytes.subarray(start).toString('utf8')
    cut = true
  }
  const shown = text === '' ? 0 : text.split('\n').length
  return `${header(shown, cut)}\n${text}`
}

const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

const outcomeOf = (row: TrafficHttpRow): TrafficRead['outcome'] => {
  if (row.aborted) return 'aborted'
  if (row.transport !== null) return 'failed'
  return row.status === null ? 'pending' : 'answered'
}

const optional = (value: string | null): string | null =>
  value === null ? null : fit(value, FIELD_BYTES)

const rowOf = (row: TrafficHttpRow): TrafficRead => {
  const path = clip(pathOf(row.u), URL_BYTES)
  return {
    requestId: row.requestId === '' ? null : fit(row.requestId, FIELD_BYTES),
    method: fit(row.m, FIELD_BYTES),
    path: path.text,
    ...(path.cut ? { pathCut: true as const } : {}),
    status: row.status,
    outcome: outcomeOf(row),
    code: optional(row.code),
    nextAction: optional(row.nextAction),
    transport: optional(row.transport),
  }
}

const readTraffic = (
  deps: ProjectReadDeps,
  projectId: string,
  askedCount: number,
  askedSkip: number
): string => {
  ensure(deps, projectId)
  const count = within(askedCount, PROJECT_TRAFFIC_COUNT)
  const skip = within(askedSkip, PROJECT_TRAFFIC_SKIP)
  const journal = deps.traffic.journal(projectId)
  const http = (journal?.rows ?? []).filter((row): row is TrafficHttpRow => row.source === 'http')
  const newest = [...http].reverse().slice(skip, skip + count)
  const rows: TrafficRead[] = []
  const doc = {
    captureId: journal?.captureId ?? null,
    recording: deps.traffic.state(projectId)?.capturing ?? false,
    total: http.length,
    skip,
    rows,
    cut: false,
  }
  let room = TRAFFIC_BYTES - jsonBytes(doc)
  for (const row of newest) {
    const entry = rowOf(row)
    const cost = jsonBytes(entry) + (rows.length === 0 ? 0 : 1)
    if (cost > room) return JSON.stringify({ ...doc, cut: true })
    rows.push(entry)
    room -= cost
  }
  return JSON.stringify(doc)
}

const bodyStateOf = (descriptor: TrafficBodyDescriptor): BodyState => {
  if (descriptor.truncation !== null) return 'truncated'
  switch (descriptor.state) {
    case 'pending':
    case 'streaming':
      return 'pending'
    case 'complete':
    case 'aborted':
    case 'unavailable':
    case 'evicted':
      return descriptor.state
  }
}

const readBody = (
  page: TrafficReadResult,
  descriptor: TrafficBodyDescriptor
): { readonly body: BodyRead; readonly cut: boolean } => {
  const type = descriptor.contentType === null ? null : clip(descriptor.contentType, FIELD_BYTES)
  const encoding =
    descriptor.contentEncoding === null ? null : clip(descriptor.contentEncoding, FIELD_BYTES)
  const labelsCut = type?.cut === true || encoding?.cut === true
  const held = bodyStateOf(descriptor)
  const base = {
    reason: descriptor.truncation,
    contentType: type?.text ?? null,
    contentEncoding: encoding?.text ?? null,
    decoding: descriptor.decoding,
    observedBytes: descriptor.observedBytes,
    capturedBytes: descriptor.capturedBytes,
  }
  if (page.kind !== 'page') {
    const state = page.kind === 'unsupported' && held === 'pending' ? held : page.kind
    return { body: { ...base, state, binary: false, text: null }, cut: labelsCut }
  }
  const bytes = Buffer.from(page.dataBase64, 'base64')
  const whole = bytes.length <= BODY_BYTES && held === 'complete'
  const end = whole ? bytes.length : boundary(bytes, Math.min(bytes.length, BODY_BYTES))
  const text = textOf(bytes.subarray(0, end))
  return {
    body: { ...base, state: held, binary: text === null, text },
    cut: labelsCut || end < bytes.length,
  }
}

const composeRequest = (
  detail: TrafficDetail,
  pages: { readonly request: TrafficReadResult; readonly response: TrafficReadResult }
): string => {
  const cut = new Set<CutField>()
  const scalar = (field: CutField, value: string, room: number): string => {
    const kept = clip(value, room)
    if (kept.cut) cut.add(field)
    return kept.text
  }
  const request = readBody(pages.request, detail.requestBody)
  if (request.cut) cut.add('requestBody')
  const response = readBody(pages.response, detail.responseBody)
  if (response.cut) cut.add('responseBody')

  const requestHeaders: HeaderList = { total: detail.requestHeaders.length, shown: [] }
  const responseHeaders: HeaderList = { total: detail.responseHeaders.length, shown: [] }
  const trailers: HeaderList = { total: detail.trailers.length, shown: [] }
  const requestBody: BodyRead = { ...request.body, text: null }
  const responseBody: BodyRead = { ...response.body, text: null }
  const worst: CutField[] = [...CUT_FIELDS]
  const doc = {
    state: 'found',
    captureId: detail.key.captureId,
    requestId: detail.key.requestId,
    method: scalar('method', detail.method, FIELD_BYTES),
    url: scalar('url', detail.url, URL_BYTES),
    forwardedUrl: scalar('forwardedUrl', detail.forwardedUrl, URL_BYTES),
    status: detail.status,
    transport:
      detail.transport === null ? null : scalar('transport', detail.transport, FIELD_BYTES),
    timing: detail.timing,
    requestHeaders,
    responseHeaders,
    trailers,
    requestBody,
    responseBody,
    cut: worst,
  }
  let room = REQUEST_BYTES - jsonBytes(doc)

  const fillText = (target: BodyRead, text: string | null, field: CutField): void => {
    if (text === null) return
    const literalRoom = room + NULL_BYTES
    const kept = literalRoom < 2 ? null : fit(text, literalRoom)
    if (kept === null || kept.length < text.length) cut.add(field)
    if (kept === null) return
    target.text = kept
    room -= jsonBytes(kept) - NULL_BYTES
  }

  const fillHeaders = (
    headers: readonly (readonly [string, string])[],
    target: HeaderList,
    field: CutField
  ): void => {
    for (const [index, [name, value]] of maskHeaders(headers, false).entries()) {
      if (index >= HEADERS_PER_LIST) {
        cut.add(field)
        return
      }
      const kept = [fit(name, HEADER_NAME_BYTES), fit(value, HEADER_VALUE_BYTES)] as const
      const cost = jsonBytes(kept) + (target.shown.length === 0 ? 0 : 1)
      if (cost > room) {
        cut.add(field)
        return
      }
      target.shown.push(kept)
      room -= cost
      if (kept[0].length < name.length || kept[1].length < value.length) cut.add(field)
    }
  }

  fillText(responseBody, response.body.text, 'responseBody')
  fillText(requestBody, request.body.text, 'requestBody')
  fillHeaders(detail.responseHeaders, responseHeaders, 'responseHeaders')
  fillHeaders(detail.requestHeaders, requestHeaders, 'requestHeaders')
  fillHeaders(detail.trailers, trailers, 'trailers')
  return JSON.stringify({ ...doc, cut: CUT_FIELDS.filter((field) => cut.has(field)) })
}

const readRequest = async (
  deps: ProjectReadDeps,
  projectId: string,
  captureId: string,
  requestId: string
): Promise<string> => {
  ensure(deps, projectId)
  const missing = (state: 'cleared' | 'evicted' | 'not-found' | 'unsupported'): string =>
    JSON.stringify({
      state,
      captureId: fit(captureId, FIELD_BYTES),
      requestId: fit(requestId, FIELD_BYTES),
    })
  const journal = deps.traffic.journal(projectId)
  if (journal === null) return missing('not-found')
  if (journal.captureId !== captureId) return missing('cleared')
  await deps.traffic.decodedReady(projectId, captureId, requestId, 'request')
  await deps.traffic.decodedReady(projectId, captureId, requestId, 'response')
  ensure(deps, projectId)
  const detail = deps.traffic.detail(projectId, captureId, requestId)
  if (detail === null) {
    const probe = deps.traffic.bodyPage(projectId, captureId, requestId, 'request', 'encoded', 0, 1)
    return missing(probe.kind === 'page' ? 'not-found' : probe.kind)
  }
  const page = (side: 'request' | 'response'): TrafficReadResult =>
    deps.traffic.bodyPage(projectId, captureId, requestId, side, 'decoded', 0, BODY_BYTES + 1)
  return composeRequest(detail, { request: page('request'), response: page('response') })
}

export function projectReader(projectId: string, deps: ProjectReadDeps): ProjectReader {
  return {
    terminal: ({ lines }) => later(() => readTerminal(deps, projectId, lines)),
    traffic: ({ count, skip }) => later(() => readTraffic(deps, projectId, count, skip)),
    request: ({ captureId, requestId }) => readRequest(deps, projectId, captureId, requestId),
  }
}
