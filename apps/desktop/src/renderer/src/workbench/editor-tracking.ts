/**
 * Which editor the person last worked in, remembered rather than re-derived.
 *
 * **The bug this exists for.** Editor context was read by asking
 * `IEditorService.activeTextEditorControl` at the moment it was needed. That
 * answers for an ordinary file and answers *nothing* for a diff: a diff editor's
 * two child editors are where focus and selection actually live, and the parent
 * control is not one of them. So opening a GitLab merge-request file — a
 * standard diff over `gl-review:` models — reported `no-editor`, the pill went
 * unmatched, and the composer never even asked for a snapshot. The log said
 * `scheme: "workbench.editors.diffEditorInput", reason: "no-editor"`, which is
 * the whole diagnosis in one line: a real diff input, and no editor found in it.
 *
 * Re-querying also loses the *side*. The previous fix unwrapped a diff to
 * `getModifiedEditor()`, which is right about half the time and silently wrong
 * on the other half — a selection made on the original side was reported as the
 * modified editor's own. Remembering the editor that was actually interacted
 * with makes the side a fact rather than a guess.
 *
 * And it has to survive focus leaving. The snapshot is taken when a message is
 * sent, by which time the person is typing in Chorus and the workbench holds no
 * focus at all. A lookup at that moment is a lookup at the worst possible
 * moment; a retained reference is not.
 *
 * **Why this module has no imports.** Everything here is state transitions over
 * opaque handles. The editors, inputs and services live in `@codingame`
 * packages that import CSS, which the project's `environment: 'node'` test setup
 * cannot load — so anything that touches them is untestable by construction.
 * Keeping the decisions here and the plumbing in `context.ts` is what lets focus,
 * selection, input changes, removal and send-after-focus-loss be tested at all.
 */

/**
 * The editor and the input it belonged to, kept together.
 *
 * The input is not decoration: an editor can outlive the tab that showed it, and
 * a stale reference would report a selection in a document nobody is looking at.
 * Checking the retained input against the active one is how a read refuses.
 */
export interface Tracked<Editor, Input> {
  readonly editor: Editor
  readonly input: Input
}

export interface TrackerState<Editor, Input> {
  /** Every editor currently registered, so a read can refuse a removed one. */
  readonly live: ReadonlySet<Editor>
  readonly tracked: Tracked<Editor, Input> | null
}

export function emptyTracker<Editor, Input>(): TrackerState<Editor, Input> {
  return { live: new Set<Editor>(), tracked: null }
}

export function addEditor<E, I>(state: TrackerState<E, I>, editor: E): TrackerState<E, I> {
  const live = new Set(state.live)
  live.add(editor)
  return { ...state, live }
}

/**
 * Forgets an editor, and forgets it as *the* editor if it was one.
 *
 * Both halves matter. Leaving it in `live` would let a later read accept a
 * disposed editor; leaving it as `tracked` would report a selection from an
 * editor that no longer exists, which is the same bug one step further on.
 */
export function removeEditor<E, I>(state: TrackerState<E, I>, editor: E): TrackerState<E, I> {
  const live = new Set(state.live)
  live.delete(editor)
  const tracked = state.tracked?.editor === editor ? null : state.tracked
  return { live, tracked }
}

/**
 * Promotes the editor the person is actually in.
 *
 * **Focus promotes unconditionally; a selection change only promotes when that
 * editor holds the widget focus.** The asymmetry is the point. Focus is a
 * statement about intent — this is where I am — while selection events also fire
 * for edits an extension makes, for a decoration pass, and for the *other* side
 * of a diff being scrolled or synced. Promoting on any selection would let the
 * modified side steal a selection made on the original side, which is precisely
 * the wrong-side bug this replaces.
 */
export function promote<E, I>(
  state: TrackerState<E, I>,
  editor: E,
  input: I,
  reason: 'focus' | 'selection',
  hasWidgetFocus: boolean
): TrackerState<E, I> {
  if (!state.live.has(editor)) return state
  if (reason === 'selection' && !hasWidgetFocus) return state
  return { ...state, tracked: { editor, input } }
}

/**
 * Drops the retained editor when the tab it belonged to is no longer active.
 *
 * Without this, opening a second file and sending a message would quote the
 * first — the retained editor is still live and still holds its old selection,
 * so nothing else would notice. The active input is the only thing that says
 * which document the person is looking at now.
 *
 * A null active input — an empty group, a webview, a custom editor — clears it
 * too. Reporting a text selection while a webview is on screen would be the same
 * lie in the other direction.
 */
export function activeInputChanged<E, I>(
  state: TrackerState<E, I>,
  activeInput: I | null
): TrackerState<E, I> {
  if (state.tracked === null) return state
  if (activeInput !== null && state.tracked.input === activeInput) return state
  return { ...state, tracked: null }
}

