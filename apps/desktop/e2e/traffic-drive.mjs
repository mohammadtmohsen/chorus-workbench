import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch, wait } from './harness.mjs'

const SOURCE = join(homedir(), 'Library/Application Support/@chorus/desktop-dev')
const PROJECT = 'tpa-web-1'
const VARIABLE = 'JAVA_API_DEV_BASE_URL'

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-traffic-'))
  const db = join(SOURCE, 'chorus.v2.db')
  if (!existsSync(db)) throw new Error(`no database at ${db}`)
  const copy = spawnSync('sqlite3', [db, `.backup '${join(dir, 'chorus.v2.db')}'`])
  if (copy.status !== 0) {
    throw new Error(`could not copy the database: ${String(copy.stderr)}`)
  }
  return dir
}

const say = (label, value) => {
  console.log(`\n=== ${label} ===`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

ensureBuilt()

const userData = seed()
const upstream = await new Promise((resolve) => {
  const server = createServer((request, response) => {
    // One row that carries a next action and one that carries only a code, so
    // the trailing column can be shown to hold both in the same place.
    // No code, only a next action: the row whose single trailing value is the
    // one that used to sit a column to the right of everybody else's.
    const body = JSON.stringify({ data: { nextAction: 'LOGIN' } })
    const deep = JSON.stringify({ ok: true, nested: { a: 1, b: [1, 2] }, hello: 'readable' })
    const many = {}
    for (let i = 0; i < 16; i++) many[`x-filler-${String(i)}`] = `value ${String(i)}`.repeat(4)
    if ((request.url ?? '').startsWith('/gz')) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        ...many,
      })
      response.end(gzipSync(deep))
      return
    }
    if ((request.url ?? '').startsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'application/json', ...many })
      response.end(
        JSON.stringify({ code: 'MOBILE_FAMILY_CONTRACT_NOT_FOUND_AND_THEN_SOME_MORE_CHARACTERS' })
      )
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', ...many })
    response.end(body)
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

const capturePort = await new Promise((resolve) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    const port = address !== null && typeof address === 'object' ? address.port : 0
    probe.close(() => {
      resolve(port)
    })
  })
})

