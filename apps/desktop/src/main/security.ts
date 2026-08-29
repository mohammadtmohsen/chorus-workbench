import { shell, type Session, type WebContents } from 'electron'
import { isSafeHref } from '../shared/markdown.js'

/**
 * Chorus renders untrusted model output. Without these, an injection in an
 * agent message escalates from "weird text" to remote code execution, so none
 * of it is optional (plan §4.4).
 */

const BASE_CSP = [
  "default-src 'none'",
  // Vite injects styles at runtime; scripts stay strict, which is what matters.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
]

const PRODUCTION_CSP = [...BASE_CSP, "script-src 'self'", "connect-src 'self'"].join('; ')

/**
 * Dev only. React Fast Refresh injects an inline preamble script and talks to
 * the Vite dev server over a websocket, both of which the production policy
 * correctly refuses. Shipping this to users would defeat the point, so it is
 * selected by the dev-server URL rather than by a build flag that could drift.
 */
const DEVELOPMENT_CSP = [
  ...BASE_CSP,
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
].join('; ')

export function applyContentSecurityPolicy(session: Session, isDev: boolean): void {
  const policy = isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })

  // No renderer of ours has any business asking for the camera, mic, or geo.
  session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}

/**
 * The workbench's own policy, on the workbench's own session — a second policy,
 * not a wider one (preflight §5.2).
 *
 * The shell's `default-src 'none'` is what an embedded workbench cannot run
 * under, and the failure everything here is arranged against is that somebody
 * relaxes it *as a block* to make the workbench work. Because the workbench lives
 * on its own `chorus-workbench` partition, none of `PRODUCTION_CSP` moves: this
 * is a separate document under a separate policy that the shell never sees.
 *
 * The relocated risk is the opposite one, and it is quieter. A fresh partition
 * starts with **no** CSP and **no** permission handler at all, so every directive
 * below is here because it had to be installed deliberately rather than because
 * it was loosened. An absent control is not a relaxed control; it is a dead one.
 *
 * Each line names what needs it:
 *
 *  - `script-src 'self' 'unsafe-eval'` — VS Code compiles regexes and evaluates
 *    generated code in its own runtime, and its workers are built from the
 *    bundle. `'self'` is still the only *origin*; no remote script is admissible.
 *  - `worker-src`/`child-src` with `blob:` — the textmate, language-detection and
 *    editor workers are started from blob URLs by the bundler's worker plumbing.
 *  - `style-src 'unsafe-inline'` — VS Code writes theme colours into inline style
 *    attributes on nearly every element it draws. There is no version of the
 *    workbench that runs without this.
 *  - `connect-src 'self' data: blob:` plus **exactly** `ws://<authority>` and
 *    `http://<authority>` for the one remote extension host Chorus spawned, with
 *    the port substituted at spawn time. Never a `127.0.0.1:*` wildcard: the
 *    port is ephemeral, so a wildcard is the tempting shortcut, and it would let
 *    *any* local server be reached from a renderer that runs third-party
 *    extension code. The narrow form is possible only because main reads the port
 *    back out of the child it started, which is the same fact that makes
 *    "never attach to a port Chorus did not open" enforceable.
 *  - `frame-ancestors 'none'` — nothing frames the workbench either. A workbench
 *    document that permitted framing is one an extension webview could try to
 *    frame.
 */
const WORKBENCH_BASE_CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  /*
   * `https://open-vsx.org` here and in `connect-src` — the one host this
   * workbench may reach beyond its own server, and it is the gallery it is
   * already configured to install from.
   *
   * Without it the Extensions view can search and install and cannot *show* what
   * it is offering: the details pane renders "Failed to fetch" and every icon is
   * blank, because installing happens on the REH while the README and the icons
   * are fetched by this renderer. Reported as "failed to fetch" against an
   * extension that had in fact installed.
   *
   * **Two hosts, and the second is not optional.** Every asset URL Open VSX
   * returns — README, licence, icon — is on `open-vsx.org/api/...` and
   * **302-redirects to `openvsx.eclipsecontent.org`**, Eclipse's content CDN. A
   * CSP applies to the redirect target, so allowing only the first host leaves
   * the pane failing exactly as it did before, which is what happened: the
   * gallery origin was added, the error did not change, and the redirect was
   * only visible by following the request rather than reading the config.
   *
   * Narrowly, and the narrowness is the point the paragraph above makes: this
   * renderer runs third-party extension code, so each origin added is one that
   * code can reach. These two buy nothing new in practice — an extension already
   * talks to Open VSX through the extension host — which is what makes them the
   * only widening worth making.
   */
  "img-src 'self' data: blob: https://open-vsx.org https://openvsx.eclipsecontent.org",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
]

