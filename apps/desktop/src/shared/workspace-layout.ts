import { z } from 'zod'

/** A leaf is one editor group; branches describe how groups divide the workspace. */
export type WorkspaceLayoutNode =
  | { kind: 'leaf'; paneId: string }
  | {
      kind: 'branch'
      orientation: 'row' | 'column'
      children: WorkspaceLayoutNode[]
      sizes: number[]
    }

export const WorkspaceLayoutNode: z.ZodType<WorkspaceLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('leaf'), paneId: z.string() }),
    z.object({
      kind: z.literal('branch'),
      orientation: z.enum(['row', 'column']),
      children: z.array(WorkspaceLayoutNode),
      sizes: z.array(z.number()),
    }),
  ])
)

export const WorkspacePane = z.object({
  id: z.string(),
  /** Conversation ids, in the order their tabs appear in this pane. */
  tabs: z.array(z.string()),
  activeTabId: z.string().nullable(),
})
export type WorkspacePane = z.infer<typeof WorkspacePane>

/**
 * Renderer-owned workspace state that is safe to write beside the open-session
 * note. It contains no transcript or draft content.
 */
/**
 * Matches `--sidebar` in `styles.css`, and the clamp the resize handle uses.
 *
 * Narrowed from 336/240/640 when the drawer stopped being the daily state. It
 * holds names, a search field and one overflow button now — everything that
 * used to need 336px moved to the preview or the menu — and the ceiling is a
 * ceiling because a temporary management panel should not be able to take half
 * the window and stay there. A width persisted from the old range is clamped
 * into this one on the way in.
 */
export const SIDEBAR_WIDTH = { default: 248, min: 220, max: 320 } as const

/**
 * How wide Chorus sits beside the workbench in a project pane.
 *
 * A wider range than the sidebar's because the two sides trade against each
 * other: 360 is about the narrowest a transcript reads at, and past 720 the
 * editor starts wrapping code, which is the failure the fixed split shipped
 * with. One width for every pane rather than one each — panes are a way of
 * seeing several projects at once, and a divider that meant something different
 * in each would make the layout unreadable.
 */
export const CHORUS_WIDTH = { default: 420, min: 300, max: 720 } as const

/**
 * Matches `--terminal-height` and the clamp the panel's grip uses.
 *
 * 212 rather than 240: in a 900px window the panel sits between a transcript
 * and a composer that is itself 180px, and 240 left the transcript with less
 * room than the two things framing it. 212 holds ten lines of shell output at
 * the terminal's own size, which is what the approved composition shows.
 */
export const TERMINAL_HEIGHT = { default: 212, min: 96, max: 720 } as const

/**
 * One terminal in a panel's roster. **Not the shell** — that lives in main.
 *
 * An object rather than a bare id string, and that is a deliberate hedge rather
 * than speculative generality: every field added later is defaulted and
 * therefore cheap, but changing an array's *element type* from `string` to an
 * object is the migration that is not. One field now is the shape that extends.
 *
 * `id` is permissive on purpose — see `normalizeTerminalPanel`. A stricter
 * schema would reject a hand-edited or duplicated roster, and a rejected
 * `WorkspaceSnapshot` does not lose the roster, it loses **every open
 * conversation**. Duplicates and blanks are repaired, never refused.
 */
export const TerminalTab = z.object({ id: z.string() })
export type TerminalTab = z.infer<typeof TerminalTab>

/** One panel's visibility, size and roster. Not the shells — those are in main. */
export const TerminalPanelState = z.object({
  open: z.boolean().default(false),
  height: z.number().default(TERMINAL_HEIGHT.default),
  /*
   * Which terminals this panel holds, in tab order.
   *
   * **Defaulted, and this is the line that can lose someone's work.** See the
   * warning on `WorkspaceSnapshot` below: a required field here makes
   * `parseOpenProjects` reject the whole envelope, and it returns
   * `{ projects: [] }` — every open conversation gone, once, silently, with no
   * error anywhere. `open-projects.test.ts` carries a fixture per defaulted
   * field for exactly this reason.
   *
   * A panel written before the roster existed parses to `[]` and is backfilled
   * one tab by `normalizeTerminalPanel` in the renderer — main only applies
   * schema defaults and does not repair.
   */
  tabs: z.array(TerminalTab).default([]),
  /** Which of `tabs` is on screen. Repaired, not trusted, when it names none. */
  activeId: z.string().nullable().default(null),
})
export type TerminalPanelState = z.infer<typeof TerminalPanelState>

/**
 * A panel nobody has opened yet.
 *
 * Exported and shared, because it used to be copied into `store.ts` and
 * `hooks.ts` as well — three literals of the same shape, in three files, and the
 * roster had to be added to all of them. One definition beside the schema it
 * mirrors is one place for the next field to land.
 *
 * Frozen so a consumer cannot mutate the shared default: it is handed out as the
 * fallback for *every* conversation with no panel, so a stray write would give
 * all of them the same one.
 */
export const CLOSED_TERMINAL_PANEL: TerminalPanelState = Object.freeze({
  open: false,
  height: TERMINAL_HEIGHT.default,
  tabs: [],
  activeId: null,
})

