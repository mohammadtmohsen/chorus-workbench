import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  ActivityPush,
  ContextUsagePush,
  TasksPush,
  TranscriptEvent,
} from '../../../shared/ipc.js'
import { countsAsUnread } from '../../../shared/unread.js'
import type {
  ConversationArrangement,
  TerminalPanelState,
} from '../../../shared/workspace-layout.js'
// `WorkspaceSnapshot` is imported as a value, not a type: `SNAPSHOT_KEYS` below
// reads its keys off the schema so the list cannot drift from the shape.
import { CLOSED_TERMINAL_PANEL, WorkspaceSnapshot } from '../../../shared/workspace-layout.js'
import {
  activateTab,
  clampChorusWidth,
  clampSidebarWidth,
  closePane,
  closeTab,
  EMPTY_WORKSPACE,
  equalizeBranch,
  focusPane,
  leafPaneIds,
  moveTab,
  newGroupId,
  openSession,
  placeSession,
  reconcileWorkspace,
  newTerminalId,
  normalizeTerminalPanel,
  reorderTab,
  setBranchSizes,
  splitTab,
  splitWithSession,
  tabLocation,
  type SplitDirection,
} from './layout.js'

export interface SessionPulse {
  readonly lastSeq: number
  readonly unread: number
  readonly working: readonly TranscriptEvent['actor'][]
  readonly approvalIds: readonly string[]
  readonly questionIds: readonly string[]
  /*
   * What the conversation has spent, reduced here as well as in the transcript.
   *
   * The transcript's copy belongs to a mounted `Session`, and the sidenav shows
   * every session including the ones that are not — so the number a card needs
   * cannot come from there. Same rule as the transcript's: each agent reports
   * its own running total, so the latest wins per agent and the conversation is
   * their sum. Adding reports up would count the same tokens again each time.
   */
  readonly usageByActor: Readonly<
    Record<string, { input: number; output: number; cost: number | null }>
  >
  readonly tokens: number
  readonly costUsd: number | null
  /*
   * How full each agent has filled its context window, 0-100.
   *
   * Not reduced from events like everything else above: this is state the agent
   * reports about itself, pushed on its own channel and never written to the
   * log, so there is nothing to replay. Per actor because two agents in one
   * conversation keep separate contexts — that is the product's premise, and a
   * single number would flatten it.
   *
   * Empty until a turn finishes. Absent is the honest answer before then, and
   * different from zero, which would claim an empty context.
   */
  readonly contextByActor: Readonly<Record<string, number>>
  /**
   * What each agent has left running, as last pushed.
   *
   * Same category as `contextByActor` and carried the same way: no event
   * reports it, so folding the log must not be able to erase it. Replaced
   * wholesale per actor, including with an empty list — under the provider's
   * replace semantics that is the only thing that says the last task finished.
   */
  readonly tasksByActor: Readonly<Record<string, readonly BackgroundTaskView[]>>
  /**
   * What each agent says it is doing right now, as last pushed.
   *
   * The same category again, and the one that changes fastest — several times a
   * turn. A key rather than a phrase: nothing in this file has a translator, and
   * the working line is what turns it into a word.
   *
   * `null` is a value with meaning. It says the agent has stopped doing the
   * thing it named and is back to working at nothing in particular, which is
   * most of a turn; treating it as absent would leave `compacting` on screen
   * long after the compaction finished.
   */
  readonly activityByActor: Readonly<Record<string, ActivityPush['activity']>>
  /**
   * The last turn in this conversation ended badly.
   *
   * One of the four states a row draws, and the only one with no other source:
   * waiting is a count of approvals, working is a list of actors, idle is the
   * absence of both. `turn.completed` carries `status`, so this is folded from
   * the log like the rest of the pulse rather than pushed.
   *
   * Cleared when a turn starts, not when the row is seen. A failure that
   * disappeared because a pointer crossed it would be a state you could miss by
   * looking at it.
   */
  readonly failed: boolean
}

/** One background task, as a card needs to draw it. */
export interface BackgroundTaskView {
  readonly id: string
  readonly kind: string
  readonly description: string
}

/** Drops one key without `delete`, which the lint rules forbid on a computed key. */
/** Drop one conversation's entry from a by-conversation map, whatever it holds. */
function without<T>(
  entries: Readonly<Record<string, T>>,
  conversationId: string
): Record<string, T> {
  return Object.fromEntries(Object.entries(entries).filter(([id]) => id !== conversationId))
}

