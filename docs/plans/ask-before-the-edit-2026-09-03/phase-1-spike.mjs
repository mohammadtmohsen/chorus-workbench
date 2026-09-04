import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * Phase 1 spike for `docs/plans/ask-before-the-edit-2026-09-03/plan.md`.
 *
 * One question: **can Chorus force the provider to call `canUseTool` for an
 * edit, and can it stop and restart that mid-session?** Everything the plan
 * promises rests on the answer.
 *
 * **It reads the real user configuration, deliberately.** `CLAUDE_CONFIG_DIR`
 * isolates credentials along with settings, so an isolated run is an
 * unauthenticated one — the first attempt failed with *"Not logged in"*. It
 * therefore **writes nothing** to that configuration; every case only *adds*
 * layers at query time. What it reads is printed first, because a result is
 * uninterpretable without knowing the tiers underneath it. It also loads the
 * user's real hooks and MCP servers, for the same reason.
 *
 * Portable: the project and its file are created here, and the CLI is located
 * rather than hardcoded (`CLAUDE_CLI` overrides).
 *
 * Run: `node ask-spike.mjs` from `packages/adapter-claude`.
 */

const PROJ = join(tmpdir(), `ask-spike-${String(process.pid)}`)
const FILE = join(PROJ, 'greeting.txt')
const ORIGINAL = 'hello world\nsecond line\nthird line\n'

const cli = (() => {
  if (process.env.CLAUDE_CLI !== undefined) return process.env.CLAUDE_CLI
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
})()
if (cli === undefined) {
  console.error('no `claude` on PATH; set CLAUDE_CLI=/path/to/claude')
  process.exit(1)
}

/** The tiers underneath every result below. Printed, never modified. */
function reportBaseline() {
  const path = join(process.env.HOME ?? '', '.claude', 'settings.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const permissions = parsed.permissions ?? {}
    const allow = permissions.allow ?? []
    const edits = allow.filter((rule) =>
      ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(rule).split('(')[0])
    )
    console.log('user settings — allow entries:', allow.length)
    console.log('user settings — edit-tool allows:', JSON.stringify(edits))
    console.log('user settings — defaultMode:', permissions.defaultMode ?? '<unset>')
  } catch {
    console.log('user settings — unreadable or absent')
  }
  console.log('cli:', cli, '\n')
}

const ASK_EDITS = { permissions: { ask: ['Edit', 'Write'] } }
const reset = () => {
  mkdirSync(PROJ, { recursive: true })
  writeFileSync(FILE, ORIGINAL, 'utf8')
}
const landed = () => readFileSync(FILE, 'utf8') !== ORIGINAL

const EDIT = `Use the Edit tool to change "second" to "SECOND" in ${FILE}. Do not read it first. Then stop.`
const REVERT = `Use the Edit tool to change "SECOND" back to "second" in ${FILE}. Do not read it first. Then stop.`

/** One-shot cases: what holds at session start. */
async function startupCase(name, options) {
  reset()
  let asked = 0
  let failure = null
  try {
    for await (const message of query({
      prompt: EDIT,
      options: {
        cwd: PROJ,
        permissionMode: 'default',
        pathToClaudeCodeExecutable: cli,
        ...options,
        canUseTool: (tool, input) => {
          if (tool === 'Edit' || tool === 'Write') asked += 1
          return Promise.resolve({ behavior: 'allow', updatedInput: input })
        },
      },
    })) {
      void message
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  console.log(
    `${name} canUseTool: ${String(asked)}   landed: ${String(landed())}` +
      (failure === null ? '' : `\n   FAILED: ${failure.slice(0, 200)}`)
  )
}

/**
 * The live sequence, which one-shot calls cannot reach.
 *
 * `applyFlagSettings` and `setPermissionMode` are control requests, and control
 * requests need streaming input — so the prompt is an async generator held open
 * between turns and fed one message at a time.
 */
async function liveSequence() {
  reset()
  console.log('\n--- live transitions, one session ---')

  const queued = []
  let waiting = null
  const send = (text) => {
    const value =
      text === null
        ? null
        : {
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text }] },
            parent_tool_use_id: null,
            session_id: '',
          }
    if (waiting !== null) {
      const resolve = waiting
      waiting = null
      resolve(value)
    } else queued.push(value)
  }

  async function* input() {
    for (;;) {
      const next =
        queued.length > 0
          ? queued.shift()
          : await new Promise((resolve) => {
              waiting = resolve
            })
      if (next === null) return
      yield next
    }
  }

  let asked = 0
  const q = query({
    prompt: input(),
    options: {
      cwd: PROJ,
      permissionMode: 'default',
      pathToClaudeCodeExecutable: cli,
      settings: ASK_EDITS,
      canUseTool: (tool, toolInput) => {
        if (tool === 'Edit' || tool === 'Write') asked += 1
        return Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
      },
    },
  })

  /*
   * The stream is consumed once, in the background, and never broken out of.
   *
   * `break`ing a `for await` calls the iterator's `return()`, which tears the
   * transport down — the first attempt died on the next control request with
   * "ProcessTransport is not ready for writing". So a single loop runs for the
   * life of the session and resolves one deferred per `result`.
   */
  let turnDone = null
  const pump = (async () => {
    for await (const message of q) {
      if (message.type === 'result' && turnDone !== null) {
        const resolve = turnDone
        turnDone = null
        resolve()
      }
    }
  })()

  const turn = async (label, text) => {
    const before = asked
    const finished = new Promise((resolve) => {
      turnDone = resolve
    })
    send(text)
    await finished
    console.log(`   ${label} canUseTool: ${String(asked - before)}`)
  }

  try {
    await turn('a. flag ask, mode default             ', EDIT)

    await q.setPermissionMode('acceptEdits')
    await turn('b. + acceptEdits, flag still on       ', REVERT)

    await q.applyFlagSettings({ permissions: null })
    await turn('c. flag cleared, still acceptEdits    ', EDIT)

    await q.applyFlagSettings(ASK_EDITS)
    await turn('d. flag reinstalled, still acceptEdits', REVERT)

    await q.setPermissionMode('default')
    await turn('e. back to default, flag on           ', EDIT)
  } catch (error) {
    console.log('   FAILED:', error instanceof Error ? error.message : String(error))
  } finally {
    send(null)
    await pump.catch(() => undefined)
  }
}

reportBaseline()
await startupCase('1. user config as-is, mode default        ', {})
await startupCase('2. + flag-layer ask                       ', { settings: ASK_EDITS })
await startupCase('3. flag ask + acceptEdits at start        ', {
  settings: ASK_EDITS,
  permissionMode: 'acceptEdits',
})
await startupCase('4. acceptEdits, no flag layer             ', { permissionMode: 'acceptEdits' })
await startupCase('5. managedSettings ask                    ', { managedSettings: ASK_EDITS })
await liveSequence()

rmSync(PROJ, { recursive: true, force: true })
process.exit(0)
