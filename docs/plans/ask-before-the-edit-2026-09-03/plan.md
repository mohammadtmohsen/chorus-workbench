# Ask before the edit, and show what it would do

> **Revision 10, 2026-09-04.** Built, driven, and reshaped by driving it. Eight
> Codex reviews before a line was written; every blocker checked against
> the source and every one standing. What each revision got wrong is at the foot.
>
> **R5 found a better mechanism**: `settings` — _"the highest priority among
> user-controlled settings"_ (`sdk.d.ts:1858-1861`) — with `applyFlagSettings`
> to change it **mid-session** (`:2351-2360`), above the user's own
> `settings.json` and needing no restart.
>
> **R6 made its lifecycle explicit.** A mechanism whose _when_ is vague is not a
> mechanism: "on entry" cannot mean "when the verdict is `ask`", because a
> bypassed callback produces no verdict at all.
>
> **R7 runs the Phase 1 spike and rewrites around what it found.** The flag layer
> beats `acceptEdits` — so enforcement works, option 2 cannot be `acceptEdits`
> alone, and the flag is installed for _every_ profile rather than a chosen few.
> Results are under Phase 1.

## What driving it changed

**It works.** Both spikes passed, the backend and the surface were built, and the
whole loop ran: a proposed edit opens a diff, the card asks, an answer settles it.
Everything below is what the _running_ thing taught, in the order it was found —
and it is most of what the feature actually is. The plan got the mechanisms
right and the interaction almost entirely wrong.

**"Allow all edits this session" was removed.** Findings eight and ten spent four
revisions arguing about how to implement it — `acceptEdits`, clearing the flag
layer, a wildcard grant. Pressed once in the real app, the answer was immediate:
it switches the feature off. A control whose only use is to stop the thing you
turned on does not belong beside it. An edit now grants nothing at all — not a
mode, not a wildcard, not even for the same file — so `addFileChanges` and its
wildcard key are gone. `addAlways` and `isRemembered` keep refusing `fileChange`,
because a grant remembered from before this existed would still switch it off
silently.

**Allow once is the armed default, for every kind.** It was the session grant, on
the argument that answering the same ask four times is what makes a queue people
stop reading. The key already under a finger should do the _narrow_ thing: a
mistaken Enter on Allow once costs one action you had not read, and on the wider
button it costs every action for the rest of the session, invisibly.

**Open question 1 is answered: refusing carries words.** The deny message was
hardcoded to `'Denied by the user'` and never left main, so the field existed on
the wire with nothing able to fill it. An agent told only "no" retries the same
edit.

**And the words carry a line.** Selecting in the diff and refusing appends
`About greeting2.txt line 1:` and the quoted text. The filename comes from the
approval, not the snapshot — both sides of the diff are served on `chorus-ask:`,
which resolves to no file, so the snapshot's own path is an internal URI.

**A refusal with words holds the agent to that file.** The sequence measured on
2026-09-04 is not a batch: the second edit is not requested until the first is
answered, so the first attempt — sweeping the queue — found nothing to cancel and
the problem survived it. A hold is kept instead: another file is refused
unasked, the same file goes straight to a card because that proposal _is_ the
correction, and the hold clears at the end of the turn.

**Both tabs are previews, and the reveal is on `vscode-remote:`.** Answering
closes the diff and opens the real file — italic, replaced by the next thing
opened, because neither was chosen by the person. Opening it with `URI.file`
produced _"the editor could not be opened because the file was not found"_ over a
file plainly visible in the explorer: the workspace folder is built on
`vscode-remote://<authority>` (`services.ts:355`), so a `file:` URI resolves to
nothing. Finding four warned about exactly this and the warning was not applied
to the reveal — `gate-handle.ts` uses `URI.file` and works, and "it works over
there" was taken as evidence about here.

**The card heading names the file, not the path.** Claude sends absolute paths;
one was passed through and became two lines of shouted directory names.

## The promise, stated exactly

Accepted by the user on 2026-09-03, in this session, when asked directly whether
the reduced scope was acceptable:

