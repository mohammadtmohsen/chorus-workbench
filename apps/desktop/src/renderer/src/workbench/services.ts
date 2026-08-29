import {
  type IEditorOverrideServices,
  type IWorkbenchConstructionOptions,
  LogLevel,
} from '@codingame/monaco-vscode-api'
import type { EnvironmentOverride } from '@codingame/monaco-vscode-api/workbench'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
/*
 * The export-map subpath, not the path inside the tarball. The published map is
 * `"./vscode/*" → "./vscode/src/*.js"`, so the pattern supplies both `src/` and
 * the extension; writing either here doubles it and Node raises
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than anything that names the mistake.
 * Review round 3 of the preflight caught exactly this, in a test.
 */
import product from '@codingame/monaco-vscode-api/vscode/vs/platform/product/common/product'
import type { WorkbenchConnection } from '../../../shared/workbench-ipc.js'

/*
 * The service-override list, one import per service, and every line is here
 * because a Phase 1 proof needs it. The set is roughly preflight §8.2's tier
 * B/C — the library's own demo installs 180 packages and 286 MB of them, most of
 * which exists for serverless operation the product will not use once a remote
 * extension host is supplying the built-ins.
 *
 * `WorkbenchServiceOverride` and `ViewsServiceOverride` are mutually exclusive
 * ("never both at the same time", issue #817). This is the workbench one,
 * because the shape being tested is a whole IDE surface, not an editor.
 */

// The full workbench layout: activity bar, sidebar, editor area, panel, status bar.
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
// ⌘P / ⌘⇧P. The cheapest interaction that proves a surface is still alive after
// its sibling was destroyed, because it opens a widget the DOM can be asked about.
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
// The explorer tree, which is what makes "each surface lists its own root" visible.
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
/*
 * `initUserConfiguration` is deliberately **not** imported. It writes the user's
 * settings file wholesale, so calling it on startup discards whatever the person
 * had changed; Chorus's own preferences go in `configurationDefaults` instead.
 */
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
/*
 * Git — `BOARD.md` C-062, and it was unregistered rather than unbuilt.
 *
 * Without this the built-in Git extension loads from the REH, tries to register
 * its provider and is refused by the library with `Unsupported:
 * SCMService.registerSCMProvider is not supported`. So the product had no source
 * control at all, and the message said why in a channel nobody reads.
 *
 * Git is named in the plan's acceptance criterion and is a Phase 4 surface, so
 * this only opens the door: the source-control view has to be reached, and a
 * real repository has to appear in it, before C-062 is closed.
 */
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
/*
 * Terminals in the workbench — Phase 4 slice 4d.
 *
 * **Called with no backend, deliberately.** `getServiceOverride(backend?)`
 * registers a local backend only when one is passed; omitted, the terminal
 * service resolves a backend by *remote authority* instead, which is the REH.
 * So a terminal opened here is a process on the server that already owns the
 * project's filesystem, rather than a second shell running somewhere else with
 * its own idea of where the project is.
 *
 * **This does not retire Chorus's own terminals.** The global terminal stays a
 * real PTY in main — `CLAUDE.md` states that as a rule, and it belongs to no
 * project, so a per-project workbench has nowhere to put it. What this replaces
 * is the per-session panel.
 */
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
/*
 * Debugging — Phase 4 slice 4f, and the workbench told us it was missing.
 *
 * A running surface logged `[ms-vscode.js-debug]: View container 'debug' does
 * not exist and all views registered to it will be added to 'Explorer'`. So the
 * JavaScript debugger was already there, shipped by the REH and activating
 * normally; what it had nowhere to go. Registering the debug service is what
 * creates the container its views are written against.
 *
 * No argument, because there is no adapter to supply: `js-debug` is the adapter
 * and it lives on the server, which is also where the processes it attaches to
 * run. The plan puts JS/TS first for that reason — it is the one debugger that
 * needs nothing installed.
 */
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'
/*
 * Extensions you can actually install — Phase 5 slice 5a.
 *
 * `extensions-service-override` registers the **host** side only: the extension
 * service, the scanners, manifest properties. So the workbench ran exactly the
 * extensions the REH shipped with and offered no way to add one. This is the
 * management half — gallery, workbench extensions service, enablement,
 * recommendations, and `IExtensionManagementServerService`, which is what knows
 * to install a workspace extension on the **server** rather than in the browser.
 *
 * `webOnly` is left false: there is a server, and forcing web-only would refuse
 * exactly the Node workspace extensions §4 lists as the largest class — ESLint,
 * Docker, Tailwind and the rest.
 */
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
/*
 * The one that makes the files real.
 *
 * `scanRemoteExtensions` is on because a remote extension host that nobody scans
 * contributes nothing: the REH ships the built-ins — Git, the language basics,
 * the JS debugger — and without the scan the workbench connects to a server and
 * then behaves as though it had not.
 */
