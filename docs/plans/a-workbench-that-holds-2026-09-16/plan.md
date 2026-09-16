# A workbench that holds

## Status

| Phase                                 | Status                 | Commit               | Notes                                                                                                          |
| ------------------------------------- | ---------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| 0 — Research                          | ✅ done                | —                    | Three agents, read-only. Findings below.                                                                       |
| 1 — The port in the name              | ⏸️ parked 2026-09-16   | —                    | Its premise was already fixed by `workspaceIdFor`, and the residual is not observable.                         |
| 2 — A workbench that is not throttled | ✅ verified 2026-09-16 | `1de72c0`            | Measured before and after. `detached` went from `hidden` to `visible`, and no `visibilitychange` fires at all. |
| 3 — Focus, honestly                   | ✅ verified 2026-09-16 | `1867518`, `2f07d03` | Measured with the workaround disabled: SCM refreshed with focus in the chat. `scm-refresh.ts` removed.         |
| 4 — Extensions per workspace          | ⬜ not started         | —                    | Closes C-063 with upstream machinery.                                                                          |
| 5 — Remote over SSH                   | ⬜ not started         | —                    | No resolver. One authority, pointed elsewhere.                                                                 |
| 6 — `33.0.9` → `36.2.7`               | ⬜ not started         | —                    | Table stakes, not a fix. Its own migration.                                                                    |

Meta: written 2026-09-16, after a research round by `claude`, `codex` and `deepseek`.
Nothing was run and nothing was changed. Every claim below is either a citation or
is marked unverified.

## 0. Why, and what we were wrong about

The report was that the editor is not stable: source control fails in all four
ways at once — empty, stale, inert, and dying after a while — and the terminal,
extensions, explorer and search are unreliable too. Remote SSH does not work at
all.

Four symptoms across four surfaces is not four bugs. Every one of those surfaces
is remote, so the first question is what they share, and the answer is the
connection to the remote extension host.

**The first hypothesis was wrong and is recorded because the correction is the
useful part.** Restricted Mode was the obvious candidate: the authority carries
an ephemeral port, so workspace identity changes on every launch, so workspace
trust is re-asked, and `microsoft/vscode#184810` is titled "Git SCM is disabled
in restricted mode". It is a clean story and it is false here.
`services.ts:588` already sets `enableWorkspaceTrust: false`, which is the
embedder switch documented in `IWorkbenchConstructionOptions` and is stronger
than the `security.workspace.trust.enabled` setting. Trust cannot be the shared
cause because trust is already off.

What is true is narrower. The authority churn is real, and
`remote-authority.ts` already documents it: `--port 0` means a different
`vscode-remote://` authority every launch, so every launch mints a fresh
workspace identity and abandons the last one. Measured, not assumed — that file
records brute-forcing the port space and matching all 35 `workspace:*` scopes to
seven launches of five projects. The cost is storage identity, not trust.

The actual shared cause is one level down, and `workbench-host.ts:44` already
names it under the heading _What the lease cannot do, stated because it is the
load-bearing unknown_: the refcount lease keeps a **process** alive, but it does
not hold a **socket** open, because the client connections belong to the
surface's `WebContents` and go when it does.

Research since has made that much sharper. The reconnection token is
`generateUuid()`, minted per connection inside the renderer realm
(`remoteAgentConnection.js:370`), and the server keys both
`_managementConnections` and `_extHostConnections` on it
(`remoteExtensionHostAgentServer.ts:473-510`). Nothing in
`IWorkbenchConstructionOptions` can supply one. So a realm that dies presents a
new token, is treated as a fresh connection, and gets a new extension host.
**A reload is never a reconnection**, and `--reconnection-grace-time` only bounds
how long the abandoned host lingers.

## The shape of the answer

Three of the six phases are cheap and documented. One is architectural and needs
a decision. One is blocked on a measurement that already has a probe written for
it. One is a migration that fixes nothing and has to happen anyway.

The ordering below is by cost-to-benefit, not by severity.

## Phase 1 — The port in the name

**⏸️ Parked on 2026-09-16, before a line was written, because the premise did not
survive being checked.** Everything below is kept because the design work is
sound and the reasons it was parked are worth more than the phase was.

