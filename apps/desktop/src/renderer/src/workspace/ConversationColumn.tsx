import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../Session.js'
import { useWorkspaceActions } from './hooks.js'
import type { ConversationDrag } from './useConversationDrag.js'
import type { WorkspacePane } from '../../../shared/workspace-layout.js'

/**
 * One group of a project's conversations: a strip of tabs and the one on screen.
 *
 * This replaced `ConversationDock`, which was a single strip for the whole
 * project because a project could only show one conversation at a time. A
 * project's column can now be split, and each half is one of these — so the
 * strip belongs to the group rather than to the project, and "which conversation
 * is showing" is a property each group answers for itself.
 *
 * **The strip hides when there is nothing to switch between**, which is the rule
 * the dock had and the reason it is stated as a prop rather than derived here: a
 * group holding one conversation in an unsplit column shows no chrome at all, so
 * the common case looks exactly as it did before projects existed. The same
 * group in a *split* column keeps its strip, because with two columns on screen
 * an unlabelled one is a transcript with no name.
 *
 * It renders the transcript through `renderSession` rather than mounting
 * `Session` itself: the pane owns what a session needs — the carry, the panel
 * request, every callback `App` threads down — and duplicating that here would
 * be a second place for it to drift.
 */
export function ConversationColumn(props: {
  readonly projectId: string
  readonly group: WorkspacePane
  /** Every conversation in the project; this group shows the ones it holds. */
  readonly sessions: readonly SessionInfo[]
  readonly paneId: string
  /** The pane has the caret **and** this is the arrangement's focused group. */
  readonly focused: boolean
  /**
   * Start a conversation in this group.
   *
   * The `+` moved here from the rail, where it could only mean "in the most
   * recent project" — the rail lists projects and has no way to say which group
   * of which project. Pressed here it says both, because the group focuses
   * itself first and a new conversation joins the focused one.
   */
  readonly onNewConversation: () => void
  /** Ends one conversation — the × on its tab. Confirms first; see the markup. */
  readonly onEndConversation: (conversationId: string) => void
  /**
   * Names one conversation — a double-click on its tab.
   *
   * **The project tab strip says rename does not live on a tab, and that note is
   * about the project tab.** Its argument is a redirection: the hover card shows
   * the whole name and is already where you go to ask about a project. A
   * conversation has no such card — `SessionRow`, which had the double-click, is
   * no longer mounted anywhere — so `conversation:rename` was wired end to end
   * with nothing in the running app able to reach it. The tab is the only place a
   * conversation appears, which makes it the only place its name can be changed.
   */
  readonly onRename: (conversationId: string, title: string) => void
  /** The pane's one conversation drag, shared by every group in it. */
  readonly drag: ConversationDrag
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const { showConversationIn, focusConversationGroup } = useWorkspaceActions()

  /*
   * Which tab is being renamed, held here rather than lifted, because nothing
   * outside this strip can act on it: a rename starts and ends inside one tab,
   * and the committed name goes to main rather than to a parent. Only one at a
   * time by construction — a second double-click replaces the first, and the
   * first input's `blur` commits what was typed on the way out.
   */
  const [renaming, setRenaming] = useState<string | null>(null)

  /*
   * Resolved from the group's own tab order, not from the project's session
   * list, so the strip reads left to right as it is stored. A tab whose session
   * has gone is dropped rather than rendered blank — reconcile removes it on the
   * next hydrate, and until then a missing session is a tab that cannot be shown.
   */
  const tabs = props.group.tabs.flatMap((conversationId: string) => {
    const session = props.sessions.find((candidate) => candidate.conversationId === conversationId)
    return session === undefined ? [] : [session]
  })
  const active =
    tabs.find((session) => session.conversationId === props.group.activeTabId) ?? tabs.at(-1)

  return (
    <div
      className="conversation-column"
      data-group={props.group.id}
      data-focused={props.focused}
      /*
       * What a drop here would do, for the highlight. Read off the live drag
       * rather than from a hover handler, so the zone shown is the one the drop
       * will actually take — a second source for "where would this land" is a
       * second thing to keep in step, and the one that lies is always the
       * feedback.
       */
      data-drop={
        props.drag.drag?.target?.groupId === props.group.id
          ? props.drag.drag.target.kind
          : undefined
      }
      data-drop-direction={
        props.drag.drag?.target?.kind === 'split' &&
        props.drag.drag.target.groupId === props.group.id
          ? props.drag.drag.target.direction
          : undefined
      }
      /*
       * Focus follows the pointer *down*, not the caret. A click anywhere in a
       * column is a statement about which half you are working in, and it has to
       * land before the click reaches a control inside — otherwise starting to
       * type in the right-hand composer would still leave a new conversation
       * joining the left-hand group.
       */
      onPointerDownCapture={() => {
        if (!props.focused) focusConversationGroup(props.projectId, props.group.id)
      }}
    >
      {/*
        Always drawn, where it used to hide for a single conversation.
        
        That rule — no chrome when there is nothing to switch between — was
        right while the strip only switched. It carries the `+` now, so hiding
        it would hide the only way to start a second conversation in a project.
      */}
      <div className="conversation-dock">
        <div className="conversation-dock-tabs" role="tablist" aria-label={t('dock.conversations')}>
          {tabs.map((session) => (
            /*
             * A wrapper with two buttons, which is the project tab's shape and
             * the only one available: a `<button>` cannot contain a `<button>`,
             * so the close cannot live inside the tab it closes.
             *
             * `data-conversation-tab` stays on the wrapper, because the drag
             * measures tab rectangles to decide a drop slot and the rectangle
             * that matters includes the ×.
             */
            <div
              key={session.conversationId}
              className="conversation-dock-tab"
              data-conversation-tab={session.conversationId}
              data-dragging={
                props.drag.drag?.conversationId === session.conversationId ? 'true' : undefined
              }
              data-active={session.conversationId === active?.conversationId}
            >
              {renaming === session.conversationId ? (
                /*
                 * The input takes the whole tab, replacing the × as well as the
                 * label. A destructive control sitting beside a text field you
                 * are typing in is one press away from ending the session you
                 * meant to name, and there is nothing the × could usefully mean
                 * mid-rename anyway.
                 *
                 * Uncontrolled, like the project card's: the value is read off
                 * the element when the edit ends, so typing does not re-render
                 * the strip and an abandoned edit leaves no state behind.
                 *
                 * **Empty is not rejected here.** `renameConversation` in main
                 * treats a blank field as a request for the folder name back
                 * (runtime.ts), trims, and no-ops when the name is unchanged —
                 * so it decides, and `App`'s rename applies the title main
                 * returns rather than the one that was typed. A second guard
                 * here would be a second rule to keep in step with that one.
                 */
                <input
                  className="conversation-dock-tab-rename"
                  defaultValue={session.title}
                  /*
                   * **Not styling — this is what stops the tab resizing.**
                   *
                   * `size` defaults to 20, so an input's max-content width is
                   * about twenty characters. The tab wrapper is `flex: 0 1 auto`
                   * and takes its width from its content, so swapping a short
                   * label for that input widened the tab on every double-click.
                   * `width: 100%` does not help: a percentage resolves to `auto`
                   * while the parent's intrinsic size is being computed, which is
                   * exactly the step that was reading 20 characters.
                   *
                   * At 1 the input contributes nothing, the wrapper falls to its
                   * `min-width: 160px`, and the tab keeps the width it had.
                   */
                  size={1}
                  autoFocus
                  aria-label={t('conversation.renameTitle')}
                  placeholder={t('conversation.titlePlaceholder')}
                  onKeyDown={(event) => {
                    /* Escape abandons; the name is whatever it already was. */
                    if (event.key === 'Escape') {
                      setRenaming(null)
                      return
                    }
                    /*
                     * `isComposing` guards an IME: Enter while a candidate is
                     * open picks the candidate, and committing there would file
                     * the half-composed text as the name.
                     */
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      props.onRename(session.conversationId, event.currentTarget.value)
                      setRenaming(null)
                    }
                  }}
                  /*
                   * Blur commits rather than cancels, which is the behaviour the
                   * project card already has — clicking away from a field you
                   * typed in means keep it everywhere else in this app.
                   */
                  onBlur={(event) => {
                    props.onRename(session.conversationId, event.currentTarget.value)
                    setRenaming(null)
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    role="tab"
                    className="conversation-dock-tab-main"
                    aria-selected={session.conversationId === active?.conversationId}
                    title={session.title}
                    onPointerDown={(event) => {
                      props.drag.onPointerDown(
                        props.group.id,
                        session.conversationId,
                        session.title,
                        event
                      )
                    }}
                    onClick={() => {
                      /*
                       * A drag that moved suppresses the click the browser fires
                       * next. Without this, letting go over the tab's own strip both
                       * reorders it and switches to it — and the switch is the one
                       * you did not ask for.
                       */
                      if (props.drag.consumeSuppressedClick()) return
                      showConversationIn(props.projectId, props.group.id, session.conversationId)
                    }}
                    /*
                     * Both clicks of the double still run `onClick` first, and
                     * that is wanted rather than tolerated: renaming a tab you
                     * were not looking at switches to it on the way in, so the
                     * transcript under the name is the one being named. The
                     * second click is a no-op on an already-open conversation.
                     */
                    onDoubleClick={() => {
                      setRenaming(session.conversationId)
                    }}
                  >
                    {session.title}
                  </button>
                  {/*
                    **Ends the session, and does not merely close the tab.**

                    That is the difference from the project tab's ×, which closes a
                    view and leaves the conversations inside running in main. A
                    conversation has no equivalent — a tab is the only place it
                    appears, so a × that hid it would leave agents running in a room
                    with no door. It goes through `App`'s confirmation dialog for the
                    same reason the card's End Session does.
                  */}
                  <button
                    type="button"
                    className="conversation-dock-tab-close"
                    aria-label={t('conversation.endTitled', { title: session.title })}
                    title={t('conversation.endTitled', { title: session.title })}
                    onClick={(event) => {
                      event.stopPropagation()
                      props.onEndConversation(session.conversationId)
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        {/*
          Outside the tablist, and outside the scroller.
          
          It sat among the tabs with `margin-left: auto`, which pins it right
          only while everything fits — the strip scrolls, so with enough
          conversations the `+` was pushed past the edge and could not be reached
          without scrolling to the end. Its own flex child beside the scrolling
          list is always on screen.
          
          It is also not a tab, so `role="tablist"` was the wrong parent: a
          screen reader counted it as one of the conversations.
        */}
        <button
          type="button"
          className="conversation-dock-add"
          aria-label={t('conversation.newInGroup')}
          title={t('conversation.newInGroup')}
          onClick={props.onNewConversation}
        >
          +
        </button>
      </div>
      {/*
        No empty branch here. A group cannot stay empty — the tree collapses one
        the moment its last tab leaves — so the case worth drawing is a *project*
        with no conversations, and that has no group to draw it in. `EditorPane`
        owns it.
      */}
      {/*
        Wrapped, so the focus outline can sit on the body rather than round the
        whole group — the strip has to stay outside it, or the active tab's own
        border and the group's collide in the same two pixels. See the
        stylesheet's note on `.conversation-body`.
      */}
      <div className="conversation-body">
        {active !== undefined && props.renderSession(active, props.focused, props.paneId)}
      </div>
    </div>
  )
}