const EMPTY_PULSE: SessionPulse = {
  lastSeq: 0,
  unread: 0,
  working: [],
  approvalIds: [],
  questionIds: [],
  usageByActor: {},
  tokens: 0,
  costUsd: null,
  contextByActor: {},
  tasksByActor: {},
  activityByActor: {},
  failed: false,
}

/**
 * The store's non-layout state, kept apart from the actions below so that
 * `WorkspaceActions` is callables and nothing else. `hooks.ts` hands that type
 * out wholesale; if state leaked into it, a component could read a snapshot it
 * never subscribed to and render a value that has since moved on.
 */
export interface WorkspaceRuntime {
  readonly hydrated: boolean
  readonly pulses: Readonly<Record<string, SessionPulse>>
  /**
   * Which conversations are reading and reasoning only.
   *
   * It used to live inside the toggle that set it, which was fine while the
   * toggle was the only thing that showed it. The preview shows it now, and the
   * toggle is in a menu that unmounts — so a control's own `useState` would
   * forget the mode every time the menu closed.
   *
   * Runtime rather than snapshot: a mode belongs to a running session, and a
   * relaunch is a new one. Nothing here is persisted.
   */
  readonly planning: Readonly<Record<string, boolean>>
}

export interface WorkspaceActions {
  hydrate: (
    saved: WorkspaceSnapshot | null,
    conversationIds: readonly string[],
    /** Which projects have a conversation open — what the tabs are keyed by. */
    projectIds: readonly string[],
    /** What the log says was missed while the app was closed, per conversation. */
    unreadByConversation?: Readonly<Record<string, number>>,
    /** Which conversations each project holds — what the inner columns are built from. */
    conversationsByProject?: Readonly<Record<string, readonly string[]>>
  ) => void
  /** Opens a **project** tab. Conversations live inside one; they are not tabs. */
  openProject: (projectId: string, paneId?: string) => void
  activateTab: (paneId: string, projectId: string) => void
  /** Marks one conversation read. Separate from the tab actions on purpose. */
  clearConversationUnread: (conversationId: string) => void
  /**
   * Puts one of a project's conversations on screen — what the dock does.
   *
   * Takes both ids because the pane is keyed by the project and the content by
   * the conversation, and deriving one from the other would mean the store
   * holding a session list it has no other reason to know about.
   */
  showConversation: (projectId: string, conversationId: string) => void
  focusPane: (paneId: string) => void
  closeTab: (paneId: string, projectId: string) => void
  closePane: (paneId: string) => void
  reorderTab: (paneId: string, fromIndex: number, slotBefore: number) => void
  moveTab: (conversationId: string, targetPaneId: string, slotBefore: number) => void
  splitTab: (conversationId: string, targetPaneId: string, direction: SplitDirection) => void
  /** Move an open session, or open a closed one, into a pane at a slot. */
  placeSession: (conversationId: string, targetPaneId: string, slotBefore: number) => void
  /** The same, into a new group beside the target. Refuses a fifth pane. */
  splitWithSession: (
    conversationId: string,
    targetPaneId: string,
    direction: SplitDirection
  ) => void
  /** What plan mode actually became, as the session reported it. */
  setPlanning: (conversationId: string, planning: boolean) => void
  setBranchSizes: (path: readonly number[], sizes: readonly number[]) => void
  equalizeBranch: (path: readonly number[]) => void
  /** Forgets one conversation's state. Leaves the project's tab alone. */
  removeSession: (conversationId: string) => void
  /** Closes a project's tab. Call when its last conversation has gone. */
  removeProject: (projectId: string) => void
  setSidebarHidden: (hidden: boolean) => void
  toggleGlobalTerminal: () => void
  setGlobalTerminalOpen: (open: boolean) => void
  /** Committed on release, not per frame — same trade as the sidebar's width. */
  setGlobalTerminalHeight: (height: number) => void
  /** Toggles one conversation's panel, leaving every other one alone. */
  toggleSessionTerminal: (conversationId: string) => void
  setSessionTerminalHeight: (conversationId: string, height: number) => void
  /** Append a terminal to a panel's roster and select it. Opens the panel. */
  addGlobalTerminal: () => void
  addSessionTerminal: (conversationId: string) => void
  /**
   * Drop a tab from the roster. **Kills nothing** — the shell is in main, and
   * the caller awaits `terminal:kill` first. Removing the last tab hides the
   * panel rather than leaving it open with nothing in it.
   */
  removeGlobalTerminalTab: (id: string) => void
  removeSessionTerminalTab: (conversationId: string, id: string) => void
  activateGlobalTerminal: (id: string) => void
  activateSessionTerminal: (conversationId: string, id: string) => void
  /** Committed on drop, not on every pointer move; see `useSidebarResize`. */
  setSidebarWidth: (width: number) => void
  /** The workbench/Chorus divider, for one project. See the field's own note. */
  setChorusWidth: (projectId: string, width: number) => void
  /** Shows or hides a project's workbench. Chorus takes the pane when it is off. */
  toggleWorkbench: (projectId: string) => void
  /**
   * Puts a conversation on screen in the group that holds it.
   *
   * Distinct from `showConversation`, which searches every group: this names
   * one, because a conversation open in a strip is being clicked in a *place*.
   */
  showConversationIn: (projectId: string, groupId: string, conversationId: string) => void
  /** Which group a new conversation joins and the keyboard acts on. */
  focusConversationGroup: (projectId: string, groupId: string) => void
  /**
   * Gives a newly created conversation a tab, in the focused group.
   *
   * **Required, not a convenience.** `reconcileConversationGroups` is the only
   * other thing that places a conversation, and it runs at hydrate — so without
   * this a conversation started while the app is open exists, streams, and has
   * no tab anywhere until the next relaunch. Idempotent, so every path that can
   * produce a conversation may call it without checking first.
   */
  adoptConversation: (projectId: string, conversationId: string) => void
  /**
   * Move a conversation to a slot in a group — the inner `placeSession`.
   *
   * Delegates to the identical function the pane tree uses, so "drop on a strip"
   * behaves the same at both levels rather than the same by coincidence.
   */
  placeConversation: (
    projectId: string,
    conversationId: string,
    targetGroupId: string,
    slotBefore: number
  ) => void
  /** Split a group and put the conversation in the new one — the inner `splitWithSession`. */
  splitConversation: (
    projectId: string,
    conversationId: string,
    targetGroupId: string,
    direction: SplitDirection
  ) => void
  /** Drop a conversation's tab from its group. Collapses a group left empty. */
  closeConversationTab: (projectId: string, conversationId: string) => void
  /** How a branch of the conversation tree divides, by path. */
  setConversationSizes: (
    projectId: string,
    path: readonly number[],
    sizes: readonly number[]
  ) => void
  ingestEvents: (events: readonly TranscriptEvent[]) => void
  /** Pushed state, not a logged event — see the action for why it is separate. */
  ingestContextUsage: (usage: ContextUsagePush) => void
  ingestTasks: (push: TasksPush) => void
  ingestActivity: (push: ActivityPush) => void
}

