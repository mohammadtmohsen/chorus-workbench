# Status

## Phase 0 — prove the forwarder is transparent · **passed**, 2026-09-22

Nothing shipped into the repository. Phase 0 is a measurement, and its whole
purpose was to be able to reverse §2.1 before any code depended on it. It did not
reverse.

**What was proven, on this Mac.** A DPoP-signed `POST /api/mobile/v1/auth/identify`
through a `http.createServer` forwarder returned a **byte-identical** status and
body to the same request sent direct, and the proof _verified_ through it — the
backend runs its device-proof gate before the member lookup, so a `200` carrying
`MEMBER_NOT_FOUND` is only reachable by a request whose signature survived the
trip. `CONNECT` blind-tunnelled a real HTTPS page (`200`, 559 bytes) while plain
HTTP kept working on the same server. `server.address().port` is the port
read-back `CLAUDE.md:494` demands, in one line.

**What was proven on the device, which is what the phase actually required.** Expo
Go fetched its **17.7 MB** Hermes bundle through the forwarder at `200` and
rendered the login screen. `CONNECT seen: firebaselogging-pa.googleapis.com:443`
tunnelled blind. Four connections stayed established. A real `identify` from the
app captured `{"dpop":true,"status":200}`.

**And the device found what the Mac could not.** With `Accept-Encoding: identity`
the backend answers chunked plain and the capture reads
`"code":"APP_DEVICE_PROOF_INVALID"`. With `Accept-Encoding: gzip` it answers
`Content-Encoding: gzip` and the capture reads `"code":null`. The real app sends
gzip — OkHttp's default — so the phone's own `identify` showed `code: null,
nextAction: null` on a `200`, with the one field this tool exists to show missing
and **nothing saying it was missing**: the parse throws into the same `catch` that
handles "not JSON at all".

The Mac test could not have found it for a precise reason. Node's `http.request`
sends no `Accept-Encoding`, so the backend returned plain JSON and the parse
worked. "Run it on the device" was load-bearing rather than ceremonial.

### What this corrected in the plan

**§4.5** — the emitted shape gains `parsed`, so a compressed envelope and an empty
one stop being the same observation.

**§6 phase 1** — the bounded tap must gunzip, and a test must cover both encodings.
Stripping `Accept-Encoding` was considered and rejected: it works, and it costs
Metro's 17.7 MB bundle its compression, while gunzipping leaves the wire
byte-identical — which is the property §2.1 rests on and the one phase 0 just
proved.

Both fixes were measured before being written down. Through the forwarder,
`Content-Encoding: gzip` survives, bodies are byte-identical, and the gunzipped
tap recovers `"parsed":true,"code":"APP_DEVICE_PROOF_INVALID"`.

**§6 phase 1's other requirement was also settled here rather than assumed.** The
plan proposed `pipe` for streaming and a separate bounded tap for capture; that
shape was run against a 2.5 MB response and streamed it byte-identical
(`sha 38a637965059`) while producing a correct capture line. One mechanism cannot
do both, and phase 1 does not have to discover that.

### Two operational notes, because both cost a wrong answer

**Any device test here needs a ≥60-second budget.** The app sat on the splash for
about fifty seconds and a failure was written before it was tested for causation —
removing the proxy changed nothing, and it then loaded. The cause was a 17.7 MB
bundle plus a Hermes compile on a mid-range Samsung. A shorter budget reads a slow
load as a forwarding failure and reverses §2.1 for the wrong reason.

**`input keyevent 111` does not dismiss the Android soft keyboard.** `keyevent 4`
does. A "tap Continue" landed on the `5` key instead and typed an extra digit into
the field; the `identify` only fired once the keyboard was gone.

### Still unproven after phase 0

Slow traffic. `curl` and the phone both exercised real keep-alive and a 2.5 MB
body, but nothing tested an upstream that stalls mid-response, and nothing tested
the ring buffer under a Metro reload — that is phase 1's flood test rather than
phase 0's.

The device was left with its proxy restored to `null` and no forwarder running.

## Phase 1 — the forwarder and its push path · **written**, 2026-09-22

**Superseded by the gate section below — this phase is now verified.** It was
written and reviewed with nothing run, and the four findings that produced are
recorded at the end of this file rather than here, because they belong to the act
of running rather than to the act of writing.

