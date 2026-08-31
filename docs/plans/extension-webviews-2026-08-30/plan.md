# Extension webviews and custom file viewers, and the origin the workbench does not have

## The problem, and the thing it is not

Three concrete readers are blank in Chorus while their surrounding editor tab
and breadcrumb mount normally:

- the built-in Markdown preview;
- `adamraichu.pdf-viewer` 1.1.2, contributing the
  `pdfViewer.PDFEdit` custom editor for PDF files; and
- `ShahiowlKumar.docxreader` 1.4.2, contributing the
  `docxreader.docxEditor` custom editor for DOCX files.

The same extensions and files render in VS Code. The shared symptom is an empty
editor body and no error a person can see. That makes the webview envelope the
first common suspect, but it does not prove that every viewer-specific stage is
healthy. This plan treats the three readers as a diagnostic matrix and requires
all three to pass; it does not call the PDF and DOCX failures fixed merely because
Markdown starts rendering.

**The obvious diagnosis is wrong, and it was made and retracted on 2026-08-30.**
`monaco-vscode-api`'s `missing-services.js` contains a `WebviewService` whose
`createWebviewElement` and `createWebviewOverlay` are `unsupported` and throw, so
the first reading is that Chorus never registered a real one. It did.
`view-common-service-override` arrives transitively through
`getWorkbenchServiceOverride()`, which `services.ts` already spreads, and the
app's overrides are applied over `registerSingleton` fallbacks — so the real
`WebviewService` wins. There is no missing registration, no package to add, and
adding one would only create the duplicate-key hazard `services.ts` already
documents for storage.

The record matters because the wrong fix is cheap and looks right. Anyone
arriving at this file from the stub will want to add
`@codingame/monaco-vscode-view-common-service-override` to `apps/desktop`. Do
not. It is already there.

The two installed viewers are useful witnesses because they reach the shared
webview through different paths. The PDF viewer reads the file with
`workspace.fs`, converts it to base64, rewrites its bundled JavaScript, CSS and
PDF worker through `webview.asWebviewUri`, then sends the document into the
webview with `postMessage`. The DOCX reader converts the remote document with
Mammoth in the extension host, then assigns generated HTML containing inline CSS
and JavaScript to the custom editor. Its loading and error states are HTML too.
A completely blank body in both therefore points below their file renderers, but
the PDF still exercises resource rewriting, a worker and messaging after the
common bootstrap, while DOCX exercises remote-file conversion and generated
inline content. Those later stages need separate observations once the shell is
alive.

## What actually stops it

Three things, and the ordering is the point: each one hides the next.

**One — the bootstrap is inline script.** A webview is a nested pair of iframes;
the outer one loads a bundled `pre/index.html` whose entire bootstrap is a single
inline `<script type="module">`. Production's policy is
`script-src 'self' 'unsafe-eval' blob:` with no `'unsafe-inline'` and no hash, so
that script never runs. Dev's policy _does_ carry `'unsafe-inline'`. **A webview
therefore behaves differently in `pnpm dev` and in a packaged build, and dev is
the permissive one.**

**Two — extension resources are on a host nothing allows.** Inside a webview,
`asWebviewUri` rewrites every stylesheet, script, image and worker resource to
`https://<encoded-authority>.vscode-resource.vscode-cdn.net/…`. That host appears
in no directive of the workbench policy, so Markdown preview's own CSS and JS,
and the PDF viewer's scripts, styles and PDF worker, are refused even once the
bootstrap runs.

**Three — and this is the one that decides the shape — production runs on
`file://`.** Those `vscode-cdn.net` URLs are not really fetched; a **service
worker** registered by the bootstrap intercepts them and answers over
`postMessage`. Chromium does not expose service workers on a `file:` origin, so
`navigator.serviceWorker` is undefined, the bootstrap gives up, and the pane is
blank. `workbench-surface.ts` loads production via `loadFile`, i.e. `file://`.
Dev loads `http://localhost:<port>`, which is a secure context, where all of this
works.

