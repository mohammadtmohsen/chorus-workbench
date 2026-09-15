import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stable code-signing identity for locally installed builds.
 *
 * **This exists because of the keychain, not because of Gatekeeper.** The app
 * keeps a workbench extension's credentials in the login keychain through
 * Electron's `safeStorage`, and macOS binds a keychain item's access list to the
 * *code signature* of the program asking for it. An ad-hoc signature — `codesign
 * --sign -` — has no stable designated requirement for an access list to record,
 * so "Always Allow" has nothing durable to write down: it was observed doing
 * nothing at all, and the prompt returned on every single launch.
 *
 * Signed by a certificate that stays the same between builds, the requirement
 * becomes `identifier … and certificate leaf = <this cert>`, which the keychain
 * can and does remember. One "Always Allow" then holds across rebuilds.
 *
 * **Local installs only.** Nothing here reaches the release pipeline, which
 * still signs ad-hoc and still says so in its notes. A self-signed certificate
 * is worth nothing on anyone else's machine: it is not trusted, it is not a
 * Developer ID, and it does not notarize. What it buys is a signature that is
 * *the same one* each time on this machine, which is the only property the
 * keychain cares about.
 */

/** The certificate's common name, and the argument `codesign -s` is given. */
export const LOCAL_IDENTITY = 'Chorus Local Dev'

/**
 * Its own keychain, and the login keychain is deliberately left alone.
 *
 * **This is the difference between working and hanging.** A key imported into
 * the login keychain prompts on every use even when `codesign` is on its access
 * list — macOS added partition ids in 10.12 and an ACL alone no longer
 * satisfies them. The fix is `set-key-partition-list`, which needs the
 * keychain's password, and the login keychain's password is the person's login
 * password: not something a build script may ask for or hold.
 *
 * A keychain this script creates has a password this script knows, so the same
 * call is unattended. That is also why a build can run in the background
 * without stopping on a dialog nobody is watching.
 */
const KEYCHAIN = join(homedir(), 'Library/Keychains/chorus-local-signing.keychain-db')

/**
 * Not a secret, and pretending otherwise would be the mistake.
 *
 * The keychain it opens holds exactly one thing: a self-signed certificate whose
 * only power is to sign local builds on this machine. It grants no access to
 * anything, it is trusted by nothing, and it is useless anywhere else. A
 * generated password would have to be written next to the file it protects,
 * which is the same secret with more moving parts.
 */
const KEYCHAIN_PASSWORD = 'chorus-local-signing'

/**
 * The password on the PKCS#12 file, which exists only between two commands.
 *
 * It protects a bundle written into a temp directory and deleted in the same
 * function. It is not empty because an empty PKCS#12 password is one of the two
 * ways `security import` fails on an OpenSSL 3 file — see the export below for
 * the other.
 */
const TRANSIT_PASSWORD = 'chorus-transit'

/** Long, because rotating the certificate discards the keychain grant it exists
    to preserve. */
const VALID_DAYS = 3650

function security(args, options = {}) {
  return execFileSync('security', args, { encoding: 'utf8', ...options })
}

/**
 * Whether the identity is present and paired with its key.
 *
 * `find-identity` rather than `find-certificate`: a certificate whose private
 * key is missing is useless here and lists identically.
 *
 * **No `-v`, and that is not laxity.** `-v` filters to identities the system
 * considers *valid*, which means trusted — and a self-signed certificate is by
 * definition not. With it, the import reported "1 identity imported" and this
 * function still answered no, so every run made another certificate and then
 * declared failure. Signing does not need trust; only verifying against a trust
 * policy does, which is Gatekeeper's business and not this file's.
 */
function hasIdentity() {
  try {
    return security(['find-identity', '-p', 'codesigning', KEYCHAIN]).includes(LOCAL_IDENTITY)
  } catch {
    // No such keychain yet, which is the ordinary first run.
    return false
  }
}

/**
 * Adds the keychain to the user's search list without disturbing what is there.
 *
 * **`list-keychains -s` replaces the whole list rather than appending to it**,
 * so the current entries are read and passed back with the new one on the end.
 * Getting this wrong would drop the login keychain out of the search path,
 * which breaks far more than a build.
 */
