import { initialize } from '@codingame/monaco-vscode-api'
import { prepareWorkbench } from './services.js'
import { reportEditorContext } from './context.js'
import { serveWorkbenchEdits } from './edit.js'
import { announceSharedExtensionScope } from './extension-scope.js'
import { registerWorkbenchWorkers } from './workers.js'
import { persistUserSettings, restoreUserSettings } from './user-settings.js'

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
   * The user's settings file has to exist in the user-data provider by the time
   * the configuration service reads its user layer, and that read happens inside
   * `initialize`. `restoreUserSettings` enforces the order itself (`initFile`
   * throws once services are up), so getting this wrong is loud rather than a
   * workbench that quietly starts with defaults.
   *
   * A profile that has never stored settings answers `null` and nothing is
   * seeded, which is what leaves Code-OSS's own defaults in place.
   */
  await restoreUserSettings(await window.chorusWorkbench.readUserSettings())

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

  /*
   * C-063's disclosure, and the condition on which the shared scope was accepted.
   * Same placement rule as the line above: after `initialize`, because the
   * services do not exist before it.
   */
  await announceSharedExtensionScope()

  /*
   * Phase 6 slice 6a. After `initialize` like the two above, and given the root
   * from the descriptor so the relativising happens here — no path crosses back
   * to main.
   */
  await reportEditorContext(connection.projectRoot)
  /*
   * Phase 6d. Registered after the workbench is initialized, because resolving a
   * model needs the services to exist — but before anything can ask, since main
   * has no way to know when this document became ready and a request that
   * arrives early would simply have no listener.
   */
  serveWorkbenchEdits(connection.projectRoot)
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
