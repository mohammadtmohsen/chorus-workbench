# Open a chat before its agents finish starting

## Status

| Unit           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope          | Full build requested for +, restart and forward/continue; Codex leads, Claude implements and reviews                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Research       | Both traced the shared awaited provider boot; source confirms the tab is adopted only after startup settles                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Design         | Challenged against source by Claude; accepted deferred event creation, per-participant cancellation, guarded shutdown, starting-room reopen/relocate checks, stale-snapshot protection and ready-control gating                                                                                                                                                                                                                                                                                                                   |
| Implementation | U1 and U2 implemented and corrected after Codex review. The final Claude adversarial review found F1 (high: restart remounted the replacement when its source closed, losing the draft typed during boot; reproduced by Codex) and F2 (low: note-selection send to a starting chat raised a raw not-active error). Both corrected. F1 verified by a unit test and a before/after runtime retention run. F2 source-reviewed, linted and built, not driven at runtime. Claude's review of the corrections found no supported defect |
| Verification   | Latest: 298 tests passed across 13 focused and layout files. Changed-file ESLint, selected Prettier and the desktop build passed. Node typecheck passed in the integrated check, and main has not changed since. Web typecheck is blocked only by concurrent TerminalPanel.tsx:139; the full tsconfig also reports concurrent TrafficPanel.test.tsx:395. Fake-provider timing and restart retention runs completed                                                                                                                |

## Current / Issue

`App.startIn` adds and adopts the new tab only after `startConversation` resolves. Main waits for all agents' health, session startup, effort setup and service attachment. Restart and the forward arrow (`onContinue`, which carries the transcript) use the same path. Recent-version caching and the prior render/query improvements do not remove this readiness wait.

The user now wants the new chat box to appear immediately, before agent readiness. This changes the previous plan's decision to retain the wait before opening. Provider startup itself still takes time. The UI must expose that state honestly and allow drafting without losing a message through a premature send.

Main mints conversation IDs. Transcript, workspace, carry and draft state use that ID, so the tab should use its permanent ID from its first mount. Active participants must retain their existing ownership. Registering an empty active room would expose methods that assume ready services and make closing a booting room unsafe.

## Proposed

Main owns a separate record for each starting conversation. Begin validates the adopted root and read-only/empty-cast guards, resolves the profile with its existing safe fallback, captures title/grants/style, mints the permanent ID and publishes starting metadata. It appends nothing. The boot first yields a macrotask, then checks cancellation before reconstructing the carry, appending `conversation.created` with `continuedFrom` only for real carried context, appending its notice, and starting providers. Cancelling before preparation appends no ghost row. The begin response does not await a provider or full-history read. The first transcript read may queue behind deferred preparation on main, but the new box must already be available. Frame/IPC ordering needs measured evidence; a macrotask alone is not a zero-latency guarantee.

Keep `startConversation` and `conversation:start` as awaited compatibility paths with the same ready result and failure message. Add `conversation:begin` and `conversation:awaitStart` to the validated IPC contract and preload bridge. Derive await outcomes: a starting record exposes its completion promise; an active room supplies ready metadata; a FIFO-capped cache retains the most recent 64 unconsumed failures; otherwise the result is cancelled. Remove cached failures when consumed or closed and clear them on shutdown. This bounds abandoned failures without retention timers. A ready room closed before a late await reads as cancelled. Cancelled legacy awaited calls reject rather than returning a cancelled object. The await method must capture an existing record before awaiting so a later failure-cache eviction cannot alter an already waiting caller.

`activeSessions` includes starting metadata with no ready participants. Add a backward-compatible starting field to its schema; existing callers without the field mean ready. Starting records are not added to the ready participant map. Preserve the permanent ID through the ready transition. Do not persist a half-started room as a ready conversation.

On successful boot, publish the ready participants and preserve seed context, partial-failure logging and captured settings. Remember a draft in the starting record in memory and transfer it to the ready room before its first persistence write; typing during startup must not be lost on a later ready-room restore. An all-agent failure removes the starting room and reports the joined error. Cancellation closes participants already ready and each later participant immediately as it completes, without waiting for the slowest agent. Give each participant one cleanup owner and keep cleanup promises handled. Carry a cancellation/closing guard through participant startup, checking after asynchronous health/start/effort/attachment boundaries before reading database-backed state, attaching or querying `lastSeq`. A late raw session must close without touching a closed database.

Shutdown marks the runtime closing first, refuses begin and cancels every starting record. It waits at most 3,000ms for startup and cancellation cleanup before adapter disposal and the existing shutdown sequence. Clear the deadline timer on early completion. Late completions remain cancelled and close themselves; they cannot register or query the closed database. Existing store append calls after closure are dropped by the store, which is a documented residual limit rather than a reason to allow reads on a closed handle. The three-second bound is Codex's implementation choice to prevent an unbounded provider boot from blocking quit.

