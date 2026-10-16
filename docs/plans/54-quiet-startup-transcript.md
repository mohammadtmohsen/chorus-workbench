# Quiet startup transcript

## Status

| Unit           | Result                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| Scope          | Approved: display cleanup; retain current startup behavior and stored events |
| Implementation | Written, formatted and diff reviewed; unverified                             |
| Verification   | No tests, builds, app launch or UI checks requested                          |

## Current / Issue

```mermaid
flowchart LR
    Startup[New session or app restore] --> Events[Session starts, hooks and command-list updates]
    Events --> Store[Append-only event log]
    Store --> Transcript[Joined rows, startup Activity and commands_changed notices]
```

An unused conversation contains zero user messages and twelve agent starts across four launches. Resumed joins are already hidden; successful SessionStart output and command-list updates continue accumulating.

## Proposed

```mermaid
flowchart LR
    Events[Existing lifecycle and provider events] --> Store[Existing event log]
    Store --> Filter[Transcript display filter]
    Filter --> Quiet[Hide routine initialization]
    Filter --> Visible[Keep replies, work, approvals, warnings and errors]
```

## Code Changes

### `apps/desktop/src/shared/transcript-events.ts`

```ts
'session.started': 'ignore',
```

Use the existing shared disposition map so live pushes and paged history both hide joined rows. Raw history and internal event processing remain available.

### `apps/desktop/src/renderer/src/transcript.ts`

Remove the joined-row renderer. Extend the existing notice filter: plain agent `info` notices for `commands_changed` are hidden only without diagnostic detail or a code. Successful agent SessionStart hook notices are hidden, including their informational output. Warnings, errors, coded notices, other hooks and actual task activity keep their current presentation.

### `apps/desktop/src/renderer/src/transcript.test.ts`

Update the existing activity-boundary expectation: a plain command-list refresh no longer splits a command group. Keep the controls for real message, actor and error boundaries.

## Final Flow

```mermaid
sequenceDiagram
    participant Runtime
    participant Store
    participant Transcript
    Runtime->>Store: Existing startup and restore events
    Store->>Transcript: Stored or live events
    Transcript->>Transcript: Hide routine startup rows
    Runtime->>Store: Reply, work or actionable failure
    Store->>Transcript: Display meaningful activity
```

Task baseline: `/private/tmp/chorus-quiet-startup-lozxb0l8`.
