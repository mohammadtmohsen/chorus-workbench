import { useTranslation } from 'react-i18next'
import { useDialog } from '../useDialog.js'

/**
 * The one place Restart and End are confirmed.
 *
 * Both actions were reachable from three surfaces — the preview card, the
 * session menu and the composer — and only one of them asked anything, and only
 * for End, and only while an agent was working. So the same key press destroyed
 * a turn or did not depending on which control you happened to use.
 *
 * This lives above all three rather than inside any of them. `App` already
 * funnels every caller through `restart` and `endNow`, and the comment there
 * already says why: "the same two handlers the session menu is given, so a
 * button in the composer and a row in the menu do one thing, not two." Wrapping
 * that funnel is what makes the confirmation impossible to route around.
 *
 * It replaces the preview's two-step arm rather than adding to it. Arming was a
 * confirmation; a confirmation on top of a confirmation is three clicks to end a
 * session, and the second one stops being read.
 */
export interface ConfirmSessionActionProps {
  /** Whether an agent is mid-turn, which is what makes the action lossy. */
  readonly working: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmSessionAction(props: ConfirmSessionActionProps): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onCancel)

  /*
   * The body says what is actually at stake, and it changes when something is.
   *
   * "Are you sure?" is not information. What a person needs is what the
   * irreversible thing costs, and that differs depending on whether an agent is
   * mid-sentence.
   *
   * It asked for Restart too until restart was removed from the app. One `kind`
   * for one action is a discriminator with a single arm, so it went with it.
   */
  const title = t('workspace.confirmEndTitle')
  const body = props.working ? t('workspace.confirmEndBodyWorking') : t('workspace.confirmEndBody')

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialog}
        className="sheet sheet--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="confirm-title">{title}</h2>
        <p className="confirm-body">{body}</p>
        <div className="sheet-actions confirm-actions">
          {/*
            Cancel first in the DOM, so it is what `useDialog` focuses on open
            and what Enter takes. The destructive choice should never be the one
            a reflex lands on.
          */}
          <button type="button" onClick={props.onCancel}>
            {t('workspace.confirmCancel')}
          </button>
          <button type="button" className="confirm-go confirm-go--danger" onClick={props.onConfirm}>
            {t('workspace.end')}
          </button>
        </div>
      </section>
    </div>
  )
}
