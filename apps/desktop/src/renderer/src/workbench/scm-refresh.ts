import { getService } from '@codingame/monaco-vscode-api'
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'

/**
 * Keeps the SCM view current while somebody is reading the chat instead of the
 * editor.
 *
 * **The problem is a question answered correctly and meant differently.** The
 * bundled git extension refreshes through `whenIdleAndFocused()`, which parks on
 * `window.state.focused` until the window is focused again:
 *
 * ```js
 * if(!_.window.state.focused){
 *   let e=He(_.window.onDidChangeWindowState,t=>t.focused);
 *   await Bi(e); continue    // parks here, indefinitely
 * }
 * ```
 *
 * That is correct in VS Code, where one window is one document: nobody wants
 * `git status` running against a window nobody is looking at. It is wrong here,
 * because `focused` resolves to `getActiveDocument().hasFocus()` — a fact about
 * *this `WebContentsView`*, not about the Chorus window. Clicking into the chat
 * blurs the workbench while leaving it fully on screen beside it, so the editor
 * a person is actively watching decides nobody is watching and stops updating.
 * An agent then edits ten files and the SCM view shows nothing until the editor
 * is clicked.
 *
 * **Why this rather than making the workbench believe it is focused.** That was
 * the first shape considered and it is worse. `IHostService` exposes no focus
 * hook to override — the host-service-override package takes only fullscreen
 * parameters — so it would mean patching `document.hasFocus` and dispatching
 * synthetic window focus events, which every other focus-gated behaviour in the
 * editor would then read as true: focus-change autosave, dimming, and anything
 * a third-party extension gates the same way. A lie told at the bottom of the
 * stack is repaid by everything built on it.
 *
 * This instead adds one honest fact: files on disk changed, so refresh. The
 * event it listens to is the same `IFileService` stream the git extension is
 * waiting on, delivered over the remote agent's socket as a push, so nothing
 * here polls and nothing depends on focus or on main knowing about the write.
 * An agent CLI writing straight to disk is covered for exactly that reason.
 */

/**
 * Long enough to collect a burst, short enough to feel immediate.
 *
 * An agent edit lands as many file events in quick succession — a formatter
 * rewriting a directory produces dozens — and `git.refresh` shells out to
 * `git status`. One refresh per burst is the point; the git extension's own
 * debounce for the same reason is 1000ms, and matching it means the two cannot
 * end up interleaving refreshes at different rates.
 */
const REFRESH_DEBOUNCE_MS = 1000

/**
 * Runs `git.refresh` after file changes settle, for the life of the document.
 *
 * **Failures are swallowed on purpose.** `git.refresh` is contributed by the git
 * extension, so it is absent in a project that is not a repository and during
 * the window before the extension has activated. Neither is a fault worth
 * reporting: there is nothing for a person to do about it and nothing broken —
 * a folder with no git in it has no SCM view to keep current.
 */
export async function refreshScmOnFileChanges(): Promise<void> {
  const [files, commands] = await Promise.all([
    getService(IFileService),
    getService(ICommandService),
  ])

  let timer: ReturnType<typeof setTimeout> | null = null

  files.onDidFilesChange(() => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void commands.executeCommand('git.refresh').catch(() => {
        /* no repository here, or the extension has not activated yet */
      })
    }, REFRESH_DEBOUNCE_MS)
  })
}
