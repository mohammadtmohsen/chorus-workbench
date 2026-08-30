import { getService } from '@codingame/monaco-vscode-api'
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'
import { ISCMService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm.service'

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
 * **The repository check is not an optimisation, it is the whole safety of
 * this.** A first version relied on `.catch()` to absorb the case where a
 * project is not a repository, on the assumption that the command would reject.
 * It does not: the git extension catches its own errors and puts up a *modal* —
 * "Git: There are no available repositories" — so on any project whose folder is
 * not a git checkout, this fired that dialog every time a file changed. Strictly
 * worse than the staleness it was written to fix, and reported within minutes.
 *
 * So the guard asks the question the command cannot be trusted to answer
 * quietly, through the same `IFileService` the events arrive on. It is re-asked
 * per burst rather than cached, because `git init` in an open project is a thing
 * people do and a cached "no" would then be wrong until the next launch.
 */
export async function refreshScmOnFileChanges(): Promise<void> {
  const [files, commands, scm] = await Promise.all([
    getService(IFileService),
    getService(ICommandService),
    getService(ISCMService),
  ])

  let timer: ReturnType<typeof setTimeout> | null = null

  files.onDidFilesChange(() => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      /*
       * **Ask the question the command actually asks.** A first guard checked
       * that `.git` existed in the project root, which is true of every real
       * checkout and still produced the modal at startup: a `.git` directory on
       * disk and a repository the git extension has finished *discovering* are
       * different facts, and the command cares about the second. Firing before
       * discovery completes is precisely the window a launch spends, so the
       * dialog greeted every start.
       *
       * `ISCMService.repositories` is that second fact, held by the workbench
       * rather than inferred from the filesystem. Empty means the command would
       * have nothing to refresh and would say so in a modal; it also covers the
       * folder that is not a repository at all, so the filesystem check it
       * replaces bought nothing the service does not already know.
       */
      if ([...scm.repositories].length === 0) return
      void commands.executeCommand('git.refresh').catch(() => {
        /* a repository disappeared between the check and the call */
      })
    }, REFRESH_DEBOUNCE_MS)
  })
}