**Its stated motivation is obsolete, and the plan was quoting a measurement its
own later fix had already answered.** "Every launch mints a fresh workspace
identity" was true when `remote-authority.ts` recorded it. It is not true now:
`workspaceIdFor(root)` is wired at `services.ts:644`, which is exactly the fix
that measurement produced, and the session partition is the constant
`WORKBENCH_PARTITION` (`workbench-surface.ts:108`). Both mechanisms that could
churn identity are already port-independent.

**The one residual, and it is not observable.** `folderUri` on the same line is
a `vscode-remote://` URI and does carry the port, so anything stored _inside_
the now-stable bucket that names a resource — restored tabs, breakpoints,
recently-opened — points at last launch's authority. Checked with the user on
2026-09-16: **tabs restore correctly across launches.** So the mechanism is real
and produces no symptom.

**What would revive this phase.** A reported symptom that survives
`workspaceIdFor` — editor state that does not restore, a breakpoint that will
not rebind, an extension whose `workspaceState` resets. Without one, this is a
phase without a problem.

**Two findings worth keeping if it ever does revive.** First, do not use a plain
`--port <n>`: `parsePort` (`src/server-main.ts:173-174`) returns the integer
verbatim, and on `EADDRINUSE` `handleServerError`
(`remoteExtensionHostAgentServer.ts:223-226`) only logs — no fallback and no
exit, so the child stays alive and silent and the failure costs the full 60s
timeout at `workbench-host.ts:1175`. Use **`--port <n>-<n>`**, a one-element
range: `findFreePort` (`server-main.ts:207-224`) then `console.warn` +
`process.exit(1)` (`:181-182`), which lands on the existing exit handler in
seconds with the port named. Second, do not persist a `bind(0)` port: this
machine's `net.inet.ip.portrange.first/last` are 49152/65535, the same range the
kernel hands to outbound connections. Pick below 49152 and outside
`BROWSER_RESTRICTED_PORTS` (`base/node/ports.ts:67`).

---

**Goal.** Give the REH a stable port, so the remote authority is stable, so the
workspace identity is stable.

**The invariant this phase must not break, in the file's own words.**
`workbench-host.ts:327-334` documents the readback as deliberate — "never
chosen, never scanned, never assumed" — because attaching to a stale REH,
possibly at a different commit, "presents as a workbench that works and is
wrong, which is exactly what attaching to whatever owned port 9800 produced.
**Never attach to a port Chorus did not open.**" That is `CLAUDE.md`'s
e2e-harness trap one level out, and it is not negotiable.

**The randomness was never what provided it — the readback is.** Chorus builds
an authority only when _its own child_ prints `Extension host agent listening on
<n>` (`readServerPort`, `:351`). Changing `--port 0` to `--port <n>` leaves that
gate exactly where it is: if something else holds the port, our child cannot
bind, prints nothing, and the existing wait fails closed. The port becomes
**requested** rather than **assigned**, and it is still **confirmed**. The
invariant survives because it never depended on the number being unpredictable.

**And there is a second guard already in place.** `:923` mints a `randomUUID()`,
writes it `0600`, and passes `--connection-token-file` at `:935`. A foreign
server on the chosen port holds its own token, so Chorus's client cannot
authenticate against it — a wrong server fails loudly rather than serving a
plausible empty tree.

**What the port stability buys downstream.** `:1009` records that "the
workbench session's CSP was built with the first authority in it", which is why
a silent re-spawn is refused today. A stable port makes that authority stable
across launches, so the storage identity `remote-authority.ts` pins by hand
stops being a workaround for a moving target.

**What changes, concretely.**

1. A `chosen-port` file beside the token under `serverDataDir()`. It is per
   profile, which is the same scope the reaper already keys on.
2. On first run only, pick one: bind a `net.Server` to `127.0.0.1:0`, read the
   port the OS assigned, close it, persist it. That is "first free", chosen by
   the OS rather than by a hardcoded number that may already be taken on
   somebody's machine.
3. `--port 0` becomes `--port <persisted>`.
4. **The readback is unchanged.** `readServerPort` still parses the child's own
   stdout, and the authority is still built from what the child reported — not
   from what was requested. If the two disagree, that is a fact worth logging
   rather than an assumption worth making.
5. A port in use fails closed with a message naming the port, rather than
   falling back. A silent fallback would restore exactly the churn this phase
   removes.

**The cost, stated.** One port per profile means one Chorus per profile owning
it. That is not a new restriction: `:909-914` already refuses to start when a
server from an earlier session owns the profile's data directory. A port
collision converts into the same "refuse and say why" path that already exists,
rather than a new failure mode.

