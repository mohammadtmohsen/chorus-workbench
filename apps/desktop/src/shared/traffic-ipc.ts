import { z } from 'zod'
import { TrafficRowShape, TrafficSourceShape } from './ipc.js'

export const TrafficAccesses = z.enum(['loopback', 'lan'])
export type TrafficAccess = z.infer<typeof TrafficAccesses>

export const TrafficProject = z.object({ projectId: z.string().min(1) }).strict()
export type TrafficProject = z.infer<typeof TrafficProject>

export const TrafficSubscription = TrafficProject.extend({
  subscriptionId: z.string().min(1),
}).strict()

export const TrafficStream = TrafficSubscription.extend({
  seq: z.number().int().nonnegative(),
}).strict()

export const TrafficFailure = z.enum([
  'in-use',
  'failed',
  'source-busy',
  'unknown-project',
  'capturing',
  'no-port',
  'no-origin',
  'ownership-unknown',
  'unresolved',
  'invalid-host',
])
export type TrafficFailure = z.infer<typeof TrafficFailure>

export const TrafficLegacy = z.object({
  completed: z.boolean(),
  assignedProjectId: z.string().nullable(),
  origin: z.string().nullable(),
  port: z.number().int().nullable(),
  access: TrafficAccesses.nullable(),
  error: z.string().nullable(),
})
export type TrafficLegacy = z.infer<typeof TrafficLegacy>

export const TRAFFIC_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const TRAFFIC_IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/

export const isTrafficHost = (value: string): boolean =>
  TRAFFIC_IPV4.test(value) && value !== '0.0.0.0'

export const TrafficConfig = z
  .object({
    origin: z.string().nullable().optional(),
    port: z.number().int().min(0).max(65_535).nullable().optional(),
    access: TrafficAccesses.optional(),
    host: z.string().refine(isTrafficHost).nullable().optional(),
    envVar: z.string().max(64).regex(TRAFFIC_ENV_NAME).nullable().optional(),
  })
  .strict()

export const TrafficState = z.object({
  capturing: z.boolean(),
  port: z.number().int().nullable(),
  wantedPort: z.number().int().nullable(),
  address: z.string().nullable(),
  host: z.string().nullable().optional(),
  hostOverridden: z.boolean().optional(),
  origin: z.string().nullable(),
  access: TrafficAccesses,
  envVar: z.string().nullable(),
  source: TrafficSourceShape,
  failure: TrafficFailure.nullable(),
  forwardedDevices: z.number().int().nonnegative(),
})
export type TrafficState = z.infer<typeof TrafficState>

export const TrafficLive = z.object({ projectIds: z.array(z.string().min(1)) })
export type TrafficLive = z.infer<typeof TrafficLive>

export const BODY_PAGE = 65_536

