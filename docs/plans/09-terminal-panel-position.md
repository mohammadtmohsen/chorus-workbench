# Remember the workbench terminal panel position

## Status

| Step | Status |
| --- | --- |
| Investigation | Codex and Claude traced panel storage and native-view bounds independently; source evidence supports shared-key overwrites and degenerate layout; runtime NOT VERIFIED |
| Plan challenge | Codex accepted the narrower renderer-side size hold and legacy seed write-through; unsupported hidden-view resize claims remain an uncertainty |
| Implementation | Implemented by Claude in `storage.ts` and `entry.ts`; main-process files unchanged; Codex inspected the actual incremental diff |
| Integrated review | Codex reviewed U1 and U2 together; Claude's final integrated adversarial review found no supported functional defect; Codex confirmed and documented the logging and seed-write cost notes |
| U2: save when panel layout settles | Implemented and source-reviewed by Codex and Claude; runtime NOT VERIFIED |
| Verification | Tests, typecheck, lint, builds and app launches NOT RUN under the standing user instruction |
| Delivery | Reviewed local changes complete; no commit, installation, packaging or push |

## Current / Issue

The supplied screenshot shows the embedded Code-OSS bottom terminal panel at approximately its minimum height. This panel belongs to the editor, not Chorus's global terminal. Code-OSS writes `workbench.panel.size` in PROFILE storage when storage flushes. All project surfaces share that profile; a window blur flushes their separate grids into the same key. Panel position, hidden state and maximization flag already use WORKSPACE storage.

New background surfaces start with 0×0 bounds. They boot before receiving usable geometry because hidden project tabs do not report bounds. Creation, attachment and handoff each explicitly assign zero bounds. Code-OSS's grid is nonproportional, its panel minimum height is 77, and the editor has high layout priority. This provides a supported mechanism for a panel squashed at startup to overwrite the shared saved height. The exact grid size and IPC ordering have not been reproduced at runtime.

The baseline is the existing dirty working tree. Relevant files were copied to `/private/tmp/workbench-terminal-position-baseline/` before any product edit. No test, build or app baseline was run. Existing plan 08 horizontal chat/editor persistence remains in place.

## Proposed

Keep the embedded workbench as the owner. In `ChorusStorageService`, route only `workbench.panel.size`, `workbench.panel.lastNonMaximizedHeight` and `workbench.panel.lastNonMaximizedWidth` from PROFILE to WORKSPACE. The latter two must follow the size or maximize/restore and dock changes can still import another project's dimensions. Reads prefer the workspace value and fall back to the existing profile value for compatibility. Normal saves also update the PROFILE copy as the current seed for projects without their own saved dimensions. Existing project values always take precedence. This avoids freezing the migration fallback at a previously squashed size after the user corrects it. Default seeding continues writing the profile fallback directly through the base service; it must never replace a saved workspace size. Preserve both string `get` overloads and the `store` target/external arguments. Installed `LayoutStateModel` reads through `get` and writes through `store`; reset skips loading rather than deleting these keys. No extra getter or deletion overrides, IPC, schema, dependency or package patch.

Hold the renderer's workbench root at a usable size before `initialize`, independent of how Electron propagates bounds to hidden native views. In `entry.ts`, retain each axis's last positive viewport dimension; use `screen.availWidth`/`availHeight` only before one exists. When an axis is zero, explicitly size the root to that retained dimension. On positive geometry, clear the temporary CSS override and return to normal sizing. Register this resize handling before Code-OSS starts, so its measurement reads the protected root. Logical width messages remain authoritative: mark their arrival and never clear or replace that width during native cropping or resize. Main-process geometry, visibility, overlays, zoom and transfer authorization stay unchanged.

The initial main-side proposal was dropped in the plan challenge because renderer sizing is smaller and avoids depending on unverified hidden-view resize behavior. Claude's claim that hidden native views are not resized is not source-proven. Electron's View API documentation does not guarantee the renderer viewport timing here. The root-size hold does not require that claim to be true.

This follows the already requested per-project layout behavior. A legacy profile height that was previously overwritten cannot be reconstructed; preserve it until the user resizes the panel rather than inventing a different saved position. Sidebar and auxiliary-bar sizing, terminal output/scrollback and the global terminal are outside this fix.