**Two things nobody has checked, and they are the risk.** Whether the REH fails
to bind or silently falls back to another port when `--port <n>` is taken — the
readback covers either, but the error message depends on which. And the
persisted port is an ephemeral one, so the OS may hand it to something else
between launches; the answer is to fail closed and let the user reset, but the
frequency is unknown.

**Exit criteria.** Two consecutive launches produce the same
`vscode-remote://` authority for the same project, and `workspace:*` storage
scopes are reused rather than re-minted.

## Phase 2 — A workbench that is not throttled

**Goal.** Stop a detached or backgrounded workbench being marked `hidden`, so
its timers, its reconnection schedule and its rendering keep running.

**This phase was called "a socket that outlives its view" and that was the wrong
problem.** The name is kept in the history because the correction is the useful
part: the socket was never the thing at risk.

**The measurement was taken on 2026-09-16 and it changes this phase's premise.**
`apps/desktop/src/main/reparent-check.ts` was extended to read
`document.visibilityState`, a `visibilitychange` log and a
`requestAnimationFrame` counter alongside `isDestroyed()`, and to run itself
once a surface exists. Run with `CHORUS_REPARENT_CHECK=both-open`, on macOS,
Electron 43.2.0:

```
both-open     1  destroyed=false  before=visible  detached=hidden                    after=hidden   frames=0
both-open     2  destroyed=false  before=hidden   detached=hidden                    after=visible  frames=43
source-closes 1  destroyed=false  before=visible  detached=hidden                    after=hidden   frames=1
source-closes 2  destroyed=false  before=hidden   detached=hidden  afterClose=hidden  after=hidden   frames=1
```

**Verified after the fix, same probe, same machine, 2026-09-16:**

```
both-open 1  destroyed=false  before=visible  detached=visible  events=[]  after=visible  frames=6
both-open 2  destroyed=false  before=visible  detached=visible  events=[]  after=visible  frames=57
```

`detached` went from `hidden` to `visible`, and `events=[]` throughout — the
`visibilitychange` listener never fires, so the page is never told it is hidden.
That is the claim, measured on the real path rather than argued.

**One thing the fix does not do, stated so nobody reads more into it.** The frame
counter did not climb across step 2's detached window (6 before, 6 after 500 ms).
Frames come from the compositor and an unparented view has no surface to draw
into, so rAF stalling there is expected and was never the target. The target was
`visibilityState`, because that is what gates renderer timers — the client's
reconnection schedule and `scm-refresh.ts`'s own debounce.

**`source-closes` carries the case that matters.** Its `afterClose` reading is
taken with the view detached _and_ the window it came from closed, and it still
reads `destroyed=false`. That is exactly what `beginHandoff` was written to
survive, and it survives. Across all four moves in both modes nothing was ever
destroyed.

**The realm survives and the page is hidden.** `destroyed=false` on both moves,
so reparenting does not kill the `WebContents` — the reconnection token is not
lost to a dead realm by this path. But the page transitions to `hidden` while
unparented, `visibilitychange` fires, and `requestAnimationFrame` stops at
`frames=0`. It returned to `visible` only on step 2, when the view went back to
the real Chorus window, where `frames=43` shows rAF resuming.

**So this is throttling, not destruction, and that is the macOS residual the
source reading could not reach.** The Aura analysis below is correct for its
platform and wrong for this one: on macOS the renderer is an `NSView` and
detaching it from its superview does mark it hidden. Chromium throttles timers
in a hidden page, and `HANDOFF_EXPIRY_MS` is 10 seconds, so a handoff runs the
workbench's client — including its reconnection schedule — under a throttled
timer for that whole window.

**And nothing opts out.** `backgroundThrottling` is not set anywhere in
`apps/desktop/src/`, so the `WebContentsView` at `workbench-surface.ts:848`
takes the default `true`. Turning it off is the documented remedy, at the
documented cost of applying window-wide.

**`detached=hidden` is the unambiguous reading.** It is taken while the view has
no parent window at all, so there is nothing for it to be occluded by; `hidden`
there can only be the detach itself. It is identical in both modes.

