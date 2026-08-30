import { contextBridge, ipcRenderer } from 'electron'
import type { ChorusWorkbenchApi, WorkbenchConnection } from '../shared/workbench-ipc.js'

/**
 * The workbench surface's own preload, and the reason it exists is what it is
 * not (preflight §4.1b).
 *
 * The shell's preload ends with `contextBridge.exposeInMainWorld('chorus', api)`
 * over the whole `ChorusApi` — some seventy methods, among them `decideApproval`,
 * `writeProjectFile`, `runGitAction` and every `terminal:*` channel. A workbench
 * document runs third-party extension code by design, so handing it that object
 * would let extension code answer Chorus's own permission prompts. The failure
 * mode is quiet, too: copying the window's `webPreferences` to "keep the sandbox
 * settings consistent" brings `preload` along silently, which is why
 * `workbench-surface.ts` builds its own literal and never spreads.
 *
 * One method. No bounds, no commands, no `ipcRenderer` pass-through.
 *
 * What this does not buy, said plainly: once `connection()` resolves, whatever it
 * carries is in this document's JavaScript heap. The preload narrows who can ask
 * and what else is reachable; it does not make the answer unreadable by code
 * running here. What it removes is the shell's ability to ask at all, and this
 * document's ability to do anything else with Chorus.
 */

/**
 * Everything below is imported as a **type** and nothing as a value, and that is
 * a build constraint rather than a style.
 *
 * Two preload entries that share one runtime module make Rollup hoist it into
 * `out/preload/chunks/`, and a sandboxed preload cannot load it. Observed, from
 * the app's own console: `Unable to load preload script: …/out/preload/index.js`
 * / `Error: module not found: ./chunks/workbench-ipc-CCkEpa_4.js`, and with it a
 * shell whose `window.chorus` was `undefined` — the *shell's* preload broken by a
 * file added for the workbench. The config's existing note says a sandboxed
 * preload cannot resolve from `node_modules`; this is the same fact one step
 * further in, and it applies to our own emitted chunks.
 *
 * So this file shares no runtime module with `preload/index.ts`: the channel name
 * is written out, and the descriptor is checked by hand rather than with zod. A
 * test asserts the constant still equals the shared one, because two spellings of
 * one channel is precisely the drift that shows up as a dead control rather than
 * an error.
 */
export const CONNECTION_CHANNEL = 'workbench:connection'
/*
 * E5's two, spelled out for the same reason and carrying the same risk. A test
 * asserts all three against the shared constants, because a channel name that
 * drifts here fails as silence — an `invoke` nobody answers — rather than as an
 * error naming the channel.
 */
export const USER_SETTINGS_READ_CHANNEL = 'workbench:userSettings:read'
export const USER_SETTINGS_WRITE_CHANNEL = 'workbench:userSettings:write'
/* The storage pair, under the same test and drifting the same silent way. */
export const STORAGE_READ_CHANNEL = 'workbench:storage:read'
export const STORAGE_WRITE_CHANNEL = 'workbench:storage:write'
/* The OAuth callback push, under the same test as every other name here. */
export const URL_CHANNEL = 'workbench:url'
/* Phase 6 slice 6a, spelled out here for the same reason and under the same test. */
export const CONTEXT_CHANNEL = 'workbench:context'
export const SNAPSHOT_CHANNEL = 'workbench:snapshot'
export const SNAPSHOT_RESULT_CHANNEL = 'workbench:snapshot:result'
export const EDIT_CHANNEL = 'workbench:edit'
export const EDIT_RESULT_CHANNEL = 'workbench:edit:result'

/**
 * A hand-written check instead of a schema, for the reason above — and it is now
 * five fields rather than one, which is exactly when the temptation to import zod
 * returns. It is still refused: a shared runtime module is a shared emitted
 * chunk, and a sandboxed preload cannot load one.
 *
 * Every field is required. A descriptor missing its token would otherwise reach
 * the workbench as a connection with no credential, and the failure would arrive
 * as an unauthorised WebSocket several layers in rather than at the boundary.
 *
 * **And this function rebuilds the object rather than passing it along, so a
 * field added to the shared schema and not added here is silently dropped.** That
 * is not a hypothetical: `workspaceTrust` was added in main, admitted by the zod
 * schema, spread into the descriptor, read by the renderer — and never arrived,
 * because this list still had five names in it. The gate reported a Workspace
 * Trust dialog it had been told would not appear, and every layer in between
 * looked correct. Adding a descriptor field is a two-file change, and this is the
 * second file.
 */
export function asConnection(value: unknown): WorkbenchConnection | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const fields = ['projectRoot', 'remoteAuthority', 'connectionToken', 'commit', 'quality'] as const
  for (const field of fields) {
    const held = record[field]
    if (typeof held !== 'string' || held === '') return null
  }
  return {
    projectRoot: record['projectRoot'] as string,
    remoteAuthority: record['remoteAuthority'] as string,
    connectionToken: record['connectionToken'] as string,
    commit: record['commit'] as string,
    quality: record['quality'] as string,
    /*
     * Carried only when it is exactly the one string that means anything, and
     * dropped otherwise — a boolean, a typo, a future spelling, a value someone
     * hoped would mean the same thing. Every rejection lands on the safe side,
     * because the absence of this field is what enforces Workspace Trust.
     */
    ...(record['workspaceTrust'] === 'waived' ? { workspaceTrust: 'waived' as const } : {}),
  }
}

/**
 * The earliest possible receiver.
 *
 * Preload scripts are injected before the page loads, so this listener is
 * registered before the entry module's graph has even begun to evaluate. Main
 * sequences its push on this view's own `did-finish-load`, but there is still a
 * window between the document existing and the entry subscribing — and under a
 * full workbench that graph is large. The buffer is what makes main's ordering
 * sufficient rather than merely likely.
 */