export type WorkspaceStore = WorkspaceSnapshot & WorkspaceRuntime & WorkspaceActions

/*
 * Every terminal-panel edit goes through `normalizeTerminalPanel`.
 *
 * Not a style choice. The panel invariant — an open panel has at least one tab,
 * ids are unique, `activeId` names one of them — is what lets `Session` and
 * `Workspace` render a ref without a null check, and these actions are the only
 * things besides a persisted file that can break it. Routing them through the
 * same repair the loader uses means "opening a panel mints its first terminal"
 * is not a rule anyone has to remember: `toggleSessionTerminal` flips `open` and
 * the normalizer supplies the tab.
 *
 * The two helpers stay scope-explicit — `editGlobal` and `editSession`, not one
 * function taking a nullable conversation id — for the reason the whole feature
 * keeps repeating: the global panel belongs to no conversation, and a nullable
 * id is how it ends up reached by something walking sessions.
 */
function editGlobal(
  state: WorkspaceStore,
  change: (panel: TerminalPanelState) => TerminalPanelState
): Pick<WorkspaceSnapshot, 'globalTerminal'> {
  return { globalTerminal: normalizeTerminalPanel(change(state.globalTerminal)) }
}

function editSession(
  state: WorkspaceStore,
  conversationId: string,
  change: (panel: TerminalPanelState) => TerminalPanelState
): Pick<WorkspaceSnapshot, 'terminals'> {
  const current = state.terminals[conversationId] ?? CLOSED_TERMINAL_PANEL
  return {
    terminals: {
      ...state.terminals,
      [conversationId]: normalizeTerminalPanel(change(current)),
    },
  }
}

/**
 * Edit one project's conversation arrangement, or do nothing.
 *
 * **A project with no entry is left alone**, deliberately. Absent means "never
 * arranged", and every one of these actions names a group that a non-existent
 * arrangement cannot contain — so inventing one here would be inventing a group
 * id the caller did not mean. `reconcileConversationGroups` is the only thing
 * that creates an arrangement, because it is the only thing that knows which
 * conversations are live.
 */
