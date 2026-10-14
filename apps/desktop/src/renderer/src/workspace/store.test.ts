import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_HOME_URL,
  type BrowserApi,
  type BrowserPush,
  type BrowserState,
} from '../../../shared/browser-ipc.js'
import type { IdeContextPush, TranscriptEvent } from '../../../shared/ipc.js'
import {
  BOX_WIDTH,
  CLOSED_TERMINAL_PANEL,
  TRAFFIC_WIDTH,
  WEB_TABS_MAX,
  WorkspaceSnapshot,
  type TerminalPanelState,
} from '../../../shared/workspace-layout.js'
import { columnWidths, EMPTY_WORKSPACE, onScreenConversations } from './layout.js'
import {
  reducePulse,
  sameWorkspaceSnapshot,
  useWorkspaceStore,
  workspaceSnapshot,
  type SessionPulse,
} from './store.js'
import { attachWebPage, runWebCommand, startWebPages } from './web-pages.js'

const PULSE: SessionPulse = {
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

function event(type: string, payload: Record<string, unknown> = {}): TranscriptEvent {
  return {
    seq: 1,
    id: 'e1',
    conversationId: 'c1',
    actor: 'claude',
    type,
    payload,
    createdAt: 1,
  }
}

describe('reducePulse', () => {
  /*
   * The one real hazard in carrying context fill on the pulse.
   *
   * Nothing in the log reports it — it arrives on its own push channel — so a
   * reducer that rebuilds the pulse from an event must copy it forward. Rebuilt
   * without it, every message the agent sent would silently reset the figure to
   * empty and the sidebar would flicker back to showing nothing.
   */
  it('does not let a logged event erase pushed context fill', () => {
    const withContext: SessionPulse = {
      ...PULSE,
      contextByActor: { claude: { percent: 72, markPercent: 79 } },
    }
    const next = reducePulse(withContext, event('agent.message.completed', { text: 'hi' }), true)
    expect(next.contextByActor).toEqual({ claude: { percent: 72, markPercent: 79 } })
  })

  /* The same hazard, for the same reason: nothing in the log reports it. */
  it('does not let a logged event erase pushed background tasks', () => {
    const withTasks: SessionPulse = {
      ...PULSE,
      tasksByActor: { claude: [{ id: 't1', kind: 'shell', description: 'sleep 60' }] },
    }
    const next = reducePulse(withTasks, event('agent.message.completed', { text: 'hi' }), true)
    expect(next.tasksByActor).toEqual({
      claude: [{ id: 't1', kind: 'shell', description: 'sleep 60' }],
    })
  })

  it('still folds what the log does report', () => {
    const next = reducePulse(PULSE, event('turn.started', { turnRef: 't1' }), true)
    expect(next.working).toContain('claude')
  })

  it('counts an unread only while the conversation is off screen', () => {
    const seen = reducePulse(PULSE, event('agent.message.completed', { text: 'a' }), true)
    const unseen = reducePulse(PULSE, event('agent.message.completed', { text: 'a' }), false)
    expect(seen.unread).toBe(0)
    expect(unseen.unread).toBe(1)
  })

  /*
   * The fourth row state, and the only one folded from a payload field rather
   * than counted. A row that could not tell a failed turn from an idle session
   * would leave the worst outcome looking like the ordinary one.
   */
  it('marks a session failed when a turn ends that way', () => {
    const next = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    expect(next.failed).toBe(true)
  })

  it('does not call a stopped turn a failure', () => {
    const next = reducePulse(PULSE, event('turn.completed', { status: 'interrupted' }), true)
    expect(next.failed).toBe(false)
  })

  it('clears a failure when the next turn starts', () => {
    const failed = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    const next = reducePulse(failed, { ...event('turn.started'), seq: 2 }, true)
    expect(next.failed).toBe(false)
  })

  /*
   * A conversation has two agents in it, and they finish separately.
   *
   * This was an assignment — `failed = status === 'failed'` — so the *last*
   * completion in a turn decided the flag for the whole session. Codex failing
   * and Claude finishing normally a second later left a row reading idle, which
   * is the one case where the state matters most: the answer never came and
   * nothing on the rail said so. Only `turn.started` may clear it.
   */
  it('does not let one agent finishing erase another agent’s failure', () => {
    const failed = reducePulse(
      PULSE,
      { ...event('turn.completed', { status: 'failed' }), actor: 'codex' },
      true
    )
    expect(failed.failed).toBe(true)
    const alsoDone = reducePulse(
      failed,
      { ...event('turn.completed', { status: 'completed' }), actor: 'claude', seq: 2 },
      true
    )
    expect(alsoDone.failed).toBe(true)
  })

  it('does not let a stop after a failure erase it either', () => {
    const failed = reducePulse(PULSE, event('turn.completed', { status: 'failed' }), true)
    const stopped = reducePulse(
      failed,
      { ...event('turn.completed', { status: 'interrupted' }), seq: 2 },
      true
    )
    expect(stopped.failed).toBe(true)
  })
})

describe('which conversations count as on screen', () => {
  /*
   * The defect these guard, and it was live rather than theoretical: `visible`
   * was computed by looking a **conversation** id up in the outer pane record,
   * whose tabs hold **project** ids. That lookup could never match, so `visible`
   * was always false and a conversation being read counted as unseen — its badge
   * climbed while it was open, and only an explicit clear knocked it back down.
   *
   * `p1` is showing; `c1` is its group's active tab and `c2` sits behind it in
   * the same group. `p2` has a tab in the same pane but is not the active one.
   */
  const seed = (): void => {
    useWorkspaceStore.setState({
      pulses: {},
      panes: { 'pane-1': { id: 'pane-1', tabs: ['p1', 'p2'], activeTabId: 'p1' } },
      conversationGroups: {
        p1: {
          layout: { kind: 'leaf', paneId: 'g1' },
          panes: { g1: { id: 'g1', tabs: ['c1', 'c2'], activeTabId: 'c1' } },
          focusedPaneId: 'g1',
        },
        p2: {
          layout: { kind: 'leaf', paneId: 'g2' },
          panes: { g2: { id: 'g2', tabs: ['c3'], activeTabId: 'c3' } },
          focusedPaneId: 'g2',
        },
      },
    })
  }

  const unread = (conversationId: string): number =>
    useWorkspaceStore.getState().pulses[conversationId]?.unread ?? 0

  const said = (conversationId: string): TranscriptEvent => ({
    ...event('agent.message.completed', { text: 'hi' }),
    conversationId,
  })

  it('does not count an unread for the conversation showing in the active project', () => {
    seed()
    useWorkspaceStore.getState().ingestEvents([said('c1')])
    expect(unread('c1')).toBe(0)
  })

  /*
   * The control, and the half that must keep working: the same event for a
   * project that has a tab in the pane but is not the one showing still counts.
   */
  it('counts one for a conversation in a project that is not showing', () => {
    seed()
    useWorkspaceStore.getState().ingestEvents([said('c3')])
    expect(unread('c3')).toBe(1)
  })

  /*
   * Why both levels are required rather than the inner one alone: this
   * conversation is in the project that is showing, in the group that is
   * showing, and it is still not on screen.
   */
  it('counts one for a conversation behind another tab of the same project', () => {
    seed()
    useWorkspaceStore.getState().ingestEvents([said('c2')])
    expect(unread('c2')).toBe(1)
  })

  /*
   * A detached window reports what it is showing, and that report is merged
   * rather than replaced — the window that owns the rail has to keep its own
   * answer as well, or a conversation read over there would count as unseen.
   */
  it('merges what another window reports, without dropping its own answer', () => {
    seed()
    const showing = onScreenConversations(useWorkspaceStore.getState(), ['c9'])
    expect([...showing].sort()).toEqual(['c1', 'c9'])
  })
})

describe('sameWorkspaceSnapshot', () => {
  /*
   * The bug this exists for, and it shipped.
   *
   * `App`'s persistence subscription compared six hand-written fields. When
   * terminals were added to the snapshot they were not added to that list, so a
   * change to a terminal panel compared *equal*, the debounced listener never
   * fired, and nothing reached disk. Opening a terminal and resizing it did not
   * survive a relaunch.
   *
   * It read as working because `reorder` and `commitLayout` both send the whole
   * snapshot, so a terminal panel persisted as a side effect of the next
   * unrelated layout change. The failure was "sometimes it saves", which is the
   * kind nobody files.
   */
  it('sees a terminal panel opening', () => {
    const opened: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      globalTerminal: { ...CLOSED_TERMINAL_PANEL, open: true },
    }
    expect(sameWorkspaceSnapshot(EMPTY_WORKSPACE, opened)).toBe(false)
  })

  it('sees a session terminal being resized', () => {
    const before: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      terminals: { 'conversation-1': { ...CLOSED_TERMINAL_PANEL, open: true } },
    }
    const after: WorkspaceSnapshot = {
      ...before,
      terminals: { 'conversation-1': { ...CLOSED_TERMINAL_PANEL, open: true, height: 310 } },
    }
    expect(sameWorkspaceSnapshot(before, after)).toBe(false)
  })

  it('still says nothing changed when nothing did', () => {
    expect(sameWorkspaceSnapshot(EMPTY_WORKSPACE, { ...EMPTY_WORKSPACE })).toBe(true)
  })

  /*
   * The guard that actually holds the line, rather than the two above.
   *
   * Cases for `terminals` and `globalTerminal` only prove today's bug is fixed;
   * they say nothing about the next field added to `WorkspaceSnapshot`, which is
   * exactly how this happened the first time. Walking the schema's own keys
   * means a field that the comparison does not reach fails here on the day it is
   * added, with no one having to remember this file exists.
   *
   * A distinct sentinel per key, so the assertion cannot pass because two fields
   * happened to hold the same value.
   */
  it('notices a change to any field the snapshot carries', () => {
    for (const key of Object.keys(WorkspaceSnapshot.shape)) {
      const changed = { ...EMPTY_WORKSPACE, [key]: { sentinel: key } }
      expect(
        sameWorkspaceSnapshot(EMPTY_WORKSPACE, changed),
        `${key} is not compared, so a change to it would never be persisted`
      ).toBe(false)
    }
  })
})

