# The numbers hold still

## The problem

The account limits on the rail sometimes flicker — `25 → 26 → 25`, and `0% → 25%`
— on all four readings, Codex and Claude, five-hour and weekly, with no timing
the user has noticed.

Diagnosed by claude and challenged by deepseek, from the source. Nothing was
reproduced, and running `codex app-server generate-ts` was declined; Codex's
shapes were read from the generated types already committed under
`packages/adapter-codex/src/generated/`.

**Six causes, and they compound.**

- **Every report replaces the whole list.** `runtime.ts:5299-5301` sets an agent's
  windows to whatever the latest report carried, and `useUsage.ts:146` replaces
  the agent's push again. A report with one window empties the other slot until
  the next full report.
- **Claude has two sources in two precisions.** `rate_limit_event` carries one
  window as a fraction (`mapping.ts:1166`; captured live as `0.85` at
  `mapping.test.ts:1150`). The plan-usage read carries every window as 0-100
  (`sdk.d.ts:3212`), used as-is at `mapping.ts:1178`. The event's `25.6` rounds to
  26, the read's `25` to 25.
- **Claude windows the rail has no slot for take one anyway.** The event's
  `rateLimitType` includes `overage` and `seven_day_overage_included`
  (`sdk.d.ts:4253`), absent from `WINDOW_MINUTES`, so they map with null minutes;
  the record path skips unknown ids (`mapping.ts:1175`) and the flat path does
  not. `useUsage.ts:178` sorts null minutes first and `:184` files them as short,
  so an overage window at 0 takes the five-hour slot — the reported `0%`, which is
  a real zero and not an empty slot (`QuickRail.tsx:865` already prints `—` for
  that). `seven_day_opus` and `seven_day_sonnet` can take the weekly slot the
  same way.
- **Plan reads overlap.** `claude-adapter.ts:750` fires an unawaited read on every
  `system` message, whatever the subtype, and on every `result`, so answers can
  land out of order.
- **Sessions of one agent share one map.** Every conversation's adapter writes
  into the same per-agent entry, last writer wins (`runtime.ts:5300`).
- **Codex updates are sparse, and may name another bucket.**
  `AccountRateLimitsUpdatedNotification` documents itself as a sparse rolling
  update that clients "should merge into the most recent `account/rateLimits/read`
  response", where a null "does not clear a previously observed value".
  `RateLimitSnapshot` has nullable `primary`/`secondary`, a nullable
  `windowDurationMins`, and a `limitId`. `adapter-codex/src/mapping.ts:141-157`
  maps each update on its own, whatever bucket it names. Whether the live server
  sends partial or other-bucket updates is unverified; the type allows both.

## What was asked for, and settled before any code

- **The readings stop flickering**, on both providers.
- **A plan, then micro steps through deepseek**, each reviewed before the next.

## The shape of the answer

### Codex merges as its contract says

A pure `mergeRateLimits(held, update)` in `adapter-codex/src/mapping.ts`, used by
the adapter at both entry points.

- **A read replaces what is held** — it is the snapshot the contract merges into,
  and its `limitId` is the bucket the rail shows.
- **An update for another bucket is ignored.**
- **An update merges field by field.** A null side, or a null
  `windowDurationMins` or `resetsAt`, keeps the held value.
- The adapter holds the merged snapshot and emits windows from it, through the
  existing mapping.

`rateLimitsByLimitId` stays unread.

### Claude has one source per window

- **Only `five_hour` and `seven_day` are emitted**, from both paths. Overage and
  per-model windows have no slot on the rail.
- **Plan reads are single-flight.** The gate lives inside `readPlanUsage`, so the
  manual refresh (`claude-adapter.ts:813`) and the session-start priming loop
  (`:829-839`, started once at `:1490`) pass through it too. A call while a read is
  in flight shares that read and marks one re-read for when it finishes. The
  priming loop's retries are sequential awaits, so they never overlap themselves
  and are not starved.
- **Reads trigger on `system` with `subtype === 'init'`, and on `result`** — the two
  moments the existing comment at `:748-749` names.
- **`rate_limit_event` is demoted, not dropped.** Once a plan read has answered in
  the session, the event triggers a read instead of emitting windows. Before that
  — and for sessions where `rate_limits_available` is false, where the event is
  the only source — its eligible windows are emitted as today.

The demotion lives in the adapter because the adapter knows the source; a merge
further down cannot tell the two apart.

