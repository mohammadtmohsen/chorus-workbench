import { describe, expect, it } from 'vitest'
import {
  activeInputChanged,
  addEditor,
  emptyTracker,
  hydrationTarget,
  promote,
  readable,
  removeEditor,
  type TrackerState,
} from './editor-tracking.js'

/**
 * The state machine behind "which editor is the person actually in".
 *
 * Editors and inputs are opaque here — strings stand in for them — which is the
 * whole reason this is testable. The real ones come from `@codingame` packages
 * that import CSS, and the project's `environment: 'node'` setup cannot load
 * those; a test that imported them would fail on `Unknown file extension ".css"`
 * before reaching an assertion. That is not hypothetical: it is why no unit test
 * caught the `process.platform` defect earlier in this file's history.
 */

type State = TrackerState<string, string>

const withEditors = (...editors: string[]): State =>
  editors.reduce<State>((state, editor) => addEditor(state, editor), emptyTracker<string, string>())

describe('tracking which editor the person is in', () => {
  it('remembers the focused editor and reads it back', () => {
    let state = withEditors('modified', 'original')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    expect(readable(state, 'mr-diff')).toBe('modified')
  })

  /*
   * The wrong-side bug, stated as a test. A diff's two children both emit
   * selection changes — synced scrolling, decorations, an extension's own edits —
   * so promoting on any selection would let the side the person is *not* in
   * claim the selection. Focus is the statement of intent; selection is only
   * evidence when it comes with focus.
   */
  it('does not let the unfocused side of a diff steal the selection', () => {
    let state = withEditors('modified', 'original')
    state = promote(state, 'original', 'mr-diff', 'focus', true)
    state = promote(state, 'modified', 'mr-diff', 'selection', false)
    expect(readable(state, 'mr-diff')).toBe('original')
  })

  it('follows a selection made in the editor that holds focus', () => {
    let state = withEditors('modified', 'original')
    state = promote(state, 'original', 'mr-diff', 'focus', true)
    state = promote(state, 'modified', 'mr-diff', 'selection', true)
    expect(readable(state, 'mr-diff')).toBe('modified')
  })

  /*
   * The case the whole design exists for. By the time a message is sent the
   * person is typing in Chorus and the workbench holds no focus at all, so a
   * lookup at that moment finds nothing. The retained editor is still readable
   * because nothing about the editor changed — only where the caret is.
   */
  it('still reads after focus has left the workbench entirely', () => {
    let state = withEditors('modified')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    // No event models "Chorus took focus" — the tracker simply is not told, which
    // is the point: nothing invalidates it.
    expect(readable(state, 'mr-diff')).toBe('modified')
  })

  it('refuses an editor that has been disposed', () => {
    let state = withEditors('modified')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    state = removeEditor(state, 'modified')
    expect(readable(state, 'mr-diff')).toBeNull()
  })

  /*
   * Opening another file must not quote the previous one. The retained editor is
   * still alive and still holds its old selection, so the active input is the
   * only thing that can tell.
   */
  it('refuses once a different document is the active one', () => {
    let state = withEditors('modified')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    expect(readable(state, 'some-other-file')).toBeNull()
  })

  it('forgets the editor when the active input changes', () => {
    let state = withEditors('modified')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    state = activeInputChanged(state, 'some-other-file')
    expect(readable(state, 'some-other-file')).toBeNull()
    expect(readable(state, 'mr-diff')).toBeNull()
  })

  /*
   * A webview, a custom editor or an empty group has no text input. Reporting a
   * text selection while one of those is on screen is the same lie as reporting a
   * closed file's.
   */
  it('forgets the editor when the active pane has no input at all', () => {
    let state = withEditors('modified')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    state = activeInputChanged(state, null)
    expect(readable(state, null)).toBeNull()
  })

  /*
   * Refusing on a null active input, asserted without going through
   * `activeInputChanged` first. An earlier version treated "no active input" as
   * "nothing contradicts us" and returned the retained editor — which is a text
   * selection reported while a webview or an empty group is on screen.
   */
  it('refuses to read while nothing is active, even if tracking survived', () => {
    let state = withEditors('modified')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    expect(readable(state, null)).toBeNull()
  })

  it('ignores an editor it was never told about', () => {
    const state = promote(withEditors('modified'), 'ghost', 'mr-diff', 'focus', true)
    expect(readable(state, 'mr-diff')).toBeNull()
  })

  /*
   * Removing an editor that is not the tracked one must not clear the tracking —
   * a diff closing one child while the other stays, or an unrelated tab being
   * closed while a selection is pending in this one.
   */
  /*
   * The startup case, and the one the first version of this tracker missed
   * entirely. Every event it listens to is a *change*, so a session restored onto
   * a diff with a live selection produced none of them and the tracker stayed
   * empty — reproducing the original `no-editor` symptom through the fix for it.
   */
  it('adopts the selected side of a restored diff', () => {
    const chosen = hydrationTarget(
      [
        { editor: 'original', uri: 'gl-review:/src/app.ts?base', hasSelection: false },
        { editor: 'modified', uri: 'gl-review:/src/app.ts?head', hasSelection: true },
      ],
      ['gl-review:/src/app.ts?base', 'gl-review:/src/app.ts?head']
    )
    expect(chosen).toBe('modified')
  })

  it('adopts the original side when that is the one with a selection', () => {
    const chosen = hydrationTarget(
      [
        { editor: 'original', uri: 'gl-review:/src/app.ts?base', hasSelection: true },
        { editor: 'modified', uri: 'gl-review:/src/app.ts?head', hasSelection: false },
      ],
      ['gl-review:/src/app.ts?base', 'gl-review:/src/app.ts?head']
    )
    expect(chosen).toBe('original')
  })

  /*
   * With no selection anywhere, or one on both sides, there is nothing that
   * distinguishes them — and this used to take the first match anyway, on the
   * reasoning that focus would correct a transient wrong guess.
   *
   * The guess is not transient in the way that matters. The two sides of a
   * merge-request diff are *different commits*, so adopting the wrong one
   * reports a `review` provenance naming a commit those lines were never in.
   * The agent then gets code with a reference that looks authoritative and
   * points nowhere. No context at all is the cheaper wrong answer.
   */
  it('adopts nothing when the two sides cannot be told apart', () => {
    expect(
      hydrationTarget(
        [
          { editor: 'original', uri: 'a', hasSelection: false },
          { editor: 'modified', uri: 'b', hasSelection: false },
        ],
        ['a', 'b']
      )
    ).toBeNull()
    expect(
      hydrationTarget(
        [
          { editor: 'original', uri: 'a', hasSelection: true },
          { editor: 'modified', uri: 'b', hasSelection: true },
        ],
        ['a', 'b']
      )
    ).toBeNull()
  })

  /*
   * The ordering defect, and the reason coverage is checked before anything is
   * chosen. A diff's two editors resolve their models independently, so there is
   * a window in which one side has a model and the other does not — and inside
   * it the resolved side is the only candidate and wins unopposed, even when it
   * is the side nobody selected. Nothing corrects that afterwards: by the time
   * the second side arrives, something is already tracked and hydration is
   * blocked. Whichever side's network request returned first would decide.
   */
  it('waits for the second side of a diff rather than adopting the first to load', () => {
    const wanted = ['gl-review:/src/app.ts?base', 'gl-review:/src/app.ts?head']
    // The unselected side has resolved; the person's own side has not.
    expect(
      hydrationTarget(
        [{ editor: 'original', uri: 'gl-review:/src/app.ts?base', hasSelection: false }],
        wanted
      )
    ).toBeNull()
    // And once it does, the selection decides — as it would have all along.
    expect(
      hydrationTarget(
        [
          { editor: 'original', uri: 'gl-review:/src/app.ts?base', hasSelection: false },
          { editor: 'modified', uri: 'gl-review:/src/app.ts?head', hasSelection: true },
        ],
        wanted
      )
    ).toBe('modified')
  })

  /* The same window with the *selected* side first: still no answer yet. */
  it('waits even when the side that resolved first is the selected one', () => {
    expect(
      hydrationTarget([{ editor: 'modified', uri: 'head', hasSelection: true }], ['base', 'head'])
    ).toBeNull()
  })

  /*
   * An ordinary file names one document and opens one editor, so there is
   * nothing to be wrong about — no selection is needed to disambiguate a set of
   * one. Without this arm, restoring onto a plain file with the caret parked in
   * it would adopt nothing.
   */
  it('adopts the only candidate, selection or not', () => {
    expect(hydrationTarget([{ editor: 'only', uri: 'a', hasSelection: false }], ['a'])).toBe('only')
  })

  /*
   * And a diff whose sides happen to share a URI is still a set of one editor
   * per document — the guard is about *ambiguity*, not about diffs.
   */
  it('refuses when several editors show the same document and none is selected', () => {
    expect(
      hydrationTarget(
        [
          { editor: 'left', uri: 'a', hasSelection: false },
          { editor: 'right', uri: 'a', hasSelection: false },
        ],
        ['a']
      )
    ).toBeNull()
  })

  it('adopts nothing when no open editor belongs to the active input', () => {
    expect(
      hydrationTarget([{ editor: 'other-file', uri: 'z', hasSelection: true }], ['a', 'b'])
    ).toBeNull()
    expect(hydrationTarget([], ['a'])).toBeNull()
  })

  /* An editor whose model has not arrived yet is not a candidate. */
  it('ignores an editor with no model', () => {
    expect(hydrationTarget([{ editor: 'blank', uri: null, hasSelection: false }], ['a'])).toBeNull()
  })

  it('keeps the tracked editor when a different one is removed', () => {
    let state = withEditors('modified', 'original')
    state = promote(state, 'modified', 'mr-diff', 'focus', true)
    state = removeEditor(state, 'original')
    expect(readable(state, 'mr-diff')).toBe('modified')
  })
})