describe('the terminal roster, through the store', () => {
  const reset = (): void => {
    useWorkspaceStore.setState({ terminals: {}, globalTerminal: CLOSED_TERMINAL_PANEL })
  }
  const session = (): TerminalPanelState =>
    useWorkspaceStore.getState().terminals['c1'] ?? CLOSED_TERMINAL_PANEL
  const globalPanel = (): TerminalPanelState => useWorkspaceStore.getState().globalTerminal

  /*
   * The invariant nothing has to remember. `toggleSessionTerminal` only flips
   * `open`; the tab arrives because every write goes through
   * `normalizeTerminalPanel`. If these actions ever stop routing through it, an
   * open panel renders against `id: ''` and attaches to a shell that is not
   * there.
   */
  it('gives a panel its first terminal just by being opened', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    expect(session().open).toBe(true)
    expect(session().tabs).toHaveLength(1)
    expect(session().activeId).toBe(session().tabs[0]?.id)
  })

  it('does the same for the global panel', () => {
    reset()
    useWorkspaceStore.getState().toggleGlobalTerminal()
    expect(globalPanel().tabs).toHaveLength(1)
    expect(globalPanel().activeId).not.toBeNull()
  })

  it('appends a terminal and selects it', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    const first = session().activeId
    useWorkspaceStore.getState().addSessionTerminal('c1')
    expect(session().tabs).toHaveLength(2)
    expect(session().activeId).not.toBe(first)
    expect(session().activeId).toBe(session().tabs[1]?.id)
  })

  it('opens a hidden panel when a terminal is added to it', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    expect(session().open).toBe(true)
    expect(session().tabs).toHaveLength(1)
  })

  it('never mints the same id twice, even across panels', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addGlobalTerminal()
    const ids = [...session().tabs, ...globalPanel().tabs].map((tab) => tab.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('activates a tab it holds and ignores one it does not', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addSessionTerminal('c1')
    const first = session().tabs[0]?.id ?? ''
    useWorkspaceStore.getState().activateSessionTerminal('c1', first)
    expect(session().activeId).toBe(first)
    useWorkspaceStore.getState().activateSessionTerminal('c1', 'not-a-tab')
    expect(session().activeId).toBe(first)
  })

  /*
   * Closing the tab you are looking at lands on its neighbour, the same rule
   * `normalizeWorkspace` already applies to a pane's `activeTabId`. Falling back
   * to the first would jump you across the strip for no reason.
   */
  it('lands on the neighbour when the selected tab is removed', () => {
    reset()
    for (let n = 0; n < 3; n += 1) useWorkspaceStore.getState().addSessionTerminal('c1')
    const [a, b, c] = session().tabs.map((tab) => tab.id)
    useWorkspaceStore.getState().activateSessionTerminal('c1', b ?? '')
    useWorkspaceStore.getState().removeSessionTerminalTab('c1', b ?? '')
    expect(session().tabs.map((tab) => tab.id)).toEqual([a, c])
    expect(session().activeId).toBe(c)
  })

  it('leaves the selection alone when some other tab is removed', () => {
    reset()
    for (let n = 0; n < 3; n += 1) useWorkspaceStore.getState().addSessionTerminal('c1')
    const [a, , c] = session().tabs.map((tab) => tab.id)
    useWorkspaceStore.getState().activateSessionTerminal('c1', c ?? '')
    useWorkspaceStore.getState().removeSessionTerminalTab('c1', a ?? '')
    expect(session().activeId).toBe(c)
  })

  /*
   * The one that would otherwise be an infinite loop of terminals: removing the
   * last tab has to *close* the panel, because `normalizeTerminalPanel` mints a
   * replacement for any open panel with none. Killing your last terminal would
   * silently open a new one.
   */
  it('closes the panel when its last terminal goes, rather than minting another', () => {
    reset()
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    const only = session().activeId ?? ''
    useWorkspaceStore.getState().removeSessionTerminalTab('c1', only)
    expect(session().open).toBe(false)
    expect(session().tabs).toEqual([])
    expect(session().activeId).toBeNull()
  })

  /*
   * Hiding a panel is not killing its shells — that distinction is what the whole
   * feature rests on — so the roster has to survive being out of sight.
   */
  it('keeps the roster when the panel is hidden', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    useWorkspaceStore.getState().addSessionTerminal('c1')
    const ids = session().tabs.map((tab) => tab.id)
    useWorkspaceStore.getState().toggleSessionTerminal('c1')
    expect(session().open).toBe(false)
    expect(session().tabs.map((tab) => tab.id)).toEqual(ids)
  })

  /* Two panels, no leakage: the global one is a separate field for this reason. */
  it('adds to one scope without touching the other', () => {
    reset()
    useWorkspaceStore.getState().addSessionTerminal('c1')
    expect(globalPanel().tabs).toEqual([])
    useWorkspaceStore.getState().addGlobalTerminal()
    expect(session().tabs).toHaveLength(1)
    expect(globalPanel().tabs).toHaveLength(1)
  })
})

