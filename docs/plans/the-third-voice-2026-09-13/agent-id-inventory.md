# Agent-id inventory — Phase 1 deliverable

> **The counts below were wrong twice and are corrected at the end.** The five
> categories found 84 sites; scanning for _every line mentioning either literal_
> found **119**, including two `Actor` enums and eleven negated guards that no
> category caught. See "Phase 1 outcome" at the foot of this file for what was
> actually swept and what was deliberately left.

Every place the pair `'codex' | 'claude'` is spelled out, across non-test,
non-generated source. This is the list Phase 1 repoints at `AGENT_IDS`, and the
list Phase 2 walks when the third member is added.

It exists because **the compiler names only 18 of these 84 sites.** Everything in
categories A, C, D and E keeps compiling against a widened `AgentId` while
silently excluding the third agent.

| Category                                        | Count  | Compiler sees it? |
| ----------------------------------------------- | ------ | ----------------- |
| A — `z.enum(['codex', 'claude'])`               | 36     | No                |
| B — TypeScript unions                           | 18     | Yes               |
| C — equality predicates and ternaries           | 11     | No                |
| D — bare array literals                         | 7      | No                |
| E — per-agent object literals and `Record` keys | 12     | No                |
| **Total**                                       | **84** | **18**            |

## Two findings that change Phase 1's shape

**Four files declare their own `AgentId` instead of importing it.**
`Settings.tsx:11`, `HandoffComposer.tsx:5`, `Session.tsx:152` and
`mention-menu.ts:1` each redeclare the union locally. Widening
`packages/shared/src/ids.ts` does **nothing** for any of them, and the renderer
is where three of the four live. These have to be deleted and replaced with an
import, not edited.

**Category E was missed by every earlier count**, including the review's. Twelve
per-agent object shapes — `models`, `efforts`, `INSTALL`, `NAME`, `openChanges` —
need a third key, and no regex anyone ran for `'codex' | 'claude'` finds them,
because the agent names appear as bare object keys.

---

## A — `z.enum(['codex', 'claude'])` · 36 sites

Twenty-nine in `shared/ipc.ts` alone.

| File                                     | Lines                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/shared/ipc.ts`         | 14, 103, 159, 196, 426, 534, 564, 594, 613, 614, 617, 618, 640, 707, 763, 819, 1123, 1124, 1422, 1423, 1439, 1440, 1474, 1574, 1597, 1960, 1993, 2015, 2049 |
| `apps/desktop/src/main/settings.ts`      | 36                                                                                                                                                          |
| `apps/desktop/src/main/open-projects.ts` | 32                                                                                                                                                          |
| `packages/event-store/src/events.ts`     | 103, 117, 306, 307                                                                                                                                          |
| `packages/event-store/src/store.ts`      | 597                                                                                                                                                         |

`store.ts:597` is the one to look at first — it validates `agent_id` coming
**out** of SQLite, so it governs whether a persisted DeepSeek row can be read
back at all.

## B — TypeScript unions · 18 sites

The only category the typechecker reports.

| File                                                | Lines                                                 | Note                                          |
| --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `apps/desktop/src/main/ipc.ts`                      | 292, 319, 324, 349, 494, 603, 632, 963, 964, 983, 984 |                                               |
| `apps/desktop/src/renderer/src/Settings.tsx`        | 11, 410, 623                                          | **11 is a local redeclaration**               |
| `apps/desktop/src/renderer/src/HandoffComposer.tsx` | 5                                                     | **local redeclaration**                       |
| `apps/desktop/src/renderer/src/Session.tsx`         | 152                                                   | **local redeclaration, and it is `export`ed** |
| `apps/desktop/src/renderer/src/mention-menu.ts`     | 1                                                     | **local redeclaration**                       |
| `packages/shared/src/ids.ts`                        | 20                                                    | the canonical one                             |

## C — equality predicates and ternaries · 11 sites

The silent category. Four of these are behavioural bugs for a third agent, not
just spellings.

| File:line                                          | What it does                                                               | Consequence                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/runtime.ts:4208`            | `filter((id): id is AgentId => id === 'codex' \|\| id === 'claude')`       | Hand-written predicate. Drops DeepSeek from **every project's cast**, silently.          |
| `apps/desktop/src/renderer/src/Session.tsx:1664`   | `approval.agentId === 'claude' ? 'claude' : 'codex'`                       | A DeepSeek approval is decided **as Codex**. Wrong session; DeepSeek keeps waiting.      |
| `apps/desktop/src/renderer/src/Session.tsx:1684`   | `questions.find((q) => q.agentId === 'codex' \|\| q.agentId === 'claude')` | A DeepSeek question is never found, never drawn, never answered. **Blocks forever.**     |
| `apps/desktop/src/renderer/src/Session.tsx:1806`   | `const from = m.actor === 'claude' ? 'claude' : 'codex'`                   | Same shape as 1664, for a handoff's source. Attributes a DeepSeek handoff to Codex.      |
| `apps/desktop/src/renderer/src/transcript.ts:1257` | `actor === 'codex' \|\| actor === 'claude'`                                | The "is this an agent" predicate. A DeepSeek message is not treated as agent output.     |
| `apps/desktop/src/renderer/src/Session.tsx`        | 1754, 1804, 1816, 1848, 1860, 1865                                         | Gate the recap, explain, go and quote affordances. A DeepSeek message loses all of them. |

