# Status — a window of its own

**The gate passes on this feature, and nothing has run in the app.** As of
2026-09-15, after `0fb5443`: typecheck passes, lint is clean on every file this
feature touches, `format:check` passes, `workbench:check` passes, and `pnpm test`
passes 2601 tests with none failing. `pnpm check` still exits 1, on three
`no-console` lines in P0's uncommitted `reparent-check.ts`, which go when P0 is
reverted.

Every phase was written by deepseek from a spec and reviewed on disk by claude,
one delivery at a time. Nobody has dragged a tab, and the Electron check has not
been run.

## Verification — 2026-09-15

- **`0fc26ba` did not typecheck.** `selectActions` in `hooks.ts` lists every store
  action by name, and Phase 4 added three without listing them there. Fixed in
  `0fb5443`, together with a `prefer-optional-chain` fix in `detached-windows.ts`
  and prettier over the feature's files.
- **The gate was also red on work outside this feature.** That was fixed in the
  working tree and is not committed: two optional chains in `runtime.ts`, a disable
  comment one line too high in `overlay.ts`, formatting in `runtime.ts`,
  `styles.css` and two other plans, and three `aside.test.ts` tests.
- **Those three tests were already broken in `HEAD`.** `sentToAgent` kept only
  sessions with no `instructions`, on the premise that only `startNamer` sets
  them. `f5a9028` added the call rule, which `sessionOptsFor` puts into every
  conversation's `instructions`, so the helper read nothing. It now excludes the
  namer by `NAMER_INSTRUCTIONS`, which `runtime.ts` exports for it. The helper's
  doc comment still states the old premise.

## Before Phase 1 — the Electron check · snippet written, not run

`apps/desktop/src/main/reparent-check.ts` is uncommitted, and only three temporary
lines in `index.ts` import it. `CHORUS_REPARENT_CHECK=both-open` or
`source-closes` turns it on, and `⌘⌥⇧M` moves the first workbench view.

**It moves the view the shell already opened, rather than opening its own.**
Opening one needs the project registry and the server lease, and neither is what
the check is about. The source-closes run closes a spare window, not the main one.
Closing the shell would destroy the view through `watchOwner`, and the run would
then measure Chorus rather than Electron.

**The plan put this check before Phase 1. It has not been run, and Phases 1–6
were built anyway, on the user's instruction.** If either run fails, "the editor
moves live" has to be revisited, and Phase 1's transfer may be wasted.

## Phase 1 — a surface can change hands · gate passes, not run in the app

Built as planned, with two corrections found while specifying Phase 2.

- **An unclaimed detach becomes a return, not a re-attach.** The first version
  re-attached the view to the source window on expiry. The source renderer no
  longer held that view id, so the returning tab would have opened a second
  surface and leaked the first. `expireHandoff` now re-arms a `'return'` handoff
  whose destination is the source.
- **The source may take back a detach nobody has claimed.** That covers a
  detached window closed before its renderer loaded.

Review also caught two ordering bugs. `claimHandoff` dropped the handoff before
attaching, which would leak on a failed attach. `expireHandoff` could throw out of
a timer.

Eleven tests in `workbench-surface.test.ts`, passing.

## Phase 2 — a window for one project · gate passes, not run in the app

- **The channels live in a new contract, `shared/detached-window-ipc.ts`.**
  `registerIpcHandlers` discards `event`, and every one of these handlers has to
  know its caller.
- **`token` is spelled `ticket`.** The conversation transcript redacts `token:`
  followed by a value, and it mangled the spec in four places. The rename keeps
  later specs intact.
- **`detachedAccess` also admits the main window while an entry is `redocking`,**
  not only while it is `returning`. A redock is a return.
- **`'app:focus'` is gone,** replaced by `'window:focus'`, which focuses the
  caller's window. Its doc comment was left behind at `shared/ipc.ts:1048`, and
  whether to delete it is the user's call.
- **`OpenSessionSchema` was lifted out of `'conversation:restore'`,** so that
  `'conversation:active'` shares one session shape with it.

## Phase 3 — the detached stage · gate passes, not run in the app

- **All three layout writes go through one `persistLayout`.**
- **A detached window boots through the same restore path,** fed by
  `window:detachedBootstrap`. Drafts, unread counts and pending decisions seed the
  same way in both windows.
- **`EditorPane`, `PaneWorkbench`, `ChorusSash`, `PaneTabStrip` and `TabJoin` moved
  out of `Workspace.tsx` verbatim.** Every moved block was diffed against `HEAD`.
- **The tab's × in a detached window closes the window,** which returns the
  project. The plan did not say, and closing the only tab would otherwise leave an
  empty window.
- **The `Session` render is one `renderSession` function** shared by both windows.
- **No CSS changed.** `.stage` is a flex column at `styles.css:5897`, so a
  `.workspace-shell` with no masthead above it fills the window.

## Phase 4 — the main window lets go and takes back · gate passes, not run in the app

- **`openProject` does not focus the main window.** Doing so would have reached
  for `window` in the store's node tests. `raise()` focuses the main window only
  when the project is not detached.
- **`startIn` skips a session it already holds,** because the conversations push
  can list it first.
- **A detached window places a conversation started elsewhere with
  `adoptConversation`,** not `reconcileConversationGroups`.
- **`selectActions` in `hooks.ts` had to list the three new actions,** which the
  first commit missed.

Five tests in `layout.test.ts` and one in `store.test.ts`, passing.

## Phase 5 — drag out · gate passes, not run in the app

**`lostpointercapture` cancels a drag, as the review asked. If Chromium drops
capture when the pointer leaves the window, this makes dragging out impossible,
and that listener is the first thing to remove.**

## Phase 6 — drag back · gate passes, not run in the app

- **`virtualIndex` takes the pane, the real index and the detached slots.** It did
  not need the workspace the plan gave it.

One test in `layout.test.ts`, passing.

## Known gaps

- **Nothing has run in the app.** The Electron check, dragging out and dragging
  back are all still to be done by hand, on macOS and on Windows.
- **A main-window reload with no saved layout** while a project is detached opens
  that project's tab in both windows.
- **Detaching may flash a refusal in the pane for a frame.** The main window's
  bounds loop is refused between `beginHandoff` and the tab's removal
  (`WorkbenchFrame.tsx:332-334`).
- **The `sentToAgent` doc comment at `aside.test.ts:61-62` is now wrong.** Whether
  to correct it is the user's call.
- **P0 must not be committed:** `reparent-check.ts`, and its three lines in
  `index.ts`.
