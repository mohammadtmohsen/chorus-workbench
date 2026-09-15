import { useTranslation } from 'react-i18next'
import type { NoteResize } from './noteSize.js'

/**
 * The three handles a note is resized by — left edge, bottom edge, corner.
 *
 * **Inside the box rather than around it**, which is what lets one component
 * serve both notes. The global note is sized by its own fixed root and a
 * project's by the panel floating over its column, so there is no one element
 * the two shells could hang handles on — but they both draw the same `.note-body`
 * in the middle, and its edges are the edges you can see. `NoteEditor` takes
 * these as a slot for that reason.
 *
 * **Three targets rather than one corner**, because the two axes are wanted for
 * different reasons: a note is made wider to stop code wrapping and taller to
 * see more of it at once, and a corner forces a person asking for one to answer
 * for both. The corner is there anyway for when the answer really is both.
 */
export interface NoteGripsProps {
  readonly resize: NoteResize
}

export function NoteGrips(props: NoteGripsProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <div
        className="note-grip note-grip--width"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('app.noteResizeWidth')}
        tabIndex={0}
        {...props.resize.grip('width')}
      />
      <div
        className="note-grip note-grip--height"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('app.noteResizeHeight')}
        tabIndex={0}
        {...props.resize.grip('height')}
      />
      <div
        className="note-grip note-grip--corner"
        role="separator"
        aria-label={t('app.noteResizeBoth')}
        tabIndex={0}
        {...props.resize.grip('both')}
      />
    </>
  )
}