**The two bare-window `after=hidden` readings are not evidence about re-attach.**
They were read first as "it did not recover", and that reading is wrong.
Electron documents occlusion as a visibility input on macOS — "if the window is
occluded (i.e. fully covered) by another window, the visibility state will be
`hidden`" — and a bare `new BrowserWindow({width, height})` created while Chorus
is in front of it is occluded by that definition. Re-attach does clear the flag:
`WasShown()`'s only guard is the flag itself, and `both-open` step 2 returning
`after=visible frames=43` is that path firing. Demote those two readings; keep
`detached=hidden`.

**What the run still does not settle.** Each run had a single surface
(`candidates 1`), so the ambiguous-`heldView` case was never exercised, and the
500ms settle was never stress-tested.

**An unparented view does not stop on the Aura path, and this is settled from
Electron's source rather than its docs** — kept because the method is sound and
the platform split is the finding. Electron documents nothing about a view with
no parent;
`browser-window.md`'s "Page visibility" section is normative about _windows_
only. But `View::RemoveChildView` (`electron_api_view.cc:284-304`) erases the
child and calls the native remove and nothing else, and
`WebContentsView::OnViewRemovedFromWidget`
(`electron_api_web_contents_view.cc:132-141`) removes only the draggable-region
provider. Neither calls `WasHidden()`. The throttle is reachable only through
`WasHidden()` — Electron ships `patches/chromium/disable_hidden.patch` guarding
that early return with `disable_hidden_` — and the only route to it is window
hide, minimize or occlusion, which is an `aura::Window` concern a parentless
view does not have.

**The arithmetic rules out the timing story too.** `HANDOFF_EXPIRY_MS` is
10,000 against a 30-second grace window, so a handoff cannot outlive the
server's retention even at its worst. And the client runs its own reconnection
schedule — `[0, 5, 5, 10, 10, 10, 10, 10, 30]` — inside that window. **Socket
drops are already handled.** Only realm death is not, which is why the token
being minted in the realm is the whole of this phase.

**That residual is what the measurement closed.** On macOS the renderer is an
`NSView` and `removeChildView` detaches it from its superview, and the run shows
the page does go `hidden`. Who calls `WasHidden()` on that path is still
unidentified — see open questions — and it does not matter for the fix, because
the flag has exactly three writers and the guard sits above one of them.

**A sharper hazard found on the way, and it is not about reparenting at all.**
`~WebContentsView` calls `api_web_contents_->Destroy()`, so when the JavaScript
wrapper is garbage collected the page dies with it. Source-only; the docs say
nothing. Chorus's `byId` map is the sole thing preventing that, and it is a
plain JS reference. Any handle that escapes the map is one collection away from
killing a live workbench. Worth a test that asserts the map holds every surface
it created.

**`is_hidden_` has exactly three writers, and that is what makes this tractable.**
`WasHidden()` (`render_widget_host_impl.cc:885`), `WasShown()` (`:927`), and
`RendererExited()` (`:2398`). The third is a crash path — its own comment says
"after the renderer crashes... we assume such RenderWidgetHost to be invisible".
So every runtime transition in a live renderer goes through the pair, and
Electron's `disable_hidden_` guard sits at the top of `WasHidden()` **before**
the assignment. With it set, the flag can never become true; `WasShown()`'s only
guard is that same flag, so it returns early and harmlessly. `blink_widget_->
WasHidden()`, the viz visibility push and `UpdateClientPriority` are all
downstream of the guard and never run. **The fix closes both directions, not
half of one.**

**Use the setter, not only the preference.** `HandleNewRenderFrame`
(`electron_api_web_contents.cc:1918-1936`) applies
`disable_hidden_ = !background_throttling_` on every new render frame, so
`webPreferences: { backgroundThrottling: false }` is re-applied rather than
one-shot. But the runtime setter does one thing the preference cannot:
`if (rwh_impl->IsHidden()) rwh_impl->WasShown({})` — it **repairs a view that is
already hidden**. A surface that has been detached once needs that, so the two
are not interchangeable.

**Three names, and only one of them is fictional.** There is no
`setBackgroundThrottlingAllowed`. `electron.d.ts` at 43.2.0 does carry
`getBackgroundThrottling()` (`:17986`), `setBackgroundThrottling(allowed)`
(`:18374`) and the `backgroundThrottling` property (`:18523`). They are the same
thing: the property is defined in Electron's own JS layer at
`lib/browser/api/web-contents.ts:977-980` as
`set: (allowed) => this.setBackgroundThrottling(allowed)`, and the method binds
to `WebContents::SetBackgroundThrottling` at `electron_api_web_contents.cc:2581`
— the one carrying the `WasShown` repair.