/**
 * Editor context has to outlive an unmounted tab — Phase 6.
 *
 * The defect this locks: the context was `useState` inside `Session`, and only
 * the active tab of each group is mounted. Switching away and back reinitialised
 * it to nothing, and any push that arrived while unmounted had nowhere to land —
 * so the composer's `ideAttached` went false and Send stopped attaching the
 * editor, for a reason that had nothing to do with the editor.
 *
 * Reducing rather than rendering, because the judgement is in the store: what a
 * remount does is read the store again, and a store that still holds the value
 * is the whole property.
 */
describe('ide context survives a remount', () => {
  const push = (over: Partial<IdeContextPush> = {}): IdeContextPush => ({
    conversationId: 'c1',
    editor: 'workbench',
    status: 'ready',
    file: null,
    ...over,
  })

  it('is still there after the component that drew it has gone', () => {
    const store = useWorkspaceStore.getState()
    store.ingestIdeContext(push())
    // A remount reads the store; it does not re-receive the push.
    expect(useWorkspaceStore.getState().ideByConversation['c1']?.workbench?.status).toBe('ready')
  })

  /*
   * The overwrite that caused this bug in the first place. The external bridge
   * pushes `unavailable` for every conversation on every runtime event when no
   * VS Code is connected, and folded into one slot it erased a live workbench
   * context within milliseconds.
   */
  it('an external unavailable does not displace a workbench ready', () => {
    const store = useWorkspaceStore.getState()
    store.ingestIdeContext(push())
    store.ingestIdeContext(push({ editor: 'external', status: 'unavailable' }))
    const entry = useWorkspaceStore.getState().ideByConversation['c1']
    expect(entry?.workbench?.status).toBe('ready')
    expect(entry?.external?.status).toBe('unavailable')
  })

  /*
   * And the lifecycle edge: once the surface is gone the workbench must stop
   * winning, or the external bridge stays suppressed behind an editor that no
   * longer exists.
   */
  it('a workbench unavailable clears the slot so the external one shows through', () => {
    const store = useWorkspaceStore.getState()
    store.ingestIdeContext(push())
    store.ingestIdeContext(push({ editor: 'external', status: 'unmatched' }))
    store.ingestIdeContext(push({ status: 'unavailable' }))
    const entry = useWorkspaceStore.getState().ideByConversation['c1']
    expect(entry?.workbench).toBeNull()
    expect(entry?.external?.status).toBe('unmatched')
  })
})

