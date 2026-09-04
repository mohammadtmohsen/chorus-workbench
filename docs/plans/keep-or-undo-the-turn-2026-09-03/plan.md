> **WITHDRAWN 2026-09-03.** This plan was built, driven and reverted: it is
> capture-then-restore, and the thing asked for was accept-first review. Its code
> is gone from the tree. Superseded by
> `docs/plans/ask-before-the-edit-2026-09-03/`. Kept for the record of what each
> of its revisions got wrong, which is why it is still here at all.

# Restore the captured version of a file Claude edited

> **Revision 5, 2026-09-03.** Reviewed and rejected four times; every blocker was
> checked against the source and every one stood. The record of what each
> revision got wrong is at the foot, because it is worth more than a plan that
> pretends it was right.
>
> **Revision 4 renamed the action** from "Undo Claude's edits" to **Restore
> captured version**, because Chorus cannot prove the change it captured is the
> only change since. That stands, and the button says out loud that it rewrites
> the whole file.
>
> **Revision 5 replaces the unblinding mechanism, which was unreachable.**
> Codex's review found that `removeRules` is not callable and that restarting
> does not help; its run ended before it could finish checking for an
> alternative. There is one, it is better than what it replaces, and finding two
> is rewritten around it.

## The problem

VS Code's agent mode edits first and asks second: the change lands, then sits in a
pending-change surface with keep and undo per file. Chorus asks first and never
asks again — a `fileChange` approval either blocks the turn with a card
(`Session.tsx:2559`) or is auto-allowed and never seen
(`conversation-service.ts:617-627`). `read-only` interrupts every edit;
`workspace-write` and `trusted` show nothing. The middle is missing.

**This is not a Changes panel.** Those were deleted on 2026-08-28 because two
readers of one repository is two things to keep in step. Nothing here reads the
repository; it reads one turn's captured images, expires when the next turn
starts, and works with the editor shut.

## The guarantee, stated exactly

Revisions 1 and 2 promised a complete account of the turn. Revision 3 narrowed it
but still asserted "where nothing else has touched the file since" — which Chorus
cannot prove either. Both are withdrawn. What is left is deliberately modest:

> **Chorus captures a copy of each file immediately before Claude's `Write`,
> `Edit` or `NotebookEdit` changes it, when it observes that change through the
> permission callback. Restore writes that copy back over the file as it now
> stands.**

That is a statement about **what Chorus holds**, not about who changed what. It is
provable. Everything below follows from refusing to claim more.

| Writer                                  | Observed?     | Why                                                                                                                                                           |
| --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `Write`/`Edit`/`NotebookEdit`    | **yes**       | `canUseTool` blocks on Chorus's answer (`claude-adapter.ts:1198`)                                                                                             |
| Claude `Bash`                           | no paths      | the approval carries a command line, never a changed-path list                                                                                                |
| Filesystem MCP tools                    | no paths      | `mcpToolCall` names a tool and its input, not what it wrote                                                                                                   |
| Hooks, formatters, watchers             | invisible     | no approval at all                                                                                                                                            |
| Codex, any tool                         | **not gated** | `thread/start` uses `approvalPolicy: 'on-request'` with a `workspace-write` sandbox (`codex-adapter.ts:508-513`); an in-root patch need not raise an approval |
| The person, in the editor or a terminal | invisible     | nothing emits a changed-path signal — `file.edited.byUser` is in the schema with **no emitter**                                                               |

**v1 is Claude-only.** A Codex participant in a Review project behaves exactly as
under `workspace-write` and contributes nothing to the card.

## The four things that nearly broke it

**One — a mixed-writer restore is destructive, and renaming it is only half the
answer.** Claude changes `A→B`; then Bash, a formatter, or the person changes
`B→C` before the turn closes. The batch records `C` as the closing digest, so the
conflict gate passes, and Restore writes `A` — silently discarding `B→C`. No
wording fixes that on its own. Three layers, together:

- **The action is renamed.** "Restore captured version", not "Undo". It describes
  what happens, and what happens is a whole-file write.
- **Observed writers taint the batch.** A `command` approval, an `mcpToolCall`, or
  any `tool.started` Chorus cannot attribute to a path marks every row in the open
  batch **possibly stale** and says so. Chorus does not know that those tools wrote
  anything; it knows it can no longer claim they did not.
- **The restore shows what it will discard.** Before writing, the card renders the
  diff between the file as it is now and the image about to replace it. A silent
  destruction becomes an informed one, and for the common clean case that diff is
  exactly the agent's own edit, so nothing is added to the ordinary path.

