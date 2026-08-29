#!/usr/bin/env node
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regenerates `apps/desktop/build/workbench-runtime.json` — preflight §4.2's row
 * for this file, and §3.5's manifest.
 *
 * Run by a person, output committed. Not in CI, and it downloads no artifact:
 * everything below is either already on disk or is metadata measured in bytes.
 *
 * **Three sources, and not one of them is the tarball.** That is the correction
 * review round 3 forced and it is the whole design:
 *
 *  1. **The client's compiled product module**, for `vscodeVersion` /
 *     `vscodeCommit`. Not `package.json` — the published package has no `config`
 *     field at all, it exists only in the source repository at the tag, and a
 *     test written against it fails on `undefined` at every run. The module that
 *     ships is what the client actually presents in the handshake.
 *  2. **The VSCodium release API**, for asset names and sizes, plus each asset's
 *     published `.sha256` sibling. The checksum is what makes the manifest an
 *     assertion about bytes rather than a pointer at a URL, because a release
 *     asset can be replaced.
 *  3. **`upstream/stable.json` at the release tag**, for `upstreamTag` and
 *     `upstreamCommit`. This is the *only* published join between a VSCodium
 *     release and a VS Code commit: the artifact itself names neither, because
 *     the REH build writes only `{ commit, date, version }` and VSCodium sets
 *     that commit to a sha1 of its own version string.
 *
 * A platform absent from `server.artifacts` is an unsupported target, stated
 * here rather than discovered at runtime — which is where `win32-arm64` lives,
 * since VSCodium has never published one.
 *
 * Usage: `node scripts/workbench-manifest.mjs [<vscodium-release-tag>]`
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT = join(REPO, 'apps/desktop/build/workbench-runtime.json')

/*
 * The release tag is the first positional, and flags are filtered out first.
 * `--check` was being read as a tag and fetched as a git ref, which fails as a
 * 404 against VSCodium rather than as a usage error.
 */
const ARGS = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const CHECK = process.argv.includes('--check')
const RELEASE = ARGS[0] ?? '1.121.03429'

/** The targets Phase 1 names. `win32-arm64` is absent because the artifact is. */
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']

const require = createRequire(join(REPO, 'apps/desktop/package.json'))

/**
 * The client's identity, read out of the module that ships rather than out of a
 * manifest field that does not.
 *
 * Read as text and matched, rather than imported. The module is ESM whose first
 * line imports `product.json.js`, so importing it from a plain Node script drags
 * in a resolution problem that has nothing to do with the two strings wanted
 * here — and §3.5 names reading the same file as text as the acceptable
 * substitute. What is not acceptable is reading `package.json`.
 */
function readClientIdentity() {
  /*
   * The export-map subpath, not the path inside the tarball — that distinction
   * cost review round 3 a correction of its own. The published map is
   * `"./vscode/*" → "./vscode/src/*.js"`, so the pattern already supplies both
   * `src/` and the extension; writing either of them here doubles it and Node
   * raises `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than anything that names the
   * mistake.
   *
   * And `require.resolve('…/package.json')` is not available either: the same
   * wildcard catches it and resolves to `package.json.js`, which does not exist.
   * So the package root is derived from the module's own location.
   */
  const module =
    require.resolve('@codingame/monaco-vscode-api/vscode/vs/platform/product/common/product')
  const root = module.slice(0, module.indexOf(`${'/vscode/src/'}`))
  const entry = join(root, 'package.json')
  const source = readFileSync(module, 'utf8')

  const commit = /commit:\s*'([0-9a-f]{40})'/.exec(source)?.[1]
  const version = /version:\s*'([^']+)'/.exec(source)?.[1]
  const quality = /quality:\s*'([^']+)'/.exec(source)?.[1]
  if (commit === undefined || version === undefined || quality === undefined) {
    throw new Error(`Could not read the client's identity out of ${module}`)
  }
  return {
    package: '@codingame/monaco-vscode-api',
    version: JSON.parse(readFileSync(entry, 'utf8')).version,
    vscodeVersion: version,
    vscodeCommit: commit,
    quality,
  }
}

async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.json()
}

async function text(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return response.text()
}

