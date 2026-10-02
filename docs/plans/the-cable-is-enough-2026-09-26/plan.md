# The cable is enough

## The problem

tpa-mobile points its API at the capture proxy as `http://127.0.0.1:30100`. The
iOS simulator shares the Mac's network, so loopback reaches the proxy and every
call lands in the Traffic panel. An Android phone on USB does not: its
`127.0.0.1` is the phone. Its calls fail, and the panel shows nothing.

Two ways around it exist today, and both cost the person something every time:

- `adb reverse tcp:30100 tcp:30100` works, but the rule dies with the USB
  connection, so it has to be retyped on every replug.
- The LAN address works, but it means editing the app's `.env` and restarting
  Metro with `--clear`, and again whenever DHCP moves the Mac's address.

Diagnosed on 2026-09-26 against a Samsung SM-A137F: same Wi-Fi subnet as the Mac,
Chorus listening on `*:30100`, the device's only reverse rule Metro's `8081`.
Running the reverse by hand fixed it.

## The shape

**While a project is capturing, every attached Android device carries a reverse
rule for that project's port.** Chorus applies it when capture starts, applies it
again to any device that attaches while capture runs, and removes it when capture
stops. The app's URL stays `127.0.0.1:<port>` for good, and that one URL serves
the simulator and the phone at once.

The owner is runtime, beside `LogcatService`, for the reason `selectTrafficSource`
already gives: a child process is runtime's business, not a project's. The
registry knows which projects are capturing on which ports; runtime turns that
into `adb` commands.

### `apps/desktop/src/main/adb-reverse.ts` — new

`AdbReverse`, one instance for the app.

- `sync(ports)` takes the full set of ports that should be reversed right now.
- While that set is non-empty it holds one `adb track-devices` child, which
  reports the device list every time it changes. While the set is empty there is
  no child at all.
- On every device list and every `sync`, it diffs what each device should carry
  against what it has already been given, then runs
  `adb -s <serial> reverse tcp:P tcp:P` for each missing pair and
  `adb -s <serial> reverse --remove tcp:P` for each port that left the set.
- Only devices in state `device` are touched; `unauthorized` and `offline` wait
  until they become `device`.
- `close()` removes every rule it applied and kills the tracker.

The two judgements are pure and exported: `parseDeviceLists(text)` for the
tracker's output, and `reverseCommands(applied, serials, ports)` for the
commands to run. The class is plumbing around them.

**The tracker's output shape was read from the binary, not from memory.** Against
adb 1.0.41 (platform-tools 37.0.0) with one phone attached, `od -c` of the stream
is `0013R58TC1151DM\tdevice\n`: a four-digit hex byte length, then one
`serial\tstate` line per device. An empty list is `0000`. The parser keeps a
partial frame for the next chunk, and reads the stream as `latin1` so a
character is a byte.

### `apps/desktop/src/main/project-traffic.ts`

- `capturingPorts()` — the port of every entry whose service is live.
- `setForwarded(count)` — publishes `forwardedDevices` for each project whose
  count moved, and only those, so the push it causes is a no-op for `sync`.
- `forwardedDevices` joins `ProjectTrafficState`, `0` at creation and on stop.

### `apps/desktop/src/main/runtime.ts`

Owns `new AdbReverse()`. Subscribes to the registry and, on every `state` push,
calls `adbReverse.sync(this.traffic.capturingPorts())`; `onChange` feeds the
counts back through `setForwarded`. Calls `adbReverse.close()` where it already
calls `this.logcat.close()`, and re-syncs after both `traffic.dispose` sites so a
project forgotten mid-capture takes its port with it.

### The panel

`forwardedDevices` joins the shared `TrafficState` schema. The header shows
"Forwarded to N Android device(s)" beside "Listening on …", **only while
capturing with at least one device forwarded** — a web project's capture never
grows an Android line, and a machine without `adb` stays quiet in the panel.

### `apps/desktop/src/main/reap.ts`

`'adb track-devices'` joins `CHILD_PATTERNS`, next to `'adb logcat'`. It is a
long-lived child exactly like logcat, and the backstop exists for those.

## Edge cases

- **Two projects capturing** on 30100 and 30101: both ports on every device.
- **A rule the person added by hand** on the same port: rebinding to the same
  target is harmless; stopping capture removes it along with ours.
- **No `adb` on the PATH:** the spawn fails, it is logged once, and nothing else
  happens until the next capture start. A machine without the Android SDK is a
  machine that has no Android device to forward to.
- **Chorus dies mid-capture:** the rules outlive it and point at a closed port,
  and die with the USB connection anyway. The next start rebinds them.
- **Unplugged during capture:** the device leaves the list, its rules are already
  gone, and its record of applied rules is dropped so a replug gets them again.

## What this deliberately does not do

- **No panel line for failures.** A missing `adb` or a failed reverse is a log
  warning, not a banner.
- **Does not change the env var hint line.** It still shows the LAN address, even
  though `127.0.0.1` is now the one that works everywhere.
- **Nothing for a physical iPhone.** iOS has no reverse; that device still needs
  the LAN route. The simulator needs nothing.
- **Does not touch tpa-mobile**, and does not reverse Metro's `8081` — Expo
  already does.
- **No device choice.** Every attached device, as agreed.

## Phases

**Phase 1** — the files above, plus `forwardedDevices` in the two test fixtures
that build a whole `TrafficState`. Built and installed 2026-09-26; on the phone,
over Wi-Fi `adb`, Chorus added `tcp:30100` within a second of the device
appearing.

**Phase 2 — Wi-Fi devices come back on their own.** Found while testing phase 1:
the phone had been moved to Wi-Fi `adb` (`adb tcpip 5555` + `adb connect`), and
after Chorus was relaunched `adb devices` was empty. The adb server had
restarted — its pid was newer than Chorus's — and a restarted server forgets
every `adb connect`. Forwarding had nothing to forward to.

- `AdbReverse` remembers every Wi-Fi device (`host:port` serial, state `device`)
  it sees, most recent first, at most five.
- The list is saved to `adb-wireless.json` in the user data folder, **not**
  `settings.json`. The settings sheet writes that file whole from the renderer's
  copy, so a list main kept there would be dropped or overwritten by the next
  save of an unrelated preference.
- While capture runs, each remembered address missing from the device list gets
  `adb connect`: once on the tracker's first list, then every 10 s. One connect
  per address at a time; failures are silent, because a phone that is simply
  elsewhere is the normal case.
- The timer lives and dies with the tracker, so nothing is attempted while
  nothing is capturing.

Deliberately not handled: a phone that rebooted is out of Wi-Fi mode until
`adb tcpip 5555` over a cable, and a phone whose address moved is unreachable at
the remembered one. And `adb disconnect` by hand is undone within ten seconds
while a capture runs — stopping the capture is the way to let a phone go.

## Decided 2026-09-26

1. **The panel says so** — the forwarded line above.
2. **Tests are written** in `adb-reverse.test.ts`: the parser, the diff, and the
   class against a fake tracker. Not run until asked.
3. **The env var hint line stays** as it is.
4. **Phase 2 defaults**, all accepted: remembered across relaunches, reconnect
   only while capturing every 10 s, keep the five most recent, nothing new in
   the panel.
