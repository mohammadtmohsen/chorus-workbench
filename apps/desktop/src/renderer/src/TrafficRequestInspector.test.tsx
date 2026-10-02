/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrafficRowShape } from '../../shared/ipc.js'
import type { TrafficBodyDescriptor, TrafficDetail } from '../../shared/traffic-ipc.js'
import { TrafficRequestInspector } from './TrafficRequestInspector.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

type HttpRow = Extract<TrafficRowShape, { source: 'http' }>
type Chorus = typeof window.chorus

const REQUEST = '{"username":"Admin"}'
const RESPONSE = '{"token":"abc"}'

const row = (over: Partial<HttpRow> = {}): HttpRow => ({
  source: 'http',
  seq: 1,
  requestId: 'r1',
  m: 'POST',
  u: 'http://127.0.0.1:9000/api/v1/auth/login',
  dpop: false,
  status: 200,
  aborted: false,
  parsed: true,
  code: null,
  nextAction: null,
  transport: null,
  ...over,
})

const PENDING = row({ status: null, parsed: false })

const body = (state: TrafficBodyDescriptor['state'], text: string): TrafficBodyDescriptor => ({
  state,
  truncation: null,
  observedBytes: text.length,
  capturedBytes: text.length,
  contentType: 'application/json',
  contentEncoding: null,
  decoding: 'ready',
})

let answered = false
let detailReads = 0

const detailOf = (key: TrafficDetail['key']): TrafficDetail => ({
  key,
  method: 'POST',
  url: PENDING.u,
  forwardedUrl: PENDING.u,
  requestHeaders: [],
  forwardedHeaders: [],
  responseHeaders: [],
  trailers: [],
  status: answered ? 200 : null,
  transport: null,
  timing: { startedAt: 0, upstreamAt: null, upstreamDoneAt: null, settledAt: null },
  requestBody: body('complete', REQUEST),
  responseBody: answered ? body('complete', RESPONSE) : body('pending', ''),
})

const bridge = (): Partial<Chorus> => ({
  readTrafficDetail: (request) => {
    detailReads += 1
    const key = {
      projectId: request.projectId,
      captureId: request.captureId,
      requestId: request.requestId,
    }
    return Promise.resolve({ kind: 'detail' as const, detail: detailOf(key) })
  },
  readTrafficBody: (request) => {
    const text = request.side === 'request' ? REQUEST : answered ? RESPONSE : ''
    const key = {
      projectId: request.projectId,
      captureId: request.captureId,
      requestId: request.requestId,
    }
    return Promise.resolve({
      kind: 'page' as const,
      key,
      offset: request.offset,
      dataBase64: request.offset === 0 ? btoa(text) : '',
      body: request.side === 'request' ? body('complete', REQUEST) : detailOf(key).responseBody,
    })
  },
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

const inspector = (shown: HttpRow): React.JSX.Element => (
  <TrafficRequestInspector projectId="p1" subscriptionId="s1" captureId="c1" row={shown} />
)

const responseText = (container: HTMLElement): string =>
  container.querySelector('[data-side="response"]')?.textContent ?? ''

beforeEach(() => {
  answered = false
  detailReads = 0
  Object.assign(window, { chorus: bridge() })
})

afterEach(() => {
  cleanup()
})

describe('a request selected before it answered', () => {
  it('shows the response once the request settles, without being selected again', async () => {
    const { container, rerender } = render(inspector(PENDING))
    await flush()
    expect(responseText(container)).not.toContain('token')

    answered = true
    rerender(inspector(row()))
    await flush()

    expect(responseText(container)).toContain('token')
  })

  it('reads again once per settle, not once per push of the same row', async () => {
    const { rerender } = render(inspector(PENDING))
    await flush()
    answered = true
    rerender(inspector(row()))
    await flush()
    rerender(inspector(row({ code: 'OK' })))
    await flush()

    expect(detailReads).toBe(2)
  })

  it('keeps waiting while the exchange on screen is still the in-flight one', async () => {
    const { container } = render(inspector(row()))
    await flush()

    expect(responseText(container)).toContain('traffic.waitingForResponse')
  })

  it('says it is waiting while the request is pending', async () => {
    const { container } = render(inspector(PENDING))
    await flush()

    expect(responseText(container)).toContain('traffic.waitingForResponse')
    expect(container.querySelector('.traffic-head .traffic-pending')).not.toBeNull()
  })
})