**What landed.** `main/traffic.ts` — an in-process HTTP forwarder that streams
byte-identical while reading a bounded, gunzipped envelope alongside, plus a blind
`CONNECT` tunnel — with 15 tests. Then the push path across six layers:
`shared/ipc.ts` (five contract entries, `TrafficRowShape`, the channel, the
`rows | stopped` union, `TRAFFIC_CAPTURE`, six bridge methods), `main/ipc.ts`
(handlers and the forwarder), `main/index.ts`, `main/runtime.ts` (the service, the
adapter seam, shutdown), `preload/index.ts`, and `renderer/src/traffic-stream.ts`
with 15 more tests. Nothing listens until `traffic:start`.

### What review changed, which is the part worth keeping

**§4.5's documented limitation was false of the code.** The tap kept whole chunks,
so the real bound was `tap + one chunk` — about 72 KB with Node's 64 KB chunks —
and "any response larger than the cap reports `parsed: false`" was not true. Asking
for a test of the limitation is what exposed it; arguing about it would not have.

**Two unhandled client-side stream errors could have taken down the main process.**
Node's `Stream.prototype.pipe` re-raises a destination error rather than absorbing
it: its `onerror` calls `cleanup()`, removing the handler it installed, then
re-emits when no other listener remains. Read from the runtime, not remembered.
`upRes.pipe(res)` had no handler on `res` and `req.pipe(up)` none on `req`, and
both fire on an ordinary Metro reload. A fourth instance of the same class sat on
the 400 early-return, which was found by reasoning about the class rather than
patching the instance.

**A 502 meant two opposite things.** Backend unreachable and client-walked-away
produced identical rows. `aborted` separates them, and separates a second pair for
free: a `200` with `parsed: false` is a body too large for the tap, or a truncated
delivery. Two booleans, four situations, deliberately not an enum.

**The service was an open TCP relay, not merely an open proxy.** `listen(0)` binds
every interface and the tunnel opened a socket to any `host:port`. §4.6 is the
answer: listen only while capture is explicitly on, and refuse any port but 443.

**Two deferrals to phase 2 were overruled.** `pendingUntilAttached` belongs beside
the reducer because its twin lives at `terminal-stream.ts:67`, inside the stream
module — the pane never decided that for terminals either. And bounding the
reducer is not the renderer-side eviction §4.4 forbids: that rule is about rows
crossing IPC before anything drops them, not about what the renderer retains after.

### Named and deliberately not closed

The service's `capture` is overridable per instance while the renderer's bound is
the shared constant, so an override above 1,000 would yield attachments the reducer
trims. Every current use is under it. `onFailure`'s fan-out has no test, because
provoking a post-listen server error needs an fd-exhaustion fault; a test seam was
considered and rejected as the worse trade. The disconnect test proves the outcome
and not which of three listeners recorded it, which is the right trade — forcing
one would test Node's event ordering rather than this code. The upstream stall
after headers is still untested.

### One thing from outside the plan

**This repository's own conventions were enforced against by another repository's
guards.** The session is rooted in `tpa-mobile`, so its `PostToolUse` hooks fire on
workbench files and cannot see that the file belongs elsewhere. They blocked a
docstring and `export function forwardTrafficToRenderer`, which now reads unlike
its nine siblings in the same file and unlike `export function shouldApply` in the
twin module it mirrors. Nothing is misconfigured; the scope is simply the session's
root rather than the file's repository.

## Phase 2 — the pane · **written**, 2026-09-22

**Superseded by the gate section below.** Phase 2 is the first part of this that a person can look at,
and it has not been typechecked, linted, tested or launched.

**What landed.** `renderer/src/TrafficPanel.tsx` — one component holding the whole
effect: subscribe, queue while unattached, attach, replay through
`pendingUntilAttached`, ack what was applied, with the `cancelled` guard
`TerminalView.tsx:171-175` documents. Start and stop with the port shown, a bounded
render window of 200 with the total in the header, and 19 `traffic.*` keys verified
used-and-defined both ways. Mounted at `Workspace.tsx:528` in the editor area
beside the rail, toggled from `QuickRail.tsx:326`, gated on local state so it starts
closed each launch — opening it does not listen, so there is nothing to persist
carefully.

### Two decisions taken against the plan's own wording

**§3 said "a pane in the shell, beside the terminal" and both halves were wrong**,
because that sentence was written before reading the layout. `Workspace.tsx:494`
puts the global terminal _inside the editor area_, "below every pane and beside the
rail, which is the only arrangement where the panes keep their full height" — a
region already proven against the `WebContentsView` constraint. The pane mounts
there. And the two panels **stack**: that region is a vertical flex column, and
reworking it so two fixed-height panels share a row would change a working surface
for nothing.

### What review changed

**A request the proxy refused produced no row at all.** The 400 returned before
`record` was defined, so the one situation where the tool's own behaviour is the
answer was the one situation it stayed silent about. Found by checking a premise
rather than accepting one: the reported defect was a mislabelled row, and the real
defect was its inverse.

