import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { archiveIsEmpty, archiveRefusals, readArchiveEntries } from './workbench-archive.js'

const run = promisify(execFile)

/**
 * Publishing an unpacked remote extension host — preflight §3.5, and the
 * **ordering is the property**.
 *
 * None of the steps below is where it is by preference. Each one is placed so
 * that moving it reintroduces a state the next step exists to make unreachable,
 * and the single sentence the whole design has to be checked against is: **an
 * interrupted or malicious extraction cannot become a valid-looking runtime.**
 *
 * A tree that is missing files, was written from a half-verified archive, or was
 * never patched, has no receipt — because the receipt is written last, inside a
 * directory that is not yet at its final name. A tree that *has* a receipt got
 * one only after verification, containment checking, extraction and patching all
 * completed. There is no interleaving of a crash, a `SIGKILL` or a full disk that
 * produces the first while looking like the second.
 *
 * **The publish path never recursively deletes a destination**, and that is the
 * load-bearing prohibition rather than a stylistic one. An interrupted `rm -rf`
 * leaves a directory that exists, is missing an arbitrary subset of its files,
 * and may still carry a parseable, matching receipt — because the receipt is one
 * small file among thousands and nothing orders its deletion first. That is
 * precisely the state everything here is arranged to make unreachable, and a
 * recursive delete is the one operation that can manufacture it. A rename cannot.
 */

export const ExtractionReceipt = z.object({
  artifact: z.string().min(1),
  /** Measured on the downloaded file, never copied from the manifest. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The byte-level identity of the manifest this tree was published under.
   *
   * Without it the receipt records which *artifact* was unpacked but not which
   * *manifest* authorised it — so a manifest edited afterwards (a bumped
   * `client.vscodeCommit`, a changed patch target) would leave a receipt that
   * still agrees on every field it happens to carry.
   */
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  vendor: z.string().min(1),
  release: z.string().min(1),
  /** From the release's own `upstream/stable.json` — never from the tarball, which does not say. */
  upstreamTag: z.string().min(1),
  upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
  /**
   * Recorded deliberately: after the §1.5b patch the server's own `commit` is
   * Chorus's value, and a receipt that did not say so would leave the next reader
   * believing the server had agreed with the manifest independently.
   */
  productJsonCommitPatchedTo: z.string().regex(/^[0-9a-f]{40}$/),
  unpackedAt: z.string().min(1),
})
export type ExtractionReceipt = z.infer<typeof ExtractionReceipt>

export const RECEIPT_FILE = 'chorus-extraction.json'

/**
 * Bounded, because a livelock is not a recovery.
 *
 * Round 5's rule is to restart by re-reading the destination rather than to
 * retry blindly, and re-entering the table costs nothing — the temporary tree is
 * already built, so no pass repeats a download or an extraction. What a bound
 * buys is that a destination something else is churning produces a legible error
 * instead of a process that never returns.
 */
const PUBLISH_ATTEMPTS = 8

/** The errors that mean *another actor made progress*, rather than that something is broken. */
function raceLost(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT' || code === 'EPERM'
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        resolvePromise(hash.digest('hex'))
      })
  })
}

