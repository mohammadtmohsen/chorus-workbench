'use strict'

/**
 * The first executable extension proof — plan §4, Phase 5.
 *
 * **Why a Chorus-authored fixture goes first.** The preflight is explicit that
 * neither installed AI extension may be the first proof: a proprietary,
 * platform-specific SPA declaring proposed APIs Code-OSS cannot grant fails with
 * too many candidate causes to be worth anything. A failure has to name one
 * thing. This extension is the smallest thing that can fail for exactly one
 * reason at a time.
 *
 * **No build step, on purpose.** Plain CommonJS, no TypeScript, no bundler, no
 * dependencies. Every layer between the source and the host is a layer that can
 * be blamed when the proof fails — and the whole value of a fixture is that when
 * it does not activate, the extension host is the only remaining suspect.
 *
 * **What it proves, in the order §4 asks for the node-workspace class:**
 *
 *  1. **Activation** — `activate` ran at all.
 *  2. **Host** — that it is the *remote* Node host and not the browser worker.
 *     `process.versions.node` exists only in the Node host; `env.remoteName`
 *     names the connection. An extension declaring `["workspace"]` that answers
 *     "web" here means the host resolution is wrong, which is a Phase 1 claim.
 *  3. **Filesystem** — reads a real directory entry from the project root with
 *     Node's own `fs`, not the workbench's file service. The file service would
 *     prove the *client* can see files through the REH; this proves the
 *     extension host process is genuinely sitting on that filesystem.
 *  4. **Process** — spawns one and reads its output, which is the capability a
 *     pipe cannot fake and the one ESLint, Docker and the rest all depend on.
 *
 * Every result is written to an output channel and mirrored into a status bar
 * item, so a person and a driver can both read it without either being told
 * where to look.
 */

const vscode = require('vscode')
const { execFile } = require('node:child_process')
const { readdir } = require('node:fs/promises')

/** Kept module-level so the command can re-show it without re-running anything. */
let report = 'not yet run'

async function build() {
  const lines = []
  const check = (name, ok, detail) => {
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    return ok
  }

  check('activate', true, `extension host reached ${new Date().toISOString()}`)

  /*
   * Node rather than the web worker. `process` is absent in the worker host, so
   * the optional chaining is not defensive style — it is the test.
   */
  const nodeVersion = typeof process === 'undefined' ? undefined : process.versions?.node
  check(
    'node host',
    nodeVersion !== undefined,
    nodeVersion ?? 'no process global — web worker host'
  )
  check(
    'remote',
    vscode.env.remoteName !== undefined,
    vscode.env.remoteName ?? 'undefined — running locally, not through the REH'
  )

  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder === undefined) {
    check('filesystem', false, 'no workspace folder')
  } else {
    /*
     * `folder.uri.fsPath` rather than the URI: in the Node host on the server the
     * remote path *is* a local path, and that equivalence is the thing being
     * proved. If this throws, the host is not where the files are.
     */
    try {
      const entries = await readdir(folder.uri.fsPath)
      check('filesystem', entries.length > 0, `${folder.uri.fsPath} — ${entries.length} entries`)
    } catch (error) {
      check('filesystem', false, `${folder.uri.fsPath} — ${String(error)}`)
    }
  }

  try {
    const output = await new Promise((resolve, reject) => {
      execFile('node', ['--version'], { timeout: 10_000 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout.trim())
      })
    })
    check('process', output.startsWith('v'), `node --version → ${output}`)
  } catch (error) {
    check('process', false, String(error))
  }

  return lines.join('\n')
}

async function activate(context) {
  const channel = vscode.window.createOutputChannel('Chorus Fixture')
  context.subscriptions.push(channel)

  report = await build()
  channel.appendLine(report)

  const failed = report.includes('FAIL')
  /*
   * The status bar because it is the one surface visible without being opened.
   * A proof nobody can see without knowing which panel to open is a proof that
   * gets reported as "nothing happened".
   */
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
  item.text = failed ? '$(error) Fixture: FAIL' : '$(check) Fixture: PASS'
  item.tooltip = report
  item.command = 'chorusFixture.report'
  item.show()
  context.subscriptions.push(item)

  context.subscriptions.push(
    vscode.commands.registerCommand('chorusFixture.report', () => {
      channel.clear()
      channel.appendLine(report)
      channel.show(true)
    })
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