## D — bare array literals · 7 sites

| File:line                                                | What it is                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/settings.ts:148`                  | `DEFAULT_SETTINGS.agents`                                                                                     |
| `apps/desktop/src/main/runtime.ts:2241`                  | `parseMentions(..., { participants: ['codex', 'claude'] })` — mention parsing would not recognise `@deepseek` |
| `apps/desktop/src/main/runtime.ts:2914`                  | `for (const agentId of ['claude', 'codex'] as const)` — an `as const` loop that silently iterates two         |
| `apps/desktop/src/renderer/src/Settings.tsx:14`          | `AGENTS`                                                                                                      |
| `apps/desktop/src/renderer/src/App.tsx:90`               | default cast                                                                                                  |
| `apps/desktop/src/renderer/src/Session.tsx:161`          | `ALL_AGENTS`                                                                                                  |
| `apps/desktop/src/renderer/src/workspace/useUsage.ts:40` | `ACCOUNTS` — the limits surface; ties to the `agents:limits` no-op                                            |

## E — per-agent object literals and `Record` keys · 12 sites

Found by no earlier scan. Each needs a third key.

| File                                                | Lines                          | Shape                                        |
| --------------------------------------------------- | ------------------------------ | -------------------------------------------- |
| `apps/desktop/src/shared/ipc.ts`                    | 111, 112, 114, 115, 1634, 1635 | `models` / `efforts` schemas and defaults    |
| `apps/desktop/src/main/settings.ts`                 | 31, 32, 160, 161               | `perAgent` schema and `DEFAULT_SETTINGS`     |
| `apps/desktop/src/renderer/src/HandoffComposer.tsx` | 16                             | `NAME: Record<AgentId, string>`              |
| `apps/desktop/src/renderer/src/transcript.ts`       | 288                            | `openChanges: { codex: null, claude: null }` |

`Record<AgentId, …>` at `HandoffComposer.tsx:16` is the one exception in this
category: it **will** fail to compile once `AgentId` widens, because a `Record`
over a union requires every member. That is the behaviour every site in category
E should have, and does not.

---

## What Phase 1 does with this

Repoint all 84 at a single `AGENT_IDS` tuple in `@chorus/shared` — **still
holding the same two members** — and delete the four local redeclarations in
favour of an import. No behaviour change, and no third agent yet.

Category E cannot be repointed at a tuple directly; a per-agent record needs a
helper that builds the shape from `AGENT_IDS` so that adding a member cannot
leave a key behind. That helper is the one piece of new code Phase 1 writes.

---

# Phase 1 outcome

## Two categories the five-category scan missed

**F — `Actor` enums, 2 sites.** `apps/desktop/src/shared/ipc.ts:69` and
`packages/event-store/src/events.ts:16`, both
`z.enum(['user', 'system', 'codex', 'claude'])`. These are the most load-bearing
sites in the sweep: without them widened, a DeepSeek message cannot be persisted
to the log or cross the IPC boundary at all. No scan for `'codex' | 'claude'`
finds them, because the pair is embedded in a four-member list.

**G — negated exclusion guards, 11 sites.** `X !== 'codex' && X !== 'claude'`,
the inverse of category C and equally silent — `Session.tsx` ×6, `quote.ts:67`,
`runtime.ts:2115`. A DeepSeek message hits the early return in every one.

## What `@chorus/shared` now exports

`AGENT_IDS` and `ACTORS` as the declarations, `AgentId` and `Actor` derived from
them, `AgentIdSchema` and `ActorSchema` for the zod boundaries, `isAgentId` for
the predicates, and `agentRecord` for the per-agent objects. Still two members.

## Swept — 119 mentions down to 49

| File                                                     | What changed                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/shared/src/ids.ts`                             | the tuples, the schemas, `isAgentId`, `agentRecord`            |
| `apps/desktop/src/shared/ipc.ts`                         | 29 `z.enum` · the `Actor` enum · 6 per-agent records           |
| `apps/desktop/src/main/ipc.ts`                           | 11 unions                                                      |
| `apps/desktop/src/main/settings.ts`                      | 1 `z.enum` · 4 records · the defaults                          |
| `apps/desktop/src/main/open-projects.ts`                 | 1 `z.enum`                                                     |
| `apps/desktop/src/main/runtime.ts`                       | the `4208` predicate · the `2115` guard · mention participants |
| `packages/event-store/src/events.ts`                     | 4 `z.enum` · the `Actor` enum                                  |
| `packages/event-store/src/store.ts`                      | the `agent_id` read schema                                     |
| `Session.tsx`                                            | local `AgentId` deleted · 9 guards · 2 coercing ternaries      |
| `Settings.tsx`, `HandoffComposer.tsx`, `mention-menu.ts` | local `AgentId` deleted                                        |
| `transcript.ts`                                          | the actor predicate · `openChanges`                            |
| `quote.ts`                                               | the actor guard                                                |

