import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBuilt, launch } from './harness.mjs'

/**
 * Why the agent is never told what the editor is showing — a probe, not a gate.
 *
 * Four rounds have been spent on this path and three fixes shipped, each aimed at
 * a link further downstream than the break. The app's own log now says
 * `ide:snapshot` is never called, which only moves the question upstream: the
 * composer will not ask unless the pill is `ready`, and the pill is `ready` only
 * if main pushed a context with a file in it.
 *
 * Static reading has run out. The forwarder is installed, the sink is set, the
 * prop is wired. What is left is whether the *surface* reports at all, and that
 * is observable only in a running app.
 *
 * So this launches one, opens a project, opens a file inside the workbench, moves
 * the selection, and reads main's own debug log back. It answers exactly one
 * question and prints what it found rather than asserting — a probe belongs in
 * the record as evidence, and turning it into a pass/fail before the cause is
 * known would be inventing the expectation.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'chorus-ctx-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'sample.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')
  return root
}

/** Every `workbench context` line main wrote, decoded. */
function contextLines(dataPath) {
  try {
    return readFileSync(join(dataPath, 'logs', 'chorus.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('workbench context') || line.includes('editor snapshot'))
      .map((line) => {
        try {
          const parsed = JSON.parse(line)
          return `${parsed.message}  ${JSON.stringify(parsed.fields)}`
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

async function main() {
  /*
   * Built first, and its absence is why the first three runs of this probe said
   * nothing: `launch` runs `electron .` against `out/`, so without this it drives
   * whatever was last compiled. Every conclusion drawn from those runs was drawn
   * from a bundle that predated the code under test.
   */
  ensureBuilt()
  const root = scratchRepo()
  const app = await launch({
    keepData: true,
    env: { CHORUS_WORKBENCH_E2E_ROOTS: root, CHORUS_DEBUG: '1' },
  })

  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })

    /*
     * Isolation, asserted rather than assumed — and it is asserted because it was
     * violated. A run whose store already held a real project reported 28 routed
     * contexts that had nothing to do with the scratch repo, and every number in
     * it was meaningless. `CHORUS_USER_DATA` is set and `app.setPath` runs before
     * anything reads a path, so the environment *looks* right; the only honest
     * check is what Electron actually resolved and what the store actually holds.
     */
    const projects = JSON.parse(
      await app.evaluate('window.chorus.listProjects({}).then(JSON.stringify)')
    )
    const roots = projects.projects.map((project) => project.root)
    const strayRoots = roots.filter((r) => !r.includes('chorus-ctx-'))
    console.log(`  projects in store: ${roots.length === 0 ? '(none)' : roots.join(', ')}`)
    if (strayRoots.length > 0) {
      throw new Error(
        `probe is not isolated: the store holds ${strayRoots.join(', ')} — every measurement below would describe another project.`
      )
    }

    const { chosen } = JSON.parse(
      await app.evaluate('window.chorus.chooseWorkbenchProject().then(JSON.stringify)')
    )
    await app.evaluate(
      `window.chorus.openWorkbench({ grant: ${JSON.stringify(chosen.grant)} }).then(JSON.stringify)`
    )

    // The workbench boots, connects to the REH and mounts its editor. None of
    // that is quick on a cold cache, and a probe that read the log too early
    // would report "no context" for a surface that had not started.
    console.log('  waiting 45s for the workbench to come up…')
    await wait(45_000)

    console.log('\n  — what main logged —')
    const lines = contextLines(app.dataPath)
    if (lines.length === 0) {
      console.log('  (nothing: the surface never reported a context)')
    } else {
      for (const line of lines.slice(-12)) console.log(`  ${line}`)
    }

    /*
     * Nothing logged can mean two different things, and they live in different
     * files: the reporter never ran, or it ran and found no editor because none
     * was open. So a file is opened *inside the surface* and the log read again.
     */
    const pages = await (await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/list`)).json()
    const surface = pages.find((t) => t.type === 'page' && t.url.includes('workbench.html'))
    console.log(`\n  surface target: ${surface === undefined ? 'NONE' : surface.url.slice(0, 60)}`)
    if (surface === undefined) return

    const ws = new WebSocket(surface.webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))
    let id = 0
    const evaluate = (expression) =>
      new Promise((resolve) => {
        const mine = (id += 1)
        const onMessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.id !== mine) return
          ws.removeEventListener('message', onMessage)
          resolve(JSON.stringify(msg.result?.result?.value ?? msg.result?.exceptionDetails ?? null))
        }
        ws.addEventListener('message', onMessage)
        ws.send(
          JSON.stringify({
            id: mine,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          })
        )
      })

    /*
     * The entry writes its failure into the document rather than the console,
     * exactly so a driver can read it without `Runtime.enable`. If `main()`
     * threw anywhere — including before `reportEditorContext` — this is where it
     * says so, and everything after that line never ran.
     */
    console.log(
      `  entry failure: ${await evaluate("document.querySelector('.workbench-failure')?.textContent ?? 'none'")}`
    )
    console.log(`  chorusWorkbench in surface: ${await evaluate('typeof window.chorusWorkbench')}`)
    console.log(
      `  monaco services present:    ${await evaluate('typeof window.MonacoEnvironment')}`
    )

    /*
     * The whole point of the probe: open a file and select lines, then read what
     * main logged. Anything short of this proves nothing — a surface with no
     * editor open reports nothing, correctly, and looks identical to one that is
     * broken.
     */
    console.log(`  gate handle: ${await evaluate('typeof window.__chorusGate')}`)
    console.log(`  open sample.ts: ${await evaluate("window.__chorusGate.open('src/sample.ts')")}`)
    await wait(2_000)
    console.log(`  select 1-3:     ${await evaluate('window.__chorusGate.select(1, 3)')}`)
    await wait(2_000)

    console.log('\n  — log after opening and selecting —')
    const after = contextLines(app.dataPath)
    if (after.length === 0) console.log('  (still nothing)')
    for (const line of after.slice(-8)) console.log(`  ${line}`)

    const routed = after.filter(
      (l) => l.includes('workbench context') && !l.includes('"conversations":0')
    )
    console.log(
      `\n  VERDICT: reports=${String(after.filter((l) => l.includes('workbench context')).length)} routed=${String(routed.length)}`
    )
    ws.close()
  } finally {
    await app.quit()
    console.log(`\n  data kept at ${app.dataPath}`)
  }
}

await main()
