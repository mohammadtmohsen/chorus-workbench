import { Emitter, type Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'

/**
 * Whether the window holding this workbench is the one the person is in — Phase 3.
 *
 * **The problem is a question with no local answer.** VS Code's git extension
 * refreshes only when it believes the window is focused: it wraps its polling in
 * `whenIdleAndFocused()`, which reads `hasFocus` off `IHostService`. In stock
 * Code-OSS that is `getActiveDocument().hasFocus()`, and in a workbench embedded
 * in Chorus it is false whenever the person is typing in Chorus's own composer —
 * a workbench that is fully on screen, with its own document unable to have focus
 * because a *sibling* document in the same window has it.
 *
 * So the answer has to come from main, which can see windows rather than
 * documents. `workbench-surface.ts` pushes it on the owning window's `focus` and
 * `blur` and answers a pull for the value before the first push.
 *
 * **What this is not.** It is not a way around VS Code's own gate, and it is not
 * a claim that the editor is focused. It is the honest answer to the question
 * that gate is asking — the window, not the document — and the difference matters
 * because the wrong answer is what makes the SCM view stale while the transcript
 * beside it reports a file changed.
 *
 * The state is module-level because there is one workbench per realm and one
 * window per surface: `entry.ts` initialises once and `services.ts` reads it from
 * a getter the host service calls whenever it likes.
 */

let windowFocus = false

const changed = new Emitter<void>()

/**
 * Every change, carrying nothing.
 *
 * `void` rather than `boolean` on purpose. The host service recomputes the value
 * from `hasFocus()` and ignores any payload, so a boolean here would be a second
 * source for one fact — and the two would disagree the first time a push arrived
 * before `hasFocus()` had moved.
 */
export const onDidChangeWindowFocus: Event<void> = changed.event

export function windowHasFocus(): boolean {
  return windowFocus
}

/**
 * How many pushes have arrived, and it exists to be compared rather than read.
 *
 * A local `let pushed = false` is what this wants to be and cannot: the flag is
 * only ever set inside a callback, which TypeScript's control flow does not
 * follow, so it pins the local to `false` and the lint reports the guard on it as
 * always true — while annotating the type to widen it trips `no-inferrable-types`
 * instead. A module-scoped count is not narrowed, and comparing two readings of
 * it says the thing the guard actually means: did anything arrive while the pull
 * was in flight.
 */
let pushCount = 0

function apply(next: boolean): void {
  if (next === windowFocus) return
  windowFocus = next
  changed.fire()
}

/**
 * Seeds the value and subscribes, before `initialize` and before any service can
 * read it.
 *
 * **Subscribed first and pulled second**, which is the ordering that cannot lose
 * a change. A push arriving while the pull is in flight is the newer fact, so the
 * pull's answer is applied only when nothing has pushed — otherwise a window that
 * blurred mid-seed would be reported as focused for the rest of the session.
 *
 * **A failure here is swallowed, deliberately.** This runs on the startup path
 * beside the settings restore, and a focus read that failed must not be able to
 * stop a workbench from opening: the value stays `false`, which is what the
 * document's own `hasFocus()` answers anyway — i.e. the state the app was already
 * in, not a new one.
 */
export async function seedWindowFocus(): Promise<void> {
  window.chorusWorkbench.onWindowFocusChanged((hasFocus) => {
    pushCount += 1
    apply(hasFocus)
  })
  const before = pushCount
  try {
    const focused = await window.chorusWorkbench.windowHasFocus()
    if (pushCount === before) apply(focused)
  } catch {
    return
  }
}