describe('a detached project', () => {
  it('focuses its window instead of opening a tab', () => {
    const focusProjectWindow = vi.fn(() => Promise.resolve({ ok: true as const }))
    const previousWindow: unknown = Reflect.get(globalThis, 'window')
    Reflect.set(globalThis, 'window', { chorus: { focusProjectWindow } })
    try {
      useWorkspaceStore.setState({
        ...EMPTY_WORKSPACE,
        detached: { p1: { paneId: 'pane-1', index: 0 } },
      })
      const before = useWorkspaceStore.getState().panes
      useWorkspaceStore.getState().openProject('p1')
      expect(focusProjectWindow).toHaveBeenCalledWith({ projectId: 'p1' })
      expect(useWorkspaceStore.getState().panes).toBe(before)
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
      else Reflect.set(globalThis, 'window', previousWindow)
      useWorkspaceStore.setState({ detached: {} })
    }
  })
})

describe('editor width persistence', () => {
  it('saves each project separately and restores the fractions with the layout', () => {
    useWorkspaceStore.setState({ editorWidthFractions: {} })
    const store = useWorkspaceStore.getState()
    store.setEditorWidthFraction('p1', 1.4)
    store.setEditorWidthFraction('p2', 0.7)
    store.setEditorWidthFraction('p1', 0)
    store.setEditorWidthFraction('p1', Number.NaN)
    const saved = workspaceSnapshot(useWorkspaceStore.getState())
    expect(saved.editorWidthFractions).toEqual({ p1: 1, p2: 0.7 })

    useWorkspaceStore.getState().hydrate(saved, [], ['p1', 'p2'])
    expect(useWorkspaceStore.getState().editorWidthFractions).toEqual({ p1: 1, p2: 0.7 })
  })
})

describe('resetProjectWidths', () => {
  it('puts every box and Traffic at its default in one update', () => {
    useWorkspaceStore.setState({
      conversationGroups: {
        p1: {
          layout: {
            kind: 'branch',
            orientation: 'row',
            children: [
              { kind: 'leaf', paneId: 'g1' },
              { kind: 'leaf', paneId: 'g2' },
            ],
            sizes: [0.7, 0.3],
          },
          panes: {
            g1: { id: 'g1', tabs: ['c1'], activeTabId: 'c1' },
            g2: { id: 'g2', tabs: ['c2'], activeTabId: 'c2' },
          },
          focusedPaneId: 'g1',
          widths: { g1: 900, g2: 760 },
        },
      },
      trafficPanels: { p1: { open: true, width: 1_200, widthCustomized: true } },
      editorWidthFractions: { p1: 1, p2: 0.7 },
    })

    const seen: string[] = []
    const stop = useWorkspaceStore.subscribe(() => {
      seen.push('update')
    })
    useWorkspaceStore.getState().resetProjectWidths('p1')
    stop()

    const state = useWorkspaceStore.getState()
    const arrangement = state.conversationGroups['p1']
    expect(seen).toHaveLength(1)
    expect(arrangement === undefined ? [] : columnWidths(arrangement)).toEqual([
      BOX_WIDTH.default,
      BOX_WIDTH.default,
    ])
    expect(state.trafficPanels['p1']).toEqual({
      open: true,
      width: TRAFFIC_WIDTH.default,
      widthCustomized: false,
    })
    expect(state.editorWidthFractions).toEqual({ p2: 0.7 })
  })
})