**The runtime assignment does something the construction flag cannot, and the
reason is the explicit call rather than the guard.** `disable_hidden_` is a
guard on `WasHidden()` and on nothing else: `disable_hidden.patch` contains
**zero** occurrences of `WasShown`, and the symbol appears at exactly three
sites — the guard body, the member declaration, and
`RenderWidgetHostViewAura::HideImpl()`'s call site. `WasShown()`'s only
condition is `if (!is_hidden_) return;`, which the guard cannot influence.

What the runtime line has is the explicit call. `SetBackgroundThrottling` ends
with `if (rwh_impl->IsHidden()) rwh_impl->WasShown({})`
(`electron_api_web_contents.cc:2604-2606`), and that is the only public way to
clear an `is_hidden_` that was set **outside** the `WasHidden`/`WasShown` pair.
There is one such writer: `RendererExited()` (`:2398`), on a renderer crash.
`HandleNewRenderFrame` (`:1918-1940`) assigns `disable_hidden_` and calls
`SetSchedulerThrottling` and stops — it never calls `WasShown()`, so it cannot
clear the flag either.

So: `backgroundThrottling: false` in the `webPreferences` literal at
`workbench-surface.ts:848`, which is the mechanism, and
`surface.view.webContents.backgroundThrottling = false` in `attachSurface` after
`addChildView`, which is an explicit `WasShown()` for a state set outside the
pair.

**Whether that state is reachable is unobserved, so the line is useful rather
than load-bearing.** `RendererExited()`'s own comment says the flag is set so
the renderer "will have correct visibility set when respawned", which suggests
the respawn path clears it. Nobody has seen a surface stuck. And a crash does
not cause an attach, so if it ever does happen the repair fires on the _next_
handoff, which may never come — `render-process-gone` is where a real fix would
go. Not written, deliberately.

**The cost, and it is wider than it first looks.** Electron's docs say that once
one webContents in a window disables throttling, "frames will be drawn and
swapped for the whole window and other webContents displayed by it". So this
does not opt four surfaces out — it opts the **shell's** webContents out too,
and a minimised Chorus keeps painting. For Chorus the direction is right, a
background project's terminal and agents keep running, and the trade was taken
knowingly on 2026-09-16. It is not three free lines.

The flag itself is per-`WebContents` — `bool background_throttling_ = true` on
`WebContents` (`electron_api_web_contents.h:827`), read from
`options.Get("backgroundThrottling", …)` (`:880`) — so the shared
`workbenchSession` cannot leak it between surfaces, and `sandbox` is unrelated.

**What is already right, so it is not the bug.** `beginHandoff`
(`workbench-surface.ts:927`) removes the id from `byOwner` before detaching the
view, so a source window closing no longer destroys a surface that has moved.
That is the `finish the detach wiring the gate caught` commit, and the
`source-closes` run proves it: `destroyed=false` with the source window closed
under a detached view.

**What this phase no longer needs, and it is worth saying.** `webSocketFactory`
was going to be taken here, so that a socket owned by main survived a view. The
measurement removes the reason: the realm survives reparenting, the socket goes
with it, and the client's own reconnection schedule already covers a drop. So
the mutual exclusion with the resolver path — `expectsResolverExtension =
!!remoteAuthority?.includes('+') && !options.webSocketFactory`
(`environmentService.js:18`) — **no longer has to be decided at all**. It stays
recorded because Phase 5 may still want it, and because a later phase that
reaches for `webSocketFactory` needs to know what it costs.

**Exit criteria.** A project's terminal survives its view being reparented into
a detached window, with the build still running, and
`document.visibilityState` reads `visible` throughout.

## Phase 3 — Focus, honestly

**Goal.** Remove `scm-refresh.ts` by fixing the thing it works around.

**The cause is confirmed and is not fixed upstream.** The git extension's
`updateWhenIdleAndWait()` calls `whenIdleAndFocused()`, which parks while
`window.state.focused` is false — unchanged in `1.121.0`, `1.128.1` and current
`main`. `git.autorefresh` enables entry into that path and does not bypass the
gate; there is no setting that does. `BrowserHostService` computes focus from
`getActiveDocument().hasFocus()`, which in Chorus is a fact about _one
`WebContentsView`_, not about the Chorus window. Clicking into the chat tells an
editor that is fully on screen that nobody is watching it.

