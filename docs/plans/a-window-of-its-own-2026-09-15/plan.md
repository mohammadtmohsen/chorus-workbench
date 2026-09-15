# A window of its own

## The problem

In VS Code, a tab dragged past the window's edge opens in a window of its own.
The ask is the same gesture for a Chorus project tab.

Today nothing happens. A tab dropped where there is no target — outside the
window included — is a silent no-op: `useTabDrag.ts:420-437` resolves `null` and
calls nothing. Only `clientX`/`clientY` are read (`:425-426`).

## What was settled before any code

Asked and answered on 2026-09-15.

- **One project per detached window.** Only its pane: the editor and its
  conversations. No rail, masthead, global notes or global terminal.
- **Its tab leaves the main window** while detached.
- **Closing the detached window returns the project** to the pane and position it
  left. If that pane is gone, to the end of the focused pane.
- **Dragging its tab onto the main window's tab strip returns it** at the slot it
  was dropped on.
- **The editor moves live.** Open files, unsaved buffers and the workbench
  terminal survive the move. No reload.
- **Clicking the project in the main rail focuses its window.** So does a
  notification about one of its conversations.
- **Ending its last conversation closes the window**, as it closes the tab in the
  main window.
- **Nothing is restored after a restart.** Chorus opens one main window, with the
  project back where it was.
- **One `App`, with a role.** Not a separate `DetachedApp`.
- **The detached window uses the standard OS title bar.**

## Corrections after review

codex reviewed this plan twice on 2026-09-15. Its shell could not read the repo,
so both reviews worked from excerpts and the plan pasted into the conversation.
Each item below is corrected in the sections that follow.

### First review

1. **The handoff did not revoke ownership.** It removed the view id from
   `byOwner`, but `ownedSurface` checks `surface.owner === caller`
   (`workbench-surface.ts:956-962`). The old renderer's close, 100ms after
   unmount, would still have destroyed the editor.
2. **Closing a window had one meaning.** A redock ends by closing the detached
   window, and a single `close` handler would have started a second return.
3. **"Four fork points" missed the auto-start** (`App.tsx:1013-1019`). It could
   open a new conversation in a detached window whose last one had just ended. It
   also counted one layout write where there are three (`:383-455`, `:743-748`,
   `:1309-1316`).
4. **The layout slice was read back from main**, which can be 180ms behind the
   main renderer's debounced write.
5. **A reload of the main window** would have lost the detached set, restored
   those tabs, and shown one project in two windows.
6. **`resolveTarget` needs a live drag's geometry**, which the main window does
   not have during a redock. And "drafts are flushed" named no mechanism.
7. **Fake tests were presented as covering the transfer.** They say nothing about
   Electron reparenting, window lifecycle, focus or IME.

### Second review

1. **The cursor was sampled after awaiting draft writes**, which can be long after
   release. And a redock flushed no drafts at all.
2. **The registry could not rebuild the main window after a reload.** It held no
   return slots and no slices.
3. **Closing a detached window by hand saved no drafts.**
4. **Grants were left with the old owner.** Revoking them is not the whole guard
   either: `{ projectId }` is authorised by adoption, not by window
   (`workbench-surface.ts:625-647`), so any window could still open a second
   surface for a detached project.
5. **Forced destruction after a claim had no path**, and the manual check did not
   test a source window closing right after the view left it.
6. **Return slots collided** when two projects left the same pane.

## What the code assumes today

Read on 2026-09-15. Each of these is a single-window assumption the feature has
to meet.

- **A workbench view belongs for life to the renderer that opened it.** `owner`
  is `event.sender`, and the parent window is derived from it once
  (`workbench-surface.ts:813-817`, `:868`). Every shell operation checks
  `owner === caller` (`:956-962`). The owner reloading or closing destroys the
  view (`:689-705`, `:762-781`). There is no transfer.
- **Any window may open a surface for any adopted project.** `redeem` authorises
  `{ projectId }` through the project registry, not the window
  (`workbench-surface.ts:625-647`).
- **A released view can only be adopted by the renderer that released it.**
  `WorkbenchFrame`'s `parked` map is module state (`WorkbenchFrame.tsx:44`,
  `:69-91`).
- **One saved layout for the whole app.** Every mounted `App` writes its entire
  snapshot from three places (`App.tsx:383-455`, `:743-748`, `:1309-1316`), and
  main replaces its copy wholesale (`runtime.ts:3644-3647`).