/**
 * The editor a report should be built from, or null.
 *
 * **Checked at read time rather than trusted**, because the gap between
 * promotion and read is exactly where this goes wrong: the person selects,
 * clicks into Chorus, types a message, and sends. Between those, the tab can be
 * closed, the editor disposed, or a different file opened. Verifying both that
 * the editor is still registered and that its input is still the active one is
 * what makes a stale quote impossible rather than unlikely.
 */
export function readable<E, I>(state: TrackerState<E, I>, activeInput: I | null): E | null {
  const tracked = state.tracked
  if (tracked === null) return null
  if (!state.live.has(tracked.editor)) return null
  /*
   * **A null active input refuses, rather than trusting the retained editor.**
   *
   * It used to pass, on the reading that "no active input" meant "nothing to
   * contradict us". That is backwards: a null input is a webview, a custom
   * editor or an empty group on screen, and reporting a text selection then
   * describes a document the person is demonstrably not looking at. Refusing
   * costs a message with no context attached; accepting costs a quote that looks
   * authoritative and is wrong.
   */
  if (activeInput === null) return null
  if (tracked.input !== activeInput) return null
  return tracked.editor
}

/** One editor considered for hydration, described without depending on its type. */
export interface Candidate<Editor> {
  readonly editor: Editor
  /** The editor's model URI as a string, or null when it has no model yet. */
  readonly uri: string | null
  readonly hasSelection: boolean
}

/**
 * Which already-open editor the tracker should adopt at startup.
 *
 * **Every event this tracker listens to is a change**, and a restored session
 * has already had all of them: the editors were created, focused and given their
 * selections before this code existed. So a workbench reopened onto a
 * merge-request diff tracked nothing, reported `no-editor`, and the composer
 * never asked for a snapshot — exactly the original symptom, surviving the fix
 * for it, because the fix only ever learned about editors that changed *after*
 * it started.
 *
 * Restoring a selection is a normal way to start, not an edge case. Asking
 * somebody to click into their editor to wake the feature up would be a
 * workaround pretending to be a fix.
 *
 * **Nothing is adopted until every expected document has arrived**, and that
 * ordering rule is the whole reason this is not simply "pick the best match".
 * A diff's two editors resolve their models independently — different requests,
 * for `gl-review:` different network round trips — so there is a window where
 * exactly one side has a model. Judging inside that window, the lone resolved
 * side is the *only* candidate and wins by default, including when it is the
 * side the person is not in. Nothing corrects it afterwards, because by the time
 * the other side arrives something is already tracked. First to load would
 * quietly become the answer.
 *
 * So `wanted` is read as a set that must be *covered*, not as a list to search.
 * An ordinary input names one document and is covered the moment its editor has
 * a model; a diff names two and is covered only when both do. Refusing early
 * costs a retry — `onDidChangeModel` fires again for the second side — where
 * guessing early costs a wrong commit.
 *
 * **Then two ways to be sure, and no third.** One candidate carrying a selection
 * is the person's own side of a diff — the selection is the evidence. One
 * candidate at all is an ordinary file, where there is nothing to be wrong
 * about. Anything else returns `null`.
 *
 * **Refusing to guess is the correction, and it is not a style preference.** An
 * earlier version took the first match when the two sides could not be told
 * apart, on the reasoning that a wrong guess is transient because focus will fix
 * it. It is not transient in the way that matters: the two sides of a
 * merge-request diff resolve to *different commits*, so the wrong one attaches a
 * `review` provenance naming a commit that never held those lines, and the agent
 * is handed code with an authoritative-looking reference to somewhere it does
 * not exist. Reporting nothing costs a message with no context; reporting the
 * wrong side costs a wrong answer that reads as a right one. Focus, a click or
 * the model arriving all promote properly afterwards.
 */
export function hydrationTarget<E>(
  candidates: readonly Candidate<E>[],
  wanted: readonly (string | null)[]
): E | null {
  const uris = new Set(wanted.filter((uri): uri is string => uri !== null))
  if (uris.size === 0) return null
  const matches = candidates.filter((c) => c.uri !== null && uris.has(c.uri))
  /*
   * Every expected document, present. `matches` only holds candidates whose URI
   * is in `uris`, so the distinct ones it covers are a subset — and equal sizes
   * is therefore the same statement as "all of them", without a second loop.
   */
  const covered = new Set(matches.map((c) => c.uri))
  if (covered.size !== uris.size) return null
  /*
   * Destructured rather than indexed, so the narrowing is the compiler's rather
   * than an assertion. Each list is non-empty by its own length check, but a `!`
   * would state that instead of proving it.
   */
  const selected = matches.filter((c) => c.hasSelection)
  const [onlySelected] = selected
  if (selected.length === 1 && onlySelected !== undefined) return onlySelected.editor
  const [onlyMatch] = matches
  if (matches.length === 1 && onlyMatch !== undefined) return onlyMatch.editor
  return null
}