describe('replacing a restarted chat', () => {
  const seed = (): void => {
    useWorkspaceStore.setState({
      panes: { 'pane-1': { id: 'pane-1', tabs: ['p1', 'p2'], activeTabId: 'p1' } },
      conversationGroups: {
        p1: {
          layout: {
            kind: 'branch',
            orientation: 'row',
            children: [
              { kind: 'leaf', paneId: 'g1' },
              {
                kind: 'branch',
                orientation: 'column',
                children: [
                  { kind: 'leaf', paneId: 'g2' },
                  { kind: 'leaf', paneId: 'g3' },
                ],
                sizes: [0.25, 0.75],
              },
            ],
            sizes: [0.7, 0.3],
          },
          panes: {
            g1: { id: 'g1', tabs: ['c1'], activeTabId: 'c1' },
            g2: { id: 'g2', tabs: ['c2'], activeTabId: 'c2' },
            g3: { id: 'g3', tabs: ['c3'], activeTabId: 'c3' },
          },
          focusedPaneId: 'g1',
          widths: { g1: 900, g2: 760, g3: 760 },
        },
        p2: {
          layout: { kind: 'leaf', paneId: 'g4' },
          panes: { g4: { id: 'g4', tabs: ['c4'], activeTabId: 'c4' } },
          focusedPaneId: 'g4',
        },
      },
    })
  }

  it('swaps the focused chat in a resized row inside its own box', () => {
    seed()
    const before = useWorkspaceStore.getState()
    expect(before.replaceConversation('p1', 'c1', 'n1')).toBe(true)

    const after = useWorkspaceStore.getState()
    const was = before.conversationGroups['p1']
    const now = after.conversationGroups['p1']
    expect(now?.panes['g1']).toEqual({ id: 'g1', tabs: ['n1'], activeTabId: 'n1' })
    expect(now?.layout).toBe(was?.layout)
    expect(now?.widths).toBe(was?.widths)
    expect(now?.focusedPaneId).toBe('g1')
    expect(now?.panes['g2']).toBe(was?.panes['g2'])
    expect(now?.panes['g3']).toBe(was?.panes['g3'])
    expect(after.conversationGroups['p2']).toBe(before.conversationGroups['p2'])
    expect(after.panes).toBe(before.panes)
  })

  it('swaps a chat in a resized vertical split without moving the caret', () => {
    seed()
    const before = useWorkspaceStore.getState()
    expect(before.replaceConversation('p1', 'c3', 'n3')).toBe(true)

    const now = useWorkspaceStore.getState().conversationGroups['p1']
    const was = before.conversationGroups['p1']
    expect(now?.panes['g3']).toEqual({ id: 'g3', tabs: ['n3'], activeTabId: 'n3' })
    expect(now?.layout).toBe(was?.layout)
    expect(now?.widths).toBe(was?.widths)
    expect(now?.focusedPaneId).toBe('g1')
    expect(now?.panes['g1']).toBe(was?.panes['g1'])
    expect(now?.panes['g2']).toBe(was?.panes['g2'])
  })

  it('refuses, and changes nothing, when the chat has no box in that project', () => {
    seed()
    const before = useWorkspaceStore.getState().conversationGroups
    expect(useWorkspaceStore.getState().replaceConversation('p1', 'c4', 'n4')).toBe(false)
    expect(useWorkspaceStore.getState().replaceConversation('p9', 'c1', 'n1')).toBe(false)
    expect(useWorkspaceStore.getState().conversationGroups).toBe(before)
  })
})

const MAIN = [{ id: 'main' }]
const SPLIT = [{ id: 'main' }, { id: 's2' }]

describe('project widths', () => {
  it('keeps Traffic at its 500px floor', () => {
    useWorkspaceStore.setState({
      trafficPanels: { p1: { open: false, width: 800, widthCustomized: true } },
    })
    useWorkspaceStore.getState().setTrafficWidth('p1', 120)
    expect(useWorkspaceStore.getState().trafficPanels['p1']).toEqual({
      open: false,
      width: TRAFFIC_WIDTH.min,
      widthCustomized: true,
    })
  })

  it('keeps the default through collapse and saves a future resize across reloads', () => {
    useWorkspaceStore.setState({ ...EMPTY_WORKSPACE })
    const store = useWorkspaceStore.getState()
    store.setTrafficCollapsed('p1', true)
    store.setTrafficCollapsed('p1', false)
    const initial = useWorkspaceStore.getState().trafficPanels['p1']
    expect(initial).toEqual({ open: false, width: 500, collapsed: false })
    store.setTrafficWidth('p1', 500)
    expect(useWorkspaceStore.getState().trafficPanels['p1']).toBe(initial)

    store.setTrafficWidth('p1', 800)
    store.setTrafficCollapsed('p1', true)
    store.setTrafficCollapsed('p1', false)
    const saved = WorkspaceSnapshot.parse(workspaceSnapshot(useWorkspaceStore.getState()))
    store.hydrate(saved, [], ['p1'])
    expect(useWorkspaceStore.getState().trafficPanels['p1']).toEqual({
      open: false,
      width: 800,
      widthCustomized: true,
      collapsed: false,
    })

    store.resetProjectWidths('p1')
    const reset = WorkspaceSnapshot.parse(workspaceSnapshot(useWorkspaceStore.getState()))
    store.hydrate(reset, [], ['p1'])
    expect(useWorkspaceStore.getState().trafficPanels['p1']).toEqual({
      open: false,
      width: 500,
      widthCustomized: false,
      collapsed: false,
    })
  })

  it('keeps the run terminal pane at its own floor, one project at a time', () => {
    useWorkspaceStore.setState({ projectTerminals: { p2: { width: 900, shells: SPLIT } } })
    useWorkspaceStore.getState().setProjectTerminalWidth('p1', 120)
    useWorkspaceStore.getState().setProjectTerminalWidth('p2', 700.4)
    expect(useWorkspaceStore.getState().projectTerminals).toEqual({
      p1: { width: 480, shells: MAIN },
      p2: { width: 700, shells: SPLIT },
    })
  })

  it('puts the run terminal pane back to 500 with the row’s widths, keeping its shells', () => {
    useWorkspaceStore.setState({
      trafficPanels: { p1: { open: true, width: 1_200, widthCustomized: true } },
      projectTerminals: { p1: { width: 1_000, shells: SPLIT }, p2: { width: 900, shells: MAIN } },
    })
    useWorkspaceStore.getState().resetProjectWidths('p1')
    const state = useWorkspaceStore.getState()
    expect(state.projectTerminals).toEqual({
      p1: { width: 500, shells: SPLIT },
      p2: { width: 900, shells: MAIN },
    })
    expect(state.trafficPanels['p1']).toEqual({
      open: true,
      width: TRAFFIC_WIDTH.default,
      widthCustomized: false,
    })
    expect(workspaceSnapshot(state).projectTerminals).toEqual(state.projectTerminals)
  })
})