function editArrangement(
  state: WorkspaceStore,
  projectId: string,
  change: (arrangement: ConversationArrangement) => ConversationArrangement
): Record<string, ConversationArrangement> {
  const current = state.conversationGroups[projectId]
  if (current === undefined) return state.conversationGroups
  return { ...state.conversationGroups, [projectId]: change(current) }
}

/** A new terminal, appended and selected. Opens the panel if it was hidden. */
function addTab(panel: TerminalPanelState): TerminalPanelState {
  const id = newTerminalId()
  return { ...panel, open: true, tabs: [...panel.tabs, { id }], activeId: id }
}

/**
 * Drop one tab from the roster.
 *
 * **This does not kill anything** — the PTY is in main, and the caller awaits
 * `terminal:kill` before calling this. The name says so: a `killTerminal` here
 * would read at the call site as though the store had done the killing, which is
 * the same confusion `detach`-versus-`dispose` cost a section of the original
 * plan.
 *
 * Removing the last tab closes the panel, because an open panel with no tabs
 * violates the invariant and there is nothing to show. `normalizeTerminalPanel`
 * would otherwise mint a replacement — killing the last terminal would silently
 * open a new one.
 */
function removeTab(panel: TerminalPanelState, id: string): TerminalPanelState {
  const tabs = panel.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return { ...panel, open: false, tabs: [], activeId: null }
  /*
   * The neighbour, not the first. Closing the tab you are looking at should land
   * on the one beside it — the same rule `normalizeWorkspace` already applies to
   * a pane's `activeTabId`, and the reason it clamps an index rather than
   * resetting.
   */
  const removedAt = panel.tabs.findIndex((tab) => tab.id === id)
  const next = panel.activeId === id ? tabs[Math.min(removedAt, tabs.length - 1)] : undefined
  return { ...panel, tabs, activeId: next?.id ?? panel.activeId }
}

/** Select a tab, ignoring an id this panel does not hold. */
function activateTerminalTab(panel: TerminalPanelState, id: string): TerminalPanelState {
  if (!panel.tabs.some((tab) => tab.id === id)) return panel
  return { ...panel, activeId: id }
}

function snapshot(state: WorkspaceStore): WorkspaceSnapshot {
  return {
    layout: state.layout,
    panes: state.panes,
    focusedPaneId: state.focusedPaneId,
    sidebarHidden: state.sidebarHidden,
    sidebarWidth: state.sidebarWidth,
    chorusWidths: state.chorusWidths,
    conversationGroups: state.conversationGroups,
    workbenchHidden: state.workbenchHidden,
    terminals: state.terminals,
    globalTerminal: state.globalTerminal,
    /*
     * Hand-written, unlike `SNAPSHOT_KEYS` below which reads the schema. A field
     * added to `WorkspaceSnapshot` and forgotten *here* is dropped on every
     * persist — which is the same class of bug the comment on `SNAPSHOT_KEYS`
     * records, from the other end.
     */
  }
}

function pulseKey(event: TranscriptEvent, field: string): string {
  const value = event.payload[field]
  return typeof value === 'string' && value !== '' ? value : event.id
}

