import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { BOX_WIDTH, type WorkspaceLayoutNode } from '../../../shared/workspace-layout.js'
import type { SessionInfo } from '../Session.js'
import { ProjectTerminalPane } from '../ProjectTerminalPane.js'
import { TrafficPanel, type TrafficTerminalOption } from '../TrafficPanel.js'
import type { WorkbenchGeometry } from '../workbench/WorkbenchFrame.js'
import { ConversationTree } from './ConversationTree.js'
import { ProjectNotes } from './ProjectNotes.js'
import type { NoteSize } from '../noteSize.js'
import { useConversationDrag } from './useConversationDrag.js'
import type { ProjectInfo } from './session-row.js'
import type { ActiveTabDrag } from './useTabDrag.js'
import {
  clampActivityBar,
  columnWidths,
  columnsOf,
  editorViewport,
  editorWidthIn,
  leafPaneIds,
  projectTerminalMinimum,
  projectTerminalWidth,
  ROW_EDGE_INSET,
} from './layout.js'
import {
  useConversationGroups,
  usePane,
  useProjectRun,
  useProjectTerminalPane,
  useRowScroll,
  useTrafficLive,
  useTrafficPanel,
  useWorkspaceActions,
} from './hooks.js'
import { PaneWorkbench } from './PaneWorkbench.js'
import { PaneTabStrip } from './PaneTabStrip.js'
import { routeRowWheel, startRowPush, stepRow, type RowWidths } from './row-drag.js'
import { useWorkspaceStore } from './store.js'

export interface LayoutViewProps {
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
  /**
   * Every project, because a tab is a project and now says so.
   *
   * The strip had only the session map, so it named a tab with its project's
   * newest conversation — the one string it could reach. That read correctly
   * while a conversation defaulted to its folder's name and became wrong the
   * moment either could be renamed.
   */
  readonly projects: readonly ProjectInfo[]
  /** Names the project. The folder it points at is never touched. */
  readonly onRenameProject: (projectId: string, name: string) => void
  /** Writes the project's scratchpad. Debounced by the pad, not here. */
  readonly onSetProjectNotes: (projectId: string, notes: string) => void
  readonly onSetProjectNoteSize: (projectId: string, size: NoteSize) => void
  readonly onSendProjectNoteSelection: (conversationId: string, text: string) => void
  readonly onCommitLayout: () => void
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
  readonly trafficTerminals: readonly TrafficTerminalOption[]
}

