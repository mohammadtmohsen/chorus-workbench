import { createReadStream } from 'node:fs'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

/**
 * The archive's own headers, read rather than asked for — preflight §3.5 step 3.
 *
 * That step requires rejecting absolute paths, `..` traversal and links that
 * escape the extraction root, **for the resolved target and not just the entry
 * name**, and it requires validating "independently rather than delegating the
 * invariant". CVE-2026-23745 is the reason it is worded that way: `node-tar`
 * ≤ 7.5.2 left `linkpath` unsanitised for `Link` and `SymbolicLink` entries in
 * the *default* configuration, i.e. in the one people choose because they believe
 * it is the safe one.
 *
 * So the work is split where each half is strongest. **Validation is ours and
 * reads the bytes**; extraction is the system `tar`, which is far better tested
 * at writing a tree than anything written here would be. The alternative — parse
 * `tar -tvzf` — was tried first and rejected on observation: its output is
 * `ls -l`-shaped, the date column changes format with the file's age, and a name
 * containing ` -> ` is indistinguishable from a symlink's arrow. A tar header is
 * none of those things. It is fixed offsets in a 512-byte block, and the type,
 * the name and the link target each have exactly one place they can be.
 *
 * What this deliberately does not do is extract. A validator that also wrote
 * files would have to be trusted with the thing it was written to check.
 */

/** Fixed offsets in the ustar header block. Every one of these is from the format, not from a guess. */
const BLOCK = 512
const NAME = { at: 0, length: 100 }
const SIZE = { at: 124, length: 12 }
const TYPEFLAG = 156
const LINKNAME = { at: 157, length: 100 }
const PREFIX = { at: 345, length: 155 }

/**
 * The entry kinds that carry a path Chorus has to judge, plus the three that
 * *rewrite* the next entry's path and would otherwise let one past.
 *
 * `x`/`L`/`K` are the reason a validator cannot look at header names alone: a
 * GNU long-name block or a pax extended header supplies the real path for the
 * entry that follows, so a reader that ignored them would judge a placeholder
 * (`././@LongLink`, or a pax stub) and let the actual path through unexamined.
 * That is the same shape as the CVE above — the sanitised field was not the one
 * that decided where the bytes landed.
 */
const PAX_EXTENDED = 'x'
const PAX_GLOBAL = 'g'
const GNU_LONG_NAME = 'L'
const GNU_LONG_LINK = 'K'
const HARD_LINK = '1'
const SYM_LINK = '2'
const DIRECTORY = '5'

export interface ArchiveEntry {
  readonly path: string
  readonly typeflag: string
  /** The link target for `1` and `2`, and the empty string for everything else. */
  readonly linkname: string
}