**There is no documented API for this.** `@codingame/monaco-vscode-host-service-override`
advertises focus management and exposes only fullscreen parameters, in both
`33.0.9` and `36.2.7`. `microsoft/vscode#126817` records Git and Explorer using
window focus as a recovery trigger, and no issue covers the multi-view embedder
case.

**There is a third route, and it is the one being built.** Found by `codex` on
2026-09-16, after both of the routes below had been written down as the only
two. Do not fake focus, and do not reverse the architecture — instead give
`BrowserHostService` an honest focus provider. The provider answers "is the
`BrowserWindow` that currently contains this `WebContentsView` focused", which
is VS Code's ordinary meaning of window focus, correctly restored for a host
where one logical window holds several documents. Clicking the chat no longer
reads as nobody watching, because the window is still focused.

**What makes it bounded rather than open-ended.** The package already has the
exact shape: `CustomBrowserHostService extends BrowserHostService` takes
`_toggleFullScreen` and `_onDidChangeFullScreen` as leading static constructor
args before the DI params, and overrides `onDidChangeFullScreen` with a getter
that composes the injected event with `super`'s. Focus slots in the same way,
beside it.

**The wrinkle codex did not have, and it changes one sentence.** Chorus does not
import `@codingame/monaco-vscode-host-service-override`, and it is not a direct
dependency — `@codingame/monaco-vscode-api` depends on it
(`pnpm-lock.yaml:4061`), so the api registers `IHostService` itself with no
params. So this is not adding a registration, it is **overriding the api's own**,
and Chorus's spread has to win. `BrowserHostService` is confirmed live in the
built bundle — ten occurrences, plus `getActiveDocument().hasFocus` twice — so
`scm-refresh.ts`'s account of the cause is correct rather than inferred.

**The change, in five parts.**

1. Add `@codingame/monaco-vscode-host-service-override@33.0.9` as a direct
   dependency. It already resolves at that exact version transitively.
2. `pnpm patch` it: `hasFocus?: () => boolean` and `onDidChangeFocus?: Event<boolean>`
   on `BrowserHostServiceOverrideParams`, threaded as constructor args 2 and 3,
   `__param` indices shifted by two, and getters that fall through to `super`
   when the input is absent. Submit the identical change upstream.
3. Main tracks the owning `BrowserWindow`'s focus per surface and pushes it to
   the view. **The subscription has to follow the handoff**, because
   `attachSurface` changes which window owns a surface.
4. The preload exposes it and `services.ts` passes both into
   `getHostServiceOverride`, spread late enough to win.
5. `scm-refresh.ts` stays until the replacement is measured, then goes. Deleting
   it first would trade a known workaround for a known bug.

**The two routes this replaces, kept because they were the honest answer until
the third was found.** Compose
the chat and the workbench in one focus-bearing document, which trades away the
native-view isolation that Preflight §4.1a chose deliberately. Or contribute a
focus-provider parameter to the CodinGame host override upstream, and wait.

**What we are not doing, and it needs saying.** Replacing `IHostService`
privately, or hardcoding `hasFocus()` to `true`. That is a lie told at the
bottom of the stack, and `scm-refresh.ts`'s own comment already argues the case
against it: every other focus-gated behaviour — autosave, dimming, third-party
extensions — would read the lie as truth.

**Measured on 2026-09-16, and `scm-refresh.ts` is gone.**

The workaround was disabled locally first, so it could not be what refreshed
anything. With a project open and the cursor in **Chorus's own composer** — a
sibling document in the same window, which is the exact state that used to park
the git extension — a file created on disk from outside the app appeared in
Source Control without the editor being clicked. The count went from one change
to two while the workbench's own document was blurred.

Two false starts are worth recording, because both looked like failures and
neither was. The first attempt showed an empty Source Control, which was correct:
the repository had no changes. The second showed nothing because the git
extension had not activated yet — opening the view is what activates it, and a
branch appearing in the status bar is activation rather than a refresh. And a
third confound was the test setup itself: driving the test from a _different
window_ blurs the window under test, so the provider correctly answered `false`
and the extension correctly parked. That is the fix working, and it reads
identically to the fix failing unless you know to look.

Removed by ownership rather than by references: `scm-refresh.ts`, `scm-gate.ts`,
`scm-gate.test.ts` and the `entry.ts` call site. Nothing else named them.