- **Restore resets main's snapshot.** `restoreOpenConversations` re-reads the file
  and replaces it (`runtime.ts:3281-3283`).
- **Auto-start fires once per mounted `App`** when it has no sessions
  (`App.tsx:1013-1019`).
- **`createWindow` builds one kind of window** (`index.ts:40-113`) and its handle
  is thrown away (`:339`).
- **Event ingestion, the badge, `markSeen` and banners share one effect**
  (`App.tsx:279-324`). Two windows would raise every banner twice.
- **`raise()` focuses a window before opening the project** (`App.tsx:31-48`), and
  `app:focus` focuses whichever window comes first (`ipc.ts:268-276`).
- **No push says a conversation started or ended.** Only renames arrive
  (`App.tsx:253-269`).

What already works in our favour:

- **Every push reaches every window** (`ipc.ts:1141-1209`, `:1477-1479`).
- **The navigation allowlist ignores a fragment** (`security.ts:512-521`), so
  `index.html#detached=<id>` passes as the same entry. A query string is refused.
- **`reorderConversations` keeps ids it was not given** (`runtime.ts:3618-3633`).
- **Disk writes cannot land out of order.** `writeOpenProjects` is synchronous
  (`open-projects.ts:118-132`).
- **Removing a view already scans every window** (`workbench-surface.ts:922-925`).

## The shape of the answer

### Main owns which projects are detached, and the main window owns the rest

The detached window is a view onto one project. It never restores, never writes
the saved layout, never raises a banner and never sets the badge.

**The registry of detached windows lives in the main process.** That is the only
copy that survives a renderer reload. For each detached project it holds the
window, its state, its return slot and the latest layout slice. The main
renderer's `detached` map is rebuilt from it on boot.

The main window writes its layout with every detached project put back at its
return slot. So `open-projects.json` always describes a one-window app, "nothing
restored after a restart" costs nothing, and there is no schema change.

### One `App`, with a role read once at boot

`main.tsx` reads `location.hash` once: `{ kind: 'main' }` or
`{ kind: 'detached', projectId }`.

The role gates capabilities. These are categories, not a count of `if`
statements.

- **Boot.** A detached window does not call `restoreConversations`. It calls a
  bootstrap query that returns its project's conversations and slice. The main
  window restores, then applies the registry before its first visible or
  persisted layout.
- **Auto-start.** Main role only.
- **Persistence.** All three writes go through one role-aware `persistLayout`,
  which applies `withDetachedReturned`. A detached window never calls
  `writeConversationLayout`.
- **Events.** Both roles ingest events. The badge, banners and `markSeen` are main
  only. A detached window reports its focus and its visible conversations instead.
- **The stage.** A detached window renders only the project pane.

Starting, ending, renaming, restarting, carries and `Session` stay one code path.
A conversation must behave the same in both windows.

### The project pane becomes its own file

`EditorPane` (`Workspace.tsx:804`) and `PaneWorkbench` (`:776-802`) move to
`workspace/EditorPane.tsx`. `Workspace` and the detached stage both render it.

The detached stage keeps `PaneTabStrip` with its one tab. That tab is the handle
the project is dragged back with.

### A surface can change hands

A `Surface` gains `state: 'active' | 'handing-off'`.

**Begin.** `beginHandoff(caller, projectRoot, destination)` does all of this in one
synchronous call:

- Finds the caller's surfaces on that root through `byOwner`. It refuses when
  there are none, and when there is more than one, rather than guessing which.
- Sets `handing-off`, removes the id from `byOwner`, and records the destination.
- `ownedSurface` refuses a surface that is handing off. The old renderer's close
  becomes a refusal, which `closeQuietly` already swallows
  (`WorkbenchFrame.tsx:63-67`).
- Deletes every grant whose owner is the caller and whose root is this one. The
  caller's grants for other projects stay.
- Calls `removeChildView` and zeroes the bounds, so a closing window never holds
  the view.
- Starts an expiry.

**Claim.** The destination's `WorkbenchFrame` calls `openWorkbench({ projectId })`.

- Main looks for a handoff on that project whose destination is the caller. Any
  other caller is refused.
- It adds the view to the caller's window at zero bounds, sets `owner`, registers
  `watchOwner`, sets `active`, recomputes visibility, and returns the same view id.
- `owner` and the parent change together, in one function. The comment at
  `:804-811` exists so the two can never disagree.

