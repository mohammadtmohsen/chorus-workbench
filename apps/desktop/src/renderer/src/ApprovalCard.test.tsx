/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './Session.js'
import type { PendingApproval } from './transcript.js'

/**
 * Which button an approval arms, and which keys it refuses.
 *
 * Mounted rather than reduced, because the behaviour *is* the lifecycle: focus
 * is taken in an effect when the card appears, and the guard exists precisely
 * because that focus was not asked for. There is no pure part to extract.
 *
 * `@vitest-environment jsdom` at the top, because `node` is this project's
 * default and a DOM is an exception that has to be asked for.
 *
 * i18n is stubbed to the key, so what is asserted is *which* string a button
 * carries rather than the wording of it — the wording lives in `en.json` and is
 * allowed to change without breaking this.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const approval = (kind: string): PendingApproval => ({
  approvalId: `a-${kind}`,
  agentId: 'claude',
  kind,
  summary: 'WebFetch',
  detail: 'https://letsencrypt.org/docs/rate-limits/',
  expiresAt: 0,
})

function draw(kind: string): { buttons: HTMLButtonElement[]; hint: string } {
  const { container } = render(
    <ApprovalCard
      approval={approval(kind)}
      waiting={0}
      active
      onAllow={() => undefined}
      onAllowAlways={() => undefined}
      onDeny={() => undefined}
    />
  )
  return {
    buttons: [...container.querySelectorAll<HTMLButtonElement>('.approval-actions button')],
    hint: container.querySelector('.approval-hint')?.textContent ?? '',
  }
}

afterEach(() => {
  cleanup()
})

describe('an approval card', () => {
  /*
   * Allow once is the default, for every kind.
   *
   * This has now been both ways. It was Allow once, then the session grant on
   * the argument that answering the same ask four times is what makes a queue
   * people stop reading — and back again on 2026-09-04, after driving it: the
   * key already under a finger should do the narrow thing. A mistaken Enter on
   * Allow once costs one action you had not read; on the wider button it costs
   * every action for the rest of the session, invisibly.
   */
  it('arms the narrow grant, whatever the kind', () => {
    for (const kind of ['command', 'mcpToolCall', 'fileChange']) {
      const { buttons, hint } = draw(kind)
      const armed = buttons.find((b) => b === document.activeElement)
      expect(armed?.textContent).toBe(kind === 'fileChange' ? 'ask.yes' : 'approval.allowOnce')
      expect(armed?.className).toContain('btn--go')
      expect(hint).toBe('approval.enterHint')
    }
  })

  /*
   * A file edit has no wider button at all, and that is the feature rather than
   * a simplification of it: "allow all edits this session" stops the asking,
   * which is the opposite of what the diff-and-accept flow is for.
   */
  it('offers no session grant on a file edit, and still offers one elsewhere', () => {
    expect(draw('fileChange').buttons.map((b) => b.textContent)).toEqual(['ask.yes', 'ask.no'])
    expect(draw('command').buttons.map((b) => b.textContent)).toContain('approval.allowAlways')
    expect(draw('mcpToolCall').buttons.map((b) => b.textContent)).toContain(
      'approval.allowRemembered'
    )
  })

  /*
   * The guards sit on whichever button is armed, which is now always the narrow
   * one.
   *
   * Space, because a card can land mid-sentence and the next space of ordinary
   * prose would answer it. Held Enter, because auto-repeat would walk the whole
   * queue on one press.
   */
  it('refuses Space and a held Enter on whichever button is armed', () => {
    for (const kind of ['command', 'mcpToolCall']) {
      const { buttons } = draw(kind)
      const armed = buttons.find((b) => b === document.activeElement)
      expect(armed).toBeDefined()
      expect(fireEvent.keyDown(armed!, { key: ' ' })).toBe(false)
      expect(fireEvent.keyDown(armed!, { key: 'Enter', repeat: true })).toBe(false)
      // A deliberate press is untouched.
      expect(fireEvent.keyDown(armed!, { key: 'Enter' })).toBe(true)
      cleanup()
    }
  })

  /* A background pane's card must not steal the caret from the pane in front. */
  it('takes no focus when its pane is not active', () => {
    const { container } = render(
      <ApprovalCard
        approval={approval('command')}
        waiting={0}
        active={false}
        onAllow={() => undefined}
        onAllowAlways={() => undefined}
        onDeny={() => undefined}
      />
    )
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.approval-actions button')]
    expect(buttons.some((b) => b === document.activeElement)).toBe(false)
  })

  /*
   * The armed button is the narrow one, so pressing it grants once.
   *
   * Worth asserting rather than assuming: the ref, the styling and the handler
   * are three separate props, and an earlier version of this change moved the
   * first two and left the third — which looks right and grants the wrong thing.
   */
  it('grants once when the armed button is pressed', () => {
    const calls: string[] = []
    const { container } = render(
      <ApprovalCard
        approval={approval('command')}
        waiting={0}
        active
        onAllow={() => calls.push('once')}
        onAllowAlways={() => calls.push('session')}
        onDeny={() => calls.push('deny')}
      />
    )
    const armed = [
      ...container.querySelectorAll<HTMLButtonElement>('.approval-actions button'),
    ].find((b) => b === document.activeElement)
    act(() => {
      armed?.click()
    })
    expect(calls).toEqual(['once'])
  })
})
