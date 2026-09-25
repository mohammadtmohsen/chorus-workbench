# The traffic is not a transcript

One pane in Chorus that shows what the app and the web app are actually sending —
the request, the response code, whether a `DPoP` proof was attached — so that
three separate capture tools can be uninstalled and the answer stops being two
clicks deep in a generic table.

This plan spends its first section on why none of it may reach the event log,
because that is the decision rather than the commit, and because `CLAUDE.md`
already answers it for a neighbouring case and the answer transfers with more
force than it was written with.

> **Revision 2.** Rewritten after one adversarial review. Corrections are recorded
> where they apply rather than patched out, because in every case the defect was
> this plan asserting something nobody had run.
>
> Revision 1 → 2, six findings, all upheld. The load-bearing one is §2.1: the
> capture engine was **assumed to be mitmproxy and never chosen**, and an
> in-process forwarder was measured producing the identical line with four of the
> plan's costs deleted. Revision 1's §4.2 claimed a spawned `mitmdump` dies with
> its parent — **false, and measured false**: after the parent's SIGKILL it is
> PPID 1 and still holds the port. Revision 1's §4.5 claimed a general redaction
> rule and was a two-route denylist. Revision 1's §4.4 put eviction in the
> renderer, behind the IPC boundary §1 exists to protect. Revision 1's §2.2
> called the Metro read "one accessor" and it is a second consumer of a
> single-consumer sequence protocol.
>
> Nothing has been built. Every mechanism claim carries its file and line or the
> command that produced it, and the three claims that are still unproven say so.

## The problem

Three capture tools are installed on this machine — Proxyman, HTTP Toolkit and
mitmproxy — and the two with the better interfaces gate their useful half behind
a paid tier. That is the visible complaint. It is not the real one.

The real one is that none of them knows what the traffic means. Debugging the
mobile registration flow is a loop of "type a subscriber id, tap Continue, find
out whether the backend answered `REGISTER` or `MEMBER_NOT_FOUND`" — and in all
three tools that answer is a JSON body you have to open a request to read, next
to forty bundle fetches from Metro. The field that decides the next twenty
minutes is `data.nextAction`, and no general-purpose viewer will ever put it on
the row.

Chorus already owns a bounded terminal mirror and a push channel for facts that
are not history. A pane that reads `nextAction` off the row is a smaller thing to
build here than a fourth tool is to install.

## 1. Why this may not be an event, and what that buys

`CLAUDE.md:176` says terminal output is not a log event, and is careful to say the
usual test does not settle it — last week's build output would be useful to read
back. It is excluded for two other reasons, and both apply to captured traffic
harder than they apply to a shell.

**The log records the conversation.** Captured traffic is a second stream that
happens to share a window. It has no `conversationId` to file an event under —
the phone is not talking to a conversation, it is talking to a backend — so every
consumer downstream of `mapping.ts` would have to answer "is this one mine?"
forever, for a stream whose honest answer is always "no".

**And it is the worst instance of C-021's unsolved half.** That entry is open
because storing what an agent read means storing whatever it read, including
files the permission engine treats as secret. A terminal is sharp — `cat .env`,
a pasted token. A captured HTTP request is sharper, and not occasionally but
structurally. Every authenticated call to this backend carries
`Authorization: DPoP <token>` and a signed device proof. `POST /auth/register/complete`
carries a password and its confirmation. `POST /auth/otp/verify` carries the code
texted to a real person's phone. `POST /auth/identify` carries the login name,
which this owner now types as a **national number**. `GET /api/mobile/v1/me`
returns a national number, a date of birth and a family tree. There is no
scrubbing story for that, and writing it to SQLite would put a member's
credentials on disk in a file that is deliberately append-only.

So the shape is the shape `terminal.ts` already chose: **a bounded mirror in
main, replayed to a view on attach, gone when the app closes, pushed on its own
channel, never appended.**

The saving is larger than the constraint. `CLAUDE.md:275` prices a new event type
at five files — `events.ts`, the `ChorusEventPayload` schema,
`conversation-service.ts`, a projection, a `catchup.ts` case — plus the renderer's
`transcript.ts` and `Entry.tsx`. None of that is owed. There is no schema
migration, no projection to rebuild, no exhaustive switch to satisfy, and no
question about whether the other agent should be told: it should not, because the
other agent runs under its own harness and cannot act on a request our proxy saw.

