# A settle that never arrives

**Status: built and green in tests — typecheck, lint, the Traffic suites and
the full suite. Not yet driven in the app or on a real phone capture.**

## The problem

Reported from a real tpa-mobile capture on 2026-09-27: rows sit on the spinner
with Outcome "Pending" for ever, although the app got its answer. The stuck rows
are the ones that travel in a burst — four `GET /me/approvals*` fired together,
two `POST /auth/refresh` around a `401 APP_SESSION…` — interleaved with rows
that settled normally.

A row is pending while `status === null && !aborted` (`traffic-filter.ts`). It
leaves that state only when its settle — the same sequence rewritten with a
status — reaches the renderer.

## Why the settle is lost

`TrafficService` paces its subscriber the way the terminal paces a renderer: a
consumer acknowledges what it has drawn, and once 64 sequences are unacknowledged
(`PENDING_HIGH`) the service pauses. While paused, `absorb` empties the outbox
before queueing each row (`if (this.paused) this.outbox.length = 0`), so each
8 ms frame delivers only the **last** row absorbed in it.

**Nothing acknowledges a `TrafficService` in production.** `cb87f0c` built the
pacing and, in the same commit, put `ProjectTrafficRegistry` between the service
and the renderer. The registry calls `service.attach()` once and never
`service.ack()`; the renderer's `ackTraffic` reaches `TrafficIpc.ack` and stops
there. The only `.ack(` on a `TrafficService` anywhere is `traffic.test.ts:697`.

So `ackedSeq` is frozen at the attach value. After the 64th row of a capture
`paused` latches and never releases, and from then on every frame with more than
one row in it loses all but the last. A request's start and its settle are
separate absorbs, usually in different frames. Requests fired together are
answered together, so their **settles** share a frame and all but one are thrown
away. The row stays `status: null` — Pending — for ever.

**Nothing downstream can recover it.** The registry's journal never received the
row. The one recovery path, `resync` → Refresh → `snapshot`, re-reads that
journal, so it redraws the same Pending row. The service's own ring holds every
row, but `service.snapshot()` has no production caller.

The same mechanism drops **starts**: a request whose start shares a frame with a
later row never appears in the panel at all, and its settle is discarded by
`append` because its sequence is already behind the journal's.

The existing test that pins this, `coalesces pushes once an attached view falls
behind, and drops none of the ring` (`traffic.test.ts:633`), asserts that 100
requests arrive as one push holding one row. That was the design: coalesce the
stream, re-read the ring. The ring is never re-read, so the coalescing is loss.

## The shape

### The service stops pacing; the IPC boundary keeps its own

The service's only consumer is the registry, in the same process, synchronous.
It cannot fall behind, so pacing it measures nothing — and when it does trip, it
destroys data that has no second copy downstream.

Backpressure already exists where it belongs, at the process boundary.
`TrafficIpc` holds one delivery outstanding per subscription, and past
`PENDING_LIMIT` or `PENDING_BYTES` it replaces the queue with a `resync`. The
renderer shows Refresh, and Refresh reads the journal — which, once the service
delivers everything, is complete. That path loses nothing.

So `TrafficService` delivers every absorbed row to its subscriber on each frame,
and the pacing goes: `pace`, `paused`, `ackedSeq`, `PENDING_HIGH`,
`PENDING_LOW`, `ack`, and the outbox-clearing line. `attach` keeps its epoch and
its replay of the ring; `TerminalService` carries its own copy of the constants
and its own `pace`, and is not touched. The coalescing described in
`the-traffic-is-not-a-transcript` and `a-row-that-is-still-waiting` is gone
after this; those plans are records of what was built then.

**No cap replaces it, on purpose.** A logcat dump now becomes one push per
frame holding every line of the chunk. That is bounded one layer up:
`TrafficIpc` splits a push past `DELIVERY_BYTES`, and past `PENDING_LIMIT` or
`PENDING_BYTES` replaces the queue with a `resync` — against a journal that is
now complete, so the bound costs a Refresh, never a row. The cost that does
move is CPU: a 1,000-line push is a `findIndex` per row in `append`, three
`JSON.stringify` of the push in `TrafficIpc`, and a stringify-compare per row
in `reduceTraffic`. It is the load `sends every row when the view keeps up`
always assumed, which the latch was suppressing by accident; it is noted below,
not fixed here.

### Rejected: ack from the registry

