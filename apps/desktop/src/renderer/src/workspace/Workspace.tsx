import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceLayoutNode } from '../../../shared/workspace-layout.js'
import type { AgentId, SessionInfo } from '../Session.js'
import { QuickRail } from './QuickRail.js'
import { ConversationTree } from './ConversationTree.js'
import { useConversationDrag } from './useConversationDrag.js'
import { useShellOverlay } from './overlay.js'
import { createPreviewController, ProjectPreviewHost } from './SessionPreview.js'
import { TerminalPanel } from '../TerminalPanel.js'
import type { TerminalRefShape } from '../../../shared/ipc.js'
import { leafPaneIds, type SplitDirection } from './layout.js'
import { WorkbenchFrame } from '../workbench/WorkbenchFrame.js'
import {
  useConversationGroups,
  useChorusWidth,
  useWorkbenchShown,
  usePane,
  useGlobalTerminal,
  useSessionRowState,
  useWorkspaceActions,
  useWorkspaceLayout,
} from './hooks.js'
import { stateOf } from './session-row.js'
import { StateMark } from './SessionRow.js'
import type { ProjectInfo } from './session-row.js'
import { countRender } from './render-count.js'
import { monogramOf, stepSlot } from './session-row.js'
import { useWorkspaceStore } from './store.js'
import { useTabDrag, type ActiveTabDrag } from './useTabDrag.js'
import { primaryAlt, primaryOnly, primaryShift, shortcutLabel } from '../shortcuts.js'

/**
 * The shell: a rail of sessions on the left, panes filling the rest.
 *
 * **Reconstructed on 2026-08-14, and the reason belongs here.** A `git checkout`
 * of this file — run against a working tree where the rail work had never been
 * committed — reverted it to a version predating all of it. What follows was
 * rebuilt from the last production bundle, which is unminified and keeps its
 * region markers, so the *code* came back exactly. The comments did not: a build
 * strips them. Everything explanatory in this file was therefore written fresh,
 * and where a decision is not evident from the code it is now unrecorded rather
 * than wrong.
 *
 * The drawer went in the same pass, deliberately: `SessionList`, its resize
 * handle, the sidebar width, search, history and Arrange mode. Sessions are the
 * rail's tiles; what a session can do lives in its composer, in the card that
 * opens on hover, and — for the cast, the folder and permissions — in the menu
 * the composer's settings control opens.
 */

interface WorkspaceProps {
  readonly sessions: readonly SessionInfo[]
  readonly starting: boolean
  readonly onNewSession: () => void
  /** Starts a conversation in one named project — the `+` inside a pane. */
  readonly onStartInProject: (projectId: string) => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onEnd: (conversationId: string) => void
  readonly onCommitLayout: () => void
  /** A card dropped at a new place in the rail's order. */
  readonly onReorderSessions: (conversationId: string, slot: number) => void
  readonly onOpenSettings: () => void
  /** Opens the list of every conversation the log holds, not only the open ones. */
  readonly onOpenHistory: () => void
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly onToggleAgent: (
    conversationId: string,
    agentId: AgentId,
    present: boolean
  ) => Promise<void>
  readonly projects: readonly ProjectInfo[]
  readonly onRenameProject: (projectId: string, name: string) => void
  /** Project-level, and it reaches every conversation in the project. */
  readonly onToggleProjectAgent: (
    projectId: string,
    agentId: AgentId,
    present: boolean
  ) => Promise<void>
  readonly onChooseProjectProfile: (projectId: string, profileId: string) => Promise<void>
  readonly onAddProject: () => Promise<void>
  /** Starts a conversation in a project. There is no other way to start one. */
  readonly onOpenProject: (projectId: string) => void
  readonly home: string
  readonly onChooseProfile: (conversationId: string, profileId: string) => Promise<void>
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}

/**
 * A tab's own state mark, in its own component because of the hook.
 *
 * `useSessionRowState` subscribes to one conversation's slice of the pulse, and
 * the tabs are produced by a `map` — so this cannot be inlined without calling a
 * hook in a loop. Splitting it also means a session going busy re-renders one
 * tab rather than the whole strip.
 */
function TabState({ conversationId }: { conversationId: string }): React.JSX.Element {
  const row = useSessionRowState(conversationId)
  const state = stateOf(row)
  return (
    <span className="workspace-tab-state" data-state={state}>
      <StateMark state={state} voice={row.working.length === 1 ? (row.working[0] ?? null) : null} />
    </span>
  )
}

function directionFromKey(key: string): SplitDirection | null {
  if (key === 'ArrowLeft') return 'left'
  if (key === 'ArrowRight') return 'right'
  if (key === 'ArrowUp') return 'up'
  if (key === 'ArrowDown') return 'down'
  return null
}

/**
 * The nearest pane in a direction, by where the panes actually are.
 *
 * Geometry rather than tree order: the layout is a tree of splits, and "the pane
 * to the right" is a question about the screen, not about which branch a node
 * happens to sit in. Cross-axis distance counts double, so a pane directly
 * beside wins over one further along but off to the side.
 */
function directionalPane(paneId: string, direction: SplitDirection): string | null {
  const source = document.querySelector(`[data-workspace-pane="${paneId}"]`)
  if (source === null) return null
  const sourceRect = source.getBoundingClientRect()
  const sx = sourceRect.left + sourceRect.width / 2
  const sy = sourceRect.top + sourceRect.height / 2
  const candidates = [...document.querySelectorAll('[data-workspace-pane]')].flatMap((pane) => {
    const id = (pane as HTMLElement).dataset['workspacePane']
    if (id === undefined || id === paneId) return []
    const rect = pane.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const dx = x - sx
    const dy = y - sy
    const primary =
      direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy
    if (primary <= 1) return []
    return [
      {
        id,
        primary,
        cross: direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx),
      },
    ]
  })
  candidates.sort((a, b) => a.primary + a.cross * 2 - (b.primary + b.cross * 2))
  return candidates[0]?.id ?? null
}