## Deliberately left, and why

**Reading-order arrays — 5 sites.** `ALL_AGENTS`, `Settings.tsx:15`,
`DEFAULT_SETTINGS.agents`, `App.tsx:90`, `useUsage.ts:40`. These are display
order, not declaration order, and `useUsage.ts` carries a comment saying so in as
many words — deriving them from `AGENT_IDS` would change what the user reads.
Phase 2 places a new agent in each by hand.

**Binary names — 6 sites.** `resolveCommand('claude')`, `agent-probe.ts`'s
`PROBES`, `options.command ?? 'claude'`. These name executables, not agents, and
`claude-adapter.ts:968` must stay `'claude'` for DeepSeek too. A sweep that
"fixes" these breaks approach A.

**Two-agent product logic — 4 sites.** `collaborate.ts:499-500`'s `WORKER` and
`GUIDE`, `runtime.ts:2916`'s both-must-be-seated loop, `runtime.ts:2928`'s
`notClaude` refusal, and `Session.tsx:1841`'s hand-off affordance. Each encodes
a two-role feature rather than a spelling. **What a third agent means for
collaborate is an unanswered product question**, not a refactor.

**Switch statements — 6 sites.** `Entry.tsx` ×4, `handoff.ts` ×2. Complete with
two members, and `switch-exhaustiveness-check` reports them the moment the union
widens. That is the designed behaviour and needs no change now.

**The adapters — 18 sites.** `claude-adapter.ts`'s ten emissions, both
`mapping.ts` constants, the Codex equivalents. These are Phase 3.

## Unverified

**Nothing was typechecked, linted or run.** Two changes carry more risk than the
rest and should be the first thing a gate is pointed at:

1. `apps/desktop/src/shared/ipc.ts` now imports from `@chorus/shared`. That file
   is consumed by main, preload and renderer, so it is the one place a workspace
   import could fail to resolve in a bundling context that previously needed none.
2. `z.enum(AGENT_IDS)` passes a `readonly` tuple where a mutable one was written
   before. Zod 4 should accept it; that has not been confirmed.