Reopening an already starting ID returns its starting metadata without a second boot. History/list metadata must mark it open while starting. Relocation refuses a project with starting rooms. Forgetting a project cancels them before removal; late participants close without needing the removed registry entry. Project-profile changes during a captured startup remain a snapshot race; gate the relevant project fan-out controls in U2 rather than claiming new policy propagation.

App opens/adopts the begin result immediately, then awaits readiness. A successful restart ends its source only if both source and replacement remain open. Failure removes the replacement and keeps its source, with error and removal in the same update. Cancellation or a stale begin/completion cannot reopen the tab or end its source. Ignore duplicate restart requests for the same source while its replacement is pending; separate + gestures remain independent. Count in-flight operations instead of clearing a shared starting boolean on the first completion. Update the session ref synchronously when applying changes: its current implementation updates inside React's state updater, which may run later and cannot safely decide whether a just-closed replacement is still present.

The conversations-changed handler reconciles startup/participant changes while retaining unchanged object identity. Drop older requests by sequence; a given ID cannot go from ready back to starting. Also invalidate pre-mutation reads and guard locally closed IDs before publishing UI removal. Request sequencing alone does not cover the interval before main handles a close, and a delayed begin reply must not re-add a tab closed after its earlier starting broadcast. Keep the close guard until both start replies and snapshots can no longer revive it. Detached views receive the same state with existing ownership and placement rules.

Session and Composer show a translated starting status. Typing, attachments and caret remain available. Return early inside `send` as well as disabling its button while starting. Answer-style reads use the starting record's captured style, and its toggle waits for readiness. Gate rename, per-conversation profile changes and the project plan/profile fan-out while a relevant room is starting. Command-list warm-up already tolerates missing services and the open menu retries. The ready transition updates props without changing the key or remounting Session. Preserve failed-agent addressing after partial startup.

## Code changes and order

U1 introduces the main-owned lifecycle, validated IPC and bridge as one reviewable unit. Expected existing files are `main/runtime.ts`, `main/ipc.ts`, `shared/ipc.ts` and `preload/index.ts`. Add focused runtime lifecycle coverage beside the existing fake-adapter harness and extend relevant IPC/schema coverage. Preserve the old awaited API so the renderer continues functioning before U2 lands. Codex reviews the actual diff and runs the relevant authorized checks before the next unit.

U1 as implemented, then corrected after the first run:

- `runtime.ts`: `startConversation` is now `beginConversation` plus `awaitStart`, with the same ready result, the same joined failure message, and a rejection when the room is closed before it starts. `beginConversation` is synchronous: it checks shutdown, the cast, the adopted root and the read-only flag, mints the id, captures profile, grants, title and style, stores a `StartingConversation`, fires `onConversations` and returns. It appends nothing.
- `bootStarting` first yields one `setImmediate`, then returns if cancelled. Only then does it compose the carry, append `conversation.created` (with `continuedFrom` only for a real carry) and the notice, and start the agents. The rest of the boot is the previous code, except that the draft comes from the starting record and registration also removes the record.
- Each agent promise either closes itself, if the room was cancelled, or joins `started`. `cancelStarting` sets the flag, removes the record, settles `cancelled` immediately and closes everything in `started`. Each participant therefore has one cleanup owner.
- `startParticipant` takes an optional `stopped` guard. Everything after the session opens now runs in a new `joinParticipant`, the same code at the same indentation. `startParticipant` catches any exception from it and closes exactly one owner before rethrowing the original error: the service once `attach` has been reached, because `attach` takes the session first; otherwise the raw session. The guard is checked after health, at the start of `joinParticipant`, after effort and after attach, and each check simply throws so cleanup stays in one place. Existing callers pass nothing and behave as before.
- `awaitStart` resolves, in order: the record's settled promise (captured before awaiting); a cached failure (removed when read); ready metadata from `active`; otherwise `cancelled`. Failures are capped at 64, oldest first, removed on close of that id and cleared on shutdown. There are no retention timers.
- `close()` sets `closing`, cancels every starting record, and waits at most 3,000ms for tracked boot and cleanup work, re-snapshotting work added during the wait. It clears the deadline timer, then runs the existing sequence. Late completions close themselves with reason `shutdown`. The final step is now `this.store.close()` instead of `this.db.close()`, so the store's `closed` flag is set and a late append is refused and counted rather than reaching a closed handle. The runtime no longer keeps the raw handle; the store owns the one every subsystem shares.
- `failStart` makes a failed boot leave nothing behind. It removes the starting record, closes every participant the boot already started, and removes a registration the boot had already made, rewriting the reopen list and logging if that rewrite fails. It then caches the failure and notifies. If `failStart` itself throws, the start still settles as failed, so no awaiter hangs.
- `activeSessions` appends starting rooms, with `participants: []`, `unread: 0` and `starting: true`. `reopenConversation` returns that same entry for a starting id, without booting. `listConversations` marks it open. `relocateProject` counts it. `forgetProject` cancels it before closing active rooms. `rememberDraft` writes to the record. `answerStyle` falls back to the captured style.
- `shared/ipc.ts`: the start request and response schemas move unchanged, comments included, into `StartConversationRequest` and `StartedConversationShape`. `conversation:start` and the new `conversation:begin` share them. `conversation:awaitStart` answers `ready`/`failed`/`cancelled`. `OpenSessionSchema` and the reopen response gain an optional `starting`, where absence means ready. `ChorusApi` and the preload gain `beginConversation` and `awaitStart`.
- Tests: new `main/conversation-start.test.ts` with gated fake adapters and no real providers. Cases added to `main/ipc.test.ts` and `shared/ipc.test.ts`.