**Two — the mode is not the rules, and revision 4's fix for that was
unreachable.** `claude-adapter.ts:307-322` forwards `pending.suggestions` as
`updatedPermissions` on any non-`once` allow, and `sdk.d.ts:2133-2162` shows what
those are: a `PermissionUpdate` union of `addRules` / `replaceRules` /
`removeRules` / `setMode` / `addDirectories` / `removeDirectories`, each carrying
a destination of `'userSettings' | 'projectSettings' | 'localSettings' |
'session' | 'cliArg'`. Installed rules survive a mode change, so
`setPermissionMode('default')` does not unblind a session.

Revision 4 proposed issuing a matching `removeRules`. **That cannot be done.**
`PermissionUpdate` is a payload you _return from_ `canUseTool`, not a method you
can call: `Query`'s complete control surface is `interrupt`,
`setPermissionMode`, `setMcpPermissionModeOverride`, `setModel`,
`setMaxThinkingTokens`, `applyFlagSettings`, `initializationResult`,
`reinitialize`, `supportedCommands`, `supportedModels` and `supportedAgents`
(`sdk.d.ts:2279-2420`). So the only way to send `removeRules` is through the
callback that has stopped firing — unreachable exactly when it is needed. And a
restart does not help either, because a new session reloads `~/.claude/settings.json`,
`.claude/settings.json` and `.claude/settings.local.json` and installs the same
rules again.

**The mechanism that does work is `managedSettings`**, an `Options` field
(`sdk.d.ts:1322`, `:1899`) whose own documentation describes this exact
situation: _"Intended for embedding applications (e.g. desktop apps) that derive
lockdown settings from their own enterprise configuration and need to enforce
them on the spawned subprocess without writing root-owned files."_ It is the
policy tier, and it is filtered **restrictive-only** — permissive arrays such as
`permissions.allow` are silently dropped, so it can tighten and can never widen.

Review therefore starts its sessions with a managed tier that forces the
callback:

```ts
managedSettings: {
  permissions: { ask: [/* Write, Edit, NotebookEdit */], defaultMode: 'default' },
}
```

`permissions.ask` is documented as _"permission rules that should always prompt
for confirmation"_ (`sdk.d.ts:5043-5070`), and being in the managed tier it
outranks any `allow` persisted in user, project or local settings, whatever a
previous "always" wrote there. `defaultMode` even accepts `'manual'` as an alias
for `'default'`, which is the name the feature was asked for under.

Two consequences:

- **`managedSettings` is a start-time option, so entering Review restarts the
  session.** Revision 4 also restarted, but for a reason that did not work; this
  one does, because the managed tier is reapplied on every start and the reloaded
  settings rules can no longer outrank it.
- **`settingSources: []` is rejected**, though it would also work. It is
  documented as SDK isolation mode and would drop the user's hooks, skills, MCP
  servers and slash commands — which `CLAUDE.md` says are deliberately inherited,
  and which `mcpToolCall` being a first-class approval kind depends on.

`applyFlagSettings` is a live control method that merges a partial settings
object, and is the candidate for a transition without a restart. **Its behaviour
here is unverified** — only its signature was read — so v1 restarts and this is
left as an improvement.

The concrete instance of the danger, for the test: `workspace-write` carries
`allow-file-edits` and `trusted` carries `allow-edits`, and the adapter's own
comment at `claude-adapter.ts:1155-1174` records that both are **session scope**.
So the blinded state is reachable from either of the two profiles a user is most
likely to switch into Review _from_. Test with an installed `addRules` edit
permission, not only with `acceptEdits`.

**Three — arbitration is project-wide, so the critical section must be too.**
Revision 3 serialized per conversation while arbitrating per project root: two
conversations can then race through capture. Path reservation is taken
**synchronously, before any awaited read**, in a map keyed by project canonical
root, inside the synchronous `handle()` (`conversation-service.ts:499-506`). The
async capture then runs under a reservation already held. Every **live unsettled**
batch participates, not only open ones — a completed-but-unsettled batch can
overlap a turn that was already running.

The image is "before the first observed edit of the turn", never "pre-turn":
capture is lazy, at the first approval naming the path, so anything earlier in the
turn is already inside it.

**Four — the crash intent cannot describe a creation.** Revision 3's
`{path, fromDigest, toDigest}` assumes a file exists on both sides, while Phase 4
correctly deletes a file the agent created. The record becomes:

```
{ path, op: 'restore' | 'delete',
  from: digest | 'absent' | 'unreadable',
  to:   digest | 'absent' }
```

fsynced before the write, marked done after the rename. On startup each unfinished
intent is resolved by hashing:

| disk matches                                       | conclusion                  |
| -------------------------------------------------- | --------------------------- |
| `to`                                               | it landed — `restored`      |
| `from`                                             | it did not — `kept`         |
| neither, or unreadable where a digest was expected | `unknown`, said on the card |

`absent` is distinguished from `unreadable`: a missing file is a state, an
unreadable one is a failure. A batch whose intents are all complete but which died
before its settlement event is reconciled from those intents at startup, and only
then is one `settled` appended.

**Five — `file-write.ts` needs three fixes.** Right bones — `resolveWithinRoot`
containment, atomic temp-plus-rename, `digestOf`, `lineDelta` — and currently dead
code whose header claims to be the only writer into a project tree. But it reads
and writes **UTF-8 strings** (`:94-165`), so a binary file round-trips through a
string and is corrupted; its temp file is **`.chorus-${process.pid}.tmp`**
(`:150`), a fixed name per process in the target's directory, so two concurrent
restores collide; and the replacement does not carry the original **mode**.
`expectedSha` is a check-then-write race by construction — narrowed by re-digesting
immediately before the rename, and stated rather than claimed away.

## The shape

A fourth profile, **Review**, beside `read-only`, `workspace-write` and `trusted`
(`rules.ts:204-273`). It allows Claude's edit tools outright — **though
credential-file edits, MCP calls and `editorEdit` still ask, by design**
(`ask-credential-files` matches `kind: ['fileChange','command']` at
`rules.ts:138-171`), and the summary says so rather than promising an
uninterrupted turn.

Each observed `fileChange` allow captures the file before the provider is
unblocked. At turn end Chorus diffs each image against disk and appends one event.
The transcript draws it at the foot of the turn: a row per file with **Restore**,
a header **Restore all**, per-row staleness, and a standing line — _"Covers
Claude's file edits. Changes from the terminal, MCP tools, hooks or your own
editor are not tracked — use Source Control."_

Live until the next turn starts, then settled and its images released. Older turns
keep a settled, read-only card.

Images live under `app.getPath('userData')`, one `mkdtemp` directory per batch,
mode `0700`, files `0600` — they can contain `.env` bytes, and this is the only
place those exist. Swept at settlement, at startup, and when a project closes.
**Never in the event log**, which holds the fact of a change and its digests only.

### Not restorable, with the reason on the row

Binary files and files over the capture cap; a path contested by another live
batch; an approval naming no files or no determinable change kind; renames, whose
destination the approval does not carry; `editorEdit`, which never reached disk
(⌘Z, and excluded from Restore all); and anything a crash resolved `unknown`.

## Phase 1 — The profile

`PROFILES` is an array, not a union (`rules.ts:41-46`), and `profileById` falls
back rather than throwing (`:278-284`), so a new entry needs no migration —
`permission_profile_id` is nullable `TEXT` with no constraint
(`projects.ts:472-478`).

Spread `...UNIVERSAL_DENIES` and `...UNIVERSAL_ASKS` first, carry no `scope` on
the edit-allow rule, leave `mcpToolCall` asking; the `PROFILES` sweeps
(`engine.test.ts:102-111`, `:138-152`) then apply unmodified.
`PermissionProfile` grows `journaled`.

**i18n is mandatory** — `CLAUDE.md` requires new user-facing strings to come from
`en.json`, and revision 2 wrongly filed it as a decision. `PermissionProfile`
gains `nameKey` / `summaryKey`, and the renderer prefers a key when present. Both
must be **carried through two places that currently drop them**:
`runtime.ts:1331-1333` destructures `{ id, name, summary }`, and the
`'policy:profiles'` response schema (`ipc.ts:1297-1300`) is a closed zod object
with the same three. Migrating the three legacy profiles is optional and out of
scope.

`runtime.ts:3196-3200` maps every profile that is not `'read-only'` to a
`workspaceWrite` sandbox — right for Review, but a silent two-way branch on a
string id, so check it.

Exit: Review is selectable, its strings come from `en.json` and survive the IPC
round trip, edits run unasked, credential edits still ask.

## Phase 2 — Capture that cannot be blinded

Injected into `ConversationService` the way `onLimits` and `onActivity` are
(`:41-64`) — the service has no `cwd` and should not learn filesystem access.

