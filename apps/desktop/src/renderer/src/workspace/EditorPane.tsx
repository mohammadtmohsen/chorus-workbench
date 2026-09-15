import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceLayoutNode } from '../../../shared/workspace-layout.js'
import type { SessionInfo } from '../Session.js'
import { ConversationTree } from './ConversationTree.js'
import { ProjectNotes } from './ProjectNotes.js'
import type { NoteSize } from '../noteSize.js'
import { useConversationDrag } from './useConversationDrag.js'
import type { ProjectInfo } from './session-row.js'
import type { ActiveTabDrag } from './useTabDrag.js'
import {
  useConversationGroups,
  useChorusWidth,
  usePane,
  useWorkbenchShown,
  useWorkspaceActions,
} from './hooks.js'
import { PaneWorkbench } from './PaneWorkbench.js'
import { ChorusSash } from './ChorusSash.js'
import { PaneTabStrip } from './PaneTabStrip.js'

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
}

export function EditorPane(props: LayoutViewProps & { readonly paneId: string }): React.JSX.Element {
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
  const chorusWidth = useChorusWidth(projectId)
  const workbenchShown = useWorkbenchShown(projectId)
  const arrangement = useConversationGroups(projectId)
  const focusedConversationGroupId = arrangement?.focusedPaneId ?? null
  const activeConversationId =
    focusedConversationGroupId === null
      ? null
      : (arrangement?.panes[focusedConversationGroupId]?.activeTabId ?? null)
  const {
    splitConversation,
    placeConversation,
    setConversationSizes,
    equalizeConversationBranch,
    focusConversationGroup,
  } = useWorkspaceActions()
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
          /*
            One slot per project open in this pane, keyed by project so a tab
            switch moves which one is visible rather than destroying one surface
            and building another. The region itself still leaves the layout when
            the *active* project's Editor switch is off, which is what the
            `hidden` here is for.
          */
          <div className="workspace-pane-workbench" hidden={!workbenchShown}>
            {/* `pane` is non-null here: `projectId` is read off it, and the
                guard above is what narrows both. */}
            {pane.tabs.map((id) => (
              <PaneWorkbench
                key={id}
                projectId={id}
                active={id === projectId}
                projectRoot={
                  [...props.sessions.values()].find((session) => session.projectId === id)?.cwd ??
                  ''
                }
              />
            ))}
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
            The project's scratchpad, above its conversations.

            **Keyed by project, and the key is load-bearing.** The pad seeds its
            draft from props once, so without it switching tabs would leave the
            previous project's note in the box — the worst failure available to
            something you type into, because the next keystroke files it against
            the wrong project.

            First child of the Chorus column rather than anywhere nicer: the
            editor beside it is a native view composited over the window, so a
            pad that floated across that edge would vanish at it rather than
            overlap. Everything Chorus draws stays on Chorus's side.
          */}
          {projectId !== null && (
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
          )}
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
              /* Wired exactly as `onSizes` is, commit included: an arrangement
                 that evened out and came back uneven on relaunch would be the
                 same gesture failing silently. */
              onEqualize={(path) => {
                equalizeConversationBranch(projectId, path)
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
              onRename={props.onRename}
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
