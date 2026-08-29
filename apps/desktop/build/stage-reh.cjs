'use strict'

/**
 * Puts the right remote-extension-host archive inside the app before it is
 * packed, so a first launch does not need the network.
 *
 * **Why a hook and not an `extraResources` pattern.** The archive is named per
 * platform *and* per architecture — `vscodium-reh-darwin-arm64-1.121.03429.tar.gz`
 * — and the release segment comes from the manifest rather than from anything
 * electron-builder knows. Expressing that as a `from:` glob would mean guessing
 * which of its filename macros expand where, and a glob that matches nothing
 * **succeeds**: the app would ship without a server and the fault would surface
 * on a stranger's first launch as a silent fall back to downloading. A hook is
 * handed the arch, so it can fail loudly instead.
 *
 * **It stages to a fixed path** — `build/reh/workbench-server.tar.gz` — which
 * `electron-builder.yml` ships under a fixed name. The host therefore looks for
 * one path and never has to reconstruct a filename from a platform triple.
 *
 * **The cache is shared with the running app on purpose.** Same directory
 * `workbench-host.ts` uses, keyed off `appData`, so a developer who has already
 * run Chorus does not download 76 MB again to build it, and a CI runner that
 * builds twice downloads once.
 *
 * Set `CHORUS_SKIP_REH_BUNDLE=1` to pack without it. The result is a build that
 * downloads on first launch — which is what every build did before this existed,
 * and is the thing to reach for when you want a small installer for a quick
 * local test rather than a release.
 */

const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

/** Where `workbench-host.ts` keeps its copy — `app.getPath('appData')` on each OS. */
function cacheDir() {
  const override = process.env['CHORUS_WORKBENCH_CACHE']
  if (override !== undefined && override !== '') return override
  const home = homedir()
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'chorus-workbench-runtime')
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'chorus-workbench-runtime')
  }
  return join(process.env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'chorus-workbench-runtime')
}

/**
 * electron-builder's `Arch` enum is positional, and the names it reports are not
 * the ones VSCodium publishes under. Mapped explicitly rather than by
 * `String(arch)`, because the enum's numeric values are an implementation detail
 * that has changed between majors.
 */
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/**
 * `darwin`/`win32`/`linux`, as the manifest keys them.
 *
 * `beforePack` is not handed `electronPlatformName` the way `afterPack` is —
 * `sign-adhoc.cjs` destructures it and works, and the same read here returned
 * `undefined` and failed the build. The packager's own `Platform` carries both
 * spellings: `name` is `mac`/`windows`/`linux` and `nodeName` is the Node one,
 * which is what the manifest keys on.
 */
function platformOf(context) {
  const nodeName = context.packager?.platform?.nodeName
  if (nodeName !== undefined) return nodeName
  const name = context.packager?.platform?.name
  if (name === 'mac') return 'darwin'
  if (name === 'windows') return 'win32'
  if (name === 'linux') return 'linux'
  throw new Error('could not determine the target platform for the workbench server')
}

async function download(url, destination, expectedSize) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`could not fetch the workbench server: ${response.status} ${response.statusText}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== expectedSize) {
    throw new Error(`the workbench server download is ${bytes.length} B where the manifest says ${expectedSize} B`)
  }
  // Named only once whole, so an interrupted download cannot be found by name
  // and mistaken for a good one — the same rule `workbench-host.ts` follows.
  const partial = `${destination}.partial`
  writeFileSync(partial, bytes)
  renameSync(partial, destination)
}

exports.default = async function stageReh(context) {
  const app = join(__dirname, '..')
  const staged = join(app, 'build', 'reh', 'workbench-server.tar.gz')

  if (process.env['CHORUS_SKIP_REH_BUNDLE'] === '1') {
    // An empty placeholder rather than no file: `extraResources` fails the build
    // when its source is missing, and a skipped bundle must not look like a
    // broken one. The host treats a file that fails its checksum as absent.
    mkdirSync(join(app, 'build', 'reh'), { recursive: true })
    writeFileSync(staged, '')
    console.log('  • workbench server NOT bundled  reason=CHORUS_SKIP_REH_BUNDLE=1')
    return
  }

  const manifest = JSON.parse(readFileSync(join(app, 'build', 'workbench-runtime.json'), 'utf8'))
  const arch = ARCH_NAMES[context.arch]
  if (arch === undefined) throw new Error(`unrecognised electron-builder arch ${context.arch}`)
  const key = `${platformOf(context)}-${arch}`
  const artifact = manifest.server.artifacts[key]
  if (artifact === undefined) {
    // Stated in the manifest rather than discovered here — `win32-arm64` lives
    // in this branch, because VSCodium has never published one.
    throw new Error(`no ${manifest.server.vendor} server is published for ${key}; it cannot be bundled`)
  }

  const cache = cacheDir()
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, artifact.name)
  if (!existsSync(archive) || statSync(archive).size !== artifact.size) {
    console.log(`  • downloading workbench server  ${artifact.name} (${artifact.size} B)`)
    await download(
      `https://github.com/VSCodium/vscodium/releases/download/${manifest.server.release}/${artifact.name}`,
      archive,
      artifact.size
    )
  }

  /*
   * Verified here as well as at runtime, and that is not belt-and-braces: this
   * is the last point at which a corrupt archive is a build failure rather than
   * a broken installer somebody has already downloaded.
   */
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (sha256 !== artifact.sha256) {
    throw new Error(`${artifact.name} hashes to ${sha256}, manifest says ${artifact.sha256}`)
  }

  mkdirSync(join(app, 'build', 'reh'), { recursive: true })
  writeFileSync(staged, readFileSync(archive))
  console.log(`  • bundling workbench server  ${key} ${artifact.name} (${artifact.size} B)`)
}