First run, by Codex, against the five focused files: 112 passed and 1 failed, the forward test at `conversation-start.test.ts:138`. It read `claude.sessions.at(-1)`, which was the topic-naming session that `send` starts through the same adapter, not the room's own agent. The main-process typecheck and changed-file ESLint passed. Prettier flagged `shared/ipc.test.ts` and this plan.

Corrections after review:

- The forward test now finds the room's Claude session through its `session.started` `sessionRef` and the fake session holding the same ref. Carry behaviour is unchanged.
- Exceptions after the session opens close it once, through the single owner above. A new case makes the log refuse `session.started` during `attach`, then asserts the original error, exactly one close, and no room.
- A failure after agents have started, before registration, closes them. A case makes the partial-failure `error.raised` append throw. A failure after registration rolls the room back: it leaves `active` and the reopen list, and its agents close. A case uses a conversations listener that throws once, after registration.
- Shutdown closes the store itself. A case holds an attached agent's close past the deadline, then releases it. The late `session.ended` is dropped and counted, nothing throws, and both the attached and the raw session end closed.
- Formatting: Prettier's only change in `shared/ipc.test.ts` is in the concurrent project-shell case (`terminal:dispose`), not in this unit's block, so that file was left alone. This plan was formatted.

Deviations and limits found while implementing:

- The `starting` field is optional rather than defaulted. A default would have made it required on `conversation:restore`'s output type, with no benefit.
- The carry comment now reads "appended" instead of "minted", because the carry is composed after the id exists.
- Between U1 and U2, the current renderer adds a starting room through conversations-changed with `participants: []`. Its add-only handler then keeps that entry, so rail agent chips and `soleAgent` stay empty for that room until relaunch. U2's reconciliation closes this.
- An agent that finished `attach` before the cancel was seen still writes its join and `session.ended` rows into the cancelled room's log.
- The earlier "attach in flight" limit does not apply to today's synchronous `attach`. Any thrown setup step is now cleaned up by its single owner.
- After the 3,000ms bound, late writes are refused by the closed store and counted. Late reads are prevented by the startup guards. A provider start that never resolves still holds its own process until it settles or the app exits.
- Concurrent project-shell terminal edits landed in `runtime.ts` and `shared/ipc.ts` during U1 (`runAvailable`, the `shell` scope, `shellRoot`, `shellEnv`, `disposeProjectShells`, and the shell IPC tests). They were preserved and not reformatted.

U2 switches App to begin/await, reconciles startup updates and gates Composer readiness. Expected files are `renderer/src/App.tsx`, `Session.tsx`, `Composer.tsx`, `workspace/ProjectSettings.tsx` and `i18n/en.json`, plus focused tests. Extract a narrow reconciliation or startup hook only if it supplies a meaningful test seam for these asynchronous paths. No temporary conversation ID, custom memo comparator, separate fake transcript or new state library. Existing `SessionHost` ownership and keys stay intact.

U2 as implemented, then corrected after the first run:

- `useConversationStarts.ts` is a new hook, and the only new seam. It owns three things: the in-flight count, the restart guard, and conversations-changed reconciliation. App supplies `role`, the profile, `sessionsRef`, a `closedIds` ref, `updateSessions`, `finishEnd`, `refreshProjects` and error reporting.
- `startIn` calls `beginConversation` and adopts the tab the moment main answers. It then awaits `awaitStart` separately:
  - ready: updates participants and phase on the same object position;
  - failed: removes only that chat and reports its error in the same tick;
  - cancelled: main no longer has the room, so the chat and its tab are removed locally if still listed. There is no error and no second close over IPC, and the source is kept.
    +, restart and forward all share this path.
