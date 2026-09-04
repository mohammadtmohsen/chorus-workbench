import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolveWithinRoot } from '@chorus/workspace'
import type { ApprovalRequest } from '@chorus/agent-protocol'

/**
 * What a proposed edit would leave on disk, held while the card is on screen.
 *
 * **Nothing here ever reaches the event log.** `conversation-service` appends an
 * approval as `request: event.request`, typed `z.unknown()`, so anything hung on
 * the request is persisted whole — for an `Edit` that would be the entire
 * surrounding file, and on a `.env` the secret. The preview is therefore
 * *pulled* through `previewFileChange` and held here in memory, never carried.
 *
 * Main owns it because main is the only thing that may read a filesystem, and
 * because the adapter must not learn one: the adapter holds the tool input and
 * computes from it, and is handed the current text rather than fetching it.
 */

/**
 * Above this a file is not previewed at all.
 *
 * Checked with `stat` **before** the read, not after — a cap enforced by
 * discarding what was already loaded has not bounded anything. The number is a
 * source file's order of magnitude; a diff of something larger is not a thing
 * anybody reads in a card.
 */
const MAX_PREVIEW_BYTES = 512 * 1024

export interface EditPreview {
  readonly approvalId: string
  readonly projectRoot: string
  /** Project-relative, for the editor's tab label. */
  readonly path: string
  readonly absolutePath: string
  /**
   * The file as it stood when the card was raised, or `null` when there was no
   * file.
   *
   * `null` and `''` are different and are kept that way: a `Write` creating a
   * file has no left-hand side at all, while an existing empty file has one that
   * happens to be empty. Rendering them the same would misdescribe the edit.
   */
  readonly before: string | null
  /** Digest of `before`, or `'absent'`. The preflight compares against this. */
  readonly digest: string
  /** What the edit would produce. Absent when the adapter could not say. */
  readonly proposed: string
}

const digestOf = (text: string | null): string =>
  text === null ? 'absent' : createHash('sha256').update(text, 'utf8').digest('hex')

/** Reads a file for preview, or says why it cannot. Never throws. */
async function readForPreview(
  absolutePath: string
): Promise<{ text: string | null; tooBig: boolean }> {
  try {
    const info = await stat(absolutePath)
    if (info.size > MAX_PREVIEW_BYTES) return { text: null, tooBig: true }
    return { text: await readFile(absolutePath, 'utf8'), tooBig: false }
  } catch {
    // Absent is the ordinary case of a `Write` creating a file, and it is not a
    // failure — it is the left-hand side being empty.
    return { text: null, tooBig: false }
  }
}

export class EditPreviews {
  private readonly live = new Map<string, EditPreview>()

  /**
   * Builds the preview for a queued approval, if one can be built.
   *
   * **Never throws and never rejects.** It is driven from the callback fired on
   * the synchronous path that pumps provider events, so a failure here has to
   * cost the preview and nothing else.
   */
  async capture(options: {
    readonly request: ApprovalRequest
    readonly projectRoot: string
    readonly propose: (approvalId: string, currentText: string | null) => string | null
  }): Promise<EditPreview | null> {
    try {
      const { request, projectRoot } = options
      if (request.kind !== 'fileChange') return null
      const first = request.files[0]
      // One file, deliberately: every edit tool names exactly one, and a request
      // naming several is a shape this cannot describe honestly in one diff.
      if (first === undefined || request.files.length !== 1) return null

      const resolved = resolveWithinRoot(projectRoot, first.path)
      if (!resolved.ok) return null
      const absolutePath = resolved.value

      const { text, tooBig } = await readForPreview(absolutePath)
      if (tooBig) return null

      const proposed = options.propose(request.id, text)
      // `null` is the adapter refusing to guess — an input shape it does not
      // recognise, or an `old_string` that is absent or ambiguous. No preview.
      if (proposed === null) return null

      const preview: EditPreview = {
        approvalId: request.id,
        projectRoot,
        path: relativeTo(projectRoot, absolutePath),
        absolutePath,
        before: text,
        digest: digestOf(text),
        proposed,
      }
      this.live.set(request.id, preview)
      return preview
    } catch {
      return null
    }
  }

  get(approvalId: string): EditPreview | undefined {
    return this.live.get(approvalId)
  }

  /**
   * Is the file still what the person was shown?
   *
   * A **preflight**, not a guarantee: another writer can change the file between
   * this check and the provider's write, and nothing here can close that. What
   * it does close is the case where the file moved while the card sat on screen,
   * which is the one long enough to matter.
   *
   * `true` when there is no preview to check against — an approval nobody
   * previewed is not stale, it is simply unpreviewed.
   */
  async stillCurrent(approvalId: string): Promise<boolean> {
    const preview = this.live.get(approvalId)
    if (preview === undefined) return true
    try {
      const { text, tooBig } = await readForPreview(preview.absolutePath)
      if (tooBig) return false
      return digestOf(text) === preview.digest
    } catch {
      return false
    }
  }

  /** The card is settled: the preview is spent and must not outlive it. */
  release(approvalId: string): EditPreview | undefined {
    const preview = this.live.get(approvalId)
    this.live.delete(approvalId)
    return preview
  }

  /** Drops everything for a conversation whose session is going away. */
  releaseAll(): void {
    this.live.clear()
  }
}

const relativeTo = (root: string, absolute: string): string =>
  absolute.startsWith(root) ? absolute.slice(root.length).replace(/^[/\\]/, '') : absolute