**No second surface.** While a project is in the registry, `redeem` accepts
`{ projectId }` for it only from that entry's current window — the detached one,
or the main window while the entry is `returning`. This is the real guard:
revoking grants alone cannot stop it, because `{ projectId }` never needed one.
`workbench-surface.ts` takes the check as an injected predicate, the way it
already takes `resolveProjectRoot`.

**Expiry.**

- An unclaimed detach becomes a return. The view goes back to the main window.
- An unclaimed return destroys the view.

**What the transfer keeps, and what it resets.**

- **Kept:** `byContents`, `awaitingCallback`, the runtime lease and `editorHidden`.
  The view id and its `WebContents` are the same objects.
- **Reset:** `overlayHidden` belongs to the old owner and does not follow the view.
- **Revoked:** the old owner's grants for this root. They are neither moved nor
  left usable.

Handoffs are keyed by view id inside main. The project id is only how a claimant
names what it expects.

### Main keeps a registry of detached windows

`index.ts` gets `createWindow(role)`. A detached window loads the same document
with `#detached=<projectId>`, gets the same `lockDownNavigation` and scale
listener, opens at the cursor, and uses the OS title bar with the project's name.

The registry is `Map<projectId, { window, state, returnSlot, slice }>`. The state
is one of `detaching`, `detached`, `redocking`, `returning`, `closing-empty` or
`shutting-down`. **Every transition is idempotent.**

**The slice and slot.**

- A detach seeds `returnSlot` and `slice`.
- Every ordered slice message from the detached window updates the cached slice
  before main forwards it.
- The cache is a relay copy, not another writer. The detached window is still the
  only writer.

**Boot queries.**

- The main renderer's query returns every entry's id, slot and slice. It
  restores, removes those projects from its panes, and merges their slices,
  before its first visible or persisted layout.
- The detached renderer's bootstrap query returns its project's conversations and
  slice. Main refuses any caller that is not that entry's window.

**How a detached window closes.**

- **Closed by the user, while `detached`.** The synchronous `close` listener calls
  `event.preventDefault()` and asks the detached renderer to
  `flushDraftsAndReadSlice`, with a timeout. On the answer, main updates the
  cached slice, begins the handoff, pushes `project:returned`, sets `returning`
  and calls `close()` again. That second close goes through with no second return.
- **If the flush fails or times out**, main runs the same sequence with the last
  cached slice: begin the handoff, push `project:returned`, set `returning`, call
  `close()`. It never closes raw while the view is still attached. A draft typed
  in the last second may be lost. codex proposed cancelling the close instead. This plan does not,
  because a hung renderer would then leave a window nobody can close.
- **Closed after a redock:** the handoff already happened. Nothing more.
- **Closed after the last conversation ended (`closing-empty`):** destroy the
  view. Return nothing.
- **Main window closing (`shutting-down`):** close every detached window, with no
  handoffs, then quit as today (`index.ts:454-458`).
- **Load failure before a claim:** the detach expiry returns the project.
- **Forced destruction after a claim** skips `close`. The owner's `destroyed`
  handler removes the surface (`workbench-surface.ts:700-703`), and the registry's
  `closed` fallback returns the tab. The main window then opens a fresh view, so
  the editor does not move live on this path. `destroy()` is not assumed to emit
  `close`.
- **The `close` listener is synchronous.** Electron does not await an async one.

Main also gains:

- `focusProjectWindow(projectId)`.
- `app:focus` focusing the caller's window, not the first one.
- A conversations push for starts and ends.
- `project:prepareDetach`, `project:commitDetach`, `project:prepareRedock` and
  `project:commitRedock`, described under the two drags.

### Layout between two windows

- **A detach commits the project's current slice** — its `conversationGroups`,
  `chorusWidths` and `workbenchHidden` entries — from the main renderer's live
  store. It is never read back from main.
- **Acks only at ownership boundaries:** a detach commit, a redock commit, and a
  close. The main renderer removes the tab only after main accepts the commit.
- **While detached, the detached window is the only writer of that slice.** It
  sends changes on one ordered path. Main caches each one and forwards it
  synchronously, with no `async` handler in between. The main renderer merges
  them last-write-wins.
- **The main window never edits a detached project's slice itself.** A change
  aimed at that project, such as starting a conversation from history, is sent to
  the detached window to apply.

### The main window lets go and takes back