- A begin reply for an ID already listed (for example, already ready from a snapshot) does not overwrite it. A begin reply for an ID closed locally in the meantime is dropped before insert, adopt or await.
- Restart ends its source only when the replacement is ready and both chats are still open. A second restart of the same source is ignored while one is pending.
- The count rises for each start and falls in a `finally`, so begin refusal, failure, cancellation and a dropped reply all balance it.
- Reconciliation numbers its reads and applies only the newest. Every local mutation (begin insert, ready, failure) issues a fresh read, so an older read can neither remove nor revive a chat.
- `advanceSession` moves a chat from starting to ready, or updates a ready chat's participants. It never moves a ready chat back to starting, and returns the same object when nothing changed. That keeps plan 11's memo boundary intact.
- Locally closed IDs (`finishEnd` adds them) are filtered from snapshots. They are pruned only once a snapshot no longer lists them and no begin reply is still outstanding. History reopen clears the guard for its ID.
- Detached scoping, adoption and detached clean-up keep their previous rules.
- `App.tsx`:
  - `updateSessions` writes `sessionsRef` synchronously, then publishes state.
  - The `starting` boolean and the old conversations-changed effect are replaced by the hook.
  - Rename and per-conversation profile changes do nothing while that chat is starting.
  - The `startIn` comments moved with their code into the hook. "The `catch` below" now reads "the failure path".
- `Session.tsx`: `SessionInfo.starting?: boolean | undefined`, passed to Composer.
- `Composer.tsx`: a required `starting` prop. `send` returns before touching the draft, which covers Enter and submit alike. The send button and the answer-style toggle are disabled, and a translated `conversation.agentsStarting` status reuses the existing preview row, so no CSS changed. Typing, attachments and the caret are untouched.
- `ProjectSettings.tsx`: profile choices, plan fan-out and relocate are disabled while any of the project's chats is starting.
- Tests:
  - `useConversationStarts.test.tsx` drives held begin/await/read promises through a fake bridge. It covers:
    - opening before readiness;
    - ready identity;
    - fast ready beating begin;
    - concurrent starts and counting;
    - begin refusal;
    - failure;
    - forward;
    - restart success, failure, close, cancel and duplicate;
    - a delayed begin after local close;
    - out-of-order and stale-starting snapshots;
    - snapshot readiness with identity;
    - detached scoping.
  - `Composer.test.tsx` covers Enter, submit and button blocking with draft, attachments and status, then the same mount turning ready: draft, attachments and caret kept, and it sends.

First run, by Codex:

- The four focused renderer files (`useConversationStarts.test.tsx`, `Composer.test.tsx`, `SessionHost.test.tsx`, `i18n/en.test.ts`): 27 passed.
- Renderer `tsc`: stopped only at the existing `TerminalPanel.tsx:139` project-terminal union, outside this plan.
- ESLint: one `no-unnecessary-type-assertion` error, on the test's `detached` fixture.
- Review found two gaps. First, an older read could overwrite or remove a session that App changed outside the hook. Second, a cancelled start left its starting tab behind.

Corrections:

- App owns a `sessionsRevision` ref, bumped synchronously by every `updateSessions`. Each read records its ticket and that revision, and applies only if both are unchanged. If only the revision moved, the hook reads again rather than losing what changed in main. Its own accepted reconciliation bumps the revision normally. The test harness mirrors this.
  - New case: an older read resolves after an insertion elsewhere. The chat survives, a fresh read follows, and identity is kept.
  - New case: the same after an update elsewhere.
- A cancelled outcome now follows the failure path without its error. It guards the ID, removes a still-listed chat and its tab locally, and issues a fresh read. It never calls `finishEnd`, so there is no second close over IPC.
  - The restart test now expects the cancelled replacement gone, with its source kept and no error.
  - New case: a chat cancelled while visible, with no later push. It is removed, no error is reported, and neither an older nor the newest starting snapshot brings it back.
- The `detached` test fixture is a typed declaration, not an assertion.
- The Composer same-mount test now sets a selection range before readiness. It asserts `selectionStart` and `selectionEnd` after the ready re-render, alongside focus, draft and attachment.

Limits noted while implementing:

- Rename and profile changes are silently ignored while starting; they do not show a message.
- Reopen from history, aside promotion and restore go through `updateSessions`. Its revision bump now invalidates any read already in flight, which closes the stale-read exposure noted in the first version.
- Restart and Continue stay available on a starting chat. Restarting it cancels or ends it after the replacement is ready.
- The `Session.tsx` Prettier warning is the existing multiline `workspace/hooks` import, unchanged.

