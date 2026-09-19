# Status — the editor that knows this codebase

## Phase 1 — code-complete, and entirely unverified

**2026-09-19.** Five tasks, written by deepseek and reviewed by claude after each
one. **Nothing in this phase changes behaviour**: no suggestion is slower,
larger, differently shaped or differently gated than before it. It is all
measurement, which is why it could be built before anything was committed.

**No gate was run, the app was never launched, no test was executed, and neither
instrument has fired.** `G1` costs nine paid requests at roughly $0.003; `G2` is
a three-and-a-half-minute sampling run that costs nothing. Both wait on Mohamad.

### What shipped

| #   | Task                                               | Where                                                        |
| --- | -------------------------------------------------- | ------------------------------------------------------------ |
| T1  | `usage` parsed; cache counters and `finish_reason` | `main/completion-client.ts`                                  |
| T2  | Request correlation and honestly-named timings     | same file, plus the handler in `main/workbench-surface.ts`   |
| T3  | Request-to-visible reporting from the renderer     | a new one-way channel across shared, preload, main, renderer |
| T4  | The `G1` caching probe — built, not run            | `main/completion-client.ts`, gated on `isE2eProfile()`       |
| T5  | `G2`: the language-service sampler                 | `renderer/src/workbench/completion.ts`                       |

### Five findings worth more than the code

**1. The cache counters are not where the earlier research said they were.**
deepseek had reported them nested inside `usage.prompt_tokens_details`; checked
again against the FIM reference's own example JSON, they are direct properties of
`usage`. **Building from the first summary would have logged `unreported` for
every response, and `G1` would have concluded the endpoint does not cache** — a
wrong verdict arriving from our mistake rather than the provider's, which is
precisely what that gate cannot detect about itself. The guard added in response
reports the `usage` key names, once per provider, when both counters come back
absent.

**2. A `WeakMap` keyed by the completions object removed a bound rather than
adding one.** T3 needed per-request state that survives until `handleItemDidShow`
fires — and that callback is handed the _same object the provider returned_,
verified at `provideInlineCompletions.js:392`. So the key is collected when the
editor drops the suggestion. A `Map` keyed by request id would have needed a cap
and an eviction rule, which is the cancelled-ids lesson from the previous phase
paid a second time.

**3. The rename hit the `activeTabId` trap, while quoting it.** A mechanical
`CompletionOutcome → EditorReportKind` substitution rewrote two unrelated things:
the report-kind union, and the FIM _response_ parser's return type. `CLAUDE.md`
already records that a rename by substitution cannot tell which of two things
sharing a name you meant, and **it fails in the direction of looking correct** —
`EditorReportKind` reads plausibly as the return type of a response parser. The
compiler could not help and neither could a diff; reading the file after the
substitution is what caught it.

**4. The probe's own log was asserting an intended value as an observed one.**
It waited `delay - previous` _before_ each send, so the second send landed about
three seconds after the first while the line said `2000`. Fixed by recording the
actual elapsed beside the intent. This is the same class as naming
response-header arrival "TTFT", which is the error the whole phase is built to
avoid.

**5. The probe inherited the live path's two-second timeout.** At roughly 4,000
tokens of prefix — the size caching is supposed to matter for — a timeout was a
plausible outcome rather than a remote one, and it would have returned
`timed out` and taught `G1` nothing at exactly the point of interest.
`requestCompletion` now takes an optional deadline defaulting to the live value,
which `D3` requires for Phase 3 regardless.

### Decisions taken during the phase, not in the plan

- **No cap on the usage-key list.** It fires at most once per provider per
  process, so its worst case is two lines per app lifetime — and a `slice` would
  silently drop a field that sorts late, turning a diagnostic into a confident
  wrong answer.
- **No request id on the usage-keys line.** It reports a _process-level_ fact —
  what shape this provider's responses have — so `provider` is its correlator. An
  id invites the reading that the shape was reported _for that request_.
- **Snooze reports once per episode**, cleared from `onDidChangeIsSnoozing`, with
  the UUID minted only when a report is actually sent. Snooze is an episode-level
  fact; one line tells a reader what a hundred identical ones would, and every
  keystroke after the first costs one boolean.
- **p50 and p95 are derived from the log, not computed in code.** A percentile
  computed inside the app is a number nobody can check, and `G1` already records
  raw values.
- **A provider error that is not a cancellation reports nothing, deliberately.**
  Filing it as a normal outcome would have `G2` count a defect as a measurement.
  The round count is the signal: fewer lines than rounds is the evidence.

### What the instruments will and will not tell us

`G2`'s sampler carries two opposing biases, both now recorded in the plan: it
reads an **idle cursor**, which flatters the result, and `queryMs` is a
`Promise.all` over every registered provider, so it reports the **slowest**
rather than the first useful answer. A p95 read without both is read wrong.

`G1` can prove a cache hit with one non-zero result. **It cannot prove the
absence of caching** — consistently zero means only that none was observed, which
is why `D7` budgets the feature as uncached regardless.