The store gains `detached: Record<projectId, ReturnSlot>`, where a slot is
`{ paneId, index }`. It is rebuilt from main's registry on boot. Runtime only,
never persisted.

**Slots are indices in the virtual full pane.** That is the pane as it would be
with every detached project put back.

- `detachTab` computes the index against `withDetachedReturned`, so existing
  detached gaps count.
- `returnTab` translates a virtual index into a real one by skipping the
  still-detached slots before it.
- `withDetachedReturned` inserts slots in ascending index order.
- `returnTab` falls back to the end of the focused pane when the slot's pane is
  gone.

The rest:

- **`detachTab`, `returnTab` and `withDetachedReturned`** are pure, in
  `layout.ts` beside `placeSession`. `persistLayout` applies
  `withDetachedReturned`.
- **`openProject` checks `detached` first** and focuses that window
  (`store.ts:654-656`). Rail, notification, history, `startIn` and `promoteAside`
  all go through it.
- **`raise()` stops focusing a window itself.** `openProject` picks the window:
  the detached one, or the caller's.
- **One conversations reducer serves both roles.** The main window keeps every
  session but never puts a detached project in a pane. A detached window filters
  to its own project. The last end closes exactly once.
- **Notices count the detached window.** A conversation visible in a focused
  detached window raises nothing.
- **A return for a project with no live conversations inserts nothing.**

### The two drags

Both are two-stage. **Prepare** runs at release and decides whether the drop
counts. **Commit** runs after drafts are flushed and does the move.

**Out.**

1. A project-tab drag that ends with no target calls `project:prepareDetach` at
   once.
2. Main samples `screen.getCursorScreenPoint()` and compares it with the source
   window's outer bounds. Both are in DIPs, so zoom does not matter here. Inside
   the window, prepare refuses and nothing happens. Outside, it returns a
   short-lived token.
3. The main renderer flushes drafts. It reads the draft reader of every mounted
   conversation in that project (`onDraftReader`, `App.tsx:1575`), and awaits
   every draft write.
4. It calls `project:commitDetach` with the token and the final live slice.
5. A failed flush or an expired token does no move.

`pointercancel` or lost pointer capture cancels the drag. A cancel is never a drop.

**Back.**

1. The detached window's tab drag, ending with no target, calls
   `project:prepareRedock` at once.
2. Main samples the cursor. It requires the point to be outside the detached
   window and inside the main window's **content** bounds. It converts the point
   to content-relative coordinates and divides by the zoom factor
   (`scale.ts:30-37`).
3. Main sends a hit-test request, with a request id and a timeout, to the main
   renderer. The main renderer measures its tab strips fresh — the measurement at
   `useTabDrag.ts:135-186` is refactored so it runs without a live drag — and
   answers with an `insert` slot or nothing.
4. A slot comes back to the detached window with a short-lived token. A miss or a
   timeout returns nothing, and nothing happens.
5. The detached renderer flushes its drafts the same way, then calls
   `project:commitRedock` with the token and the final live slice.
6. The commit returns the project at that slot (`redocking`) and closes the
   detached window. A failed flush or an expired token does no move.

## Before Phase 1: a check you run by hand

The transfer rests on Electron behaviour its typings do not promise. Electron
43.2.0's `addChildView` and `removeChildView` say nothing about moving a view
between windows.

On macOS and on Windows, a throwaway snippet in main moves a live workbench
`WebContentsView` from one window to another. It runs twice:

- **Both windows stay open.** Remove the view from one and add it to the other.
- **The source closes.** Remove the view, close the source window straight away,
  then add the view to the other.

Each run checks four things:

- An unsaved buffer survives.
- The workbench terminal's process survives.
- Focus returns to the editor.
- IME composition still works.

I can write the snippet when asked. Running it is yours. If either run fails any
of the four, "the editor moves live" has to be revisited before Phase 1.

## Phases

Phases 2 to 4 add code that nothing calls yet. Nothing calls
`project:prepareDetach` until Phase 5, so no feature gate is needed.

1. **A surface can change hands.** `workbench-surface.ts`. Tests in
   `workbench-surface.test.ts` against its fakes:
   - `beginHandoff` refuses zero matches and more than one.
   - Owner-only operations refuse a surface that is handing off.
   - Only the destination can claim.
   - The view id survives the claim.
   - `overlayHidden` is reset.
   - The old owner's grants for that root are revoked, not moved or left usable.
     Its grants for other roots remain.
   - The injected predicate refuses `{ projectId }` from any window but the
     entry's current one.
   - An expired detach returns; an expired return destroys.

   _Exit:_ the transfer exists and is covered. The manual check above has passed.