Codex reviews the integrated change. Claude then challenges the final diff for production bugs. Validated findings are corrected and relevant checks rerun. Deliver reviewed local source and verification evidence; packaging, installation and publishing are not requested.

## Acceptance and verification

| Criterion                                                                                 | Required evidence                                                                                                                                                | Current result                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| +, restart and forward open the new focused chat without provider boot                    | Hold fake adapter startup unresolved and assert begin metadata and the new UI are available; measure the visible boundary in an isolated runtime where practical | PASS with fake providers: visible in 12.3–18.7ms against a 1,520.4–1,547.3ms awaited control. Real providers not measured                                                                                          |
| Forward does not wait for reconstruction of a large carried chain before exposing its tab | Inspect preparation ordering and exercise a controlled continuation; context notice and first-message seed remain correct                                        | PASS: runtime test for ordering and seed; isolated run with a 600-turn source                                                                                                                                      |
| No premature send loses a draft or attachments                                            | Submit/button blocked during startup; type then update readiness on the same mount and verify draft, attachments and caret                                       | PASS. Composer tests; two Add runtime trials; restart retention, where F1 reproduced, was corrected, and two rounds then kept node, draft and selection. Forward typing not measured; attachments unit-tested only |
| Restart preserves its source on failure or cancellation                                   | Hold/fail startup, close the replacement and verify the source was not ended; success ends it after readiness                                                    | PASS: focused hook tests                                                                                                                                                                                           |
| Closed starting chats do not resurrect or leak agents                                     | Close before/after one participant completes, then settle remaining agents and assert cleanup/no active registration                                             | PASS: focused runtime and hook tests                                                                                                                                                                               |
| Partial failure retains ready agents and current error behavior                           | Fake adapters with mixed outcomes; verify participants, transcript errors and seed context                                                                       | PASS: focused runtime tests                                                                                                                                                                                        |
| Fast completion and fast failure are observable by a later await                          | Complete boot before calling await; assert exact ready/failed/cancelled result and bounded outcome cleanup                                                       | PASS: focused runtime tests                                                                                                                                                                                        |
| Concurrent starts, project removal, shutdown and detached views remain consistent         | Target lifecycle and reconciliation seams, stale snapshots and owner scoping; no database writes after drain                                                     | PASS in focused tests. Detached end-to-end not run                                                                                                                                                                 |
| History reopen and relocation respect starting rooms                                      | Reopen does not spawn twice; relocation refuses while startup is pending; listing identifies the room as open                                                    | PASS: focused runtime tests                                                                                                                                                                                        |
| Shutdown has a bounded startup wait and safe late cleanup                                 | Hold a start forever, advance the three-second deadline, then release it and assert no database reads or late registration                                       | PASS: focused runtime tests, using the real 3,000ms deadline                                                                                                                                                       |
| Ready drafts survive persistence, and stale snapshots cannot undo local actions           | Type/save during boot then restore a ready room; resolve snapshots/begin replies out of order around close and readiness                                         | PASS: focused tests, plus restart retention after the F1 correction                                                                                                                                                |
| Old awaited start callers keep their behavior                                             | Existing session-defaults/read-only/IPC cases plus unchanged ready result/error semantics                                                                        | PASS: existing session-defaults, read-only and IPC suites                                                                                                                                                          |

Instant opening means removing readiness and history preparation from the visible boundary. It does not promise zero milliseconds on a busy OS. Report measured click-to-visible latency separately from provider boot. Do not count a spinner on the old chat as a newly opened chat.

Relevant project commands are focused desktop `test` calls for the new lifecycle/Composer/reconciliation files and existing `session-defaults.test.ts`, `profile-readonly.test.ts`, `main/ipc.test.ts` and `shared/ipc.test.ts`; changed-file ESLint; desktop typecheck and build. GUI checks use an isolated synthetic database and fake or stub providers, with no real messages or external provider costs. Existing full-typecheck failures in concurrent terminal, traffic and project-tool work are tracked separately. Do not repair unrelated work to obtain a green run.

## Risks and scope

The main risks are orphaned late agents, an unconsumed outcome leak, stale snapshots removing or reviving a room, and a ready transition remounting a composer. A renderer close must win over a late success. Shutdown must drain this new lifecycle. Draft durability across a process exit while agents are still starting is not promised by today's persistence; avoid silently claiming it.

No changes to the original dead × diagnosis, streaming reduction, transcript virtualization, terminal/traffic behavior, provider credentials, dependency versions or packaging. Existing plan-11 improvements and concurrent work remain intact. Scope grew beyond opening in two places. The first is the cancellation and cleanup needed to make the newly visible starting state safe. The second is a stable column key in `workspace/EditorPane.tsx`: restart needed it so the replacement is not remounted when its source column closes (F1).

