/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrafficState } from '../../shared/traffic-ipc.js'
import { TrafficPanel } from './TrafficPanel.js'

/**
 * A refused change must not be left sitting in the field as though it had been
 * taken.
 *
 * The reported defect: `Forward to` was corrected from `:3008` to `:30081`
 * while a capture was running. `configure` refuses an origin change mid-capture
 * on purpose — the socket is bound and the forward target is read once at
 * `Start` — but `commitOrigin` only synced its field when the change
 * *succeeded*, so the rejected text stayed in the box. The panel displayed one
 * address and the listener went on forwarding to another, and every row was a
 * 502 against a port with nothing on it.
 *
 * Mounted rather than reduced, because the defect is the async settle: a
 * `.then` that wrote the wrong thing into state. There is no pure part that
 * could have failed here — a test of "what should the field show" would have
 * asserted `state.origin`, which is what the fixed code already does.
 *
 * i18n is stubbed to the key, so this asserts *which* string a surface carries
 * rather than the wording of it; the wording lives in `en.json` and is allowed
 * to change without breaking this.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const STORED = 'http://127.0.0.1:3008'
const TYPED = 'http://127.0.0.1:30081'

const state = (over: Partial<TrafficState> = {}): TrafficState => ({
  capturing: true,
  port: 30_100,
  wantedPort: 30_100,
  address: '127.0.0.1:30100',
  origin: STORED,
  access: 'lan',
  envVar: null,
  source: { kind: 'off' },
  failure: null,
  ...over,
})

type Chorus = typeof window.chorus

const bridge = (configure: Chorus['configureTraffic']): Partial<Chorus> => ({
  onTraffic: () => () => undefined,
  attachTraffic: () =>
    Promise.resolve({
      subscriptionId: 'sub-1',
      captureId: 'cap-1',
      rows: [],
      seq: 0,
      state: state(),
    }),
  ackTraffic: () => Promise.resolve({ ok: true as const }),
  detachTraffic: () => Promise.resolve({ ok: true as const }),
  readTrafficLegacy: () =>
    Promise.resolve({
      completed: true,
      assignedProjectId: null,
      origin: null,
      port: null,
      access: null,
      error: null,
    }),
  configureTraffic: configure,
})

const installed: Partial<Chorus> = {}

beforeEach(() => {
  Object.assign(window, { chorus: installed })
})

afterEach(() => {
  cleanup()
})

const draw = async (configure: Chorus['configureTraffic']): Promise<HTMLInputElement> => {
  Object.assign(installed, bridge(configure))
  const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
  /* The attach promise seeds every draft, so nothing is typed before it lands. */
  await act(() => Promise.resolve())
  const field = container.querySelector<HTMLInputElement>('[data-traffic-field="origin"] input')
  if (field === null) throw new Error('the origin field is not drawn')
  return field
}

const hintFor = (field: HTMLElement): HTMLElement => {
  const hint = field.parentElement?.querySelector<HTMLElement>('.traffic-field-hint')
  if (hint === undefined || hint === null) throw new Error('the field has no hint')
  return hint
}

const commit = async (field: HTMLInputElement, text: string): Promise<void> => {
  fireEvent.change(field, { target: { value: text } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await act(() => Promise.resolve())
}

describe('a refused change to Forward to', () => {
  it('puts the stored address back, and says why under the field', async () => {
    const field = await draw(() =>
      /* What `configure` really does when the guard refuses: nothing is stored. */
      Promise.resolve({ state: state(), failure: 'capturing' })
    )

    await commit(field, TYPED)

    /*
     * The assertion the defect fails. Leaving `TYPED` here is the bug: the
     * person reads their own correction back and believes it was taken, while
     * the listener forwards somewhere else entirely.
     */
    expect(field.value).toBe(STORED)

    const hint = hintFor(field)
    expect(hint.dataset['refused']).toBe('true')
    expect(hint.textContent).toBe('traffic.capturingChange')
    /* And not also at the foot of the panel — one fact, one place. */
    expect(document.querySelectorAll('.traffic-stopped')).toHaveLength(0)
  })

  it('takes the new address and goes back to the ordinary hint when it is accepted', async () => {
    const field = await draw(() =>
      Promise.resolve({ state: state({ origin: TYPED }), failure: null })
    )

    await commit(field, TYPED)

    expect(field.value).toBe(TYPED)
    const hint = hintFor(field)
    expect(hint.dataset['refused']).toBe('false')
    expect(hint.textContent).toBe('traffic.originHint')
  })

  /*
   * The other half of the same rule, and the one that was already right before
   * this change: a refusal must not leave the field showing the rejected value.
   * The port is the field the guard also refuses, so it is the one that proves
   * the two handlers now agree rather than one of them carrying the fix.
   */
  it('does the same for the port, refused and accepted', async () => {
    Object.assign(
      installed,
      bridge(() => Promise.resolve({ state: state(), failure: 'capturing' }))
    )
    const { container } = render(<TrafficPanel projectId="p1" terminals={[]} />)
    await act(() => Promise.resolve())
    const port = container.querySelector<HTMLInputElement>('[data-traffic-field="port"] input')
    if (port === null) throw new Error('the port field is not drawn')

    await commit(port, '39999')
    expect(port.value).toBe('30100')
    expect(hintFor(port).dataset['refused']).toBe('true')
  })
})
