# Status

## Phase 1 — The profile · written 2026-09-03, unverified

The `review` profile exists and is selectable. Nothing captures anything yet;
`journaled` has no consumer until Phase 2, so the flag is inert by design and the
profile currently behaves as `workspace-write` with an unscoped edit rule.

**Nine files.**

- `packages/orchestrator/src/policy/rules.ts` — `PermissionProfile` gains
  `nameKey`, `summaryKey` and `journaled`; the `review` entry sits between
  `workspace-write` and `trusted`.
- `apps/desktop/src/main/runtime.ts` — `availableProfiles` carries the two keys
  instead of dropping them.
- `apps/desktop/src/shared/ipc.ts` — the `policy:profiles` response schema
  carries them too.
- `apps/desktop/src/renderer/src/App.tsx`, `workspace/Workspace.tsx`,
  `workspace/ProjectPreviewCard.tsx`, `workspace/SessionPreview.tsx` — the
  pass-through types widened.
- `workspace/ProjectSettings.tsx`, `QuickQuestion.tsx` — both renderers prefer a
  key when the profile carries one.
- `i18n/en.json` — `profile.review.name` and `profile.review.summary`.

**The one decision worth re-reading.** `allow-journaled-edits` deliberately
carries **no `scope`**, unlike every other allow rule in `rules.ts`. `engine.ts`
reads `scope ?? 'once'`, and both adapters treat anything other than `once` as
lasting provider permission — which is the blinding that would stop the journal
recording halfway through a session. `workspace-write` and `trusted` both carry
`scope: 'session'` on their edit rules, so they are exactly the profiles a person
would switch into Review _from_. The comment in `rules.ts` says this at the rule.

**Two things checked and deliberately left alone.** `runtime.ts` maps every
profile that is not `'read-only'` to a `workspaceWrite` sandbox, which is right
for Review — read, not changed. And the three older profiles keep their hardcoded
`name`/`summary`; the key is optional so they did not have to move, and migrating
them is out of scope.

**Placement is provisional.** Open question 3 in the plan — whether Review sits
beside `workspace-write` or replaces it — is unresolved. It is currently third of
four, in the middle, which removes nothing.

**Unverified.** No typecheck, no lint, no tests, no app run. Nothing in this phase
has been executed.

## Phase 2 — Capture · written 2026-09-03, unverified

Copies are taken before the provider is unblocked, and the four paths that would
have stopped the provider asking are closed. Nothing is drawn yet; the batch is
held in memory and read by nobody until Phase 3.

**Seven files.**

- `packages/agent-protocol/src/adapter.ts` — `SessionOpts.alwaysAskFileEdits`, a
  neutral "keep asking about edits" that each adapter expresses its own way.
- `packages/adapter-claude/src/claude-adapter.ts` — that flag becomes
  `managedSettings: { permissions: { ask: [...], defaultMode: 'default' } }`.
- `packages/orchestrator/src/conversation-service.ts` — the `TurnJournal` and
  `BatchKey` contracts, the capture call, the wire-scope coercion, the
  `acceptEdits` guard, turn hooks, the profile transition, and shutdown.
- `apps/desktop/src/main/turn-journal.ts` — new. The store.
- `apps/desktop/src/main/runtime.ts` — constructs and purges the store, passes
  `alwaysAskFileEdits` from the profile, hands the journal to every service.

**Four ways the provider could stop asking, and where each is closed.**

1. A user "allow for this session" on a credential-file edit → `decideApproval`
   no longer calls `acceptEditsFromNowOn` under a journaled profile. This is the
   one that actually fires under Review, because `ask-credential-files` matches
   `fileChange` and outranks the profile's allow.
2. A rule carrying `scope: 'session'` → the profile's edit rule carries none
   (Phase 1), and `wireDecision` coerces anyway.
3. A session or remembered grant returning `session`/`always` → `wireDecision`
   coerces the **wire** answer to `once`. Chorus keeps its own grant, so nobody
   is asked twice; only the CLI keeps calling back.
4. Rules already written to the user's settings files → `managedSettings`, which
   is the policy tier and is filtered restrictive-only.

**The log records the scope the user chose, not the coerced one.** Those are two
different facts and conflating them would falsify the audit trail.

**Deliberately not finished, and it is a real gap.** Switching a _running_
conversation into Review clears the permission mode and abandons any open batch,
but cannot apply `managedSettings` — that is a start-time option. So a session
that already had lasting CLI rules installed keeps them until it restarts, and
the restart is the runtime's to arrange. Until then such a session may under-report.