- **A diff and an accept for every queued, previewable Claude `Write`/`Edit`
  approval.** Not every edit: an auto-allowed one shows nothing by design, and an
  unknown input shape, an oversized file, a `NotebookEdit` or an unreadable path
  each show none either.
- **A visible notice when a Claude edit-tool call completes successfully with no
  approval recorded against it** — scoped to what the event stream can observe.
  Chorus cannot see a cause and does not guess one. **The notice may be missed**
  in two named cases: a session whose enforcement write failed says so with a
  standing notice instead, and two live tool-use ids that collide suppress each
  other rather than risk accusing the agent of a bypass that did not happen.

It is not "nothing lands without your say-so", and the plan says so wherever it
would otherwise be read that way.

## The problem

The Claude Code extension holds a proposed edit, opens it as a diff tab titled
`[Claude Code] package.json`, and asks _"Make this edit to package.json?"_ —
**Yes**, **Yes, allow all edits this session**, **No**. Nothing touches disk
until an answer.

Chorus already asks. What it shows is the difference: a card whose body is
`describePatch`'s `- old\n+ new` — no gutter, no colour, no file context.

## The eleven facts

**One — the tab follows the final verdict.** Not the profile, and not
"credential edits always ask": `evaluate` checks a remembered grant
(`engine.ts:158`) and a session grant (`:183`) **before** ask rules (`:188`).
The condition is exactly: the verdict was `ask` and a card was queued.

**Two — the preview is pulled, never carried.** `conversation-service.ts:604-612`
appends `request: event.request`; `events.ts:237` types it `z.unknown()`. A
`proposed` field would persist the full content of every edited file — for an
`Edit` the whole surrounding file, on a `.env` the secret.

```
AgentSession.previewFileChange?(approvalId, currentText) -> string | null
```

Adapter computes (it holds the input), main supplies the text (only main may
read a filesystem), no raw provider input crosses the boundary.
**`SupervisedSession` must forward it.**

**Three — the seam is `onApprovalQueued?(request)`, fired after `queue.add`.**
Only the service knows the verdict; only the runtime has a filesystem and a
surface. The runtime owns every unsafe step: `resolveWithinRoot` against the
project root — **main never opens an agent-supplied path directly** — a byte cap
enforced before the read _and_ before IPC, and a snapshot distinguishing
**absent** (a `Write` creating a file) from **empty**.

**Four — both sides render from one immutable snapshot, and the digest check is
a preflight.** A new file has no left-hand resource; the workspace is
`vscode-remote://<authority><root>` (`services.ts:355`); the file can move while
the card is open.

The guard is the **first thing** `decideApproval` does for a previewed
`fileChange` — before the grant and before `acceptEditsFromNowOn`, which run at
`:292-320`. A mismatch **denies** the request, resolving the promise the CLI is
blocked on. It is only a preflight: another writer between check and write is
unguardable here. So a stale denial is recorded as system-decided and
**explained in the transcript**, because the deny message reaches only the
provider today.

**Five — withdrawal is invisible and needs a signal.** The adapter deletes its
pending entry on abort and emits nothing (`claude-adapter.ts:611-617`); the queue
has no timer (`queue.ts:29`). `approval.withdrawn` joins the protocol — and
**joins `UNDROPPABLE`**, because the one event that clears an orphaned card must
not be dropped under backpressure to leave the card it exists to remove.

**Six — `tool.started` cannot prove an edit ran, and `tool.completed` cannot
name one.** `mapping.ts:660` emits `tool.started` from the assistant's `tool_use`
**proposal**, so denied and failed edits produce one. `ToolCompleted`
(`events.ts:217-221`) carries `itemRef`, `status` and a patch — **no tool name**.

So the detector holds bounded live state: remember `tool.started` by `itemRef`,
correlate the approval by **`itemRef`**, the name the protocol already uses for
the provider's tool-use id, and drop both entries at completion or session end.

One id, not two. `agentID` sits beside `toolUseID` on the `canUseTool` options
(`sdk.d.ts:245-247`) and an earlier revision proposed pairing them. That cannot
work: `agentID` exists **only on the callback**, `ToolStarted` and
`ToolCompleted` carry nothing derived from it, and the detector's whole subject
is the edit where **no callback happened**. A key one half of the comparison can
never supply is not a key — and for the same reason it cannot annotate the notice
either.

