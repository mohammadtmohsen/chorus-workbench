# UI and performance review

## Status

| Unit              | Result                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Scope             | Recent Traffic, browser tab, notification, and shared editor layout changes, including their existing dependencies    |
| Review            | Nine source-supported findings recorded on 2026-10-14                                                                 |
| Implementation    | All nine fixes written after the user authorized “fix all”                                                            |
| Source review     | Scoped reviews and corrective re-reviews complete for Traffic, settings, tabs, notifications, and storage integration |
| Build and install | `CHORUS_INSTALL_KEEP_RUNNING=1 pnpm app:install` completed; signed arm64 app installed at `/Applications/Chorus.app`  |
| Verification      | Runtime behavior and performance magnitude unverified; no tests, separate typecheck, or app launch ran                |

This is a focused review of the recent UI work, not an audit of the entire desktop app. P1 means fix before installing the changes. P2 means a correctness or interaction issue worth fixing next. P3 means a performance enhancement whose practical impact needs measurement.

## Current / Issue

The findings below describe the pre-fix source captured in `/private/tmp/workbench-review-fixes-20261014`. The implementation record follows the original findings.

### 1. P1 — Settings patches reset omitted preferences

`apps/desktop/src/renderer/src/TrafficRequestInspector.tsx:74` sends only `trafficRequestFraction`. The request schema at `apps/desktop/src/shared/ipc.ts:1760` derives from `SettingsShape.partial()`, whose fields carry read defaults. Main parses this request at `apps/desktop/src/main/ipc.ts:1196`, then spreads the parsed preferences over saved settings at `:811`.

Installed Zod 4.4.3 preserves these defaults inside optional wrappers. Its `core/util.ts:720` wraps each field; `core/schemas.ts:3501` delegates optional input to the default-bearing inner schema; `:3647` replaces undefined with the default. Thus saving the split also writes omitted fields such as `theme: 'system'`, `notifications: true`, and `completionProvider: 'auto'`. An unrelated settings write likewise resets a saved split to `0.5`.

The patch contract must validate only fields actually supplied. Defaults belong on reads.

### 2. P2 — Request JSON controls can target the response pane

`TrafficRequestInspector.tsx:218` shares collapse and focus state between both bodies. Both rendered trees attach the same ref at `:531`. `focusPath` at `:440` queries only the last attached tree, normally the response tree.

`traffic-body.ts:145` creates paths such as `/0` independently for each body. Clicking a request property can focus the response property with the same path. Collapsing that path also collapses the corresponding response node. Give each side its own ref, collapse state, and focus state.

### 3. P2 — Body reads overlap and continue after selection changes

The effect at `TrafficRequestInspector.tsx:335` starts both bodies but checks only whether each is finished. When a short request body finishes while the response is still loading, the changed `loaded` object starts a second response read from offset zero. Representation fallback can also restart work through the callback dependency at `:332`.

The generation guard at `:278` is not invalidated on unmount. Automatic selection remounts the inspector through `TrafficPanel.tsx:1652`, so the old inspector can continue its paging loop after a new request is selected. Keep one in-flight task per side and invalidate it during cleanup. Check cancellation before starting another page.

### 4. P2 — Resizing rebuilds JSON bodies on every pointer movement

`TrafficRequestInspector.tsx:165` updates the shared signal on every pointer movement. Subscribers rerender even when the clamped fraction is unchanged because a new object is published at `:64`.

Each render formats the body at `:356`, parses another JSON tree at `:416`, flattens it at `:523`, and maps all visible rows at `:532`. `traffic-body.ts:45` already parses and stringifies during formatting. This repeats work unrelated to geometry across every mounted inspector.

Cache body formatting and parsed trees by their actual content. Cache rows by tree and collapse state. Keep body rendering independent of the split fraction, skip unchanged fractions, and coalesce drag updates to animation frames. Large-tree virtualization is a later option if measurement still shows excessive row rendering.

### 5. P2 — Failed editor storage writes are lost

`apps/desktop/src/renderer/src/workbench/storage.ts:170` updates its local items before awaiting `applyStorageDelta`. If that IPC write rejects, it has no retry queue or rollback. Repeating the same value is skipped at `:176` because the cache already holds it.

The installed Code-OSS storage implementation clears its pending maps before calling the database in `vs/base/parts/storage/common/storage.js:184`. It does not requeue a rejected update. The custom database's `close` at `storage.ts:202` also has nothing to retry.

A failed write can therefore leave a sidebar preference changed in the UI but absent after reopening. Retain and retry unacknowledged deltas, including deletions, without allowing an older failed value to overwrite a newer change. Distinguish invalid writes from transient failures.