/**
 * How one project arranges its conversations, and it is **the same shape as the
 * workspace's own pane tree**.
 *
 * It began as a row of at most two groups, which was enough for "two side by
 * side" and nothing else. The instruction that replaced it was "exactly the same
 * as project level, from all directions" — and the only way to guarantee two
 * behaviours are identical is for them to be one behaviour. So this is a
 * `layout` / `panes` / `focusedPaneId` triple, structurally a `PaneTree`, and
 * every operation on it is the function the outer level already uses.
 *
 * **A "pane" here is a conversation group.** The word means "a container of tabs
 * in a tree" at both levels — the same sense VS Code uses for editor groups —
 * which is why nothing is renamed: a function that splits a tree does not care
 * what its leaves hold.
 *
 * Absent means "never arranged". `reconcileConversationGroups` builds the
 * default from the live conversation list, so a project nobody has split has no
 * entry and cannot drift out of step with what is running.
 */
export const ConversationArrangement = z.object({
  layout: WorkspaceLayoutNode.nullable(),
  panes: z.record(z.string(), WorkspacePane),
  focusedPaneId: z.string().nullable(),
})
export type ConversationArrangement = z.infer<typeof ConversationArrangement>

export const WorkspaceSnapshot = z.object({
  layout: WorkspaceLayoutNode.nullable(),
  panes: z.record(z.string(), WorkspacePane),
  focusedPaneId: z.string().nullable(),
  sidebarHidden: z.boolean().default(false),
  /*
   * Defaulted rather than required, so a workspace written before the sidebar
   * could be resized still parses and simply opens at the width it had.
   */
  sidebarWidth: z.number().default(SIDEBAR_WIDTH.default),
  /**
   * The workbench/Chorus divider, **per project**.
   *
   * One number for the whole app was the first shape, and it was wrong the
   * moment two projects could be on screen: dragging the divider in one pane
   * moved it in every other, because there was only ever one value to move.
   *
   * Keyed by project rather than by pane, matching `workbenchHidden`. A pane is
   * ephemeral — created and destroyed by splits, its id reissued by
   * `nextPaneId`, and pruned by `reconcileWorkspace` — so a width keyed by one
   * would be lost every time the arrangement changed. A project is the stable
   * thing, and carrying its divider between panes is the behaviour somebody
   * would expect from a setting that belongs to the project.
   *
   * Renamed rather than retyped. `chorusWidth` was a `number` in every snapshot
   * already written, and a schema that expects a record where a number is stored
   * fails to parse — which, per the warning below, does not lose a *width*, it
   * loses **every open conversation**. Unknown keys are stripped rather than
   * rejected, so the old field is simply ignored and each project opens at the
   * default once.
   */
  chorusWidths: z.record(z.string(), z.number()).default({}),
  /**
   * Which projects have their workbench hidden, by project id.
   *
   * Hidden rather than shown, so the default — an absent key, an empty record, a
   * project nobody has toggled — is the editor being *on*. That matters more
   * than symmetry: this is the project-first workbench, and a shape whose empty
   * value means "no editors anywhere" would open a fresh install with the thing
   * it is named after switched off.
   *
   * Defaulted, under the warning above: a required field here would make
   * `parseOpenProjects` reject the whole snapshot and lose every open
   * conversation.
   */
  workbenchHidden: z.record(z.string(), z.boolean()).default({}),
  /*
   * Both defaulted, and this is the sharpest trap in the file.
   *
   * `parseOpenProjects` returns `{ projects: [] }` when this schema fails, so a
   * required field here loses **every open conversation**, not merely the
   * layout, once, with no error anywhere. `sidebarWidth` above is the precedent
   * and carries the same warning for the same reason.
   *
   * The trap got sharper rather than softer when the file changed. The old
   * parser had a legacy bare-array fallback, which was itself no use — it failed
   * too — but its existence at least suggested a second chance. There is no
   * fallback now, by design, so a schema failure is final on the first attempt.
   *
   * Separate fields rather than one map keyed by conversation id, matching
   * `TerminalService` in main and the store in the renderer: the global panel
   * belongs to no conversation, and anything walking sessions must not reach it.
   */
  terminals: z.record(z.string(), TerminalPanelState).default({}),
  globalTerminal: TerminalPanelState.default(CLOSED_TERMINAL_PANEL),
  /**
   * How each project arranges its conversations inside its own Chorus column.
   *
   * The outer layout is a tree of panes keyed by project. This is one level
   * further in: a project's conversations, which until now were a strip of
   * chips where exactly one was on screen. Splitting here puts two of them side
   * by side **sharing the project's one editor** — the workbench is per project
   * and stays whole, so no second `WebContentsView` and no second REH
   * connection.
   *
   * **A row of at most two groups, not a tree**, and that is a decision rather
   * than a first step. The column has a 300px minimum and lives beside an
   * editor, so two is what actually fits; arbitrary nesting already exists one
   * level out, where a pane can be split four ways. A third conversation side by
   * side is expressible today — split the *pane* — and it is the right level for
   * it, because at that point you want two editors too.
   *
   * Absent means "never arranged", and it is not the same as a single empty
   * group: `reconcileConversationGroups` builds the default arrangement from the
   * live conversation list, so a project nobody has split has no entry at all
   * and cannot drift out of step with what is actually running.
   *
   * Defaulted, under the same warning as every field above: a required record
   * here would make `parseOpenProjects` reject the snapshot and lose every open
   * conversation, not merely an arrangement.
   */
  conversationGroups: z.record(z.string(), ConversationArrangement).default({}),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>