So the map is keyed on the id alone, and **at protocol level that id is
`itemRef`** — `tool.started.itemRef` already carries the provider's tool-use id,
so nothing new crosses the adapter boundary and the two halves of the comparison
speak the same word. `agentID` is not carried at all: it cannot key the map, and
it cannot annotate a bypass notice either, because a bypass is precisely the case
with no callback to have supplied it.

Uniqueness is promised only _"within the assistant message"_. Observed ids are
`toolu_` plus twenty-two random characters, so a collision is implausible — but
implausible is not guaranteed, and a plan may not assert through the gap:

**A duplicate live id makes both entries contested, and a contested id raises no
notice at all until it drains.** Without that rule a collision could accuse the
agent of a bypass that never happened, which is the one failure this notice must
never produce. The cost is a missed notice in a case that may never occur, and
that cost is named in the promise rather than hidden in a footnote.

**Seven — the notice says only what it knows.** _"Claude made this edit without
asking Chorus."_ No cause: it could be `acceptEdits`, a hook, a rule or provider
behaviour, and Chorus sees none of them. Suppressed once the person has chosen
option 2 — they asked for exactly this.

**And it needs no suppression at all**, which earlier revisions spent two
findings arranging. Under the grant design in finding eight, "allow all edits
this session" is answered _by Chorus_ — the callback still fires, an approval is
still recorded, and the notice never triggers. A completion with no approval
against it therefore stays suspicious in every mode there is, and a notice that
never needs silencing cannot be silenced at the wrong moment.

**Eight — option 2 is a Chorus-owned wildcard grant, and nothing else.** The
spike sent three earlier designs to the scrapyard, and the answer turned out to
be inside Chorus rather than at the provider.

`acceptEdits` bypasses the callback (spike row four), so it can never be part of
this: it buys silence by blinding the thing whose whole job is to see. And
clearing the flag mid-session is unproven — the live run cleared it with the mode
still permissive and the callback kept firing, and the spike cannot say whether
the clear shape was wrong or flag changes simply do not reach a live session.

Neither matters, because neither is needed. **Keep the flag installed, never
touch the mode, and record an actor-scoped wildcard `fileChange` session grant in
Chorus.** `grantKey` is `${agentId}:${kind}:${subject}` with the paths as the
subject, so today's grant is path-specific and a wildcard needs its own explicit
form — `${agentId}:fileChange:*` — checked where session grants are already
checked, after denies and before ask rules.

Everything falls out of it:

- **No more cards**, because `evaluate` returns allow from the grant.
- **Every edit stays visible**, because the callback still fires and every
  decision is still logged. Chorus is never blinded by its own feature.
- **Credential edits are covered**, and correctly: a grant outranks
  `ask-credential-files`, which is exactly what "allow _all_ edits this session"
  means. The person said all.
- **No provider suggestions**, still — `claude-adapter.ts:307-323` forwards
  `pending.suggestions` on any non-`once` allow, and for a `fileChange` that is
  redundant and unsafe, since a forwarded rule can keep bypassing the callback
  after the mode returns to `default`. Forward nothing for a `fileChange`, and
  only for `fileChange`: an MCP "always allow this tool" legitimately wants a
  persistent destination.
- **No mode or flag replay after a crash.** The grant lives on
  `ConversationService`, which outlives the provider session the supervisor
  replaces, so finding eleven dissolves.
- **No detector suppression**, per finding seven.

The three ordering defects that hung off `acceptEditsFromNowOn` go with it:
`:877-883` is `void` and swallows its failure, `supervisor.ts:260-262` records
`chosenPermissionMode` before awaiting the call, and the local grant was
installed before either confirmed. **Under this design Chorus never calls
`acceptEdits` for an edit at all**, and none of the three can fire.

**Nine — re-profiling fails _disclosed_, and that is the single failure policy.**
`runtime.ts:3374-3385` persists the profile then fans out synchronously, while
the renderer refreshes only after a successful IPC reply. A failed reset can
leave the database saying one thing, the UI another, and the session applying
edits silently — the worst of the three.