### Main merges per window

A pure `mergeUsageWindows(held, incoming)` in `agent-protocol/src/events.ts`,
beside `UsageWindow` and `toEpochMs`, so main can import it. A window with a
non-null percent replaces the held window with the same id; a held window the
report does not carry keeps its value. `runtime.ts:5299-5301` stores and pushes
the merged list.

### The rail files only windows with a length

`usageReadings` skips a window whose `windowMinutes` is null. **Visible for Codex:**
a snapshot that never carries minutes currently shows a number in the five-hour
slot, and will show the em dash. That is the honest reading the rail's own
comment asks for, and with the Codex merge above it should be rare.

## Rejected

- **"A lower figure within a window is stale."** A legitimately revised-down
  figure, or an account change mid-session, would be ignored until the reset, and
  matching one window across sources by reset moment has no sound tolerance.
- **Dropping `rate_limit_event`.** It is the only source when plan usage is
  unavailable.
- **A sequence guard or timestamps on reports.** Single-flight and one source per
  window remove the out-of-order cases this would have caught.
- **Reading `rateLimitsByLimitId`.** The rail has one Codex account.
- **Changing `QuickRail.tsx`.** It already prints `—` for an empty slot.

## Steps

Each is one micro task for deepseek, reviewed before the next.

1. `adapter-claude/src/mapping.ts` — `usageWindows` emits only `five_hour` and
   `seven_day`.
2. `adapter-claude/src/mapping.test.ts` — overage and per-model windows are dropped
   on both paths.
3. `adapter-claude/src/claude-adapter.ts` — single-flight `readPlanUsage`, and the
   narrowed trigger.
4. `adapter-claude/src/claude-adapter.ts` — the `rate_limit_event` demotion.
5. `adapter-codex/src/mapping.ts` — `mergeRateLimits`.
6. `adapter-codex/src/mapping.test.ts` — its cases: a sparse side, null minutes,
   another bucket, a read replacing.
7. `adapter-codex/src/codex-adapter.ts` — hold the snapshot; route the read and
   rolling updates through the merge.
8. `agent-protocol/src/events.ts` — `mergeUsageWindows`, with its cases in that
   package's tests.
9. `apps/desktop/src/main/runtime.ts` — merge per window before storing and pushing.
10. `apps/desktop/src/renderer/src/workspace/useUsage.ts` — skip null-minute
    windows; `useUsage.test.ts:189` builds one and would then pass without testing
    pace, so it gets a length.

## As built — 2026-09-15

Written by deepseek one micro step at a time, each reviewed against a snapshot
of its file before the next was sent. **Nothing has been typechecked, linted,
tested or run.**

- **Steps 8 and 10 were split** so each touched one file: 8a the function, 8b a
  new `agent-protocol/src/events.test.ts`; 10a the filter, 10b the test.
- **Step 10 was corrected while building.** The plan said the case at
  `useUsage.test.ts:189` should get a length; with one, `pace` returns numbers and
  its null assertions would fail, and without a change it would pass without ever
  reaching `pace`. Instead a new case pins that a lengthless window takes no slot,
  and the pace case uses a zero-length window, which reaches `pace`'s `<= 0` guard.
- **`pace`'s null-minutes clause is kept** as the function's own contract, though
  `usageReadings` can no longer reach it.
- **Codex merges on update and replaces on read** — the contract's own split, not
  an inconsistency: the notification is sparse, the read is the full snapshot. An
  update for another bucket still emits, carrying the held values.
- **Main's map only ever grows.** A window that stops being reported keeps its last
  value until restart; a sparse update is far likelier than a window ceasing to
  exist, which is the premise of the fix.
- **`mergeUsageWindows` sorts**, so the order is canonical even though Codex's
  mapper does not sort. Only the fourth case in `events.test.ts` pins that.
- **Once plan usage has answered, `rate_limit_event` only triggers a read**, and the
  single-flight gate bounds a burst to one read in flight plus one re-read.

## Exit criteria

Checked by hand, over a few turns with both agents and more than one conversation
open:

- No reading moves backwards and forwards between two figures.
- No reading drops to `0%` or `—` and comes back.
- A manual refresh still updates all four.

## Open questions and risks

- **A window that genuinely disappears stays at its last value**, because main
  never clears a window a report omits. A plan change mid-session is the case.
- **A Codex window whose length changes** would leave its old id held beside the
  new one until restart.
- **Nothing in this plan has been run.**
