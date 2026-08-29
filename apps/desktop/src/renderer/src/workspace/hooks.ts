import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@chorus/shared'
import type { SessionRowState } from './session-row.js'
import {
  CHORUS_WIDTH,
  CLOSED_TERMINAL_PANEL,
  type ConversationArrangement,
  type TerminalPanelState,
  type WorkspaceLayoutNode,
  type WorkspacePane,
} from '../../../shared/workspace-layout.js'
import { leafPaneIds, tabLocation } from './layout.js'
import {
  useWorkspaceStore,
  type SessionPulse,
  type WorkspaceActions,
  type WorkspaceStore,
} from './store.js'

/**
 * The seam between the store and the views.
 *
 * No component subscribes to `useWorkspaceStore` directly during render; it
 * comes through one of these instead. Two things buy that indirection:
 *
 * - **Cost.** A whole-store subscription re-renders on every streamed pulse,
 *   and with a live transcript mounted in the tree that is the most expensive
 *   re-render in the app. Each hook here subscribes to the narrowest slice its
 *   caller actually reads.
 * - **Reach.** The store's shape stays free to change without a sweep through
 *   the views.
 *
 * Imperative reads inside event handlers — `useWorkspaceStore.getState()` — are
 * a different thing and stay where they are. They subscribe to nothing, so they
 * cost nothing and cannot go stale: the read happens when the handler fires.
 */

/*
 * Actions are referentially stable — the initialiser defines them once and no
 * `set` call replaces them — so this shallow compare never reports a change and
 * the subscription never re-renders anyone. Selecting them as a group rather
 * than capturing the object once at module load keeps that an optimisation
 * rather than an assumption: if an action ever did get recreated, this notices.
 */
function selectActions(state: WorkspaceStore): WorkspaceActions {
  const {
    hydrate,
    openProject,
    clearConversationUnread,
    showConversation,
    showConversationIn,
    focusConversationGroup,
    adoptConversation,
    splitConversation,
    placeConversation,
    closeConversationTab,
    setConversationSizes,
    activateTab,
    focusPane,
    closeTab,
    closePane,
    reorderTab,
    moveTab,
    splitTab,
    placeSession,
    splitWithSession,
    setPlanning,
    setBranchSizes,
    equalizeBranch,
    removeSession,
    removeProject,
    setSidebarHidden,
    setSidebarWidth,
    setChorusWidth,
    toggleWorkbench,
    toggleGlobalTerminal,
    setGlobalTerminalOpen,
    setGlobalTerminalHeight,
    toggleSessionTerminal,
    setSessionTerminalHeight,
    addGlobalTerminal,
    addSessionTerminal,
    removeGlobalTerminalTab,
    removeSessionTerminalTab,
    activateGlobalTerminal,
    activateSessionTerminal,
    ingestEvents,
    ingestContextUsage,
    ingestTasks,
    ingestActivity,
  } = state
  return {
    hydrate,
    openProject,
    clearConversationUnread,
    showConversation,
    showConversationIn,
    focusConversationGroup,
    adoptConversation,
    splitConversation,
    placeConversation,
    closeConversationTab,
    setConversationSizes,
    activateTab,
    focusPane,
    closeTab,
    closePane,
    reorderTab,
    moveTab,
    splitTab,
    placeSession,
    splitWithSession,
    setPlanning,
    setBranchSizes,
    equalizeBranch,
    removeSession,
    removeProject,
    setSidebarHidden,
    setSidebarWidth,
    setChorusWidth,
    toggleWorkbench,
    toggleGlobalTerminal,
    setGlobalTerminalOpen,
    setGlobalTerminalHeight,
    toggleSessionTerminal,
    setSessionTerminalHeight,
    addGlobalTerminal,
    addSessionTerminal,
    removeGlobalTerminalTab,
    removeSessionTerminalTab,
    activateGlobalTerminal,
    activateSessionTerminal,
    ingestEvents,
    ingestContextUsage,
    ingestTasks,
    ingestActivity,
  }
}

export function useWorkspaceActions(): WorkspaceActions {
  return useWorkspaceStore(useShallow(selectActions))
}

export interface WorkspaceLayoutView {
  readonly layout: WorkspaceLayoutNode | null
  readonly focusedPaneId: string | null
}