R7 had two policies and they contradicted: this finding stopped a session whose
reset failed, while finding ten let one run under a notice — and reinstalling the
flag during a re-profile triggers both at once. **One policy, and it is the
second**, because prevent-plus-detect already says Chorus discloses what it
cannot prevent, and killing a working session over a settings write is a harder
guarantee than the one that was agreed.

The order inverts and the outcome is named:

1. Apply the live change to every affected session and **await** each.
2. A session whose change fails **keeps running, under a standing notice** that
   edits may not be shown. Nothing is silently unenforced and nothing is killed.
3. Persist the profile — the intent is recorded either way — then reply with
   **the profile actually applied and which agents could not be changed**, so the
   renderer draws the truth rather than assuming success.

The word is **fail-disclosed**, not fail-closed. Closed would mean refusing to
proceed; this proceeds and says so.

**Ten — when the flag layer is written, and when it is cleared.** "On entry" was
ambiguous, and the verdict cannot resolve it: a bypassed callback produces no
verdict, so a rule waiting for one can never fire.

**It is installed for every profile, unconditionally**, and R6's
profile-predicate was wrong. `workspace-write` and `trusted` do carry
unconditional allows for `fileChange` — but `ask-credential-files` outranks a
_rule_ allow, so an edit to `.env` still resolves to `ask` under them. Clearing
the flag for those profiles would restore precisely the credential bypass the
flag exists to prevent.

Installing it always is also cheaper to reason about, because **the flag layer
buys visibility, not asking**. It forces the provider to call back; Chorus's own
policy still decides what happens next, and under `trusted` that decision is
"allow" and no card ever appears. Nothing about the felt experience of a
permissive profile changes — Chorus simply stops being blind.

- **Written** at session start from `SessionOpts`, for every session. Whether
  `applyFlagSettings` can move it mid-session is unresolved and no longer
  matters: the flag is the same for every profile and is never changed after
  start.
- **Never cleared.** Finding eight removed the only reason to clear it, so the
  flag is written once per session and left alone. Nothing has to reason about a
  half-cleared state, and a re-profile changes Chorus's policy without touching
  the provider at all.
- **On failure the session runs, under a standing notice that edits may not be
  shown** — the one policy from finding nine, applied here too.

**Eleven — nothing needs replaying after a crash.** Earlier revisions had the
flag state and the permission mode remembered beside each other and restored
together, because option 2 changed both. Under finding eight it changes neither:
the flag is installed identically at every session start, including the one the
supervisor builds on resume, and "stop asking" lives in a Chorus grant on
`ConversationService`, which the provider's crash does not touch.

Recorded rather than deleted, because the absence is the point — a resume path
with nothing to restore is one that cannot restore it wrongly.

## Phases

The two spikes answer questions everything else assumes. **Neither runs unless
you ask** — they launch the app and drive a live agent.

### Phase 1 — Spike: what can actually be enforced

**Reading the real configuration, writing nothing to it** — and the isolation
claim two revisions carried was wrong. `CLAUDE_CONFIG_DIR` takes the credentials
with the settings, which is why the first attempt died on _"Not logged in"_; but
`settingSources: []` disables filesystem settings **while keeping
authentication**, and the adapter already uses exactly that for forks. A
lower-tier `Edit` allow can therefore be tested with a temporary project settings
file and no touch of `~/.claude/settings.json` at all.

Seven questions, in order of what they would change:

1. With a `permissions.allow` for `Edit` in that isolated config, does
   `canUseTool` fire? (The bypass this feature exists to notice.)
2. With `settings: { permissions: { ask: ['Edit', 'Write'] } }` at session
   start — the flag layer, above user/project/local — does it fire then?
3. With `applyFlagSettings` mid-session, does it start firing **without a
   restart**? This decides whether finding ten can change a live session, and
   whether finding nine needs a stop at all.