The guard is on the decision path, not the funnel. Under a journaled profile:
`decide()` never calls `acceptEditsFromNowOn()` for a `fileChange` (`:317-319`);
the supervisor's `chosenPermissionMode` is cleared so a crash-resume cannot
reinstate it (`supervisor.ts:330-332`); the session runs under the
`managedSettings` tier of finding two, which is applied where the options object
is built (`claude-adapter.ts:1155-1180`, beside `permissionMode: 'default'`) and
therefore also survives a supervisor resume, since resume passes the same
`SessionOpts`; and the **wire** scope is coerced to `once` on the `answer` value
in `recordAndAnswer` (`:457-461`), which is already built separately from the
logged payload.

**Chorus keeps its own grant.** Only the provider's wire scope becomes `once`.
The session or remembered grant the user chose is still recorded and still stops
Chorus asking again — the coercion exists so the _CLI_ keeps calling back, not to
re-ask the person. The log records the scope the user chose, not the coerced one.

Also: `recordAndAnswer` takes the request (the queue's `onResolved` has the entry
at `:149-150`, the auto-decide path has `event.request` at `:618-636`, the
fallback at `:345` needs threading); capture never throws, because the provider is
blocked on that promise; and async work rides a per-conversation promise chain
under a synchronously-taken project-root reservation, with `turn.started` awaiting
the previous finalization and `drain()` (`:465`) awaiting the tail.

Exit criteria — the invariants, stated precisely:

- three edits to two files in one turn produce one batch of two entries;
- a capture failure yields an uncapturable entry and the turn completes;
- **no non-`once` allow for a `fileChange` reaches the adapter** — asserted for
  the rule path, the session-grant path, and with a pre-existing **remembered**
  grant, the case revisions 1 and 2 both missed;
- **`setPermissionMode('acceptEdits')` is never sent under Review**, including
  after a simulated crash-resume. _Not_ "`setPermissionMode` is never called" —
  revision 3's wording contradicted its own required `default` transition;
- **a session with an installed `addRules` edit permission still calls back under
  Review** — the managed tier's `permissions.ask` outranking a persisted `allow`
  is the whole claim of finding two, and it is proven with rules, not only with a
  mode. Assert it for a rule written to `userSettings`, since that is the one a
  restart alone cannot clear.

## Phase 3 — The card, read-only

No buttons; revision 2's inert ones were a defect, not a milestone.

**Not the five-file event change** — these originate in Chorus, like
`policy.changed`, so there is no `AgentEvent` member and no adapter case.
`turn.changes.proposed` (batch id; per file: path, added, removed, patch,
`restorable`, a reason key when false, staleness) and `turn.changes.settled` (per
file `kept | restored | superseded | unknown`).

**Their fields are required, not optional.** The append-only convention at
`events.ts:213-219` governs adding a field to an _existing_ payload, where old
rows would fail to parse. These are new types with no old rows, and optionality
would admit invalid states — `restorable: false` with no reason.

Also: a no-op projection with its own reason (`projections.ts:323-336` style);
`settled` is **not** a catch-up no-op, because "the user put your file back" is
what the other agent must hear, while `proposed` is, per `catchup.ts:162-171`; the
settlement is appended as `user` or `system`, **never the agent** — `catchup.ts:107`
skips events whose actor is the recipient, which would be the one agent that needs
it; `transcript-events.ts:32` is a total `Record` and will not compile until both
are classified; and `ToolPatch` (`Entry.tsx:169-199`) is reused rather than
copied. No `useShellOverlay` — the card is in the transcript column.

## Phase 4 — Restore

`file-write.ts` first: `Buffer` path, collision-resistant temp name, mode
preserved, and a delete for a created file, all under existing containment.

Then the durable intent from finding four. Then the dirty-buffer check — a
**path-specific working-copy query**, because `readEditorSnapshot` reads
`trackedEditor(editors)` (`context.ts:257`) and answers "what is the person
looking at". That function already resolves `IWorkingCopyService`, so the query is
a small addition to `edit.ts`'s main→surface pattern. Writing under a dirty buffer
is the destruction `editor-edit.ts:11-16` exists to prevent.

The confirm step from finding one renders the current-versus-image diff before
writing. `Restore all` is one settlement over many per-file intents, and skips
non-restorable rows.

Exit: a file returns to its captured image; one changed since the batch closed is
refused; a created file is deleted; an executable keeps its bit; a dirty buffer
blocks the write; `kill -9` midway through `Restore all` reconciles to the truth
on restart; the settlement reaches the agent through catch-up.

## Phase 5 — The diff in the workbench

Last and separable. Entirely new work: the shell can tell a view four things —
open, move, hide, close (`workbench-ipc.ts:465`) — and that contract says in its
own comment there is deliberately no generic command channel. No `DiffEditorInput`,
no `openEditor({original, modified})`; the only in-surface `openEditor` is the
E2E-gated `__chorusGate` (`gate-handle.ts:44`), and clicking a transcript path
today shells out to the external `code -g` (`ipc.ts:659-692`).