describe('project shells', () => {
  it('adds shell rows with fresh ids without widening the pane', () => {
    useWorkspaceStore.setState({ projectTerminals: {} })
    const store = useWorkspaceStore.getState()
    const added = Array.from({ length: 7 }, () => store.addProjectShell('p1'))

    const pane = useWorkspaceStore.getState().projectTerminals['p1']
    expect(new Set(added).size).toBe(7)
    expect(added).not.toContain('main')
    expect(pane?.shells.map((shell) => shell.id)).toEqual(['main', ...added])
    expect(pane?.width).toBe(500)
    expect(useWorkspaceStore.getState().projectTerminals['p2']).toBeUndefined()
  })

  it('keeps a wider pane as it was when a shell is added', () => {
    useWorkspaceStore.setState({ projectTerminals: { p1: { width: 1_500, shells: MAIN } } })
    useWorkspaceStore.getState().addProjectShell('p1')
    expect(useWorkspaceStore.getState().projectTerminals['p1']?.width).toBe(1_500)
  })

  it('removes a shell but never the last one', () => {
    useWorkspaceStore.setState({ projectTerminals: { p1: { width: 960, shells: SPLIT } } })
    const store = useWorkspaceStore.getState()
    store.removeProjectShell('p1', 'main')
    expect(useWorkspaceStore.getState().projectTerminals['p1']).toEqual({
      width: 960,
      shells: [{ id: 's2' }],
    })
    store.removeProjectShell('p1', 's2')
    store.removeProjectShell('p1', 'gone')
    store.removeProjectShell('p2', 'main')
    expect(useWorkspaceStore.getState().projectTerminals).toEqual({
      p1: { width: 960, shells: [{ id: 's2' }] },
    })
  })
})

describe('row scroll', () => {
  it('keeps two projects’ offsets apart', () => {
    useWorkspaceStore.setState({ rowScroll: {} })
    const store = useWorkspaceStore.getState()
    store.setRowScroll('a', 640)
    store.setRowScroll('b', -500)
    expect(useWorkspaceStore.getState().rowScroll).toEqual({ a: 640, b: -500 })
  })

  it('does not update for an unchanged offset or one a row could not report', () => {
    useWorkspaceStore.setState({ rowScroll: { a: 640 } })
    const seen: string[] = []
    const stop = useWorkspaceStore.subscribe(() => {
      seen.push('update')
    })
    const store = useWorkspaceStore.getState()
    store.setRowScroll('a', 640)
    store.setRowScroll('a', Number.NEGATIVE_INFINITY)
    store.setRowScroll('a', Number.NaN)
    store.setRowScroll('b', Number.POSITIVE_INFINITY)
    stop()
    expect(seen).toHaveLength(0)
    expect(useWorkspaceStore.getState().rowScroll).toEqual({ a: 640 })
  })

  it('saves zero when the row is revealed', () => {
    useWorkspaceStore.setState({ rowScroll: { a: 640 } })
    useWorkspaceStore.getState().setRowScroll('a', 0)
    expect(useWorkspaceStore.getState().rowScroll).toEqual({ a: 0 })
  })

  it('is written with the rest of the snapshot', () => {
    useWorkspaceStore.setState({ rowScroll: { a: 640 } })
    const persisted = workspaceSnapshot(useWorkspaceStore.getState())
    expect(persisted.rowScroll).toEqual({ a: 640 })
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(WorkspaceSnapshot.shape).sort())
  })
})

