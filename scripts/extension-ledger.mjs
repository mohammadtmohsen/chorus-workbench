import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/*
 * The workbench pair every row below was proved against — Phase 5 slice 5g.
 *
 * A compatibility result is a statement about a *combination*: this client, this
 * server, these built-ins. Recording "Tailwind works" without saying which pair
 * it worked with is a claim that cannot be checked later and cannot be
 * invalidated when the pair moves — which is exactly what 5g's "move together or
 * not at all" is for. Read from the manifest rather than restated, so it cannot
 * drift from what the app actually ships.
 */
const runtime = JSON.parse(
  readFileSync(join('apps', 'desktop', 'build', 'workbench-runtime.json'), 'utf8')
)

/**
 * Generates the compatibility ledger plan §4 requires — one row per installed
 * extension id.
 *
 * **It fills in only what can be known without running anything**, and that
 * boundary is the point rather than a limitation. Identity, licence, declared
 * host kind and Open VSX availability are facts about a manifest and a registry;
 * install, activation, the golden action and the cross-platform result are facts
 * about a machine doing the thing, and §4 is explicit that
 * "extension installation works" is not the gate — activation and one
 * representative action are. So those four columns are emitted empty, for a
 * person to fill as each is actually proved.
 *
 * A generator rather than a hand-written table because the input moves: the list
 * is whatever `code --list-extensions` says today, and a ledger transcribed once
 * is wrong the first time somebody installs something.
 *
 *   node scripts/extension-ledger.mjs
 */

const EXTENSIONS_DIR = join(homedir(), '.vscode', 'extensions')
const OUT = join(
  'docs',
  'plans',
  'chorus-project-workbench-2026-08-22',
  'extension-ledger.md'
)

/**
 * Which extension host a manifest lands in, by §4's corrected rule.
 *
 * **Order decides, not membership.** The preflight corrected this in both
 * directions: being *capable* of running in a browser is not the same as landing
 * in the web host. GitLens, YAML and Error Lens all declare
 * `["workspace", "web"]` and, with a REH attached, run in the **Node host** —
 * their web build is only the no-remote fallback. What sends an extension to the
 * web host is declaring `ui` **first**.
 *
 * An absent `extensionKind` is not unknown: VS Code defaults it from the entry
 * points, `workspace` when there is a `main`, `ui` for a manifest with neither.
 */
function hostKind(manifest) {
  const declared = manifest.extensionKind
  if (Array.isArray(declared) && declared.length > 0) {
    return declared[0] === 'ui' ? 'web (ui first)' : `node (${declared.join(',')})`
  }
  if (typeof manifest.main === 'string') return 'node (implied by main)'
  if (typeof manifest.browser === 'string') return 'web (implied by browser)'
  return 'contribution-only'
}

/**
 * §4's four proof classes, which decide what evidence a row needs rather than
 * merely describing it.
 */
function proofClass(manifest) {
  if (typeof manifest.main !== 'string' && typeof manifest.browser !== 'string') {
    return 'contribution-only'
  }
  const kind = hostKind(manifest)
  if (kind.startsWith('web')) return 'browser-capable'
  return 'node-workspace'
}

function licence(dir, manifest) {
  const declared = manifest.license
  if (typeof declared === 'string' && declared.trim() !== '') return declared
  const file = readdirSync(dir).find((name) => /^licen[cs]e/i.test(name))
  return file === undefined ? 'unstated' : `see ${file}`
}

/**
 * Open VSX availability, asked of the registry rather than assumed.
 *
 * The registry answers 404 for a namespace it does not carry, which is the
 * single most common reason a Microsoft-adjacent extension cannot be used here —
 * and the one §4 wants named explicitly rather than discovered by a person
 * searching and finding nothing.
 */
async function openVsx(id) {
  const [namespace, name] = id.split('.')
  if (namespace === undefined || name === undefined) return { vsx: 'malformed id', by: '' }
  try {
    const response = await fetch(`https://open-vsx.org/api/${namespace}/${name}`)
    if (response.status === 404) return { vsx: 'absent', by: '' }
    if (!response.ok) return { vsx: `error ${String(response.status)}`, by: '' }
    const body = await response.json()
    /*
     * **`publishedBy` is the column that matters, not the version.** Many Open
     * VSX entries are built and pushed by the Eclipse Foundation's
     * `publish-extensions` bot from the vendor's public source, not uploaded by
     * the vendor. That is a different artifact with a different provenance from
     * the one on the Marketplace, and `verified: true` does not distinguish
     * them — it only says the namespace is claimed.
     *
     * It changes what "works" means for a row: a bot-built extension can lag the
     * vendor's release, omit a proprietary component, or be absent the next time
     * anyone looks.
     */
    const by = typeof body.publishedBy?.loginName === 'string' ? body.publishedBy.loginName : '?'
    return {
      vsx: typeof body.version === 'string' ? body.version : 'present',
      by: by === 'open-vsx' ? '**bot**' : by,
    }
  } catch (error) {
    return { vsx: `unreachable (${error instanceof Error ? error.message : String(error)})`, by: '' }
  }
}

