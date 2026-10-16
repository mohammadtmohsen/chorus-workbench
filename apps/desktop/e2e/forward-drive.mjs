import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

const SOURCE = join(homedir(), 'Library/Application Support/@chorus/desktop-dev')
const TITLE = 'Differences between the two modes'
const QUESTION =
  '@claude In two short bullet points: (1) what topic was this chat opened from, and ' +
  '(2) quote the user message it was opened from. Do not change any files.'
const CLAUDE_PROJECTS = join(homedir(), '.claude/projects')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const say = (label, value) => {
  console.log(`\n=== ${label} ===`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-forward-'))
  const db = join(SOURCE, 'chorus.v2.db')
  if (!existsSync(db)) throw new Error(`no database at ${db}`)
  const copy = spawnSync('sqlite3', [db, `.backup '${join(dir, 'chorus.v2.db')}'`])
  if (copy.status !== 0) throw new Error(`could not copy the database: ${String(copy.stderr)}`)
  return dir
}

const query = (dir, sql) => {
  const result = spawnSync('sqlite3', ['-readonly', '-json', join(dir, 'chorus.v2.db'), sql])
  if (result.status !== 0) throw new Error(String(result.stderr))
  const text = String(result.stdout).trim()
  return text === '' ? [] : JSON.parse(text)
}

const bytes = (text) => Buffer.byteLength(text, 'utf8')

ensureBuilt()

const userData = seed()
const [source] = query(
  userData,
  `select id from conversations where title = '${TITLE}' order by updated_at desc limit 1`
)
if (source === undefined) throw new Error(`no conversation titled ${TITLE}`)
const [bulletRequest] = query(
  userData,
  `select id, seq from events where conversation_id = '${source.id}' and type = 'user.message'
     and json_extract(payload, '$.text') like '%bullet%' order by seq limit 1`
)
say('source', { conversationId: source.id, bulletRequest })

const startedAt = Date.now()
const app = await launch({ userData, keepData: true })
try {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await app.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await wait(4_000)

  const evaluate = async (body) =>
    JSON.parse(await app.evaluate(`JSON.stringify((() => { ${body} })())`))
  const sourcePane = `[data-conversation="${source.id}"]`

  await evaluate(`
    document.querySelector('button[aria-label="Past conversations"]')?.click()
    return true
  `)
  await app.until(`document.querySelector('.history-row') !== null`, { timeout: 30_000 })
  const picked = await evaluate(`
    const row = [...document.querySelectorAll('.history-row')]
      .find((node) => node.querySelector('.history-title')?.textContent === ${JSON.stringify(TITLE)})
    if (row === undefined) return 'missing row'
    row.click()
    return 'clicked'
  `)
  check('the source conversation opens from history', picked === 'clicked', picked)
  await app.until(`document.querySelector('${sourcePane} .score') !== null`, { timeout: 120_000 })

  const anchorEntry = `${sourcePane} .entry[data-event-id="${bulletRequest.id}"]`
  for (let tries = 0; tries < 60; tries++) {
    const found = await evaluate(`return document.querySelector('${anchorEntry}') !== null`)
    if (found) break
    await evaluate(`
      const score = document.querySelector('${sourcePane} .score')
      score.scrollTop = 0
      score.dispatchEvent(new Event('scroll'))
      return true
    `)
    await wait(800)
  }
  check(
    'the old bullet-points message is reachable in the transcript',
    await evaluate(`return document.querySelector('${anchorEntry}') !== null`)
  )
  check(
    'the composer no longer has a Forward button',
    await evaluate(
      `return document.querySelector('${sourcePane} button[aria-label^="Forward a task"]') === null`
    )
  )

  const selectedText = await evaluate(`
    const entry = document.querySelector('${anchorEntry}')
    if (entry === null) return null
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null && !node.textContent.includes('bullet points')) node = walker.nextNode()
    if (node === null) return null
    entry.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, node.textContent.length)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.querySelector('${sourcePane} .score').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return selection.toString().trim()
  `)
  say('selected text', selectedText)
  check(
    'a passage of the old message was selected',
    typeof selectedText === 'string' && selectedText.includes('bullet points')
  )

  const forwardOffer = `[...document.querySelectorAll('${sourcePane} .quote-offer-action')]
    .find((node) => node.textContent.trim() === 'Forward to new chat')`
  await app.until(`${forwardOffer} !== undefined`, { timeout: 10_000 })
  const offered = await evaluate(`
    return [...document.querySelectorAll('${sourcePane} .quote-offer-action')].map((node) => node.textContent.trim())
  `)
  say('selection pill', offered)
  check('the selection pill offers Forward to new chat', offered.includes('Forward to new chat'))
  await evaluate(`${forwardOffer}.click(); return true`)

  let child
  const childDeadline = Date.now() + 120_000
  while (Date.now() < childDeadline) {
    ;[child] = query(
      userData,
      `select conversation_id as id, json_extract(payload, '$.forward') as forward,
         json_extract(payload, '$.title') as title, seq
       from events where type = 'conversation.created' and created_at >= ${String(startedAt)}
         and json_extract(payload, '$.continuedFrom') = '${source.id}' order by seq desc limit 1`
    )
    if (child !== undefined) break
    await wait(1_000)
  }
  check('Forward opened a child of the source with no dialog', child !== undefined)
  const forward = child === undefined ? null : JSON.parse(child.forward ?? 'null')
  say('child metadata', { ...child, forward })
  check('the selection is the child’s pre-context', forward?.objective === selectedText)
  check(
    'the selected message is anchored',
    forward?.sourceEventIds?.includes(bulletRequest.id) === true,
    JSON.stringify(forward?.sourceEventIds)
  )
  const firstLine = Array.from(
    (selectedText ?? '')
      .split(/\r?\n/u)
      .find((line) => line.trim() !== '')
      ?.trim()
      .replace(/\s+/gu, ' ') ?? ''
  )
    .slice(0, 80)
    .join('')
  check(
    'the child is titled by the selection’s first line',
    child?.title === firstLine,
    child?.title
  )

  const childPane = `[data-conversation="${child?.id}"]`
  await app.until(`document.querySelector('${childPane} textarea') !== null`, {
    timeout: 120_000,
  })
  await wait(1_500)
  const view = await evaluate(`
    const notice = [...document.querySelectorAll('${childPane} *')].find((node) =>
      node.children.length === 0 && (node.textContent || '').startsWith('Task: '))
    return {
      drafts: [...document.querySelectorAll('${childPane} textarea')].map((node) => node.value),
      notice: notice?.textContent ?? null,
    }
  `)
  say('child after Forward', view)
  check(
    'the child composer opens empty',
    view.drafts.length > 0 && view.drafts.every((draft) => draft === '')
  )
  check(
    'the child shows the selection as its Task notice',
    view.notice?.includes('bullet points') === true,
    view.notice
  )
  check(
    'the source chat stays open',
    query(
      userData,
      `select count(*) as n from events where conversation_id = '${source.id}' and type = 'session.ended'
         and created_at >= ${String(startedAt)}`
    )[0].n === 0
  )
  check(
    'nothing was sent on the user’s behalf',
    query(
      userData,
      `select count(*) as n from events where conversation_id = '${child?.id}' and type = 'user.message'`
    )[0].n === 0
  )

  agent: {
    if (process.env.FORWARD_ASK === '0') {
      console.log('\nAgent question skipped (FORWARD_ASK=0)')
      break agent
    }
    let asked = 'not sent'
    const sendDeadline = Date.now() + 120_000
    while (Date.now() < sendDeadline) {
      asked = await evaluate(`
        const chat = [...document.querySelectorAll('${childPane} button[aria-pressed]')]
          .find((node) => node.textContent.trim() === 'Chat')
        if (chat === undefined) return 'missing Chat toggle'
        if (chat.getAttribute('aria-pressed') !== 'true') chat.click()
        const area = document.querySelector('${childPane} textarea')
        area.focus()
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(area, ${JSON.stringify(QUESTION)})
        area.dispatchEvent(new Event('input', { bubbles: true }))
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return 'attempted'
      `)
      await wait(3_000)
      const recorded = query(
        userData,
        `select count(*) as n from events where conversation_id = '${child?.id}' and type = 'user.message'`
      )[0].n
      if (recorded > 0) {
        asked = 'sent'
        break
      }
    }
    check(
      'the question was sent from the empty child composer once its agents were ready',
      asked === 'sent',
      asked
    )
    if (asked !== 'sent') break agent

    let reply
    const replyDeadline = Date.now() + 240_000
    while (Date.now() < replyDeadline) {
      ;[reply] = query(
        userData,
        `select json_extract(payload, '$.text') as text from events
         where conversation_id = '${child?.id}' and type = 'agent.message.completed' and actor = 'claude'
         order by seq desc limit 1`
      )
      if (reply !== undefined) break
      await wait(3_000)
    }
    say('claude replied', reply?.text ?? '(no reply)')
    check('Claude answered in the child', reply !== undefined)
    check(
      'Claude knew the selected topic and quoted the anchored message',
      /bullet/i.test(reply?.text ?? '') && /seperate lines|separate lines/i.test(reply?.text ?? '')
    )

    const prompt =
      readdirSync(CLAUDE_PROJECTS)
        .map((name) => join(CLAUDE_PROJECTS, name))
        .filter((dir) => dir.endsWith('tpa-web-1'))
        .flatMap((dir) => readdirSync(dir).map((name) => join(dir, name)))
        .filter((file) => file.endsWith('.jsonl') && statSync(file).mtimeMs >= startedAt)
        .flatMap((file) =>
          readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line.includes('"type":"user"'))
            .flatMap((line) => {
              try {
                const content = JSON.parse(line).message?.content
                const text =
                  typeof content === 'string'
                    ? content
                    : (content ?? [])
                        .map((part) => (part.type === 'text' ? part.text : ''))
                        .join('')
                return text.includes('quote the user message it was opened from') ? [text] : []
              } catch {
                return []
              }
            })
        )
        .at(0) ?? ''
    const references = (prompt.match(/\[#\d+ [0-9a-f-]{36}\]/gu) ?? []).length
    say('the prompt Claude received (head)', prompt.slice(0, 2_000))
    check('the delivered prompt was found in Claude’s session file', prompt !== '')
    check(
      'the delivered prompt stays within the context cap plus the question',
      bytes(prompt) <= 26_000,
      `${String(bytes(prompt))} bytes`
    )
    check(
      'the handover presents the selection as pre-context',
      prompt.includes('from this passage they selected')
    )
    check(
      'the anchored message is in the handover with its reference',
      prompt.includes(`[#${String(bulletRequest.seq)} ${bulletRequest.id}]`)
    )
    check(
      'the handover also carries other records with references',
      references >= 5,
      `${String(references)} references`
    )
  }
} finally {
  say('test profile kept at', app.dataPath)
  await app.stop()
}

console.log(
  `\n${failures.length === 0 ? 'ALL PASSED' : `${String(failures.length)} FAILED: ${failures.join('; ')}`}`
)
process.exit(failures.length === 0 ? 0 : 1)