/**
 * The one remote extension host this session may reach, as two origins.
 *
 * Built from the authority main read out of the child's own stdout, so the
 * policy and the server cannot drift: there is no second place the port is
 * written down. An authority that is not `host:port` is refused rather than
 * interpolated, because a policy assembled from an unvalidated string is a policy
 * whose meaning depends on what was in the string.
 */
function remoteConnectSources(remoteAuthority: string | null): string {
  if (remoteAuthority === null) return ''
  if (!/^[A-Za-z0-9.\-[\]:]+:\d+$/.test(remoteAuthority)) {
    throw new Error(`Not a usable workbench remote authority: ${remoteAuthority}`)
  }
  return ` ws://${remoteAuthority} http://${remoteAuthority}`
}

/**
 * Exported for its test, which is the point rather than a convenience: this
 * string is a security boundary, and it now contains a deliberate widening. A
 * test that names every origin is how the next widening has to be deliberate too.
 */
export function workbenchPolicy(isDev: boolean, remoteAuthority: string | null): string {
  const remote = remoteConnectSources(remoteAuthority)
  return [
    ...WORKBENCH_BASE_CSP,
    isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"
      : "script-src 'self' 'unsafe-eval' blob:",
    `connect-src 'self' data: blob: https://open-vsx.org https://openvsx.eclipsecontent.org${remote}${isDev ? ' ws://localhost:* http://localhost:*' : ''}`,
  ].join('; ')
}

/**
 * Is this the REH's own resource endpoint, on the server Chorus started.
 *
 * **The path carries the product segment**, and a first version of this did not
 * — so the branch it guards was unreachable and the fix it enabled did nothing
 * at all, while the screenshot stayed identical. The client builds
 * `/${quality}-${commit}/vscode-remote-resource`: `network.js`'s
 * `getServerProductSegment` returns `${product.quality}-${product.commit}` and
 * joins it in front. `workbench-ipc.ts` already documents that prefix, in the
 * paragraph explaining why a `quality` mismatch 404-storms rather than failing
 * loudly.
 *
 * Compared exactly rather than with `endsWith`, which is the point of threading
 * the identity here at all: both values are already in `WorkbenchRuntime`, so
 * there is no reason to accept a path that merely finishes the right way. This
 * runs in a session that executes third-party extension code.
 */
export function isOwnRemoteResource(
  url: string,
  remoteAuthority: string | null,
  product: { readonly quality: string; readonly commit: string } | null
): boolean {
  if (remoteAuthority === null || product === null) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.origin === `http://${remoteAuthority}` &&
    parsed.pathname === `/${product.quality}-${product.commit}/vscode-remote-resource`
  )
}

export function applyWorkbenchContentSecurityPolicy(
  session: Session,
  isDev: boolean,
  remoteAuthority: string | null,
  /** The server's identity, which its resource path is prefixed with. */
  product: { readonly quality: string; readonly commit: string } | null
): void {
  const policy = workbenchPolicy(isDev, remoteAuthority)

  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {
      ...details.responseHeaders,
      'Content-Security-Policy': [policy],
    }

    /*
     * The one response Chorus adds a CORS header to, and why it has to.
     *
     * An installed theme lives on the remote extension host, so applying it ends
     * in `FileIconThemeLoader -> readExtensionResource ->
     * http://<authority>/vscode-remote-resource`. VS Code's server sends
     * `Access-Control-Allow-Origin` only when the request's origin matches
     * `product.webEndpointUrlTemplate`, and VSCodium's bundled product defines
     * no such template — so no origin ever matches, the browser refuses the
     * response, and it surfaces as a bare "Failed to fetch" toast naming nothing.
     *
     * **Scoped to one origin and one path**, both compared exactly: the origin is
     * the server Chorus itself spawned and read the port back from, and the path
     * is the single resource endpoint. Not a prefix, not a subtree — the same
     * narrowness the CSP above is written for, because this session runs
     * third-party extension code.
     *
     * `*` is defensible *here* rather than in general: the endpoint is
     * authenticated by the connection token, which nothing without it can
     * supply, and CORS forbids `*` together with credentials. What it grants is
     * the ability to *read* a response somebody was already entitled to request.
     *
     * Existing spellings are dropped rather than appended to: two
     * `Access-Control-Allow-Origin` headers are treated as none.
     */
    if (!isOwnRemoteResource(details.url, remoteAuthority, product)) {
      callback({ responseHeaders })
      return
    }

    /*
     * Rebuilt without any existing spelling rather than deleting keys: header
     * names are case-insensitive, so a server-sent `access-control-allow-origin`
     * beside ours would be two values for one header, which browsers treat as
     * none.
     */
    const withCors = Object.fromEntries(
      Object.entries(responseHeaders).filter(
        ([name]) => name.toLowerCase() !== 'access-control-allow-origin'
      )
    )
    callback({
      responseHeaders: { ...withCors, 'Access-Control-Allow-Origin': ['*'] },
    })
  })

  /*
   * Set, not inherited. `setPermissionRequestHandler` is a session method, so
   * the shell's `callback(false)` covers `session.defaultSession` and nothing
   * else — leaving this partition without one means every request is answered by
   * Electron's defaults instead. Denied stays denied in Phase 1: a denial is a
   * legible failure, a blanket grant is an invisible one, and an absent handler
   * is invisible twice over.
   */
  session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
}

