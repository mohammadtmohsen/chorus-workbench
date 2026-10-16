# Persistent chat busy status

## Status

| Unit           | Result                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------- |
| Scope          | Requested: visible busy status at the end of the chat throughout active Work and Chat replies  |
| Implementation | Written, formatted and diff reviewed; unverified                                               |
| Verification   | Tests, builds and live UI checks not requested; the preceding installation request was stopped |

## Current / Issue

```mermaid
flowchart LR
    Start[Agent busy] --> Status[Thinking row]
    Status --> Text[Text begins streaming]
    Text --> Hidden[Work status hidden]
    Hidden --> Tools[Tools and pauses continue without a status row]
```

`Session.tsx` excludes Work agents with a streaming message and excludes Chat requests in the replying phase. Busy state and the Send/Stop indicator remain active, so the transcript can look finished while work continues.

## Proposed

```mermaid
flowchart LR
    Active[Work turn or pending Chat request] --> Footer[Named status below the newest output]
    Footer --> More[Replies, tools and pauses]
    More --> Footer
    Footer --> End[Remove only when the request finishes, fails or is stopped]
```

## Code Changes

### `apps/desktop/src/renderer/src/Session.tsx`

Render the Work footer directly from `view.working` and the Chat footer from every active `view.replies` entry. Keep the existing footer position in both transcript branches. Work shows the provider's current activity when available and Working otherwise; Chat shows Waiting, thinking or Replying according to its request phase. Remove the streaming-message exclusion and its unused derived set.

### `apps/desktop/src/renderer/src/i18n/en.json`

Add the Replying label. Reuse the existing Working label for the Work fallback.

## Final Flow

```mermaid
sequenceDiagram
    participant Agent
    participant Transcript
    Agent->>Transcript: Turn starts
    Transcript->>Transcript: Show named Working status
    Agent->>Transcript: Text, tools and pauses
    Transcript->>Transcript: Keep status under latest output
    Agent->>Transcript: Completion, failure or Stop
    Transcript->>Transcript: Remove active status
```

Task baseline: `/private/tmp/chorus-persistent-busy-mg6nhwlg`.
