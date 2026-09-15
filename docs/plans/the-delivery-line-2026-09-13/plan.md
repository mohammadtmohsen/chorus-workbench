# The delivery line

## The problem

`collaborate.ts` drives two agents and says so in two constants: `WORKER` is
Claude, `GUIDE` is Codex. `preflight` iterates exactly that pair,
`runtime.ts:2916` refuses to start unless both are seated, and `runtime.ts:2928`
refuses any source message whose actor is not Claude — a refusal literally named
`notClaude`.

There are three agents now, and the third is not a third opinion. DeepSeek is a
coder: it should be handed work, not asked to plan. The two-role shape cannot
express that, because both of its roles think.

## What was settled before any code

- **The pipeline**: Claude plans → Codex reviews the plan and plans the complex
  parts → Claude adjusts the final plan and splits it into micro-tasks →
  each micro-task goes to DeepSeek, one at a time → **Claude reviews each one**
  → repeat until the list is done.
- **DeepSeek never plans.** It receives one micro-task at a time and returns
  work. It is never asked for a verdict and never reviews.
- **Chorus drives it.** Main owns the state machine, the same way it owns the
  current one. The sequence is not advice in a prompt that an agent may skip.
- **This replaces the two-agent collaborate.** `WORKER`/`GUIDE` and the
  `notClaude` guard go.
- **No DeepSeek falls back to Claude coding.** A project without DeepSeek — not
  in the cast, or no API key — still gets plan → review → implement, with Claude
  doing the micro-tasks.
- **Display order becomes codex, claude, deepseek** in the reading-order lists.

## The shape of the answer

### Three roles, and only one of them is new

```
PLANNER  = claude    plans, refines, splits, and reviews what comes back
REVIEWER = codex     reviews the plan; plans the parts that are hard
CODER    = deepseek  implements one micro-task at a time, and nothing else
```

`CODER` is the only one that can be absent, and the only one whose absence has a
fallback: it becomes `PLANNER`. `REVIEWER`'s absence is a different question and
is in the open questions below, because a plan nobody reviewed is a different
product rather than a degraded one.

### The loop is the new thing, and it is where this can go wrong

Today's `Preset` has a fixed `STEP_TOTAL` — `{ oneShot: 2, guided: 4 }` — and
`RunStatus.stepTotal` is that number. A micro-task list makes the total dynamic:
it is `3 + (2 × tasks)` and is not known until Claude has answered the third
stage.

Two consequences the current shape cannot carry:

- **`stepTotal` becomes a running estimate**, null until the split is parsed.
  The progress display has to survive not knowing.
- **A loop needs two caps or it does not terminate.** A cap on micro-tasks per
  run, and a cap on re-issues per task when Claude keeps objecting. Without the
  second, one micro-task Claude never accepts is an unbounded spend against
  three providers.

### The split needs an envelope, and `parseVerdict` is the model

Claude has to return a list a machine can read. `parseVerdict` already solves the
same problem for a one-word answer, and its discipline is the part worth copying:
it reads the **first non-blank line and nowhere else**, because scanning anywhere
would let a sentence quoting the protocol decide the loop.

So a `TASK_PROTOCOL` beside `VERDICT_PROTOCOL`, and a `parseMicroTasks` beside
`parseVerdict` — pure, exported, tested, and anchored the same way. An unparseable
split is a run outcome, not an exception: the same `unparsed` shape the verdict
already has.

### Steps

`Step` today is `'review' | 'revise' | 'verify' | 'report'`. It becomes:

| Step         | Who      | What it asks for                                          |
| ------------ | -------- | --------------------------------------------------------- |
| `plan`       | Claude   | a plan for the request the run started from               |
| `reviewPlan` | Codex    | verdict protocol, plus its own planning of the hard parts |
| `split`      | Claude   | the final plan, then the task protocol                    |
| `implement`  | DeepSeek | exactly one micro-task, quoted in full                    |
| `accept`     | Claude   | verdict protocol, against that one micro-task             |
| `report`     | Claude   | what the whole run produced                               |

`implement` and `accept` are the loop. The other four run once.

### What this deliberately does not do

- **No parallel micro-tasks.** One at a time was asked for, and it is also the
  only version where a review can attribute a failure to one task.
- **No DeepSeek verdicts.** It never reviews, including its own work.
- **No new adapter work.** DeepSeek is already an agent; this is orchestration.
- **No change to `dispatchAndWatch`.** The timeouts, the acknowledgement bound,
  the idle bound and the cancellation semantics are all reused untouched — they
  are the part of this file that already works and they are agent-agnostic.

## Phases

**1. Roles and the display order.** `WORKER`/`GUIDE` become `PLANNER`,
`REVIEWER`, `CODER`; `preflight` iterates the actual cast rather than a fixed
pair; `runtime.ts:2916`'s both-seated loop and `:2928`'s `notClaude` guard go,
along with the `notClaude` member of `CollaborationRefusal`. The five
reading-order lists become codex, claude, deepseek. No pipeline change yet.

**2. The envelope.** `TASK_PROTOCOL` and `parseMicroTasks`, pure and exported,
with the anchoring discipline `parseVerdict` already has. Tested against the
ways a model actually formats a list — numbered, bulleted, emphasised, and with
prose before it that must not be read as a task.

**3. The linear stages.** `plan → reviewPlan → split`, with `stepTotal` becoming
nullable and the status surface handling an unknown total.

**4. The loop.** `implement → accept`, both caps, and the fallback that makes
`CODER` Claude when DeepSeek has no session. `CoordinatorPort.sessionRef`
already returns null for an agent that is not in the room, so the fallback has
its signal without new plumbing.

**5. `report`, and the run outcomes.** Including the new failure modes: a split
that would not parse, and a micro-task that hit its re-issue cap.

## Open questions

1. **What happens with no Codex.** DeepSeek's absence has a fallback; Codex's
   does not, and a plan nobody reviewed is a different product rather than a
   degraded one. Refuse, or skip the review stage and say so in the report?
2. **The two caps' numbers.** Micro-tasks per run and re-issues per task. I would
   start at 20 and 3, but these are spend limits and they are yours.
3. **Does `oneShot` survive?** It is the cheap single-review preset and is
   orthogonal to this pipeline. "Replace it" was about the two-agent design; I
   have read it as replacing `guided` only, and kept `oneShot`. Say if that is
   wrong.
4. **Where the user's request enters.** Today a run starts from a completed
   Claude reply. This pipeline starts with Claude _planning_, so it more
   naturally starts from the user's own message. That changes
   `RunRequest.sourceEventId`'s meaning.

## What is unverified

Nothing here has been built. The claim most worth doubting is that
`dispatchAndWatch` is genuinely agent-agnostic — it is written against
`AgentId` and reused for a third agent for the first time, and DeepSeek's turn
shape comes from a different provider through the same adapter. Phase 4 is where
that gets tested, and if the idle or acknowledgement bounds turn out to be tuned
for Claude's pacing, this plan needs a fifth open question.