Codex U1 correction review: the incremental diff preserves the seed path and corrects the test to follow the participant session ref rather than the independent namer. Acquired-session cleanup is centralized, final boot failure rolls back registration and closes owned participants, and shutdown calls EventStore.close to refuse late appends. The focused rerun passed all 118 tests; node typecheck and changed-file ESLint passed. A Prettier warning in shared/ipc.test.ts belongs to the concurrent shell assertion and was left untouched. No visible opening speed is claimed before U2.

## Integrated verification by Codex

The integrated focused run passed 148 tests across nine files. The U1 rerun passed 118 and the corrected renderer run passed 30. Exact commands:

```sh
pnpm --filter @chorus/desktop test src/main/conversation-start.test.ts src/main/session-defaults.test.ts src/main/profile-readonly.test.ts src/main/ipc.test.ts src/shared/ipc.test.ts src/renderer/src/useConversationStarts.test.tsx src/renderer/src/Composer.test.tsx src/renderer/src/SessionHost.test.tsx src/renderer/src/i18n/en.test.ts
pnpm --filter @chorus/desktop exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @chorus/desktop exec tsc -p tsconfig.web.json --noEmit
pnpm --filter @chorus/desktop exec tsc -p tsconfig.json --noEmit
pnpm --filter @chorus/desktop build
```

The node check and build passed. The web check is blocked only by the concurrent project-terminal reference union at TerminalPanel.tsx:139. Changed-file ESLint passed for all product and test changes. Prettier passed the selected U1/U2 files and plan; pre-existing Session.tsx import formatting and the concurrent shared/ipc.test.ts shell assertion were excluded from that final formatting selection.

### Isolated visible-boundary timing

Artifacts: `/private/tmp/workbench-instant-profile-20261003/v3/runtime.json`, with preparation and driver scripts at `/private/tmp/workbench-instant-profile-20261003/{prepare-v3,run-v3}.mjs`. Launcher: `node /private/tmp/workbench-chat-profile-20261003/runtime.mjs --instant-v3`. The copied production renderer and main lifecycle use fake adapters with a fixed 1,500ms start delay. No real provider is launched and no external message is sent. A 600-turn source fixture tests Forward. The comparison is an awaited-response control: only its temporary preload begin bridge calls the existing awaited start channel. It is not a full historical build baseline.

Each action ran twice per mode. Timing starts at the real toolbar click and ends at the second requestAnimationFrame after the new visible composer is found. This bounds a rendering opportunity, rather than measuring physical display scan-out. Control paint timings were 1,520.4–1,547.3ms (median 1,530.45ms). Begin timings were 12.3–18.7ms (median 14.35ms). All six begin observations showed Starting agents…, a disabled send button, the composer focused, and main still reporting the room as starting. Their later ready lists contained all three fake participants. Both Add trials typed through boot and pressed Enter while starting; the same textarea retained the draft and selection [4,10], and the ready runtime retained the draft. Attachment preservation is covered by the Composer test, not this runtime driver.

Two earlier timing attempts stopped after a duplicated toolbar label selected another mounted column; their partial artifacts remain at the parent directory. The corrected driver scopes to the active composer, verifies the hit target, and completed without renderer errors. These are controlled local measurements, not a latency guarantee for every machine, native drag-region behavior, or real provider startup.

### Final correction verification by Codex

Latest command:

```sh
pnpm --filter @chorus/desktop test src/main/conversation-start.test.ts src/main/session-defaults.test.ts src/main/profile-readonly.test.ts src/main/ipc.test.ts src/shared/ipc.test.ts src/renderer/src/useConversationStarts.test.tsx src/renderer/src/Composer.test.tsx src/renderer/src/SessionHost.test.tsx src/renderer/src/i18n/en.test.ts src/renderer/src/workspace/EditorPane.test.tsx src/renderer/src/workspace/layout.test.ts src/renderer/src/workspace/store.test.ts src/renderer/src/workspace/row-scroll.test.tsx
```

Results:

- 298 tests passed across those 13 files.
- The five renderer suites including `EditorPane.test.tsx` passed 31.
- ESLint passed for `EditorPane.tsx`, `EditorPane.test.tsx` and `App.tsx`.
- Prettier passed `EditorPane.test.tsx`, `App.tsx` and this plan. The existing multiline import in `EditorPane.tsx` was left untouched.
- `pnpm --filter @chorus/desktop build` passed.
- Web typecheck reports only the concurrent `TerminalPanel.tsx:139` project-terminal union.

Restart retention:

