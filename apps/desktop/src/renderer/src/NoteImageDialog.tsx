import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialog } from './useDialog.js'

/**
 * How an image gets into the global note when it is not pasted.
 *
 * **A sheet rather than the file picker on its own**, because a picker can only
 * answer one of the two questions people arrive with. A screenshot on disk wants
 * Finder; an image already on the web wants somewhere to put its address. One
 * control for each, in one place, is the smallest thing that covers both.
 *
 * **It owns no async work and closes nothing.** Both actions report an intent
 * and stop there: the caller fetches, stores, inserts and decides when this goes
 * away. That is what keeps a cancelled picker from closing the sheet, and what
 * lets a failed address leave the text you typed where you can correct it.
 *
 * Neither path ever sees a filesystem path. Main answers both with a
 * `chorus-note:` URL — see `note-images.ts`.
 */
export interface NoteImageDialogProps {
  /** Something is in flight: the picker is open, or an address is being fetched. */
  readonly busy: boolean
  /** What went wrong last time, already a sentence. */
  readonly error: string | null
  readonly onPick: () => void
  readonly onAddress: (address: string) => void
  readonly onCancel: () => void
}

export function NoteImageDialog(props: NoteImageDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const dialog = useDialog<HTMLElement>(props.onCancel)
  const title = t('app.noteImageTitle')
  const [address, setAddress] = useState('')

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
        <button
          type="button"
          className="note-image-pick"
          disabled={props.busy}
          onClick={props.onPick}
        >
          {t('app.noteImagePick')}
        </button>
        <p className="confirm-body">{t('app.noteImageOr')}</p>
        {/*
          A form, so Enter submits the address rather than doing nothing — the
          field is the only thing in here somebody types into, and a text box
          that ignores Enter is a text box people press twice.
        */}
        <form
          className="note-image-address"
          onSubmit={(event) => {
            event.preventDefault()
            if (address.trim() === '' || props.busy) return
            props.onAddress(address.trim())
          }}
        >
          <input
            type="url"
            value={address}
            disabled={props.busy}
            aria-label={t('app.noteImageAddress')}
            placeholder={t('app.noteImageAddress')}
            onChange={(event) => {
              setAddress(event.currentTarget.value)
            }}
          />
        </form>
        {props.error !== null && <p className="confirm-body note-image-error">{props.error}</p>}
        <div className="sheet-actions confirm-actions">
          {/* Cancel first in the DOM, so it is what `useDialog` focuses on open —
              the same ordering as the two confirmations. */}
          <button type="button" onClick={props.onCancel}>
            {t('app.noteImageCancel')}
          </button>
          <button
            type="button"
            className="confirm-go"
            disabled={props.busy || address.trim() === ''}
            onClick={() => {
              props.onAddress(address.trim())
            }}
          >
            {props.busy ? t('app.noteImageWorking') : t('app.noteImageInsert')}
          </button>
        </div>
      </section>
    </div>
  )
}
