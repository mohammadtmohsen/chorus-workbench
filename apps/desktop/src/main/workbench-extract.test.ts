import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertMatchedPair, WorkbenchManifest } from './workbench-host.js'
import {
  hashBytes,
  hashFile,
  patchProductCommit,
  publishServer,
  readReceipt,
  receiptMatches,
  RECEIPT_FILE,
} from './workbench-extract.js'

/**
 * The three claims this stage rests on, and none of them can be argued from the
 * code reading correctly.
 *
 * 1. **The manifest is a matched pair, and it agrees with the client actually
 *    installed.** This is what makes the client/server pin one fact rather than
 *    two numbers that drift — a `pnpm up` that moved the client without the
 *    server is red here, before it is reviewed.
 * 2. **A tree without a valid receipt is never used**, and publishing over one
 *    goes by quarantine rather than by deletion.
 * 3. **An interrupted or malicious extraction cannot become a valid-looking
 *    runtime.** Asserted by interrupting one.
 */

const scratch = mkdtempSync(join(tmpdir(), 'chorus-workbench-extract-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const MANIFEST_PATH = join(__dirname, '../../build/workbench-runtime.json')

describe('the workbench runtime manifest', () => {
  const bytes = readFileSync(MANIFEST_PATH)
  const manifest = WorkbenchManifest.parse(JSON.parse(bytes.toString('utf8')))

  it('pins a client and a server built from the same upstream tree', () => {
    // The one equality that makes them atomic. It is what actually enforces
    // correctness here, because VSCodium's own `commit` is a sha1 of its version
    // string and so can never satisfy the server-side handshake check unpatched.
    expect(manifest.client.vscodeCommit).toBe(manifest.server.upstreamCommit)
    expect(() => {
      assertMatchedPair(manifest)
    }).not.toThrow()
  })

  it('carries 40-hex commits, which is what catches a version string in a SHA field', () => {
    // `@codingame/monaco-vscode-api@34.1.3` ships `config.vscode.commit` reading
    // `"1.124.2"` — a version where a SHA belongs. Anything reading such a field
    // has to reject a value that is not 40 hex, or it silently pins a server to a
    // string that can never match.
    expect(manifest.client.vscodeCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.server.upstreamCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('agrees with the client that is actually installed', () => {
    /*
     * Read out of the **compiled product module**, which is what ships and what
     * the client presents in the handshake — never out of `package.json`, whose
     * published form has no `config` field at all. Round 2 of the preflight caught
     * a test written against that field; round 3 caught its replacement written
     * against an import specifier that could not resolve. This one is neither: the
     * export-map subpath, read as text, which §3.5 names as the acceptable
     * substitute for importing it.
     */
    const module =
      require.resolve('@codingame/monaco-vscode-api/vscode/vs/platform/product/common/product')
    const source = readFileSync(module, 'utf8')
    expect(source).toContain(`commit: '${manifest.client.vscodeCommit}'`)
    // Covered explicitly because a quality mismatch fails *silently*: it is never
    // compared in the handshake, it just changes the `<quality>-<commit>` prefix
    // every resource URL is fetched under, and the workbench 404-storms.
    expect(source).toContain(`quality: '${manifest.client.quality}'`)
  })

  it('states an unsupported target by omitting it, win32-arm64 included', () => {
    // VSCodium has never published `vscodium-reh-win32-arm64`, in the current
    // release or in any of the last thirty. The absence is the statement, made
    // here rather than discovered at runtime.
    expect(manifest.server.artifacts['win32-arm64']).toBeUndefined()
    expect(manifest.server.artifacts['darwin-arm64']).toBeDefined()
  })

  it('is what the loader hashes, byte for byte', () => {
    // The receipt records this value, so a manifest edited after an extraction
    // leaves a receipt that no longer matches. Hashed as read rather than
    // re-serialised, because a re-serialisation is a different set of bytes.
    expect(hashBytes(bytes)).toMatch(/^[0-9a-f]{64}$/)
  })
})

/** A tiny archive shaped like a server: a `product.json` and something under `out/`. */
function fakeServerArchive(
  name: string,
  commit = 'ffffffffffffffffffffffffffffffffffffffff'
): string {
  const source = join(scratch, `${name}-src`)
  mkdirSync(join(source, 'out'), { recursive: true })
  writeFileSync(join(source, 'product.json'), JSON.stringify({ commit, version: '1.121.03429' }))
  writeFileSync(join(source, 'out', 'server-main.js'), '// pretend\n')
  const archive = join(scratch, `${name}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', source, '.'])
  return archive
}

const CLIENT_COMMIT = '987c9597516278c9fcf10d963a0592ce1384ab93'

async function publishInto(root: string, archive: string, manifestSha256: string): Promise<string> {
  return publishServer({
    root,
    finalName: 'test-release',
    archive,
    expectedSha256: await hashFile(archive),
    clientCommit: CLIENT_COMMIT,
    receipt: {
      artifact: 'fake.tar.gz',
      manifestSha256,
      vendor: 'vscodium',
      release: '1.121.03429',
      upstreamTag: '1.121.0',
      upstreamCommit: CLIENT_COMMIT,
    },
  })
}

describe('publishing a server', () => {
  it('verifies the archive before writing anything, and leaves no tree behind', async () => {
    const root = join(scratch, 'reject')
    const archive = fakeServerArchive('bad')
    await expect(
      publishServer({
        root,
        finalName: 'test-release',
        archive,
        expectedSha256: 'f'.repeat(64),
        clientCommit: CLIENT_COMMIT,
        receipt: {
          artifact: 'fake.tar.gz',
          manifestSha256: 'a'.repeat(64),
          vendor: 'vscodium',
          release: '1.121.03429',
          upstreamTag: '1.121.0',
          upstreamCommit: CLIENT_COMMIT,
        },
      })
    ).rejects.toThrow(/does not match the manifest/)

    // Nothing at the final path, and no temporary tree either. Verifying after
    // extraction would mean the bad bytes were already on disk, and "delete it if
    // the check fails" is a cleanup path that runs exactly when something is
    // already wrong.
    expect(existsSync(join(root, 'test-release'))).toBe(false)
    expect(readdirSync(root).filter((e) => e.startsWith('.tmp-'))).toEqual([])
  })

  it('patches product.json and writes the receipt last', async () => {
    const root = join(scratch, 'publish')
    const manifestSha256 = 'b'.repeat(64)
    const dir = await publishInto(root, fakeServerArchive('good'), manifestSha256)

    const product = JSON.parse(readFileSync(join(dir, 'product.json'), 'utf8')) as {
      commit: string
      version: string
    }
    // The branding field corrected, and nothing else touched: VSCodium's own
    // `version` survives, because the patch may never assert a version fact.
    expect(product.commit).toBe(CLIENT_COMMIT)
    expect(product.version).toBe('1.121.03429')

    const receipt = readReceipt(dir)
    expect(receipt?.productJsonCommitPatchedTo).toBe(CLIENT_COMMIT)
    expect(receipt?.manifestSha256).toBe(manifestSha256)
    // Measured, never copied from the manifest.
    expect(receipt?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reuses a valid tree instead of extracting again', async () => {
    const root = join(scratch, 'reuse')
    const archive = fakeServerArchive('reuse')
    const first = await publishInto(root, archive, 'c'.repeat(64))
    const stamp = readReceipt(first)?.unpackedAt

    const second = await publishInto(root, archive, 'c'.repeat(64))
    expect(second).toBe(first)
    // Same receipt, so nothing was re-extracted and re-stamped.
    expect(readReceipt(second)?.unpackedAt).toBe(stamp)
  })

  it('quarantines an invalid destination rather than deleting it, then publishes', async () => {
    const root = join(scratch, 'quarantine')
    const archive = fakeServerArchive('q')
    const dir = await publishInto(root, archive, 'd'.repeat(64))

    /*
     * The exact state the transactional order exists to make unreachable, forced
     * by hand: a tree that is *there* and is not the one the manifest authorises.
     * Corrupting the receipt is the cheapest way to produce it, and it stands in
     * for the real causes — an interrupted extraction, a stale release, a manifest
     * bumped underneath a tree that was published under the old one.
     */
    writeFileSync(join(dir, RECEIPT_FILE), '{ not json')
    writeFileSync(join(dir, 'evidence.txt'), 'the old tree was here')

    const republished = await publishInto(root, archive, 'd'.repeat(64))
    expect(republished).toBe(dir)
    expect(
      receiptMatches(dir, {
        artifact: 'fake.tar.gz',
        sha256: await hashFile(archive),
        manifestSha256: 'd'.repeat(64),
        release: '1.121.03429',
        upstreamTag: '1.121.0',
        upstreamCommit: CLIENT_COMMIT,
      })
    ).toBe(true)

    /*
     * And the old tree still exists, moved rather than removed. This is the whole
     * argument for quarantine: an interrupted `rm -rf` leaves a directory that
     * exists, is missing an arbitrary subset of its files, and may still carry a
     * parseable matching receipt — which is exactly the state nothing here is
     * allowed to produce. A rename cannot produce it.
     */
    const quarantined = readdirSync(root).filter((e) => e.startsWith('.quarantine-'))
    expect(quarantined).toHaveLength(1)
    expect(existsSync(join(root, quarantined[0] ?? '', 'evidence.txt'))).toBe(true)
  })

  it('refuses a manifest whose hash has moved under a published tree', async () => {
    const root = join(scratch, 'drift')
    const archive = fakeServerArchive('drift')
    const dir = await publishInto(root, archive, 'e'.repeat(64))

    // The field that makes the receipt an assertion about a *manifest* and not
    // just about an artifact. Without it a manifest edited after extraction
    // leaves a receipt still agreeing on every field it happens to carry.
    expect(
      receiptMatches(dir, {
        artifact: 'fake.tar.gz',
        sha256: await hashFile(archive),
        manifestSha256: '0'.repeat(64),
        release: '1.121.03429',
        upstreamTag: '1.121.0',
        upstreamCommit: CLIENT_COMMIT,
      })
    ).toBe(false)
  })

  it('treats a tree with no receipt at all as unusable', async () => {
    const root = join(scratch, 'headless')
    mkdirSync(join(root, 'test-release'), { recursive: true })
    writeFileSync(join(root, 'test-release', 'product.json'), '{}')

    // Not "repair it", not "assume it is fine because the files are there". This
    // is the shape an extraction killed halfway leaves behind, and the receipt
    // being written last is what makes its absence decisive.
    expect(readReceipt(join(root, 'test-release'))).toBeNull()
    const dir = await publishInto(root, fakeServerArchive('headless'), 'f'.repeat(63) + 'a')
    expect(readReceipt(dir)).not.toBeNull()
    expect(readdirSync(root).filter((e) => e.startsWith('.quarantine-'))).toHaveLength(1)
  })
})

describe('patchProductCommit', () => {
  it('refuses a product.json that is not an object', () => {
    const path = join(scratch, 'not-product.json')
    writeFileSync(path, '"a string"')
    expect(() => {
      patchProductCommit(path, CLIENT_COMMIT)
    }).toThrow(/not an object/)
  })

  it('leaves every other field alone', () => {
    const path = join(scratch, 'product.json')
    writeFileSync(path, JSON.stringify({ commit: 'old', nameShort: 'VSCodium', extra: [1, 2] }))
    patchProductCommit(path, CLIENT_COMMIT)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      commit: CLIENT_COMMIT,
      nameShort: 'VSCodium',
      extra: [1, 2],
    })
  })
})

/** Keeps the unused import honest under `noUnusedLocals`. */
export const MANIFEST_DIR = dirname(MANIFEST_PATH)
