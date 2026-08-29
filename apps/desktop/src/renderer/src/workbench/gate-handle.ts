import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { isCodeEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'

/**
 * What a driver needs to make this editor do something, and nothing else.
 *
 * **Installed only when the connection says `workspaceTrust: 'waived'`**, which
 * main sets when the app is unpackaged *and* the E2E root seed is present —
 * both, never either, and neither reachable from a renderer. A packaged app has
 * no such field, so this cannot be installed in one. It rides the flag the trust
 * waiver already uses rather than inventing a second way in.
 *
 * **Why it exists at all.** The editor-context chain — surface reports, main
 * routes, renderer receives, Send asks, snapshot carries the text — took four
 * rounds to diagnose and every round guessed at a different link, because
 * nothing could open a file in this document from outside it. The alternatives
 * were both bad: clicking a measured rectangle in the explorer is the thing
 * Codex refused during Phase 1 review, and driving quick open by keystroke turns
 * every failure into "was it the picker or the thing under test".
 *
 * Two operations, both of which a person can do trivially and a driver could not
 * do at all. It reads nothing back — the assertions belong on what *main* logged,
 * which is the boundary the bug actually lived at.
 */
export async function installGateHandle(projectRoot: string): Promise<void> {
  const editors = await getService(IEditorService)
  const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot

  const handle = {
    /** Opens a project-relative file as the active editor. */
    open: async (relativePath: string): Promise<boolean> => {
      await editors.openEditor({ resource: URI.file(`${root}/${relativePath}`) })
      return true
    },
    /**
     * Selects a line range in the active editor.
     *
     * Through the editor's own `setSelection` rather than by synthesising drag
     * events: the point is to reach the state a selection produces, and a
     * synthetic drag tests the input stack instead of the thing under test.
     */
    select: (startLine: number, endLine: number): boolean => {
      const control = editors.activeTextEditorControl
      if (!isCodeEditor(control)) return false
      const model = control.getModel()
      if (model === null) return false
      control.setSelection({
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: model.getLineMaxColumn(endLine),
      })
      return true
    },
  }

  ;(window as unknown as { __chorusGate?: typeof handle }).__chorusGate = handle
}
