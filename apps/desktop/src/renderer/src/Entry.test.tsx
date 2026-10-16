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
