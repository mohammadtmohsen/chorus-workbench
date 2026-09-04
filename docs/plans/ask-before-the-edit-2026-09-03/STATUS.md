# Status

## Shipped, and driven · 2026-09-04

The loop works end to end, confirmed by driving the real app: Claude proposes an
edit, a diff opens with the proposal, the card asks, and answering settles it and
leaves the file open. Every interaction decision below came from _using_ it, not
from the plan.

**The gate is green** — typecheck, 2438 tests, format. Lint has one error and one
format warning, both in `apps/desktop/src/renderer/src/workbench/entry.ts`, both
belonging to the uncommitted C-066 browser-extension work that shares this tree.
Untouched deliberately.

### Phase 1 — Spike: what can be enforced

Answered. Raw output in `phase-1-spike.txt`, harness in `phase-1-spike.mjs`.

`acceptEdits` alone bypasses the callback entirely — the edit lands with
`canUseTool` never called. A flag-layer `permissions.ask` forces it back _through_
`acceptEdits`. So enforcement works on a machine with no admin tier.

Clearing the flag mid-session did **not** work, and the spike cannot say whether
the clear shape was wrong or flag changes do not reach a live session. It no
longer matters: the design that needed it was removed.

Untested here: an `Edit` allow at the _user_ tier (this machine has none), and
managed-machine behaviour, where `managedSettings` is documented to be dropped.

### Phase 2 — Spike: the diff editor

Answered. `openEditor` returned `workbench.editors.textDiffEditor` with **both
sides synthetic**, served by a content provider on `chorus-ask:` with nothing on
disk. Harness in `phase-2-spike.mjs`.

Two harness faults worth not repeating: matching a CDP target on `/workbench/i`
across url and title finds the _shell_, whose window title is "Chorus Workbench"
— match `workbench.html`; and a driver that skips `ensureBuilt()` reports the gate
installed and the operation missing.

### Phases 3–6 — Built

- **Protocol** — `approval.withdrawn` (and in `UNDROPPABLE`, since the one event
  that clears an orphaned card must not be dropped), `previewFileChange` on the
  session, `itemRef` on a `fileChange` approval, coded notices.
- **Orchestrator** — the preview seam (`onApprovalQueued`, `preflightApproval`,
  `onApprovalSettled`), the digest preflight ahead of every side effect, the hold
  after a refusal with words, and no grant at all for an edit.
- **Adapter** — `proposedText`, pure and fail-closed: an unrecognised shape, an
  absent `old_string` or an ambiguous one all return `null`, and `null` means no
  tab rather than a wrong one.
- **Main** — `edit-preview.ts` holds the snapshot, digest and proposal in memory
  and never on the request, because `approval.requested` is appended to the log
  whole; the ask-diff channel; the selection appended to a refusal.
- **Surface** — `ask-diff.ts`: two fixed URIs reused so one tab exists at a time,
  `setValue` rather than dispose-and-recreate (recreating closes the tab being
  replaced), and the reveal on `vscode-remote:`.
- **Renderer** — the card's wording for `fileChange` only, the reject input,
  Allow once armed for every kind, the file name in the heading.
- **The bypass detector** — in the adapter, where the ids live. `tool.started` is
  remembered by `itemRef` because `tool.completed` carries no tool name; a
  `fileChange` approval records its `itemRef`; a successful completion of an edit
  tool with no approval against it raises `editWithoutApproval`. A duplicate live
  id is contested and accuses nobody, since tool-use ids are documented unique
  only within one assistant message. Four tests in `edit-bypass.test.ts`.

### What is deliberately not built

No batching, no editing the proposal before accepting, no Codex, no new profile.
`NotebookEdit`, oversized files, unknown input shapes and unreadable paths get no
diff — the card still asks, it just has nothing to show.

### Known gaps

- **`applyFlagSettings` mid-session is unproven**, so the flag layer is written
  at session start only.
- **The reveal fires before the write.** `onApprovalSettled` runs ahead of
  `respondToApproval`, so on an accept the file opens with its pre-edit content
  and updates a moment later when the watcher catches up. It reads as watching
  the change land; if it ever reads as a flicker, that is why.

### The withdrawn plan beside this one

`docs/plans/keep-or-undo-the-turn-2026-09-03/` describes capture-then-restore —
five phases, built, driven, working, and reverted on 2026-09-03 because it was
the opposite of what was asked for. Its code is gone. It is kept for the record
of what each of its revisions got wrong, and should not be read as live.