/** Exported for tests, like the transcript's reducer, because it is pure. */
export function reducePulse(
  pulse: SessionPulse,
  event: TranscriptEvent,
  visible: boolean
): SessionPulse {
  if (event.seq <= pulse.lastSeq) return pulse
  let working = [...pulse.working]
  let approvalIds = [...pulse.approvalIds]
  let questionIds = [...pulse.questionIds]
  let unread = visible ? 0 : pulse.unread

  let failed = pulse.failed
  if (event.type === 'turn.started') {
    if (!working.includes(event.actor)) working.push(event.actor)
    failed = false
  }
  if (event.type === 'turn.completed') {
    working = working.filter((actor) => actor !== event.actor)
    /*
     * Set, never cleared here.
     *
     * `interrupted` is not a failure: it is what stopping an agent looks like
     * from the log's side, and marking the row failed for it would turn a
     * deliberate Stop into an alarm. But this was an assignment, so *any*
     * completion decided the flag — and a conversation has two agents in it. One
     * failing and the other finishing normally a second later left a row that
     * said idle, which is the one case where the state matters most: the reply
     * you are waiting for never came and nothing on the rail says so.
     *
     * `turn.started` is the only thing that clears it, which is what the field's
     * own comment already promised: a failure survives until the next turn.
     */
    if (event.payload['status'] === 'failed') failed = true
  }
  if (event.type === 'approval.requested') {
    const id = pulseKey(event, 'approvalId')
    if (!approvalIds.includes(id)) approvalIds.push(id)
  }
  if (event.type === 'approval.decided') {
    const id = pulseKey(event, 'approvalId')
    approvalIds = approvalIds.filter((candidate) => candidate !== id)
  }
  if (event.type === 'userinput.requested') {
    const id = pulseKey(event, 'userInputId')
    if (!questionIds.includes(id)) questionIds.push(id)
  }
  if (event.type === 'userinput.answered') {
    const id = pulseKey(event, 'userInputId')
    questionIds = questionIds.filter((candidate) => candidate !== id)
  }
  let usageByActor = pulse.usageByActor
  let tokens = pulse.tokens
  let costUsd = pulse.costUsd
  if (event.type === 'usage.updated') {
    const num = (key: string): number =>
      typeof event.payload[key] === 'number' ? event.payload[key] : 0
    const cost = event.payload['costUsd']
    usageByActor = {
      ...usageByActor,
      [event.actor]: {
        input: num('inputTokens'),
        output: num('outputTokens'),
        cost: typeof cost === 'number' ? cost : null,
      },
    }
    const totals = Object.values(usageByActor)
    const priced = totals.filter((t) => t.cost !== null)
    tokens = totals.reduce((sum, t) => sum + t.input + t.output, 0)
    // Null until an agent actually reports a price: a zero would be a claim
    // that cannot be made, and Codex does not always report one.
    costUsd = priced.length === 0 ? null : priced.reduce((sum, t) => sum + (t.cost ?? 0), 0)
  }

  // The list is shared with the main process, which counts the same events back
  // out of the log at launch to restore this number.
  if (!visible && countsAsUnread(event.type)) {
    unread += 1
  }
  return {
    lastSeq: event.seq,
    unread,
    working,
    approvalIds,
    questionIds,
    usageByActor,
    tokens,
    costUsd,
    // Carried through untouched: no event reports it, so folding the log must
    // not be able to erase what the context channel pushed.
    contextByActor: pulse.contextByActor,
    tasksByActor: pulse.tasksByActor,
    activityByActor: pulse.activityByActor,
    failed,
  }
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  subscribeWithSelector((set) => {
    const update = (change: (current: WorkspaceSnapshot) => WorkspaceSnapshot): void => {
      set((state) => change(snapshot(state)))
    }
    const clearUnread = (conversationId: string): void => {
      set((state) => {
        const pulse = state.pulses[conversationId]
        if (pulse === undefined || pulse.unread === 0) return state
        return {
          pulses: { ...state.pulses, [conversationId]: { ...pulse, unread: 0 } },
        }
      })
    }

    return {
      ...EMPTY_WORKSPACE,
      hydrated: false,
      pulses: {},
      planning: {},
      hydrate: (
        saved,
        conversationIds,
        projectIds,
        unreadByConversation = {},
        conversationsByProject = {}
      ) => {
        const repaired = reconcileWorkspace(
          saved,
          conversationIds,
          projectIds,
          conversationsByProject
        )
        set({
          ...repaired,
          hydrated: true,
          // Restored sessions start out of plan mode, and the caller seeds the
          // ones the runtime says are in it. Carrying a stale map through a
          // second hydrate would claim a mode nothing had asked for.
          planning: {},
          /*
           * Seeded with what happened while the app was closed.
           *
           * Every other field starts empty on purpose — they describe a live
           * agent, and nothing is live yet. Unread is the exception because it
           * describes the *log*, which outlived the process, and starting it at
           * zero is what used to make every relaunch claim nothing had happened.
           */
          pulses: Object.fromEntries(
            conversationIds.map((id) => [
              id,
              { ...EMPTY_PULSE, unread: unreadByConversation[id] ?? 0 },
            ])
          ),
        })
      },
      /*
       * The tab actions take **project** ids now, and `clearUnread` no longer
       * rides along with them.
       *
       * Unread is a property of a conversation, and a tab is a project — which
       * may hold several. Clearing on tab activation would have marked every
       * conversation in a project read the moment one of them was shown, and
       * clearing "the project's unread" is not a thing that exists. The caller
       * clears the conversation it actually put on screen.
       *
       * The layout functions underneath are unchanged: they were always generic
       * over an opaque tab id, which is the reason this re-key is a change of
       * what goes in rather than a rewrite of the algebra.
       */
      openProject: (projectId, paneId) => {
        update((current) => openSession(current, projectId, paneId))
      },
      activateTab: (paneId, projectId) => {
        update((current) => activateTab(current, paneId, projectId))
      },
      clearConversationUnread: (conversationId) => {
        clearUnread(conversationId)
      },
      /*
       * Reveal, rather than a pointer write.
       *
       * This used to set `activeConversation[projectId]` — one conversation per
       * project, which stopped being expressible the moment a project's column
       * could hold two groups. The group that already holds the conversation
       * owns the answer now, so this finds it, makes it that group's active tab
       * and focuses the group. A conversation in no group is left alone: only
       * `reconcileConversationGroups` places conversations, because only it knows
       * which are live.
       */
      showConversation: (projectId, conversationId) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) => {
            /*
             * Reveal, rather than a pointer write. This used to set
             * `activeConversation[projectId]` — one conversation per project,
             * which stopped being expressible the moment a project's column
             * became a tree. The group holding it owns the answer now.
             */
            const found = tabLocation(arrangement, conversationId)
            if (found === null) return arrangement
            return activateTab(focusPane(arrangement, found.paneId), found.paneId, conversationId)
          }),
        }))
        clearUnread(conversationId)
      },
      focusPane: (paneId) => {
        update((current) => focusPane(current, paneId))
      },
      closeTab: (paneId, conversationId) => {
        update((current) => closeTab(current, paneId, conversationId))
      },
      closePane: (paneId) => {
        update((current) => closePane(current, paneId))
      },
      reorderTab: (paneId, fromIndex, slotBefore) => {
        update((current) => reorderTab(current, paneId, fromIndex, slotBefore))
      },
      moveTab: (conversationId, targetPaneId, slotBefore) => {
        update((current) => moveTab(current, conversationId, targetPaneId, slotBefore))
        clearUnread(conversationId)
      },
      splitTab: (conversationId, targetPaneId, direction) => {
        update((current) => splitTab(current, conversationId, targetPaneId, direction))
        clearUnread(conversationId)
      },
      placeSession: (conversationId, targetPaneId, slotBefore) => {
        update((current) => placeSession(current, conversationId, targetPaneId, slotBefore))
        clearUnread(conversationId)
      },
      splitWithSession: (conversationId, targetPaneId, direction) => {
        update((current) => splitWithSession(current, conversationId, targetPaneId, direction))
        clearUnread(conversationId)
      },
      setPlanning: (conversationId, planning) => {
        set((state) =>
          state.planning[conversationId] === planning
            ? state
            : { planning: { ...state.planning, [conversationId]: planning } }
        )
      },
      setBranchSizes: (path, sizes) => {
        update((current) => setBranchSizes(current, path, sizes))
      },
      equalizeBranch: (path) => {
        update((current) => equalizeBranch(current, path))
      },
      /** Closes a project's tab everywhere. Call when its last conversation has gone. */
      removeProject: (projectId) => {
        update((current) => {
          let next = current
          for (const paneId of leafPaneIds(next.layout)) {
            next = closeTab(next, paneId, projectId)
          }
          return next
        })
      },
      removeSession: (conversationId) => {
        set((state) => {
          /*
           * **Its tab is in the project's tree, not in a pane.**
           *
           * This used to call `closeTab` on the pane holding it, which was right
           * while a pane tab *was* a conversation. Since the re-key a pane tab is
           * a project, so the lookup found nothing and the conversation's tab was
           * simply left behind: ending the last conversation in a group left an
           * empty bordered box with a `+` in it, and ending one in a split left a
           * dead half that never collapsed.
           *
           * Going through `closeTab` on the *arrangement* is what fixes both,
           * because that is the same function the pane tree uses — an emptied
           * leaf is pruned and its branch merged by `normalizeTree`, so the
           * surviving group takes the space with no merge logic written here.
           */
          const groups: Record<string, ConversationArrangement> = {}
          for (const [projectId, arrangement] of Object.entries(state.conversationGroups)) {
            const found = tabLocation(arrangement, conversationId)
            const pruned =
              found === null ? arrangement : closeTab(arrangement, found.paneId, conversationId)
            /*
             * A project left with no conversations loses its entry entirely
             * rather than keeping one empty group. Absent is what `EditorPane`
             * reads to draw the "no conversations" state, and it is what
             * `reconcileConversationGroups` would have produced anyway.
             */
            const empty = Object.values(pruned.panes).every((pane) => pane.tabs.length === 0)
            if (!empty) groups[projectId] = pruned
          }
          /*
           * Its panel's visibility goes too. A conversation that ends and is
           * later replaced by one that reuses nothing should not inherit a panel
           * someone opened for the old one.
           */
          return {
            conversationGroups: groups,
            pulses: without(state.pulses, conversationId),
            planning: without(state.planning, conversationId),
            terminals: without(state.terminals, conversationId),
          }
        })
      },
      toggleGlobalTerminal: () => {
        set((state) => editGlobal(state, (panel) => ({ ...panel, open: !panel.open })))
      },
      setGlobalTerminalOpen: (open) => {
        set((state) => editGlobal(state, (panel) => ({ ...panel, open })))
      },
      setGlobalTerminalHeight: (height) => {
        set((state) => editGlobal(state, (panel) => ({ ...panel, height })))
      },
      toggleSessionTerminal: (conversationId) => {
        set((state) =>
          editSession(state, conversationId, (panel) => ({ ...panel, open: !panel.open }))
        )
      },
      setSessionTerminalHeight: (conversationId, height) => {
        set((state) => editSession(state, conversationId, (panel) => ({ ...panel, height })))
      },
      addGlobalTerminal: () => {
        set((state) => editGlobal(state, addTab))
      },
      addSessionTerminal: (conversationId) => {
        set((state) => editSession(state, conversationId, addTab))
      },
      removeGlobalTerminalTab: (id) => {
        set((state) => editGlobal(state, (panel) => removeTab(panel, id)))
      },
      removeSessionTerminalTab: (conversationId, id) => {
        set((state) => editSession(state, conversationId, (panel) => removeTab(panel, id)))
      },
      activateGlobalTerminal: (id) => {
        set((state) => editGlobal(state, (panel) => activateTerminalTab(panel, id)))
      },
      activateSessionTerminal: (conversationId, id) => {
        set((state) =>
          editSession(state, conversationId, (panel) => activateTerminalTab(panel, id))
        )
      },
      setSidebarHidden: (sidebarHidden) => {
        set({ sidebarHidden })
      },
      setSidebarWidth: (width) => {
        set({ sidebarWidth: clampSidebarWidth(width) })
      },
      setChorusWidth: (projectId, width) => {
        set((state) => ({
          chorusWidths: { ...state.chorusWidths, [projectId]: clampChorusWidth(width) },
        }))
      },
      showConversationIn: (projectId, groupId, conversationId) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            activateTab(focusPane(arrangement, groupId), groupId, conversationId)
          ),
        }))
        clearUnread(conversationId)
      },
      adoptConversation: (projectId, conversationId) => {
        set((state) => {
          const current = state.conversationGroups[projectId]
          /*
           * A project with no arrangement gets its first group here rather than
           * being left to reconcile. It is the same one-empty-group seed, and
           * building it now is what lets the very first conversation in a
           * project have a tab the moment it starts.
           */
          if (current === undefined) {
            const groupId = newGroupId()
            return {
              conversationGroups: {
                ...state.conversationGroups,
                [projectId]: {
                  layout: { kind: 'leaf' as const, paneId: groupId },
                  panes: {
                    [groupId]: { id: groupId, tabs: [conversationId], activeTabId: conversationId },
                  },
                  focusedPaneId: groupId,
                },
              },
            }
          }
          if (tabLocation(current, conversationId) !== null) return {}
          const target = current.focusedPaneId ?? leafPaneIds(current.layout)[0]
          const group = target === undefined ? undefined : current.panes[target]
          if (target === undefined || group === undefined) return {}
          return {
            conversationGroups: {
              ...state.conversationGroups,
              [projectId]: {
                ...current,
                panes: {
                  ...current.panes,
                  [target]: {
                    ...group,
                    tabs: [...group.tabs, conversationId],
                    activeTabId: conversationId,
                  },
                },
              },
            },
          }
        })
      },
      focusConversationGroup: (projectId, groupId) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            focusPane(arrangement, groupId)
          ),
        }))
      },
      /*
       * The four below are one line each, and that is the whole point of the
       * `PaneTree` refactor. Reorder, move between groups, split in any of four
       * directions, the four-group ceiling, collapsing a group the move emptied,
       * repairing sizes — none of it is written twice. A fix to how a pane splits
       * is a fix to how a conversation splits, by construction.
       */
      placeConversation: (projectId, conversationId, targetGroupId, slotBefore) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            placeSession(arrangement, conversationId, targetGroupId, slotBefore)
          ),
        }))
      },
      splitConversation: (projectId, conversationId, targetGroupId, direction) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            splitWithSession(arrangement, conversationId, targetGroupId, direction)
          ),
        }))
      },
      closeConversationTab: (projectId, conversationId) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) => {
            const found = tabLocation(arrangement, conversationId)
            return found === null
              ? arrangement
              : closeTab(arrangement, found.paneId, conversationId)
          }),
        }))
      },
      setConversationSizes: (projectId, path, sizes) => {
        set((state) => ({
          conversationGroups: editArrangement(state, projectId, (arrangement) =>
            setBranchSizes(arrangement, path, sizes)
          ),
        }))
      },
      toggleWorkbench: (projectId) => {
        set((state) => {
          const next = { ...state.workbenchHidden }
          if (next[projectId] === true) delete next[projectId]
          else next[projectId] = true
          return { workbenchHidden: next }
        })
      },
      ingestEvents: (events) => {
        if (events.length === 0) return
        set((state) => {
          let changed = false
          const pulses = { ...state.pulses }
          for (const event of events) {
            const location = tabLocation(state, event.conversationId)
            const pane = location === null ? undefined : state.panes[location.paneId]
            const visible = pane?.activeTabId === event.conversationId
            const current = pulses[event.conversationId] ?? EMPTY_PULSE
            const next = reducePulse(current, event, visible)
            if (next !== current) {
              pulses[event.conversationId] = next
              changed = true
            }
          }
          return changed ? { pulses } : state
        })
      },
      /*
       * Its own action rather than a case in `reducePulse`.
       *
       * That reducer folds the event log, and this never enters the log — it
       * arrives on a separate push because it is the agent's current state, not
       * conversation history. Routing it through the same function would mean
       * inventing a synthetic event and a `seq` that nothing ordered.
       *
       * A report for a conversation the store has never seen is dropped: the
       * sidebar draws sessions it knows about, and a pulse conjured here would
       * be one with no card to sit on.
       */
      /*
       * Replaced rather than merged, and never skipped when empty — an empty
       * list is how the last task's ending arrives.
       */
      ingestTasks: (push) => {
        set((state) => {
          const current = state.pulses[push.conversationId]
          if (current === undefined) return state
          return {
            pulses: {
              ...state.pulses,
              [push.conversationId]: {
                ...current,
                tasksByActor: { ...current.tasksByActor, [push.agentId]: push.tasks },
              },
            },
          }
        })
      },
      /*
       * Ignored when the agent is saying the same thing again, which it does
       * often: a thinking tick can arrive several times a second, and every one
       * of them would otherwise be a store write and a re-render of every pane.
       */
      ingestActivity: (push) => {
        set((state) => {
          const current = state.pulses[push.conversationId]
          if (current === undefined) return state
          if (current.activityByActor[push.agentId] === push.activity) return state
          return {
            pulses: {
              ...state.pulses,
              [push.conversationId]: {
                ...current,
                activityByActor: {
                  ...current.activityByActor,
                  [push.agentId]: push.activity,
                },
              },
            },
          }
        })
      },
      ingestContextUsage: (usage) => {
        set((state) => {
          const current = state.pulses[usage.conversationId]
          if (current === undefined) return state
          if (current.contextByActor[usage.agentId] === usage.percentUsed) return state
          return {
            pulses: {
              ...state.pulses,
              [usage.conversationId]: {
                ...current,
                contextByActor: {
                  ...current.contextByActor,
                  [usage.agentId]: usage.percentUsed,
                },
              },
            },
          }
        })
      },
    }
  })
)

