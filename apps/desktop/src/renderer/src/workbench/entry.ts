import { getService, initialize } from '@codingame/monaco-vscode-api'
import { IURLService } from '@codingame/monaco-vscode-api/vscode/vs/platform/url/common/url.service'
import { ILogService } from '@codingame/monaco-vscode-api/vscode/vs/platform/log/common/log.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { prepareWorkbench } from './services.js'
import { reportEditorContext } from './context.js'
import { serveWorkbenchEdits, serveWorkbenchSnapshot } from './edit.js'
import { serveAskDiff } from './ask-diff.js'
import { installGateHandle } from './gate-handle.js'
import { announceSharedExtensionScope } from './extension-scope.js'
import { refreshScmOnFileChanges } from './scm-refresh.js'
import { registerWorkbenchWorkers } from './workers.js'
import { persistUserSettings, restoreUserSettings } from './user-settings.js'
import { restoreBrowserExtensions, synchronizeBrowserExtensions } from './browser-extensions.js'

/**
 * One workbench, in one document, in one process.
 *
 * The library initialises once per JavaScript realm and cannot be unloaded —
 * `checkServicesNotInitialized` throws on a second `initialize` in the same
 * global. N surfaces work because N `WebContentsView`s are N realms in N
 * processes, so the module-level singleton cannot be shared even by accident.
 * This file must therefore never pretend it can re-initialise.
 *
 * `window.vscodeWindow` is deliberately never set. The library's patch reads
 * `export const mainWindow = (window.vscodeWindow ?? window)`, and setting it to
 * a parent is what makes VS Code append its `data-vscode` head elements into a
 * shared document — where the documented teardown,
 * `document.querySelectorAll('[data-vscode]').forEach(el => el.remove())`, genuinely
 * does reach a sibling. Left unset, `mainWindow` is this document's own window,
 * the tagged elements land in this document's own head, and a cleanup running in
 * this realm cannot see another surface's elements. That hazard is designed out
 * rather than mitigated, and the cost of designing it out is zero — Chorus has no
 * use for parent-DOM integration, because each surface is its own top-level
 * `webContents` in which `window.vscodeWindow` has nothing to point at.
 */
