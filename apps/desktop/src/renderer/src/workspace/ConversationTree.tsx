import { Fragment } from 'react'
import type { SessionInfo } from '../Session.js'
import { ConversationColumn } from './ConversationColumn.js'
import type { ConversationDrag } from './useConversationDrag.js'
import type {
  ConversationArrangement,
  WorkspaceLayoutNode,
} from '../../../shared/workspace-layout.js'

/**
 * A project's conversation tree, drawn the way the workspace draws its panes.
 *
 * The recursion is `LayoutView`'s, one level in: a branch becomes a flex row or
 * column with a sash between each pair of children, a leaf becomes one group.
 * The two are not shared code — one renders panes with project tab strips inside
 * a `<section>`, the other renders groups with conversation strips — but they
 * are the same shape, because the thing they walk is the same type and the
 * operations on it are the same functions.
 *
 * The sash is rendered by the parent branch rather than by the child, so it
 * knows the path and the index it divides. That is also why this takes `path`:
 * `setBranchSizes` addresses a branch by its position in the tree, and a node
 * cannot know its own address.
 */
export function ConversationTree(props: {
  readonly node: WorkspaceLayoutNode
  readonly path: readonly number[]
  readonly projectId: string
  readonly arrangement: ConversationArrangement
  readonly sessions: readonly SessionInfo[]
  readonly paneId: string
  /** The pane holding this project has the caret. */
  readonly paneFocused: boolean
  readonly drag: ConversationDrag
  readonly onSizes: (path: readonly number[], sizes: readonly number[]) => void
  /** Start a conversation in one group — the `+` at the end of its strip. */
  readonly onNewConversation: (groupId: string) => void
  /** End one conversation — the × on its tab. */
  readonly onEndConversation: (conversationId: string) => void
  /** Name one conversation — a double-click on its tab. */
  readonly onRename: (conversationId: string, title: string) => void
  readonly renderSession: (
    session: SessionInfo,
    focused: boolean,
    paneId: string
  ) => React.ReactNode
}): React.JSX.Element | null {
  if (props.node.kind === 'leaf') {
    const group = props.arrangement.panes[props.node.paneId]
    if (group === undefined) return null
    return (
      <ConversationColumn
        projectId={props.projectId}
        group={group}
        sessions={props.sessions}
        paneId={props.paneId}
        focused={props.paneFocused && props.arrangement.focusedPaneId === group.id}
        onNewConversation={() => {
          props.onNewConversation(group.id)
        }}
        onEndConversation={props.onEndConversation}
        onRename={props.onRename}
        drag={props.drag}
        renderSession={props.renderSession}
      />
    )
  }

  const branch = props.node
  return (
    <div
      className="conversation-branch"
      data-orientation={branch.orientation}
      style={{ flexDirection: branch.orientation === 'row' ? 'row' : 'column' }}
    >
      {branch.children.map((child, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <div
              className="conversation-sash"
              role="separator"
              aria-orientation={branch.orientation === 'row' ? 'vertical' : 'horizontal'}
              tabIndex={0}
              onPointerDown={(event) => {
                startResize(event, branch, index, (sizes) => {
                  props.onSizes(props.path, sizes)
                })
              }}
            />
          )}
          <div className="conversation-branch-child" style={{ flexGrow: branch.sizes[index] ?? 1 }}>
            <ConversationTree
              node={child}
              path={[...props.path, index]}
              projectId={props.projectId}
              arrangement={props.arrangement}
              sessions={props.sessions}
              paneId={props.paneId}
              paneFocused={props.paneFocused}
              drag={props.drag}
              onSizes={props.onSizes}
              onNewConversation={props.onNewConversation}
              onEndConversation={props.onEndConversation}
              onRename={props.onRename}
              renderSession={props.renderSession}
            />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * Drag one divider, in fractions of the pair it sits between.
 *
 * **Fractions, and only the pair.** The sizes are proportions of a branch whose
 * own width is decided further out — by the Chorus divider, by the pane tree, by
 * the window — so a stored pixel width would stop adding up the moment any of
 * those moved. Measuring the two neighbours rather than the whole branch keeps a
 * three-way split from resizing the child the pointer is nowhere near.
 */
function startResize(
  event: React.PointerEvent<HTMLDivElement>,
  branch: Extract<WorkspaceLayoutNode, { kind: 'branch' }>,
  index: number,
  commit: (sizes: readonly number[]) => void
): void {
  /* Captured in a local: React nulls `currentTarget` when the handler returns,
     and the move listener would then never be removed. */
  const sash = event.currentTarget
  const container = sash.parentElement
  if (container === null) return
  const children = [
    ...container.querySelectorAll<HTMLElement>(':scope > .conversation-branch-child'),
  ]
  const before = children[index - 1]
  const after = children[index]
  if (before === undefined || after === undefined) return

  const row = branch.orientation === 'row'
  const beforeBox = before.getBoundingClientRect()
  const afterBox = after.getBoundingClientRect()
  const start = row ? beforeBox.left : beforeBox.top
  const end = row ? afterBox.right : afterBox.bottom
  const span = end - start
  if (span <= 0) return

  const total = branch.sizes.reduce((sum, size) => sum + size, 0) || 1
  const share = branch.sizes.map((size) => size / total)
  const pair = (share[index - 1] ?? 0) + (share[index] ?? 0)

  sash.setPointerCapture(event.pointerId)

  const move = (moved: PointerEvent): void => {
    const along = (row ? moved.clientX : moved.clientY) - start
    /* Clamped so neither side can be dragged to nothing — a group with no size
       is one nobody can grab the sash back out of. */
    const first = Math.min(Math.max(along / span, 0.15), Math.max(pair - 0.15, 0.15))
    const next = [...share]
    next[index - 1] = first
    next[index] = pair - first
    commit(next)
  }
  const stop = (): void => {
    sash.removeEventListener('pointermove', move)
    sash.removeEventListener('pointerup', stop)
    sash.removeEventListener('pointercancel', stop)
    sash.releasePointerCapture(event.pointerId)
  }
  sash.addEventListener('pointermove', move)
  sash.addEventListener('pointerup', stop)
  // A capture lost to a system gesture fires this and never `pointerup`.
  sash.addEventListener('pointercancel', stop)
}
