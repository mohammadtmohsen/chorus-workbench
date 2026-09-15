import { useProjectRowState } from './hooks.js'
import { stateOf } from './session-row.js'
import { StateMark } from './SessionRow.js'

/**
 * A tab's state mark, in its own component because of the hook.
 *
 * The hook subscribes to a slice of the pulse and the tabs are produced by a
 * `map`, so this cannot be inlined without calling a hook in a loop. Splitting
 * it also means one session going busy re-renders one tab rather than the whole
 * strip.
 *
 * **It takes a list, and that is what makes one component serve both strips.** A
 * conversation tab passes its one id; a project tab passes every conversation in
 * the project, and `useProjectRowState` folds them by the same precedence a
 * single row uses. The project tab used to read the project's *newest*
 * conversation and nothing else, so an approval anywhere else in the project
 * left the outer tab reading idle — the agent was stopped holding a tool and the
 * only surface that said so was a tab you had to already be looking at.
 *
 * A single-id list folds to exactly what the single-conversation hook returned,
 * which is why there is one path here rather than two that agree today.
 */
export function TabState({
  conversationIds,
}: {
  readonly conversationIds: readonly string[]
}): React.JSX.Element {
  const row = useProjectRowState(conversationIds)
  const state = stateOf(row)
  return (
    <span className="workspace-tab-state" data-state={state}>
      <StateMark state={state} voice={row.working.length === 1 ? (row.working[0] ?? null) : null} />
    </span>
  )
}
