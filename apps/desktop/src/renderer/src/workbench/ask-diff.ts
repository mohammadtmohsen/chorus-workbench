import { getService } from '@codingame/monaco-vscode-api'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { ITextModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service'
import { IModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/model.service'
import { ILanguageService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/language.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type { WorkbenchAskDiffResult } from '../../../shared/workbench-ipc.js'

/**
 * The proposed edit, shown as a real diff before anything is applied.
 *
 * **Both sides are synthetic**, and that is the design rather than a shortcut.
 * The proposed content has not been applied and must never be written to disk to
 * be looked at; the original is a snapshot rather than the live file, so it
 * cannot move under the reader while the card is open. Proven in the Phase 2
 * spike: `openEditor` returned `workbench.editors.textDiffEditor` with a content
 * provider on this scheme and nothing on disk.
 *
 * **Two fixed URIs, reused.** One tab exists at a time and its contents are
 * replaced as each queued edit becomes current — matching the approval card,
 * which shows one at a time, oldest first. Per-file URIs would leave a tab per
 * edit in an editor the person was using for something else.
 */

const SCHEME = 'chorus-ask'
const ORIGINAL = URI.from({ scheme: SCHEME, path: '/original' })
const PROPOSED = URI.from({ scheme: SCHEME, path: '/proposed' })

let registered = false
/** The pane the last open produced, so the tab can be closed again. */
let open: { close: () => void } | null = null

/**
 * Content for the two fixed URIs, held here rather than fetched.
 *
 * A content provider is asked once per model; after that the model *is* the
 * content, so replacing a tab's contents means writing to the model rather than
 * re-answering the provider. These are the seed values for the first ask.
 */
const seed = new Map<string, string>()

export function serveAskDiff(remoteAuthority: string): void {
  window.chorusWorkbench.onAskDiffRequest(async (raw): Promise<WorkbenchAskDiffResult> => {
    const request = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const requestId = typeof request['requestId'] === 'string' ? request['requestId'] : ''

    try {
      if (request['close'] === true) {
        open?.close()
        open = null

        /*
         * Leave the real file open, permanently.
         *
         * `pinned: true` is what makes it permanent rather than a preview — VS
         * Code's preview tab is the italic one that the next file silently
         * replaces, which is the wrong thing for a file you just decided about.
         * The diff was a question; this is the answer, and it should still be
         * there when you look back.
         */
        const reveal = request['revealPath']
        if (typeof reveal === 'string' && reveal !== '') {
          const editors = await getService(IEditorService)
          await editors.openEditor({
            /*
             * `vscode-remote:`, not `file:` — and this is not a preference.
             *
             * The workspace folder is built on that scheme against the remote
             * authority (`services.ts:355`), so every file operation is answered
             * by the extension host. A `file:` URI for a project file resolves to
             * nothing here, which the editor reports as "the file was not found"
             * over a file that is plainly in the explorer.
             */
            resource: URI.from({
              scheme: 'vscode-remote',
              authority: remoteAuthority,
              path: reveal,
            }),
            /*
             * A preview tab — italic, and replaced by the next file opened the
             * same way. Deliberately not pinned: this is somewhere the person was
             * put rather than somewhere they chose to go, and a permanent tab per
             * answered edit fills the editor with files nobody asked to keep.
             */
            options: { preserveFocus: false },
          })
        }
        return { requestId, ok: true }
      }

      const path = typeof request['path'] === 'string' ? request['path'] : ''
      const before = typeof request['before'] === 'string' ? request['before'] : ''
      const proposed = typeof request['proposed'] === 'string' ? request['proposed'] : ''

      const models = await getService(ITextModelService)
      const modelService = await getService(IModelService)
      const languages = await getService(ILanguageService)

      seed.set(ORIGINAL.toString(), before)
      seed.set(PROPOSED.toString(), proposed)

      if (!registered) {
        registered = true
        models.registerTextModelContentProvider(SCHEME, {
          provideTextContent: (resource) => {
            const existing = modelService.getModel(resource)
            if (existing !== null) return Promise.resolve(existing)
            return Promise.resolve(
              modelService.createModel(
                seed.get(resource.toString()) ?? '',
                // Coloured as the file it describes, not as plain text: a diff
                // whose two sides are highlighted differently is harder to read
                // than one with no colour at all.
                languages.createByFilepathOrFirstLine(URI.file(path)),
                resource
              )
            )
          },
        })
      }

      /*
       * Written into the models when they already exist, because a provider is
       * asked once per URI and these URIs are deliberately reused. `setValue`
       * rather than dispose-and-recreate: recreating would close the tab holding
       * them, which is the tab being replaced.
       */
      for (const [uri, text] of [
        [ORIGINAL, before],
        [PROPOSED, proposed],
      ] as const) {
        const model = modelService.getModel(uri)
        if (model !== null && model.getValue() !== text) model.setValue(text)
      }

      const editors = await getService(IEditorService)
      const pane = await editors.openEditor({
        original: { resource: ORIGINAL },
        modified: { resource: PROPOSED },
        label: `[claude] ${path}`,
        /*
         * Takes focus, like the extension this mirrors — a diff you have to go
         * and find is one people stop looking at — but **not pinned**.
         *
         * A preview tab, for the same reason the revealed file is one: nothing
         * here was chosen, it was put in front of you, and a question that
         * outlives its answer is clutter. It also makes the handover tidy, since
         * the file revealed on settle takes the same slot rather than opening
         * beside a diff of a decision already made.
         */
        options: { preserveFocus: false },
      })

      const input = pane?.input
      const group = pane?.group
      open =
        input === undefined || group === undefined
          ? null
          : {
              close: () => {
                void group.closeEditor(input)
              },
            }

      return { requestId, ok: true }
    } catch (error) {
      return {
        requestId,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })
}