### 6. P2 — Transparent notification gaps block underlying clicks

`apps/desktop/src/main/toast-windows.ts:125` creates one transparent native window. `useToastWindow.ts:54` sizes it to the entire stack rectangle, including the gaps at `styles.css:13888` and rounded corners at `:13901`. No mouse pass-through or shaped hit region is configured.

Transparency alone does not pass clicks to the editor or browser below, per [Electron's transparent-window limitations](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations). The source therefore implies blocked clicks in visually empty parts of the notification stack. This is a platform-supported inference, not an observed runtime result.

Add selective pass-through outside the cards while retaining their interactive controls. [Electron documents mouse-event forwarding](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions#click-through-windows). Verify the chosen implementation on supported platforms.

### 7. P2 — Shell overlays destroy and recreate notification windows

`ToastStack.tsx:22` activates the native host only while notifications exist and no shell overlay is active. `useToastWindow.ts:28` opens a window each time activation changes. Cleanup closes it at `:161`. Opening and closing a menu, hover card, notes panel, or dialog can trigger this lifecycle.

Every recreation copies all styles at `:93` and changes the portal destination. The notification input DOM is remounted, losing focus and selection even though parent-held draft text survives. There is no focus restoration.

Keep the native host and portal destination stable for the shell lifetime. Hide it while an overlay needs priority and restore the appropriate input focus when returning. Release the window and observers when the shell closes.

### 8. P2 — Crowded equal-width tabs clip close controls

`styles.css:14043` allows each tab to shrink arbitrarily and clips overflow. Its main button retains horizontal padding at `:14087`, while close retains a fixed 26px width at `:14106`. Below roughly 40px per tab, these controls cannot fit. The browser roster allows 100 tabs in `apps/desktop/src/shared/workspace-layout.ts:155`.

Use a compact presentation at narrow widths. Reduce padding and expose close through a reachable active-tab control or menu. Retain equal widths and no scrolling, as requested. Keyboard and middle-click closing can supplement the visible controls.

### 9. P3 — Editor storage flushes perform full-file synchronous I/O

`apps/desktop/src/main/workbench-storage.ts:146` reads and parses the complete storage file for each delta. It stringifies every scope and performs synchronous write and rename at `:163`. The main-process IPC handler calls it directly at `workbench-surface.ts:1679`.

The cost grows with all saved project and extension state, rather than the changed scope. Multiple project surfaces share the same main event loop. Blocking work is proven by the source; noticeable stalls have not been measured.

Consider a cached authoritative store and a serialized asynchronous writer or worker. Preserve atomic writes, scope validation, ordering, cross-project broadcasts, and acknowledgement semantics. Measure representative storage sizes before choosing the larger change.

## Proposed

1. Correct the settings patch schema first so UI gestures preserve other preferences.
2. Separate request and response tree interaction state.
3. Make Traffic body loading single-flight and cancellable.
4. Decouple body computation and rendering from divider movement.
5. Make editor storage failure recovery durable and ordered.
6. Preserve both native notification interaction and underlying interaction in empty areas.
7. Keep the notification host stable across shell overlays.
8. Add compact tab controls while preserving equal distribution.
9. Cache committed storage and serialize asynchronous atomic writes. Performance magnitude remains unmeasured.

## Code Changes

| Area                | Proposed files and boundaries                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings            | `shared/ipc.ts`: separate optional patch validators from default-bearing read validators; preserve existing normalization, per-agent partial maps, and write-only secret fields. `main/ipc.ts`: keep the merge operating on supplied keys only.                                                                                                                                                                        |
| Traffic             | `TrafficRequestInspector.tsx`: cancel and guard per-side loading; coalesce resize frames and skip unchanged fractions. `TrafficBody.tsx`: independent memoized body content and tree controls per pane. Preserve automatic latest-request selection.                                                                                                                                                                   |
| Editor persistence  | `renderer/src/workbench/storage.ts`: retain revision-tagged deltas until acknowledgement, retry transient errors, and roll back rejected revisions without replacing newer Code-OSS cache values. Explicit flush request/result channels in `shared/workbench-ipc.ts`, `preload/workbench.ts`, `renderer/src/workbench/entry.ts`, and `main/workbench-surface.ts` drain storage before removing surface authorization. |
| Notifications       | `useToastWindow.ts`, `ToastStack.tsx`, and `main/toast-windows.ts`: separate window lifetime from visibility and add selective native hit handling. Preserve focus, theme mirroring, and parent-window routing.                                                                                                                                                                                                        |
| Browser tabs        | `styles.css` and `workspace/WebTabStrip.tsx`: adapt narrow-tab contents and reachable close controls. Preserve equal widths, keyboard selection, and drag ordering.                                                                                                                                                                                                                                                    |
| Storage performance | `main/workbench-storage.ts`: cache committed state, share initial reads, and serialize asynchronous atomic writes. `main/workbench-surface.ts` awaits persistence before broadcasting. `main/index.ts` awaits closing surfaces and queued disk writes before allowing quit.                                                                                                                                            |

## Implementation record

| Finding                      | Change written                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Settings patches         | Explicit optional validators without read defaults; normalization, per-agent maps, and secret fields retained                                                                                                                                                                                         |
| 2 — JSON interaction         | Each `TrafficBody` owns its own tree ref, collapse state, focus state, and keyboard entry point                                                                                                                                                                                                       |
| 3 — Body reads               | One in-flight loop per side and generation; cleanup invalidates reads and every page checks cancellation; encoded fallback stays within the same loop                                                                                                                                                 |
| 4 — Divider rendering        | Memoized body component with stable byte/descriptor props; formatting, tree, rows, and form fields cached; pointer updates coalesced and final position flushed on release or cleanup                                                                                                                 |
| 5 — Persistence failures     | Retained outbox with bounded backoff; newer revisions survive older acknowledgements; invalid batches do not block later writes; Code-OSS writers are closed before the final drain; failed database close retains its retry path; explicit surface-close drain retries before revoking authorization |
| 6 — Notification hit regions | Rounded-card and scrollbar regions; macOS mouse forwarding outside those regions; Windows/Linux native window shapes; scroll, card mutations, and card resizes refresh regions                                                                                                                        |
| 7 — Notification lifetime    | Lazy first creation, then stable host and portal across visibility changes; saved input focus and selection restored when appropriate; listeners and observers released on teardown                                                                                                                   |
| 8 — Compact tabs             | Content-independent strip width, compact icons, a separate active-tab close control, stable accessible names, and keyboard closing; equal widths and no scrolling retained                                                                                                                            |
| 9 — Storage I/O              | Committed snapshot cache and serialized asynchronous writes; updates broadcast after commit; main quit waits for the write queue                                                                                                                                                                      |

The source review corrected compact-mode sizing feedback and tab accessible names. It also corrected invalid-write rollback races, froze upstream storage writers during final draining, retained failed close outboxes, wired Chromium teardown explicitly, added a main-process quit barrier, and refreshed notification hit regions beneath a capped stack. Notification focus replies use snapshot identity so a stale reply cannot apply an obsolete selection. These were source reviews, not runtime tests.

## Final Flow

With the written fixes, a divider move changes geometry without rebuilding body content. Releasing it writes only the split preference. Each selected exchange owns at most one read loop per body, and leaving the exchange invalidates both. Request and response tree controls operate independently.

Global layout changes remain pending until acknowledged. Notification cards keep a stable native host and accept input, while empty areas permit underlying editor and browser interaction. Browser tabs continue to divide the available width equally, with a reachable close action at narrow widths.

Surface close requests a renderer storage drain while its storage capability remains live. The service emits its final save event, closes upstream storage writers, and drains retained database changes. Failed database close keeps its outbox registered for retry while the document remains alive. Main revokes authorization after the result or the ten-second deadline, closes the view, and releases the last project lease. App quit additionally awaits the serialized disk-write queue. Failed drains are reported. Persistent filesystem failures and forced termination cannot be made durable by retries.

Manual verification remains: preserve non-default settings while resizing and while saving unrelated preferences; rapidly select requests with large bodies; navigate and collapse JSON independently in both panes; resize large bodies across projects; recover a failed storage write and reopen; click notification gaps; preserve a reply draft and focus across overlays; and close, select, and reorder crowded browser tabs.

On the user's build-and-install request, `CHORUS_INSTALL_KEEP_RUNNING=1 pnpm app:install` completed successfully on 2026-10-14. The dependency builds, Electron/Vite build, local signing with `Chorus Local Dev`, and installer signature verification completed. Version 0.20.0 was installed at `/Applications/Chorus.app`. The previous bundle remains at `/Applications/Chorus.app.replaced-1791969547283` for the running session. Reopening Chorus loads the updated build. No tests, separate typecheck, or app launch ran; runtime behavior and performance magnitude remain unverified. The installation log is `/private/tmp/workbench-ui-fixes-install-20261014.log`.
