import { getService } from '@codingame/monaco-vscode-api'
import { ITextModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service'
import { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { readEditorSnapshot } from './context.js'
import type { WorkbenchEditRequest, WorkbenchEditResult } from '../../../shared/workbench-ipc.js'

/**
 * Applies an agent's edit to the **live model**, not to the file — Phase 6d.
 *
 * This is the half of Phase 6 that makes an agent a participant in the editor
 * rather than a process writing beside it. The distinction is not academic: if
 * the person has unsaved changes in a file, writing it on disk either destroys
 * their work or is destroyed by their next save. Going through the model means
 * the edit lands where they are actually looking.
 *
 * **Three properties come free from doing it this way, and each was a bullet in
 * the plan.** The edit joins the model's own undo stack, so `⌘Z` reverses it
 * like anything they typed. The file becomes dirty rather than saved, so nothing
 * is committed on their behalf — the plan's "never auto-save". And the SCM view
 * and diagnostics update themselves, because they are watching the model.
 *
 * **Nothing here trusts the request.** It arrives from main, which got it from
 * an agent, and both are outside this document's trust boundary. The path is
 * relative and is refused if it escapes the project; the version must match
 * before a single character moves.
 */

/**
 * The payload, checked before it is believed.
 *
 * It arrives from main, which got it from an agent, so this document trusts
 * none of it — the same rule `workbench-surface.ts` applies in the other
 * direction to anything a surface reports. A malformed request is answered with
 * a refusal rather than thrown, because main is waiting for a reply and an
 * exception here would become a timeout there.
 */
export function asEditRequest(value: unknown): WorkbenchEditRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const r = v['range']
  if (typeof r !== 'object' || r === null) return null
  const range = r as Record<string, unknown>
  const numbers = ['startLine', 'startColumn', 'endLine', 'endColumn'] as const
  if (!numbers.every((k) => typeof range[k] === 'number' && Number.isInteger(range[k]))) return null
  if (typeof v['requestId'] !== 'string' || v['requestId'] === '') return null
  if (typeof v['path'] !== 'string') return null
  if (typeof v['baseVersion'] !== 'number' || !Number.isInteger(v['baseVersion'])) return null
  if (typeof v['oldText'] !== 'string') return null
  if (typeof v['newText'] !== 'string') return null
  return {
    requestId: v['requestId'],
    path: v['path'],
    baseVersion: v['baseVersion'],
    range: {
      startLine: range['startLine'] as number,
      startColumn: range['startColumn'] as number,
      endLine: range['endLine'] as number,
      endColumn: range['endColumn'] as number,
    },
    oldText: v['oldText'],
    newText: v['newText'],
  }
}

/** Guards against `..` and absolute paths before a URI is ever built. */
function insideProject(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return !path.split('/').includes('..')
}

/**
 * Resolves the model for a project-relative path, or says why it cannot.
 *
 * `ITextModelService` rather than opening an editor: an edit must not steal the
 * person's view. If the file is not open, this creates the model and the edit
 * lands in it — the file shows as dirty and they can look when they choose,
 * which is what an editor does when a refactor touches twenty files.
 */
async function resolveModel(projectRoot: string, path: string) {
  const models = await getService(ITextModelService)
  const files = await getService(IFileService)
  const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot
  const uri = URI.file(`${root}/${path}`)
  if (!(await files.exists(uri))) return { uri, reference: null }
  return { uri, reference: await models.createModelReference(uri) }
}

/**
 * The handler main's request arrives at.
 *
 * Returns a result rather than throwing, because every refusal here is
 * information the agent should act on differently — a conflict means re-read, a
 * missing file means the path was wrong — and an exception crossing IPC would
 * flatten all of them into one string.
 */
export async function applyWorkbenchEdit(
  projectRoot: string,
  request: WorkbenchEditRequest
): Promise<WorkbenchEditResult> {
  if (!insideProject(request.path)) {
    return {
      requestId: request.requestId,
      ok: false,
      refusal: 'outside-project',
      message: `"${request.path}" is not a path inside this project.`,
      version: null,
    }
  }

  let resolved
  try {
    resolved = await resolveModel(projectRoot, request.path)
  } catch (error) {
    return {
      requestId: request.requestId,
      ok: false,
      refusal: 'unopenable',
      message: error instanceof Error ? error.message : String(error),
      version: null,
    }
  }

  if (resolved.reference === null) {
    return {
      requestId: request.requestId,
      ok: false,
      refusal: 'unopenable',
      message: `"${request.path}" does not exist in this project.`,
      version: null,
    }
  }

  try {
    /*
     * No null check on the model: the service declares it non-nullable, and the
     * `catch` below turns a runtime surprise into a refusal rather than a crash.
     * A guard the types call dead is a guard nobody maintains.
     */
    const model = resolved.reference.object.textEditorModel
    const version = model.getVersionId()
    /*
     * The conflict check, and it is deliberately before anything else touches
     * the model. An agent that read version 7 and is told the model is at 9 has
     * been overtaken — by the person typing, or by an earlier edit in the same
     * turn — and applying anyway is the silent clobber this whole mechanism
     * exists to prevent.
     */
    if (version !== request.baseVersion) {
      return {
        requestId: request.requestId,
        ok: false,
        refusal: 'conflict',
        message: `"${request.path}" has changed since it was read (version ${String(version)}, edit was written against ${String(request.baseVersion)}).`,
        version,
      }
    }

    /*
     * The second check, and it catches what the version cannot.
     *
     * A version says *when*; it says nothing about *where*. An edit written
     * against the right version with a range that is one line out passes the
     * version check and then replaces the wrong text — silently, because
     * nothing downstream knows what was supposed to be there. Comparing the
     * range's actual contents is the only thing that catches it.
     */
    const actual = model.getValueInRange({
      startLineNumber: request.range.startLine,
      startColumn: request.range.startColumn,
      endLineNumber: request.range.endLine,
      endColumn: request.range.endColumn,
    })
    if (actual !== request.oldText) {
      return {
        requestId: request.requestId,
        ok: false,
        refusal: 'conflict',
        message: `The text at that range in "${request.path}" is not what the edit expected. Re-read the file and use the range and text you find.`,
        version,
      }
    }

    /*
     * `pushStackElement` before and after, so the edit is exactly one undo step.
     * Without it an agent's change can merge into whatever the person typed
     * immediately before, and one `⌘Z` then undoes both — which makes "undo the
     * agent's edit" impossible to do precisely, and that is the plan's exit
     * criterion for this slice.
     *
     * `pushEditOperations` rather than `applyEdits`: the latter does not go on
     * the undo stack at all.
     */
    model.pushStackElement()
    model.pushEditOperations(
      null,
      [
        {
          range: {
            startLineNumber: request.range.startLine,
            startColumn: request.range.startColumn,
            endLineNumber: request.range.endLine,
            endColumn: request.range.endColumn,
          },
          text: request.newText,
        },
      ],
      () => null
    )
    model.pushStackElement()

    return { requestId: request.requestId, ok: true, version: model.getVersionId() }
  } catch (error) {
    return {
      requestId: request.requestId,
      ok: false,
      refusal: 'failed',
      message: error instanceof Error ? error.message : String(error),
      version: null,
    }
  } finally {
    /*
     * Released whatever happened. A model reference is refcounted, and one that
     * is never released keeps the model — and its file watcher — alive for the
     * life of the window. Ten refused edits would be ten leaked models.
     */
    resolved.reference.dispose()
  }
}

/**
 * Subscribes this document to main's edit requests. Called once, at startup.
 *
 * The project root is closed over rather than carried in the request: the
 * surface knows which project it is, and a root arriving over IPC would be a
 * value main could get wrong and this document would then trust.
 */
export function serveWorkbenchEdits(projectRoot: string): void {
  window.chorusWorkbench.onEditRequest(async (raw) => {
    const request = asEditRequest(raw)
    if (request === null) {
      return {
        requestId:
          typeof raw === 'object' && raw !== null && 'requestId' in raw
            ? String(raw.requestId)
            : '',
        ok: false,
        refusal: 'failed',
        message: 'The edit request was malformed.',
        version: null,
      }
    }
    return applyWorkbenchEdit(projectRoot, request)
  })
}

/**
 * Answers main's snapshot request for the life of the document.
 *
 * Registered beside the edit handler because they are the same mechanism in the
 * same direction — main asking this surface something — and splitting them
 * across files would mean two places to look when a request goes unanswered.
 */
export function serveWorkbenchSnapshot(projectRoot: string): void {
  window.chorusWorkbench.onSnapshotRequest(async () => readEditorSnapshot(projectRoot))
}
