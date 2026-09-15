# Status — answer in your language

## 2026-09-08 — all three phases shipped, unrun

**Phase 1, the setting.** `styleInstruction` and `styleOnByDefault` added to both
schemas — `shared/ipc.ts` and `main/settings.ts` — with defaults, so a settings
file written before today parses unchanged. `normaliseStyleInstruction` keeps
newlines, which is the one thing it does differently from
`normaliseExplainLanguage`: a language name is one line, a set of style rules is
one per line. `MAX_STYLE_INSTRUCTION` is 2000, and the bound is about context
spent on every turn rather than about fitting on a button.

**Phase 2, the port and the adapters.** `SessionOpts.instructions`, mapped to
Claude's `systemPrompt` preset-append arm and to Codex's `developerInstructions`
on both `thread/start` and `thread/resume`. Neither adapter can reach the arm
that _replaces_ a provider's own prompt, and the interface says why.

Forks are excluded in both, which the plan called for and nearly did not get.
Claude's `spawn` serves `start`, `resume` **and** `fork` from one options object,
so the guard had to name `fork` rather than only test the text — otherwise every
aside would have inherited the instruction and argued with its own
`explainPrompt`. Codex's `fork` builds its params by hand and never had the key.

**Phase 3, the toggle.** Shipped against the `planning` precedent rather than the
event log. The plan is corrected in place and says why: the flag decides how an
agent is spawned, so it must be readable before anything is replayed.

`setAnswerStyle` respawns each participant onto its existing thread, carrying
`seenSeq`, `catchupBudget` and `seedContext` across and reapplying plan mode.
`conversation:answerStyle` is one channel doing both directions — omitting `on`
is a read — because the control lives in the composer, which unmounts with its
tab and has to be able to ask.

## What the gate said

Typecheck, lint and format are green. Two errors were this change's own and both
are fixed: `catchupBudget` needed a guard rather than an assignment under
`exactOptionalPropertyTypes`, and `working` is a list of agent names rather than
a boolean.

**Five tests fail and none of them belong to this work** —
`preload/workbench.test.ts` (seventeen methods against eighteen),
`WorkbenchFrame.test.tsx` (three bounds assertions) and `layout.test.ts` (one
clamp). All three sit on uncommitted changes to `preload/workbench.ts`,
`WorkbenchFrame.tsx` and `layout.ts` that predate this branch and are not part of
it.

One repair here was also not this work's: `hooks.ts` did not implement
`seedPendingDecisions`, which an uncommitted change to `store.ts` had added to
`WorkspaceActions`. It was blocking typecheck for everything, so it was fixed on
request. Five files were reformatted by `prettier --write`, two of which —
`store.ts` and `shared/workbench-ipc.ts` — belong to that same unfinished work.

## What has never happened

**The app has not been launched and the toggle has never been clicked.** Nothing
below has been observed, only written:

- that Claude accepts the appended preset prompt and actually changes voice;
- that Codex's `developerInstructions` **appends** rather than displacing part of
  its own instructions — still unverified, and still the sharpest open question
  in the plan;
- that a respawn is invisible from the transcript's side;
- that the composer's toggle is correctly disabled for the whole of a turn.

No test was written for any of it. `explain-language.test.ts` is the pattern a
sibling should follow, and the plan says so.