## Phase 4 — Extensions per workspace (closes C-063)

**Goal.** Installing an extension in one project stops enabling it in all of
them.

**The gallery is already correct** — `services.ts:802` points at Open VSX with
`resourceUrlTemplate` filled, for the licence reason its comment gives. Nothing
to do there.

**Per-project extension _directories_ are not possible.** `--extensions-dir` is
a server-level argument (`argv.d.ts:65`) with no per-connection variant anywhere
in the server CLI. Upstream does not support several extension directories on
one server. Chasing this is chasing something that does not exist.

**Per-workspace _enablement_ is possible and is upstream machinery.**
`ExtensionEnablementService._enableExtensionInWorkspace` and
`_disableExtensionInWorkspace` persist at `StorageScope.WORKSPACE`
(`extensionEnablementService.js:654-735`), gated on `hasWorkspace` — and Chorus
always opens a folder, so the gate is satisfied.

This reframes C-063 rather than solving it as written. One shared install set,
per-project enablement. Say so on the board when it closes.

**Also noted:** `@codingame/monaco-vscode-user-data-profile-service-override@33.0.9`
exists and is not installed. The profiles seam is available and unused. It is
only worth taking if per-project extension _sets_ turn out to matter more than
enablement, which is not established.

## Phase 5 — Remote over SSH

**Goal.** Make "open a folder on another machine" work.

**The Microsoft extension will never work and is not the route.**
`ms-vscode-remote.remote-ssh` is proprietary and licensed to official VS Code
builds. Chorus embeds Code-OSS.

**Neither open alternative works as a resolver here, and the reasons differ.**
The browser `ExtensionService._doResolveExtensions` returns early unless
`expectsResolverExtension`, then filters `_scanWebExtensions()` for an
`onResolveRemoteAuthority:*` activation event and resolves on
`ExtensionHostKind.LocalWebWorker` (`extensionService.js:145-176`). A resolver
here must be a **web** extension. `xaberus/vscode-remote-oss` has `main` and no
`browser` entry, so it is structurally excluded. `jeanp413/open-remote-ssh` has
a `browser` entry and declares `onResolveRemoteAuthority:ssh-remote`, so it is
structurally eligible, but it depends on `ssh2`, `socks` and `simple-socks`,
which are Node-only. _That it therefore fails is inference from its dependency
list, not a documented statement_ — see open questions.

**The route that needs no resolver at all.** `_doResolveAuthority` builds
`new WebSocketRemoteConnection(host, port)` straight from the authority string
and takes the token from the construction options. So Chorus can point its one
authority at an REH running on the remote machine, reached through an `ssh -L`
tunnel. That is precisely the model `vscode-remote-oss`'s own README documents,
and it is the honest answer to the request.

**The cost, and it is real.** There is one authority, so a window is local or
remote, never both. And the remote REH's commit must match the client's, which
`assertMatchedPair` would have to be extended to cover — a remote box will not
happen to be running the artifact Chorus pinned.

## Phase 6 — `33.0.9` → `36.2.7`

**Goal.** Stop being three majors behind.

**This fixes none of the above, and that is the finding.** Across the tagged
comparison `v33.0.9...v36.2.7`, `remoteAgent.ts`, `scm.ts`, `extensions.ts`,
`host.ts` and `lifecycle.ts` are **unchanged**. Only `files.ts` changed, and its
changes are stream error handling, `readFileStream` delegation and an HTML
filesystem provider. No watcher fix, no authority fix, no focus fix, no
lifecycle fix.

`33.0.9` embeds VS Code `1.121.0` and Monaco `0.55.1`; `36.2.7` embeds VS Code
`1.128.1` and Monaco `0.56.0`. `34.0.0`, `35.0.0` and `36.0.0` each declare a
breaking jump.

**So do it last and do it alone.** Advance every `@codingame/monaco-vscode-*`
package together, rebuild against Monaco `0.56.0`, and repatch the VSCodium REH
to the matching client commit. Bundled with a behaviour change, a regression
would have two candidate causes.

## What we are deliberately not doing

- **Not rewriting canonical URIs.** Tried and reverted on 2026-08-30; it fixed
  trust and emptied the file explorer, because canonical URIs are consulted far
  beyond the trust service. Phase 1 removes the need.
- **Not calling `_setResolvedAuthority`.** The public name does not exist; the
  underscore method is an internal VS Code seam, and using it is the
  guessed-shape failure one level up.
