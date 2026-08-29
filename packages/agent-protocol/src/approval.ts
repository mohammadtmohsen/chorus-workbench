import type { AgentId, ApprovalId } from '@chorus/shared'

/**
 * The four things an agent can ask permission for. Both providers' native
 * approval shapes collapse onto this so one card renders all of them (plan §4.2).
 */
export type ApprovalKind =
  'command' | 'fileChange' | 'permissionGrant' | 'mcpToolCall' | 'editorEdit'

export interface ApprovalRequestBase {
  readonly id: ApprovalId
  readonly agentId: AgentId
  readonly kind: ApprovalKind
  readonly reason?: string
  /** Wall-clock deadline. Chorus owns this — neither provider imposes one (plan §2.2). */
  readonly expiresAt: number
  /**
   * The provider's own prompt sentence — "Claude wants to read foo.txt".
   *
   * Preferred over anything Chorus composes, because the provider knows what it
   * is about to do and we are inferring it from a tool name and an argument
   * bag. Optional because not every provider renders one.
   */
  readonly title?: string
  /** A subtitle from the provider, spelling out what the permission covers. */
  readonly description?: string
  /**
   * The path that triggered this, when one did — a Bash command reaching
   * outside the allowed directories names it here and nowhere else.
   */
  readonly blockedPath?: string
  /** Why this is being asked at all, in the provider's words. */
  readonly decisionReason?: string
}

export interface CommandApproval extends ApprovalRequestBase {
  readonly kind: 'command'
  readonly command: readonly string[]
  readonly cwd: string
  readonly withNetwork: boolean
}

export interface FileChangeApproval extends ApprovalRequestBase {
  readonly kind: 'fileChange'
  readonly files: readonly { readonly path: string; readonly patch: string }[]
}

export interface PermissionGrantApproval extends ApprovalRequestBase {
  readonly kind: 'permissionGrant'
  readonly cwd: string
  readonly requested: {
    readonly filesystem?: readonly string[]
    readonly network?: boolean
  }
  /**
   * The tool that asked, when the provider names one.
   *
   * This is the catch-all kind, so without it the card has nothing to say but
   * the kind itself — which is how `Task`, `WebFetch` and `TodoWrite` all came
   * to render as "claude wants approval / permissionGrant".
   */
  readonly toolName?: string
  /** The tool's arguments, so the card can show what was actually asked for. */
  readonly input?: Readonly<Record<string, unknown>>
}

/**
 * Outward-facing by nature — Slack, Jira, GitHub. Unlike a file edit, these are
 * not recoverable with `git checkout`, which is why a permission profile may
 * never auto-allow one (plan §2.6).
 */
export interface McpToolCallApproval extends ApprovalRequestBase {
  readonly kind: 'mcpToolCall'
  readonly serverName: string
  readonly toolName: string
  /** Human-readable target: "#engineering", "ACME-1234", "owner/repo#42". */
  readonly target?: string
  readonly input: Readonly<Record<string, unknown>>
}

/**
 * An agent changing a file in the user's open editor — Phase 6e.
 *
 * **Its own kind rather than a `fileChange` with a patch**, because a person
 * answering this needs two things a file change cannot express. The **version**
 * says which state of the file the agent was looking at, which is what makes a
 * conflict comprehensible rather than mysterious. And the **range** says where,
 * which for a one-line change in a thousand-line file is the difference between
 * an answerable question and a shrug.
 *
 * The patch is a unified diff over the replaced range only, so the existing
 * `parseDiff` renders it exactly as it renders every other diff in the
 * transcript. That is why `FileDiff` survived Phase 9 — it is a decision
 * surface, answerable with the editor switched off, and not a review surface.
 */
export interface EditorEditApproval extends ApprovalRequestBase {
  readonly kind: 'editorEdit'
  /** Project-relative. An absolute path is not expressible upstream. */
  readonly path: string
  /** The editor model version the agent wrote this against. */
  readonly version: number
  readonly range: {
    readonly startLine: number
    readonly startColumn: number
    readonly endLine: number
    readonly endColumn: number
  }
  /** Unified diff of the replaced range, for `parseDiff`. */
  readonly patch: string
}

export type ApprovalRequest =
  | CommandApproval
  | FileChangeApproval
  | PermissionGrantApproval
  | McpToolCallApproval
  | EditorEditApproval

/**
 * How long an answer lasts.
 *
 * `always` outlives the app, and exists because of the one case where `session`
 * was a promise Chorus could not keep: an MCP tool call may never be
 * auto-decided, so "allow for this session" on one was silently refused and the
 * same tool asked again on every call, in every session, forever. A person who
 * has answered "yes, this tool, always" has made a decision; forgetting it is
 * not caution, it is amnesia.
 *
 * It is still never granted by a profile rule or inferred from a tool's
 * annotations — only by someone pressing the button.
 */
export type ApprovalScope = 'once' | 'session' | 'always'

export type ApprovalDecision =
  | {
      readonly outcome: 'allow'
      readonly scope: ApprovalScope
      readonly updatedInput?: Readonly<Record<string, unknown>>
    }
  | { readonly outcome: 'deny'; readonly message: string; readonly interrupt?: boolean }
  | { readonly outcome: 'cancel' }
  /** Deadline passed with no answer. Always denies — never auto-allows (plan §4.4). */
  | { readonly outcome: 'timeout' }

/** True for approval kinds that a permission profile is forbidden from auto-allowing. */
export function requiresExplicitUserDecision(kind: ApprovalKind): boolean {
  /*
   * `editorEdit` joins `mcpToolCall` here, and for a sharper reason than the
   * general "outward-facing" one. This kind changes what is on the person's
   * screen, in a buffer they may be typing in. A profile that could pre-approve
   * it would mean opening a file and finding it already different — and the
   * whole argument for editing the model rather than the file is that the person
   * stays in control of their own editor. Being asked is that control.
   */
  return kind === 'mcpToolCall' || kind === 'editorEdit'
}