function joinSearchList() {
  const current = security(['list-keychains', '-d', 'user'])
    .split('\n')
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter((line) => line !== '')
  if (current.includes(KEYCHAIN)) return
  security(['list-keychains', '-d', 'user', '-s', ...current, KEYCHAIN])
}

function createIdentity() {
  const work = mkdtempSync(join(tmpdir(), 'chorus-local-identity-'))
  const key = join(work, 'key.pem')
  const cert = join(work, 'cert.pem')
  const bundle = join(work, 'bundle.p12')

  try {
    /*
     * `extendedKeyUsage=codeSigning` is what makes the identity visible to
     * `find-identity -p codesigning` at all. Without it the certificate exists
     * and no code-signing tool can see it, which reads as "it was never
     * created".
     */
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        String(VALID_DAYS),
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-subj',
        `/CN=${LOCAL_IDENTITY}`,
        '-addext',
        'basicConstraints=critical,CA:false',
        '-addext',
        'keyUsage=critical,digitalSignature',
        '-addext',
        'extendedKeyUsage=critical,codeSigning',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )

    /*
     * The old algorithms, on purpose, and an empty password would fail outright.
     *
     * OpenSSL 3 defaults to AES-256-CBC with a SHA-256 MAC, which Security
     * framework cannot read: `security import` refuses the file with "MAC
     * verification failed during PKCS12 import (wrong password?)" — a message
     * that names the password and means the algorithm. `PBE-SHA1-3DES` with a
     * SHA-1 MAC is the format macOS accepts.
     *
     * The password is non-empty for the same reason. An empty one is a second,
     * separate way to reach the same error on this path, and the file it
     * protects exists for the length of this function inside a temp directory
     * that is removed in `finally`.
     */
    execFileSync(
      'openssl',
      [
        'pkcs12',
        '-export',
        '-out',
        bundle,
        '-inkey',
        key,
        '-in',
        cert,
        '-keypbe',
        'PBE-SHA1-3DES',
        '-certpbe',
        'PBE-SHA1-3DES',
        '-macalg',
        'sha1',
        '-passout',
        `pass:${TRANSIT_PASSWORD}`,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )

    if (!existsSync(KEYCHAIN)) {
      security(['create-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN])
    }
    /*
     * No auto-lock and no lock-on-sleep. A keychain that relocks between builds
     * would prompt for its password, which is the interactive step this whole
     * arrangement exists to avoid.
     */
    security(['set-keychain-settings', KEYCHAIN])
    security(['unlock-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN])

    // `-T /usr/bin/codesign` names the one program allowed to use the key.
    // Deliberately not `-A`, which would hand it to everything on the machine.
    security(
      ['import', bundle, '-k', KEYCHAIN, '-P', TRANSIT_PASSWORD, '-T', '/usr/bin/codesign'],
      { stdio: 'inherit' }
    )

    /*
     * The partition list is the part an access list no longer covers on its own
     * — see `KEYCHAIN` above. Without this, `codesign` is on the ACL and still
     * gets a dialog.
     */
    security([
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      KEYCHAIN_PASSWORD,
      KEYCHAIN,
    ])
  } finally {
    // The private key is in the keychain now; the copy on disk is not wanted.
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * The identity to sign a local build with, created on first use.
 *
 * Idempotent, and that is the whole point: a fresh certificate per build would
 * reproduce exactly the ad-hoc problem it replaces. The unlock runs every time
 * because a keychain can be locked by things other than a timeout.
 */
export function ensureLocalIdentity() {
  if (!hasIdentity()) {
    console.log(`local-identity: creating a self-signed "${LOCAL_IDENTITY}" certificate`)
    createIdentity()
  }
  joinSearchList()
  security(['unlock-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN])

  if (!hasIdentity()) {
    throw new Error(
      `local-identity: "${LOCAL_IDENTITY}" is still not a usable code-signing identity. ` +
        'Signing would fall back to ad-hoc and the keychain prompt would return on every launch.'
    )
  }
  return LOCAL_IDENTITY
}