There is a second reason to keep it away from the store that has nothing to do
with secrets. `better-sqlite3` is synchronous on the main thread. A capture
stream is the one workload in this app whose volume is set by something outside
it — a Metro reload is hundreds of requests in a second — and the event log is
the last place that pressure should land. §4.4 is where that volume is actually
handled, and revision 1 got it wrong.

## 2. What the sources actually are

Measured on 2026-09-22, in the order of what they cost.

### 2.1 The engine is in-process, and the measurement that chose it

**Revision 1 assumed mitmproxy and never chose it.** That assumption produced a
Python file, a port-discovery problem, an orphan class of bug and half of phase 0.
An in-process forwarder was then measured and it produces the identical line with
all four deleted.

A plain `http.createServer` in main, forwarding to the target and reading the
response envelope as it passes, emits:

```json
{
  "m": "GET",
  "u": "http://88.99.104.107:30081/api/mobile/v1/auth/identify",
  "dpop": false,
  "status": 400,
  "code": "MOBILE_CLIENT_HEADERS_MISSING"
}
```

That is byte-for-byte what a `mitmdump` addon produces for the same request. What
it does not need: a `.py` file written to a temp path at spawn — the first Python
this TypeScript app would ever carry; a child process; a port to discover, since
`server.address().port` **is** the read-back `CLAUDE.md:494` demands, in one line;
and a reaper, since a server inside main cannot outlive main.

**The measurement that makes this decisive is the orphan test.** Revision 1's §4.2
claimed `reap.ts` had established that stdio-connected children die with their
parent, and transferred that to `mitmdump`. It does not transfer: that measurement
was about children that _read stdin_ — `claude` and `codex` — and `mitmdump` never
reads stdin, so closing the pipe tells it nothing. Run: a Node parent spawns
`mitmdump -q -p 8099`, the parent is SIGKILLed, and four seconds later the child
is **PID 62305, PPID 1, still LISTENing on 8099**. A spawned proxy is C-058 with a
different front door, and `-p 0` does not mitigate it — it makes the leak _silent
and cumulative_, one orphan per crash on a port nobody will ever be refused from.

Two further facts against the spawned engine, both from the review. `mitmdump -p 0`
binds an ephemeral port but prints **nothing** — Python buffers stdout when it is
a pipe, so the port read-back has no source. And an addon reporting its own bound
port is **unproven**: the probe failed with
`'AddonManager' object has no attribute 'keys'`.

**What is given up, stated plainly rather than buried.** mitmproxy would make
HTTPS interception a configuration change; in-process makes it a rewrite. It also
brings a decade of correctness on chunked bodies, connection reuse, HTTP/2 and
WebSocket that a hand-rolled forwarder will get wrong somewhere. §5 already
refuses TLS interception, so this is not a capability being lost — but the two
are coupled and revision 1 treated them as independent.

**One defect a `curl` test cannot reach, and it is the difference between thirty
lines and forty.** A device configured to use a forward proxy sends `CONNECT` for
every HTTPS host it talks to — Expo's servers, analytics, anything. A bare
`http.createServer` answers a `CONNECT` with **nothing at all**: measured, the
response was empty and the socket closed. A phone pointed at it would lose every
HTTPS request silently while plain HTTP kept working, which is the worst kind of
breakage to debug. The server must handle the `connect` event with a blind
`net.connect` tunnel — pass the bytes through, inspect nothing. That is ten more
lines and it is not optional.

**Still unproven, and phase 1 proves it first:** the forwarder has only been tested
with `curl`. A real DPoP-signed request from the phone has not been through it.
`htu` is method-plus-URL and header order should not matter, but "should not" is
not a measurement.

### 2.2 Metro is nearly free, and the gap is a protocol not an accessor

`terminal.ts:2` imports `@xterm/headless`, the mirror is bounded at
`SCROLLBACK = 5_000` (`:207`, overridable through `options.scrollback ?? SCROLLBACK`
at `:300`), and a `SerializeAddon` is loaded at `:559`. So if `npm run dev` runs in
a Chorus terminal, Metro's output is **already captured**, already bounded,
already in main.