4. **With that flag-layer `ask` in place, does `setPermissionMode('acceptEdits')`
   still stop the callbacks?** The decisive one, and the assumption option 2
   rests on: if an explicit `ask` outranks a mode, "allow all edits this session"
   must clear the flag entry too and finding eight changes shape.
5. **And does returning to `default` restore them?** A mode that cannot be un-set
   makes option 2 irreversible for the session, which the card would have to say.
6. With a lower-tier `permissions.defaultMode: 'acceptEdits'` in the isolated
   config — a bypass Chorus never set and cannot see.
7. With `managedSettings`, for completeness.

**The conclusion is bounded and the plan says so:** this machine has no
IT-managed tier, so the spike can establish behaviour _without_ one and nothing
about behaviour _with_ one — which is exactly the case that drops
`managedSettings`, and the case that stays unverified.

**Result — run 2026-09-03 and completed 2026-09-04. Raw output in
`phase-1-spike.txt` beside this plan.**

It reads the real user configuration and writes nothing to it:
`CLAUDE_CONFIG_DIR` isolates credentials along with settings, so an isolated run
is an unauthenticated one. The tiers underneath the results were
`defaultMode: auto`, 149 allow entries, **no edit-tool allow**.

**At session start:**

| case                                           | `canUseTool` fired |
| ---------------------------------------------- | ------------------ |
| user config as-is, mode `default`              | yes                |
| + flag-layer `permissions.ask`                 | yes                |
| **flag ask + `permissionMode: 'acceptEdits'`** | **yes**            |
| `acceptEdits`, no flag layer                   | **no**             |
| `managedSettings` ask (no admin tier here)     | yes                |

**Mid-session, one streaming session, in order:**

| step                                                                 | `canUseTool` fired |
| -------------------------------------------------------------------- | ------------------ |
| a. flag ask, mode `default`                                          | yes                |
| b. `setPermissionMode('acceptEdits')`, flag on                       | yes                |
| **c. `applyFlagSettings({permissions: null})`, still `acceptEdits`** | **yes**            |
| d. flag reinstalled                                                  | yes                |
| e. back to `default`                                                 | yes                |

**Two findings, one positive and one negative.**

**Enforcement works at session start.** Row four is the bypass this feature
exists to notice — `acceptEdits` alone, no callback, the edit lands unseen. Row
three is the fix: a flag-layer `ask` forces the callback _through_ `acceptEdits`.
On a machine with no admin tier, Chorus can make itself unblindable.

**Clearing the flag mid-session did not work, and that is a real problem for
option 2.** Step (c) should have gone quiet: the flag was cleared and the mode
was still `acceptEdits`, which on its own bypasses (start row four). It kept
asking. So either `applyFlagSettings({permissions: null})` is the wrong shape for
a clear, or a flag change does not affect permission evaluation in a live
session — the spike distinguishes neither, and steps (d) and (e) cannot tell them
apart because both expect "yes" either way.

**What that cost, and what it stopped costing.** It killed the design where
option 2 clears the flag. It does **not** leave option 2 without a mechanism:
finding eight now answers it inside Chorus with a wildcard grant, which needs
neither the clear nor the mode — so the follow-up spike that was owed here is no
longer owed.

**Still outstanding:** a lower-tier `Edit` allow, which is now testable via
`settingSources` plus a temporary project settings file rather than the real user
config. **Still untestable here:** managed-machine behaviour, where
`managedSettings` is documented to be dropped.

### Phase 2 — Spike: does a synthetic diff editor open

`openEditor({original, modified})` with a provider on `chorus-ask:` has never run
here; the single attempt returned _"The editor did not answer"_ with no editor
open, which is evidence of nothing. Register the provider, seed two trivial
models, open a diff in a live surface.

**Result, run 2026-09-04.** `openEditor` returned
`workbench.editors.textDiffEditor` — the real VS Code diff editor, opened with
**both sides synthetic**: a content provider registered on a `chorus-ask:`
scheme, nothing on disk, nothing asked of the REH. The harness is
`phase-2-spike.mjs` beside this plan; it drives the surface's own CDP target,
because the shell's socket cannot reach that document and only that document can
reach `getService`.

