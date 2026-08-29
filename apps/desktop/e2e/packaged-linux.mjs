import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './harness.mjs'

/**
 * The Linux bundle, asked the questions the suite cannot.
 *
 * Mirrors `packaged.mjs` and `packaged-windows.mjs`, and exists for the same
 * reason: the specs run `electron .` against `out/`, which is a directory tree,
 * and the thing a person installs is an asar with several files deliberately
 * outside it. A green suite says nothing about whether the AppImage can open its
 * own database.
 *
 * **The native question is different here, and it is the reason this file is not
 * a copy of the Windows one.** `node-pty` publishes prebuilds for darwin and
 * win32 and none at all for Linux, so its install script falls through to
 * `node-gyp rebuild` and the binding that ships is *compiled on the build host*.
 * That is why the release workflow builds Linux on Linux. It also means the
 * binding's path is not knowable in advance — a compiled build puts it under
 * `build/Release`, a future prebuild would put it under `prebuilds/linux-x64` —
 * so this asks whether *a* binding shipped rather than asserting one path.
 *
 * Getting that wrong in either direction is the failure this file is guarding:
 * a bundle with no PTY starts perfectly, serves its renderer, and only fails
 * when somebody opens a terminal.
 */

const APP = fileURLToPath(new URL('..', import.meta.url))
const UNPACKED_ROOT = join(APP, 'release/linux-unpacked')
const BUNDLE = join(UNPACKED_ROOT, 'chorus')
const RESOURCES = join(UNPACKED_ROOT, 'resources')
const UNPACKED = join(RESOURCES, 'app.asar.unpacked')

/**
 * How much of this the machine can honestly answer. Same split as the other two
 * verifiers: a conversation needs an installed, authenticated agent, which no CI
 * runner has.
 */
const SCOPE = process.env['CHORUS_VERIFY_SCOPE'] === 'bundle' ? 'bundle' : 'full'

/** Where a pty binding may legitimately be, compiled or prebuilt. */
const PTY_CANDIDATES = [
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/prebuilds/linux-x64/pty.node',
]

/** Same, for the helper node-pty execs on every spawn. */
const SPAWN_HELPER_CANDIDATES = [
  'node_modules/node-pty/build/Release/spawn-helper',
  'node_modules/node-pty/prebuilds/linux-x64/spawn-helper',
]

function checkNative(check) {
  check(
    existsSync(join(UNPACKED, 'node_modules/better-sqlite3/prebuilds/linux-x64.node')),
    'the SQLite binding is in the bundle, outside the asar'
  )

  const pty = PTY_CANDIDATES.find((relative) => existsSync(join(UNPACKED, relative)))
  if (pty === undefined) {
    check(false, `no node-pty binding shipped — looked in ${PTY_CANDIDATES.join(' and ')}`)
  } else {
    check(true, `node-pty's binding is in the bundle at ${pty}`)
  }

  /*
   * The helper has to be executable or every spawn dies with a bare
   * `posix_spawnp failed.` that never mentions permissions. A compiled build
   * gets the bit from the linker, which is exactly why the macOS repair exists
   * and this platform needs none — so this asserts the outcome rather than
   * trusting the reasoning.
   */
  const helper = SPAWN_HELPER_CANDIDATES.find((relative) => existsSync(join(UNPACKED, relative)))
  if (helper === undefined) {
    check(false, `no spawn-helper shipped — looked in ${SPAWN_HELPER_CANDIDATES.join(' and ')}`)
    return
  }
  check(
    (statSync(join(UNPACKED, helper)).mode & 0o111) !== 0,
    'spawn-helper is executable, so a PTY can actually spawn'
  )
}

/** The remote extension host, by size against the manifest. See `packaged.mjs`. */
function checkBundledServer(check) {
  const manifest = JSON.parse(readFileSync(join(APP, 'build', 'workbench-runtime.json'), 'utf8'))
  const artifact = manifest.server.artifacts['linux-x64']
  if (artifact === undefined) {
    check(false, 'the manifest publishes no server for linux-x64')
    return
  }
  const archive = join(RESOURCES, 'workbench-server.tar.gz')
  if (!existsSync(archive)) {
    check(false, 'the workbench server is bundled (no workbench-server.tar.gz in resources)')
    return
  }
  const size = statSync(archive).size
  check(
    size === artifact.size,
    `the workbench server is bundled whole — ${String(size)} B, manifest says ${String(artifact.size)} B`
  )
}

async function main() {
  if (!existsSync(BUNDLE)) {
    const release = join(APP, 'release')
    const present = existsSync(release) ? readdirSync(release).join(', ') : 'no release/ directory'
    console.error(`no packaged app at ${BUNDLE}\n  release/ holds: ${present}\n  run: pnpm package`)
    process.exit(1)
  }

  const checks = []
  const check = (ok, label) => {
    checks.push({ ok, label })
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }

  checkNative(check)
  checkBundledServer(check)

  const app = await launch({ executable: BUNDLE })
  try {
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    check(true, 'the bundle starts and serves its renderer')

    if (SCOPE === 'bundle') {
      console.log('\n  — scope: bundle. Skipped the store, composer and agent')
      console.log('    checks, which need an installed and authenticated CLI.')
    } else {
      await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
      check(true, 'the event store opens, so better-sqlite3 loaded')
    }
  } finally {
    await app.quit()
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