/**
 * The tree and which pane owns the caret — everything the shell needs to draw
 * the arrangement, and nothing about what is inside it.
 */
export function useWorkspaceLayout(): WorkspaceLayoutView {
  return useWorkspaceStore(
    useShallow((state: WorkspaceStore) => ({
      layout: state.layout,
      focusedPaneId: state.focusedPaneId,
    }))
  )
}

/**
 * One pane's tabs. Undefined once the pane has been normalised away, which a
 * caller mid-render can still be holding an id for.
 */
export function usePane(paneId: string): WorkspacePane | undefined {
  return useWorkspaceStore((state) => state.panes[paneId])
}

/**
 * The global terminal panel's visibility and height.
 *
 * A narrow selector like every other hook here: subscribing to the whole store
 * would re-render the workspace on every transcript delta, which is the reason
 * this file exists at all.
 */
export function useGlobalTerminal(): TerminalPanelState {
  return useWorkspaceStore((state) => state.globalTerminal)
}

/**
 * One conversation's panel.
 *
 * `CLOSED_TERMINAL_PANEL` is a module constant rather than an object literal in the
 * selector: returning a fresh object each call would make the selector never
 * equal itself and re-render the pane on every store change.
 */
export function useSessionTerminal(conversationId: string): TerminalPanelState {
  return useWorkspaceStore((state) => state.terminals[conversationId] ?? CLOSED_TERMINAL_PANEL)
}

/**
 * One project's conversation arrangement, or undefined when it has none.
 *
 * Undefined is a real answer — a project with no conversations has no
 * arrangement at all — and the column renders nothing rather than inventing a
 * group. See the schema's own note on why absent differs from empty.
 */
export function useConversationGroups(
  projectId: string | null
): ConversationArrangement | undefined {
  return useWorkspaceStore((state) =>
    projectId === null ? undefined : state.conversationGroups[projectId]
  )
}

export function useSidebarHidden(): boolean {
  return useWorkspaceStore((state) => state.sidebarHidden)
}

export function useSidebarWidth(): number {
  return useWorkspaceStore((state) => state.sidebarWidth)
}

/** Whether this project's workbench is on screen. Absent means on. */
export function useWorkbenchShown(projectId: string | null): boolean {
  return useWorkspaceStore((state) =>
    projectId === null ? false : state.workbenchHidden[projectId] !== true
  )
}

/**
 * One project's workbench/Chorus divider, falling back to the default.
 *
 * The fallback lives here rather than in the store so that a project which has
 * never been dragged holds *no* entry — the record then says exactly which
 * projects somebody has arranged, and seeding every project with 420 on first
 * sight would make that unanswerable.
 */
export function useChorusWidth(projectId: string | null): number {
  return useWorkspaceStore((state) =>
    projectId === null
      ? CHORUS_WIDTH.default
      : (state.chorusWidths[projectId] ?? CHORUS_WIDTH.default)
  )
}

/**
 * The **project** showing in the focused pane.
 *
 * Renamed from `useActiveConversationId`, which is what it was called while a
 * tab was a conversation. Phase 3 re-keyed `activeTabId` to a project id and
 * left the name, so the one caller — the rail, comparing it against
 * `session.conversationId` to mark the active tile — silently stopped matching
 * anything. A wrong name survives a re-key in a way a wrong type does not.
 */
export function useActiveProjectId(): string | null {
  return useWorkspaceStore((state) =>
    state.focusedPaneId === null ? null : (state.panes[state.focusedPaneId]?.activeTabId ?? null)
  )
}

/** Which pane holds a session's tab, or null when it is running off screen. */
export function useTabPaneId(conversationId: string): string | null {
  return useWorkspaceStore((state) => tabLocation(state, conversationId)?.paneId ?? null)
}

export function useSessionPulse(conversationId: string): SessionPulse | undefined {
  return useWorkspaceStore((state) => state.pulses[conversationId])
}

/**
 * What each agent in one conversation says it is doing, and nothing else.
 *
 * Narrow on purpose, for the reason `useWorkingSessionCount` was written down
 * the file: subscribing a mounted transcript to its whole pulse would re-render
 * it on every streamed delta. This changes only when a provider changes its
 * mind about what it is doing, which is a few times a turn.
 *
 * A string rather than the record, so the comparison is by value — a fresh
 * object would compare unequal on every push and defeat the point.
 */