async function main(): Promise<void> {
  /*
   * The one thing this document is told, and it is told it by main.
   *
   * Never a query string: the shell would have to hold the descriptor to write
   * one, and a URL parameter is not a variable that stays in memory — it lands in
   * session history and in any devtools recording, permanently. There is no
   * secret in this slice's descriptor yet, and the mechanism is still the one
   * that will carry the connection token in step 2, so it is built now rather
   * than retrofitted around one.
   */
  const connection = await window.chorusWorkbench.connection()

  /*
   * Before the container, before the services, and before `initialize` — E5.
   *
   * User settings and the browser-extension registry have to exist in the
   * user-data provider by the time services read them inside `initialize`.
   * Their restore helpers enforce that ordering through `initFile`, so getting
   * this wrong is loud rather than a workbench that quietly starts empty.
   *
   * A profile that has never stored settings answers `null` and nothing is
   * seeded, which is what leaves Code-OSS's own defaults in place.
   */
  await restoreUserSettings(await window.chorusWorkbench.readUserSettings())
  await restoreBrowserExtensions(await window.chorusWorkbench.readBrowserExtensions())

  const container = document.createElement('div')
  container.className = 'workbench-root'
  document.body.replaceChildren(container)

  /*
   * Before `initialize`, because a service that resolves a worker during startup
   * reads `MonacoEnvironment` off `globalThis` at that moment — there is no
   * registry to add to afterwards, only a global to have set in time.
   */
  registerWorkbenchWorkers()

  const { services, options, env } = prepareWorkbench(connection)
  await initialize(services, container, options, env)

  /*
   * After `initialize`, because the file service does not exist before it. Not
   * awaited into the startup path any further than resolving the service: a
   * failure to subscribe must not stop a workbench that is otherwise up, and it
   * reaches the same failure element as everything else through `main`'s catch.
   */
  await persistUserSettings((text) => window.chorusWorkbench.writeUserSettings(text))
  await synchronizeBrowserExtensions(
    (text) => window.chorusWorkbench.writeBrowserExtensions(text),
    (handler) => {
      window.chorusWorkbench.onBrowserExtensionsChanged(handler)
    }
  )

  /*
   * Keeps SCM current while the person is in the chat rather than the editor.
   *
   * After `initialize` like everything else here. See `scm-refresh.ts` for why
   * the git extension stops refreshing the moment this view loses keyboard focus
   * to a sibling `WebContentsView` in the same window.
   */
  await refreshScmOnFileChanges()

  /*
   * OAuth callbacks, handed in by main.
   *
   * After `initialize` for the same reason as everything else here — the service
   * does not exist before it. `IURLService.open` is what VS Code's own protocol
   * handler calls, so an extension that registered a URI handler receives this
   * exactly as it would in a desktop VS Code; nothing here knows or cares which
   * extension is waiting.
   */
  const urls = await getService(IURLService)
  window.chorusWorkbench.onUrl((url) => {
    void urls.open(URI.parse(url))
  })

  /*
   * C-063's disclosure, and the condition on which the shared scope was accepted.
   * Same placement rule as the line above: after `initialize`, because the
   * services do not exist before it.
   */
  await announceSharedExtensionScope()

  /*
   * Phase 6d. Registered after the workbench is initialized, because resolving a
   * model needs the services to exist — but before anything can ask, since main
   * has no way to know when this document became ready and a request that
   * arrives early would simply have no listener.
   *
   * **Before the reporting setup, and that ordering is defensive.** These two
   * were registered after it, so anything thrown while establishing the push —
   * a service that will not resolve, a Node global reached from a browser bundle,
   * which has happened — took the Send-time handlers down with it. The two
   * failures then compound: no context is pushed *and* no snapshot can be
   * requested, which reads as "the editor is not connected" rather than as one
   * thing being broken.
   */
  serveWorkbenchEdits(connection.projectRoot)
  serveWorkbenchSnapshot(connection.projectRoot)
  serveAskDiff(connection.remoteAuthority)

  /*
   * Phase 6 slice 6a. After `initialize` like the two above, and given the root
   * from the descriptor so the relativising happens here — no path crosses back
   * to main.
   *
   * Not awaited into the startup path: a failure to establish the push must not
   * stop a workbench that is otherwise up, and — since the handlers above are
   * already registered — Send still works from the snapshot alone.
   */
  /*
   * **Caught so the surface survives it, logged so it is not invisible.**
   *
   * The catch is deliberate and stays: the handlers above are already
   * registered, so a failure here costs the live pill and leaves Send working
   * from the snapshot. What it must not do is cost the *evidence* — this was
   * `.catch(() => undefined)`, and a `ReferenceError` thrown while establishing
   * the push then looked exactly like an editor with nothing open. Two separate
   * investigations began by re-deriving from a symptom what one line would have
   * said outright.
   *
   * `ILogService`, not `console`: it is the workbench's own channel, it reaches
   * the Output view and the log file, and the renderer is not allowed `console`.
   * Stringified here rather than passed as an argument, so the stack survives
   * whichever logger is attached.
   */
  const logs = await getService(ILogService)
  await reportEditorContext(connection.projectRoot).catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    logs.error(`Chorus: editor context reporting failed to start — ${detail}`)
  })

  /*
   * A driver's handle on this editor, and **only** under the gate's own
   * condition.
   *
   * `workspaceTrust: 'waived'` is set by main solely when the app is unpackaged
   * *and* the E2E root seed is in the environment — both, never either, and
   * neither reachable from a renderer. It is the flag the trust waiver already
   * rides on, so this adds no new way in; a packaged app has no `workspaceTrust`
   * field at all and this branch cannot run.
   *
   * It exists because the editor-context chain could not be proved end to end
   * without opening a file, and every other route into this document — clicking
   * a measured rectangle in the explorer, driving quick open by keystroke — is
   * either refused on review or so indirect that a failure says nothing about
   * the thing under test.
   */
  if (connection.workspaceTrust === 'waived') {
    await installGateHandle(connection.projectRoot)
  }
}

/*
 * A failure goes into the document, not into the console.
 *
 * Partly because the renderer may not use `console`, and partly because the
 * console is the wrong channel for it: reading another target's console over the
 * debugger needs `Runtime.enable`, which this repository already records as
 * breaking sandboxed renderers created afterwards. An element the gate can query
 * is legible to a person looking at the surface *and* to the driver, and neither
 * has to be enabled first.
 */
void main().catch((error: unknown) => {
  const failure = document.createElement('pre')
  failure.className = 'workbench-failure'
  failure.textContent = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : 'failed'
  document.body.replaceChildren(failure)
})