let buffered: WorkbenchConnection | null = null

ipcRenderer.on(CONNECTION_CHANNEL, (_event, payload: unknown) => {
  // Checked on this side too: main is trusted, but a shape mismatch is our bug
  // and should surface at the boundary rather than deep inside VS Code's startup.
  const parsed = asConnection(payload)
  if (parsed !== null) buffered = parsed
})

const api: ChorusWorkbenchApi = {
  connection: async () => {
    if (buffered !== null) return buffered

    /*
     * A pull answers a reload, because a buffer does not survive one.
     *
     * If this document reloads — a crash recovery, a dev-server full reload,
     * anything calling `location.reload()` — the preload re-executes with an
     * empty buffer and main's push has already happened. Push and pull are one
     * mechanism with two triggers, not two mechanisms; without this arm the
     * reload case hangs rather than throwing, which reads as a slow workbench
     * rather than a broken one.
     *
     * The request carries no arguments. A project id in the payload would be a
     * claim this renderer is not entitled to make: main answers by looking up
     * which view the sender is.
     */
    const raw: unknown = await ipcRenderer.invoke(CONNECTION_CHANNEL)
    const parsed = asConnection(raw)
    if (parsed === null) throw new Error('Malformed workbench connection descriptor')
    buffered = parsed
    return parsed
  },

  /*
   * Anything that is not a string becomes `null`, and that is the safe direction.
   *
   * `null` means "this profile has never stored settings", which makes the
   * workbench seed nothing and keep Code-OSS's defaults. A malformed reply
   * therefore degrades to a clean profile rather than to a seeded one — the
   * opposite choice would let a bad answer from main write over the defaults with
   * whatever it happened to be.
   */
  readUserSettings: async () => {
    const raw: unknown = await ipcRenderer.invoke(USER_SETTINGS_READ_CHANNEL)
    return typeof raw === 'string' ? raw : null
  },

  writeUserSettings: async (text: string) => {
    await ipcRenderer.invoke(USER_SETTINGS_WRITE_CHANNEL, text)
  },

  /*
   * Same narrowing as `readUserSettings` above, and the same reason: anything
   * that is not a string reads as "this scope has stored nothing", which the
   * storage service starts from anyway. A malformed reply must degrade to an
   * empty database rather than to a database of whatever arrived.
   */
  readStorage: async (scope: string) => {
    const raw: unknown = await ipcRenderer.invoke(STORAGE_READ_CHANNEL, scope)
    return typeof raw === 'string' ? raw : null
  },

  writeStorage: async (scope: string, text: string) => {
    await ipcRenderer.invoke(STORAGE_WRITE_CHANNEL, scope, text)
  },

  /*
   * One listener for the life of the document, and the payload is checked here
   * because it arrived from outside it. A non-string is dropped rather than
   * passed on: the handler parses it as a URI, and `URI.parse(undefined)` fails
   * somewhere far less obvious than this line.
   */
  onUrl: (handler: (url: string) => void) => {
    ipcRenderer.on(URL_CHANNEL, (_event, url: unknown) => {
      if (typeof url === 'string') handler(url)
    })
  },

  /*
   * `send`, not `invoke`, and the difference is deliberate.
   *
   * This fires on cursor movement, so it is the highest-frequency thing crossing
   * this boundary by a wide margin. `invoke` would make every keystroke await a
   * round trip to main before the editor's own handler returned; `send` posts and
   * returns. A dropped report costs nothing — the next movement supersedes it,
   * because this channel carries **state and not history**.
   *
   * The payload is validated in main regardless. A surface runs third-party
   * extension code, so nothing arriving from one is trusted here, and `send`
   * removes the reply rather than the check.
   */
  reportContext: (context) => {
    ipcRenderer.send(CONTEXT_CHANNEL, context)
  },

  /*
   * The one channel that runs the other way — main asks, this document answers.
   *
   * Electron has no `webContents.invoke`, so the request/response pair is built
   * by hand: main sends with a `requestId` and the reply carries it back. The
   * correlation lives in main, which is the side that can time out; this side's
   * only job is to answer every request it is given, exactly once.
   *
   * A handler that throws still replies. An unanswered request is indisting-
   * uishable from a hung surface, and main would sit on it until its timeout —
   * so the failure is converted into a result here rather than escaping.
   */
  onSnapshotRequest: (handler) => {
    ipcRenderer.on(SNAPSHOT_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(SNAPSHOT_RESULT_CHANNEL, { requestId, snapshot: await handler() })
        } catch {
          // Answered regardless: main is waiting, and an unanswered request is
          // indistinguishable from a hung surface until its timeout.
          ipcRenderer.send(SNAPSHOT_RESULT_CHANNEL, { requestId, snapshot: null })
        }
      })()
    })
  },

  onEditRequest: (handler) => {
    ipcRenderer.on(EDIT_CHANNEL, (_event, request: unknown) => {
      void (async () => {
        const requestId =
          typeof request === 'object' && request !== null && 'requestId' in request
            ? String(request.requestId)
            : ''
        try {
          ipcRenderer.send(EDIT_RESULT_CHANNEL, await handler(request))
        } catch (error) {
          ipcRenderer.send(EDIT_RESULT_CHANNEL, {
            requestId,
            ok: false,
            refusal: 'failed',
            message: error instanceof Error ? error.message : String(error),
            version: null,
          })
        }
      })()
    })
  },
}

contextBridge.exposeInMainWorld('chorusWorkbench', api)
