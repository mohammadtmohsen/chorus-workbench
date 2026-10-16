import { memo, useCallback, type ComponentProps } from 'react'
import { Session, type ForwardSelection } from './Session.js'
import type { StartOptions } from './useConversationStarts.js'
import { useWorkspaceStore } from './workspace/store.js'

export type SessionHostProps = Omit<
  ComponentProps<typeof Session>,
  'onActivate' | 'onRestart' | 'onForward'
> & {
  readonly paneId: string
  readonly startIn: (projectId: string, options: StartOptions) => void
}

export const SessionHost = memo(function SessionHost({
  paneId,
  startIn,
  ...props
}: SessionHostProps): React.JSX.Element {
  const { conversationId, projectId } = props.session
  const onActivate = useCallback(() => {
    useWorkspaceStore.getState().focusPane(paneId)
  }, [paneId])
  /*
   * Ending this room and opening a fresh one in the same project, in
   * one gesture. `startIn`'s `replacing` argument is what orders the
   * two — see there for why the new one has to exist first.
   */
  const onRestart = useCallback(() => {
    startIn(projectId, { replacing: conversationId })
  }, [startIn, projectId, conversationId])
  /*
   * Opening a fresh room that goes on from this one, and ending
   * nothing. The exact opposite of Restart beside it, from the same
   * conversation and through the same call — which is why the two
   * pass different named fields rather than the same positional one.
   */
  const onForward = useCallback(
    (selection: ForwardSelection) => {
      let objective = ''
      for (const point of selection.text.trim()) {
        if (objective.length + point.length > 2000) break
        objective += point
      }
      startIn(projectId, {
        continueFrom: conversationId,
        objective,
        sourceEventIds: selection.sourceEventIds,
      })
    },
    [startIn, projectId, conversationId]
  )
  return <Session {...props} onActivate={onActivate} onRestart={onRestart} onForward={onForward} />
})