**A failed action is a different fact from a stopped stream**, and folding the
first into the reducer's `stopped` would have made a button that failed to start
look like a stream that died. The notice is local, clears on the next success, and
the reducer's type is untouched.

**`stopTraffic` nulled its port before awaiting the close.** A rejected close then
left the runtime believing it had stopped while the socket was still bound, and
`startTraffic` would have opened a _second_ port — §4.6's exposure returning through
a failure path. The fix is an ordering, with deliberately no `catch`: leaving
`trafficPort` set is the true state, and `startTraffic:4912` returns an existing
port rather than binding again, so the next start reuses the bound socket. Letting
the rejection propagate is also what makes the renderer's notice appear.

**Unhandled failure is now three instances in two processes** — two Node streams
emitting `'error'` with no listener in main, one promise rejection with no handler
in the renderer. Same silence, same process-that-must-not-stop. Whether that earns
a house rule is the repo owner's to write.

### Named and not closed

The failure notice reuses `.traffic-stopped`, so a failed action and a stopped
stream read identically apart from their words — deliberately left, because
choosing a visual treatment for something nobody has looked at yet is a guess.
`runtime.ts:4949`'s shutdown path still nulls before awaiting; nothing calls
`startTraffic` after a quit, so the ordering cannot bite there.

## The gate — run 2026-09-22, phases 1 and 2 together

```
typecheck        18/18 packages          PASS
lint             0 problems              PASS
format:check     ours clean              11 pre-existing files still fail
workbench:check  manifest up to date     PASS
test             2649 passed, 4 skipped  PASS
```

Two phases were written, reviewed over six rounds and never run, on the owner's
standing rule. They then ran, and the result is the argument for both halves of
that rule — most of what the gate found was mechanical and cost nothing to defer,
and one thing was not.

**Three mechanical classes.** Seven `TS4111` errors in `traffic.ts`, because
`noPropertyAccessFromIndexSignature` is on and both `Record<string, unknown>` and
`IncomingHttpHeaders` reach `data`, `code`, `nextAction` and `dpop` through an
index signature. Two import errors, because `traffic.test.ts` imported `Frame`
from `traffic.js`, which imports the type without re-exporting it. Twenty-one
`restrict-template-expressions` errors, every one a port interpolated into a test
URL, fixed with the `${String(x)}` idiom the repo already uses 92 times.

**And one that reading could not have found.** `close()` destroyed each tunnel's
**upstream** socket and left its **client** socket open, so `server.close()` waited
on a connection nothing would ever close. In the suite it presented as a
ten-second `afterEach` timeout — a flake, on the reading. It is not: `stopTraffic`
awaits `close()`, so stopping capture while a phone held an HTTPS tunnel would have
hung the runtime with the port still bound, which is §4.6's exposure arriving
through the shutdown path this time. The fix is one line, and it is the symmetry
that was already half-present: `client.on('close')` destroyed the upstream, and now
`upstream.on('close')` destroys the client. The file went from 10.58 s to 424 ms.

**Eleven files still fail `format:check` and none are ours.** `remote-workbench.ts`
and `.test.ts`, `Composer.tsx`, `RemoteProjectDialog.tsx`, `command.test.ts`,
`workbench-surface.test.ts`, `docs/install-windows.md` and four plan documents were
all failing before this work began, so `pnpm check` did not pass on this branch
beforehand either. Only our files were formatted; sweeping the rest would bury this
diff inside an unrelated reformat and claim a repair nobody asked for.

## Phase 3 — Metro · **written and gated**, 2026-09-22

```
typecheck        18/18 packages          PASS
lint             0 problems              PASS
format:check     ours clean              PASS  (11 pre-existing files still fail)
workbench:check  manifest up to date     PASS
test             2667 passed, 4 skipped  PASS
```

**The gate found a defect the discriminated union created in a place nobody looked
at.** `traffic-stream.test.ts` built every row through a `Partial<TrafficRowShape>`
factory. Once the row became a union, `Partial` distributed across both arms and
made the discriminant itself optional — so the factory produced a value that is
neither an `http` row nor a `log` row, and the reducer's entire suite had been
running against it. `Extract<TrafficRowShape, { source: 'http' }>` on the override
plus a pinned `source: 'http'` on the base is the fix.

Then twenty-two lint errors in two classes. Twenty were `row?.` accesses that went
stale the moment a narrowing helper started returning a non-nullable row, plus one
`row === undefined || row.source !== 'http'` that narrows identically as
`row?.source !== 'http'`. Two were `no-control-regex` in `log-lines.ts`, where the
control characters are the module's whole subject rather than an accident; they take
a file-scoped disable carrying its reason, the form `services.ts:321` already uses
in a repo with eight such directives under `src/`.