- Launcher: `node /private/tmp/workbench-chat-profile-20261003/runtime.mjs --instant-retention [--after]`. Scripts: `prepare-retention.mjs` and `run-retention.mjs` in `/private/tmp/workbench-instant-profile-20261003/`.
- Each round restarts a single-chat project with the 1,500ms fake-provider start, types and selects while it is starting, presses Enter (blocked), and waits for the source to be removed at readiness.
- `retention-before/runtime.json`: a new textarea, an empty draft and selection [0,0]. Focus was still true through autofocus.
- `retention-after/runtime.json`: two rounds, each with the same textarea, the draft "restart draft kept through boot", selection [4,10] and focus true. No renderer errors.

Changed files for the whole plan:

- Main and IPC: `main/runtime.ts`, `main/ipc.ts`, `shared/ipc.ts`, `preload/index.ts`.
- Renderer: `App.tsx`, the new `useConversationStarts.ts`, `Session.tsx`, `Composer.tsx`, `workspace/ProjectSettings.tsx`, `workspace/EditorPane.tsx` and `i18n/en.json`.
- Tests: the new `main/conversation-start.test.ts`, `useConversationStarts.test.tsx`, `Composer.test.tsx` and `workspace/EditorPane.test.tsx`, plus additions to `main/ipc.test.ts` and `shared/ipc.test.ts`.

## Final adversarial review by Claude

Source reviewed: the integrated diff and snapshots under `/private/tmp/workbench-instant-chat-final-review/`, which matched the working tree file for file, plus the surrounding renderer layout code. I ran no checks and made no product edits.

### F1 (high, reproduced by Codex, corrected in source): restart lost what was typed during boot

- `adoptConversation` calls `openBox`, which calls `placeBox(..., 'right')`. That puts the restart replacement in a new top-level column at `sourceColumn + 1` (`layout.ts:1013-1028`, `:984-1011`).
- EditorPane keys those columns by position, `<Fragment key={index}>` (`EditorPane.tsx:427-428`).
- At readiness, `settle` calls `finishEnd(source)`, and `removeSession` closes the source tab (`store.ts:798-826`). If the source was the only tab in its group, `normalizeTree` prunes the emptied group, and the replacement column shifts down to the source's index.
- That key's instance previously rendered the source's `SessionHost`, keyed by the source ID. It now renders the replacement's ID, so the replacement's existing subtree is unmounted and a fresh one mounted.
- The fresh Session reads `props.carry` during render, through `renderSession`'s `carries.current.get(id)`. That is before the old instance's unmount cleanup writes the carry, so the new chat mounts with no carry, and its draft, attachments, caret and scroll intent reset. The reproduction confirmed a new node, an empty draft and a reset selection. Focus stayed, through autofocus.
- The common case is a project holding one conversation, restarted while the person types into the new box.
- The awaited-control restart rows in the earlier timing run reported `focused: false`. That run did not isolate the cause, and the reproduction showed focus kept, so focus loss is not claimed.

Smallest correction: key the top-level columns by a stable group ID rather than by position. In `EditorPane.tsx:428`, use `<Fragment key={leafPaneIds(column)[0] ?? index}>`, importing `leafPaneIds` from `./layout.js`. The replacement's column keeps its key when the source column is pruned, so nothing remounts, and the side-by-side layout during boot is unchanged.

The other option is to open the restart replacement as a tab in the source's own group. That needs a new store action over `openSession(arrangement, id, groupId)`. It changes what the person sees during boot.

The key change also fixes an older hazard in the same place: closing any column to the left of another chat remounted that chat and dropped its unsent draft.

Reproduction, by Codex: isolated Electron with the existing 1,500ms fake-provider start, artifact `/private/tmp/workbench-instant-profile-20261003/retention-before/runtime.json`. A single-chat project was restarted and the replacement typed into while it was starting.

- Before readiness: the draft read "restart draft kept through boot", the selection was [4,10], and the composer had focus.
- After the source closed: the textarea was a different node, the draft was empty and the selection was [0,0].
- Focus was still true, through the composer's autofocus, so focus loss is not claimed.

Correction made (`EditorPane.tsx`): the column `Fragment` is now keyed `leafPaneIds(column)[0] ?? index`, using the existing `leafPaneIds` helper. `columnWidths` already identifies a column by the same first-leaf ID.

- When the source column is pruned, the replacement's column keeps its key.
- Inside that `Fragment`, the conditional sash at index 0 becomes `false` in the same child position, so the `conversation-slot` keeps its position and does not remount.
- Widths and paths are still read by index, so the measured widths, branch paths and side-by-side boot layout are unchanged.
- `SessionHost` keys are untouched.

New regression test, `workspace/EditorPane.test.tsx`:

- It mounts the real `EditorPane` and the real workspace store with a two-column arrangement. Only unrelated surfaces are stubbed: the tab strip, the workbench, the notes, traffic, the project terminal, and the two `window.chorus` push hooks.
- It types into the right-hand chat, and sets a selection.
- It removes the left chat through the store's own `removeSession`, which collapses the arrangement to a single leaf, and re-renders without that chat.
- It asserts the right chat's textarea is the same DOM node, with the same draft and selection.
- Under the old index key this case remounts the chat, so the test discriminates. It passed in Codex's run.

Both checks proposed in the first version of this review were added and run: the restart retention driver and the EditorPane render test. Results are in "Final correction verification by Codex" above.

### F2 (low, supported by source, corrected): note-selection send to a starting chat

`App.sendNoteSelection` (`App.tsx:1359-1361`) sends the project note selection to the pad's active chat with no starting check. For a chat still starting, main's `send` throws "Conversation … is not active", and that is shown as an error. The note text is not lost.

Smallest correction: return early when `stillStarting(conversationId)`. Ideally the pad's send control would also reflect readiness, but that is a separate component.

Correction made (`App.tsx`): `sendNoteSelection` returns early when `stillStarting(conversationId)`, with `stillStarting` in its dependencies. The pad only dismisses its selection pop-up before calling, so the note text stays available. There is no new message and no notes UI change. It is source-reviewed, linted and built. The note-selection action itself was not driven at runtime.

### Checked and found sound

- The main starting record, which appends nothing until the boot yields.
- Deferred `conversation.created` with the existing `continuedFrom` semantics.
- Per-participant ownership with one cleanup owner, across `joinParticipant`, the boot's `.then`, `started` with `cancelStarting`, and `failStart`. No double close.
- Rollback after registration, the 3,000ms drain before adapter disposal, the late raw-session close without a database read, and `EventStore.close()` dropping late appends.
- Await answered from the record, the cache, active or cancelled; the 64-entry cap.
- Reopen returning the starting entry; forget cancelling; relocate refusing.
- Draft transfer at registration.
- Renderer ticket plus revision guards with re-read, closed-ID pruning gated on outstanding begins, and delayed begin and ready replies.
- Restart ending its source only when both chats are open, cancelled-tab removal without IPC, Composer `send` returning before draft clearing, and the settings gates.
- A session-scope terminal for a starting chat would resolve its folder to the home directory (`cwdFor` reads `active`). `useSessionTerminal` has no renderer caller, so this is not reachable today.

### Measurement check

- Recomputed from `v3/runtime.json`: begin paint 12.3–18.7ms, median 14.35ms; control 1,520.4–1,547.3ms, median 1,530.45ms. Both match the record above.
- All six begin rows show the starting status, send disabled, focus, and main reporting starting.
- The draft and selection are proven through readiness for the two Add trials in `v3`, and, after the F1 correction, for two restart rounds in the retention run. Forward did not type through boot.
- The control and begin paths share the copied production renderer and main. The clicks are DOM clicks on hit-tested elements, not OS input.

Not verified, and not claimed:

- real provider startup speed;
- latency on other machines;
- detached-window behaviour end to end;
- native drag-region hit testing;
- Forward typing through boot;
- the note-selection send at runtime;
- the original dead-× diagnosis.

### Correction review by Claude

I reviewed the actual F1 and F2 diffs and the new test against source, read both retention artifacts, and found no supported defect. I ran no checks.

- The key `leafPaneIds(column)[0] ?? index` cannot collide, because group IDs are unique in an arrangement and every column has a leaf. The fallback is unreachable for a valid layout.
- When a column to the left is pruned, the surviving column keeps its key. Its conditional sash becomes `false` in the same child position, so the slot is reused. This matches the after-fix artifact: same node, draft and selection [4,10].
- Widths and branch paths are still derived by index from the current arrangement, so no saved width moves to the wrong column.
- Dragging a column into a new order now moves its DOM instead of remounting it, so its chat keeps its state. A moved focused element can lose focus, which the old remount also did. No code was found that depended on the remount.
- The new test discriminates. Under index keys the slot at key 0 would switch from the source's chat to the replacement's, with a different `SessionHost` key, and so remount it.
- F2: `stillStarting` is declared before `sendNoteSelection`, it reads the synchronous session ref, and it is in the dependency array. The pad keeps the note text. The early return gives no feedback while the chat starts, as this round's scope required.

Limits that remain, none introduced by the corrections:

- A change to a column's first group inside a vertical split still changes that column's key and remounts it. Under index keys the same change remounted it too, because the element type changed.
- Chats inside a vertical split are still keyed by index in `ConversationTree`.