export function hashBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The receipt at `dir`, or null for absent, unparseable or malformed. */
export function readReceipt(dir: string): ExtractionReceipt | null {
  try {
    const parsed = ExtractionReceipt.safeParse(
      JSON.parse(readFileSync(join(dir, RECEIPT_FILE), 'utf8'))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface ReceiptExpectation {
  readonly artifact: string
  readonly sha256: string
  readonly manifestSha256: string
  readonly release: string
  readonly upstreamTag: string
  readonly upstreamCommit: string
}

/**
 * Whether the tree at `dir` is one Chorus may run, and "matching" is spelled out
 * rather than left to a field-by-field guess: the receipt parses, its
 * `manifestSha256` equals the hash of the manifest being read *now*, and its
 * artifact and commits agree with that manifest's.
 *
 * Anything else is unusable — not "repair it", not "assume it is fine because the
 * files are there".
 */
export function receiptMatches(dir: string, expected: ReceiptExpectation): boolean {
  const receipt = readReceipt(dir)
  if (receipt === null) return false
  return (
    receipt.artifact === expected.artifact &&
    receipt.sha256 === expected.sha256 &&
    receipt.manifestSha256 === expected.manifestSha256 &&
    receipt.release === expected.release &&
    receipt.upstreamTag === expected.upstreamTag &&
    receipt.upstreamCommit === expected.upstreamCommit
  )
}

/**
 * §1.5b's edit, and the guard is the point rather than the edit.
 *
 * VSCodium's `product.json` carries a sha1 of its own version string where the
 * handshake expects an upstream VS Code commit — observed on this artifact as
 * `824c4c46…`, which is `sha1("1.121.03429\n")` — so *no* VSCodium server can
 * ever satisfy the check unpatched, at any version. That makes the patch
 * permanent rather than a workaround, and it means the same one-line edit that
 * makes a **correct** pairing work would also make an **incorrect** one connect.
 *
 * So the caller must already have established `client.vscodeCommit ===
 * server.upstreamCommit`. This function corrects a *branding* field; it may never
 * assert a *version* fact. When the manifest's two commits differ the correct
 * behaviour is to refuse to start, not to patch.
 */
export function patchProductCommit(productJson: string, commit: string): void {
  const product: unknown = JSON.parse(readFileSync(productJson, 'utf8'))
  if (typeof product !== 'object' || product === null) {
    throw new Error(`The unpacked server's product.json is not an object: ${productJson}`)
  }
  writeFileSync(productJson, `${JSON.stringify({ ...product, commit }, null, 2)}\n`)
}

export interface PublishOptions {
  /** `<userData>/workbench` — every temporary and quarantine sibling lives here too. */
  readonly root: string
  /** `<release>-<platform>-<arch>`, the checksum-addressed final name. */
  readonly finalName: string
  readonly archive: string
  readonly expectedSha256: string
  readonly clientCommit: string
  readonly receipt: Omit<ExtractionReceipt, 'sha256' | 'unpackedAt' | 'productJsonCommitPatchedTo'>
}

async function extract(archive: string, into: string): Promise<void> {
  /*
   * The system tool writes the files; containment was already decided from the
   * archive's own headers by `workbench-archive.ts`. `--no-same-owner` because
   * the tarball records the build machine's uid, and nothing here should try to
   * honour it.
   */
  await run('tar', ['-xzf', archive, '--no-same-owner', '-C', into], {
    maxBuffer: 8 * 1024 * 1024,
  })
}

export async function publishServer(options: PublishOptions): Promise<string> {
  const { root, finalName, archive, expectedSha256, clientCommit, receipt } = options
  mkdirSync(root, { recursive: true })
  const final = join(root, finalName)

  const expectation: ReceiptExpectation = {
    artifact: receipt.artifact,
    sha256: expectedSha256,
    manifestSha256: receipt.manifestSha256,
    release: receipt.release,
    upstreamTag: receipt.upstreamTag,
    upstreamCommit: receipt.upstreamCommit,
  }

  // Already published and valid: the cheapest answer, and the one that keeps a
  // relaunch from paying for an extraction it has already done.
  if (existsSync(final) && receiptMatches(final, expectation)) return final

  /*
   * Step 1 — verify the archive against the committed manifest **before**
   * extracting a single entry.
   *
   * Verifying afterwards means the bad bytes are already on disk, and "delete it
   * if the check fails" is a cleanup path that runs exactly when something is
   * already wrong.
   */
  const measured = await hashFile(archive)
  if (measured !== expectedSha256) {
    throw new Error(
      `The workbench server archive does not match the manifest: expected ${expectedSha256}, measured ${measured}`
    )
  }

  /*
   * Step 2 — a new temporary sibling, on the same filesystem as the final
   * location. The sibling constraint is what makes step 6 a rename rather than a
   * copy, on every platform. Never extract over an existing tree, never extract
   * into the final path.
   */
  const temp = mkdtempSync(join(root, '.tmp-'))
  try {
    /*
     * Step 3 — reject absolute paths, `..` traversal, and links whose resolved
     * target escapes the root. Independently, from the archive's own headers,
     * rather than by trusting the extractor: CVE-2026-23745 is exactly this bug
     * left unhandled in a library's default configuration.
     */
    const entries = await readArchiveEntries(archive)
    const refusals = archiveRefusals(entries)
    if (refusals.length > 0) {
      throw new Error(
        `The workbench server archive is not safe to extract:\n  ${refusals.join('\n  ')}`
      )
    }
    if (archiveIsEmpty(entries)) {
      throw new Error('The workbench server archive contains no files')
    }

    await extract(archive, temp)

    /*
     * Step 4 — patch `product.json` in the temporary tree, before the tree is
     * ever addressable under its final name. A patch applied after the rename
     * would mean a valid-looking runtime exists, for a window, unpatched.
     */
    patchProductCommit(join(temp, 'product.json'), clientCommit)

    /*
     * Step 5 — the receipt last, once every byte above it is final. It is the
     * commit record; anything written after it could contradict it.
     */
    const complete: ExtractionReceipt = {
      ...receipt,
      sha256: measured,
      productJsonCommitPatchedTo: clientCommit,
      unpackedAt: new Date().toISOString(),
    }
    writeFileSync(join(temp, RECEIPT_FILE), `${JSON.stringify(complete, null, 2)}\n`)

    return publish(root, temp, final, expectation)
  } catch (error) {
    // Our own temporary tree, which no code path reads and nothing can mistake
    // for a runtime — the one place a recursive delete is safe here.
    rmSync(temp, { recursive: true, force: true })
    throw error
  }
}

/**
 * Steps 6–8: the destination is only ever one of three things, and the third is
 * the one an earlier draft of the preflight dropped.
 *
 * | Destination                        | Meaning                          | Action                            |
 * | ---------------------------------- | -------------------------------- | --------------------------------- |
 * | Absent                             | First writer                     | rename. Done                      |
 * | Present, receipt valid             | Another extraction won the race  | Use it, drop the temporary tree   |
 * | Present, receipt invalid or absent | Interrupted, corrupt or stale    | Quarantine, then publish          |
 *
 * **This is a genuine weakening of "one atomic substitution", and saying so is
 * the point.** Between the quarantine rename and the publish rename the final
 * path does not exist, so publishing over an invalid tree is two atomic renames
 * with a gap rather than one atomic swap — POSIX's guarantee covers each rename
 * and does not span the pair. The property that survives is the one that matters:
 * **the final path is only ever absent, or a complete tree with a receipt.** It is
 * never a partially-written one.
 */
function publish(
  root: string,
  temp: string,
  final: string,
  expectation: ReceiptExpectation
): string {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    if (!existsSync(final)) {
      try {
        renameSync(temp, final)
        return final
      } catch (error) {
        if (raceLost(error)) continue
        throw error
      }
    }

    if (receiptMatches(final, expectation)) {
      rmSync(temp, { recursive: true, force: true })
      return final
    }

    /*
     * A **unique** sibling in the same parent, so it is same-filesystem by
     * construction and cannot collide with a concurrent quarantine. The
     * randomness is load-bearing: a fixed `.quarantine/` would itself hit
     * ENOTEMPTY the second time, which is the bug being fixed one directory over.
     */
    try {
      renameSync(final, join(root, `.quarantine-${randomUUID()}`))
    } catch (error) {
      // ENOENT here means another process quarantined the same invalid tree
      // first. That is progress, not an error — look at what is there now.
      if (raceLost(error)) continue
      throw error
    }
    try {
      renameSync(temp, final)
      return final
    } catch (error) {
      // ENOTEMPTY here means another process published into the gap the
      // quarantine opened. Also progress.
      if (raceLost(error)) continue
      throw error
    }
  }
  throw new Error(
    `Could not publish the workbench server into ${final} after ${String(PUBLISH_ATTEMPTS)} attempts`
  )
}

/**
 * A separate, restartable sweep, and the only place a recursive delete is
 * allowed — because a half-deleted `.quarantine-<random>` is garbage that no code
 * path reads, looks for, or can mistake for a runtime. A crash mid-sweep costs
 * disk, not correctness.
 *
 * **Quarantine only a tree no Chorus-spawned server is running out of.** On
 * Windows a directory rename fails with a sharing violation while a process holds
 * an executable inside it, so a leaked server turns quarantine into a hard
 * failure rather than a race. That interaction is UNVERIFIED and is the Windows
 * case worth driving deliberately.
 */
export function sweepQuarantine(root: string, entries: readonly string[]): void {
  for (const entry of entries) {
    if (!entry.startsWith('.quarantine-')) continue
    rmSync(join(root, entry), { recursive: true, force: true })
  }
}