function trimNul(buffer: Buffer, at: number, length: number): string {
  const slice = buffer.subarray(at, at + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/**
 * The declared size of an entry's payload, so the reader knows how far to skip.
 *
 * Base-256 is handled even though nothing in a REH needs it: the high bit of the
 * first byte marks a size too large for eleven octal digits, and a reader that
 * did not notice would parse the field as octal, get a nonsense length, and
 * resynchronise on a block boundary that is not an entry — turning a legitimate
 * large file into a stream of unparseable headers rather than into an error.
 */
function readSize(buffer: Buffer): number {
  const first = buffer[SIZE.at] ?? 0
  if ((first & 0x80) !== 0) {
    let value = 0
    for (let i = SIZE.at + 1; i < SIZE.at + SIZE.length; i += 1)
      value = value * 256 + (buffer[i] ?? 0)
    return value
  }
  const octal = trimNul(buffer, SIZE.at, SIZE.length).trim()
  const parsed = Number.parseInt(octal, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/** A pax record is `<length> <key>=<value>\n`, and the length counts itself. */
function paxValue(payload: Buffer, key: string): string | null {
  let offset = 0
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset)
    if (space === -1) return null
    const declared = Number.parseInt(payload.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(declared) || declared <= 0) return null
    const record = payload.subarray(space + 1, offset + declared).toString('utf8')
    const equals = record.indexOf('=')
    if (equals !== -1 && record.slice(0, equals) === key)
      return record.slice(equals + 1).replace(/\n$/, '')
    offset += declared
  }
  return null
}

/**
 * Every entry the archive declares, in order, with long-name and pax overrides
 * already applied.
 *
 * Streamed rather than buffered: the artifact is 76 MB compressed and several
 * hundred unpacked, and holding it in memory to look at 512-byte headers would
 * be paying the whole cost of extraction to avoid extracting.
 */
export async function readArchiveEntries(archive: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []

  // Annotated rather than inferred: `Buffer.alloc` narrows to `Buffer<ArrayBuffer>`
  // while `Buffer.concat` widens to `Buffer<ArrayBufferLike>`, so an inferred
  // accumulator cannot be reassigned from its own concatenation.
  let pending: Buffer = Buffer.alloc(0)
  /** Bytes of the current entry's payload still to be skipped or collected. */
  let remaining = 0
  /** Set when the payload being read belongs to a header that renames its successor. */
  let collecting: typeof PAX_EXTENDED | typeof GNU_LONG_NAME | typeof GNU_LONG_LINK | null = null
  let collected: Buffer = Buffer.alloc(0)
  let overrideName: string | null = null
  let overrideLink: string | null = null
  let sawEnd = false

  const consume = (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

    for (;;) {
      if (remaining > 0) {
        const take = Math.min(remaining, pending.length)
        if (take === 0) return
        if (collecting !== null) collected = Buffer.concat([collected, pending.subarray(0, take)])
        pending = pending.subarray(take)
        remaining -= take
        if (remaining > 0) return

        if (collecting === GNU_LONG_NAME) overrideName = trimNul(collected, 0, collected.length)
        else if (collecting === GNU_LONG_LINK)
          overrideLink = trimNul(collected, 0, collected.length)
        else if (collecting === PAX_EXTENDED) {
          overrideName = paxValue(collected, 'path') ?? overrideName
          overrideLink = paxValue(collected, 'linkpath') ?? overrideLink
        }
        collecting = null
        collected = Buffer.alloc(0)
        continue
      }

      if (pending.length < BLOCK) return
      const header = pending.subarray(0, BLOCK)
      pending = pending.subarray(BLOCK)

      // Two consecutive zero blocks end the archive; one is enough to stop
      // reading, because everything after it is padding by definition.
      if (header.every((byte) => byte === 0)) {
        sawEnd = true
        return
      }

      const typeflag = String.fromCharCode(header[TYPEFLAG] ?? 0)
      const size = readSize(header)
      const padded = Math.ceil(size / BLOCK) * BLOCK

      if (typeflag === PAX_EXTENDED || typeflag === GNU_LONG_NAME || typeflag === GNU_LONG_LINK) {
        collecting = typeflag
        collected = Buffer.alloc(0)
        remaining = padded
        // The declared size is the record length; the padding beyond it is not
        // part of the payload, so it is trimmed when the payload is read back.
        continue
      }
      if (typeflag === PAX_GLOBAL) {
        remaining = padded
        continue
      }

      const prefix = trimNul(header, PREFIX.at, PREFIX.length)
      const base = trimNul(header, NAME.at, NAME.length)
      const path = overrideName ?? (prefix === '' ? base : `${prefix}/${base}`)
      const linkname = overrideLink ?? trimNul(header, LINKNAME.at, LINKNAME.length)
      overrideName = null
      overrideLink = null

      entries.push({ path, typeflag: typeflag === '\0' ? '0' : typeflag, linkname })
      remaining = padded
    }
  }

  await pipeline(createReadStream(archive), createGunzip(), async function* (source) {
    for await (const chunk of source) {
      if (!sawEnd) consume(chunk as Buffer)
      // Drained rather than returned: ending the iterator early makes the
      // pipeline reject with ERR_STREAM_PREMATURE_CLOSE, which reads as a
      // corrupt archive rather than as a finished one.
    }
    // A generator in a pipeline must yield something or the destination never
    // finishes; nothing downstream reads it.
    yield Buffer.alloc(0)
  })

  return entries
}

/**
 * The path an entry would land on, relative to the extraction root, or `null` if
 * it would land anywhere else.
 *
 * `posix.normalize` collapses `.` and `..` textually, which is the whole point:
 * the question is not whether the string contains `..` — `a/../b` is harmless —
 * but whether the collapsed result still begins inside the root. A leading `/`
 * and a Windows drive letter are refused before normalising, because neither is
 * a relative path at all and normalising one would quietly make it look like
 * one.
 */
export function containedPath(candidate: string): string | null {
  if (candidate === '') return null
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return null
  // Backslashes are a path separator on Windows, so an entry using them would be
  // one directory to this check and several to the extractor.
  if (candidate.includes('\\')) return null
  const normalised = posix.normalize(candidate)
  if (normalised === '..' || normalised.startsWith('../')) return null
  return normalised
}

/**
 * Every reason this archive may not be extracted, or an empty list.
 *
 * A list rather than a throw on the first one, because the interesting case at a
 * review gate is "what is wrong with this artifact", and a validator that stops
 * at the first entry answers that one refusal at a time.
 *
 * The link rule is the one the CVE is about, and it is checked on the **resolved
 * target**: a symlink is resolved relative to its own directory, a hard link
 * relative to the root, and either escaping is a refusal. `..` inside a link
 * target is exactly how an entry lands outside a root whose name looked fine.
 */
export function archiveRefusals(entries: readonly ArchiveEntry[]): string[] {
  const refusals: string[] = []
  for (const entry of entries) {
    const contained = containedPath(entry.path)
    if (contained === null) {
      refusals.push(`entry escapes the extraction root: ${entry.path}`)
      continue
    }
    if (entry.typeflag !== SYM_LINK && entry.typeflag !== HARD_LINK) continue

    /*
     * A symlink's target is resolved against the directory the link sits in; a
     * hard link's is resolved against the archive root. Getting these the same
     * way round is the difference between refusing a real escape and refusing a
     * legitimate relative link.
     */
    const from = entry.typeflag === SYM_LINK ? posix.dirname(contained) : '.'
    const target = entry.linkname.startsWith('/')
      ? entry.linkname
      : posix.join(from, entry.linkname)
    if (containedPath(target) === null) {
      refusals.push(`link target escapes the extraction root: ${entry.path} -> ${entry.linkname}`)
    }
  }
  return refusals
}

/** Whether an entry list contains anything at all, so an empty archive is not a silent success. */
export function archiveIsEmpty(entries: readonly ArchiveEntry[]): boolean {
  return entries.every((entry) => entry.typeflag === DIRECTORY)
}