### Three operational notes, each of which cost a wrong answer or nearly did

**A pipeline's exit code is the last command's, not the interesting one's.**
`pnpm run typecheck | grep -E "error TS|Tasks:"` exited **0** on a run that had
_failed_, because `grep` succeeded at matching the error line. It was nearly
reported as a pass. Capture the real status — redirect to a file and echo `$?` —
rather than piping a gate step into a filter.

**`reap.test.ts` is load-sensitive and will flake under a parallel gate run.** It
shells out to scan the process list against a 5-second budget, and it timed out
while a full `eslint .` was saturating the machine beside it. In isolation: 3 of 3
in 2.55 s. Nothing to do with this work, but it will look like a regression to
whoever meets it.

**A cold turbo cache here is minutes, not seconds.** `shared/ipc.ts` changed and
every package depends on it, so the typecheck went from a 5-second cache replay to
over seven minutes, and `eslint .` builds a type-aware program across all eleven.
Both need backgrounding rather than a longer timeout.

Three units: a tap in `terminal.ts`, the source-tagged row with its log intake and
line assembler, and the pane's picker. `traffic-stream.ts` was never touched, which
is the signal that the union was the right shape.

### The decision the owner delegated, and why it went the way it did

**Nothing reads a terminal's scrollback.** `TerminalPush`'s own docstring calls it
"the sharpest instance of the unsolved half of C-021 — `cat .env`, `env`, a pasted
token — and nothing scrubs a shell." An accessor over history widens that to every
consumer written afterwards, and a bounded tail does not help, because a terminal
running Metro in the foreground still holds whatever was typed before Metro started.

So phase 3 **observes rather than reads**, and the person picks the terminal.
Detection was considered and rejected on measurement, not taste:
`describeForeground` returns the shell's own name on Windows, and on macOS
`npm run dev` reports as `node`, which matches every other Node process. Pattern-
matching Metro's banner would have meant subscribing to every terminal, which
recaptures exactly the tokens the ruling refused.

### What review changed

**The mechanism in the first ruling was wrong even though the ruling was right.**
`absorb` at `terminal.ts:626` only queues and emits `if (session.attached)`, so a
Metro terminal in a background tab emits nothing and "subscribe to the live stream"
does not work as stated. The answer is the tap — the same "forward by `pipe`, read
by a separate bounded tap" argument phase 0 settled for traffic, one file over.
Sixteen insertions, zero deletions, and every guarded field untouched.

**A CSI escape split across two pty chunks rendered as literal text.** `\x1b` sits
inside `CONTROL`'s `\x0e-\x1f`, and the carry was being `CONTROL`-stripped — so a
chunk ending `\x1b[3` lost its ESC, and the next chunk produced `[32m` on screen.
The carry now stays raw; `CONTROL` applies only to completed lines, where `ANSI`
has already removed whole escapes. The test asserts the carry byte-for-byte, because
one checking only the recovered line passes for the wrong reason.

**The exit event was being swallowed**, which undid the reason unit 1 carried it —
a dead Metro terminal looked exactly like a quiet one. It now flushes the carry
first, then records a row carrying the code, worded in the renderer through
`terminal.processExited` as `TerminalView.tsx:197` already does.

**And `clip` kept the tail of an over-long line.** For the carry that is right; for
a line it is backwards, since a 4,000-character line is a stack trace and cutting
the front discards what it was about. The old tests could not tell the two apart —
their filler was `'y'.repeat(…)`.

### Named and not closed

**A Metro run in the workbench terminal is invisible to this, by construction** —
that is the editor's REH PTY, not Chorus's, and `main/terminal.ts` never sees it.
"Why is my Metro not showing" has two answers and only one is a defect.

A throwing tap listener still propagates into node-pty's data callback; ordering
protects the view's protocol but not the process, which matches `emit`'s own
behaviour. The only caller is ours and it is total. A dangling escape truncated by
a killed terminal is flushed as a completed line, so something like `[3` reaches
the pane — honest, since it really was truncated, but visible. The source control
is a native `<select>`, which will not match the app's other controls.

### Still unproven, across all three phases

Nothing has been **launched**. The pane has never been rendered, no phone has been
pointed at the running app, and `TrafficPanel.tsx` has no test — it is a component,
and the repo tests reducers rather than components. `onFailure`'s fan-out and the
mid-response stall remain untested for the reasons recorded above.