/**
 * The persistence seam. Not a hook: `App` subscribes to it outside the render
 * path to write layout through IPC, and a component that wanted this would be
 * re-rendering on every pane change to no purpose.
 */
export const workspaceSnapshot = (state: WorkspaceStore): WorkspaceSnapshot => snapshot(state)

/**
 * Every field of the snapshot, taken from the schema rather than typed out.
 *
 * Derived on purpose. `App`'s persistence subscription used to compare a
 * hand-written list of six fields, and `terminals` and `globalTerminal` were
 * added to the snapshot above without ever being added to that list — so a
 * change to either compared *equal*, the listener never fired, and nothing was
 * written. Opening a terminal panel and resizing it did not survive a relaunch.
 *
 * It looked like it worked because the two other write paths — `reorder` and
 * `commitLayout` — send the whole snapshot, so a terminal panel was saved as a
 * side effect of the next unrelated layout change. "Sometimes it persists" is
 * why nobody caught it.
 *
 * Reading the keys off the schema means the next field added cannot be
 * forgotten here, because there is nothing to remember.
 */
const SNAPSHOT_KEYS = Object.keys(WorkspaceSnapshot.shape) as (keyof WorkspaceSnapshot)[]

/**
 * Whether two snapshots hold the same thing, by reference, field by field.
 *
 * Reference equality is sound because every action builds a new object for the
 * field it touches — that is what the existing `layout` and `panes` comparisons
 * already relied on.
 */
export function sameWorkspaceSnapshot(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key) => left[key] === right[key])
}