**Also deliberate:** a created file currently lands as `unreadable` rather than
as a distinct absent state. Phase 4 is what needs the distinction, and inventing
it before there is a restore to use it would be guessing at its shape.

**Unverified.** No typecheck, no lint, no tests, no app run.

**The top risk is unchanged and is now load-bearing.** `managedSettings`
outranking a persisted `allow` is read out of `sdk.d.ts:1880-1910` and
`:5043-5070`, never observed. If that reading is wrong, point 4 above is open and
the guarantee is narrower than the profile claims.

## Phase 3 — The card, read-only · written 2026-09-03, unverified

A turn under Review ends with a card listing the files Chorus holds a copy of,
each with its real diff and its restorable state. No buttons — Phase 4 adds
those.

**Eleven files, two of them new.**

- `packages/event-store/src/events.ts` — `turn.changes.proposed` and
  `turn.changes.settled`. Every field required: the optional convention is for
  adding to payloads with rows in the wild, and optionality here would admit a
  file that is `restorable: false` and declines to say why.
- `packages/event-store/src/projections.ts` — a no-op with its own reason.
- `packages/orchestrator/src/catchup.ts` — `proposed` is a no-op; **`restored` is
  not**, and it speaks in the user's first person like `repo.changed.byUser`'s
  `discarded`, because it is the same act and needs the same "re-read before
  continuing" warning.
- `packages/orchestrator/src/conversation-service.ts` — `TurnChanges`, the append
  on close, and the settlement.
- `packages/workspace/src/diff.ts` — `unifiedDiff`, the symmetric operation to
  `parseDiff`, on **jsdiff** (decided 2026-09-03).
- `apps/desktop/src/main/turn-journal.ts` — `closeBatch` now diffs and reports.
- `apps/desktop/src/shared/transcript-events.ts` — both classified `render`.
- `apps/desktop/src/renderer/src/transcript.ts` — the `restore` row, and the fold
  of the proposed/settled pair.
- `RestoreCard.tsx` — new.
- `ToolPatch.tsx` — new, extracted from `Entry.tsx`.
- `Entry.tsx`, `Session.tsx`, `en.json`, `styles.css`.

**The settlement is appended as `system`, never as the agent.** `catchup.ts:107`
skips events whose actor is the recipient, so filing it under the agent that made
the edits would hide it from the one agent that is still reasoning about those
files. This is the kind of thing that would have looked correct forever.

**`ToolPatch` moved to its own file.** `RestoreCard` needs it, and importing it
from `Entry` while `Entry` imports the card is a cycle. Copying it was the
alternative and is the thing its own comment forbids. Three consumers now:
transcript tool rows, the approval card, the restore card.

**A new dependency, and it was a decision.** `diff` (jsdiff) in
`@chorus/workspace`. The repository hand-writes its markdown parser and its
highlighter on purpose, so this needed an argument rather than a shrug: it is
pure JS with no native build, and it is already the shape the codebase speaks —
`mapping.ts:919-961` formats `structuredPatch` hunks handed to it by the Claude
SDK, which is jsdiff's own output. `@types/diff` was added and then removed; v9
ships its own types and the DT package is deprecated.

**One repair worth recording.** `keyOf` and the reservation key were joined with
a literal NUL byte, which made the whole file read as binary to `rg` — every
future search of it would have silently found nothing. It is now an explicit
`SEP = '�'` with a comment saying why NUL and not a space: the other
composite key is a project root plus an absolute path, and both may contain
spaces or colons.

**Unverified.** No typecheck, no lint, no tests, no app run. The event payloads,
the reducer fold and the card have never been executed.

## Phase 4 — Restore · written 2026-09-03, unverified

The card can now put a copy back. **This is the first phase that writes to a
user's files**, and nothing in it has been run.

**Fifteen files.**

- `apps/desktop/src/main/file-write.ts` — `restoreProjectFile` (bytes, not a
  string) and `deleteProjectFile`, plus `temporaryBeside`, which fixes a
  pre-existing collision: the temp name was `.chorus-<pid>.tmp`, one per process
  per directory, and restoring several files at once runs several writes
  concurrently in one process.
- `apps/desktop/src/main/turn-journal.ts` — `previewRestore`, `restore`,
  `reconcile`, the durable intents, `afterDigest`.
