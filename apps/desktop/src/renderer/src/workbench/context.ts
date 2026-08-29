import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { ICodeEditorService } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service'
import { IWorkingCopyService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyService.service'
import type { WorkbenchContext } from '../../../shared/workbench-ipc.js'

/**
 * What this surface's editor is looking at, reported to main — Phase 6 slice 6a.
 *
 * **There is no bridge extension, and that is a correction to the plan rather
 * than a shortcut.** §1.1 says editor truth comes from "the workbench API and a
 * trusted built-in extension", and §5.2 schedules the external `.vsix` to be
 * reworked into a built-in one. That framing is inherited from the world where
 * Chorus had no code inside the editor and could only reach it through the
 * extension API. It has code inside the editor now: this module runs in the
 * surface's own document, calls the same services an extension would be a proxy
 * for, and already holds the preload that reaches main.
 *
 * An extension would be **weaker**, not stronger. It would run in the extension
 * host beside third-party code, it cannot reach `window.chorusWorkbench`, and it
 * would need a transport of its own — a socket main serves, with a token
 * delivered somehow — which is a new authenticated surface added to a boundary
 * Phase 1 spent review rounds narrowing. This needs none of that.
 *
 * **State, not history.** `CLAUDE.md`'s test: reading a cursor position back a
 * week later is worse than having none, so this travels on a push channel, is
 * held in memory by main, and has no `ChorusEventPayload`. Nothing here may ever
 * become an event.
 */

/**
 * Project-relative, POSIX separators, or null when the path is not inside the
 * project at all.
 *
 * The root never crosses the IPC boundary, so the relativising happens here
 * rather than in main. A file opened from outside the project — a global
 * settings file, a diff from another tree — reports `null` rather than a `../`
 * path: an agent cannot be told to look at something the project does not
 * contain, and a traversal is not a thing that can be expressed.
 */
function relativeTo(root: string, uriPath: string): string | null {
  const normalisedRoot = root.endsWith('/') ? root.slice(0, -1) : root
  if (uriPath === normalisedRoot) return null
  if (!uriPath.startsWith(`${normalisedRoot}/`)) return null
  return uriPath.slice(normalisedRoot.length + 1)
}

/**
 * Subscribes to the editor and reports on change.
 *
 * Two sources because they answer different questions and neither covers the
 * other: `IEditorService.onDidActiveEditorChange` fires when the *file* changes,
 * and the code editor's `onDidChangeCursorPosition` fires when the caret moves
 * within one. Watching only the first reports a stale position for the whole
 * time somebody is reading a file; watching only the second misses a file opened
 * and not yet touched.
 */
/**
 * What the editor is showing, right now, with the selected text.
 *
 * **Shared with the push rather than a second reader.** The push reports
 * everything here except `text`, and it fires on every keystroke — carrying the
 * selection with it would put a copy of whatever is highlighted across a process
 * boundary sixty times a second, which is why `selectedBytes` exists. The
 * *snapshot* is asked for once, when a message is sent, and there the text is the
 * whole point: for a dirty buffer the file on disk no longer says what the person
 * is looking at, so a path and a line range name lines that do not exist yet.
 *
 * Two readers of one editor would drift — the range from one and the text from
 * another is how a quote ends up describing different lines from its own header.
 */
export async function readEditorSnapshot(
  projectRoot: string
): Promise<WorkbenchContext & { text: string }> {
  const [editors, codeEditors, workingCopies] = await Promise.all([
    getService(IEditorService),
    getService(ICodeEditorService),
    getService(IWorkingCopyService),
  ])
  const uri = editors.activeEditor?.resource
  const editor = codeEditors.getFocusedCodeEditor()
  const model = editor?.getModel() ?? null
  const selection = editor?.getSelection() ?? null
  const text =
    selection === null || model === null || selection.isEmpty()
      ? ''
      : model.getValueInRange(selection)
  return {
    relativePath: uri === undefined ? null : relativeTo(projectRoot, uri.path),
    startLine: selection?.startLineNumber ?? null,
    endLine: selection?.endLineNumber ?? null,
    isEmpty: selection?.isEmpty() ?? true,
    isDirty: uri === undefined ? false : workingCopies.isDirty(uri),
    languageId: model?.getLanguageId() ?? '',
    selectedBytes: new TextEncoder().encode(text).length,
    version: model?.getVersionId() ?? null,
    text,
  }
}

export async function reportEditorContext(projectRoot: string): Promise<void> {
  const [editors, codeEditors, workingCopies] = await Promise.all([
    getService(IEditorService),
    getService(ICodeEditorService),
    getService(IWorkingCopyService),
  ])

  /*
   * The last frame sent, so an unchanged one is not sent again.
   *
   * Cursor events fire per keystroke and arrow key. Main coalesces too, but the
   * cheapest report is the one that never crosses a process boundary — the same
   * reasoning as `WorkbenchFrame`'s rectangle dedupe, one channel over.
   */
  let last = ''

  const report = (): void => {
    const uri = editors.activeEditor?.resource
    const editor = codeEditors.getFocusedCodeEditor()
    const model = editor?.getModel() ?? null
    const selection = editor?.getSelection() ?? null

    /*
     * Bytes rather than characters, and measured from the model rather than
     * carried as text. `TextEncoder` is the only thing here that counts what a
     * provider's cap is actually expressed in; `length` would under-report every
     * non-ASCII selection by up to a factor of four.
     *
     * An empty selection reads zero without asking the model for a range, which
     * is the common case — a caret sitting in a file, on every keystroke.
     */
    const selectedBytes =
      selection === null || model === null || selection.isEmpty()
        ? 0
        : new TextEncoder().encode(model.getValueInRange(selection)).length

    const context: WorkbenchContext = {
      relativePath: uri === undefined ? null : relativeTo(projectRoot, uri.path),
      startLine: selection?.startLineNumber ?? null,
      endLine: selection?.endLineNumber ?? null,
      isEmpty: selection?.isEmpty() ?? true,
      /*
       * Asked of the working copy service, because that is where dirty lives.
       *
       * A first version of this read `model.isDirty()` on the reasoning that the
       * model is the thing being edited. `ITextModel` has no such method — the
       * typechecker said so — and the reasoning was wrong as well as the code:
       * a text model holds content and versions, and *dirtiness is a property of
       * the working copy wrapping it*, which is why `Developer: Log Working
       * Copies` is the tool C-059 ended up using to answer this same question.
       */
      isDirty: uri === undefined ? false : workingCopies.isDirty(uri),
      languageId: model?.getLanguageId() ?? '',
      selectedBytes,
      /*
       * The version an `editor_edit` must quote as `base_version`.
       *
       * Read from the same model the rest of this snapshot describes, so the
       * version and the lines cannot disagree — taken separately they could,
       * and an agent quoting a version that never went with those lines is the
       * conflict this field exists to avoid.
       */
      version: model?.getVersionId() ?? null,
    }

    const rendered = JSON.stringify(context)
    if (rendered === last) return
    last = rendered
    window.chorusWorkbench.reportContext(context)
  }

  editors.onDidActiveEditorChange(report)
  /*
   * Selection as well as position: a drag-select never moves the caret's line
   * and column on its final event, so watching position alone reports a range
   * of one character for a selection of five hundred.
   */
  /*
   * Re-subscribed per editor, because `onDidChangeCursorPosition` belongs to a
   * code editor instance rather than to the service — a new editor is a new
   * emitter, and a subscription taken once would go quiet the first time
   * somebody opened a second file.
   */
  codeEditors.onCodeEditorAdd((editor) => {
    editor.onDidChangeCursorPosition(report)
    editor.onDidChangeCursorSelection(report)
    editor.onDidChangeModelContent(report)
  })
  for (const editor of codeEditors.listCodeEditors()) {
    editor.onDidChangeCursorPosition(report)
    editor.onDidChangeCursorSelection(report)
    editor.onDidChangeModelContent(report)
  }

  report()
}