Two harness faults on the way, recorded because both would recur: matching a
target on `/workbench/i` across url and title finds the **shell**, whose window
title is "Chorus Workbench" — match `workbench.html` instead; and a driver that
skips `ensureBuilt()` reports the gate installed and the operation missing,
because it is driving whatever was last built.

**The temporary operation lives on `__chorusGate`** and must come out: it is
installed only under the E2E trust waiver, but it is product source and its job
is done.

### Phase 3 — Enforcement, correlation and the bypass notice

- **Carry the tool-use id** from the callback onto the `fileChange` approval,
  under the name the protocol already uses for it — `itemRef` — so both halves of
  the comparison speak one word (finding six). Contested ids suppress.
- **Detect** on a successful `tool.completed` whose `itemRef` matches a
  remembered edit-tool `tool.started` with no approval against its `itemRef`.
  Bounded state, dropped at completion or session end. No suppression: under
  finding eight every allowed edit still records an approval, so an unapproved
  completion is suspicious in every mode.
- **Prevent**: no provider suggestions for a `fileChange`; never an `always`
  grant for one, and a **pre-existing remembered grant for `fileChange` is
  ignored** rather than honoured, since it predates this feature and would
  silently disable it forever; clear an inherited `acceptEdits` on entry,
  awaited, failing _disclosed_ per finding nine — under finding eight Chorus
  never sets it itself.

  The **session** grant is the opposite of prevented: it is the mechanism.
  Finding eight answers "allow all edits this session" with an actor-scoped
  wildcard `fileChange` grant, so the rule here is narrower than earlier
  revisions had it — no _remembered_ grant, and no _path-scoped_ one, because
  neither expresses what the person chose.

- Whatever Phase 1 proves about the flag layer is applied here.

### Phase 4 — What the edit would produce

`proposedText(toolName, input, current) -> string | null` in `mapping.ts`, pure,
called by the adapter. `Write` → `content`; `Edit` → `old_string`/`new_string`
with `replace_all`; `NotebookEdit` → `null` in v1.

**`sdk.d.ts` declares none of these shapes** — a tool input is an opaque record
there and the names come from live payloads and from `describePatch`. Every
unrecognised shape returns `null`, no tab opens, the card behaves as today.

Exit — the negative cases are the point: an `old_string` that does not occur; one
occurring twice without `replace_all`; an unknown tool; `NotebookEdit`.

### Phase 5 — The seam and the tab

`onApprovalQueued` — **which may never reject**, because it is invoked from the
synchronous `handle` path that drives the event pump, so its whole body is
wrapped and a failure costs the preview and nothing else, the discipline the
withdrawn plan's journal chain used. Then the contained, capped, absent-aware
snapshot;
`previewFileChange` through `SupervisedSession`; one main→surface push with both
sides and the label `[{agent}] {path}`; models disposed and the tab closed on any
settlement, keyed by approval id; `approval.withdrawn` and its chain, in
`UNDROPPABLE`. **The digest preflight is implemented here**, first in
`decideApproval`, with its stale denial visible in the transcript.

### Phase 6 — The card, and a scope it can keep

**Yes**, **Yes, allow all edits this session**, **No** — only on Claude
`fileChange` cards, since `ApprovalCard` also draws commands, MCP calls and
editor edits. Finding eight's ordering and its failure path, and a line at the
point of choosing that option 2 stops the asking. Strings under `ask.*`.

## What this deliberately does not do

- No new profile and no new setting.
- No batching — each edit is asked as it arrives.
- No editing the proposal before accepting.
- No Codex: `thread/start` uses `approvalPolicy: 'on-request'` with a
  `workspace-write` sandbox and an in-root patch need not raise an approval, so a
  tab that appears sometimes is worse than one that never does.

## Open questions

1. **"Tell Claude what to do instead"** — deny already carries a message on the
   wire. v1 or not?
2. **Focus** — does the tab take it, or open behind?
3. **Several queued edits** — one tab as each becomes current, or a stack?
4. **The byte cap's number**, and whether an oversized file says so. The cap
   itself is settled as a safety requirement.

## Risks

