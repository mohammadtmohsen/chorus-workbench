# Status — a window of its own

**Nothing in this file has been typechecked, linted, formatted, tested or run.**
Every phase was written by deepseek from a spec and reviewed on disk by claude,
one delivery at a time, on 2026-09-15. "Written" below means exactly that.

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

## Phase 1 — a surface can change hands · written, unverified

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

Eleven tests in `workbench-surface.test.ts`. Not run.

## Phase 2 — a window for one project · written, unverified

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

## Phase 3 — the detached stage · written, unverified

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

## Phase 4 — the main window lets go and takes back · written, unverified

- **`openProject` does not focus the main window.** Doing so would have reached
  for `window` in the store's node tests. `raise()` focuses the main window only
  when the project is not detached.
- **`startIn` skips a session it already holds,** because the conversations push
  can list it first.
- **A detached window places a conversation started elsewhere with
  `adoptConversation`,** not `reconcileConversationGroups`.

Five tests in `layout.test.ts` and one in `store.test.ts`. Not run.

## Phase 5 — drag out · written, unverified

**`lostpointercapture` cancels a drag, as the review asked. If Chromium drops
capture when the pointer leaves the window, this makes dragging out impossible,
and that listener is the first thing to remove.**

## Phase 6 — drag back · written, unverified

- **`virtualIndex` takes the pane, the real index and the detached slots.** It did
  not need the workspace the plan gave it.

One test in `layout.test.ts`. Not run.

## Known gaps

- **A main-window reload with no saved layout** while a project is detached opens
  that project's tab in both windows.
- **Detaching may flash a refusal in the pane for a frame.** The main window's
  bounds loop is refused between `beginHandoff` and the tab's removal
  (`WorkbenchFrame.tsx:332-334`).
- **Several lines exceed 100 characters** and will be rewrapped by prettier.
- **P0 must not be committed:** `reparent-check.ts`, and its three lines in
  `index.ts`.