## Code Changes

One atomic implementation unit covers the interacting persistence and geometry fixes.

- `apps/desktop/src/renderer/src/workbench/storage.ts`: narrowly route the three numeric panel keys, preserve fallback/default initialization, and keep unrelated storage scopes unchanged.
- `apps/desktop/src/renderer/src/workbench/entry.ts`: install the zero-viewport size hold before initialization and keep logical-width messages authoritative.
- Regression coverage: use an existing suitable test pattern if available. Avoid adding a large service simulation merely to mirror overrides. Record any coverage gap. No main-process or existing test changes are needed for the revised design.

No product comments are to be added. Remove or minimally correct an existing comment only if the changed behavior makes it false. Preserve all pre-existing modifications.

### As implemented

`storage.ts`: `PROJECT_PANEL_KEYS` holds `workbench.panel.size`, `workbench.panel.lastNonMaximizedHeight` and `workbench.panel.lastNonMaximizedWidth`. `ChorusStorageService.get` redeclares both installed overloads; for a listed key at PROFILE it returns the WORKSPACE value when present, otherwise the PROFILE value with the caller's fallback. `ChorusStorageService.store` keeps the installed signature; for a listed key at PROFILE it writes WORKSPACE and then PROFILE, forwarding `target` and `external` to both. `applyDefaultSize` writes its size through `super.store`, so the 400 seed lands in PROFILE only and never in a workspace. The two `get` overloads return different types, so the repository's `unified-signatures` rule, which only merges equal return types, does not apply. No `getNumber`, `remove` or `storeAll` override: installed `LayoutStateModel` reads these keys only through `get` and writes them only through `store`.

`entry.ts`: `holdUsableRoot(container)` returns the handler that is called once right after the root is created and then on every window `resize`, registered before `onLayoutWidth` and before `initialize`, so before Code-OSS's own resize handling. Each axis keeps its last positive viewport dimension, seeded from `screen.availWidth`/`availHeight` and, when those are not usable, from Code-OSS's `DEFAULT_WORKSPACE_WINDOW_SIZE` (1440×900). An empty axis is held with `min-height`, or `min-width` only while `style.width` is still empty; a positive axis clears its own override. The hold reads `style.width` to recognize a logical width and never writes `style.width` or `style.height`, so the logical width from `onLayoutWidth` stays authoritative, and the `style.width === ''` checks used by wheel forwarding and webview wheels keep their meaning. Zero width with positive height and the reverse are handled independently.

Coverage gap, recorded rather than filled: no existing test exercises `ChorusStorageService`, and testing its overrides would need a full `BrowserStorageService` initialisation. `holdUsableRoot` lives in `entry.ts`, which runs `main()` on import. Moving the pure sizing decision into `viewport.ts` would make it testable beside `viewport.test.ts`, at the cost of a fourth file.

## Acceptance Criteria

1. A resized terminal panel restores its size when project A reopens.
2. Projects A and B retain independent sizes; background-project flushes cannot replace A's size.
3. A background project's first activation restores a usable panel rather than a panel collapsed by a zero-sized boot.
4. Detach and reattach preserve panel sizing until the destination supplies bounds.
5. Maximize/restore and dock changes use the project's own remembered dimensions. Existing panel visibility and dock position remain workspace-owned.
6. Old storage retains its profile fallback; a new profile retains the 400 default. Workspace values take precedence over default initialization. New projects in an existing profile use the current seed rather than a frozen legacy size.
7. Existing native visibility behavior remains intact, including Editor/overlay hiding. A zero viewport cannot shrink the root used by the workbench's grid to zero.
8. Existing authorization, zoom and logical-width handling remain intact.
9. Panel size, dock and visibility changes schedule a save after a short settling period while the workbench is still authorized. Normal close/quit after that save restores the latest layout without depending on the idle timer or window blur.

### Required lifecycle follow-up

Final review found that `BrowserLifecycleService.doShutdown` starts a storage flush without awaiting it. `destroySurface` removes the sender from `byContents` before calling `webContents.close`, so a later storage write is refused even if the unload path gets time to send it. `index.ts` closes all surfaces synchronously at the start of app shutdown. A panel resized since its last idle/window-blur save can therefore lose its final size.

