# Answer in your language, on every turn

## The problem

Chorus already knows what language you read in. `explainLanguage` — labelled
**"Answer in"** under the settings heading **"Your language"** — is free text,
bounded by `MAX_EXPLAIN_LANGUAGE`, normalised to a single line, empty by default.

It reaches almost nothing. `apps/desktop/src/main/runtime.ts` reads it in exactly
two places, line 1876 and line 2109, and both are the aside path: the _Explain
simply_ and _Translate_ cards, which run as ephemeral forks. An ordinary turn
never sees it. So the person who set it still reads every actual reply in
English, and gets a button under each one offering to say it again.

That is backwards. The setting exists because someone reads more comfortably in
their own language; the reply is the thing they read.

`prompt-draft.md`, beside this file, is the wording that came out of tuning the
style in a live conversation. It is the payload. This plan is the delivery.

## What is missing, precisely

**Chorus sets no system prompt at all.** `systemPrompt` appears nowhere in the
source. Both providers expose the hook and neither is used:

- Claude's SDK takes `systemPrompt: { type: 'preset', preset: 'claude_code',
append }` — verified in `sdk.d.ts:2017`. `append` is the right arm: replacing
  the preset would discard the CLI's own prompt, which is not what this is for.
- Codex takes `developerInstructions` on `thread/start`, and the same key exists
  on `thread/resume` and `thread/fork`.

**`SessionOpts` cannot carry it.** `packages/agent-protocol/src/adapter.ts:117`
holds `cwd`, `model`, `sandbox`, and nothing else. The field has to be added
there, which is one of the six packages that exist **by copy** in the sibling
repo. That is a real cost and it is accepted: the alternative is two adapters
reading a setting behind the port's back, which is worse.

## The shape

Four decisions were taken before this was written, and each one closed an
alternative that is worth naming.

**The instruction goes in the system prompt, not on each turn.** Per-turn
injection was the other candidate and it is genuinely cheaper to toggle — the
text simply rides the next message. It was rejected because the instruction then
lives in the conversation rather than above it: it competes with what the user
actually asked, it is repeated in the context once per turn, and anything reading
the log has to decide whether that text was the user's words. A system prompt is
the place a standing instruction belongs.

**So toggling restarts the session, and that is affordable because a restart is
not a reset.** The Claude adapter already carries `resume`, and Codex's
`thread/resume` accepts `developerInstructions`. Flipping the toggle ends the
current query and reopens the same session with the new value; the context comes
back with it. The one honest cost: **the change lands from the next turn, not the
one in flight.** A toggle pressed mid-stream cannot retroactively re-language a
reply that is already arriving, and the UI must not pretend otherwise.

**The toggle is per conversation, with the Settings value as the default for new
ones.** This reverses an earlier decision in the same conversation — "app-wide,
one value" — and the reversal is the right way round. One value cannot express
the ordinary case, which is reading in Arabic while pasting an English reply to a
colleague from the room next door. Settings holds the text and the default; a
conversation holds only its own on/off.

**The flag lives in memory, beside `planning`.** ~~It is written to the event
log.~~ This was decided the other way when the plan was written and reversed
while implementing it, which is the honest order: the argument for the log was
that scrolling up through a conversation whose replies change language halfway
should say why. What the code then showed is that `planning` — the exact same
shape, a per-conversation boolean that changes how agents are driven — is not in
the log at all. It lives on `ActiveConversation` and in the remembered
open-session file.

Following the precedent won for a reason the plan could not see from outside the
code: **the flag decides how an agent is spawned**, so it has to be readable
before anything has been replayed. An event would have to be projected back into
memory anyway, and the projection would then be the real source. The cost is
stated where the field is declared — a relaunch returns a room to the global
default — and the transcript marker can still be added later without moving the
state.

## Phase 1 — the setting

Settings grows a second control under the existing **Your language** heading: a
free-text box for the standing instruction, and a checkbox that is the default
on/off for new conversations. `ExplainLanguage` in `Settings.tsx:309` is the
model to follow, including its normalisation-on-write.

**The new box is not a wider "Answer in".** That field is one line and short
because it names a language; this one holds a paragraph. Two fields, because they
answer two questions — _which language_ and _how to write it_ — and `explainLanguage`
keeps driving the Explain card exactly as it does now. Nothing about the aside
path changes in this plan.

The schema in `apps/desktop/src/shared/ipc.ts:121` and the copy in
`apps/desktop/src/main/settings.ts:77` both gain the two keys, with defaults that
let a settings file written before today parse unchanged — the existing test in
`explain-language.test.ts` is the pattern and deserves a sibling.

## Phase 2 — the port and the adapters

`SessionOpts` gains an optional instruction string. Claude maps it to
`systemPrompt`'s preset-append arm inside the options block at
`claude-adapter.ts:1176`. Codex maps it to `developerInstructions` at
`thread/start` (`codex-adapter.ts:510`) **and at `thread/resume`**, because a
resume that drops it is a conversation that silently reverts after a relaunch.

`ForkOpts` extends `SessionOpts`, so asides inherit the field for free. They must
not use it: an aside already builds its own language prompt through
`explainPrompt` and `KEEP_IN_ENGLISH`, and two instructions about language in one
context is how a prompt starts arguing with itself. The fork path passes
`undefined` deliberately, and says so.

**One unverified shape.** Codex's `developerInstructions` is present in the
generated bindings, but whether it appends to the agent's own instructions or
displaces part of them is not stated by the types. Read it out of the codex
app-server behaviour before shipping, not out of this sentence.

## Phase 3 — the toggle and the restart

A control in the pane, so the flip does not require opening the settings sheet,
plus the checkbox in Settings for the default. Flipping appends the event,
updates the projection, and asks the conversation service to reopen the session
with the new options.

No event and no projection, per the reversal above. `setAnswerStyle` sets the
field and respawns each participant onto the thread it was already on, carrying
`seenSeq` across so nothing is re-read as catch-up, passing `reopening` so no
false "joined" line appears, and reapplying plan mode by hand because permission
mode is session state that comes back as `default`.

The control refuses while a turn is streaming. That is not politeness: closing a
service mid-stream discards a partial reply, and Codex does not give it back —
which is the reason the event log exists in the shape it does.

The transcript marker is deliberately not built. It was the strongest argument
for the log, and with the flag in memory it would be a marker with nothing behind
it. If it is wanted later it wants the event too, and that is a second change
rather than a missing half of this one.

## What this deliberately does not do

- **No percentage.** A "50/50" control was asked for and refused: a model does
  not count its own words, so a number in a prompt is a mood, and a slider
  showing one is a control that lies. The draft expresses the mix as a rule —
  Arabic carries the sentence, English carries the technical vocabulary and a
  share of the verbs and nouns.
- **No per-project override.** Settings default plus a per-conversation flag is
  two levels; a third is a question nobody has asked yet.
- **No change to Chorus's own UI language.** The setting note already promises
  this, and it stays true.
- **No renderer work.** `MarkdownView.tsx` already sets `dir="auto"` on every
  prose block and `dir="ltr"` on fenced code, and it is per block, from the
  block's own first strong character. The bidi drift seen while tuning the style
  was caused by lines opening with an English label, not by the renderer. The
  draft carries the resulting writing rule instead: **open an Arabic block with
  an Arabic word.**

## Open questions

- **The sibling repo.** `agent-protocol` and both adapters are copies in
  `mohammadtmohsen/chorus`. Phase 2 should land there as a cherry-pick, not as a
  second implementation — but whether that repo wants the feature at all is a
  question for its owner, and the answer might be "take the port change, skip the
  UI".
- **A turn in flight.** Ending a query mid-stream is not something Chorus does
  anywhere today. Refusing the toggle while a turn is streaming is the simplest
  answer and probably the right one, but it needs to be a deliberate choice with
  something on screen saying why the control is inert.
- **Whether the checkbox is one control or two.** "Use my language" and "here is
  the instruction text" may want to be a single control where a non-empty text
  means on. Two controls can disagree — text set, checkbox off — and that state
  has to read as something rather than as a bug.
