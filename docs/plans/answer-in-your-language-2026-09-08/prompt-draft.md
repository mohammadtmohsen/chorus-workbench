# Answer in your language — draft instruction text

**This is not a plan.** It is the wording we intend to feed into the global
always-instruction, kept here so it survives the conversation it was tuned in.

The setting it belongs to does not exist yet. Today `explainLanguage` is read in
exactly two places, both in `apps/desktop/src/main/runtime.ts`, and both are the
aside path — the Explain and Translate cards. Nothing reaches an ordinary turn.
Making this text apply to every reply means appending it to each agent's system
prompt: Claude accepts `systemPrompt: { type: 'preset', preset: 'claude_code',
append }`, Codex accepts `developerInstructions` on `thread/start`. It has to ride
`resume` as well as `start`, or the instruction is lost after a relaunch.

## The rule

Write in Modern Standard Arabic. The Arabic carries the sentence: its grammar,
its connectives, its particles, its verbs of saying and being.

Technical vocabulary always stays in English, inside the Arabic sentence —
`event`, `status`, `commit`, `branch`, `props`, `hook`, `endpoint`, `cache`,
`migration`, and the names of tools, libraries, formats and APIs. Identifiers,
file names and paths stay exactly as written, in their own script, never
translated and never transliterated.

Beyond the vocabulary, carry a further share of the sentence in English, and put
that share on **verbs and nouns** — `appending`, `passing`, `field`, `value`,
`projects`, `agents`. Not on connectives. `otherwise`, `which means`, `once` read
as an English sentence interrupted by Arabic; an English noun inside an Arabic
clause reads as how a developer actually speaks.

Definite articles stay Arabic and attached — `الـ Settings`, not `the Settings`.
This was tried the other way and reverted.

**Pair every paragraph: English first, then the same paragraph in Arabic.** Not
the whole answer in one language followed by the whole answer in the other — the
unit is the paragraph. Write a paragraph in English, write it again in Arabic
immediately underneath, then move to the next point and do the same. Technical
vocabulary stays English on both sides; the Arabic side also carries a share of
its verbs and nouns in English, as above.

This is the third shape tried and the reason it won is distance. One mixed text
was unreadable to anyone who does not code-switch. Whole-answer doubling was
readable but put each Arabic paragraph screens away from the English it
translates, so checking one against the other meant scrolling. Pairing keeps a
point and its translation adjacent, which is what a reader actually compares.

**The status block stays English.** It is the one exception to the rule above,
and it is not a bidi concession — the block's value is that six labels scan down
the left edge, and a doubled bilingual footer is a second essay under a status.

**Questions the agent asks follow the rule too**, and they are the place it
matters most: a question is blocking, it expires, and it is usually the densest
thing on screen. So the question text is written Arabic first and then English,
the same way an answer is.

Its options are the one place the doubling has to bend, and the bend is a
measured one rather than an exemption. An option's label is a few words wide and
a card header is a dozen characters, so two languages will not fit in either
without truncating both. **The label and the header stay English; the option's
description carries the Arabic**, which is the field with room for a sentence and
the field a reader consults when the label alone is not enough.

## The worked example

This is the shape. Match it.

> نعم، هذا ممكن. الـ setting موجود بالفعل لكنه يعمل على الـ Explain card فقط، ولا
> يصل إلى أي reply عادي. ولجعله global يجب appending سطر واحد إلى الـ system
> prompt الخاص بكل agent. يقبل Claude الـ `append` على الـ preset، بينما يوفّر
> Codex الـ field المسمّى `developerInstructions` في `thread/start`. تكتب الـ
> value مرة واحدة في الـ Settings فينطبق على كل الـ projects وعلى الـ agents
> الاثنين. الأمر الوحيد الذي يستدعي الانتباه هو passing الإعداد في الـ `resume`
> أيضاً لا في الـ `start` وحده، وإلا ضاع بعد إغلاق التطبيق.

## Two things this text will meet

**Bidi is already handled, and the fix is in the text rather than the code.**
`MarkdownView.tsx` sets `dir="auto"` on every prose block — paragraphs, headings,
list items, blockquotes, table cells — and `dir="ltr"` explicitly on fenced code.
`auto` takes the direction from **that block's own first strong character**.

Which is exactly why an English-labelled status block rendered left-to-right with
its punctuation on the wrong edge: each line opened with `**Plan**`, a Latin word,
so the item's first strong character was Latin and `auto` chose LTR for it. The
same list with Arabic labels resolves right-to-left, per item, with no code
change. It was diagnosed here as a missing renderer feature first; that was wrong,
and the renderer had solved it before this text existed.

The consequence for this instruction: **open an Arabic block with an Arabic
word.** A paragraph that begins with an identifier or a `code span` will be laid
out LTR however much Arabic follows it, and the block is the unit — one English
opening cannot be undone later in the same paragraph.

**No surface is exempt.** Leaving the scannable ones in English — a status block,
a table — was proposed and rejected: a rule with exceptions teaches the exception.

**Length.** The existing "Answer in" field is bounded by `MAX_EXPLAIN_LANGUAGE`
and normalised to a single line, so this text does not fit in it. That bound is
the reason the always-instruction wants its own free-text box rather than a wider
version of the field that is already there.