U2 observes the panel container with the same `ResizeObserver` pattern already used for the activity bar. Panel resize, dock and visibility changes restart one Code-OSS `RunOnceScheduler` with a 200ms delay. Its task flushes storage and reports a rejected flush through `ILogService`. The installed storage layer normally adds a 100ms write delay. This makes the panel layout durable shortly after it settles while its sender is still authorized, covering app quit, project close and window close without changing those paths. A save-before-teardown request/result handshake was rejected because it would change five interfaces and must cover duplicate shutdown, destroyed owners and closing-surface authorization.

As implemented: `savePanelLayout(logs)` in `entry.ts` resolves `IWorkbenchLayoutService` and `IStorageService`, holds one `RunOnceScheduler` at 200ms whose task is `storage.flush()` with a `.catch` that logs `Chorus: panel layout could not be saved` through `ILogService`, and re-arms it from `onDidChangePartVisibility` filtered to `Parts.PANEL_PART`, `onDidChangePanelPosition`, and a `ResizeObserver` on `layout.getContainer(window, Parts.PANEL_PART)`. `schedule()` cancels and re-arms, so a drag produces one flush after it settles rather than one per frame. It is awaited in `main` immediately after `watchWorkbenchChrome`, with the same caught-and-logged setup failure. The observer also fires once on attach and on the window's own resizes, each costing one flush. Listeners live for the document, matching the activity-bar watcher. Visibility is covered by the filtered event; the observer is expected to see the panel collapse as well, which is NOT VERIFIED.

Residual limit: closing within approximately 300ms plus IPC latency of the final panel change can still race persistence. This does not guarantee an instantaneous close; it matches the application's existing debounced persistence model. No testing is run, and actual timing remains NOT VERIFIED.

Source and incremental-diff review checked the implementation paths below. No tests were added or run. Runtime persistence, screen fallback dimensions, empty-to-real resize delivery and Code-OSS grid clamping remain NOT VERIFIED. Listener registration order is supported by the installed source: both root-hold and Code-OSS window resize handlers use the target's non-capture phase, with the hold registered first. No commit, installation, push or packaging is requested.

Final review clarified the error boundary: the new catch logs a rejected `flush()` and the setup catch logs a failed watcher installation. The installed normal flush waits on `whenFlushed()` promises that resolve even when `updateItems` fails; the underlying write rejection is discarded by the existing storage layer. This change does not add write-error reporting or retries. Final review also found a bounded cost: refreshing the PROFILE seed when another project's value differs can add a synchronous storage-file rewrite and broadcast. External MACHINE-target seed changes do not relayout the panel, so this creates no observer feedback loop. No additional code change was justified by either note.