describe('web tabs', () => {
  const reset = (): void => {
    useWorkspaceStore.setState({ ...EMPTY_WORKSPACE, hydrated: true, detached: {} })
  }

  it('adds independent tabs and preserves order when inserting after an opener', () => {
    reset()
    const state = useWorkspaceStore.getState()
    const first = state.addWebTab(true)
    const last = state.addWebTab(false)
    state.insertWebTab('linked-tab', 1, false)
    expect(useWorkspaceStore.getState().webTabs).toEqual({
      tabs: [{ id: first }, { id: 'linked-tab' }, { id: last }],
      activeId: first,
      showing: true,
    })
  })

  it('closing selects the right neighbour then the left and returns to projects when empty', () => {
    reset()
    const state = useWorkspaceStore.getState()
    state.insertWebTab('left', 0, false)
    state.insertWebTab('middle', 1, true)
    state.insertWebTab('right', 2, false)
    state.closeWebTab('middle')
    expect(useWorkspaceStore.getState().webTabs.activeId).toBe('right')
    state.closeWebTab('right')
    expect(useWorkspaceStore.getState().webTabs.activeId).toBe('left')
    state.closeWebTab('left')
    expect(useWorkspaceStore.getState().webTabs).toEqual(EMPTY_WORKSPACE.webTabs)
  })

  it('closing a background tab keeps the selection and whether projects are showing', () => {
    reset()
    const state = useWorkspaceStore.getState()
    state.insertWebTab('first', 0, true)
    state.insertWebTab('second', 1, false)
    state.showProjects()
    state.closeWebTab('second')
    expect(useWorkspaceStore.getState().webTabs).toEqual({
      tabs: [{ id: 'first' }],
      activeId: 'first',
      showing: false,
    })
  })

  it('repairs invalid, duplicate and overflow ids during hydration without losing projects', () => {
    reset()
    const tabs = [
      '',
      'has space',
      'has/slash',
      'x'.repeat(129),
      'valid',
      'valid',
      ...Array.from({ length: WEB_TABS_MAX + 5 }, (_, index) => `tab-${String(index)}`),
    ]
    const saved: WorkspaceSnapshot = {
      ...EMPTY_WORKSPACE,
      layout: { kind: 'leaf', paneId: 'saved-pane' },
      panes: { 'saved-pane': { id: 'saved-pane', tabs: ['p1'], activeTabId: 'p1' } },
      focusedPaneId: 'saved-pane',
      webTabs: { tabs: tabs.map((id) => ({ id })), activeId: 'missing', showing: true },
    }
    useWorkspaceStore.getState().hydrate(saved, ['c1'], ['p1'], {}, { p1: ['c1'] })
    const state = useWorkspaceStore.getState()
    expect(state.webTabs.tabs).toHaveLength(WEB_TABS_MAX)
    expect(state.webTabs.tabs[0]?.id).toBe('valid')
    expect(new Set(state.webTabs.tabs.map((tab) => tab.id)).size).toBe(WEB_TABS_MAX)
    expect(state.webTabs.activeId).toBe('valid')
    expect(state.layout).toEqual(saved.layout)
    expect(state.focusedPaneId).toBe('saved-pane')
    expect(state.panes['saved-pane']).toEqual(saved.panes['saved-pane'])
    expect(state.panes[state.focusedPaneId ?? '']?.tabs).toEqual(['p1'])
    expect(state.addWebTab(true)).toBe('')
  })

  it('moves a tab to a clamped final index without changing selection or showing', () => {
    reset()
    const state = useWorkspaceStore.getState()
    state.insertWebTab('first', 0, false)
    state.insertWebTab('second', 1, true)
    state.insertWebTab('third', 2, false)
    state.moveWebTab('first', 999)
    expect(useWorkspaceStore.getState().webTabs).toEqual({
      tabs: [{ id: 'second' }, { id: 'third' }, { id: 'first' }],
      activeId: 'second',
      showing: true,
    })
    state.moveWebTab('first', -999)
    expect(useWorkspaceStore.getState().webTabs.tabs.map((tab) => tab.id)).toEqual([
      'first',
      'second',
      'third',
    ])
    state.showProjects()
    state.moveWebTab('second', 2)
    expect(useWorkspaceStore.getState().webTabs).toEqual({
      tabs: [{ id: 'first' }, { id: 'third' }, { id: 'second' }],
      activeId: 'second',
      showing: false,
    })
    expect(workspaceSnapshot(useWorkspaceStore.getState()).webTabs.tabs).toEqual([
      { id: 'first' },
      { id: 'third' },
      { id: 'second' },
    ])
  })

  it('does not publish a roster change for unknown ids or unchanged positions', () => {
    reset()
    const state = useWorkspaceStore.getState()
    state.insertWebTab('only', 0, true)
    const before = useWorkspaceStore.getState().webTabs
    state.moveWebTab('missing', 0)
    state.moveWebTab('only', 0)
    state.moveWebTab('only', -10)
    state.moveWebTab('only', 10)
    state.moveWebTab('only', Number.NaN)
    expect(useWorkspaceStore.getState().webTabs).toBe(before)
    state.closeWebTab('only')
    const empty = useWorkspaceStore.getState().webTabs
    state.moveWebTab('only', 0)
    expect(useWorkspaceStore.getState().webTabs).toBe(empty)
  })

  it('intentional project reveals hide web tabs and preserve their roster', () => {
    reset()
    const state = useWorkspaceStore.getState()
    state.hydrate(null, ['c1'], ['p1'], {}, { p1: ['c1'] })
    state.insertWebTab('web', 0, true)
    const paneId = useWorkspaceStore.getState().focusedPaneId ?? ''
    state.activateTab(paneId, 'p1')
    expect(useWorkspaceStore.getState().webTabs.showing).toBe(false)
    state.activateWebTab('web')
    state.openProject('p1')
    expect(useWorkspaceStore.getState().webTabs.showing).toBe(false)
    state.activateWebTab('web')
    state.showConversation('p1', 'c1')
    expect(useWorkspaceStore.getState().webTabs).toEqual({
      tabs: [{ id: 'web' }],
      activeId: 'web',
      showing: false,
    })
  })

  it('includes the roster, selection and showing state in every snapshot', () => {
    reset()
    useWorkspaceStore.getState().insertWebTab('saved-web', 0, true)
    const snapshot = workspaceSnapshot(useWorkspaceStore.getState())
    expect(snapshot.webTabs).toEqual({
      tabs: [{ id: 'saved-web' }],
      activeId: 'saved-web',
      showing: true,
    })
    expect(WorkspaceSnapshot.parse(snapshot).webTabs).toEqual(snapshot.webTabs)
    expect(
      sameWorkspaceSnapshot(snapshot, {
        ...snapshot,
        webTabs: { ...snapshot.webTabs, showing: false },
      })
    ).toBe(false)
  })
})