export function EditorPane(
  props: LayoutViewProps & { readonly paneId: string }
): React.JSX.Element {
  const { t } = useTranslation()
  const pane = usePane(props.paneId)
  /*
   * The workbench failure message moved down into `PaneWorkbench`, which holds
   * one per project. It was held here, per pane, on the reasoning that "one
   * project failing to open a surface says nothing about the other three" — and
   * that argument was right about panes and wrong about tabs, because a pane now
   * has a surface per open project and a single slot could only ever name one of
   * them.
   */
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
  /* The row the pad is drawn from — its text and the box it is read in, which
     travel together precisely so they cannot be one refresh apart. */
  const note = props.projects.find((project) => project.id === projectId)
  const content = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const trafficBox = useRef<HTMLElement>(null)
  const [runHost, setRunHost] = useState<HTMLDivElement | null>(null)
  const activityBar = useRef<HTMLDivElement>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const [activityBars, setActivityBars] = useState<Readonly<Record<string, number>>>({})
  const hasPane = pane !== undefined
  useLayoutEffect(() => {
    const element = content.current
    if (element === null) return undefined
    const measureWidth = (): void => {
      setPaneWidth(element.clientWidth)
      setWindowWidth(window.innerWidth)
    }
    measureWidth()
    const observer = new ResizeObserver(measureWidth)
    observer.observe(element)
    window.addEventListener('resize', measureWidth)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measureWidth)
    }
  }, [hasPane])
  useEffect(() => {
    const row = scroller.current
    return row === null ? undefined : routeRowWheel(row)
  }, [hasPane])
  useEffect(() => {
    const row = scroller.current
    if (row === null || projectId === null) return
    const left = useWorkspaceStore.getState().rowScroll[projectId]
    if (left !== undefined) row.scrollLeft = left
  }, [projectId, hasPane])
  const editorWidth = editorWidthIn(windowWidth)
  const barWidth =
    projectId === null ? 0 : clampActivityBar(activityBars[projectId] ?? 0, editorWidth, paneWidth)
  const gutterWidth = ROW_EDGE_INSET + barWidth
  const bodyWidth = Math.max(0, editorWidth - gutterWidth)
  const geometry = useCallback((host: HTMLElement): WorkbenchGeometry | null => {
    const bar = activityBar.current
    const row = scroller.current
    if (bar === null || row === null) return null
    return editorViewport(
      bar.getBoundingClientRect(),
      host.getBoundingClientRect(),
      row.getBoundingClientRect()
    )
  }, [])
  const recordActivityBar = useCallback((id: string, width: number) => {
    setActivityBars((current) => (current[id] === width ? current : { ...current, [id]: width }))
  }, [])
  const revealRow = (id: string): void => {
    if (id !== projectId) return
    const row = scroller.current
    if (row !== null) row.scrollLeft = 0
  }
  const scrollRow = (id: string, delta: number): void => {
    if (id !== projectId) return
    const row = scroller.current
    if (row !== null) row.scrollLeft += delta
  }
  const revealInRow = (box: Element | null): void => {
    const row = scroller.current
    if (row === null || box === null) return
    const shown = row.getBoundingClientRect()
    const placed = box.getBoundingClientRect()
    if (placed.left >= shown.left && placed.right <= shown.right) return
    row.scrollLeft += placed.left - shown.left
  }
  const revealTraffic = (): void => {
    revealInRow(trafficBox.current)
  }
  const arrangement = useConversationGroups(projectId)
  const traffic = useTrafficPanel(projectId)
  const trafficLive = useTrafficLive(projectId)
  const run = useProjectRun(projectId)
  const terminalPane = useProjectTerminalPane(projectId)
  const terminalMinimum = projectTerminalMinimum(terminalPane.shells.length)
  useRowScroll(scroller, projectId, run !== null, hasPane)
  const widths = arrangement === undefined ? [] : columnWidths(arrangement)
  const focusedConversationGroupId = arrangement?.focusedPaneId ?? null
  const activeConversationId =
    focusedConversationGroupId === null
      ? null
      : (arrangement?.panes[focusedConversationGroupId]?.activeTabId ?? null)
  const {
    setConversationSizes,
    equalizeConversationBranch,
    moveConversationBox,
    setConversationWidths,
    resetProjectWidths,
    setTrafficWidth,
    setProjectTerminalWidth,
    addProjectShell,
    removeProjectShell,
  } = useWorkspaceActions()
  const commitLayout = props.onCommitLayout
  /*
   * One drag per pane, not one per app. A conversation cannot leave its project
   * and a project's boxes live in exactly one pane, so there is nothing for a
   * shared instance to coordinate — and per-pane state means dragging in one
   * pane re-renders only that pane.
   */
  const conversationDrag = useConversationDrag({
    onMove: (boxId, targetGroupId, direction) => {
      if (projectId === null) return
      moveConversationBox(projectId, boxId, targetGroupId, direction)
      commitLayout()
    },
  })
  const applyRow = (id: string) => (row: RowWidths) => {
    setConversationWidths(id, row.boxes)
    if (row.traffic !== null) setTrafficWidth(id, row.traffic)
    if (row.terminal !== null) setProjectTerminalWidth(id, row.terminal)
  }
  const pushRow = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (projectId === null) return
    startRowPush(event, applyRow(projectId), commitLayout)
  }
  const nudgeRow = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (projectId === null) return
    stepRow(event, applyRow(projectId))
  }
  const commitNudge = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') commitLayout()
  }
  const resetWidths = (): void => {
    if (projectId === null) return
    resetProjectWidths(projectId)
    commitLayout()
  }
  const addShell = (id: string): string => {
    const shell = addProjectShell(id)
    commitLayout()
    return shell
  }
  const removeShell = (id: string, shellId: string): void => {
    removeProjectShell(id, shellId)
    commitLayout()
  }

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
  const rowSash = (
    <div
      className="conversation-sash"
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={pushRow}
      onKeyDown={nudgeRow}
      onKeyUp={commitNudge}
      onDoubleClick={resetWidths}
    />
  )
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
        ref={content}
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
          The project's scratchpad, above its conversations.

          **Keyed by project, and the key is load-bearing.** The pad seeds its
          draft from props once, so without it switching tabs would leave the
          previous project's note in the box — the worst failure available to
          something you type into, because the next keystroke files it against
          the wrong project.
        */}
        {projectId !== null && (
          <div className="project-header">
            <ProjectNotes
              key={projectId}
              projectId={projectId}
              /* Only the focused pane's pad answers ⌘⇧N — see the effect that
                 reads this. Four panes are four mounted pads. */
              active={focused}
              conversationId={activeConversationId}
              notes={note?.notes ?? null}
              size={{ width: note?.noteWidth ?? null, height: note?.noteHeight ?? null }}
              onSave={props.onSetProjectNotes}
              onSaveSize={props.onSetProjectNoteSize}
              onSendSelection={props.onSendProjectNoteSelection}
            />
            <div className="project-run" ref={setRunHost} />
            <button
              type="button"
              className="conversation-dock-add"
              aria-label={t('conversation.newInGroup')}
              title={t('conversation.newInGroup')}
              onClick={() => {
                props.onStartInProject(projectId)
              }}
            >
              +
            </button>
          </div>
        )}
        <div className="workspace-pane-row">
          {projectId !== null && (
            <div
              className="workspace-pane-gutter"
              style={{
                width: `${String(gutterWidth)}px`,
                paddingLeft: `${String(ROW_EDGE_INSET)}px`,
              }}
            >
              <div
                className="workspace-pane-bar"
                ref={activityBar}
                style={{ width: `${String(barWidth)}px` }}
              />
            </div>
          )}
          <div className="conversation-scroller" ref={scroller}>
            {projectId !== null && (
              /*
                One slot per project open in this pane, keyed by project so a tab
                switch moves which one is visible rather than destroying one surface
                and building another.
              */
              <div
                className="workspace-pane-workbench"
                style={{ flex: `0 0 ${String(bodyWidth)}px` }}
              >
                {/* `pane` is non-null here: `projectId` is read off it, and the
                    guard above is what narrows both. */}
                {pane.tabs.map((id) => (
                  <PaneWorkbench
                    key={id}
                    projectId={id}
                    active={id === projectId}
                    projectRoot={
                      [...props.sessions.values()].find((session) => session.projectId === id)
                        ?.cwd ?? ''
                    }
                    geometry={geometry}
                    onActivityBar={recordActivityBar}
                    onRevealRow={revealRow}
                    onScrollRow={scrollRow}
                  />
                ))}
              </div>
            )}
            {projectId !== null && (
              <div
                className="conversation-sash"
                data-fixed
                role="separator"
                aria-orientation="vertical"
                onDoubleClick={resetWidths}
              />
            )}
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
            {projectId !== null &&
              arrangement?.layout != null &&
              columnsOf(arrangement.layout).map((column, index, columns) => (
                <Fragment key={leafPaneIds(column)[0] ?? index}>
                  {index > 0 && rowSash}
                  <div
                    className="conversation-slot"
                    style={{
                      flex: `0 0 ${String(widths[index] ?? BOX_WIDTH.default)}px`,
                    }}
                  >
                    {/*
                      Rendered the way the workspace renders its panes, one level
                      in — same node type, same split and move functions, same
                      drop zones. The arrangement is absent for a project with no
                      conversations, and then there is nothing to draw.
                    */}
                    <ConversationTree
                      node={column}
                      path={columns.length > 1 ? [index] : []}
                      projectId={projectId}
                      arrangement={arrangement}
                      sessions={conversations}
                      paneId={props.paneId}
                      paneFocused={focused}
                      drag={conversationDrag}
                      onSizes={(path, sizes) => {
                        setConversationSizes(projectId, path, sizes)
                        commitLayout()
                      }}
                      /* Wired exactly as `onSizes` is, commit included: an
                         arrangement that evened out and came back uneven on
                         relaunch would be the same gesture failing silently. */
                      onEqualize={(path) => {
                        equalizeConversationBranch(projectId, path)
                        commitLayout()
                      }}
                      onEndConversation={props.onEndConversation}
                      onRename={props.onRename}
                      renderSession={props.renderSession}
                    />
                  </div>
                </Fragment>
              ))}
            {projectId !== null && (
              <>
                {rowSash}
                <section
                  className="traffic-box"
                  ref={trafficBox}
                  style={{ flex: `0 0 ${String(traffic.width)}px` }}
                >
                  <div className="conversation-dock">
                    <div className="conversation-dock-tabs">
                      <div
                        className="conversation-dock-tab"
                        data-traffic-tab="true"
                        data-active="true"
                      >
                        <span className="conversation-dock-tab-main">
                          <span className="conversation-dock-tab-title">
                            {t('traffic.tabTitle')}
                          </span>
                          {trafficLive && (
                            <span className="traffic-live">
                              <span className="traffic-live-dot" aria-hidden="true" />
                              {t('traffic.live')}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="conversation-body">
                    <TrafficPanel
                      projectId={projectId}
                      terminals={props.trafficTerminals}
                      run={run}
                      runHost={{ element: runHost, reveal: revealTraffic }}
                    />
                  </div>
                </section>
              </>
            )}
            {projectId !== null && run?.available === true && (
              <>
                {rowSash}
                <section
                  className="project-terminal-box"
                  data-min-width={terminalMinimum}
                  style={{
                    flex: `0 0 ${String(projectTerminalWidth(terminalPane))}px`,
                  }}
                >
                  <ProjectTerminalPane
                    key={projectId}
                    projectId={projectId}
                    run={run}
                    shells={terminalPane.shells}
                    onAddShell={addShell}
                    onRemoveShell={removeShell}
                    onReveal={revealInRow}
                  />
                </section>
              </>
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
      </div>
    </section>
  )
}