export const TrafficRequestKey = z
  .object({
    projectId: z.string().min(1),
    captureId: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict()
export type TrafficRequestKey = z.infer<typeof TrafficRequestKey>

export const TrafficHeader = z.tuple([z.string(), z.string()])
export type TrafficHeader = z.infer<typeof TrafficHeader>

export const TrafficBodyState = z.enum([
  'pending',
  'streaming',
  'complete',
  'aborted',
  'unavailable',
  'evicted',
])

export const TrafficTruncation = z.enum(['body-limit', 'project-budget', 'global-budget'])

export const TrafficDecoding = z.enum(['not-requested', 'ready', 'unsupported', 'invalid', 'limit'])

export const TrafficBodyDescriptor = z.object({
  state: TrafficBodyState,
  truncation: TrafficTruncation.nullable(),
  observedBytes: z.number().int().nonnegative(),
  capturedBytes: z.number().int().nonnegative(),
  contentType: z.string().nullable(),
  contentEncoding: z.string().nullable(),
  decoding: TrafficDecoding,
})
export type TrafficBodyDescriptor = z.infer<typeof TrafficBodyDescriptor>

export const TrafficTiming = z.object({
  startedAt: z.number().int().nonnegative(),
  upstreamAt: z.number().int().nonnegative().nullable(),
  upstreamDoneAt: z.number().int().nonnegative().nullable(),
  settledAt: z.number().int().nonnegative().nullable(),
})

export const TrafficDetail = z.object({
  key: TrafficRequestKey,
  method: z.string(),
  url: z.string(),
  forwardedUrl: z.string(),
  requestHeaders: z.array(TrafficHeader),
  forwardedHeaders: z.array(TrafficHeader),
  responseHeaders: z.array(TrafficHeader),
  trailers: z.array(TrafficHeader),
  status: z.number().int().nullable(),
  /** How the transport failed, when it did. See `TrafficHttpRowShape`. */
  transport: z.string().nullable(),
  timing: TrafficTiming,
  requestBody: TrafficBodyDescriptor,
  responseBody: TrafficBodyDescriptor,
})
export type TrafficDetail = z.infer<typeof TrafficDetail>

export const TrafficDetailRequest = TrafficRequestKey.extend({
  subscriptionId: z.string().min(1),
}).strict()
export type TrafficDetailRequest = z.infer<typeof TrafficDetailRequest>

export const TrafficBodyReadRequest = TrafficDetailRequest.extend({
  side: z.enum(['request', 'response']),
  representation: z.enum(['encoded', 'decoded']),
  offset: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(BODY_PAGE),
}).strict()
export type TrafficBodyReadRequest = z.infer<typeof TrafficBodyReadRequest>

export const TrafficGone = z.enum(['evicted', 'cleared', 'not-found', 'unsupported'])
export type TrafficGone = z.infer<typeof TrafficGone>

export const TrafficDetailResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('detail'), detail: TrafficDetail }),
  z.object({ kind: TrafficGone, key: TrafficRequestKey }),
])
export type TrafficDetailResult = z.infer<typeof TrafficDetailResult>

export const TrafficReadResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    key: TrafficRequestKey,
    offset: z.number().int().nonnegative(),
    dataBase64: z.string(),
    body: TrafficBodyDescriptor,
  }),
  z.object({ kind: TrafficGone, key: TrafficRequestKey }),
])
export type TrafficReadResult = z.infer<typeof TrafficReadResult>

export const TRAFFIC_CONTRACT = {
  'traffic:attach': {
    request: TrafficProject,
    response: z.object({
      subscriptionId: z.string().min(1),
      captureId: z.string().min(1),
      rows: z.array(TrafficRowShape),
      seq: z.number().int().nonnegative(),
      state: TrafficState,
    }),
  },
  'traffic:detach': {
    request: TrafficSubscription,
    response: z.object({ ok: z.literal(true) }),
  },
  'traffic:ack': {
    request: TrafficStream,
    response: z.object({ ok: z.literal(true) }),
  },
  'traffic:snapshot': {
    request: TrafficStream,
    response: z.object({
      captureId: z.string().min(1),
      rows: z.array(TrafficRowShape),
      seq: z.number().int().nonnegative(),
      complete: z.boolean(),
    }),
  },
  'traffic:start': {
    request: TrafficProject,
    response: z.object({
      state: TrafficState,
    }),
  },
  'traffic:stop': {
    request: TrafficProject,
    response: z.object({ state: TrafficState }),
  },
  'traffic:clear': {
    request: TrafficProject,
    response: z.object({ captureId: z.string().min(1), seq: z.number().int().nonnegative() }),
  },
  'traffic:configure': {
    request: TrafficProject.extend({ config: TrafficConfig }).strict(),
    response: z.object({ state: TrafficState, failure: TrafficFailure.nullable() }),
  },
  'traffic:selectSource': {
    request: TrafficProject.extend({ source: TrafficSourceShape }).strict(),
    response: z.object({ state: TrafficState }),
  },
  'traffic:detail': {
    request: TrafficDetailRequest,
    response: TrafficDetailResult,
  },
  'traffic:readBody': {
    request: TrafficBodyReadRequest,
    response: TrafficReadResult,
  },
  'traffic:legacy': {
    request: z.object({}).strict(),
    response: TrafficLegacy,
  },
  'traffic:legacyDecide': {
    request: z.object({ keep: z.boolean() }).strict(),
    response: z.object({ ok: z.literal(true), legacy: TrafficLegacy }),
  },
  'traffic:live': {
    request: z.object({}).strict(),
    response: TrafficLive,
  },
} as const