export function useSessionActivity(conversationId: string): string {
  return useWorkspaceStore((state) =>
    Object.entries(state.pulses[conversationId]?.activityByActor ?? {})
      // `null` is a real value on this channel — the agent saying it stopped
      // doing the thing it named — and it belongs out of the string rather than
      // in it, because an absent entry is what the row reads as "no word".
      .filter(([, activity]) => activity !== null)
      .map(([agentId, activity]) => `${agentId}:${String(activity)}`)
      .sort()
      .join(',')
  )
}

/**
 * How many sessions have an agent working in them, and nothing else.
 *
 * This replaced `useAllPulses()` in the shell. The old hook returned the whole
 * pulse map, so *every* streamed delta changed the object it was compared
 * against and re-rendered the workspace — which renders every mounted pane, and
 * therefore every live transcript. A number cannot do that: a delta that does
 * not change the count compares equal and nobody re-renders.
 */
export function useWorkingSessionCount(): number {
  return useWorkspaceStore(
    (state) => Object.values(state.pulses).filter((pulse) => pulse.working.length > 0).length
  )
}

/**
 * What a rail shortcut or a drawer row actually draws.
 *
 * Deliberately not `useSessionPulse`. That returns the whole pulse including
 * `lastSeq`, which changes on every event — so a row re-rendered on each token
 * of a reply it was not showing a single character of. This omits `lastSeq`,
 * the usage totals, the context map and the task list; a shallow compare over
 * the four fields left is what makes an ordinary text delta cost nothing.
 *
 * `working` is a new array each time the store folds an event, so the shallow
 * compare would still report a change — `useShallow` compares one level, and
 * one level down is the array's identity. Joining it into a string is what
 * makes the comparison actually about the value.
 */
export function useSessionRowState(conversationId: string): SessionRowState {
  const flat = useWorkspaceStore(
    useShallow((state: WorkspaceStore) => {
      const pulse = state.pulses[conversationId]
      return {
        approvals: pulse?.approvalIds.length ?? 0,
        questions: pulse?.questionIds.length ?? 0,
        working: (pulse?.working ?? []).join(','),
        unread: pulse?.unread ?? 0,
        failed: pulse?.failed ?? false,
      }
    })
  )
  return useMemo(
    () => ({
      approvals: flat.approvals,
      questions: flat.questions,
      working: flat.working === '' ? [] : (flat.working.split(',') as AgentId[]),
      unread: flat.unread,
      failed: flat.failed,
    }),
    [flat.approvals, flat.questions, flat.working, flat.unread, flat.failed]
  )
}

/**
 * Every pulse in a project, folded into one row.
 *
 * **One subscription per project, not one per conversation.** A project with six
 * conversations rendering six `useSessionRowState` calls would be six store
 * subscriptions to produce one 44px tile, and the rules of hooks make it
 * impossible anyway: the count changes as conversations open and close.
 *
 * `ids` is joined into a string before it is closed over, for the reason the
 * comment above `useSessionRowState` gives — the caller builds a new array every
 * render, and a dependency on its identity would defeat the memo. `useShallow`
 * compares the flattened result, so the selector re-running is free.
 *
 * The fold is a sum for the counts and a *union* for `working`: two agents
 * working in two different conversations of one project is two voices, and the
 * tile's dot needs to know it cannot name one of them.
 */
export function useProjectRowState(conversationIds: readonly string[]): SessionRowState {
  const key = conversationIds.join(',')
  const flat = useWorkspaceStore(
    useShallow((state: WorkspaceStore) => {
      let approvals = 0
      let questions = 0
      let unread = 0
      let failed = false
      const working = new Set<string>()
      for (const id of key === '' ? [] : key.split(',')) {
        const pulse = state.pulses[id]
        if (pulse === undefined) continue
        approvals += pulse.approvalIds.length
        questions += pulse.questionIds.length
        unread += pulse.unread
        failed = failed || pulse.failed
        for (const agentId of pulse.working) working.add(agentId)
      }
      return { approvals, questions, unread, failed, working: [...working].sort().join(',') }
    })
  )
  return useMemo(
    () => ({
      approvals: flat.approvals,
      questions: flat.questions,
      working: flat.working === '' ? [] : (flat.working.split(',') as AgentId[]),
      unread: flat.unread,
      failed: flat.failed,
    }),
    [flat.approvals, flat.questions, flat.working, flat.unread, flat.failed]
  )
}