async function main() {
  const client = readClientIdentity()

  const upstream = await json(
    `https://raw.githubusercontent.com/VSCodium/vscodium/${RELEASE}/upstream/stable.json`
  )
  const release = await json(
    `https://api.github.com/repos/VSCodium/vscodium/releases/tags/${RELEASE}`
  )

  const artifacts = {}
  for (const target of TARGETS) {
    const name = `vscodium-reh-${target}-${RELEASE}.tar.gz`
    const asset = release.assets.find((a) => a.name === name)
    if (asset === undefined) {
      process.stderr.write(`  no asset published for ${target} — omitted, which is the statement\n`)
      continue
    }
    const sibling = release.assets.find((a) => a.name === `${name}.sha256`)
    if (sibling === undefined) throw new Error(`no published .sha256 for ${name}`)
    const published = await text(sibling.browser_download_url)
    const sha256 = /^([0-9a-f]{64})\b/.exec(published.trim())?.[1]
    if (sha256 === undefined) throw new Error(`unreadable .sha256 for ${name}: ${published}`)
    artifacts[target] = { name, size: asset.size, sha256 }
    process.stderr.write(`  ${target}  ${asset.size} B  ${sha256}\n`)
  }

  /*
   * The invariant, asserted here as well as in the test, because a generator that
   * can emit a manifest the test then rejects has only moved the failure.
   */
  if (client.vscodeCommit !== upstream.commit) {
    throw new Error(
      `client ${client.version} is VS Code ${client.vscodeCommit}, VSCodium ${RELEASE} is ${upstream.commit} — not a matched pair`
    )
  }

  const manifest = {
    $comment:
      'Generated by scripts/workbench-manifest.mjs. Never hand-edited. A platform absent from server.artifacts is an unsupported target.',
    client,
    server: {
      vendor: 'vscodium',
      release: RELEASE,
      upstreamTag: upstream.tag,
      upstreamCommit: upstream.commit,
      artifacts,
    },
    /*
     * Recorded because §3.5 step 3 requires the extractor to be named and
     * pinned. The answer here is not a pinned `node-tar`: containment is checked
     * against the archive's own headers by `main/workbench-archive.ts`, and only
     * the writing of files is delegated to the system tool. That is a stronger
     * reading of "validate independently rather than delegating the invariant"
     * than pinning a library and trusting it would have been, and it is why
     * CVE-2026-23745's shape — an unsanitised `linkpath` in the default
     * configuration — cannot recur here.
     */
    extraction: {
      validator: 'apps/desktop/src/main/workbench-archive.ts',
      extractor: 'system tar',
      rejects: ['absolute paths', '.. traversal', 'links whose resolved target escapes the root'],
    },
  }

  const rendered = `${JSON.stringify(manifest, null, 2)}\n`

  /*
   * `--check` is Phase 5 slice 5g's half of "move together or not at all".
   *
   * The manifest binds the four things that must not drift apart: the client
   * packages, the REH artifacts and their checksums, the built-ins that ride
   * inside those artifacts, and the commit both halves must agree on. Generating
   * it was never the weak point — **nothing verified the checked-in copy still
   * matched the installed tree.** Bump `@codingame/monaco-vscode-api` without
   * regenerating and the file goes stale in silence.
   *
   * `assertClientMatchesServer` does catch it, but at the wrong time and on the
   * wrong machine: at the moment a person opens a project, one surface at a
   * time, on whoever's laptop happens to run it. This fails in the gate, on the
   * change that caused it.
   *
   * Compared by rendered text rather than field by field, deliberately. A
   * field-wise comparison has to be extended every time the manifest grows a
   * key, and the one that gets forgotten is the one that then drifts unwatched.
   */
  if (CHECK) {
    const existing = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (existing === rendered) {
      process.stderr.write(`${OUT} is up to date\n`)
      return
    }
    process.stderr.write(
      `${OUT} is stale — the installed workbench packages no longer match it.\n` +
        `Run: node scripts/workbench-manifest.mjs\n`
    )
    process.exitCode = 1
    return
  }

  writeFileSync(OUT, rendered)
  process.stderr.write(`\nwrote ${OUT}\n`)
}

await main()
