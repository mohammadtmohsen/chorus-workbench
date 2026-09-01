import { useTranslation } from 'react-i18next'
import { useDialog } from './useDialog.js'

/**
 * The one question asked before a running conversation is replaced.
 *
 * **Asked only when something is running**, which is the whole reason it is
 * worth asking at all. Ending a quiet conversation loses nothing — the log is
 * append-only and the transcript stays in History, which is why ending stopped
 * needing a confirmation in the first place. A turn in flight is the exception:
 * that work is discarded, and it is the one case where a misclick costs
 * something that cannot be read back.
 *
 * Naming who is working is the content. "Are you sure?" is not information;
 * "Claude is mid-turn" is the sentence that decides the answer — the same
 * argument `ConfirmKillTerminal` makes about a foreground process, and this is
 * shaped after it deliberately. Two destructive confirmations that looked
 * different would be two things to learn.
 */
export interface ConfirmRestartProps {
  /** Who is mid-turn, already joined for reading. */
  readonly working: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ConfirmRestart(props: ConfirmRestartProps): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onCancel)
  const title = t('conversation.confirmRestartTitle')

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
        <p className="confirm-body">
          {t('conversation.confirmRestartBody', { agents: props.working })}
        </p>
        <div className="sheet-actions confirm-actions">
          {/*
            Cancel first in the DOM, so it is what `useDialog` focuses on open
            and what Enter takes. The destructive choice should never be the one
            a reflex lands on — the same ordering, and the same reason, as
            `ConfirmKillTerminal`.
          */}
          <button type="button" onClick={props.onCancel}>
            {t('conversation.confirmRestartCancel')}
          </button>
          <button type="button" className="confirm-go confirm-go--danger" onClick={props.onConfirm}>
            {t('conversation.confirmRestart')}
          </button>
        </div>
      </section>
    </div>
  )
}