deepseek's first proposal, and the smallest diff: one `service.ack(push.epoch,
push.seq)` in the registry's subscription. It unlatches the steady state, but
`pace` runs **before** each drain. Logcat and terminal log lines feed the same
service, and `linesFrom` emits every line of an `adb logcat` chunk in one
synchronous loop — hundreds of absorbs in one tick, one frame. Pacing latches
at the 64th, the outbox is cleared on each absorb after it, and the drain sends
one row; the ack arrives only after that drain, with 69 of 70 rows already gone.
Any HTTP settle in that frame is lost exactly as today. deepseek traced this row
by row and withdrew the proposal.

### Rejected: keep the pacing, delete only the clearing line

It leaves a bound that can never fire — the consumer is synchronous and
in-process — shaped as if it could. Dead code with a misleading shape.

### Examined and left: the snapshot race

`applySnapshot` replaces the rows wholesale. A push computed before the snapshot
but applied after it could carry an older version of a row. It cannot leave a
row wrong: the invoke reply and the pushes arrive in order, and after a `resync`
the queue is contiguous, so replaying it walks each row forward to its latest
version.

## Code

`main/traffic.ts`, `absorb`:

```ts
this.pace()
if (!this.attached) return seq
if (this.paused) this.outbox.length = 0
this.outbox.push(row)
this.schedule()
```

becomes

```ts
if (!this.attached) return seq
this.outbox.push(row)
this.schedule()
```

and `pace`, `ack`, the `paused` and `ackedSeq` fields, their resets in `attach`
and `detach`, and `PENDING_HIGH` / `PENDING_LOW` are deleted.

## Files

| File                           | Change                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `main/traffic.ts`              | delete the service's pacing                                                                        |
| `main/traffic.test.ts`         | the reproduction; `:633` rewritten to the lossless contract; `:686` drops its `ack` and is renamed |
| `main/project-traffic.test.ts` | a synchronous burst through the registry reaches the journal whole                                 |
| `main/traffic-ipc.ts`          | `splitDelivery`: the head fragment declares its own highest sequence                               |
| `main/traffic-ipc.test.ts`     | an oversized delivery arrives as fragments that each declare their own high-water mark             |

## Units

1. **Reproduce.** Two tests, written against the current code and run to prove
   they fail.
   - `traffic.test.ts`: after 64 rows, two rows absorbed in one manual frame —
     both must be delivered, and the ring holds all 66.
   - `project-traffic.test.ts`: a started registry, source `logcat`, 70
     `logcatLine` calls in one loop — the journal must hold 70 rows. One tick is
     one frame by construction, so this cannot pass by timing luck, which a
     four-request HTTP burst on the real 8 ms timer could. It needs no seam:
     `selectSource` only changes state.
2. **Fix.** The deletion above; `:633` becomes "delivers every row of a burst
   the view has not caught up with"; `:686` keeps ring replay and the rising
   epoch, drops the superseded-epoch `ack`, and is renamed so its title stops
   describing an ack. Both tests from unit 1 now pass.

3. **Added after deepseek's final review: a split delivery loses its tail.**
   `splitDelivery` halves a push over `DELIVERY_BYTES` and gave both halves the
   whole push's `seq`. The renderer raises `state.seq` to it on the head, then
   skips every row of the tail it does not already hold, because
   `row.seq <= state.seq` — silently, with no resync. Before unit 2 a push could
   exceed 64 KB only in a capture's first 64 rows; after it, any logcat burst of
   roughly 800–3,200 lines does, so unit 2 made this reachable and criteria 2
   and 3 owe the fix. The head now declares the highest sequence among its own
   rows; the rest keeps the push's, so the view ends on the same `seq` an
   unsplit push would have given it, and a rest split again takes the same rule.
   The test failed first (`expected 400 to be 200`) and passes after.

Sequential: 2 is only proved by 1 failing first, and 3 by its own test failing
first.

## Acceptance criteria

1. **The reproduction:** after any number of rows, every settle reaches the
   journal and the panel. No row a finished exchange owns stays Pending.
2. Every start reaches the panel — no request vanishes.
3. A burst of more rows than one frame can hold — logcat — loses nothing: it is
   delivered, or the view is told to Refresh and Refresh shows every row.
4. A request genuinely in flight still shows Pending, and an open stream (SSE)
   still shows Pending until it ends — unchanged by design.
5. Unchanged: row order, upsert by sequence, a settle for a trimmed row dropped,
   Clear, the resync/Refresh banner, the terminal's pacing.
6. On a real capture — tpa-mobile through a `401` → refresh burst — no row is
   left Pending once the app has its answers.

## Verification

Unit 1's tests fail before the fix and pass after it. Then `traffic.test.ts`,
`project-traffic.test.ts` and `traffic-ipc.test.ts`, then `pnpm check`. Then the
app is driven (`e2e/traffic-drive.mjs`) and a real phone capture is run, because
criterion 6 is the user's report and only a capture can close it. Each of these
runs only with the user's go-ahead.

## What this deliberately does not do

- **No "Streaming" state.** An SSE stays Pending until it ends, as
  `a-row-that-is-still-waiting` decided.
- **No reader for `service.snapshot()`.** Once the service delivers every row,
  the journal is the complete record and the ring stays test-facing.
- **No change to `TrafficIpc`'s backpressure or the Refresh banner.**
- **No change to the cross-project trim** (`ROWS_OVERALL`). It can trim a
  journal row the renderer still draws, whose later settle `append` then skips.
  It needs several projects past 4,000 rows combined; noted, not fixed here.

- **No change to the per-push CPU cost** described above: three stringifies per
  delivery in `TrafficIpc`, and the linear scans in `append` and
  `reduceTraffic`. Worth its own change if a logcat dump is seen to stutter.
- **`TrafficService.detach` and `epoch`** have no production reader after this
  — `detach` had none before it either. Left, not deleted.

## Open questions

- Does a large logcat dump now resync, or stutter the panel? It should do
  neither under normal load — to be confirmed by the drive.
