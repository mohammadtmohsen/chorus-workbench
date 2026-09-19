import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnSpec } from './command.js'
import { resolveCommand } from './which.js'

const run = promisify(execFile)

/**
 * What the user's plugins are, and whether they are switched on.
 *
 * Plugins load into every session the same way MCP servers and skills do — they
 * contribute commands, agents and hooks that an agent has and Chorus never
 * mentions. A disabled one is the interesting case, for the same reason
 * `needs-auth` is on a server: it is configured, believed in, and contributing
 * nothing.
 *
 * Shelled out to `claude plugin list --json` rather than read from
 * `~/.claude/plugins/*.json`, which the plan called the more honest of the two —
 * `--json` is a stated machine interface, and the directory layout is not.
 *
 * Deliberately not `claude plugin details`, which prints a component inventory
 * and a projected token cost and has **no `--json`**. Scraping a formatted
 * table to put numbers on screen is the private-format commitment this project
 * declined for checkpoints, and the failure mode is silently wrong figures
 * rather than an error.
 */

export interface PluginInfo {
  /** `name@marketplace`, which is how the CLI identifies it. */
  readonly id: string
  /** The bare name, which is what a person calls it. */
  readonly name: string
  readonly enabled: boolean
  /** `user`, `project`, `local` — where it was installed from. */
  readonly scope: string
  /** Absent when the CLI reports it as "unknown", which it often does. */
  readonly version?: string
}

/** Long enough for a cold CLI start, short enough not to hang the sheet. */
const TIMEOUT_MS = 10_000

export async function listPlugins(): Promise<PluginInfo[]> {
  const claude = await resolveCommand('claude')
  if (claude === null) return []

  try {
    const { file, args } = spawnSpec(claude, ['plugin', 'list', '--json'])
    const { stdout } = await run(file, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return parsePlugins(stdout)
  } catch {
    // No claude, a version too old to have the subcommand, or a machine with no
    // plugins at all. All three mean the same to the caller: nothing to show.
    return []
  }
}

/**
 * The skills Chorus can install, and what the CLI calls each one.
 *
 * **A closed set, for the same reason `SecretId` is one.** This is reachable
 * from a renderer, and a channel that took a marketplace source and a plugin
 * name would let anything that can talk to it install arbitrary code from
 * arbitrary GitHub repositories into the user's `~/.claude`. Naming the one
 * skill Chorus offers means there is no such thing as asking for another.
 */
const INSTALLABLE = {
  typesafe: { marketplace: 'typesafe-ai/skills', plugin: 'typesafe@typesafe-ai' },
} as const

export type InstallableSkill = keyof typeof INSTALLABLE

/**
 * `detail` is the CLI's own words, which is why it is not a translation key.
 *
 * **`unconfirmed` is a separate state from `failed` because the evidence is
 * different.** `listPlugins` answers `[]` on a timeout as readily as on an empty
 * machine, so "the plugin is not in the list" is not the same claim as "the
 * install failed" — and asserting the second when nothing was observed is the
 * confident-and-wrong shape this file exists to avoid.
 */
export type InstallOutcome =
  | { readonly state: 'installed' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'unconfirmed' }
  | { readonly state: 'failed'; readonly detail: string }

/** Long enough for a marketplace fetch and an install, both over the network. */
const INSTALL_TIMEOUT_MS = 60_000

/**
 * Installs a skill through the user's own `claude`, and then goes and looks.
 *
 * **Two commands, because the marketplace has to be added before the plugin
 * resolves.** Both are safe to run twice: re-adding a marketplace and
 * re-installing a plugin are how the CLI is asked to update them.
 *
 * **The answer is observed rather than inferred from an exit code.** A non-zero
 * exit can mean "already added", and a zero exit is not evidence the plugin is
 * there — so whichever way the commands go, the result is whether the plugin is
 * in `claude plugin list` afterwards. An exit code is the proxy; the list is the
 * thing.
 *
 * **Only the `claude` route.** `claude plugin install` defaults to user scope,
 * and DeepSeek shares `~/.claude`, so this covers two of the three agents. Codex
 * would need `npx skills add`, which installs through a package runner Chorus
 * does not control and — more to the point — has no list command, so its result
 * could only be inferred from an exit code. That is the thing this function
 * refuses to do.
 */
export async function installSkill(skill: InstallableSkill): Promise<InstallOutcome> {
  const target = INSTALLABLE[skill]
  const claude = await resolveCommand('claude')
  if (claude === null) return { state: 'unavailable' }

  let trouble = ''
  for (const args of [
    ['plugin', 'marketplace', 'add', target.marketplace],
    ['plugin', 'install', target.plugin],
  ]) {
    try {
      const { file, args: argv } = spawnSpec(claude, args)
      await run(file, argv, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    } catch (error) {
      /*
       * Caught per command rather than around the pair, because `execFile`
       * rejects on a non-zero exit and adding a marketplace that is already
       * there exits non-zero. Wrapping both in one `try` meant the second press
       * of the button skipped the install it was pressed for — the abort
       * happening in exactly the case the rest of this comment calls benign.
       *
       * The last message wins, not the first: the only path that shows this text
       * is one where the plugin is absent afterwards, and there it is the
       * install step rather than the marketplace step that explains why.
       */
      trouble = error instanceof Error ? error.message : String(error)
    }
  }

  const present = (await listPlugins()).some((plugin) => plugin.id === target.plugin)
  if (present) return { state: 'installed' }
  return trouble === '' ? { state: 'unconfirmed' } : { state: 'failed', detail: trouble }
}

/**
 * Exported for tests, because this is the half that can be wrong.
 *
 * Every field is checked rather than trusted. The command is another program's
 * output, and a release that renames a key should cost the panel a row, not
 * throw inside the settings sheet.
 */
export function parsePlugins(stdout: string): PluginInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((entry): PluginInfo[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    if (id === '') return []

    const version = typeof row['version'] === 'string' ? row['version'] : ''
    return [
      {
        id,
        // `name@marketplace` — the marketplace is noise in a list of what you
        // have, and the id is kept for anything that needs to address it.
        name: id.split('@')[0] ?? id,
        // Absent rather than false when the key is missing: a plugin the CLI
        // did not describe is not a plugin we should draw as switched off.
        enabled: row['enabled'] !== false,
        scope: typeof row['scope'] === 'string' ? row['scope'] : '',
        // The CLI says "unknown" more often than it says a version, and a row
        // reading "unknown" is worse than one that says nothing.
        ...(version === '' || version === 'unknown' ? {} : { version }),
      },
    ]
  })
}
