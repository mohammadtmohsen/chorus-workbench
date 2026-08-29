import { describe, expect, it } from 'vitest'
import { redactPayload, redactText } from './redact.js'

describe('redactText', () => {
  it.each([
    ['anthropic-key', 'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv now'],
    ['openai-key', 'OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz12'],
    ['github-token', 'token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234'],
    ['slack-token', 'xoxb-123456789012-abcdefghijkl'],
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27u'],
  ])('removes a %s', (rule, input) => {
    const result = redactText(input)
    expect(result.text).toContain(`[redacted:${rule}]`)
    expect(result.redacted).toContain(rule)
  })

  it('removes a private key block whole', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nmore\n-----END RSA PRIVATE KEY-----'
    const result = redactText(`before\n${key}\nafter`)
    expect(result.text).toBe('before\n[redacted:private-key]\nafter')
  })

  it('keeps the name of a secret assignment but not its value', () => {
    // The name is what makes the log readable; the value is what must not survive.
    const result = redactText('export GITHUB_TOKEN="ghp_secretvaluegoeshere123456"')
    expect(result.text).toContain('GITHUB_TOKEN=')
    expect(result.text).not.toContain('secretvaluegoeshere')
  })

  it('keeps the Bearer prefix so the line still reads as auth', () => {
    const result = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123')
    expect(result.text).toMatch(/Bearer \[redacted:bearer-token\]/)
  })

  it('redacts every occurrence, not just the first', () => {
    const result = redactText('ghp_AAAAAAAAAAAAAAAAAAAA and ghp_BBBBBBBBBBBBBBBBBBBB')
    expect(result.text).not.toMatch(/ghp_/)
  })

  it('is stable across repeated calls', () => {
    // A global regex carries lastIndex; without resetting it, alternating calls
    // silently skip matches.
    const input = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234'
    expect(redactText(input).text).toBe(redactText(input).text)
  })
})

describe('what redaction leaves alone', () => {
  it.each([
    'the password is wrong',
    'git commit -m "fix the token parser"',
    'const apiKey = config.apiKey',
    'https://example.com/path?ref=main',
    'sk-short',
    'PASSWORD: ok',
  ])('does not touch %s', (input) => {
    // A false positive silently destroys content the user needed, so ambiguous
    // shapes are left alone.
    expect(redactText(input).text).toBe(input)
  })

  it('leaves ordinary prose untouched', () => {
    const prose = 'I read the README and it describes a tiny fixture repository.'
    expect(redactText(prose)).toEqual({ text: prose, redacted: [] })
  })

  it('returns empty text unchanged', () => {
    expect(redactText('')).toEqual({ text: '', redacted: [] })
  })
})

describe('redactPayload', () => {
  it('redacts the text field of a delta', () => {
    const { payload, redacted } = redactPayload({
      type: 'agent.message.delta',
      itemRef: 'm1',
      text: 'here it is: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234',
    })
    expect(payload.text).toContain('[redacted:github-token]')
    expect(redacted).toEqual(['github-token'])
  })

  it('redacts command output', () => {
    const { payload } = redactPayload({
      type: 'command.output',
      chunk: 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnop',
    })
    expect(payload.chunk).not.toContain('abcdefghijklmnop')
  })

  it('reaches into nested structures like file patches', () => {
    // Structural rather than field-by-field, so a payload shape added later is
    // covered rather than silently exempt.
    const { payload } = redactPayload({
      type: 'file.change.proposed',
      files: [{ path: '.env', patch: '+API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQr' }],
    })
    expect(payload.files[0]?.patch).toContain('[redacted:')
  })

  it('leaves non-text fields alone', () => {
    const { payload } = redactPayload({ type: 'usage.updated', inputTokens: 10, costUsd: 0.5 })
    expect(payload).toMatchObject({ inputTokens: 10, costUsd: 0.5 })
  })

  it('does not redact a path that merely looks secret', () => {
    const { payload } = redactPayload({ type: 'command.started', command: ['cat', '.env'] })
    expect(payload.command).toEqual(['cat', '.env'])
  })
})

/**
 * A password inside a connection URL.
 *
 * Found by testing this module against a real `.env.local` a user had open in
 * the editor: `SESSION_SECRET=` was caught and `postgres://user:password@host`
 * was not caught by anything at all. Nor was `mongodb+srv://`, `redis://`, or an
 * HTTPS remote with a token in it — every one went into the log intact, and this
 * module is the one thing standing between hook output, notices and diffs and a
 * credential written down forever.
 */
describe('url passwords', () => {
  const cases: [string, boolean][] = [
    ['postgres://user:s3cr3tpw@db.example.com:5432/app', true],
    ['DATABASE_URL=postgres://user:s3cr3tpw@localhost:5432/flowdrive', true],
    ['mongodb+srv://admin:hunter2@cluster0.mongodb.net/prod', true],
    ['redis://:mypassword@127.0.0.1:6379', true],
    ['https://user:token@github.com/org/repo.git', true],
    // No password: the userinfo is just a username, and the line stays readable.
    ['postgres://mohamadtaleb@localhost:5432/flowdrive', false],
    ['http://localhost:3000', false],
    // A colon in a path is not a credential — the `@` is what makes it userinfo.
    ['see http://example.com/a:b for details', false],
  ]

  for (const [text, shouldRedact] of cases) {
    it(`${shouldRedact ? 'redacts' : 'leaves'} ${text.slice(0, 44)}`, () => {
      const out = redactText(text).text
      expect(out !== text).toBe(shouldRedact)
    })
  }

  it('keeps the scheme, user and host so the line still says what it is', () => {
    const out = redactText('postgres://user:s3cr3tpw@db.example.com:5432/app').text
    expect(out).toContain('postgres://user:')
    expect(out).toContain('@db.example.com:5432/app')
    expect(out).not.toContain('s3cr3tpw')
  })
})