Research: [Electron View API](https://www.electronjs.org/docs/latest/api/view) defines bounds and visibility separately but does not establish hidden-renderer resize timing. [CSSOM Screen interface](https://drafts.csswg.org/cssom-view/#the-screen-interface) defines available screen dimensions used for the initial root fallback. Installed Code-OSS 33.0.9 remains the evidence for storage consumers and grid ownership.

## Final Flow

Create the renderer root with usable dimensions even in a zero viewport → load project-specific panel state with a current profile fallback → renderer supplies native placement → root sizing follows real geometry while logical width remains authoritative → panel changes settle for 200ms → the normal Code-OSS flush writes this workspace's dimensions, dock and visibility state and refreshes the profile seed → transfers preserve the root's last usable size until destination geometry arrives.

## Delivery Report

### What changed and root cause

The embedded terminal panel now reads and saves its dimensions per project, keeps a usable root layout during zero-sized native viewports, and schedules persistence after resizing, docking or visibility changes settle. The confirmed source defect was that separate project grids shared the PROFILE panel-size keys. Hidden startup and transfer paths supplied zero bounds, providing a supported collapse mechanism consistent with the screenshot; the exact rendered collapse remains unobserved. Saving only on idle or host-window blur also left recent panel changes unsaved before teardown revoked storage authorization.

### Files changed

- `apps/desktop/src/renderer/src/workbench/storage.ts`: `PROJECT_PANEL_KEYS`, `ChorusStorageService.get`, `store`, and `applyDefaultSize`.
- `apps/desktop/src/renderer/src/workbench/entry.ts`: `holdUsableRoot`, `savePanelLayout`, and their startup wiring.
- `docs/plans/09-terminal-panel-position.md`: investigation, agreed design, review findings and delivery evidence.

Changes are incremental over the already dirty working tree. Main, preload, IPC contracts and dependency files received no edits from this task.

### Acceptance evidence

| Criterion | Result | Evidence and limit |
| --- | --- | --- |
| 1: resized panel restores on reopen | NOT VERIFIED | Installed layout calls the new workspace-first `get` and routed `store`; relaunch was not exercised |
| 2: independent project sizes | NOT VERIFIED | Each surface uses its existing `workspace:<id>` database; multi-project runtime behavior was not exercised |
| 3: background first activation avoids zero-size collapse | NOT VERIFIED | Root min-size hold precedes initialization and preserves positive axes; browser grid clamping was not observed |
| 4: detach/reattach preserves size | NOT VERIFIED | Existing transfer code is unchanged; zero-viewport root hold retains prior usable dimensions; transfer was not exercised |
| 5: maximize, dock and visibility | NOT VERIFIED | Both last-non-maximized dimensions are routed, and panel size/position/visibility watchers schedule a full layout flush; UI flow was not exercised |
| 6: legacy fallback, defaults and current seed | NOT VERIFIED | Default seeding uses `super.store`; workspace reads win and normal saves refresh PROFILE; migration was not exercised |
| 7: native visibility and root protection | NOT VERIFIED | Native code is unchanged and min-size protection is present; Electron rendering was not observed |
| 8: authorization, zoom and logical-width contracts | PASS (source) | Main and its tests match the saved baseline; no IPC changes; the hold never writes logical `style.width`; existing write parameters are forwarded |
| 9: save shortly after panel changes | NOT VERIFIED | One trailing 200ms scheduler covers size, dock and visibility events; actual persistence timing was not measured |

### Verification performed

Read-only source and diff review only. These commands compared the current task against its saved baseline; `diff` exit 1 means expected differences, not a failed test:

```sh
diff -u /private/tmp/workbench-terminal-position-baseline/storage.ts apps/desktop/src/renderer/src/workbench/storage.ts
diff -u /private/tmp/workbench-terminal-position-baseline/entry.ts apps/desktop/src/renderer/src/workbench/entry.ts
diff -u /private/tmp/workbench-terminal-position-baseline/entry-u1.ts apps/desktop/src/renderer/src/workbench/entry.ts
cmp -s /private/tmp/workbench-terminal-position-baseline/workbench-surface.ts apps/desktop/src/main/workbench-surface.ts
cmp -s /private/tmp/workbench-terminal-position-baseline/workbench-surface.test.ts apps/desktop/src/main/workbench-surface.test.ts
```

Codex inspected actual changes, installed signatures, Code-OSS load/save consumers, window resize listener registration, scheduler cancellation and the database flush path. Claude independently investigated, challenged the plan, implemented both units and performed the final integrated adversarial review. Typecheck, lint, format, unit/integration tests, build and UI verification: NOT RUN, per the standing user instruction.

### Regression coverage and remaining risks

Source review covered unrelated storage pass-through, trust/terminal environment handling, defaults, root sizing, wheel/reveal semantics, dock/maximize/visibility paths, overlay and native geometry preservation, and observer feedback. No automated coverage was authored for the two new helpers or storage overrides. Code and API compatibility were read, not compiled.

Closing in the roughly 300ms-plus-IPC save window can still lose the last change. A legacy squashed value remains until the user resizes it. Available screen geometry, actual observer delivery, shrink behavior and relaunch persistence remain unobserved. Seed write-through can add file rewrites; underlying storage write errors retain existing behavior.

### Scope deviations

U2 was added after review because idle/blur-only saving missed the user's last-position outcome. It remains limited to panel layout changes. The proposed main-process lifecycle/geometry changes were dropped; global terminal behavior, transcript scrollback, sidebar settings and the earlier chat-row feature were not changed.