const app = await launch({ userData })
try {
  await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
  await wait(4_000)

  const typed = (label, text) =>
    app.evaluate(`(() => {
      const input = [...document.querySelectorAll('.traffic-panel input')]
        .find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (input === undefined) return 'missing field: ' + ${JSON.stringify(label)}
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const readBack = input.value
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.blur()
      return { readBack, focused: document.activeElement === input }
    })()`)

  const clicked = (selector) =>
    app.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (node === null) return 'missing: ' + ${JSON.stringify(selector)}
      node.click()
      return 'clicked'
    })()`)

  await app.evaluate(`(() => {
    const tile = [...document.querySelectorAll('.rail-item.rail-project')]
      .find((node) => (node.innerText || '').includes(${JSON.stringify(PROJECT)}))
    if (tile !== undefined) tile.click()
    return true
  })()`)
  await app.until(`document.querySelector('[data-traffic-open]') !== null`, { timeout: 60_000 })
  await clicked('[data-traffic-open]')
  await app.until(`document.querySelector('.traffic-panel') !== null`, { timeout: 60_000 })
  check('the panel opened', await app.evaluate(`document.querySelector('.traffic-panel') !== null`))

  const setup = JSON.parse(
    await app.evaluate(`(() => {
      const details = document.querySelector('.traffic-setup')
      const outside = (node) => node !== null && (details === null || !details.contains(node))
      const origin = document.querySelector('[aria-label="Forward to"]')
      return JSON.stringify({
        present: details !== null,
        open: details === null ? null : details.open,
        headerOutside: outside(document.querySelector('.traffic-head')),
        filtersOutside: outside(document.querySelector('[aria-label="Search the list"]')),
        originShown: origin === null ? null : origin.checkVisibility()
      })
    })()`)
  )
  say('the capture setup', setup)
  check('the capture setup starts closed', setup.present && setup.open === false)
  check(
    'the header and the list filters stay outside it',
    setup.headerOutside && setup.filtersOutside
  )
  check('and its inputs are not drawn', setup.originShown === false)

  await clicked('.traffic-setup summary')
  await wait(600)
  const setupOpen = JSON.parse(
    await app.evaluate(`(() => {
      const details = document.querySelector('.traffic-setup')
      const origin = document.querySelector('[aria-label="Forward to"]')
      return JSON.stringify({
        open: details.open,
        originShown: origin === null ? null : origin.checkVisibility()
      })
    })()`)
  )
  say('the capture setup, opened', setupOpen)
  check(
    'it opens on click, and its inputs appear',
    setupOpen.open === true && setupOpen.originShown === true
  )

  const origin = `http://127.0.0.1:${upstream.port}`
  say('origin set to', `${origin} (asking: ${await typed('Forward to', origin)})`)
  say(
    'variable set to',
    `${VARIABLE} (asking: ${await typed('Variable your app reads', VARIABLE)})`
  )
  say('port set to', `${String(capturePort)} (asking: ${await typed('Port', String(capturePort))})`)
  await wait(1_500)

  say(
    'committed state in the panel',
    await app.evaluate(`JSON.stringify({
      envLine: document.querySelector('.traffic-env')?.innerText ?? null,
      header: document.querySelector('.traffic-panel')?.innerText.split('\\n').slice(0, 2).join(' | ') ?? null,
      startDisabled: document.querySelector('[aria-label="Start capture"]')?.disabled ?? 'no button',
    })`)
  )

  say(
    'preload / console calibration',
    await app.evaluate(`(() => {
      console.error('[probe] page console is captured')
      const api = window.chorus
      return JSON.stringify({
        hasOnTraffic: typeof api.onTraffic,
        preloadIsCurrent: String(api.onTraffic).includes('a push was dropped'),
        hasAck: typeof api.ackTraffic,
        hasAttach: typeof api.attachTraffic,
      })
    })()`)
  )
  await wait(500)

  say(
    'beside the panel',
    await app.evaluate(`(() => {
      window.__trafficSeen = []
      window.chorus.onTraffic((push) => {
        window.__trafficSeen.push(
          push.kind + ' rows=' + String(push.rows === undefined ? 0 : push.rows.length) +
          ' project=' + push.projectId + ' capture=' + (push.captureId ?? '-')
        )
      })
      return 'listening'
    })()`)
  )

  say('start', await clicked('[aria-label="Start capture"]'))
  await wait(3_000)

  const header = await app.evaluate(`document.querySelector('.traffic-panel')?.innerText ?? ''`)
  say('header after start', header.split('\n').slice(0, 3).join(' | '))
  say('renderer console', app.console().slice(-12).join('\n'))
  say('window body', await app.evaluate(`document.body.innerText.slice(0, 200)`))
  check('the listener bound', header.includes('Listening on 127.0.0.1:'))

  /*
   * The port the panel reports, never a fixed one: this machine may already be
   * running another Chorus holding the port this driver would otherwise assume.
   */
  const port = await app.evaluate(`(() => {
    const line = (document.querySelector('.traffic-env')?.innerText ?? '').trim()
    const match = /:([0-9]+)$/.exec(line)
    return match === null ? null : Number(match[1])
  })()`)
  say('listening port', String(port))
  const answer = await fetch(`http://127.0.0.1:${String(port)}/hello`)
  say('request through the listener', `status ${answer.status} ${await answer.text()}`)

  let rows = 0
  for (let i = 0; i < 25; i++) {
    rows = await app.evaluate(
      `[...document.querySelectorAll('.traffic-panel *')].filter((n) =>
         (n.className || '').toString().includes('traffic-row')).length`
    )
    if (rows > 0) break
    await wait(400)
  }
  say(
    'pushes the renderer actually received',
    await app.evaluate(`JSON.stringify(window.__trafficSeen ?? 'never registered')`)
  )
  const text = await app.evaluate(`document.querySelector('.traffic-panel')?.innerText ?? ''`)
  say('panel text after the request', text.slice(0, 700))
  check('a row appeared', /1 captured|hello/.test(text), `${String(rows)} row nodes`)

  if (/1 captured/.test(text)) {
    say(
      'row markup',
      await app.evaluate(`(() => {
        const row = [...document.querySelectorAll('.traffic-panel *')]
          .find((n) => (n.className || '').toString().includes('traffic-row'))
        return row === undefined ? 'no row node' : row.outerHTML.slice(0, 400)
      })()`)
    )
    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('.traffic-panel *')]
        .find((n) => (n.className || '').toString().includes('traffic-row'))
      if (row === null) return false
      const target = row.tagName === 'BUTTON' ? row : (row.querySelector('button') ?? row)
      target.click()
      return true
    })()`)
    await wait(3_000)
    const inspector = await app.evaluate(
      `document.querySelector('.traffic-inspector')?.innerText.slice(0, 300) ?? null`
    )
    say('inspector', inspector)
    check('the inspector opened', inspector !== null)

    const boxes = JSON.parse(
      await app.evaluate(`(() => {
      const head = (side) =>
        document.querySelector('.traffic-pane[data-side=' + side + '] > .traffic-label')
      const box = (node) => (node === null ? null : Math.round(node.getBoundingClientRect().height))
      const panes = [...document.querySelectorAll('.traffic-pane')]
      return JSON.stringify({
        panes: panes.length,
        sides: panes.map((node) => node.getAttribute('data-side')),
        leftHead: box(head('"request"')),
        rightHead: box(head('"response"')),
        sideBySide:
          panes.length === 2 &&
          Math.round(panes[0].getBoundingClientRect().top) ===
            Math.round(panes[1].getBoundingClientRect().top)
      })
    })()`)
    )
    say('the two boxes', boxes)
    check(
      'the inspector is two boxes, request then response',
      boxes.panes === 2,
      boxes.sides.join(', ')
    )
    check(
      'side by side rather than stacked',
      boxes.sideBySide === true,
      `tops equal: ${String(boxes.sideBySide)}`
    )
    check(
      'and neither heading is stretched by the label rule',
      boxes.leftHead !== null &&
        boxes.leftHead < 30 &&
        boxes.rightHead !== null &&
        boxes.rightHead < 30,
      `${String(boxes.leftHead)}px / ${String(boxes.rightHead)}px`
    )

    await wait(4_000)
    await app.evaluate(`(() => {
      const box = document.querySelector('.traffic-inspector')
      if (box !== null) box.scrollTop = box.scrollHeight
      return true
    })()`)
    await wait(800)

    const geometry = JSON.parse(
      await app.evaluate(`(() => {
        const box = document.querySelector('.traffic-inspector')
        const view = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view')
        const bar = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view .traffic-body-bar')
        const groups = [...document.querySelectorAll('.traffic-general')]
        const timing = groups.length === 0 ? null : groups[groups.length - 1]
        const rect = (node) =>
          node === null || node === undefined
            ? null
            : { top: Math.round(node.getBoundingClientRect().top), bottom: Math.round(node.getBoundingClientRect().bottom) }
        return JSON.stringify({
          inspector: rect(box),
          rows: rect(document.querySelector('.traffic-rows')),
          bodyView: rect(view),
          bodyBar: rect(bar),
          timing: rect(timing),
          lastHeader: rect(document.querySelector('.traffic-headers dd:last-of-type')),
        })
      })()`)
    )
    say('geometry', geometry)
    check(
      'the list and the detail are stacked, never side by side',
      geometry.rows !== null &&
        geometry.inspector !== null &&
        geometry.rows.bottom <= geometry.inspector.top,
      `rows bottom ${String(geometry.rows?.bottom)} vs inspector top ${String(geometry.inspector?.top)}`
    )
    check(
      'the body view is not squashed to nothing',
      geometry.bodyView !== null && geometry.bodyView.bottom > geometry.bodyView.top,
      `height ${String(geometry.bodyView === null ? 'n/a' : geometry.bodyView.bottom - geometry.bodyView.top)}`
    )
    check(
      'the body view does not run over the timing block',
      geometry.bodyBar === null ||
        geometry.timing === null ||
        geometry.bodyBar.bottom <= geometry.timing.top,
      `bar bottom ${String(geometry.bodyBar?.bottom)} vs timing top ${String(geometry.timing?.top)}`
    )

    const readFold = `(() => {
      const details = document.querySelector('.traffic-pane[data-side="request"] .traffic-fold')
      const view = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view')
      const inside = details === null ? null : details.querySelector('.traffic-general')
      const outside = [...document.querySelectorAll('.traffic-inspector > .traffic-general')]
      const carries = (node) => node !== null && (node.innerText || '').includes('bytes kept')
      return JSON.stringify({
        present: details !== null,
        open: details === null ? null : details.open,
        summary: details === null ? null : (details.querySelector('summary')?.innerText ?? null),
        payloadTop: view === null ? null : Math.round(view.getBoundingClientRect().top),
        foldTop: details === null ? null : Math.round(details.getBoundingClientRect().top),
        foldHeight: details === null ? null : Math.round(details.getBoundingClientRect().height),
        sizesInside: carries(inside),
        sizesOutside: outside.some((node) => carries(node)),
        endpointOutside:
          document.querySelector(
            '.traffic-pane[data-side="request"] > .traffic-general .traffic-url'
          ) !== null,
        structure: [...document.querySelectorAll('.traffic-inspector > *')].map(
          (node) => node.tagName.toLowerCase() + '.' + (node.className || '')
        )
      })
    })()`

    const folded = JSON.parse(await app.evaluate(readFold))
    say('the fold, closed', folded)
    check('the request section starts closed', folded.present && folded.open === false)
    check(
      'the payload sits above it',
      folded.payloadTop !== null && folded.foldTop !== null && folded.payloadTop < folded.foldTop,
      `payload ${String(folded.payloadTop)} vs fold ${String(folded.foldTop)}`
    )
    check(
      'closed, it takes only the height of its summary',
      folded.foldHeight !== null && folded.foldHeight > 0 && folded.foldHeight < 40,
      `${String(folded.foldHeight)}px`
    )
    check('no size rows are left outside it', folded.sizesOutside === false)
    check('the endpoint line stays outside it', folded.endpointOutside)

    const views = JSON.parse(
      await app.evaluate(`(() => {
        const bar = document.querySelector('.traffic-pane[data-side="request"] .traffic-body-view .traffic-body-bar')
        const buttons = bar === null ? [] : [...bar.querySelectorAll('.traffic-tab')]
        const label = (node) => (node.innerText || '').trim()
        return JSON.stringify({
          labels: buttons.map(label),
          pressed: buttons
            .filter((node) => node.getAttribute('aria-pressed') === 'true')
            .map(label)
        })
      })()`)
    )
    say('the body view bar', views)
    check(
      'the view buttons are gone',
      ['Raw', 'Formatted', 'Hex'].every((label) => !views.labels.includes(label)),
      views.labels.join(' | ')
    )

    await app.evaluate(`(() => {
      document.querySelector('.traffic-pane[data-side="request"] .traffic-fold summary').click()
      return true
    })()`)
    await wait(600)
    const opened = JSON.parse(await app.evaluate(readFold))
    say('the fold, opened', opened)
    check('it opens on click', opened.open === true)
    check('the request and response sizes are inside it', opened.sizesInside)
    check(
      'and it grows well past the summary',
      opened.foldHeight > folded.foldHeight + 40,
      `${String(folded.foldHeight)}px → ${String(opened.foldHeight)}px`
    )

    const listState = `JSON.stringify({
      rows: document.querySelectorAll('.traffic-rows .traffic-row').length,
      searched: document.querySelector('[aria-label="Search the list"]')?.value ?? null,
      clearDisabled: (() => {
        const button = [...document.querySelectorAll('.traffic-panel button')]
          .find((node) => (node.innerText || '').trim() === 'Clear')
        return button === undefined ? 'no button' : button.disabled
      })(),
      empty: (document.querySelector('.traffic-panel')?.innerText ?? '').includes('Nothing matches')
    })`

    say('before searching', await typed('Search the list', 'zzz-nothing'))
    await wait(900)
    const narrowed = JSON.parse(await app.evaluate(listState))
    say('the list, searched', narrowed)
    check(
      'the search narrows the list, and Clear is offered',
      narrowed.rows === 0 && narrowed.empty && narrowed.clearDisabled === false,
      `${String(narrowed.rows)} rows`
    )

    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.traffic-panel button')]
        .find((node) => (node.innerText || '').trim() === 'Clear')
      button.click()
      return true
    })()`)
    await wait(900)
    const cleared = JSON.parse(await app.evaluate(listState))
    say('the list, cleared', cleared)
    check(
      'Clear empties the search and the rows come back',
      cleared.searched === '' && cleared.rows > 0 && cleared.clearDisabled === true,
      `${String(cleared.rows)} rows`
    )

    await fetch(`http://127.0.0.1:${String(port)}/missing`)
    await fetch(`http://127.0.0.1:${String(port)}/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ posting: true }),
    })
    await wait(2_500)

    const table = JSON.parse(
      await app.evaluate(`(() => {
        const colour = (node) => (node === null ? null : getComputedStyle(node).color)
        const cells = [...document.querySelectorAll('.traffic-row-button .traffic-status')]
        const lefts = cells.map((node) => Math.round(node.getBoundingClientRect().left))
        const methods = [...document.querySelectorAll('.traffic-row-button .traffic-method')]
        return JSON.stringify({
          rows: cells.length,
          lefts,
          aligned: new Set(lefts).size === 1,
          twoHundred: colour(document.querySelector('.traffic-status[data-class="2xx"]')),
          fourHundred: colour(document.querySelector('.traffic-status[data-class="4xx"]')),
          methods: methods.map((node) => ({
            m: node.innerText.trim(),
            colour: getComputedStyle(node).color
          })),
          urls: [...document.querySelectorAll('.traffic-row-button .traffic-url')].map((node) => ({
            text: node.innerText.slice(0, 40),
            w: Math.round(node.getBoundingClientRect().width)
          })),
          columns: getComputedStyle(
            document.querySelector('.traffic-row-button')
          ).gridTemplateColumns,
          widths: (() => {
            const box = (selector) => {
              const node = document.querySelector(selector)
              return node === null ? null : Math.round(node.getBoundingClientRect().width)
            }
            return {
              panel: box('.traffic-panel'),
              rows: box('.traffic-rows'),
              row: box('.traffic-row'),
              button: box('.traffic-row-button'),
              step: getComputedStyle(document.querySelector('.traffic-row-button')).gap
            }
          })()
        })
      })()`)
    )
    say('the list as a table', table)
    check(
      'every status sits in one column, across rows',
      table.aligned && table.rows >= 2,
      `${String(table.rows)} rows at [${table.lefts.join(', ')}]`
    )
    check(
      'a 2xx and a 4xx are coloured differently',
      table.twoHundred !== null &&
        table.fourHundred !== null &&
        table.twoHundred !== table.fourHundred,
      `${String(table.twoHundred)} vs ${String(table.fourHundred)}`
    )
    const methodColour = (name) => table.methods.find((each) => each.m === name)?.colour ?? null
    const methodColours = new Set(table.methods.map((each) => each.colour))
    check(
      'each method has a colour of its own',
      methodColour('GET') !== null &&
        methodColour('POST') !== null &&
        methodColour('GET') !== methodColour('POST') &&
        methodColours.size === new Set(table.methods.map((each) => each.m)).size,
      table.methods.map((each) => `${each.m} ${each.colour}`).join(' | ')
    )

    const trailing = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const firsts = [...document.querySelectorAll('.traffic-row-button')].map((row) =>
          ['code', 'next']
            .map((kind) => row.querySelector('.traffic-' + kind))
            .filter((node) => node !== null && (node.innerText ?? '').trim() !== '')
            .map((node) => ({
              text: (node.innerText ?? '').trim(),
              left: Math.round(node.getBoundingClientRect().left)
            }))[0] ?? null
        ).filter((each) => each !== null)
        return {
          rows: firsts.length,
          lefts: [...new Set(firsts.map((each) => each.left))],
          values: [...new Set(firsts.map((each) => each.text))].length
        }
      })())`)
    )
    say('every trailing value', trailing)
    check(
      'a code and a next action start in the same column',
      trailing.rows >= 3 && trailing.lefts.length === 1 && trailing.values >= 2,
      `${String(trailing.rows)} rows at [${trailing.lefts.join(', ')}]`
    )

    const leaked = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const rows = [...document.querySelectorAll('.traffic-row-button')]
        return {
          rows: rows.length,
          offenders: rows
            .map((row) => (row.textContent ?? '').trim())
            .filter((text) => text.includes('/*'))
        }
      })())`)
    )
    const truncation = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const cells = [...document.querySelectorAll('.traffic-row-button .traffic-code')]
        const longest = cells.reduce(
          (best, node) => ((node.innerText ?? '').length > (best?.innerText ?? '').length ? node : best),
          null
        )
        if (longest === null) return null
        const style = getComputedStyle(longest)
        const note = longest.parentElement
        const row = longest.closest('.traffic-row-button')
        const range = document.createRange()
        range.selectNodeContents(longest)
        return {
          text: longest.innerText,
          height: Math.round(longest.getBoundingClientRect().height),
          cell: Math.round(longest.getBoundingClientRect().width),
          clientWidth: longest.clientWidth,
          scrollWidth: longest.scrollWidth,
          textWidth: Math.round(range.getBoundingClientRect().width),
          note: note === null ? null : Math.round(note.getBoundingClientRect().width),
          row: row === null ? null : Math.round(row.getBoundingClientRect().width),
          columns: row === null ? null : getComputedStyle(row).gridTemplateColumns,
          whiteSpace: style.whiteSpace,
          overflow: style.overflow,
          ellipsis: style.textOverflow
        }
      })())`)
    )
    const edges = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const row = document.querySelector('.traffic-row-button')
        if (row === null) return null
        const cells = [...row.children]
        return cells.map((cell) => {
          const box = cell.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(cell)
          const text = range.getBoundingClientRect()
          return {
            cell: cell.className,
            cellLeft: Math.round(box.left),
            textLeft: Math.round(text.left),
            same: Math.abs(text.left - box.left) <= 1
          }
        })
      })())`)
    )
    say("where each cell's text starts", edges)
    check(
      "every cell's text starts at its column's left edge",
      edges !== null && edges.length === 5 && edges.every((each) => each.same),
      edges === null
        ? 'no row'
        : edges.map((each) => `${each.cell}:${String(each.textLeft - each.cellLeft)}`).join(' ')
    )

    say('the longest trailing value', truncation)
    check(
      'a long value stays on one line and ellipsizes',
      truncation !== null &&
        truncation.height <= 20 &&
        truncation.scrollWidth > truncation.clientWidth &&
        truncation.overflow === 'hidden' &&
        truncation.ellipsis === 'ellipsis',
      JSON.stringify(truncation)
    )

    say('literal comments in the rows', leaked)
    check(
      'no row renders a comment as text',
      leaked.rows > 0 && leaked.offenders.length === 0,
      leaked.offenders.slice(0, 2).join(' | ')
    )

    const walk = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const buttons = [...document.querySelectorAll('.traffic-row-button')]
        if (buttons.length < 3) return null
        const at = () => buttons.indexOf(document.activeElement)
        buttons[0].focus()
        const seen = [at()]
        for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
          seen.push(at())
        }
        return seen
      })())`)
    )
    say('the arrows', walk)
    check(
      'the arrows walk the rows without opening anything',
      walk !== null && walk.join(',') === '0,1,2,1',
      String(walk)
    )

    await fetch(`http://127.0.0.1:${String(port)}/gz`)
    await wait(2_500)
    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('.traffic-row')]
        .find((node) => (node.innerText || '').includes('/gz'))
      if (row !== undefined) (row.querySelector('button') ?? row).click()
      return true
    })()`)
    await wait(2_000)
    await wait(4_000)

    const treeState = `JSON.stringify({
      present: document.querySelector('.traffic-pane[data-side="response"] .traffic-tree') !== null,
      flat: document.querySelector('.traffic-pane[data-side="response"] .traffic-body-text') !== null,
      rows: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node').length,
      focus: document.activeElement?.getAttribute('data-path') ?? null,
      keys: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node .tok--property').length,
      strings: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node .tok--string').length,
      keywords: document.querySelectorAll('.traffic-pane[data-side="response"] .traffic-node .tok--keyword').length,
      text: document.querySelector('.traffic-pane[data-side="response"] .traffic-tree')?.innerText ?? null
    })`

    const tree = JSON.parse(await app.evaluate(treeState))
    say('a gzipped response body', tree)
    check(
      'a JSON body is a tree, coloured, not flat text',
      tree.present && !tree.flat && tree.keys >= 3 && tree.strings >= 1 && tree.keywords >= 1,
      `keys ${String(tree.keys)}, strings ${String(tree.strings)}, keywords ${String(tree.keywords)}`
    )
    check(
      'and it shows the values the wire carried',
      typeof tree.text === 'string' && tree.text.includes('readable'),
      JSON.stringify(tree.text)
    )
    check(
      'every row is drawn when nothing is folded, braces and all',
      tree.rows === 11,
      `${String(tree.rows)} rows`
    )

    await app.evaluate(`(() => {
      const node = document.querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"]')
      if (node === null) return false
      node.focus()
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
      return true
    })()`)
    await wait(600)
    const treeFolded = JSON.parse(await app.evaluate(treeState))
    check(
      'ArrowLeft folds the focused node',
      treeFolded.rows === 5,
      `${String(treeFolded.rows)} rows`
    )

    await app.evaluate(`(() => {
      document
        .querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      return true
    })()`)
    await wait(600)
    const unfolded = JSON.parse(await app.evaluate(treeState))
    check('ArrowRight unfolds it again', unfolded.rows === 11, `${String(unfolded.rows)} rows`)

    await app.evaluate(`(() => {
      document
        .querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      return true
    })()`)
    await wait(500)

    const nesting = JSON.parse(
      await app.evaluate(`(() => {
        const contentLeft = (selector) => {
          const row = document.querySelector(selector)
          if (row === null) return null
          const style = getComputedStyle(row)
          return Math.round(row.getBoundingClientRect().left + parseFloat(style.paddingLeft))
        }
        const key = document.querySelector('.traffic-pane[data-side="response"] .traffic-node[data-path="/1"] .tok--property')
        return JSON.stringify({
          parentKey: key === null ? null : Math.round(key.getBoundingClientRect().left),
          child: contentLeft('.traffic-pane[data-side="response"] .traffic-node[data-path="/1/0"]'),
          closer: contentLeft('.traffic-pane[data-side="response"] .traffic-node[data-path="/1/>"]')
        })
      })()`)
    )
    say('the nesting', nesting)
    check(
      'a child is indented past the key that holds it',
      nesting.child !== null && nesting.parentKey !== null && nesting.child > nesting.parentKey,
      `child ${String(nesting.child)} vs key ${String(nesting.parentKey)}`
    )
    check(
      'and the closing bracket lands on that key',
      nesting.closer !== null &&
        nesting.parentKey !== null &&
        Math.abs(nesting.closer - nesting.parentKey) <= 2,
      `closer ${String(nesting.closer)} vs key ${String(nesting.parentKey)}`
    )

    const stepped = JSON.parse(await app.evaluate(treeState))
    check(
      'ArrowDown moves into the node it opened',
      stepped.focus === '/1/0',
      `focus at ${String(stepped.focus)}`
    )

    const { data } = await app.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    writeFileSync('/tmp/traffic-drive.png', Buffer.from(data, 'base64'))
    say('screenshot', '/tmp/traffic-drive.png')
  }
  const strip = `JSON.stringify(
    [...document.querySelectorAll('.conversation-dock-tab')].map((node) => {
      const box = node.getBoundingClientRect()
      return {
        traffic: node.getAttribute('data-traffic-tab') === 'true',
        title: (node.innerText || '').split('\\n')[0],
        x: Math.round(box.left + box.width / 2),
        left: Math.round(box.left),
        right: Math.round(box.right),
        y: Math.round(box.top + box.height / 2)
      }
    })
  )`

  const addTab = () =>
    app.evaluate(`(() => {
      const add = [...document.querySelectorAll('.conversation-dock-add')]
        .find((node) => (node.innerText || '').trim() === '+')
      if (add === undefined) return false
      add.click()
      return true
    })()`)

  /*
   * A real pointer owns the capture and a dispatched one cannot claim it, so the
   * three capture calls are stubbed for the length of the gesture. Everything
   * else — the threshold, the target, the layout and the store — runs for real.
   */
  /*
   * `yMode` picks where the pointer is when it lets go.
   *
   * `tab` is the tab strip's own row, which for a short column lies inside that
   * column's top split band — so a drop there is a split, and always was, for a
   * conversation tab as much as for this one. `column` aims at the middle of the
   * column instead, below both bands, which is where the slot list is reachable.
   */
  const gesture = (from, to, at, side, yMode) => `(() => {
    const tab = document.querySelector(${JSON.stringify(from)})
    const other = [...document.querySelectorAll(${JSON.stringify(to)})][${String(at)}]
    if (tab === null || other === undefined) return 'missing a tab'
    const here = tab.getBoundingClientRect()
    const there = other.getBoundingClientRect()
    const column = document.querySelector('.conversation-column').getBoundingClientRect()
    const fromX = Math.round(here.left + here.width / 2)
    const y =
      ${JSON.stringify(yMode)} === 'column'
        ? Math.round(column.top + column.height / 2)
        : Math.round(here.top + here.height / 2)
    const toX =
      ${JSON.stringify(side)} === 'left'
        ? Math.round(there.left + 4)
        : ${JSON.stringify(side)} === 'right'
          ? Math.round(there.right - 4)
          : Math.round(there.left + there.width / 2 + 20)
    const proto = Element.prototype
    const saved = [proto.setPointerCapture, proto.releasePointerCapture, proto.hasPointerCapture]
    proto.setPointerCapture = function () {}
    proto.releasePointerCapture = function () {}
    proto.hasPointerCapture = function () {
      return false
    }
    const send = (type, x) => {
      tab.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: x,
          clientY: y
        })
      )
    }
    send('pointerdown', fromX)
    for (let step = 1; step <= 8; step++) {
      send('pointermove', Math.round(fromX + ((toX - fromX) * step) / 8))
    }
    send('pointerup', toX)
    proto.setPointerCapture = saved[0]
    proto.releasePointerCapture = saved[1]
    proto.hasPointerCapture = saved[2]
    return 'from ' + String(fromX) + ' to ' + String(toX)
  })()`

  const CONVERSATION_TAB =
    '.conversation-dock-tab:not([data-traffic-tab]) .conversation-dock-tab-main'
  const TRAFFIC_TAB = '.conversation-dock-tab[data-traffic-tab="true"] .conversation-dock-tab-main'

  await addTab()
  await wait(1_500)
  await addTab()
  await wait(2_500)

  const before = JSON.parse(await app.evaluate(strip))
  say('the tab strip', before)
  const at = before.findIndex((each) => each.traffic)

  /*
   * Both measured in this one column, because the active tab is drawn
   * differently in a focused column than in an unfocused one — dashed and
   * tinted back at 55% — and a comparison across two columns would be reading
   * the focus state rather than the tab.
   */
  const look = `JSON.stringify((() => {
    const node = document.querySelector('.conversation-dock-tab[data-active="true"]')
    if (node === null) return null
    const style = getComputedStyle(node)
    const close = node.querySelector('.conversation-dock-tab-close')
    return {
      traffic: node.getAttribute('data-traffic-tab') === 'true',
      border: style.borderTopColor,
      style: style.borderTopStyle,
      ground: style.backgroundColor,
      ink: style.color,
      close: close === null ? null : getComputedStyle(close).opacity
    }
  })())`

  await app.evaluate(`(() => {
    const tab = document.querySelector('.conversation-dock-tab[data-traffic-tab] .conversation-dock-tab-main')
    if (tab !== null) tab.click()
    return true
  })()`)
  await wait(1_200)
  const trafficLook = JSON.parse(await app.evaluate(look))

  await app.evaluate(`(() => {
    const tab = document.querySelector('.conversation-dock-tab:not([data-traffic-tab]) .conversation-dock-tab-main')
    if (tab !== null) tab.click()
    return true
  })()`)
  await wait(1_200)
  const conversationLook = JSON.parse(await app.evaluate(look))
  say('the tab chrome, both in one column', {
    traffic: trafficLook,
    conversation: conversationLook,
  })
  check(
    'the traffic tab wears the same active chrome as a conversation tab',
    trafficLook !== null &&
      conversationLook !== null &&
      trafficLook.traffic === true &&
      conversationLook.traffic === false &&
      trafficLook.border === conversationLook.border &&
      trafficLook.style === conversationLook.style &&
      trafficLook.ground === conversationLook.ground &&
      trafficLook.ink === conversationLook.ink &&
      trafficLook.close === conversationLook.close,
    `traffic ${JSON.stringify(trafficLook)} vs conversation ${JSON.stringify(conversationLook)}`
  )

  if (before.length >= 3 && at > 0) {
    /*
     * Aimed at the midpoint of the *second* conversation tab, and that is not
     * arbitrary: a column's strip sits inside that column's own edge bands, so
     * a drop anywhere over its first or last tab splits instead of taking a
     * slot. The middle of the strip is the only place the slot list is
     * reachable — for a conversation tab as much as for this one.
     */
    say(
      'the slot drag',
      await app.evaluate(gesture(CONVERSATION_TAB, '.conversation-dock-tab', 1, 'mid', 'column'))
    )
    await wait(1_200)
    const after = JSON.parse(await app.evaluate(strip))
    say('the strip after dropping a conversation before the traffic tab', after)
    const trafficAt = after.findIndex((each) => each.traffic)
    const columns = await app.evaluate(`document.querySelectorAll('.conversation-column').length`)
    check(
      'a conversation is slotted in before the traffic tab',
      trafficAt > 0 && after.length === before.length,
      after.map((each) => (each.traffic ? 'traffic' : each.title)).join(' | ')
    )
    check(
      'and that drop took a slot rather than splitting',
      columns === 1 && after.length === before.length,
      `${String(columns)} column(s), ${String(after.length)} tabs`
    )
    check(
      'the dragged tab landed immediately before the traffic tab',
      trafficAt > 0 &&
        after[trafficAt - 1]?.traffic === false &&
        after.filter((each) => each.traffic).length === 1,
      after.map((each) => (each.traffic ? 'traffic' : each.title)).join(' | ')
    )
  } else {
    check('the strip offered three tabs to reorder', false, `${String(before.length)} tabs`)
  }

  const splitBefore = JSON.parse(await app.evaluate(strip))
  const last = splitBefore.length - 1
  if (splitBefore.length >= 2 && splitBefore[last]?.traffic === true) {
    say(
      'the split drag',
      await app.evaluate(gesture(TRAFFIC_TAB, '.conversation-column', 0, 'left', 'tab'))
    )
    await wait(1_200)
    const split = JSON.parse(
      await app.evaluate(`JSON.stringify({
        columns: document.querySelectorAll('.conversation-column').length,
        first: (() => {
          const column = document.querySelector('.conversation-column')
          if (column === null) return null
          return [...column.querySelectorAll('[data-tab-id]')].map((node) =>
            node.getAttribute('data-traffic-tab') === 'true' ? 'traffic' : node.innerText.split('\\n')[0]
          )
        })(),
        trafficTabs: document.querySelectorAll('[data-tab-id="traffic"]').length
      })`)
    )
    say('the columns after dragging the traffic tab to the edge', split)
    check(
      'the traffic tab splits out into its own group',
      split.columns === 2 && split.first !== null && split.first.includes('traffic'),
      `columns ${String(split.columns)}, first ${String(split.first)}`
    )
    check('and it moved rather than copied', split.trafficTabs === 1)

    // Moving the tab to a new column remounts the panel, which clears the
    // selected row, so one is chosen again before the details exist to measure.
    await app.evaluate(`(() => {
      const row = document.querySelector('.traffic-row-button')
      if (row !== null) row.click()
      return true
    })()`)
    await wait(3_000)

    const box = JSON.parse(
      await app.evaluate(`JSON.stringify((() => {
        const list = document.querySelector('.traffic-split')
        const details = document.querySelector('.traffic-inspector')
        if (list === null || details === null) return null
        return {
          list: Math.round(list.getBoundingClientRect().height),
          details: Math.round(details.getBoundingClientRect().height),
          window: window.innerHeight
        }
      })())`)
    )
    say('the details against their box', box)
    check(
      'the details are half the box they sit in, not half the screen',
      box !== null &&
        Math.abs(box.details - Math.round(box.list / 2)) <= 2 &&
        Math.abs(box.details - Math.round(box.window / 2)) > 2,
      `details ${String(box?.details)} of list ${String(box?.list)}, window ${String(box?.window)}`
    )

    say(
      'the rectangles after a split',
      JSON.parse(
        await app.evaluate(`JSON.stringify((() => {
        const box = (selector) => {
          const node = document.querySelector(selector)
          if (node === null) return null
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            widthCss: style.width,
            minWidth: style.minWidth,
            flexShrink: style.flexShrink,
            flexBasis: style.flexBasis,
            overflow: style.overflow,
            scrollWidth: node.scrollWidth
          }
        }
        return {
          window: window.innerWidth + 'x' + window.innerHeight,
          full: document.querySelector('.workspace-pane-chorus')?.getAttribute('data-full') ?? null,
          surface: box('[data-workbench-surface]'),
          chorus: box('.workspace-pane-chorus'),
          content: box('.workspace-pane-content'),
          pane: box('.workspace-pane')
        }
      })())`)
      )
    )
  } else {
    check(
      'the traffic tab was last, where a split starts from',
      false,
      `${String(splitBefore.length)} tabs`
    )
  }
} finally {
  await app.quit()
  upstream.server.close()
}

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