/**
 * How the global panel names one of its shells.
 *
 * The panel holds the roster and asks for a ref per tab, so scope construction
 * stays out here — `TerminalPanel` is shared by both scopes and must not learn
 * to build either. This replaced a module constant that existed to keep
 * `TerminalView`'s effect from tearing down; that reason expired when the effect
 * started depending on the ref's *parts* rather than on the object.
 */
function globalTerminalRef(id: string): TerminalRefShape {
  return { scope: 'global', id }
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { t } = useTranslation()
  countRender('Workspace')
  const { layout, focusedPaneId } = useWorkspaceLayout()
  const {
    placeSession,
    splitWithSession,
    showConversation,
    closeTab,
    activateTab,
    focusPane,
    reorderTab,
    setGlobalTerminalOpen,
    toggleGlobalTerminal,
    setGlobalTerminalHeight,
    addGlobalTerminal,
    activateGlobalTerminal,
    removeGlobalTerminalTab,
  } = useWorkspaceActions()
  const globalTerminal = useGlobalTerminal()
  const sessions = useMemo(
    () => new Map(props.sessions.map((session) => [session.conversationId, session])),
    [props.sessions]
  )
  const preview = useRef(createPreviewController()).current
  const commit = props.onCommitLayout
  const drag = useTabDrag({
    onInsert: useCallback(
      (conversationId: string, paneId: string, slot: number) => {
        placeSession(conversationId, paneId, slot)
        commit()
      },
      [placeSession, commit]
    ),
    onSplit: useCallback(
      (conversationId: string, paneId: string, direction: SplitDirection) => {
        splitWithSession(conversationId, paneId, direction)
        commit()
      },
      [splitWithSession, commit]
    ),
    onReorder: props.onReorderSessions,
  })

  /*
   * A drag is an overlay, for the same reason a dialog is.
   *
   * The drop shading and the pane outlines are DOM, and a `WebContentsView` is
   * composited above the DOM — so every zone that mattered was drawn *underneath*
   * the editor it was pointing at, and the only visible ones were over Chorus.
   * There is no z-index that reaches a native view; hiding it is the only lever.
   *
   * This reuses the still-frame path, which is what makes it tolerable: main
   * captures each surface as it hides it and the frames paint that, so the editor
   * appears frozen for the length of the drag rather than blinking out. A drag
   * lasts long enough for the capture's round trip to be invisible, unlike the
   * hover card that path was written for.
   */
  useShellOverlay(drag.drag !== null)
  /*
   * A rail tile drags the **project**, which is what a pane tab is keyed by.
   *
   * It goes through the same `onPointerDown` as a tab, and that is correct even
   * though the parameter is still named `conversationId`: the drag module moves
   * whatever a tab holds, and a tab holds a project id. The name is the last of
   * the re-key residue and is being corrected with the drag module itself, not
   * here — renaming the parameter without reworking `onReorder`, which really
   * does want a conversation, would trade one wrong name for another.
   */
  const onProjectPointerDown = useCallback(
    (projectId: string, name: string, event: ReactPointerEvent<HTMLElement>) => {
      drag.onPointerDown(projectId, name, null, event)
    },
    [drag]
  )

  /*
   * The shortcuts, on the document in the capture phase.
   *
   * Capture, because a pane's own handlers would otherwise swallow them, and
   * `defaultPrevented` is checked first so anything that has already claimed a
   * key keeps it. `⌘K` opens a 1.5-second chord: the arrow that follows splits
   * the focused pane, or moves the tab into the neighbouring one with Shift.
   */
  const chordUntil = useRef(0)
  const commitRef = useRef(commit)
  commitRef.current = commit
  /*
   * The shortcut effect runs once, so anything it reads from props would be
   * frozen at the first render — a reorder computed against the session list as
   * it was at launch. The same reason `commitRef` exists directly above.
   */
  const sessionsRef = useRef(props.sessions)
  sessionsRef.current = props.sessions
  const reorderRef = useRef(props.onReorderSessions)
  reorderRef.current = props.onReorderSessions
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const state = useWorkspaceStore.getState()
      const paneId = state.focusedPaneId
      const pane = paneId === null ? undefined : state.panes[paneId]
      const activeId = pane?.activeTabId ?? null
      const inTerminal = document.activeElement?.closest('.terminal-panel') != null

      if (primaryShift(event) && !event.altKey && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        state.toggleGlobalTerminal()
        return
      }
      /*
       * ⌘J used to open this session's own terminal and no longer exists.
       *
       * A project pane carries a workbench with its own terminal on the REH, so
       * the chord is left alone here rather than swallowed — the workbench binds
       * `⌃\`` for it, and a shell inside the editor should answer the editor's
       * key. ⌘⇧J still opens the global terminal, which belongs to no project
       * and is still a PTY in main.
       */

      /*
       * ⌘⇧G opened this session's Changes panel and is now unbound.
       *
       * The panel is gone: changes are read from git inside the workbench, which
       * has its own SCM view and its own bindings for it. Left unbound rather
       * than re-pointed at the workbench's view — a chord that reaches into the
       * editor from outside it is a second way to do something the editor
       * already does, and `activeId` is a *project* here anyway.
       */

      /*
       * ⌃⇧` — another terminal in whichever panel you are in. VS Code's binding.
       *
       * **`event.code`, not `event.key`**, and it is the one place in this
       * handler where that matters. Every other chord here reads
       * `event.key.toLowerCase()`, which is right for a letter and wrong for
       * this one: with Shift held, `key` is `~`. Copying the surrounding style
       * produces a shortcut that silently never fires.
       *
       * **`event.repeat` is rejected**, because this creates a *process*. No
       * other chord here does, so no other chord needs the guard — holding this
       * one would otherwise spawn shells at the OS key-repeat rate, which is the
       * only way a person reaches forty terminals by accident.
       */
      /*
       * Ctrl on *both* platforms, because it is VS Code's binding rather than a
       * primary-modifier chord. On Windows Ctrl is also the primary modifier,
       * so what keeps this distinct from `Ctrl+\`` is Shift plus the physical
       * key code — not the `!metaKey` guard, which there only means "the
       * Windows key is not held".
       */
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.metaKey &&
        !event.altKey &&
        event.code === 'Backquote'
      ) {
        /*
         * Not from inside a sheet, and this one spawns a process.
         *
         * `useDialog` traps Tab and claims Escape and nothing else, so every
         * other key reaches this handler while Settings, History or a
         * confirmation is on screen. Most chords here rearrange panes, which is
         * merely surprising behind an overlay; this one starts a **shell** in
         * whichever session was last focused, out of sight, and the person who
         * pressed it has no way to know. `preventDefault` comes after the guard
         * so a sheet that grows its own use for the chord still gets it.
         */
        if (document.activeElement?.closest('.sheet-backdrop') != null) return
        event.preventDefault()
        if (event.repeat) return
        // Same "which panel" question as ⌘J, answered the same way.
        if (document.activeElement?.closest('.terminal-panel--global') != null) {
          state.addGlobalTerminal()
          return
        }
        if (activeId === null) return
        state.addSessionTerminal(activeId)
        return
      }
      if (primaryOnly(event) && event.key.toLowerCase() === 'k' && !inTerminal) {
        event.preventDefault()
        chordUntil.current = performance.now() + 1500
        return
      }

      const direction = directionFromKey(event.key)
      if (direction !== null && performance.now() <= chordUntil.current && !inTerminal) {
        event.preventDefault()
        chordUntil.current = 0
        if (paneId === null || activeId === null) return
        if (event.shiftKey) {
          const targetPaneId = directionalPane(paneId, direction)
          const target = targetPaneId === null ? undefined : state.panes[targetPaneId]
          if (targetPaneId !== null && target !== undefined) {
            state.moveTab(activeId, targetPaneId, target.tabs.length)
            commitRef.current()
          }
        } else {
          state.splitTab(activeId, paneId, direction)
          commitRef.current()
        }
        return
      }
      if (performance.now() > chordUntil.current) chordUntil.current = 0

      /*
       * `⌘⌥⇧↑/↓` moves the focused session in the rail — the same gesture as
       * `⌘⌥⇧←/→` moving a tab in its strip, one axis round. Handled before the
       * pane-focus arm below, which would otherwise take the arrow.
       */
      if (
        primaryAlt(event) &&
        event.shiftKey &&
        (direction === 'up' || direction === 'down') &&
        activeId !== null
      ) {
        event.preventDefault()
        const order = sessionsRef.current.map((session) => session.conversationId)
        const slot = stepSlot(order, activeId, direction)
        if (slot !== null) reorderRef.current(activeId, slot)
        return
      }
      if (primaryAlt(event) && direction !== null && paneId !== null) {
        event.preventDefault()
        if (
          event.shiftKey &&
          (direction === 'left' || direction === 'right') &&
          pane !== undefined
        ) {
          const from = activeId === null ? -1 : pane.tabs.indexOf(activeId)
          if (from >= 0) state.reorderTab(paneId, from, from + (direction === 'left' ? -1 : 2))
          commitRef.current()
          return
        }
        const target = directionalPane(paneId, direction)
        if (target !== null) state.focusPane(target)
        return
      }
      if (primaryOnly(event) && event.key === '\\') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.splitTab(activeId, paneId, 'right')
        commitRef.current()
        return
      }
      if (primaryOnly(event) && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (paneId !== null && activeId !== null) state.closeTab(paneId, activeId)
        commitRef.current()
        return
      }
      if (primaryShift(event) && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        if (paneId === null || pane === undefined || pane.tabs.length === 0) return
        const next =
          (Math.max(0, pane.tabs.indexOf(activeId ?? '')) +
            (event.key === '[' ? -1 : 1) +
            pane.tabs.length) %
          pane.tabs.length
        const id = pane.tabs[next]
        if (id !== undefined) state.activateTab(paneId, id)
        return
      }
      if (primaryOnly(event) && /^[1-4]$/.test(event.key)) {
        const target = leafPaneIds(state.layout)[Number(event.key) - 1]
        if (target !== undefined) {
          event.preventDefault()
          state.focusPane(target)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  return (
    <div className="workspace-shell">
      <QuickRail
        sessions={props.sessions}
        starting={props.starting}
        preview={preview}
        onNewSession={props.onNewSession}
        projects={props.projects}
        onAddProject={props.onAddProject}
        onOpenProject={props.onOpenProject}
        onOpenSettings={props.onOpenSettings}
        onOpenHistory={props.onOpenHistory}
        terminalOpen={globalTerminal.open}
        onToggleTerminal={toggleGlobalTerminal}
        onProjectPointerDown={onProjectPointerDown}
        onReorderSessions={props.onReorderSessions}
        draggingId={drag.drag?.fromRail === true ? drag.drag.conversationId : null}
        consumeSuppressedClick={drag.consumeSuppressedClick}
      />
      <main className="workspace-editor" aria-label="Workspace">
        {layout === null ? (
          <EmptyWorkspace />
        ) : (
          <LayoutView
            node={layout}
            path={[]}
            sessions={sessions}
            focusedPaneId={focusedPaneId}
            drag={drag.drag}
            onTabPointerDown={drag.onPointerDown}
            onStartInProject={props.onStartInProject}
            onEndConversation={props.onEnd}
            consumeSuppressedClick={drag.consumeSuppressedClick}
            onActivate={activateTab}
            onFocus={focusPane}
            onClose={closeTab}
            onReorder={reorderTab}
            onRename={props.onRename}
            onCommitLayout={props.onCommitLayout}
            renderSession={props.renderSession}
          />
        )}
        {/*
            The global terminal, inside the editor area rather than the shell.

            Below every pane and beside the rail, which is the only arrangement
            where the panes keep their full height. It belongs to no
            conversation, so it is mounted here and not inside a `Session` —
            nothing about a conversation ending should reach it.
          */}
        {globalTerminal.open && (
          <TerminalPanel
            panel={globalTerminal}
            refFor={globalTerminalRef}
            title={t('terminal.globalTitle')}
            onHeightChange={(height) => {
              setGlobalTerminalHeight(height)
              props.onCommitLayout()
            }}
            onClose={() => {
              setGlobalTerminalOpen(false)
            }}
            onAddTerminal={addGlobalTerminal}
            onActivateTerminal={activateGlobalTerminal}
            onRemoveTerminal={removeGlobalTerminalTab}
            onFocusAway={() => undefined}
            variant="global"
            shortcut={shortcutLabel({ primary: true, shift: true, key: 'j' })}
          />
        )}
      </main>
      <DragFeedback drag={drag.drag} />
      {/*
          One preview for the app, beside the shell rather than inside the rail,
          and rendered last so it is not inside anything that clips.
        */}
      <ProjectPreviewHost
        controller={preview}
        projects={props.projects}
        sessions={props.sessions}
        profiles={props.profiles}
        home={props.home}
        installed={props.installed}
        onRename={props.onRenameProject}
        onShowConversation={showConversation}
        onToggleAgent={props.onToggleProjectAgent}
        onChooseProfile={props.onChooseProjectProfile}
      />
    </div>
  )
}

function EmptyWorkspace(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="workspace-empty">
      <span>{t('workspace.empty')}</span>
      <small>{t('workspace.emptyHint')}</small>
    </div>
  )
}