- **Not lying about focus.** See Phase 3.
- **Not enabling workspace trust to "fix" anything.** It is already off, and the
  decision to keep it off is a security-model question about VS Code's own
  executors — tasks, debug, terminals — which Chorus's permission engine does
  not govern. That is worth revisiting on its own terms, not as a stability fix.
- **Not tuning the file watcher yet.** There is no documented "known-good large
  local REH" preset. The supported procedure is Trace logging on the remote
  `Server` output first, then exclusions. Tuning before measuring would be
  guessing.

## Needs a decision

**Port strategy — decided 2026-09-16: persisted first-free.** Pick a free port on
first run, save it, reuse it forever. Fails closed rather than falling back,
because a silent fallback restores the churn Phase 1 removes.

**A minimised Chorus may keep painting — decided 2026-09-16: yes.** Phase 2's
fix turns background throttling off for a workbench surface, and Electron's docs
say one webContents doing that draws frames for the whole window. The upside is
that a background project's terminal and agents keep running, which is the
behaviour Chorus already promises. The cost is battery while minimised, and it
is accepted deliberately rather than by omission.

**Phase 3's route: one document, or wait on upstream?** Same-document
composition is a large architectural reversal of Preflight §4.1a. Waiting means
`scm-refresh.ts` stays indefinitely. There is no third option that is not a lie.

## Open questions

- ~~**Does reparenting a `WebContentsView` between windows kill the renderer
  realm?**~~ **Answered 2026-09-16 by running the probe. No, but it hides it.**
  See Phase 2.
- **Who calls `WasHidden()` on the macOS detach path?** Electron's own handlers
  do not: `View::RemoveChildView` calls only the native remove, and both
  `OnViewAddedToWidget` / `OnViewRemovedFromWidget` do owner-window and
  draggable-region bookkeeping. `views::WebView` does not override
  `VisibilityChanged`. The caller is somewhere in Chromium's Views-to-content
  bridge and was not located. **It does not block Phase 2**, because the flag has
  only three writers and none of them can be reached without `WasHidden()` — but
  it is open, and it is written as open rather than filled with a guess.
- **Is a crashed-and-respawned surface ever left stuck page-hidden?**
  `RendererExited()` sets `is_hidden_` outside the `WasHidden`/`WasShown` pair,
  and `HandleNewRenderFrame` cannot clear it. But its own comment says the flag
  is set so the renderer has correct visibility "when respawned", which suggests
  the respawn path handles it, and nobody has observed a stuck surface. Phase 2's
  runtime assignment is an explicit `WasShown()` for this state, and it only runs
  on attach — a crash does not cause one. `render-process-gone` is where a real
  fix would go, if the state turns out to be reachable at all.
- ~~**Does `View::SetVisible(false)` reach `WasHidden()`?**~~ **Answered
  2026-09-16: yes, and the guard covers it.** The chain on macOS is
  `View::SetVisible` → `NativeViewHost::VisibilityChanged` →
  `native_wrapper_->HideWidget()` → `RenderWidgetHostViewMac::Hide()`
  (`render_widget_host_view_mac.mm:552-562`) → `WasOccluded()` (`:618-624`,
  literally `if (host()->IsHidden()) return; host()->WasHidden();`) →
  `RenderWidgetHostImpl::WasHidden()`, which is exactly the guarded function.
  Chromium's own comment in `NativeViewHost::ViewHierarchyChanged` names the
  mechanism, speaking of "spurious visibilitychange events for web contents of
  `WebView`" during reparenting. Aura is identical and Electron's patch guards
  its call site too. The run confirms it independently: `detached=hidden` means
  `is_hidden_` became true, its only live writer is `WasHidden()`, so the detach
  funnels into the guarded function. **So a surface hidden by `applyVisibility`
  is not drawn but is no longer page-hidden.** That is the trade in full, not a
  partial fix.
- **Would a reconnection token replayed from a fresh realm be accepted
  end-to-end**, given the protocol state the server would resume against?
  Unverified.
- **Does `open-remote-ssh`'s browser bundle actually load without Node?** The
  dependency list says no; nobody has loaded it.
- **Why do search results also go missing?** A remote text search is a fresh
  remote operation, not a watcher consumer, so watcher loss does not explain it.
  Either the connection was gone — which supports Phase 2 — or there is a second
  cause nobody has found.
