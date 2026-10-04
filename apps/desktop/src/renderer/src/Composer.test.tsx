/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

class FakeObserver {
  observe(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }
}

const sendMessage = vi.fn((_request: { conversationId: string; text: string }) =>
  Promise.resolve({ targets: [] })
)
const setAnswerStyle = vi.fn((_request: { conversationId: string; on?: boolean }) =>
  Promise.resolve({ styleOn: false })
)

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  sendMessage.mockClear()
  setAnswerStyle.mockClear()
  Object.assign(window, {
    chorus: {
      sendMessage,
      setAnswerStyle,
      listCommands: () => Promise.resolve({ commands: [] }),
      rememberDraft: () => Promise.resolve({ ok: true }),
      ideSnapshot: () => Promise.resolve({ outcome: 'unavailable' }),
      interrupt: () => Promise.resolve({ ok: true }),
    },
  })
})

afterEach(() => {
  cleanup()
})

type Props = ComponentProps<typeof Composer>

const props = (starting: boolean): Props => ({
  conversationId: 'c1',
  participants: ['claude', 'codex'],
  starting,
  busy: false,
  working: [],
  backgroundAgents: '',
  ide: null,
  onRestart: () => undefined,
  onContinue: () => undefined,
  history: [],
  report: { current: { draft: '', attached: [] } },
  onError: () => undefined,
  onSending: () => undefined,
  onSendFailed: () => undefined,
  initial: {
    attached: [{ path: '/tmp/shot.png', name: 'shot.png', bytes: 3, dataUrl: null }],
  },
})

const parts = (container: HTMLElement) => {
  const box = container.querySelector('textarea')
  const send = container.querySelector<HTMLButtonElement>('button.send')
  const style = container.querySelector<HTMLButtonElement>('button.composer-style')
  if (box === null || send === null || style === null) throw new Error('composer did not render')
  return { box, send, style }
}

describe('a composer whose agents are still starting', () => {
  it('takes a draft and attachments but sends nothing, by Enter or by button', async () => {
    const { container, getByText } = render(<Composer {...props(true)} />)
    const { box, send, style } = parts(container)

    fireEvent.change(box, { target: { value: 'first question' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.submit(box.closest('form') ?? box)
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(box.value).toBe('first question')
    expect(send.disabled).toBe(true)
    expect(style.disabled).toBe(true)
    expect(getByText('conversation.agentsStarting')).toBeTruthy()
    expect(container.textContent).toContain('shot.png')
  })

  it('keeps the draft, attachments and caret on the same mount once ready, then sends', async () => {
    const view = render(<Composer {...props(true)} />)
    const { box } = parts(view.container)
    fireEvent.change(box, { target: { value: 'first question' } })
    box.focus()
    box.setSelectionRange(6, 14)

    view.rerender(<Composer {...props(false)} />)
    const after = parts(view.container)

    expect(after.box).toBe(box)
    expect(after.box.value).toBe('first question')
    expect(document.activeElement).toBe(box)
    expect(after.box.selectionStart).toBe(6)
    expect(after.box.selectionEnd).toBe(14)
    expect(after.send.disabled).toBe(false)
    expect(view.queryByText('conversation.agentsStarting')).toBeNull()
    expect(view.container.textContent).toContain('shot.png')

    fireEvent.keyDown(after.box, { key: 'Enter' })
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('first question')
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('/tmp/shot.png')
  })
})