describe('web tab initial pages and commands', () => {
  const empty: BrowserState = {
    status: 'empty',
    live: false,
    url: null,
    title: '',
    icon: null,
    canGoBack: false,
    canGoForward: false,
    documentId: null,
    passwordOrigin: null,
    error: null,
    zoom: 1,
  }
  let stop: (() => void) | null = null

  afterEach(() => {
    stop?.()
    stop = null
    useWorkspaceStore.setState({ ...EMPTY_WORKSPACE, hydrated: true, detached: {} })
    vi.unstubAllGlobals()
  })

  const setup = (saved: WorkspaceSnapshot | null = null) => {
    useWorkspaceStore.setState({ ...EMPTY_WORKSPACE, hydrated: false, detached: {} })
    useWorkspaceStore.getState().hydrate(saved, [], [])
    const attachBrowser = vi.fn<BrowserApi['attachBrowser']>((request) => {
      if (!('webTabId' in request)) return Promise.reject(new Error('Expected a web tab'))
      return Promise.resolve({
        browserId: `browser-${request.webTabId}`,
        state: empty,
        settings: 'ready',
        favorites: [],
      })
    })
    const navigateBrowser = vi.fn<BrowserApi['navigateBrowser']>((request) =>
      Promise.resolve({ state: { ...empty, url: request.address }, failure: null })
    )
    const reopenBrowser = vi.fn<BrowserApi['reopenBrowser']>(() =>
      Promise.resolve({ reopened: null })
    )
    let listener: ((push: BrowserPush) => void) | null = null
    vi.stubGlobal('window', {
      chorus: {
        attachBrowser,
        navigateBrowser,
        reopenBrowser,
        closeBrowser: vi.fn<BrowserApi['closeBrowser']>(() => Promise.resolve({ ok: true })),
        announceWebReady: vi.fn<BrowserApi['announceWebReady']>(() =>
          Promise.resolve({ ok: true })
        ),
        readBrowserDownloads: vi.fn<BrowserApi['readBrowserDownloads']>(() =>
          Promise.resolve({ downloads: [] })
        ),
        onBrowser: (next: (push: BrowserPush) => void) => {
          listener = next
          return () => {
            listener = null
          }
        },
      },
    })
    const commit = vi.fn()
    stop = startWebPages(commit)
    return {
      attachBrowser,
      navigateBrowser,
      reopenBrowser,
      commit,
      push: (push: BrowserPush): void => {
        listener?.(push)
      },
    }
  }

  it('requests Home once after a fresh new tab attaches', async () => {
    const { attachBrowser, navigateBrowser } = setup()
    runWebCommand('new-tab')
    const id = useWorkspaceStore.getState().webTabs.activeId ?? ''
    expect(navigateBrowser).not.toHaveBeenCalled()
    await attachWebPage(id)
    await attachWebPage(id)
    expect(attachBrowser).toHaveBeenCalledTimes(1)
    expect(navigateBrowser).toHaveBeenCalledTimes(1)
    expect(navigateBrowser).toHaveBeenCalledWith({
      browserId: `browser-${id}`,
      address: BROWSER_HOME_URL,
    })
  })

  it('keeps the Home request through an attach failure and retry', async () => {
    const { attachBrowser, navigateBrowser } = setup()
    attachBrowser.mockRejectedValueOnce(new Error('Attach failed'))
    runWebCommand('new-tab')
    const id = useWorkspaceStore.getState().webTabs.activeId ?? ''
    await attachWebPage(id)
    expect(navigateBrowser).not.toHaveBeenCalled()
    await attachWebPage(id)
    await attachWebPage(id)
    expect(attachBrowser).toHaveBeenCalledTimes(2)
    expect(navigateBrowser).toHaveBeenCalledTimes(1)
    expect(navigateBrowser).toHaveBeenCalledWith({
      browserId: `browser-${id}`,
      address: BROWSER_HOME_URL,
    })
  })

  it('does not request Home for a restored roster tab', async () => {
    const { attachBrowser, navigateBrowser } = setup({
      ...EMPTY_WORKSPACE,
      webTabs: { tabs: [{ id: 'restored' }], activeId: 'restored', showing: true },
    })
    await attachWebPage('restored')
    expect(useWorkspaceStore.getState().webTabs.tabs).toEqual([{ id: 'restored' }])
    expect(attachBrowser).toHaveBeenCalledWith({ webTabId: 'restored' })
    expect(navigateBrowser).not.toHaveBeenCalled()
  })

  it('does not request Home for a tab opened by the page or a context menu', async () => {
    const { push, navigateBrowser } = setup()
    push({
      kind: 'tab-open',
      browserId: 'browser-linked',
      webTabId: 'linked',
      openerWebTabId: null,
      background: true,
      state: { ...empty, url: 'https://example.com/link' },
    })
    await attachWebPage('linked')
    expect(useWorkspaceStore.getState().webTabs.tabs).toEqual([{ id: 'linked' }])
    expect(navigateBrowser).not.toHaveBeenCalled()
  })

  it('does not request Home for a reopened tab', async () => {
    const { reopenBrowser, navigateBrowser } = setup()
    reopenBrowser.mockResolvedValueOnce({
      reopened: { webTabId: 'reopened', index: 0, state: empty },
    })
    runWebCommand('reopen-tab')
    await Promise.resolve()
    await attachWebPage('reopened')
    expect(useWorkspaceStore.getState().webTabs.activeId).toBe('reopened')
    expect(navigateBrowser).not.toHaveBeenCalled()
  })

  it('commits reorders immediately and keeps the selected tab through keyboard moves', async () => {
    const { commit } = setup()
    runWebCommand('new-tab')
    const first = useWorkspaceStore.getState().webTabs.activeId ?? ''
    await attachWebPage(first)
    runWebCommand('new-tab')
    const second = useWorkspaceStore.getState().webTabs.activeId ?? ''
    await attachWebPage(second)
    commit.mockClear()
    runWebCommand('move-tab-left')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(useWorkspaceStore.getState().webTabs).toEqual({
      tabs: [{ id: second }, { id: first }],
      activeId: second,
      showing: true,
    })
    runWebCommand('move-tab-left')
    expect(commit).toHaveBeenCalledTimes(1)
    runWebCommand('move-tab-right')
    expect(commit).toHaveBeenCalledTimes(2)
    expect(workspaceSnapshot(useWorkspaceStore.getState()).webTabs.tabs).toEqual([
      { id: first },
      { id: second },
    ])
    useWorkspaceStore.getState().showProjects()
    const before = useWorkspaceStore.getState().webTabs
    runWebCommand('move-tab-left')
    expect(useWorkspaceStore.getState().webTabs).toBe(before)
  })
})
