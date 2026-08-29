import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { launch } from './harness.mjs'

/**
 * Drives the app a user would install, rather than the one the specs drive.
 *
 * The specs run `electron .` against `out/`, which is the same source and a
 * different program: `out/` is a directory tree, and the bundle is an asar with
 * two things deliberately outside it — `better-sqlite3`, which is native and
 * cannot be loaded from an archive, and the Claude SDK, which resolves its own
 * files at runtime. Nothing in the suite touched either arrangement, so for
 * several releases a green suite said nothing about whether the thing on the
 * DMG could open its own database.
 *
 * The count used to be written here — "the 26 specs", then wrong by six. A total
 * in prose is a number nobody updates when they add a spec, so it is gone rather
 * than corrected.
 *
 * This asks the four questions the suite cannot:
 *
 *  1. does the bundle start at all,
 *  2. does the native module load from outside the asar,
 *  3. does the renderer get built and served from inside it,
 *  4. does a real session start — which needs the SDK to find its own files.
 *
 * Deliberately not a spec in `specs.mjs`. Those run against one build made once;
 * this needs `pnpm package`, which is minutes and a code-signing step, and it
 * belongs at a release rather than on every change.
 */

// See the note in `packaged-windows.mjs`: `.pathname` keeps its leading
// slash. This verifier is macOS-only, but the two should not differ here.
const APP = fileURLToPath(new URL('..', import.meta.url))

/**
 * Which of the two macOS builds to verify, derived rather than hardcoded.
 *
 * electron-builder names the output directory after the architecture and does
 * not do it uniformly: arm64 lands in `release/mac-arm64`, x64 in `release/mac`.
 * Since Phase 7 the DMG is built for both, so a fixed `mac-arm64` here would
 * mean the Intel job silently verified nothing of its own.
 *
 * `process.arch` is the right discriminator because the verifier runs on the
 * machine that built it — the release matrix puts the Intel job on an Intel
 * runner precisely so the app it launches is native rather than translated.
 *
 * **Deliberately not "whichever mac* directory exists".** That fallback would
 * let a job verify a leftover bundle from another architecture and report a
 * pass for a build it never made — the same failure as the e2e harness that
 * attached to whatever owned port 9800, which took hours to see because every
 * assertion described a real app that was the wrong one.
 */
const MAC_DIR = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const ROOT = join(APP, 'release', MAC_DIR, 'Chorus.app')
const BUNDLE = join(ROOT, 'Contents/MacOS/Chorus')
const UNPACKED = join(ROOT, 'Contents/Resources/app.asar.unpacked')

/**
 * How much of this the machine can honestly answer. Mirrors the Windows
 * verifier, for the same reason: a pane needs a conversation and a conversation
 * needs an installed, authenticated agent, which a CI runner does not have.
 * `bundle` stops after the launch; `full` is the default and is what a release
 * runs on a real machine.
 */
const SCOPE = process.env['CHORUS_VERIFY_SCOPE'] === 'bundle' ? 'bundle' : 'full'

/**
 * node-pty's `spawn-helper` ships mode 0644 and electron-builder copies the mode
 * through verbatim, so without the repair in `build/sign-adhoc.cjs` the packaged
 * terminal dies with a bare `posix_spawnp failed.` — measured on 2026-08-12, not
 * inferred.
 *
 * Checked as a file rather than by driving a terminal because the failure is in
 * the packaging arrangement, and a file check catches it before the app boots. A
 * node-pty bump that reorganises `prebuilds/` fails here too, which is the point:
 * the repair hard-codes a path, and a silent miss would restore the bug.
 */
function checkSpawnHelper(check) {
  const helper = join(
    UNPACKED,
    'node_modules/node-pty/prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper'
  )
  if (!existsSync(helper)) {
    check(false, `spawn-helper is in the bundle (looked in ${helper})`)
    return
  }
  check(true, 'spawn-helper is in the bundle, outside the asar')
  check(
    (statSync(helper).mode & 0o111) !== 0,
    'spawn-helper is executable, so a PTY can actually spawn'
  )
}

async function main() {
  if (!existsSync(BUNDLE)) {
    // Say which architecture was wanted and what is actually there. A bare
    // "not found" on a two-architecture build reads as "the package step
    // failed" when the likely cause is that it built the other one.
    const release = join(APP, 'release')
    const present = existsSync(release)
      ? readdirSync(release)
          .filter((e) => e.startsWith('mac'))
          .join(', ') || 'nothing matching mac*'
      : 'no release/ directory at all'
    console.error(
      `no packaged app at ${BUNDLE}\n` +
        `  wanted the ${process.arch} build; release/ holds: ${present}\n` +
        `  run: pnpm package`
    )
    process.exit(1)
  }

  const checks = []
  const check = (ok, label) => {
    checks.push({ ok, label })
    console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  }

  // Before the app boots: nothing here needs a window, and a bad bundle should
  // say so in milliseconds rather than after a three-minute agent handshake.
  checkSpawnHelper(check)

  const app = await launch({ executable: BUNDLE })
  try {
    // A window at all means the asar was read and the renderer was served.
    await app.until(`document.querySelector('#root') !== null`, { timeout: 120_000 })
    check(true, 'the bundle starts and serves its renderer')

    /*
     * A pane means the runtime opened SQLite and started a conversation, which
     * is the native module loading from outside the asar. It is the check most
     * likely to fail on a packaging change and the one with no other coverage.
     */
    if (SCOPE === 'bundle') {
      console.log('\n  — scope: bundle. Skipped the store, composer and agent')
      console.log('    checks, which need an installed and authenticated CLI.')
    } else {
      await runFullChecks(app, check)
    }
  } finally {
    await app.quit()
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? `\nall ${String(checks.length)} passed` : `\n${String(failed)} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

/** The half that needs an installed, authenticated CLI. See `SCOPE`. */
async function runFullChecks(app, check) {
  await app.until(`document.querySelectorAll('.pane').length > 0`, { timeout: 120_000 })
  check(true, 'the event store opens, so the native module loaded')

  await app.settle()
  check(
    (await app.evaluate(`document.querySelector('.composer textarea') !== null`)) === true,
    'the composer is there to type into'
  )

  /*
   * `session.started` is the SDK resolving its own files at runtime — the other
   * thing kept outside the asar. An agent that cannot start leaves the card
   * without a voice, which no amount of renderer testing would show.
   */
  await app.until(
    `Array.from(document.querySelectorAll('.entry')).some(e => /joined/i.test(e.innerText))`,
    { timeout: 180_000 }
  )
  check(true, 'an agent joins, so the SDK found its own files')
}

await main()