The exception proves it. The Extensions view's README pane is the one webview
that renders today, and it is the one that sets `disableServiceWorker: true` —
because it needs no `vscode-resource` URIs at all.

So: **the workbench surface needs a real origin.** Not a CDN, not a second
domain, not `webviewExternalEndpoint` — this fork already patched the iframe
`src` to a same-origin bundled asset, and `webviewContentEndpoint` is dead code
in this build. What is missing is that `file://` is not an origin a service
worker will live on.

## The shape of the answer

A privileged custom scheme, registered `standard: true, secure: true,
supportFetchAPI: true`, serving `out/renderer` from main via `protocol.handle`.
The workbench surface then loads `chorus-workbench://workbench/workbench.html`
instead of a file path, and is a secure context with a stable origin.

That is a bigger change than it sounds, because `file://` is currently woven
through the surface's security story. Everything that says "this document is
allowed to be here" is expressed in terms of the entry URL:

- `entryKey` parses the entry and refuses anything with a query string.
- `lockDownNavigation` allowlists the entry and denies every other navigation.
- Every CSP directive's `'self'` resolves against the entry's origin.
- `applyWorkbenchContentSecurityPolicy` _decorates_ response headers, which a
  protocol handler must instead **synthesise**, because there are none to
  decorate.

None of those are hard individually. What makes this multi-day rather than
half-day is that they must all move together and be re-proved in a packaged
build, which is the environment none of the fast feedback loops cover.

## Phases

**Phase 1 — prove the premise at runtime, before writing anything.** Resolve
`IWebviewService` in a running workbench and confirm the constructor is the real
`WebviewService` rather than the stub. The static evidence is strong and the cost
of being wrong is every phase below. In `pnpm dev`, open known-good representative
Markdown, PDF and DOCX files with the three readers named above. Capture the
workbench console, webview console and remote extension-host errors separately.
Confirm that each custom-editor provider resolves, and determine whether the DOCX
reader reaches its loading HTML, conversion, generated HTML or error HTML. Dev is
where the service worker can register, so this environment isolates the CSP
problem from the production-origin problem without collapsing three potentially
different later failures into one.

Exit: the winning `IWebviewService` class and an observed stage/error matrix for
Markdown, PDF and DOCX are recorded. No implementation starts before this point.

**Phase 2 — the sub-frame policy.** `applyWorkbenchContentSecurityPolicy` already
branches per response; add a branch matching `resourceType === 'subFrame'` and an
exact match on the two bundled webview documents, serving those a _second_
policy that allows `'unsafe-inline'` script and `https://*.vscode-cdn.net` for
script, style, img, font, media and connect.

**The `'unsafe-inline'` must not reach the workbench document.** Extension webview
content is inline script by construction, so allowing it inside the webview is
unavoidable; widening `workbenchPolicy`'s own return value to get there is the
regression the preflight names explicitly. Two policies, and a test that names
every origin in each — the discipline `security.test.ts` already applies.

Exit: Markdown preview, `adamraichu.pdf-viewer` and
`ShahiowlKumar.docxreader` all render in `pnpm dev`. Success means actual Markdown
markup, PDF page content and DOCX document text — not merely a tab, toolbar,
loading indicator or nonblank iframe. If Markdown works while either custom
editor does not, stop and follow the failing branch from Phase 1 rather than
widening the CSP generically.

**Phase 3 — the scheme.** Register the privileged scheme, serve `out/renderer`
through `protocol.handle`, and switch the production entry off `loadFile`. Carry
the origin change through `entryKey`, `lockDownNavigation`'s allowlist, `'self'`
in the base policy, and header synthesis. Dev keeps `http://localhost` — two
entry shapes, as today.

Exit: all three representative readers render in a **packaged** build. Not
`pnpm dev`. Exercise more than first paint: change PDF pages so the worker and
message path are proven, and scroll/search the DOCX output so generated content
is proven rather than a static loading shell.