import getRemoteAgentServiceOverride from '@codingame/monaco-vscode-remote-agent-service-override'
// Side-effect imports. The theme extension contributes Dark/Light Modern, without
// which the workbench renders in unstyled defaults and "it looks broken" and "it
// is broken" become indistinguishable at the review gate.
import '@codingame/monaco-vscode-theme-defaults-default-extension'
// Registers the local extension host. Nothing in this slice activates an
// extension, but the extension service resolves a host at startup either way.
import '@codingame/monaco-vscode-extension-api/localExtensionHost'

/**
 * There is no alias, and that is a finding rather than an omission.
 *
 * Preflight §4.3 flagged this as the expensive trap: monaco-vscode-api's own
 * documentation says `monaco-editor` must resolve to
 * `@codingame/monaco-vscode-editor-api`, this repository already depends on real
 * `monaco-editor@^0.56.0` for the accepted-and-measured `MonacoDiff` Editor view,
 * and a `resolve.alias` is global to a Vite build rather than per-entry — so the
 * naive alias would swap the Monaco under the existing diff editor for
 * CodinGame's fork, in the same build, with no error.
 *
 * Read out of the installed package rather than out of the documentation, and
 * **re-read at `33.0.9` rather than carried over from `36.1.1`** — a downgrade of
 * three minor releases is exactly the change that could have reintroduced it.
 * Across every installed `@codingame/*` package there is not one bare
 * `monaco-editor` or bare `vscode` import, in a runtime `.js` file **or in a
 * `.d.ts`**. So there is no alias here and no `paths` entry either: the question
 * does not arise at build time or at typecheck time, and the shell's real
 * `monaco-editor` under `MonacoDiff` is untouched by construction rather than by
 * scoping. The demo needs the alias because it declares `"monaco-editor":
 * "file:../dist/packages/monaco-vscode-editor-api"` in its own dependencies and
 * writes `import * as monaco from 'monaco-editor'` in its own source; this file
 * imports the `@codingame/*` names directly and never writes that line.
 */

/**
 * The client's own identity, and the check that replaces forging one.
 *
 * §1.5a's correction, applied: the compiled product module hardcodes `commit`
 * above the `globalThis._VSCODE_PRODUCT_JSON` spread, and an object spread cannot
 * remove a key — so an unconfigured client presents its **true build commit**,
 * which is exactly the value the manifest wants it to present. **Omission is the
 * safe default; setting `productConfiguration.commit` is the dangerous case**,
 * because that is what lets the client assert something other than what it is.
 *
 * So Chorus sets neither, and asserts instead. Main tells this document what the
 * server's `product.json` was patched to; if the client's own compiled identity
 * disagrees, the pair is not matched and connecting would either be refused at
 * the handshake (`Client refused: version mismatch`) or — for `quality` — succeed
 * and then 404-storm with nothing naming the cause. Failing here, in a document
 * element the gate and a person can both read, is strictly better than either.
 */
