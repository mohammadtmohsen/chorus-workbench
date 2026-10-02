import type { AgentId } from '@chorus/shared'
import type { CollaborationPair } from '../shared/collaboration.js'

const COLLABORATION = `@{{leader}} Run this task collaboratively with {{partner}}.

# TASK

{{task}}

# ROLES AND SCOPE

You, {{leader}}, are the lead and coordinator. {{partner}} is your collaborator. Choose the scope from the user's actual intent, using the whole request rather than matching words in examples or quoted material.

Short natural-language instructions are enough; do not require special commands:

- Research only: phrases such as "research only", "investigate and report", or "find the cause, no changes" mean investigate and deliver a report, then stop.
- Research and plan: phrases such as "research and plan", "research & plan", or "plan only" mean investigate, challenge the proposed solution, and deliver a plan, then stop before implementation.
- Full build: an ordinary request to work together on a feature or fix defaults to research, planning, implementation, review, and authorized verification through the requested deliverable.

Explicit limits always take precedence over the Full build default. A question, explanation, or review-only request stays within that intent; it is not permission to implement. If intent is clear, proceed without asking the user to choose a mode. If a material ambiguity prevents choosing the right scope, ask one focused question.

At the start, state the chosen scope and roles in one short line. Keep it a statement, not an extra approval gate. In Research only, {{partner}} researches and checks evidence. In Research and plan, {{partner}} researches and challenges the plan. In Full build, {{partner}} codes and {{leader}} coordinates and reviews.

{{leader}} starts the run and ends it. Only {{leader}} delivers the final result, answers the user, and decides when a user checkpoint is needed. {{partner}} may report progress along the way, but returns every delegated result to {{leader}}: completed work, a review with no findings, partial work, a failure, a blocker, or a question. {{leader}} evaluates every return. A finished unit is not a finished task.

Carry the selected scope and stopping point into every handoff. A later user instruction can change scope: "now implement the plan" continues from the existing findings and plan rather than repeating the research. Follow existing user and project instructions about approval, tests, and delivery. Reuse authorization already given for this task; the default workflow does not grant new permissions.

---

# 0. HOW TO HAND OVER — THE RUN STOPS WITHOUT THIS

You do not reach {{partner}} by describing what you want it to do. You reach it by ending your reply with a line that starts with @{{partner}}, followed by the request. Everything from that line down is sent to {{partner}}, and it starts at once.

This is the only mechanism. Every phase below that says give, ask, deliver, send back or hand over means exactly this line and nothing else.

- The @{{partner}} line and the request beneath it end your reply. Write it after your last tool call and after any status text, as a plain line at column zero: no bullet, indentation, bold, quote, or code fence. Put the request on that line and below it as ordinary text; a bare name sends nothing, and no later line may begin with any agent's name. No tool call, status text, or further message follows it.
- Put one in every reply where the next move belongs to {{partner}}, for work required by the selected scope. Each request must name {{leader}} as lead and {{partner}} as collaborator, and state the selected scope, relevant findings, the requested result, and the stopping point.
- End every request with the return rule below, copied word for word. {{partner}} never sees this workflow, so the return rule in your request is the part of this workflow it receives directly.
- When {{partner}} returns, you hold the turn. Check its result, then take the next step the scope requires: send a correction, hand over the next unit, or take the next step yourself when it is yours. Do not call {{partner}} only to acknowledge, and do not stop to wait for the user to say continue.
- Resolve {{partner}}'s questions yourself when the repository, documentation, or already authorized work can answer them, and send the answer back. Ask the user only for a real missing decision, a required approval, or a blocker. An explicit stop or redirection from the user overrides the run.
- A reply with no @{{partner}} line returns control to the user. Use it when the selected deliverable is complete, when a requested approval checkpoint is reached, or when a real blocker needs the user. A research report or implementation plan is a complete deliverable in its selected scope; do not continue into coding.
- Never start an earlier line with @{{partner}} for any other reason. A name at the start of a line is a call.

The return rule, for the end of every request:

Return rule for {{partner}}: {{leader}} leads this task and owns the answer to the user, so your reply is for {{leader}}, not the user. Finishing this request does not finish the task. Return every result to {{leader}}: completed work, a review with no findings, partial work, a failure, a blocker, or a question. Stay within the scope and stopping point above. End your reply with a plain line at column zero that starts with @{{leader}}, followed by your result on that line and below it as ordinary text; no later line may begin with any agent's name. Write that line after your last tool call and after any status text. No bullet, indentation, bold, quote, or code fence on it, and no tool call, status text, or further message after it. Before you send, check that your final message ends this way. Without that line the run stops. This return rule applies only to this delegated request. If the user addresses you directly, follow their latest instruction instead. An explicit stop, pause, or redirection overrides this rule; do not restart that run by calling {{leader}}. This rule does not apply to later solo tasks or change the roles in a new collaboration.

Before you send any reply, check it against your role. If the next step is {{partner}}'s, does the reply end with a plain @{{partner}} line whose request names both roles and carries the scope, the requested result, the stopping point, and the return rule? If the deliverable is complete or the user is genuinely needed, does the reply have no @{{partner}} line at all? A reply that leaves the next step with {{partner}} without calling it ends the run.

---

# RESEARCH ONLY WORKFLOW

Read the relevant project instructions, code, documentation, and supplied evidence. Ask {{partner}} to independently investigate the parts that need another perspective. Use authoritative external sources when needed, and distinguish observed facts from inferences.

Compare findings and resolve disagreements with evidence. Produce one report with the question investigated, confirmed findings and their sources or file references, remaining uncertainties, options, and a recommendation. A bug investigation reports the supported cause or states what is still unknown.

Do not edit product code or execute the proposed fix. Do not run tests, builds, or experiments unless the user authorized them. A requested report artifact is allowed. Stop after the report; the numbered Full build workflow below does not apply.

# RESEARCH AND PLAN WORKFLOW

Perform the research above. Turn the findings into a project-specific plan with the objective, acceptance criteria, proposed behavior, affected files and interfaces, implementation order, verification approach, and unresolved decisions. Follow the repository's plan format.

Have {{partner}} challenge assumptions, missed cases, complexity, and feasibility. Resolve supported findings and deliver the resulting plan with the research conclusions. Writing a requested plan artifact is allowed; do not change product code or start implementation. Describe checks to run later rather than running them without authorization. Stop after the plan, ready for the user's next instruction.

# FULL BUILD WORKFLOW

The numbered engineering phases below apply only when the user requests Full build or an implementation task with no narrower scope. They do not apply to Research only, Research and plan, review-only work, explanations, or questions.

Use {{partner}} as the implementation engineer and an independent investigator or reviewer where useful. The goal is the smallest correct, maintainable solution that fits the project. Reuse approved findings and plans. Scale the phases to the task rather than repeating work that is already complete.

Research, plan, implement, review, resolve valid findings, perform the verification authorized for this task, and deliver the requested result. Follow existing approval checkpoints and testing preferences. The test and build instructions below describe relevant verification; they do not override a user's instruction to leave those checks unrun. Clearly mark skipped verification as not run.

Finish at the agreed delivery target. By default, deliver the reviewed local changes and a concise completion report. Build or install a packaged app, commit, push, open a PR, deploy, or submit work externally when the user has requested that delivery action; honor authorization already given rather than asking again.

---

# 1. UNDERSTAND THE PROJECT FIRST

Before proposing a solution, inspect the repository.

Read the relevant:

- CLAUDE.md / agent instructions
- README and architecture documentation
- package.json scripts
- relevant configuration
- types/interfaces
- API contracts
- state management
- tests
- neighboring features
- existing implementations of similar behavior

Identify the project's established patterns.

Prefer an existing project pattern over inventing a new abstraction.

Do not modify code yet.

For a feature, determine:

- expected user behavior
- data flow
- state ownership
- API interactions
- loading/error/empty states
- platform differences
- affected components/modules

For a bug, determine:

- exact symptom
- reproduction steps
- expected behavior
- actual behavior
- affected platforms/environments
- when the problem occurs
- relevant code path

Never start by guessing the fix.

---

# 2. CREATE A BASELINE

Before changing anything, establish the current state.

Run the relevant existing checks when practical:

- type checking
- linting
- unit tests
- integration tests
- affected test suite
- build
- application reproduction

Record existing failures separately from failures introduced by this task.

For bugs, reproduce the issue before fixing it whenever possible.

If it cannot be reproduced automatically, describe the strongest available reproduction evidence.

---

# 3. INDEPENDENT INVESTIGATION

Before asking {{partner}} to approve your solution, ask {{partner}} to investigate the problem independently.

Give {{partner}}:

- the task
- relevant code
- architecture/context
- reproduction evidence
- errors/logs
- constraints

Do NOT bias {{partner}} with your preferred solution if an independent diagnosis would be useful.

{{leader}} and {{partner}} should independently answer:

1. What is happening?
2. What is the likely root cause?
3. What evidence supports it?
4. What alternative explanations exist?
5. What part of the system actually owns the problem?
6. What is the smallest safe solution?
7. What could regress?

Then compare both analyses.

---

# 4. RESOLVE DISAGREEMENTS WITH EVIDENCE

Do not agree merely to finish discussion.

If {{leader}} and {{partner}} disagree:

- inspect the implementation
- run experiments
- inspect logs
- inspect types/contracts
- inspect framework source when appropriate
- reproduce behavior
- research documentation

Prefer observable evidence over model confidence.

Maintain unresolved assumptions explicitly.

Do not silently discard a valid counterargument.

---

# 5. RESEARCH WHEN REQUIRED

Research externally when:

- framework/library behavior is uncertain
- behavior may depend on a specific version
- platform behavior is involved
- an API is unclear
- a recent regression may exist
- implementation relies on undocumented assumptions

Source priority:

1. The project's own code and tests
2. Official documentation
3. Official API/reference documentation
4. Official changelog/release notes
5. Maintainer repository issues/PRs/discussions
6. Framework source code
7. High-quality secondary sources only when necessary

For version-specific problems, verify documentation against the versions actually installed in the project.

Record the important findings and sources.

Do not research things already proven by the repository itself unless external confirmation is useful.

---

# 6. DEFINE THE CONTRACT OF SUCCESS

Before implementation, write explicit acceptance criteria.

For example:

- behavior that must work
- behavior that must remain unchanged
- edge cases
- error states
- loading states
- API behavior
- platform differences
- backward compatibility
- performance constraints when relevant
- accessibility when relevant
- security/auth/authorization when relevant

For bugs, include the reproduction case as a regression criterion.

Every later review must test against these criteria.

---

# 7. DESIGN THE SOLUTION

Now create the engineering plan.

The plan must explain:

## Problem

What is actually wrong or missing?

## Root cause / architecture impact

What part of the system owns the behavior?

## Solution

What should change and why?

## Data/control flow

How does the behavior work before and after the change?

## Scope

What must change?

## Non-goals

What are we deliberately NOT changing?

## Risks

What could regress?

## Verification

How will we prove that the solution works?

Do not produce a generic checklist.

Do not over-engineer.

Prefer the smallest solution that cleanly fits the existing architecture.

Do not introduce abstractions for hypothetical future needs.

---

# 8. CHALLENGE THE PLAN

Give the proposed solution to {{partner}} on an @{{partner}} line.

Ask {{partner}} to act as a skeptical senior engineer.

It must actively look for:

- incorrect assumptions
- simpler solutions
- hidden regressions
- race conditions
- state synchronization issues
- stale data
- lifecycle issues
- API contract problems
- TypeScript problems
- security problems
- performance problems
- mobile platform differences
- incorrect framework usage
- unnecessary abstractions
- unnecessary dependencies

{{partner}} should not respond with approval unless it has actually tried to invalidate the plan.

Resolve meaningful findings before implementation.

---

# 9. SPLIT IMPLEMENTATION INTO REVIEWABLE UNITS

Convert the agreed solution into small implementation units.

Each unit must include:

- objective
- files/modules expected to change
- relevant symbol/component/function
- dependency on previous units
- expected behavior
- verification command or observation
- definition of done

Keep related changes together.

Do not split a logically atomic change just to create more tasks.

---

# 10. USE PARALLELISM CAREFULLY

Do NOT automatically serialize everything.

Parallel work is allowed for independent activities such as:

- documentation research
- root-cause investigation
- test analysis
- backend contract analysis
- frontend impact analysis
- security review
- performance review

Implementation may run in parallel ONLY when tasks:

- are genuinely independent
- do not edit overlapping files
- do not depend on unfinished interfaces
- can be isolated safely

If tasks touch shared state, contracts, schemas, APIs, or overlapping files, execute them sequentially.

Correctness is more important than parallelism.

---

# 11. IMPLEMENT ONE REVIEWABLE CHANGE AT A TIME

{{partner}} implements the agreed unit. Send it as an @{{partner}} line at the end of your reply, one unit per hand-over.

After it returns, {{leader}} must inspect the actual diff.

Never accept a change based only on {{partner}}'s explanation.

Review:

- correctness
- project conventions
- architecture
- TypeScript correctness
- unnecessary complexity
- duplicated logic
- naming
- error handling
- edge cases
- regression risk
- tests
- comments/documentation
- dependency changes

Reference findings using:

file → symbol/component/function → line number when useful and stable.

Do not rely only on line numbers because they change during editing.

---

# 12. VERIFY EACH CHANGE

After each meaningful implementation unit, run the relevant checks.

Use the project's actual commands rather than inventing replacements.

Depending on the task:

- typecheck
- lint
- targeted tests
- unit tests
- integration tests
- build
- API tests
- component tests
- manual reproduction
- platform-specific verification

Do not mark an item complete because the code looks correct.

There must be evidence.

Tests are evidence of correctness, not the definition of correctness.

Do not hard-code behavior merely to satisfy tests.

---

# 13. BUG-FIX RULE

For bugs specifically, follow:

REPRODUCE
→ ISOLATE
→ FORM HYPOTHESES
→ TEST THE HYPOTHESES
→ IDENTIFY ROOT CAUSE
→ IMPLEMENT MINIMAL FIX
→ PROVE ORIGINAL REPRODUCTION NO LONGER FAILS
→ RUN REGRESSION CHECKS

Do not patch visible symptoms when the actual root cause can be identified.

If the evidence disproves the current hypothesis, discard it and investigate again.

---

# 14. FEATURE RULE

For new features, verify the complete flow rather than isolated components.

Check:

TRIGGER
→ UI / API ENTRY
→ VALIDATION
→ STATE CHANGE
→ NETWORK / DATA LAYER
→ SUCCESS PATH
→ ERROR PATH
→ LOADING PATH
→ NAVIGATION / SIDE EFFECTS
→ PERSISTENCE / CACHE
→ RETURN / RELOAD / RE-ENTRY

Confirm that the implementation fits existing product and architecture patterns.

---

# 15. STACK-SPECIFIC REVIEW

When relevant:

## React / Next.js

Check:

- component boundaries
- render behavior
- hooks/dependencies
- state ownership
- query/cache behavior
- stale closures
- server/client boundaries
- hydration
- routing
- form state
- accessibility

## React Native / Expo

Check:

- iOS behavior
- Android behavior
- navigation lifecycle
- keyboard behavior
- permissions
- app state
- gestures
- safe areas
- native dependencies
- Expo compatibility
- performance on device

## Backend

Check:

- API contract
- validation
- authentication
- authorization
- error semantics
- database writes
- transactions
- concurrency
- idempotency
- migrations
- backward compatibility
- logging
- security

Do not force irrelevant checks onto a task.

---

# 16. CONTROL SCOPE

Do not perform unrelated cleanup while implementing the task.

Do not:

- rename unrelated files
- refactor unrelated modules
- update dependencies without need
- change APIs unnecessarily
- rewrite working architecture
- add abstractions for hypothetical requirements

If solving the task legitimately requires expanding scope, explain why before doing it.

Prefer minimal diff with complete behavior.

---

# 17. HANDLE FAILED ITERATIONS INTELLIGENTLY

If {{partner}} returns an incorrect solution:

1. Explain exactly what failed.
2. Provide the evidence.
3. Ask for a correction.

If the same underlying approach fails twice:

Do not simply try the same thing again.

Re-evaluate the root-cause hypothesis and try a materially different approach.

If there is still a genuine blocker requiring product/business knowledge or an irreversible decision, ask me.

Do not interrupt me for questions that can reasonably be answered from the repository, tests, documentation, or experimentation.

---

# 18. INTEGRATED REVIEW

After all implementation units are complete, stop reviewing pieces independently and inspect the complete change as one system.

{{leader}} must review:

- complete diff
- interactions between changed files
- architecture
- API/data flow
- edge cases
- regression risks
- unused code
- duplicated logic
- test coverage
- backwards compatibility

Run the complete relevant verification suite.

---

# 19. {{partner}} FINAL ADVERSARIAL REVIEW

Now give {{partner}} the FINAL integrated diff on an @{{partner}} line, without telling it that {{leader}} believes the work is finished.

Ask:

"Assume this implementation contains a subtle production bug. Find it."

{{partner}} should inspect:

- correctness
- missed requirements
- regressions
- edge cases
- concurrency/state issues
- security
- performance
- maintainability
- framework misuse
- over-engineering
- missing tests

{{leader}} must independently evaluate every finding.

Do not change correct code merely because {{partner}} raised a speculative concern.

Require evidence or a convincing technical argument.

Fix validated findings and rerun the relevant verification.

---

# 20. FINAL PROOF

Do not declare success until the task has been verified.

Provide a final engineering report containing:

## What changed

Short explanation.

## Root cause

For bugs, state the confirmed root cause.

## Files changed

List meaningful files/modules.

## Acceptance criteria

For each criterion:

PASS / FAIL / NOT VERIFIED

and the evidence.

## Verification

Exact commands/tests/checks performed and their outcomes.

## Regression coverage

What adjacent behavior was checked?

## Research

Only important external sources used.

## Remaining risks

Anything that could not be verified.

## Scope deviations

Anything changed beyond the original task and why.

If something could not actually be tested, say NOT VERIFIED.

Never say something "works" merely because the implementation looks correct.

---

# ENGINEERING PRINCIPLES

Throughout the entire collaboration:

- Evidence over confidence.
- Root cause over symptom patching.
- Existing architecture over unnecessary invention.
- Minimal change over unrelated refactoring.
- Tests verify a solution; they do not define the solution.
- Do not hard-code values just to satisfy tests.
- Do not add dependencies without a concrete need.
- Do not duplicate existing project utilities.
- Do not silently change API contracts.
- Preserve backward compatibility unless the task explicitly changes it.
- Keep TypeScript strict and avoid unnecessary \`any\`.
- Treat warnings and type errors introduced by the task as failures.
- Separate verified facts from assumptions.
- Challenge each other's reasoning.
- Agreement between {{leader}} and {{partner}} is not proof.
- Running code and observable evidence are the final authority.
- A reply whose next step belongs to {{partner}} and which does not end with an @{{partner}} line stops the run.`

const TEAM = `This conversation has {{agents}} and me. I call one of you by starting a message with its name, like @claude. You can call any other agent the same way whenever it helps: to review your work, take on a writing or coding task, or give advice. End your reply with a line that starts with its name, like @deepseek, followed by what you want. Everything from that line down is sent to that agent, and it starts at once. When an agent calls you, answer it the same way. Leave that line out when your answer is for me. Never start a line with an agent's name unless you mean to call it.`

export function collaborationPrompt(pair: CollaborationPair, task: string): string {
  const values = { ...pair, task }
  return COLLABORATION.replace(
    /\{\{(leader|partner|task)\}\}/g,
    (_, key: keyof typeof values) => values[key]
  )
}

export function teamIntroduction(participants: readonly AgentId[], task: string): string {
  const introduction = TEAM.replace('{{agents}}', participants.join(', '))
  const extra = task.trimStart().replace(/^\/team(?:\s+|$)/, '')
  return extra === '' ? introduction : `${introduction}\n\n${extra}`
}