const listed = execFileSync('code', ['--list-extensions', '--show-versions'], {
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .sort()

const rows = []
for (const entry of listed) {
  const at = entry.lastIndexOf('@')
  const id = entry.slice(0, at)
  const version = entry.slice(at + 1)
  /*
   * Resolved by prefix, because a **platform-specific** extension is unpacked as
   * `<id>-<version>-<platform>` rather than `<id>-<version>`.
   *
   * Matching the exact name missed four rows — Claude Code, ChatGPT, Docker and
   * Speech — and reported them as "manifest not found", which reads as a broken
   * install rather than as what it is. The suffix is itself the answer to this
   * ledger's **cross-platform** column: an extension shipped only as
   * `darwin-arm64` cannot pass on Windows or Linux by construction, and no
   * amount of testing here will discover that.
   */
  const prefix = `${id}-${version}`
  const match = readdirSync(EXTENSIONS_DIR).find(
    (name) => name === prefix || name.startsWith(`${prefix}-`)
  )
  const dir = match === undefined ? '' : join(EXTENSIONS_DIR, match)
  const manifestPath = dir === '' ? '' : join(dir, 'package.json')
  const platform = match === undefined ? '' : match.slice(prefix.length).replace(/^-/, '')

  if (manifestPath === '' || !existsSync(manifestPath)) {
    rows.push({ id, version, licence: '?', host: '?', klass: '?', vsx: 'manifest not found', by: '', platform: '' })
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  rows.push({
    id,
    version,
    licence: licence(dir, manifest),
    host: hostKind(manifest),
    klass: proofClass(manifest),
    platform,
    ...(await openVsx(id)),
  })
}

const header = `# Extension compatibility ledger

**Generated by \`scripts/extension-ledger.mjs\` — do not hand-edit the table's
first six columns.** They come from each extension's own manifest and from Open
VSX, and regenerating is how they stay true; the input changes the moment
somebody installs something.

**The last four columns are for a person, and they are the gate.** §4 is explicit
that "extension installation works" is not the bar: activation and one
representative action are. An empty cell means nobody has proved it, which is
different from a failure and must not be read as one.

**Every \`unavailable\` must name its blocker** — licence, registry absence,
proposed API, native dependency, product check, or missing workbench behaviour.

**One scope caveat that applies to every row — \`BOARD.md\` C-063.** Chorus runs
**one** REH with **one** extensions directory shared by every open project, so a
result here is proved under a per-server scope. If extensions ever become
per-project, these results do not transfer.

**The node-workspace class has a passing reference proof — 2026-08-24.**
\`apps/workbench-fixture\` is a three-file, no-build extension declaring
\`extensionKind: ["workspace"]\`. Installed into the REH's extensions directory
and opened in a project pane, it reported **PASS** on all four of its checks:
activation, Node host (not the web worker), a real directory read through Node's
own \`fs\` on the server, and a spawned process.

So for the ${String(rows.length)} rows the *class-level* capabilities are established —
the host exists, it sits on the project's files, and it can start processes. What
each row still needs is its own activation and one representative action, because
an extension can fail for reasons of its own inside a host that works.

**Ordering constraint from the preflight, for whoever fills this in.**
\`anthropic.claude-code\` and \`openai.chatgpt\` must **not** be the first
executable proofs. A proprietary, platform-specific SPA declaring proposed APIs
Code-OSS cannot grant fails with too many candidate causes to be worth anything.
Chorus-authored fixture extensions go first; those two run last, as the
known-working / known-failing control pair.

**Proved against — and a result is only about this pair.** Client
\`${runtime.client.package}@${runtime.client.version}\` (VS Code
\`${runtime.client.vscodeVersion}\`, commit \`${runtime.client.vscodeCommit.slice(0, 12)}\`) ·
server \`${runtime.server.vendor}\` \`${runtime.server.release}\`. When either moves,
every filled cell below is provisional until re-proved: \`pnpm check\` fails if the
manifest and the installed packages disagree, which is what keeps that honest.

Generated ${new Date().toISOString().slice(0, 10)} · ${String(rows.length)} extensions

| id | installed | licence | host kind | class | Open VSX | published by | install | activation | golden action | cross-platform | status |
| -- | --------- | ------- | --------- | ----- | -------- | ------------ | ------- | ---------- | ------------- | -------------- | ------ |
`

const table = rows
  .map(
    (r) =>
      `| \`${r.id}\` | ${r.version}${r.platform === '' ? '' : ` **${r.platform}**`} | ${r.licence} | ${r.host} | ${r.klass} | ${r.vsx} | ${r.by} | | | | |`
  )
  .join('\n')

const counts = rows.reduce((acc, r) => ({ ...acc, [r.klass]: (acc[r.klass] ?? 0) + 1 }), {})
const absent = rows.filter((r) => r.vsx === 'absent').length

const summary = `

## What the generated columns already say

- **${String(rows.length)} extensions**, by proof class: ${Object.entries(counts)
  .map(([k, n]) => `${k} ${String(n)}`)
  .join(' · ')}.
- **${String(absent)} are absent from Open VSX**, which is a blocker discoverable
  without running anything and is the first column worth reading.
`

writeFileSync(OUT, header + table + summary)
process.stdout.write(`${OUT}: ${String(rows.length)} rows, ${String(absent)} absent from Open VSX\n`)