**Revision 1 called the gap "one accessor". It is a second consumer of a protocol
written for one.** `terminal.ts:329` documents the hazard exactly: _"Wait for the
mirror before serializing, or the snapshot is behind `seq`. `mirror.write` is
asynchronous, so serializing with writes outstanding returns a screen missing the
most recent output while `seq` claims to include it — and the view would then
discard the pushes that would have filled the gap."_ `attach` therefore awaits
`this.settled(session)` and leans on a microtask-versus-macrotask argument for
atomicity.

A pane reading scrollback must join that same drain-and-`seq` discipline or it
produces a snapshot that disagrees with the sequence number it reports. That is a
change to the most carefully guarded service in main, and it is what phase 3 is
actually buying.

### 2.3 `adb logcat`

Unbuilt and cheap, and the only source that still needs a child process. `adb` is
on PATH and a device is attached. It is `child_process.spawn` with a line reader,
filtered to the app's tag — and because it _is_ a child, everything §4.2 says
about disposal and the reaper applies to it rather than to the proxy.

### 2.4 The browser console is the biggest of the four

Unbuilt, with no precedent to copy. There are **zero** uses of
`webContents.debugger` anywhere under `apps/`; the single mention of CDP is a
comment at `workbench-surface.ts:332` observing that a native dialog cannot be
clicked by it. Reading a browser's console means attaching a debugger session and
subscribing to `Runtime.consoleAPICalled` and `Log.entryAdded`, on a browser this
app does not launch and does not own. It is the one source whose work is mostly
new rather than mostly wiring, and it is last for that reason.

### 2.5 The backend log is cut, and the reason is not the one you would guess

The service is **reachable and running** — two `gradlew bootRun` processes on the
backend box for `C:/TPA-MEDEXA/MasterTPABackend`, a `-jar backend-running.jar`,
port 8080 listening, and an ssh session that already works. So "the backend is
unreachable" is false and must not be written down.

What is missing is a log to read. `application.properties` carries **only**
`logging.pattern.console`, and there is no logback configuration file anywhere in
`src/main/resources`. The service logs to the stdout of whichever terminal ran
`bootRun` — not a file, not a container log driver, not the Windows event log.
Making it readable means adding `logging.file.name` and restarting the service, in
a different repository owned by someone else.

Cut it. Record the precise reason, because the next person to check that box will
find a healthy service and conclude the plan was wrong.

## 3. Where it goes on screen

A decision rather than a layout detail, and `CLAUDE.md:220` is why. Each project's
editor is a `WebContentsView` that main composites **over** the window. Nothing the
renderer draws can be on top of it — no z-index, no portal, no stacking context —
and a dialog over that region is drawn cut in half. The escape hatch is
`workspace/overlay.ts` and `useShellOverlay`, which hides the views and hands back
a JPEG still so the region does not go black.

So the pane is a **pane in the shell**, beside the terminal, in the region the
renderer already owns. Not a floating panel, not a dialog, not an overlay over the
editor. If a detail view ever needs to sit above a pane, that is the moment
`useShellOverlay` becomes required reading — and the plan should be revised then
rather than designed for it now.

## 4. The shape of the answer

### 4.1 The proxy is a server in main; only `adb` is a child

`apps/desktop/src/main/traffic.ts`, beside `terminal.ts`.

The proxy is an `http.Server` created in main, with a `connect` handler that blind
-tunnels, listening on port 0 and reporting `server.address().port`. It has no
process lifetime of its own and cannot be orphaned.

`adb logcat` is a child and takes the `terminal.ts` treatment, because the parts
worth copying are the guards rather than the spawn. The spawner is an **interface
injected through options**, the way `TerminalServiceOptions.spawn` (`:298`) takes
`PtySpawner` (`:177`) with the real implementation at `nodePty` (`:707`) — every
test drives a fake and nothing in the suite starts a device tool. `dispose(ref)`
(`:448`) is the only thing that kills a child, and `disposeIfCurrent(ref, epoch)`
(`:464`) exists because a dispose carrying a superseded epoch is a stale click
from a view already replaced.

Use `child_process.spawn`, never a PTY. `adb` is not interactive, and the
node-pty exec-bit trap is avoided entirely by not going near it.

### 4.2 The port is never a constant, and the orphan rule now applies to `adb`

`CLAUDE.md:494`, verbatim:

> `launch` now passes `--remote-debugging-port=0` and reads the port back out of
> the child's own stderr, so attaching to someone else's app is impossible rather
> than unlikely. If you add another way to drive the app, do the same.