## What this deliberately does not do

No per-hunk restore — the image is per file. No coverage of unobserved writers.
No Codex in v1. No cross-turn history. No change to the other three profiles.

## Open questions

1. **Does `turn.changes.proposed` carry the patch into the log?** Precedent says
   yes (`file.change.proposed` stores `patch`, `events.ts:190-194`); without it a
   reopened conversation shows a card with no diff. Recommended: carry the patch,
   keep image bytes out.
2. **The capture size cap**, announced at capture time.
3. **Four profiles in a `role="listbox"`** — does Review sit beside
   `workspace-write` or replace it as the middle option?
4. **The original side's URI in Phase 5** — `vscode-remote:` to the image, or an
   in-memory model on a Chorus-owned scheme.

## Risks

- **The blinding paths remain the ones that would ship a silent correctness
  bug**: credential-ask user grant, rule scope, session grant, remembered grant,
  supervisor replay, profile transition, and installed provider rules. Seven,
  each needing its own test.
- **`managedSettings` is the load-bearing new dependency and it is unproven
  here.** Its restrictive-only filtering and its precedence over persisted
  `allow` rules are read out of `sdk.d.ts:1880-1910` and `:5043-5070`, not
  observed. If the filter drops `permissions.ask` as well — the docs say
  permissive arrays are dropped, and `ask` is restrictive, but that is a reading
  — finding two has no mechanism and v1 needs `settingSources: []` with its cost,
  or the feature waits. **This is the first thing to test in Phase 2**, before
  anything is built on it.
- **The feature is narrow enough to disappoint.** An agent working through `Bash`
  produces an empty card. The standing line has to be prominent enough that this
  reads as the boundary, not a bug.
- **Found while reading `sdk.d.ts` for finding two, and outside this plan's
  scope:** Chorus forwards `pending.suggestions` verbatim
  (`claude-adapter.ts:322`), and a `PermissionUpdate` may carry
  `destination: 'userSettings' | 'projectSettings' | 'localSettings'`. If the CLI
  ever suggests one of those, Chorus's **"Allow for this session"** would write a
  rule into the user's own configuration that outlives the session and that Chorus
  never mentions. Unverified — it depends on what the CLI actually suggests, which
  has not been observed. Not touched here.
- **Nothing has been run.** Every reference was read; no behaviour executed, no
  test written, no app launched.

## What each revision got wrong

**R1:** that `recordAndAnswer` sees every change for both providers; that policy
auto-allow could not blind the provider; that per-actor keys made concurrency
safe; that `requestWorkbenchSnapshot` could say whether a given file is dirty;
that purging images at startup suited a durable proposed event; that
`file-write.ts` was already a safe restore primitive; that the profile's hardcoded
strings were settled.

**R2:** that coercing the scope in `recordAndAnswer` was early enough — `decide()`
blinds first, on the credential path that is the only one reaching it; that the
log should record the coerced scope; that a supervisor crash-resume could not
reinstate `acceptEdits`; that a profile change reaches a running provider; that "a
complete account of the turn" was deliverable while excluding shell writes; that
contested paths need only consider _open_ batches; that the image is "pre-turn"
when capture is lazy; that blanket settlement was crash-safe; that i18n was an
open decision.

**R3:** that "nothing else has touched the file since" was provable, when a
mixed-writer restore is silently destructive; that `setPermissionMode('default')`
unblinds a session, when installed rules are separate from the mode; that a
per-conversation critical section can arbitrate a project-wide resource; that a
`{from,to}` digest pair can describe creating a file; that `nameKey`/`summaryKey`
would reach the renderer, when `runtime.ts:1331` and `ipc.ts:1297` both drop them;
that "`setPermissionMode` is never called" was compatible with its own required
`default` transition; that new event fields had to be optional.

**R4:** that a recorded `removeRules` could be issued to clean a blinded session,
when `PermissionUpdate` is a callback _return_ payload and `Query` has no
rule-mutation method — reachable only through the callback that has stopped
firing; and that restarting gives a clean permission context, when a new session
reloads the same user, project and local settings files. Replaced by
`managedSettings`.

**Kept throughout:** the Claude-side capture boundary before `respondToApproval`;
images out of the event log; a post-turn digest for later conflicts; computing the
diff from the image rather than either provider's patch (`describePatch` at
`mapping.ts:1536-1543` is not a unified diff); `file-write.ts` as the home of the
restore; the path-specific dirty check; and leaving the workbench diff last.