export type TrafficContract = typeof TRAFFIC_CONTRACT
export type TrafficChannel = keyof TrafficContract
export type TrafficRequest<C extends TrafficChannel> = z.infer<TrafficContract[C]['request']>
export type TrafficResponse<C extends TrafficChannel> = z.infer<TrafficContract[C]['response']>

export const TRAFFIC_CHANNELS = Object.keys(TRAFFIC_CONTRACT) as TrafficChannel[]

export const TRAFFIC_PUSH_CHANNEL = 'traffic:push'

export const TRAFFIC_LIVE_PUSH_CHANNEL = 'traffic:livePush'

export const TrafficPush = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rows'),
    projectId: z.string().min(1),
    subscriptionId: z.string().min(1),
    captureId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    rows: z.array(TrafficRowShape),
  }),
  z.object({
    kind: z.literal('state'),
    projectId: z.string().min(1),
    subscriptionId: z.string().min(1),
    state: TrafficState,
  }),
  z.object({
    kind: z.literal('reset'),
    projectId: z.string().min(1),
    subscriptionId: z.string().min(1),
    captureId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    reason: z.enum(['cleared', 'restarted']),
  }),
  z.object({
    kind: z.literal('resync'),
    projectId: z.string().min(1),
    subscriptionId: z.string().min(1),
  }),
])
export type TrafficPush = z.infer<typeof TrafficPush>

export interface TrafficApi {
  readonly attachTraffic: (
    request: TrafficRequest<'traffic:attach'>
  ) => Promise<TrafficResponse<'traffic:attach'>>
  readonly detachTraffic: (
    request: TrafficRequest<'traffic:detach'>
  ) => Promise<TrafficResponse<'traffic:detach'>>
  readonly ackTraffic: (
    request: TrafficRequest<'traffic:ack'>
  ) => Promise<TrafficResponse<'traffic:ack'>>
  readonly snapshotTraffic: (
    request: TrafficRequest<'traffic:snapshot'>
  ) => Promise<TrafficResponse<'traffic:snapshot'>>
  readonly startTraffic: (
    request: TrafficRequest<'traffic:start'>
  ) => Promise<TrafficResponse<'traffic:start'>>
  readonly stopTraffic: (
    request: TrafficRequest<'traffic:stop'>
  ) => Promise<TrafficResponse<'traffic:stop'>>
  readonly clearTraffic: (
    request: TrafficRequest<'traffic:clear'>
  ) => Promise<TrafficResponse<'traffic:clear'>>
  readonly configureTraffic: (
    request: TrafficRequest<'traffic:configure'>
  ) => Promise<TrafficResponse<'traffic:configure'>>
  readonly selectTrafficSource: (
    request: TrafficRequest<'traffic:selectSource'>
  ) => Promise<TrafficResponse<'traffic:selectSource'>>
  readonly readTrafficDetail: (
    request: TrafficRequest<'traffic:detail'>
  ) => Promise<TrafficResponse<'traffic:detail'>>
  readonly readTrafficBody: (
    request: TrafficRequest<'traffic:readBody'>
  ) => Promise<TrafficResponse<'traffic:readBody'>>
  readonly readTrafficLegacy: (
    request: TrafficRequest<'traffic:legacy'>
  ) => Promise<TrafficResponse<'traffic:legacy'>>
  readonly decideTrafficLegacy: (
    request: TrafficRequest<'traffic:legacyDecide'>
  ) => Promise<TrafficResponse<'traffic:legacyDecide'>>
  readonly readTrafficLive: (
    request: TrafficRequest<'traffic:live'>
  ) => Promise<TrafficResponse<'traffic:live'>>
  readonly onTraffic: (listener: (push: TrafficPush) => void) => () => void
  readonly onTrafficLive: (listener: (live: TrafficLive) => void) => () => void
}