**Phase 4 — the navigation lock, made explicit.** `lockDownNavigation` binds
`will-navigate`, which fires for the top frame only; the webview iframe's
navigation is currently unexamined rather than allowed. Bind
`will-frame-navigate` and make the webview's own document an explicit allow. This
is separable and should not gate Phase 3, but it should not be forgotten either:
right now the iframe's query-bearing URL would have been refused by `entryKey`'s
own rule if that rule had ever been applied to it.

## What this deliberately does not do

**No second origin for webviews.** Upstream isolates webview content from the
workbench by serving `pre/` from a different domain, and
`getWorkbenchServiceOverride` accepts a `webviewIframeAlternateDomains` argument
that would do it. That means serving three files over HTTP from another origin,
plus `frame-src` for it, plus a `frame-ancestors` relaxation. It buys isolation
between extension HTML and the workbench document — real, but it is a second
piece of infrastructure on top of the one this plan already introduces, and the
same-origin path is what this build is patched for.

**No notebooks.** `view-common` covers views, editors, custom editors and
webviews; notebooks are a separate override and a separate decision.

**No Chorus-owned PDF or DOCX renderer.** This restores the platform contract
used by the installed extensions; it does not copy their rendering logic into
Chorus, promise document editing, or turn DOCX/ODT conversion into a built-in
feature. PDF and DOCX remain read-only, extension-owned viewers. Although the
DOCX extension also declares ODT support, ODT is outside this plan until it is
reported and given its own representative file.

**No claim that every extension webview is now fixed.** These three readers are a
representative acceptance matrix, not proof over every extension. They cover the
common bootstrap plus rewritten resources, worker loading, extension-to-webview
messaging and generated inline HTML. Any other extension may still expose a
different missing contract.

**No clipboard inside webviews.** `setPermissionCheckHandler` denies
`clipboard-read`/`clipboard-write`, so copy buttons in a webview will silently do
nothing. That is the existing posture and widening it is its own argument, not a
consequence of this one.

## Open questions and risks

**The failure mode is designed to mislead.** It will work in dev and be blank in
production, twice, for two unrelated reasons — first the inline bootstrap, then
the service worker. Both are invisible to `pnpm dev`. If only Phase 2 ships,
everyone involved will believe the feature is finished. Phase 3's exit criterion
is a packaged build for exactly this reason.

**A privileged scheme is a security surface.** `standard: true, secure: true`
grants the origin the powers a real origin has, and `supportFetchAPI: true` lets
content fetch through it. The handler must serve `out/renderer` and nothing else,
and must not resolve paths that escape it. This is the same
`resolveWithinRoot` discipline main already applies to project files, in a new
place where getting it wrong is worse.

**An unresolved upstream defect sits next to this.** The preflight records
sustained bidirectional webview↔remote-extension messaging stalling after the
first round trip — `anthropic.claude-code` working, `openai.chatgpt` failing.
The PDF viewer explicitly sends the base64 document and worker URI through the
webview message path, so it is now an acceptance test for more than CSP and
origin. If its shell renders but remains loading or page changes fail, investigate
the messaging/worker branch as a separate platform defect; do not weaken the
Phase 2 or Phase 3 exit to exclude it. The DOCX reader can similarly reveal a
remote-file or Mammoth conversion defect once its loading/error HTML becomes
visible. This plan scopes those diagnoses but does not assume one origin change
repairs them automatically.

**Is it worth it?** Stated honestly, because the answer is not obvious. What this
buys immediately is Markdown preview plus the installed PDF and DOCX readers,
and more generally the class of extension-drawn UI. What it costs is a new URL
scheme in the most security-sensitive part of the app, and a permanent second
CSP policy. A reader who concludes the trade is bad should say so in `STATUS.md`
rather than starting Phase 3 — the finding in this document is worth keeping
either way.