/**
 * Which **projects** have a tab somewhere, as one comparable string.
 *
 * It was `useOpenConversationKey` and the name outlived the truth: `pane.tabs`
 * holds project ids since the re-key, so this has been answering a different
 * question than it claimed for as long as tabs have been projects. Renamed
 * rather than left, because a wrong name is the one kind of error that survives
 * a re-key — nothing about a string of ids fails to compile when the ids change
 * meaning.
 *
 * The rail needs this to mark tiles "open elsewhere", and it needs it once
 * rather than once per tile — twenty tiles each walking the layout tree is
 * twenty subscriptions to a value that is the same for all of them. A `Set` would be a
 * new object on every store change and never compare equal, so the selector
 * returns the primitive and the caller rebuilds the set behind a `useMemo`.
 */
export function useOpenProjectKey(): string {
  return useWorkspaceStore((state) =>
    leafPaneIds(state.layout)
      .flatMap((paneId) => state.panes[paneId]?.tabs ?? [])
      .join('\n')
  )
}

/** What the project card reports across all of a project's conversations. */
export interface ProjectFacts {
  readonly tokens: number
  readonly costUsd: number | null
  /** The fullest context window in the project, or null if nobody has reported. */
  readonly contextPercent: number | null
  readonly tasks: readonly {
    readonly id: string
    readonly kind: string
    readonly description: string
    readonly agentId: string
    readonly conversationId: string
  }[]
}

/**
 * The card's figures, summed over a project rather than read from one room.
 *
 * Spend adds up, because each conversation's total is already the sum of its
 * agents' latest reports. Context does **not**: it is a percentage of a window,
 * and adding two of them produces a number that means nothing. The fullest one
 * is the answer to the question the figure exists for — "is anything about to
 * run out of room".
 *
 * Serialised through JSON so the memo compares by value. The join-a-string trick
 * the hooks above use does not reach a task list, and returning a fresh array
 * from the selector would re-render the card on every store change. The list is
 * a handful of short objects; this is cheaper than the render it prevents.
 */
export function useProjectFacts(conversationIds: readonly string[]): ProjectFacts {
  const key = conversationIds.join(',')
  const encoded = useWorkspaceStore((state) => {
    let tokens = 0
    let cost: number | null = null
    let context: number | null = null
    const tasks: ProjectFacts['tasks'][number][] = []
    for (const conversationId of key === '' ? [] : key.split(',')) {
      const pulse = state.pulses[conversationId]
      if (pulse === undefined) continue
      tokens += pulse.tokens
      if (pulse.costUsd != null) cost = (cost ?? 0) + pulse.costUsd
      for (const percent of Object.values(pulse.contextByActor)) {
        context = context === null ? percent : Math.max(context, percent)
      }
      for (const [agentId, list] of Object.entries(pulse.tasksByActor)) {
        for (const task of list) {
          tasks.push({
            id: task.id,
            kind: task.kind,
            description: task.description,
            agentId,
            conversationId,
          })
        }
      }
    }
    return JSON.stringify({ tokens, costUsd: cost, contextPercent: context, tasks })
  })
  return useMemo(() => JSON.parse(encoded) as ProjectFacts, [encoded])
}

/**
 * Whether **every** conversation in a project is planning.
 *
 * One subscription reading the whole `planning` record, not one per session:
 * the list's length changes as conversations open and close, so a loop of
 * `usePlanning` calls would break the rules of hooks the first time it did.
 *
 * Empty is false rather than vacuously true. A project with nothing running is
 * not in plan mode; it is in no mode, and a control reading On over an empty
 * project would claim a restraint that is restraining nothing.
 */
export function useEveryPlanning(conversationIds: readonly string[]): boolean {
  const key = conversationIds.join(',')
  return useWorkspaceStore((state) => {
    if (key === '') return false
    return key.split(',').every((id) => state.planning[id] === true)
  })
}

/** Reading and reasoning only. Runtime state; it never survives a relaunch. */
export function usePlanning(conversationId: string): boolean {
  return useWorkspaceStore((state) => state.planning[conversationId] ?? false)
}
