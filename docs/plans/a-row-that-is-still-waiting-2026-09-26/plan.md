# A row that is still waiting

## The problem

Two things the Traffic panel gets wrong about a request that has not answered
yet, both reported from a real tpa-mobile capture on 2026-09-26.

**The auto-selected row never shows its response.** When capture starts, the
panel selects the first HTTP row the moment it appears (`TrafficPanel.tsx:174`)
— which is while it is still in flight. The inspector reads the detail once per
request id (`TrafficRequestInspector.tsx:96`), so it reads a pending exchange: an
empty response, and nothing ever reads it again. The header updates, because it
is drawn from the row, so the screenshot shows `POST 200 …/auth/login` above an
empty Response pane. Clicking the row twice "fixed" it only because that closes
and reopens the inspector, which remounts it.

**A request in flight looks like a broken one.** A pending row has
`status: null`, which the table draws as `—`, and `outcomeOf` falls through to
`!row.parsed` and calls it `body past the tap` — the label for a response too
large to read. `/api/v1/notifications/stream` sat in the list like that for the
whole capture. There is no way to see what is being called right now.

## The shape

### The inspector follows the row it is showing

The inspector already receives the live row. A row is **pending** while
`status === null && !aborted` — `record` always writes a number when it settles,
and an aborted exchange writes the status it had. When the selected row goes
from pending to settled, the inspector reads the detail and both bodies again.

What resets is what describes the exchange: `detail`, `gone`, `failure`, the
fetched chunks and their `loaded` flags, and each side's representation back to
`decoded`. What does **not** reset is what describes the person's reading of
it: `reveal`, the collapsed tree paths and the focused path. A credential
revealed while the call was in flight stays revealed when its answer lands.

**Two races the first draft missed, both closed in the build** (found by
reviewing the plan against the effects, and by deepseek's adversarial pass):

- **A read started while pending can land after the reset.** `loadWhole` had no
  cancellation, so its stale empty bytes could set `loaded.response` and the
  settled body would never be fetched. Each reset now bumps a read generation,
  and a run whose generation is stale drops its result. The same guard stops a
  previous row's bytes landing in a newly selected one, which predates this
  change.
- **The settle commit draws one stale frame.** `pending` comes from the row,
  which is already settled on that commit, while `detail` and `chunks` reset in
  a passive effect after it — so the pane drew the in-flight snapshot, blank or
  partial gzip, for a frame. The waiting text is therefore gated on the row
  **or** the displayed detail's response still being `pending` or `streaming`;
  `settle()` never leaves a body in either state.

### A decoded body is not read before it is decoded

This is the trap the first fix walks into. `record` starts decoding with
`void capture.response.decode()` and publishes the settled row straight away;
`readBody` is synchronous and answers `unsupported` for a compressed body whose
decode has not finished. The inspector's fallback then fetches the **encoded**
bytes — gzip, drawn as text. A click some seconds later never lost that race; a
refresh on the settle push can.

- `CapturedBody.decode()` shares one in-flight run instead of starting a second.
  Nothing called it twice before; after this change `readBody` can, and two runs
  would each charge the decoded copy to the budget.
- `ProjectTrafficRegistry.decodedReady(projectId, captureId, requestId, side)`
  awaits that run — only for a body that has settled, so a pending body is never
  decoded half-received and the half-result memoised.
- `TrafficIpc.readBody` awaits it before reading a `decoded` page.

### Pending is drawn as pending

- `outcomeOf` gains `'pending'`, checked right after `aborted`. The label is
  "Pending", muted.
- The Status cell of a pending row, in the table and in the inspector header,
  is a small CSS spinner instead of `—`, labelled "Pending" for screen readers.
  Under `prefers-reduced-motion` it does not spin.
- While the selected row is pending, the Response pane says "Waiting for
  response…" instead of an empty body. The Request pane is drawn as usual.
- It flips to the real status and outcome on the settle push, which already
  rewrites the row in place by sequence.

## Files

| File                                       | Change                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `renderer/src/TrafficRequestInspector.tsx` | re-read on settle; waiting text; header spinner       |
| `renderer/src/traffic-filter.ts`           | `isPending`, `'pending'` in `outcomeOf`               |
| `renderer/src/TrafficPanel.tsx`            | status spinner, `pending` label                       |
| `renderer/src/i18n/en.json`                | `outcomePending`, `waitingForResponse`                |
| `renderer/src/styles.css`                  | the spinner, its reduced-motion rule, the muted badge |
| `main/traffic.ts`                          | one shared decode run                                 |
| `main/project-traffic.ts`                  | `decodedReady`                                        |
| `main/traffic-ipc.ts`                      | `readBody` awaits it for decoded pages                |

Tests, written and not run until asked: `outcomeOf` on a pending row in
`traffic-filter.test.ts`; two `decode()` calls sharing one run in
`traffic.test.ts`.

## What this deliberately does not do

- **No "Streaming" label.** A server-sent stream such as `/notifications/stream`
  shows Pending until it ends, the way Chrome's DevTools shows `(pending)` for an
  event stream. Telling "waiting for headers" from "headers in, body still
  coming" needs a new phase on the row, which is a shape change across main,
  the shared schema, the renderer and every fixture that builds a row.
- **No auto-select change.** The first row is still chosen for you; it now fills
  in when its answer arrives.
- **"pending" is not searchable.** The search box matches method, path, code,
  next action and transport today, not the outcome, and that stays.
- **No elapsed-time counter** on a pending row.