/**
 * The one address a `WebContents` is allowed to hold, reduced to the three parts
 * that decide which document loads.
 *
 * `null` for anything unparseable **and for anything carrying a query string**.
 * No entry Chorus loads has one, and on the dev server the query is the one part
 * of a URL that reaches the network — so admitting it would be admitting a
 * channel rather than a document. The fragment is ignored instead of refused,
 * and the difference is read out of Electron's own typings rather than guessed:
 * `will-navigate` "is also not emitted for in-page navigations, such as clicking
 * anchor links or updating the `window.location.hash`", so a hash can only reach
 * here attached to a real cross-document load of the same entry.
 */
function entryKey(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.search !== '') return null
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/**
 * The renderer must never navigate away from our own bundle, and must never
 * open a window itself. External links go to the OS browser instead.
 *
 * **`allowedEntries` is an exact allowlist, and it replaced a prefix test that
 * was not a boundary at all.** The rule used to be "starts with `file://`, or
 * starts with the dev server's URL", and both halves fail:
 *
 *  - Under `file://` **every document on the disk qualifies** — including the
 *    shell's own `index.html`. A workbench surface runs third-party extension
 *    code by design, so that admitted the one navigation that matters: a surface
 *    walking itself onto the shell's entry, in a `WebContents` the shell's own
 *    preload was never meant to meet.
 *  - A prefix over an origin is not even a same-origin test. `http://localhost:5173`
 *    is a prefix of `http://localhost:51739.evil.example/`, so a host that merely
 *    *starts* the same passes.
 *
 * Callers derive the list from the very value they load, so the allowlist and
 * the document cannot drift — the failure `security.ts` already records once, in
 * the window-open handler below, where two allowlists over one decision drifted
 * and the drift showed up as a dead control rather than an error.
 *
 * A malformed entry throws here rather than being skipped: a list with a silent
 * hole in it is the same dead control one level further out.
 *
 * Takes a `WebContents` rather than a `BrowserWindow` because a `WebContentsView`
 * has no window of its own and inherits none of this: its `webContents` is a
 * different object, and every listener below binds to one object. Left unbound on
 * a workbench view, `will-attach-webview` in particular is not relaxed — it is
 * simply absent, which is the dead-control failure the comment further down
 * already records once.
 */
export function lockDownNavigation(contents: WebContents, allowedEntries: readonly string[]): void {
  const allowed = new Set<string>()
  for (const entry of allowedEntries) {
    const key = entryKey(entry)
    if (key === null) throw new Error(`Not a usable navigation entry: ${entry}`)
    allowed.add(key)
  }

  contents.on('will-navigate', (event, url) => {
    const key = entryKey(url)
    if (key === null || !allowed.has(key)) event.preventDefault()
  })

  /*
   * The renderer's own allowlist, not a second one.
   *
   * This used to read `url.startsWith('https://')`, which is narrower than what
   * `MarkdownView` is willing to draw as a link — `isSafeHref` admits `http:`
   * and `mailto:` too. The gap was silent by construction: the transcript
   * rendered an underlined, coloured link, the click reached here, and `deny`
   * ended it with nothing on screen to say why. Measured before it was fixed, a
   * plain-`http` link opened zero connections while an `https` one opened four.
   *
   * Sharing the predicate is the point rather than adding two schemes. Two
   * allowlists over the same decision drift, and the drift shows up as a dead
   * control rather than as an error.
   *
   * The scheme was never the protection anyway — a model can write `https://`
   * as easily as `http://`. What protects the app is that this hands the URL to
   * the OS browser and denies the window, which is unchanged.
   */
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeHref(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // A webview tag would reintroduce everything we just disabled.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