function assertClientMatchesServer(connection: WorkbenchConnection): void {
  /*
   * The deprecation is read and declined, which is why this is a disable with a
   * sentence rather than a switch to `IProductService`.
   *
   * The library's own note says to prefer the service. A service resolves the
   * *effective* product configuration — the compiled module merged with whatever
   * `productConfiguration` this workbench was constructed with — and the effective
   * value is precisely what must not be trusted here: the whole point of the check
   * is that the client's **compiled build identity** matches the server, and a
   * client that had been told to claim a commit would then agree with itself. The
   * service would make this assertion pass in exactly the case it exists to catch.
   */
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above: the compiled identity is the subject, not the effective one
  const identity = product as { commit?: string; quality?: string }
  if (identity.commit !== connection.commit || identity.quality !== connection.quality) {
    throw new Error(
      `This workbench client is ${String(identity.quality)}-${String(identity.commit)}, and the server was prepared for ${connection.quality}-${connection.commit}. Refusing to connect.`
    )
  }
}

export interface WorkbenchSetup {
  readonly services: IEditorOverrideServices
  readonly options: IWorkbenchConstructionOptions
  readonly env: EnvironmentOverride
}

/*
 * Synchronous, and it became so when the user-configuration write went away.
 * `initUserConfiguration` was the only asynchronous step in here; keeping the
 * `async` afterwards would advertise a wait that no longer exists.
 */
