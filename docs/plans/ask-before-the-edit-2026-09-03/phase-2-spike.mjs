import { ensureBuilt, launch, wait } from '../../../apps/desktop/e2e/harness.mjs'

/**
 * Phase 2 spike: can a diff editor open with **both sides synthetic**?
 *
 * The ask-before-the-edit tab needs that and nothing less — the proposed content
 * does not exist on disk and must never be written there, and the workspace is
 * addressed on `vscode-remote:`, so a `file:` original is not something this
 * build is known to resolve.
 *
 * The work happens inside the *surface* document, not the shell: only that page
 * can reach `getService`. So the operation lives on `__chorusGate`, which is
 * installed only under the E2E trust waiver, and this script attaches to the
 * surface's own CDP target rather than the shell's.
 *
 * Needs a person: adding a project and turning the editor on are native-dialog
 * and pointer work that CDP cannot do.
 */

// Without this the harness drives whatever is already in `out/` — which is how
// the first run reported the gate installed but the spike missing.
ensureBuilt()

const PROJECT = process.env.SPIKE_PROJECT ?? '/Users/mohamadtaleb/code/chorus-review-demo'

const app = await launch({ keepData: false, env: { CHORUS_WORKBENCH_E2E_ROOTS: PROJECT } })

/** The surface is its own page; the harness socket only ever addresses the shell. */
async function workbenchTarget() {
  const response = await fetch(`http://127.0.0.1:${String(app.debugPort)}/json/list`)
  const targets = await response.json()
  /*
   * Matched on the document, not the title. The shell's title is "Chorus
   * Workbench", so anything matching /workbench/ across url+title finds the
   * shell first — which is the page that has no `getService` and no gate.
   */
  return targets.find((t) => t.type === 'page' && String(t.url).includes('workbench.html'))
}

/** A one-shot CDP eval against a page that is not the shell. */
async function evaluateIn(target, expression) {
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the surface did not answer in 30s'))
    }, 30_000)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timer)
      resolve(message.result)
    })
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      })
    )
  })
  socket.close()
  if (result?.exceptionDetails !== undefined) {
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
  }
  return result?.result?.value
}

try {
  await app.until('window.chorus !== undefined', { label: 'preload ready' })
  console.log(`\n>>> 1. Add the project ${PROJECT}`)
  console.log('>>> 2. Turn the editor on for it, so a workbench surface exists.')
  console.log('>>> Waiting up to 10 minutes…\n')

  let target
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    target = await workbenchTarget().catch(() => undefined)
    if (target !== undefined) break
    await wait(3_000)
  }
  if (target === undefined) throw new Error('no workbench surface ever appeared')
  console.log('surface:', target.url.slice(0, 80))

  const hasGate = await evaluateIn(target, 'typeof window.__chorusGate')
  console.log('__chorusGate:', hasGate)
  if (hasGate !== 'object') {
    throw new Error('the gate handle is not installed — trust waiver missing?')
  }

  console.log('askSpike:', await evaluateIn(target, 'window.__chorusGate.askSpike()'))
  console.log('\n>>> Look at the window: is there a diff tab titled "[spike] greeting.txt",')
  console.log('>>> showing beta on the left and BETA on the right? Leaving it open 60s.')
  await wait(60_000)
} catch (error) {
  console.log('\nFAILED:', error instanceof Error ? error.message : String(error))
  console.log('\napp said:\n', app.output().slice(-1500))
} finally {
  await app.quit()
}