2. **A window for one project.** `index.ts`, `ipc.ts`, `shared/ipc.ts`,
   `preload/index.ts`: `createWindow(role)`, the registry with its slots, slices
   and states, the close flow with `flushDraftsAndReadSlice` and its timeout, the
   `closed` fallback, the four prepare and commit channels, the redeem predicate,
   `project:returned`, `focusProjectWindow`, both boot queries, the conversations
   push, and `app:focus` by caller.
   _Exit:_ main can open, close and return a detached window. Nothing calls it.
3. **The detached stage.** `main.tsx`, `App.tsx`, `workspace/EditorPane.tsx`,
   `Workspace.tsx`: the role, the capability gates, auto-start for main only,
   `persistLayout`, and answering `flushDraftsAndReadSlice`.
   _Exit:_ a detached window renders one project and writes nothing to the saved
   layout.
4. **The main window lets go and takes back.** `store.ts`, `layout.ts`, `App.tsx`:
   `detached` and its boot merge, `detachTab`, `returnTab`,
   `withDetachedReturned`, the `openProject` guard, `raise()`, the conversations
   reducer, notices and the empty-project case. Pure tests in `layout.test.ts`
   and `store.test.ts`:
   - Two projects detached from one pane, returned in either order.
   - Persistence reconstruction with both still detached.
   - The deleted-pane fallback.

   _Exit:_ a return puts the tab back where it was, and the saved layout always
   shows it there.
5. **Drag out.** `useTabDrag.ts`, `Workspace.tsx`, `App.tsx`: prepare, the draft
   flush, commit, and cancel on lost capture. The first phase anyone can reach.
   _Exit:_ dragging a tab out opens it in its own window, on macOS and Windows,
   checked by hand.
6. **Drag back.** `useTabDrag.ts`, `Workspace.tsx`, `App.tsx`, `ipc.ts`: the
   geometry refactor, prepare with the hit-test round trip, the detached window's
   draft flush, and commit.
   _Exit:_ dropping the tab on the main tab strip returns it at that slot, checked
   by hand.

## What this deliberately does not do

- **No restoring detached windows after a restart.** Settled.
- **No second project in a detached window**, and no dragging one into it.
- **No detaching a conversation tab.** `useConversationDrag.ts` is untouched.
- **No live drop indicator** in the main window while a tab from a detached
  window hovers over it. The drop is resolved on release only.
- **No detecting that the main window is covered** by another app during a
  redock. Bounds cannot see that.
- **No carrying scroll position or quick-question cards across.** `SessionCarry`
  holds promises (`Session.tsx:256-263`) and cannot cross IPC. Drafts are flushed
  and do survive.
- **No cancelling a close because a flush failed.** See the close flow.
- **No second main window**, and no change to the global terminal.
- **No fix to the unread "visible" check**, which compares project ids with
  conversation ids (`App.tsx:285-288`). It predates this.

## Open questions and risks

- **Unverified: reparenting a live `WebContentsView`**, with both windows open and
  with the source closing. The manual check before Phase 1 exists for this.
- **Unverified: `pointerup` arrives when released outside the window.** Under
  pointer capture it is expected to for an ordinary mouse drag, on both platforms.
  That expectation comes from the review's knowledge of Chromium, not from this
  repo. Phase 5's exit is checked by hand for this reason.
- **The cursor is sampled in main at prepare**, an IPC hop after release rather
  than at the release itself. A very fast flick could land a few pixels off.
- **Why one root could have two surfaces for one caller** is not established.
  `beginHandoff` refuses rather than guesses, which makes the cause harmless.
- **Forced destruction after a claim loses the live editor.** The project returns
  with a fresh view. Whether the workbench's own storage keeps unsaved buffers
  across that is unverified.
- **A close whose flush times out** can lose a draft typed in the last second.
- **Reloading the detached window** destroys its surface through `watchOwner` and
  opens a fresh one. The main window behaves the same today, but it is another
  path where the editor does not move live.
- **Dialog parents** pick `getFocusedWindow() ?? getAllWindows()[0]`
  (`ipc.ts:286`, `:429`, `:478`). With the detached window focused, a folder
  dialog opens over it. Probably right, and untested.