interface LayoutViewProps {
  readonly node: WorkspaceLayoutNode
  readonly path: readonly number[]
  readonly sessions: ReadonlyMap<string, SessionInfo>
  readonly focusedPaneId: string | null
  readonly drag: ActiveTabDrag | null
  readonly onTabPointerDown: (
    conversationId: string,
    title: string,
    paneId: string | null,
    event: ReactPointerEvent<HTMLElement>
  ) => void
  readonly consumeSuppressedClick: () => boolean
  /** Starts a conversation in one named project — the `+` inside a pane. */
  readonly onStartInProject: (projectId: string) => void
  /** Ends one conversation — the × on its tab. Opens `App`'s confirmation. */
  readonly onEndConversation: (conversationId: string) => void
  readonly onActivate: (paneId: string, conversationId: string) => void
  readonly onFocus: (paneId: string) => void
  readonly onClose: (paneId: string, conversationId: string) => void
  readonly onReorder: (paneId: string, fromIndex: number, slotBefore: number) => void
  readonly onRename: (conversationId: string, title: string) => void
  readonly onCommitLayout: () => void
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}

function LayoutView(props: LayoutViewProps): React.JSX.Element {
  if (props.node.kind === 'leaf') return <EditorPane {...props} paneId={props.node.paneId} />
  const branch = props.node
  return (
    <div className="split-branch" data-orientation={branch.orientation}>
      {branch.children.map((child, index) => (
        <div
          key={child.kind === 'leaf' ? child.paneId : `branch-${[...props.path, index].join('-')}`}
          className="split-child"
          style={{ flexGrow: branch.sizes[index] }}
        >
          <LayoutView {...props} node={child} path={[...props.path, index]} />
          {index < branch.children.length - 1 && (
            <Sash
              orientation={branch.orientation}
              path={props.path}
              index={index}
              sizes={branch.sizes}
              onCommitLayout={props.onCommitLayout}
            />
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The divider between two panes of one branch.
 *
 * Sizes go to the store as the pointer moves — a split is a handful of panes,
 * not a transcript per frame — and the layout is persisted only on release.
 * 240px is the floor a pane may not be dragged below, expressed as a fraction of
 * the branch so it holds at any window width.
 */
function Sash(props: {
  readonly orientation: 'row' | 'column'
  readonly path: readonly number[]
  readonly index: number
  readonly sizes: readonly number[]
  readonly onCommitLayout: () => void
}): React.JSX.Element {
  const { setBranchSizes: setSizes, equalizeBranch: equalize } = useWorkspaceActions()

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const element = event.currentTarget
    const branch = element.closest('.split-branch')
    if (branch === null) return
    const rect = branch.getBoundingClientRect()
    const axis = props.orientation === 'row' ? rect.width : rect.height
    if (axis <= 0) return
    const start = props.orientation === 'row' ? event.clientX : event.clientY
    const before = props.sizes[props.index]
    const after = props.sizes[props.index + 1]
    if (before === undefined || after === undefined) return
    const pair = before + after
    const minimum = Math.min(240 / axis, pair / 2)
    const pointerId = event.pointerId
    try {
      element.setPointerCapture(pointerId)
    } catch {
      /* Capture is an optimisation; losing it costs a less smooth drag. */
    }
    document.body.style.userSelect = 'none'

    const onMove = (move: globalThis.PointerEvent): void => {
      if (move.pointerId !== pointerId) return
      const at = props.orientation === 'row' ? move.clientX : move.clientY
      const nextBefore = Math.max(minimum, Math.min(pair - minimum, before + (at - start) / axis))
      const sizes = [...props.sizes]
      sizes[props.index] = nextBefore
      sizes[props.index + 1] = pair - nextBefore
      setSizes(props.path, sizes)
    }
    const stop = (end: globalThis.PointerEvent): void => {
      if (end.pointerId !== pointerId) return
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      document.body.style.removeProperty('user-select')
      try {
        element.releasePointerCapture(pointerId)
      } catch {
        /* Already released — the pointer left the window mid-drag. */
      }
      props.onCommitLayout()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  }

  const keyboardResize = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta =
      props.orientation === 'row'
        ? event.key === 'ArrowLeft'
          ? -0.02
          : event.key === 'ArrowRight'
            ? 0.02
            : 0
        : event.key === 'ArrowUp'
          ? -0.02
          : event.key === 'ArrowDown'
            ? 0.02
            : 0
    if (delta === 0) return
    event.preventDefault()
    const before = props.sizes[props.index]
    const after = props.sizes[props.index + 1]
    if (before === undefined || after === undefined) return
    const pair = before + after
    const nextBefore = Math.max(0.08, Math.min(pair - 0.08, before + delta))
    const sizes = [...props.sizes]
    sizes[props.index] = nextBefore
    sizes[props.index + 1] = pair - nextBefore
    setSizes(props.path, sizes)
  }

  return (
    <div
      className="workspace-sash"
      data-orientation={props.orientation}
      role="separator"
      tabIndex={0}
      aria-orientation={props.orientation === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={startResize}
      onKeyDown={keyboardResize}
      onKeyUp={props.onCommitLayout}
      onDoubleClick={() => {
        equalize(props.path)
        props.onCommitLayout()
      }}
    />
  )
}

function EditorPane(props: LayoutViewProps & { readonly paneId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const pane = usePane(props.paneId)
  /*
   * Held per pane, not globally: one project failing to open a surface says
   * nothing about the other three, and a shared message would blame whichever
   * pane the reader happened to be looking at.
   */
  const [workbenchError, setWorkbenchError] = useState<string | null>(null)
  /*
   * A tab names a project; what gets rendered is one conversation inside it.
   *
   * The pointer is stored per project and the fallback is the newest — in that
   * order, and the order is the point. A stored pointer alone would blank the
   * pane when the conversation it names ends; a derived newest alone cannot
   * express "show me the older one", which is the whole reason the dock exists.
   * Together, the pointer decides and the list heals it.
   */
  const projectId = pane?.activeTabId ?? null
  const chorusWidth = useChorusWidth(projectId)
  const workbenchShown = useWorkbenchShown(projectId)
  const arrangement = useConversationGroups(projectId)
  const { splitConversation, placeConversation, setConversationSizes, focusConversationGroup } =
    useWorkspaceActions()
  const commitLayout = props.onCommitLayout
  /*
   * One drag per pane, not one per app. A conversation cannot leave its project
   * and a project's column lives in exactly one pane, so there is nothing for a
   * shared instance to coordinate — and per-pane state means dragging in one
   * pane re-renders only that pane.
   */
  const conversationDrag = useConversationDrag({
    groupCount: arrangement === undefined ? 0 : Object.keys(arrangement.panes).length,
    onPlace: (conversationId, targetGroupId, slot) => {
      if (projectId === null) return
      placeConversation(projectId, conversationId, targetGroupId, slot)
      commitLayout()
    },
    onSplit: (conversationId, targetGroupId, direction) => {
      if (projectId === null) return
      splitConversation(projectId, conversationId, targetGroupId, direction)
      commitLayout()
    },
  })

  /*
   * Every hook above the early return, which it was not.
   *
   * `useActiveConversationFor` sat *below* `if (pane === undefined)`, so the
   * number of hooks this component ran depended on whether the pane still
   * existed — and a pane is normalised away while a caller is still holding its
   * id, which is exactly the case the guard is there for. React would have
   * renumbered the remaining hooks on that render. Reading `pane?.activeTabId`
   * costs nothing and makes the order unconditional.
   */
  if (pane === undefined) return <div />

  const conversations =
    projectId === null
      ? []
      : [...props.sessions.values()].filter((session) => session.projectId === projectId)
  const focused = props.focusedPaneId === props.paneId
  return (
    <section
      className="workspace-pane"
      data-workspace-pane={props.paneId}
      data-focused={focused}
      onPointerDown={() => {
        props.onFocus(props.paneId)
      }}
    >
      <PaneTabStrip {...props} pane={pane} />
      <div
        className="workspace-pane-content"
        data-pane-content
        /*
         * Keyed by the project, matching the tab's `aria-controls`. It used to
         * be the conversation id on both sides; only the tab moved to the
         * project, which left the two naming different things and the
         * tab/panel relationship broken for assistive technology.
         */
        id={projectId === null ? undefined : `panel-${props.paneId}-${projectId}`}
        role="tabpanel"
        aria-labelledby={projectId === null ? undefined : `tab-${props.paneId}-${projectId}`}
      >
        {/*
          Two regions: the workbench, and Chorus beside it.

          Plan §2.4 sets the shape — each visible project gets its own surface in
          its own `WebContentsView`, up to the four-pane cap. So this mounts per
          pane rather than once for the focused one: four panes showing four
          projects are four surfaces, which is the configuration the containment
          gate proved for two and the memory gate is owed for four.

          It is also, knowingly, the configuration C-054 has only ever been seen
          in. That defect is undiagnosed and this decision walks into it rather
          than around it.
        */}
        {/*
          Rendered even when the editor is switched off, and that is the point.

          Unmounting `WorkbenchFrame` runs its cleanup, which closes the surface
          — a whole `WebContents` destroyed, and switching back would reload the
          workbench and lose every open file. So the frame stays mounted with
          `hidden`, which stops it reporting bounds and asks main to make its one
          view invisible. The view keeps its rectangle, nothing inside it
          reflows, and coming back is a compositing change rather than a launch.

          The region and the sash are what actually leave the layout, so Chorus
          takes the pane.
        */}
        {projectId !== null && (
          <div className="workspace-pane-workbench" hidden={!workbenchShown}>
            <WorkbenchFrame
              key={projectId}
              target={{ projectId }}
              /* Displayed only, and any of the project's conversations answers
                 it — they all share one root, which is what a project is. */
              projectRoot={conversations[0]?.cwd ?? ''}
              hidden={!workbenchShown}
              onFailed={setWorkbenchError}
            />
            {workbenchError !== null && (
              <p className="workspace-pane-workbench-error">{workbenchError}</p>
            )}
          </div>
        )}
        {projectId !== null && workbenchShown && (
          <ChorusSash projectId={projectId} onCommit={props.onCommitLayout} />
        )}
        <div
          className="workspace-pane-chorus"
          /* Full width with the editor off: the sash is gone, so there is nothing
             left for the remembered width to divide. */
          style={workbenchShown ? { width: `${String(chorusWidth)}px` } : undefined}
          data-full={!workbenchShown}
        >
          {/*
            The project's conversation tree, which is usually one group.
            
            Rendered the way the workspace renders its panes, one level in —
            same node type, same split and move functions, same drop zones. The
            arrangement is absent for a project with no conversations, and then
            there is nothing to draw.
          */}
          {/*
            A project whose conversations have all ended.
            
            The column rendered nothing at all here, which reads as a pane that
            failed rather than one with nothing in it — and there was no way
            back, because the only `+` was in the rail and meant "the most recent
            project", not this one.
          */}
          {projectId !== null && arrangement?.layout == null && (
            <div className="conversation-empty">
              <p>{t('project.noConversations')}</p>
              <button
                type="button"
                onClick={() => {
                  props.onStartInProject(projectId)
                }}
              >
                {t('conversation.newInGroup')}
              </button>
            </div>
          )}
          {projectId !== null && arrangement?.layout != null && (
            <ConversationTree
              node={arrangement.layout}
              path={[]}
              projectId={projectId}
              arrangement={arrangement}
              sessions={conversations}
              paneId={props.paneId}
              paneFocused={focused}
              drag={conversationDrag}
              onSizes={(path, sizes) => {
                setConversationSizes(projectId, path, sizes)
                props.onCommitLayout()
              }}
              /*
               * Focus first, start second. A new conversation joins the focused
               * group — that is the one rule `adoptConversation` follows — so
               * pressing `+` in a group is expressed as making that group the
               * focused one and then starting. No second placement path.
               */
              onNewConversation={(groupId) => {
                focusConversationGroup(projectId, groupId)
                props.onStartInProject(projectId)
              }}
              onEndConversation={props.onEndConversation}
              renderSession={props.renderSession}
            />
          )}
          {/*
            The ghost, portalled to the body so no column's overflow clips it.

            Without something following the pointer a drag reads as a tab that
            has stopped responding — the source dims and a target tints, but
            neither is under your hand. `pointer-events: none` in the stylesheet
            is load-bearing rather than cosmetic: the drop target is resolved
            with `elementFromPoint`, and a ghost that could be hit would be the
            element found on every single move.
          */}
          {conversationDrag.drag !== null &&
            createPortal(
              <div
                className="conversation-drag-ghost"
                style={{ left: conversationDrag.drag.x, top: conversationDrag.drag.y }}
              >
                {conversationDrag.drag.title}
              </div>,
              document.body
            )}
        </div>
      </div>
    </section>
  )
}

/**
 * The divider between the workbench and Chorus.
 *
 * **Measured from the right edge of the pane**, not from a start offset plus a
 * delta. The workbench on the other side is a `WebContentsView` composited by
 * the window, and it resizes by main mirroring a rectangle this renderer
 * reports — so a drag is two processes agreeing frame by frame. Deriving the
 * width from the pointer's absolute position means a frame that arrives late
 * lands in the right place anyway, where an accumulated delta would drift.
 *
 * Pointer capture rather than window listeners, so a fast drag that leaves the
 * element keeps resizing; and the width is committed on release for the same
 * reason the sidebar's is — the snapshot is rewritten whole, and writing it per
 * frame would be a file write per pixel.
 */
function ChorusSash({
  projectId,
  onCommit,
}: {
  /** Whose divider this is. One number for the whole app moved every pane at once. */
  readonly projectId: string
  readonly onCommit: () => void
}): React.JSX.Element {
  const { setChorusWidth } = useWorkspaceActions()

  const resize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    /*
     * The element is captured in a local, not read from the event later.
     *
     * React nulls `currentTarget` the moment the handler returns, so a closure
     * that reaches for it during `pointermove` — or worse, during cleanup —
     * finds `null`. The listeners attached fine and were then never removed,
     * which is a leak per drag.
     */
    const sash = event.currentTarget
    const pane = sash.closest('[data-pane-content]')
    const chorus = pane?.querySelector('.workspace-pane-chorus')
    // `closest` returns `Element | null` and never `undefined`, so only `chorus`
    // — which is `undefined` when the optional chain above short-circuits —
    // needs both arms.
    if (pane === null || chorus === null || chorus === undefined) return

    const right = pane.getBoundingClientRect().right
    const startWidth = chorus.getBoundingClientRect().width
    /*
     * **Where in the sash you grabbed, preserved.** Without this the divider
     * jumps to sit exactly under the pointer on mousedown — a few pixels, but
     * it is the whole difference between dragging a handle and the handle
     * teleporting. The offset is then held for the life of the drag, so the
     * width still comes from the pointer's absolute position and cannot drift
     * the way an accumulated delta would.
     */
    const grab = right - event.clientX - startWidth

    sash.setPointerCapture(event.pointerId)

    const move = (moved: PointerEvent): void => {
      setChorusWidth(projectId, right - moved.clientX - grab)
    }
    const stop = (): void => {
      sash.removeEventListener('pointermove', move)
      sash.removeEventListener('pointerup', stop)
      sash.removeEventListener('pointercancel', stop)
      sash.releasePointerCapture(event.pointerId)
      onCommit()
    }
    sash.addEventListener('pointermove', move)
    sash.addEventListener('pointerup', stop)
    // A capture lost to a system gesture fires this and never `pointerup`.
    sash.addEventListener('pointercancel', stop)
  }

  return (
    <div
      className="chorus-sash"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={resize}
      onKeyDown={(event) => {
        // Same keys the pane sashes use, so one gesture works everywhere.
        const step = event.shiftKey ? 40 : 8
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const pane = event.currentTarget.closest('[data-pane-content]')
        const chorus = pane?.querySelector('.workspace-pane-chorus')
        if (chorus === null || chorus === undefined) return
        const current = chorus.getBoundingClientRect().width
        setChorusWidth(projectId, event.key === 'ArrowLeft' ? current + step : current - step)
      }}
      onKeyUp={onCommit}
    />
  )
}

function PaneTabStrip(
  props: LayoutViewProps & {
    readonly paneId: string
    readonly pane: { tabs: string[]; activeTabId: string | null }
  }
): React.JSX.Element {
  const { t } = useTranslation()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  /* A strip that scrolls can hold the active tab off screen. */
  useEffect(() => {
    const index = props.pane.tabs.indexOf(props.pane.activeTabId ?? '')
    if (index < 0) return
    tabRefs.current[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.pane.activeTabId, props.pane.tabs])

  const focusAt = (index: number): void => {
    const count = props.pane.tabs.length
    if (count === 0) return
    tabRefs.current[(index + count) % count]?.focus()
  }
  const onTabKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      focusAt(index + (event.key === 'ArrowLeft' ? -1 : 1))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusAt(event.key === 'Home' ? 0 : props.pane.tabs.length - 1)
    }
  }

  return (
    <div className="workspace-tab-strip" data-tab-strip role="tablist">
      <div className="workspace-tabs">
        {/*
          A tab is a **project**, and this strip was still resolving it as a
          conversation — `sessions.get(tabId)` against a map keyed by
          conversation id.

          The `flatMap` is why it looked plausible for three slices instead of
          throwing: an id it could not resolve was dropped, so a pane keyed by
          project rendered whichever conversations happened to share those ids
          and silently omitted the rest. `EditorPane` and `reconcileWorkspace`
          were re-keyed in Phase 3 and this was missed.
        */}
        {props.pane.tabs.flatMap((projectId, index) => {
          /*
           * The project's newest conversation names the tab, matching what
           * `EditorPane` chooses to render inside it. A project with no open
           * conversation has nothing to title a tab with and is dropped, which
           * is the one case the old `flatMap` handled correctly by accident.
           */
          const session = [...props.sessions.values()]
            .filter((candidate) => candidate.projectId === projectId)
            .at(-1)
          if (session === undefined) return []
          const conversationId = session.conversationId
          const active = props.pane.activeTabId === projectId
          return [
            <div
              key={projectId}
              className="workspace-tab"
              data-active={active}
              data-dragging={props.drag?.conversationId === conversationId}
            >
              {active && <TabJoin />}
              {/*
                No rename here any more; it lives on the hover card's title.

                A tab is 160px of truncated name in a strip whose single click
                switches panes — so renaming was a double-click on the one
                control whose click already means something else, editing a title
                in a box too narrow to show it. The card shows the whole name and
                is already where you go to ask about a session.
              */}
              <button
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                type="button"
                className="workspace-tab-main"
                data-workspace-tab={projectId}
                id={`tab-${props.paneId}-${projectId}`}
                role="tab"
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                aria-controls={`panel-${props.paneId}-${projectId}`}
                title={session.title}
                onPointerDown={(event) => {
                  /*
                   * The **project**, matching `data-workspace-tab` two lines up
                   * and `onClick` below — and the last place in this file that
                   * was still handing a conversation id to something keyed by
                   * projects.
                   *
                   * Dragging a tab carried the conversation, so `splitWithSession`
                   * looked it up in `pane.tabs` (project ids), found nothing, and
                   * took its *insert* branch: a new pane whose only tab was a
                   * conversation id. `WorkbenchFrame` then opened that as a
                   * project and main answered `UnknownProjectError`, which is the
                   * one place the mistake finally became visible. Everything
                   * before it — the drag, the drop, the split, the new pane — was
                   * a silent success.
                   */
                  props.onTabPointerDown(projectId, session.title, props.paneId, event)
                }}
                onClick={() => {
                  if (props.consumeSuppressedClick()) return
                  /*
                   * The project, not the conversation. `activateTab` matches
                   * against `pane.tabs`, which holds project ids — so a
                   * conversation id matched nothing and clicking a tab did
                   * nothing at all, silently, because activating an absent tab
                   * is a no-op rather than an error.
                   */
                  props.onActivate(props.paneId, projectId)
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) props.onClose(props.paneId, projectId)
                }}
                onKeyDown={(event) => {
                  onTabKeyDown(index, event)
                }}
              >
                <svg className="workspace-tab-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 12a8 8 0 0 1-8 8H5l-1.5 2v-4.5A8 8 0 1 1 20 12Z" />
                </svg>
                <span className="workspace-tab-title">{session.title}</span>
                {/*
                  What the session is *doing*, where its cast used to be.

                  The dots said which agents were in the room, which does not
                  change and so is never news. What a tab has to say is the thing
                  that changed while you were looking at another one: an approval
                  holding a tool, a question waiting, an agent working, an agent
                  that stopped.

                  The same `StateMark` the sidebar card draws, from the same
                  `useSessionRowState`. Deliberately not a second derivation:
                  a tab and its card disagreeing about whether a session is
                  blocked is worse than either being wrong alone.
                */}
                <TabState conversationId={conversationId} />
              </button>
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={t('workspace.closeTab', { title: session.title })}
                title={t('workspace.closeTab', { title: session.title })}
                onClick={(event) => {
                  event.stopPropagation()
                  // The tab is the project, so this closes the project's tab —
                  // the conversations inside it keep running in main.
                  props.onClose(props.paneId, projectId)
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>,
          ]
        })}
      </div>
    </div>
  )
}

/*
 * A split target paints the pane it will make, at the size it will be.
 *
 * This drew a 52px strip along the edge until 2026-08-14 — `SPLIT_STRIP_PX` and
 * a `stripFor` helper, both gone — on the argument that a translucent slab over
 * half a transcript reads as "this half is selected" rather than as "a pane will
 * open here". Reversed on request, and the request is the better reading: what a
 * person wants from a drop target is *where the thing lands*, and a strip makes
 * them infer that from a seam. Half a pane is not a selection when it is wearing
 * a "Split right" chip.
 *
 * Nothing about the geometry moved. `target.rect` was always the real
 * destination and the hit area was always the full half — only the paint was a
 * strip. So a two-way split now shows a half and a split of an already-split
 * pane shows a quarter, with no arithmetic here: whatever the resolver says the
 * drop makes is what gets drawn.
 *
 * The dashed edge survives and matters more now. It marks the seam the split
 * opens along, which is the one thing a filled rectangle cannot say by itself.
 */

function DragFeedback({ drag }: { drag: ActiveTabDrag | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (drag === null) return null
  const target = drag.target
  const overlay =
    /* Both insert kinds draw a line rather than a wash, so neither takes the
       overlay branch. */
    target !== null && target.kind !== 'insert' && target.kind !== 'rail-insert' ? (
      <div
        className="workspace-drop-overlay"
        data-disabled={target.disabled}
        data-kind={target.kind}
        data-direction={target.kind === 'split' ? target.direction : undefined}
        style={{
          left: target.rect.left,
          top: target.rect.top,
          width: target.rect.width,
          height: target.rect.height,
        }}
      >
        <span>
          {target.kind === 'move'
            ? t('workspace.moveHere')
            : t(`workspace.dropSplit.${target.direction}`)}
        </span>
      </div>
    ) : null
  const insertion =
    target?.kind === 'insert' ? (
      <div
        className="workspace-drop-line"
        style={{ left: target.line.left, top: target.line.top, height: target.line.height }}
      />
    ) : target?.kind === 'rail-insert' ? (
      /* The same line turned on its side: a rail is a column, so the gap it
         marks is horizontal. */
      <div
        className="workspace-drop-line workspace-drop-line--across"
        style={{ left: target.line.left, top: target.line.top, width: target.line.width }}
      />
    ) : null

  /*
   * A rail drag carries a tile; a tab drag carries a name. The ghost is kept
   * inside the window by its own width, which differs between the two.
   */
  const fromRail = drag.fromRail
  const ghostStyle: CSSProperties = {
    left: Math.min(drag.x + 12, window.innerWidth - (fromRail ? 58 : 254)),
    top: Math.min(drag.y + 12, window.innerHeight - 58),
  }
  return (
    <>
      {overlay}
      {insertion}
      <div
        className="workspace-drag-ghost"
        data-shape={fromRail ? 'tile' : 'label'}
        style={ghostStyle}
      >
        {fromRail ? monogramOf(drag.title) : drag.title}
      </div>
    </>
  )
}

/**
 * The curve that joins the active tab to the pane below it.
 *
 * Browsers and editors all solve this the same way, and it is worth naming: the
 * tab and the panel are one surface, and where the tab's rounded top meets the
 * panel's flat edge there is a *concave* quarter-round turning outward on each
 * side. Without it a tab is a rounded rectangle sitting on a line — which is
 * what Chorus drew, and why the join read as two shapes touching rather than one
 * shape with a tab on it.
 *
 * Three layers, and each is load-bearing:
 *
 *  - **the bridge**, a 1px bar running from one curve's outer edge to the
 *    other's, painting over the pane body's top border for the tab's whole
 *    width plus both curves. Chorus already erased that border under the tab
 *    itself with `border-bottom-color`; the curves widen the erasure and this is
 *    what keeps it continuous across them.
 *  - **two curves**, each an SVG rather than a CSS pseudo-element, because the
 *    corner needs a *fill* — the pane's surface, flooding into the notch — and a
 *    *stroke* on the same arc, in the tab's border colour. A `border-radius`
 *    trick gives one or the other, not both, which is why every implementation
 *    of this reaches for SVG.
 *
 * Authored at 11px with a radius of 8, rather than scaling artwork drawn for a
 * chunkier tab: Chorus's corner is 9px with a 1px border, so a copy scaled down
 * from a 14px corner with a 2px border would have arrived carrying a 1.4px
 * stroke that renders soft. The control points are the usual quarter-arc
 * constant — 8 × 0.5523 — so the arc meets both straight edges tangentially.
 *
 * **11px and half-pixel coordinates, because 10px left visible breaks.** A 1px
 * stroke is centred on its path, so a path along the box's own edge renders half
 * outside it. The box is one pixel wider than the curve to hold that half, the
 * arc sits on `x = 10.5` — the centre of the tab's 1px border, not its inside
 * face — and the path carries a straight segment at each end that runs *into*
 * the lines it joins rather than stopping at them. Butting two strokes end to
 * end leaves a hairline at any fractional device-pixel offset; overlapping them
 * cannot.
 *
 * `currentColor` on the stroke and `--bg-pane-active` on the fill, so the curve
 * follows the tab it belongs to rather than restating either value.
 */
function TabJoin(): React.JSX.Element {
  return (
    <>
      <span className="workspace-tab-bridge" aria-hidden="true" />
      <svg
        className="workspace-tab-curve workspace-tab-curve--left"
        viewBox="0 0 11 11"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M11 0H10.5V2.5C10.5 6.92 6.92 10.5 2.5 10.5H0V11H11Z" fill="var(--tab-join)" />
        <path
          className="workspace-tab-curve-line"
          d="M10.5 0V2.5C10.5 6.92 6.92 10.5 2.5 10.5H0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
      <svg
        className="workspace-tab-curve workspace-tab-curve--right"
        viewBox="0 0 11 11"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M0 0H0.5V2.5C0.5 6.92 4.08 10.5 8.5 10.5H11V11H0Z" fill="var(--tab-join)" />
        <path
          className="workspace-tab-curve-line"
          d="M0.5 0V2.5C0.5 6.92 4.08 10.5 8.5 10.5H11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    </>
  )
}