This is another way. For the in-process proxy the compliance is one line —
`listen(0)` then `server.address().port` — and it is a stronger form of the same
rule, because there is no child whose output could be missed or buffered.

**Revision 1 claimed the reaper was "a backstop rather than the mechanism". For a
port-binding child that is false**, and §2.1 records the measurement. The rule
that survives: any child added here goes in `reap.ts`'s `AGENT_PATTERNS`, and the
PPID-1 check does work — it is how the orphan was found. `adb logcat` is the only
child this plan adds, and it binds no port, which is the reason the leak it can
cause is recoverable.

### 4.3 One push channel, four source tags

The five layers, copied from the shape `LimitsPush` and `TerminalPush` already
use:

1. `shared/ipc.ts` — `TRAFFIC_PUSH_CHANNEL` and a `TrafficPush` zod schema, a
   discriminated union over the source, with the TypeScript type **inferred** from
   the schema the way `TerminalPush` does at `ipc.ts:2102`
2. the bridge interface (`ipc.ts:2262`'s neighbourhood)
3. the main implementation (`runtime.ts:4807`'s neighbourhood)
4. `preload/index.ts` — `TrafficPush.safeParse` at the boundary, as
   `preload/index.ts:271` does for terminals
5. a pure reducer in the renderer

One channel with a source tag rather than four, because the pane shows them
interleaved in time and a consumer that has to merge four streams by timestamp is
worse than a union.

### 4.4 Backpressure is in main, and revision 1 put it in the wrong process

**Revision 1 put eviction in the reducer — the renderer — so every one of §1's
"hundreds of requests a second" would cross IPC before anything dropped it.** That
is §1's volume argument landing on the one boundary §1 exists to protect.

The machinery is in the file next door. `terminal.ts:221-222` defines
`PENDING_HIGH = 64` and `PENDING_LOW = 16`, and the comment above them describes
this exact failure: _"Without this a `yes` loop outruns the mirror and corrupts the
snapshot the panel exists to restore — and it does so worst when the panel is
hidden and no renderer is attached to apply any backpressure of its own."_ The
`Session` carries `pending`, `ackedSeq`, `outbox`, `flush` and `drained` to run it.

Copy it. The ring buffer and its eviction live in main with an explicit bound;
pushes are gated on an acknowledged sequence; a hidden pane is the case the design
is measured against rather than the case it forgets.

The renderer still holds the judgement, per `CLAUDE.md:337` — `terminal-stream.ts:51`'s
`shouldApply` is the model. What belongs there is _which rows are interesting_,
not _which rows survive_. Every string carries an `i18n/en.json` key; reducers have
no translator, so anything a reducer decides is a key rather than a sentence.

### 4.5 No body is captured, ever

**Revision 1 described a general redaction rule and shipped a two-route denylist.**
It named `register/complete` and `otp/verify` and missed `identify` — which carries
the national number §1 itself cites as sensitive — along with `login`, `refresh`,
every query string and every `Set-Cookie`.

A denylist over a surface that grows is the wrong shape. **Invert it.** The capture
emits exactly:

```
{ m, u, dpop, status, parsed, aborted, code, nextAction }
```

`dpop` is a boolean, never the proof. `code` and `nextAction` are read from the
response envelope, which is where they live. **No request body is read at all, and
no response body is retained** — the forwarder parses a bounded prefix far enough
to find two fields and keeps neither the buffer nor the rest.

`parsed` exists because phase 0 found the failure it guards. The bounded tap must
gunzip before parsing — the real app sends `Accept-Encoding: gzip`, OkHttp's
default, so the backend answers `Content-Encoding: gzip` and a parse of the raw
bytes throws into the same `catch` that handles "not JSON at all". Without
`parsed`, a compressed envelope and an empty one are indistinguishable, and the
one field this tool exists to show reads `null` on a `200` with nothing to say it
was ever there.

§2.1's measurement is what makes this sufficient: the proven line carries `code`
without carrying a body, and §2.1 of revision 1 already said `nextAction` "is the
entire point". A URL is retained in full and is the one place a token could still
appear — if a query parameter ever carries a credential on this backend, that is a
backend defect to raise rather than a reason to widen this rule.

**And `parsed` carries a limit that must be documented rather than discovered.**
`JSON.parse` needs a whole document, and the tap stops at a bounded prefix — so any
response larger than the cap reports `parsed: false, code: null` even though the
fields are in its first bytes. That is correct behaviour and it will look like a
defect to whoever meets it first. The auth calls this tool exists for are a few
hundred bytes; a list endpoint is not, and will simply say it could not be read.

**`aborted` is there because a status alone lies in one specific way.** When the
client goes away before any header is written, the row has no status to carry and
falls back to 502 — the same 502 an unreachable backend produces. Those are
opposite diagnoses: one sends a person to the backend, the other means the phone
walked away, and a tool whose whole argument is that the answer is on the row
cannot afford to conflate them. One boolean separates them, and it separates a
second pair for free: a `200` with `parsed: false` is a body too large for the tap
when `aborted` is false, and a delivery cut short when it is true. Two booleans,
four situations, no enum to grow.

### 4.6 It listens only while capture is on, and the tunnel is not a relay

Unit 1 surfaced an exposure that the design owed an answer to and did not have one.
`listen(0)` with no host binds every interface, and the `connect` handler opens a
socket to whatever `host:port` it is given. While the server runs, anything on the
same network can use Chorus as an **open forward proxy and an arbitrary TCP relay**
— not merely an HTTP one.

mitmproxy has the same property and it does not matter there, because a person
starts mitmproxy for a session and stops it. Chorus runs all day. That difference
is the whole argument, and it produces two requirements rather than a warning.

**The server does not listen unless capture is explicitly on**, and stops when it
is turned off. Not a setting that defaults to on, and not started at boot with the
runtime. §5 already says a person points the phone at it by hand; this is the same
principle applied to the port's lifetime.

**The tunnel refuses any port but 443.** It exists so HTTPS passes through
uninspected — §5 — and nothing this tool serves needs a tunnel to anything else.
Refusing the rest costs nothing real and removes "arbitrary TCP relay" from what a
running Chorus offers a network.

## 5. What we are deliberately not doing

**No TLS interception and no CA certificate — and this is now coupled to §2.1.**
Both backends this serves are plain HTTP today: `tpa-web-1/.env.local` sets
`JAVA_API_BASE_URL=http://88.99.104.107:30081` and the mobile app uses the same
host. That fact is what makes the in-process engine viable. Accepting it means
accepting that the day either moves to HTTPS, inspection is a **rewrite** and not a
flag — HTTPS traffic will still pass through the blind `CONNECT` tunnel, simply
uninspected. Revision 1 stated this non-goal as if it were independent of the
engine. It is not, and that is the trade being made.

**No persistence, and not as a setting.** §1 is the whole argument. A toggle that
wrote captures to disk would reintroduce every problem it exists to avoid, behind
a switch nobody remembers flipping.

**No request replay, editing or interception rules.** mitmproxy does all of that
well and stays installed for the times that is what you want. This pane reads.

**No forking mitmweb's frontend.** What ships in the cask is a minified
`index-*.js` with no source, bound to a WebSocket protocol that moves between
versions.

**No VS Code extension.** The pane is first-party in the shell. An extension would
be constrained by the workbench's own CSP — `security.ts` sets `default-src 'none'`
and never sets `frame-src` — and would install globally anyway, because one remote
extension host serves every project (C-063).

**No system proxy management.** Chorus runs the proxy and shows the port. The
phone's proxy setting and the web dev server's `HTTP_PROXY` are set by a person. An
app that rewrites the OS network configuration breaks every other network client
on the machine when it leaks.

**No backend log**, for the reason in §2.5.

## 6. Phases

**Phase 0 — prove the forwarder is transparent, before any UI.** Revision 1 spent
this phase proving a child dies with its parent; §2.1 removed the child, and the
real risk moved. The risk now is that a hand-rolled forwarder is _not_ invisible to
the thing being debugged. Point the phone at it and prove: a DPoP-signed
`identify` gets the same answer through the proxy as without it, and `CONNECT`
passes HTTPS through untouched. If the proof fails, §2.1's decision is reversed and
mitmproxy returns with its costs.

**Phase 1 — the capture server and the channel.** `traffic.ts`, `listen(0)`, the
`connect` tunnel, the bounded ring buffer with `PENDING_HIGH`/`PENDING_LOW`
backpressure in main, and the five push layers. Mobile and web API only. No UI; a
test asserts that a fake upstream's responses become pushes, and that a flood is
dropped in main rather than in the renderer.

Two requirements phase 0 added rather than proposed. The response is forwarded by
`pipe` **and** read by a separate bounded tap — proven on 2.5 MB, byte-identical
(`sha 38a637965059`) while still capturing — because one mechanism cannot do both.
And that tap gunzips: `zlib.createGunzip()` when `content-encoding` says so, which
leaves the wire untouched. Stripping `Accept-Encoding` on the way out would also
work and is the wrong trade — it costs Metro's 17.7 MB bundle its compression, and
byte-identical forwarding is the property §2.1 rests on. A test must cover both
encodings; the identity case passes either way and is the one that hides the bug.

**Phase 2 — the pane.** The reducer with its tests, the component as plumbing, the
i18n keys, in the shell region beside the terminal. This is the phase that makes
Proxyman and HTTP Toolkit removable.

**Phase 3 — Metro.** Blocked on the open question below, and it is the only phase
that is. The accessor on `TerminalService`, the foreground match, and the
drain-and-`seq` discipline §2.2 names.

**Phase 4 — `adb logcat`.** The same spawn-and-read shape, with `reap.ts` gaining
its pattern.

**Phase 5 — the browser console, or the decision not to.** The largest of the four
and the only one with no precedent. Last, so the first four are shipping before it
is costed properly.

## Open questions

**May anything but an attached view read a terminal session's scrollback?**
**Answered: no, and phase 3 does not need it to.** The question was put to the
owner, who delegated it. The reason to refuse is `TerminalPush`'s own docstring —
the scrollback is "the sharpest instance of the unsolved half of C-021 — `cat .env`,
`env`, a pasted token — and nothing scrubs a shell." An accessor over history
widens that to every consumer anyone writes later, and a bounded tail does not help:
a terminal running Metro in the foreground still holds whatever was typed in it
before Metro started.

So phase 3 **subscribes rather than reads**. It matches a terminal by its
foreground process — `describeForeground`, `terminal.ts:114`, which §2.2 already
names — and consumes the live stream from the moment the match is made. Nothing
historical is exposed, no accessor is added, and C-021 does not widen by a single
byte. The cost is honest and small: opening the pane after Metro has been running
shows nothing until its next line, and the pane should say so rather than look
empty.

**Is the pane per project or global?** **Answered: global**, by the owner. One
service, one ring, no conversation id — which is what phases 1 and 2 already built.
Traffic from a phone is not obviously one project's, and the phone cannot tell us
which project it thinks it is talking to.

**Is the browser console worth its cost?** **Measured on 2026-09-22, and the
answer is that phase 5 is smaller than the plan assumed and probably not worth
building at all.** Three findings, each from the running system or Electron's own
typings rather than from memory.

**CDP cannot attach to the browser you already have open.** The running Chrome
carries no `--remote-debugging-port` and no `--user-data-dir`, nothing listens on
9222, and a running process cannot be handed a flag. A relaunch does not fix it
either: the installed Chrome is 153, past the 136 change that makes
`--remote-debugging-port` a no-op on the default profile, so attaching needs a
**second browser with a separate `--user-data-dir`** — no logins, no extensions,
no session. Chrome 146+ offers `autoConnect` behind a manual toggle, which hands
any local debugger an authenticated session. Both are a setting to remember, which
is the exact objection that removed the device proxy.

**`webRequest` cannot read a body.** `onCompleted` yields url, method, status,
headers and resource type, and nothing else — while `code` and `nextAction`, the
two fields this whole tool exists to put on a row, live in the response body. So
the Electron path cannot do the HTTP half at all.

**But the HTTP half does not need it.** Point the web app's API base URL at Chorus
and it arrives through origin mode, with the same envelope and the same rows as the
phone. What phase 5 uniquely adds is therefore the **console alone** — and the only
mechanism that needs no setup is a `WebContentsView`, which means browsing inside
Chorus instead of in your own browser, with `console-message` delivering a
formatted string where the browser's own console gives you an inspectable object.

So the trade is: a worse console, in a place nobody browses, for an application
whose traffic is already covered. **Recommendation: do not build it.** Record the
measurement and stop at four sources.

**When do the three tools come off?** mitmproxy stays permanently — §5 keeps it for
replay and it is the fallback if phase 0 reverses §2.1. Proxyman and HTTP Toolkit
should not be removed until phase 2 ships, and removing them is the moment this
plan is proven rather than the moment it is finished.