- **Phase 1's answer is bounded by this machine.** Managed-machine behaviour
  cannot be established here.
- **Phase 2 may fail**, and four phases rest on it.
- **Tool input shapes are read from payloads, not types.** A renamed field turns
  the preview off silently, so it needs a notice.
- **The digest is a preflight only.**
- **Phase 1 is complete; nothing has been built.** Startup and live-transition
  results are recorded under Phase 1, with the raw output and the harness kept
  beside this plan. One gap remains by choice, not omission: a lower-tier `Edit`
  allow, now testable without touching the real user config.

## What each revision got wrong

**R1:** `proposed` on the request would have persisted whole files into the
append-only log. The pure function had no caller reaching both the input and the
file. The working file cannot be the diff's left side. `read-only` was not the
condition; the verdict is.

**R2:** credential asks do not outrank grants. The digest guard cannot run
"before the decision is sent" — the grant and mode change happen first.
Withdrawal and timeout emit nothing. Awaiting `setPermissionMode` is not enough.
`managedSettings` does not force the callback. Enforcement cannot be the last
phase.

**R3:** `tool.started` does not prove an edit ran. Name-and-path correlation is
unsound when `toolUseID` is on the wire. The notice attributed a cause it cannot
know. Prevention was described and never given a phase. The digest was presented
as a guarantee. The spike would have edited the real user config.

**R4:** option 2 would have left a local `fileChange` grant that outranks ask
rules, so clearing `acceptEdits` would not restore asking. `settings` /
`applyFlagSettings` — the layer above user settings, changeable mid-session —
was never considered, and it is a better mechanism than the one two revisions
leaned on. Re-profiling was not fail-closed. The headline promise was broader
than the implementation. The detector had unbounded state and could not name a
tool from `tool.completed` alone, and `approval.withdrawn` was not undroppable.

**R8:** it declared option 2 dead when the answer was a Chorus-owned wildcard
grant, not a provider mechanism — three designs had been tried at the provider
and none was needed. It repeated the isolation claim after `settingSources: []`
was available all along, and the adapter already uses it. And it left six stale
contradictions behind: a composite key in fact six, `toolUseID` in Phase 3,
"fail-closed" in Phase 3, finding ten pointing at a "stop" finding nine no longer
has, an "isolated" Phase 1 heading over a run that read the real settings, and a
risk line calling Phase 1 half-done against a status calling it complete.

**R7:** the detector text still named a composite key in two places after
finding six had abandoned it, and `agentID` cannot annotate a bypass notice
either — the bypass is the case with no callback. "Never a false accusation" was
unsupported without a contested-id rule. The failure policy contradicted itself
across findings nine and ten, and a re-profile that reinstalls the flag triggers
both. And the spike was not isolated: it read the real configuration, hardcoded
one machine's `claude` path, and kept no raw output.

**R6:** the composite `(agentID, toolUseID)` key cannot work — `agentID` exists
only on the callback, and the detector's whole subject is the edit that had no
callback. The profile predicate for installing the flag was false: credential
edits resolve to `ask` under every profile, so clearing the flag for permissive
ones restores the bypass it was meant to prevent. The failure policy was left for
a spike to decide when it is a product decision. And a cleared flag would have
been silently reinstalled by a crash-resume.

**R5:** Phase 1 omitted the decisive test — whether `acceptEdits` still stops
callbacks once a flag-layer `ask` is in place, and whether `default` restores
them — so "acceptEdits alone is sufficient" was an assumption wearing a
conclusion's clothes. "On entry" never said when the flag layer is written or
cleared, and the verdict cannot say, because a bypass produces none.
Re-profiling could still leave the row, the UI and the session disagreeing.
Suppression was tied to a click rather than to the mode it describes.
`toolUseID` was treated as session-unique when its documentation promises only
per-message uniqueness. And `onApprovalQueued` had no stated failure behaviour
on a path that drives the event pump.

## A note on the plan format

The numbered layout in `~/.claude/CLAUDE.md` is the global default; this
repository overrides it at `CLAUDE.md:498`, and the global file defers to a
project's rules by its own instruction. Codex reviewed and agreed.