- `apps/desktop/src/shared/workbench-ipc.ts`, `main/workbench-surface.ts`,
  `preload/workbench.ts`, `renderer/src/workbench/edit.ts`, `workbench/entry.ts`
  — the per-file dirty check.
- `apps/desktop/src/shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts`,
  `main/runtime.ts` — `restore:preview` and `restore:apply`.
- `RestoreCard.tsx`, `Entry.tsx`, `Session.tsx`, `en.json`, `styles.css`.

**Four refusals, and they are the feature.** A file with unsaved changes in the
editor; a file that changed since the turn closed; a copy that has gone; a write
that failed. Each refuses rather than proceeding, and each says which on the row.

**The dirty check could not reuse the snapshot.** `readEditorSnapshot` reads the
_tracked_ editor — what the person is looking at — so asking it about an inactive
file returns a confident answer about a different document. The new channel goes
through `IWorkingCopyService`, which has an entry for every dirty model whether
or not it is on screen. **`null` means "cannot say" and every caller reads it as
dirty**: no surface, a timeout, a service that would not resolve. Guessing
"clean" there would authorise exactly the overwrite the check exists to prevent.

**Crash safety is an intent file, not an event.** `{path, op, from, to, done}`,
fsynced into the batch directory before each write and marked done after. At
startup `reconcile` hashes each unfinished intent's file: matching `to` means the
restore landed, matching `from` means it did not, matching neither means nobody
should claim to know. **It runs before `purge`** — purging first would delete the
only evidence of what was in flight.

**Ordering bug caught while writing it.** `restoreFiles` read the batch id after
calling `restore`, which settles the batch on its way out — the settlement would
have named an empty id and matched no card. It reads it first now.

**Unverified, and this phase deserves more scepticism than the others.** No
typecheck, no lint, no tests, no app run. The dirty check spans four processes
and has never round-tripped once; the intent reconciliation has never been
exercised by an actual crash; `restoreProjectFile` has never written a byte.

## Phase 5 — The diff in the workbench · written 2026-09-03, unverified

Clicking a file on the card opens the real diff editor: the captured copy on the
left, the working file on the right.

**Open question 4 is answered, by construction.** The plan left the original
side's URI undecided — a `vscode-remote:` path to the copy, or an in-memory model
on a Chorus-owned scheme. It is the second, and the reason is stronger than the
plan's: the copy lives under `userData`, outside the project root, and the
surface's file service is bound to the REH. A `file:` URI would ask the remote
host to serve a path it has no reason to, and whether it would is exactly the
kind of thing that cannot be settled by reading. **The text travels over IPC
instead** and the surface builds a read-only model on `chorus-restore:`, so
nothing has to exist on disk for the REH to reach and no temp file outlives the
tab.

The cost is that file content crosses IPC. Acceptable here and not a precedent:
it is a copy of a file the person is already being shown a diff of, going to the
surface already displaying the other side of it.

**Nine files.** `shared/workbench-ipc.ts`, `main/workbench-surface.ts`,
`preload/workbench.ts`, `renderer/src/workbench/edit.ts`, `workbench/entry.ts`
for the new request; `shared/ipc.ts`, `main/ipc.ts`, `preload/index.ts`,
`main/runtime.ts` for `restore:openDiff`; plus `RestoreCard.tsx`, `Entry.tsx`,
`Session.tsx`, `en.json` and the preload API test.

**The channel went on `IPC_CONTRACT`, not the workbench shell contract.** That
contract is surface _lifecycle_ — open, move, hide, close — and says in its own
comment that there is deliberately no generic command channel. Adding "open a
diff" to it would have been the first crack in that. The card's other two calls
already live on `IPC_CONTRACT`, so this joins them.

**This is the app's first `openEditor` outside the E2E gate.** Until now the only
one was `__chorusGate`, which is not installed in a packaged app. It opens a
_diff_ rather than a file on purpose: the card already shows the patch, so the
reason to come here is the editor's own navigation, folding and intra-line
detail — the same trade `FileDiff` versus Monaco was measured on in
`the-editor-you-already-know`.

**The preload API test had to be updated**, not because it broke but because it
pins the exact member list in order, which is the point of it. `onDirtyRequest`
and `onDiffRequest` are documented there under the same scrutiny as
`onEditRequest`, since all three are "main asks this document for something".

**Unverified.** No typecheck, no lint, no tests, no app run. Specifically
unproven: that `registerTextModelContentProvider` on a custom scheme resolves
inside this build, that `openEditor` accepts the diff input shape as written, and
that the language selection colours the left side to match the right.
