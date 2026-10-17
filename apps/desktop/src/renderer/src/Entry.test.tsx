import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Entry } from './Entry.js'
import type { TranscriptMessage } from './transcript.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { objective?: string }) =>
      key === 'forwardTask.context' ? (values?.objective ?? key) : key,
  }),
}))

const notice = (detail: string): TranscriptMessage => ({
  key: 'forward-context',
  eventId: 'forward-context',
  actor: 'system',
  kind: 'notice',
  text: '',
  status: 'complete',
  at: 1,
  noticeCode: 'contextCarried',
  detail,
})

describe('Forward context notices', () => {
  it('counts the collapsed preview when deciding whether a task is truncated', () => {
    const markup = renderToStaticMarkup(
      <Entry message={notice('Fix' + '\n '.repeat(100) + 'API retries.')} />
    )
    expect(markup).toContain('Fix API retries.')
    expect(markup).not.toContain('…')
    expect(markup).not.toContain('<details')
  })

  it('keeps a long objective behind disclosure and cuts the visible Unicode preview safely', () => {
    const detail = '🌍'.repeat(130)
    const markup = renderToStaticMarkup(<Entry message={notice(detail)} />)
    expect(markup).toContain('🌍'.repeat(120) + '…')
    expect(markup).toContain('<details')
    expect(markup).toContain(detail)
    expect(markup).not.toMatch(/[\uD800-\uDFFF]/u)
  })
})

describe('Forward at the end of a reply', () => {
  const reply = (over: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
    key: 'm1',
    eventId: 'e-reply',
    actor: 'claude',
    kind: 'message',
    text: 'The parser now retries three times.',
    status: 'complete',
    at: 1,
    ...over,
  })
  const forward = (): void => undefined
  const FORWARD = 'data-entry-action="forward"'

  it('is offered on a finished reply even with no Explain', () => {
    const markup = renderToStaticMarkup(<Entry message={reply()} onForward={forward} />)
    expect(markup).toContain(FORWARD)
    expect(markup).toContain('conversation.forwardReply<')
    expect(markup).toContain('title="conversation.forwardReplyHint"')
    expect(markup).toContain('type="button"')
    expect(markup).toContain('entry-actions-end')
  })

  it('is offered on an older reply that is not the final one, and on a summary-only reply', () => {
    const older = <Entry message={reply()} final={false} onForward={forward} />
    expect(renderToStaticMarkup(older)).toContain(FORWARD)
    const summaryOnly = reply({
      text: '',
      summary: ['only this'],
      fullText: '## Summary\n- only this\n',
    })
    expect(renderToStaticMarkup(<Entry message={summaryOnly} onForward={forward} />)).toContain(
      FORWARD
    )
  })

  it('is refused on unfinished, empty, user, system and non-message rows, or with no route', () => {
    const refused: { name: string; message: TranscriptMessage; route?: boolean }[] = [
      { name: 'streaming', message: reply({ status: 'streaming' }) },
      { name: 'empty', message: reply({ text: '  ' }) },
      { name: 'user', message: reply({ actor: 'user' }) },
      { name: 'system', message: reply({ actor: 'system' }) },
      { name: 'reasoning', message: reply({ kind: 'reasoning' }) },
      { name: 'tool', message: reply({ kind: 'tool' }) },
      { name: 'no event id', message: reply({ eventId: '' }) },
      { name: 'no route', message: reply(), route: false },
    ]
    for (const { name, message, route } of refused) {
      const markup = renderToStaticMarkup(
        <Entry message={message} {...(route === false ? {} : { onForward: forward })} />
      )
      expect(markup, name).not.toContain(FORWARD)
    }
  })

  it('sits at the right end, with Explain alone on the left', () => {
    const markup = renderToStaticMarkup(
      <Entry message={reply()} final onExplain={() => undefined} onForward={forward} />
    )
    const explain = markup.indexOf('data-entry-action="explain"')
    const end = markup.indexOf('entry-actions-end')
    const forwardAt = markup.indexOf(FORWARD)
    expect(explain).toBeGreaterThan(-1)
    expect(explain).toBeLessThan(end)
    expect(end).toBeLessThan(forwardAt)
  })
})
