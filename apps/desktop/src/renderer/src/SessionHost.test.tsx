/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionCarry, SessionInfo } from './Session.js'
import { SessionHost, type SessionHostProps } from './SessionHost.js'
import { EMPTY_VIEW } from './transcript.js'

type SessionProps = ComponentProps<typeof Session>

const { renders, focusPane } = vi.hoisted(() => ({
  renders: [] as SessionProps[],
  focusPane: vi.fn(),
}))

vi.mock('./Session.js', () => ({
  Session: (props: SessionProps) => {
    renders.push(props)
    return null
  },
}))

vi.mock('./workspace/store.js', () => ({
  useWorkspaceStore: { getState: () => ({ focusPane }) },
}))

const session: SessionInfo = {
  conversationId: 'c1',
  participants: ['claude'],
  projectId: 'p1',
  cwd: '/tmp/one',
  profileId: 'default',
  title: 'One',
}

const base = (): SessionHostProps => ({
  session,
  active: false,
  paneId: 'pane-1',
  startIn: vi.fn(),
  carry: undefined,
  onCarry: vi.fn(),
  onDraftReader: vi.fn(),
  onPromoteAside: vi.fn(),
  explainLanguage: '',
})

const latest = (): SessionProps => {
  const props = renders.at(-1)
  expect(props).toBeDefined()
  return props!
}

beforeEach(() => {
  renders.length = 0
  focusPane.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('SessionHost', () => {
  it('does not render an unchanged chat again when its parent renders', () => {
    const props = base()
    const { rerender } = render(<SessionHost {...props} />)
    rerender(<SessionHost {...props} />)
    rerender(<SessionHost {...props} />)
    expect(renders).toHaveLength(1)
  })

  it('renders again for a changed session, active state or carry, and passes them through', () => {
    const props = base()
    const { rerender } = render(<SessionHost {...props} />)

    const renamed: SessionInfo = { ...session, title: 'Renamed' }
    rerender(<SessionHost {...props} session={renamed} />)
    expect(renders).toHaveLength(2)
    expect(latest().session).toBe(renamed)

    rerender(<SessionHost {...props} session={renamed} active />)
    expect(renders).toHaveLength(3)
    expect(latest().active).toBe(true)

    const carry: SessionCarry = {
      view: EMPTY_VIEW,
      draft: 'kept',
      attached: [],
      following: true,
      scrollTop: 0,
    }
    rerender(<SessionHost {...props} session={renamed} active carry={carry} />)
    expect(renders).toHaveLength(4)
    expect(latest().carry).toBe(carry)
  })

  it('hands the chat the shell callbacks and settings it was given', () => {
    const props = { ...base(), explainLanguage: 'Arabic' }
    render(<SessionHost {...props} />)
    const received = latest()
    expect(received.onCarry).toBe(props.onCarry)
    expect(received.onDraftReader).toBe(props.onDraftReader)
    expect(received.onPromoteAside).toBe(props.onPromoteAside)
    expect(received.explainLanguage).toBe('Arabic')
    expect(received).not.toHaveProperty('paneId')
    expect(received).not.toHaveProperty('startIn')
  })

  it('activates the current pane, and starts the current chat through the current action', () => {
    const first = vi.fn()
    const second = vi.fn()
    const props = { ...base(), startIn: first }
    const { rerender } = render(<SessionHost {...props} />)

    latest().onActivate()
    expect(focusPane).toHaveBeenLastCalledWith('pane-1')

    rerender(<SessionHost {...props} paneId="pane-2" />)
    latest().onActivate()
    expect(focusPane).toHaveBeenLastCalledWith('pane-2')

    rerender(<SessionHost {...props} paneId="pane-2" startIn={second} />)
    latest().onRestart()
    expect(second).toHaveBeenLastCalledWith('p1', { replacing: 'c1' })

    const other: SessionInfo = { ...session, conversationId: 'c2', projectId: 'p2' }
    rerender(<SessionHost {...props} paneId="pane-2" startIn={second} session={other} />)
    latest().onRestart()
    expect(second).toHaveBeenLastCalledWith('p2', { replacing: 'c2' })
    latest().onForward({ text: 'Fix the API retries', sourceEventIds: ['e1', 'e2'] })
    expect(second).toHaveBeenLastCalledWith('p2', {
      continueFrom: 'c2',
      objective: 'Fix the API retries',
      sourceEventIds: ['e1', 'e2'],
    })
    expect(first).not.toHaveBeenCalled()
  })

  it('forwards a whole reply with its Summary, anchored to that reply alone', () => {
    const startIn = vi.fn()
    render(<SessionHost {...base()} startIn={startIn} />)
    const reply = 'Did the work.\n\nIt holds.\n\n## Summary\n- one\n- two'
    latest().onForward({ text: reply, sourceEventIds: ['e-reply'] })
    expect(startIn).toHaveBeenLastCalledWith('p1', {
      continueFrom: 'c1',
      objective: reply,
      sourceEventIds: ['e-reply'],
    })
  })

  it('cuts a long selection to the 2,000 units the start accepts without splitting a character', () => {
    const startIn = vi.fn()
    render(<SessionHost {...base()} startIn={startIn} />)
    latest().onForward({ text: `  ${'a'.repeat(1_999)}🚀tail  `, sourceEventIds: [] })
    const objective = (startIn.mock.calls.at(-1)?.[1] as { objective: string }).objective
    expect(objective).toBe('a'.repeat(1_999))
    expect(objective.length).toBeLessThanOrEqual(2_000)
  })
})
