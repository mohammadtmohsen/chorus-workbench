# Status

## Phase 1 and 2 — done. Phase 3 is refuted and should be deleted. (2026-08-30)

**Markdown preview and the DOCX reader render. The PDF viewer does not.** The
whole feature turned out to be four CSP additions, not the new URL scheme this
plan budgeted multiple days for.

### What actually stopped it

**One directive, applied one document too broadly.** `frame-ancestors 'none'` is
in `WORKBENCH_BASE_CSP`, and `onHeadersReceived` applies that policy to every
response in the session — including the webview's own bootstrap document:

```
electron: Failed to load URL: file:///…/out/renderer/assets/index-D5H5KsJm.html
  ?…&serviceWorkerUri=file%3A%2F%2F%2F…&fakeHtmlUri=file%3A%2F%2F%2F…
  with error: ERR_BLOCKED_BY_RESPONSE
```

The frame never loaded, so **none of the three causes in `plan.md` had ever been
reached**. Not the inline bootstrap, not `vscode-cdn.net`, not the service
worker. Every one of them was reasoned from the outside while the actual failure
was one directive earlier.

Once the frame loaded, the remaining blockers appeared one at a time and each was
read out of the frame's own console:

1. `https://*.vscode-cdn.net` for script, style, img, font and connect — the host
   `asWebviewUri` rewrites to. CSP is applied _before_ the service worker is
   consulted, so a refused request never reaches the worker that would have
   answered it.
2. `base-uri` for that host — a preview sets its base URI to the document it is
   rendering.
3. `'unsafe-inline'` for script. The narrow design — admit only the bundled
   bootstrap by `sha256-2bgY7b4A…` — was implemented first and **failed
   measurement**: the console showed inline scripts refused against that exact
   hash on every preview, because the inner frame is written with
   extension-authored HTML and a hash can only name scripts we ship.
4. `worker-src` for that host. It does not fall back to `script-src`, which is
   why the PDF viewer rendered its own loading HTML and then stopped while
   Markdown preview worked.

### Phase 3 is refuted — delete it

Measured **in the webview frame**, which is the frame that matters:

| fact                                         | observed                 |
| -------------------------------------------- | ------------------------ |
| `window.isSecureContext`                     | `true`                   |
| `navigator.serviceWorker.getRegistrations()` | `count=1`                |
| `navigator.serviceWorker.controller`         | `[object ServiceWorker]` |

**Service workers register and control on `file://` in Electron.** There is no
need for a privileged `chorus-workbench://` scheme, and none of the ripple
through `entryKey`, `lockDownNavigation`, `'self'` or header synthesis. The
plan's most expensive phase was reasoned from browser behaviour that does not
apply here.

`plan.md` should be corrected rather than left standing: Phase 3 deleted, and the
three causes rewritten as one cause plus four measured directives.

### The method note is the durable lesson

Four separate conclusions in this investigation were wrong, and every one was
reached by reasoning from a symptom instead of measuring the thing itself:

- `IWebviewService` is stubbed → it is not; the real one wins.
- Service workers are unavailable on `file:` → they are available and working.
- The bootstrap hash is sufficient → extension content carries its own inline
  scripts.
- The workspace-id pinning regressed → it works; the id count rose because a new
  stable set was created alongside the old ones.

The one thing that worked every time was reading the app's own stderr and the
frame's console. The single most productive line of the day was
`ERR_BLOCKED_BY_RESPONSE`, which appeared in a terminal and had been invisible to
three CDP probes.

## Still open

**The PDF viewer renders blank**, after the association was resolved (a stale
`editorOverrideService.cache` had no `*.pdf`, so the resolver went straight to the
text editor). Once opened with the custom editor it is blank. Not diagnosed —
this needs the frame console, and no further guesses should be made without it.

**Durable storage makes VS Code's caches durable too.** That
`editorOverrideService.cache` used to be rebuilt every launch because storage did
not survive; it now persists, and what persisted was built while webviews were
broken. This will recur in forms that look like unrelated bugs, and is worth a
board entry rather than a note here.

**Orphaned workspace scopes.** 35 pre-fix scopes keyed by the old
port-derived identity remain in `storage.json`. Inert, but garbage.