export function prepareWorkbench(connection: WorkbenchConnection): WorkbenchSetup {
  const root = connection.projectRoot.replace(/\/+$/, '')
  assertClientMatchesServer(connection)

  /*
   * The workspace folder, on the `vscode-remote` scheme — and this one URI is the
   * whole difference between the last slice and this one.
   *
   * Before, an in-memory `RegisteredFileSystemProvider` was seeded with two
   * synthesised files whose names were built from the project-root *string*, so
   * the explorer was evidence about isolation between surfaces and evidence about
   * nothing else: not one byte had been read from disk. On this scheme every file
   * operation is answered by the remote extension host, which is a process with a
   * real filesystem under it. If the tree that appears is the tree that is
   * actually on disk, that could only have come from the server.
   */
  const folderUri = URI.from({
    scheme: 'vscode-remote',
    authority: connection.remoteAuthority,
    path: root,
  })

  /*
   * Chorus's opinions live in the **defaults layer**, and this used to write the
   * user's own settings file instead — which meant overwriting it on every start.
   *
   * `initUserConfiguration(JSON.stringify({…}))` does not merge: it replaces the
   * user configuration with a fixed object, so any preference a person changed in
   * the workbench was discarded the next time a surface opened. That is invisible
   * until someone changes something and it does not stick, and it would have made
   * `files.autoSave` un-turn-off-able for a user while looking, from this file,
   * like a setting we had left alone.
   *
   * `configurationDefaults` is the honest place for a house style. It sets the
   * default layer, which the user's own settings then override in the normal way,
   * so nothing here can outrank a decision the person made — and there is no
   * `files.autoSave` line here or anywhere else, deliberately. The web workbench
   * defaults it to `afterDelay` at 1,000 ms; Chorus keeps that native behaviour
   * rather than second-guessing it, and a person who wants `off` sets it in
   * Settings and keeps it.
   *
   * **And it now survives a quit** — E5, closed by `user-settings.ts` rather than
   * by anything here. The partition is still in-memory (no `persist:`), so the
   * browser forgets everything; what persists is the user's own `settings.json`,
   * held by main under the Chorus profile and seeded back before `initialize`.
   * Nothing in this file writes that layer, which is exactly why seeding cannot
   * destroy a preference the way `initUserConfiguration` did.
   */
  const services: IEditorOverrideServices = {
    ...getLogServiceOverride(),
    ...getExtensionServiceOverride(),
    ...getModelServiceOverride(),
    ...getNotificationServiceOverride(),
    ...getDialogsServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getPreferencesServiceOverride(),
    ...getStatusBarServiceOverride(),
    ...getTitleBarServiceOverride(),
    ...getOutputServiceOverride(),
    ...getSearchServiceOverride(),
    ...getMarkersServiceOverride(),
    ...getAccessibilityServiceOverride(),
    ...getStorageServiceOverride(),
    ...getSecretStorageServiceOverride(),
    ...getLifecycleServiceOverride(),
    ...getEnvironmentServiceOverride(),
    ...getWorkspaceTrustOverride(),
    ...getWorkingCopyServiceOverride(),
    ...getExplorerServiceOverride(),
    ...getScmServiceOverride(),
    ...getTerminalServiceOverride(),
    ...getDebugServiceOverride(),
    ...getExtensionGalleryServiceOverride(),
    ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride(),
  }

  const options: IWorkbenchConstructionOptions = {
    /*
     * Authority and token, and nothing else about the server.
     *
     * `remoteAuthority` is host and port only — no scheme and no path — because
     * the client builds `vscode-remote://<authority>/...` itself and would
     * otherwise build it out of a string that already contained one. The token
     * arrived over `connection()` and is read from nowhere else: never a query
     * string, which lands in session history and in every devtools recording
     * permanently, and never the shell.
     */
    remoteAuthority: connection.remoteAuthority,
    connectionToken: connection.connectionToken,
    /*
     * On unless main said otherwise, and the default is the safe one because the
     * field is absent in every descriptor but the gate's.
     *
     * This flag and not a configuration entry, because it is the one the client
     * actually reads: `BrowserWorkbenchEnvironmentService.disableWorkspaceTrust`
     * is defined as `!options.enableWorkspaceTrust`, and `isWorkspaceTrustEnabled()`
     * returns false the moment that is true without consulting
     * `security.workspace.trust.enabled` at all. A settings entry would be one of
     * two conditions and could be overridden by the workspace's own settings file
     * — i.e. by the very tree whose authors are in question.
     */
    enableWorkspaceTrust: connection.workspaceTrust !== 'waived',
    developmentOptions: { logLevel: LogLevel.Info },
    workspaceProvider: {
      trusted: true,
      workspace: { folderUri },
      // A surface may not open windows. `lockDownNavigation` on this view's own
      // `webContents` denies it anyway; refusing here means the workbench never
      // renders an affordance that cannot work.
      open: () => Promise.resolve(false),
    },
    configurationDefaults: {
      /*
       * One agent product, not two competing sidebars — Phase 4 slice 4g.
       *
       * The pinned client ships `contrib/chat`, `contrib/inlineChat` and
       * `contrib/inlineCompletions`, so the workbench has a whole conversational
       * AI surface of its own. Chorus **is** the agent product; a second chat
       * panel inside the editor would be a different assistant, with different
       * permissions, no share of the transcript and no idea the other exists.
       *
       * `chat.disableAIFeatures` is the master switch rather than a list of
       * views to hide: `ChatEntitlementContext` watches it and updates the
       * context keys the chat UI's `when` clauses are written against, so the
       * entrypoints never register instead of registering and being hidden.
       * Read out of `chat/common/constants.js` and its consumer, not guessed.
       *
       * A **default**, not a forced value. It sits in the defaults layer like
       * everything else here, so a person who deliberately wants VS Code's chat
       * can still turn it on in Settings and keep it — the same rule
       * `files.autoSave` follows.
       */
      'chat.disableAIFeatures': true,
      /*
       * Extensions do not update themselves — Phase 5 slice 5e.
       *
       * VS Code defaults `extensions.autoUpdate` to every extension, which is
       * right for one window on one machine and wrong here for three reasons
       * that compound:
       *
       *  - **The extensions directory is shared** (`BOARD.md` C-063). One REH
       *    serves every project, so an update fired while you are in one project
       *    silently changes every other one — including projects that are open,
       *    mid-session, with agents running against them.
       *  - **It defeats pinning.** Slice 5f pins the built-in language, Git and
       *    debug extensions to the server's own version; an auto-update walks
       *    one of them past the REH and produces exactly the client/server drift
       *    the pin exists to prevent.
       *  - **It invalidates the ledger.** `extension-ledger.md` records a result
       *    against a version — `bradlc.vscode-tailwindcss` at 0.16.0. An
       *    overnight update makes every proved row a statement about something
       *    that is no longer installed, with nothing to say it happened.
       *
       * Slice 5g wants updates to be **atomic** — client packages, REH,
       * built-ins and compatibility metadata moving together or not at all — and
       * per-extension background updates are the opposite of that.
       *
       * A default, not a forced value: `Extensions: Enable Auto Update` is still
       * there for anyone who wants it, and `Check for Extension Updates` still
       * works on demand.
       */
      'extensions.autoUpdate': false,
      /*
       * The server's own extensions may not be replaced from a registry —
       * Phase 5 slice 5f.
       *
       * The REH ships 33 built-ins and **three of them carry marketplace ids
       * that Open VSX also serves**: `ms-vscode.js-debug`, its companion, and
       * the JS profile table. The other thirty are `vscode.*` — Git, the
       * language basics — and that namespace is not on Open VSX, so nothing can
       * shadow them. These three can be, and one of them is the debugger.
       *
       * Installing `ms-vscode.js-debug` from Open VSX would put a registry copy
       * beside the server's, at a version chosen by neither: the built-in is
       * versioned with the REH (`1.121.03429`) and Open VSX carries `1.117.0`.
       * A debugger from one build talking to an extension host from another is
       * the client/server drift §2.3 refuses everywhere else, arriving through
       * the one door left open.
       *
       * `"*": true` keeps everything else installable — this is a pin on three
       * ids, not an allowlist regime. Checked against the evaluator rather than
       * assumed: `allowedExtensionsService.js:82` treats a boolean value as
       * allow/deny directly, and the key is lowercased before lookup.
       */
      'extensions.allowed': {
        '*': true,
        'ms-vscode.js-debug': false,
        'ms-vscode.js-debug-companion': false,
        'ms-vscode.vscode-js-profile-table': false,
      },
      'extensions.autoCheckUpdates': true,
      /*
       * Inline completions are the other entrypoint and are not covered by the
       * switch above: they are an editor feature rather than a chat view, and
       * they would be a second model writing into the same buffer an agent is
       * editing.
       */
      'editor.inlineSuggest.enabled': false,
      'window.title': '${rootName}',
      'workbench.colorTheme': 'Default Dark Modern',
      'editor.minimap.enabled': false,
      'workbench.startupEditor': 'none',
      'telemetry.telemetryLevel': 'off',
    },
    defaultLayout: {
      /*
       * No editor is opened for you, and that is deliberate now rather than an
       * omission. The last slice could name a file because it had invented one;
       * this one must not guess at a path inside somebody's real repository, and
       * a `defaultLayout` naming a file that does not exist is a startup error
       * rather than an empty pane. What opens a file here is a person, or the
       * gate driving quick open — which is itself the sharper proof, because a
       * quick-open list is the project's real filenames.
       */
      force: true,
    },
    productConfiguration: {
      nameShort: 'Chorus',
      nameLong: 'Chorus Workbench',
      /*
       * Open VSX, and it is a licence decision before it is a product one.
       *
       * The Microsoft Marketplace's terms permit its use only from Microsoft's
       * own products, which Chorus is not — the same reason §3.1 refuses to ship
       * Microsoft's REH. Open VSX is the registry VSCodium uses.
       *
       * **Copied from the server's own `product.json`, not composed here.** The
       * unpacked REH already carries a gallery configuration, because VSCodium
       * ships one, and client and server must agree about where an extension came
       * from — a workspace extension is downloaded and installed by the *server*,
       * so a client pointing somewhere else would list one registry and install
       * from another.
       *
       * A first draft of this guessed `resourceUrlTemplate` and an
       * `extensionUrlTemplate` from memory. The server sets neither: it has
       * `itemUrl` and `latestUrlTemplate` instead. `resourceUrlTemplate` is left
       * empty rather than invented — it is the web host's asset path, only
       * Draw.io among the surveyed extensions lands in the web host (§4), and an
       * asserted URL that is wrong fails as a network error rather than as
       * configuration.
       */
      extensionsGallery: {
        serviceUrl: 'https://open-vsx.org/vscode/gallery',
        controlUrl:
          'https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json',
        extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
        resourceUrlTemplate: '',
        nlsBaseUrl: '',
      },
      /*
       * `commit` and `quality` are deliberately absent — see
       * `assertClientMatchesServer`. Setting them is the only way this client can
       * claim to be something it is not, and the compiled module already carries
       * the true values.
       */
    },
  }

  // Otherwise VS Code infers the home directory from the first workspace folder,
  // which makes the search view describe a tree that is not the one on screen.
  const env: EnvironmentOverride = { userHome: URI.file('/') }

  return { services, options, env }
}
