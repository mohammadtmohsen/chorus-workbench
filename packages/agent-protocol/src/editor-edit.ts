/**
 * The capability an agent uses to change a file **in the editor** — Phase 6e.
 *
 * It lives here, beside the event union, because it is the second thing both
 * providers have to agree on. The plan's wording is "a provider-neutral
 * `EditorEdit` request distinct from direct filesystem writes", and neutrality
 * has to be expressed somewhere neither adapter owns — otherwise the Claude
 * shape becomes the contract by accident and the Codex one is written to match
 * an implementation rather than to a definition.
 *
 * **What makes it distinct from a file write**, and the reason it exists at all:
 * a write goes to disk, and if the person has unsaved changes in that file it
 * either destroys their work or is destroyed by their next save. This goes to
 * the *model* — so it joins their undo stack, marks the file dirty rather than
 * saving it, and updates the SCM view and diagnostics as a consequence rather
 * than by being told to.
 *
 * **Nothing here is an event.** The request and its outcome are how an edit is
 * performed; what gets recorded in the log is the approval and the change, which
 * already have their own payloads. `CLAUDE.md`'s test applies — a model version
 * read back a week later is meaningless.
 */

/**
 * A range in the editor's own coordinates: 1-based lines, 1-based columns, end
 * exclusive of nothing — the same convention `ITextModel` uses.
 *
 * Not 0-based, and not a byte offset. Both alternatives would put a conversion
 * at every boundary this crosses, and a conversion that exists in four places is
 * a conversion that is wrong in one of them.
 */
export interface EditorEditRange {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

export interface EditorEditRequest {
  /**
   * Project-relative, POSIX separators. An absolute path is not expressible on
   * purpose: the root is the host's to know, and a path that could name anything
   * on the machine would make this a filesystem capability wearing an editor's
   * name.
   */
  readonly path: string
  /**
   * The model version this edit was written against.
   *
   * The safety property, and the reason an agent must read before it writes. If
   * the model has moved on — the person typed, an earlier edit in the same turn
   * landed — the edit is refused rather than applied, and the agent is told the
   * current version so it can re-read. Without this, an agent working from a
   * stale read silently overwrites whatever happened in between, which is the
   * failure that makes people stop trusting an assistant with their editor.
   */
  readonly baseVersion: number
  readonly range: EditorEditRange
  /**
   * What the agent believes is currently in that range.
   *
   * Two jobs, and the second is the one that made it necessary. It is checked
   * against the model before anything moves, so a request with the right version
   * but the wrong *range* — an off-by-one line, a stale column — is refused
   * instead of replacing the wrong text. Version alone cannot catch that: the
   * version is right.
   *
   * And it is what makes an approval showable. The request otherwise carries
   * only the replacement, and "here is what it will say afterwards" is not a
   * diff — there is nothing to compare it against, so a person is asked to
   * approve a change they cannot see.
   */
  readonly oldText: string
  readonly newText: string
}

/**
 * Why an edit did not happen, and each arm is a different thing for the agent to
 * do next — which is the whole reason this is not a boolean.
 *
 * `conflict` means re-read and try again. `outside-project` means the path was
 * wrong. `no-editor` means this project has no workbench open, so there is no
 * model to edit and no undo stack to join — the host refuses rather than
 * silently writing the file, because a silent write is exactly what this
 * capability replaces.
 */
export type EditorEditRefusal =
  'conflict' | 'outside-project' | 'no-editor' | 'unopenable' | 'failed'

export type EditorEditOutcome =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false
      readonly refusal: EditorEditRefusal
      readonly message: string
      /** Where the model actually is, when that is known. Lets a caller re-read. */
      readonly version: number | null
    }

/**
 * What a host provides and an adapter offers to its agent.
 *
 * Injected rather than imported, because the implementation reaches a
 * `WebContentsView` and no adapter may depend on Electron. The adapter's job is
 * to expose it in whatever shape its provider understands — an in-process MCP
 * tool for the Claude SDK, and a transport-backed one for Codex — while this
 * signature stays the same for both.
 */
export type EditorEditCapability = (
  /**
   * Which project's editor. Passed rather than closed over because an adapter is
   * one object serving every conversation, while a surface belongs to one
   * project — so the root is a property of the *call*, not of the host.
   */
  projectRoot: string,
  request: EditorEditRequest
) => Promise<EditorEditOutcome>
