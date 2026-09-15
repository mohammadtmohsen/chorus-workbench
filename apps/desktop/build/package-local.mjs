import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLocalIdentity } from './local-identity.mjs'

/**
 * Packs the app for a local install, signed with a stable identity.
 *
 * **A separate entry point rather than an environment variable at the call
 * site.** `CHORUS_SIGN_IDENTITY=… pnpm run package:dir` is shell syntax that
 * Windows `cmd` does not have, and this repo's scripts run on both. Setting it
 * on a child process from here works everywhere and keeps the identity out of
 * the ambient environment of anything else.
 *
 * **`package:dir` is left exactly as it was**, which matters more than the
 * duplication saved by reusing it: that script is what the release pipeline and
 * every gate run, and they must keep signing ad-hoc. Local installs are the only
 * thing that wants a stable certificate — see `local-identity.mjs` for why they
 * want it at all.
 */

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  /*
   * Not an error: signing identities are a macOS concern, and a local install
   * elsewhere is simply the ordinary build. Falling through rather than
   * refusing keeps this usable as the one entry point on every platform.
   */
  execFileSync('pnpm', ['run', 'package:dir'], { cwd: desktopDir, stdio: 'inherit' })
  process.exit(0)
}

const identity = ensureLocalIdentity()

execFileSync('pnpm', ['run', 'package:dir'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: { ...process.env, CHORUS_SIGN_IDENTITY: identity },
})
