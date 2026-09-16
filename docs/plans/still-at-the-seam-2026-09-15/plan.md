# Still at the seam

## The problem

When one agent hands off to another, the bottom of the transcript jumps up and
down for about a second. It happens with an agent's `@mention` handoff and with
the Hand off button, and it predates today's build.

Nothing here was reproduced. The diagnosis is from reading the source: claude
first, then deepseek checking it with claude's reading already in its context, so
it is verification rather than an independent second finding.

**Four things change at a handoff, and the follow is a frame late for all of
them.**

- **The action block under the last answer grows, then shrinks.** `finalKey` is
  null whenever anything is working (`Session.tsx:1763-1766`), and nothing is
  working between the sender's `turn.completed` and the receiver's
  `turn.started`. So Recap, the quick hand-off intents, the collaborate presets
  and Go ahead render under the sender's reply for that gap and vanish when the
  receiver starts (`Entry.tsx:1075-1076`, `1140`, `1196`, `1217`, `1283`). The
  row itself stays mounted; only those children come and go.
- **The receiver's thinking row mounts, then is swapped out.** It is drawn from
  `view.working` for agents not yet streaming a message
  (`Session.tsx:1910-1913`, `791-795`), so it appears at `turn.started` and is
  replaced at the first streamed message — often by a shorter, grouped row.
- **The answer's colour flashes.** `data-final` sets the reply to `--bone` and
  everything else to `--text-secondary` (`styles.css:2431-2439`), so the
  sender's reply goes muted, bright, muted across the gap. Paint only, but seen.
- **The follow lags a frame.** `settle` writes `scrollTop` inside a
  `requestAnimationFrame` requested from the `ResizeObserver` callback
  (`Session.tsx:717-724`). The callback already runs after layout and before
  paint, so the frame it asks for comes after a paint. Growth is drawn once below
  the fold; a shrink is clamped at once. `Session.tsx:891-904` already records the
  one-frame lag as visible and corrects it only for a new question.

**The gap cannot be predicted in the renderer.** `followHandoffs` waits for the
sender's `turn.completed`, then awaits `ensureSeated` before it appends
`handoff.created` and dispatches (`runtime.ts:2939-2985`). The renderer sees idle
first and the card only well into the gap.

## What was asked for, and settled before any code

- **Smooth following, message after message** — a guarantee, not a patch for
  this one seam.
- **The previous answer holds through a turn.** It stays bright and keeps its
  buttons, greyed out and unclickable, until the new reply completes. Chosen over
  today's look, knowingly: mid-turn the older answer is brighter than the one
  streaming.
- **A plan, then micro tasks through deepseek**, each reviewed before the next.

## The shape of the answer

### Pin in the same frame

`settle` writes `scrollTop = scrollHeight` directly in the observer callback, and
the `requestAnimationFrame` goes. The deferral was kept for `makeRoom`, which
wrote to a child of an observed element and looped (`Session.tsx:702-715`);
`makeRoom` is gone. A `scrollTop` write changes neither observed box — `.score`
and `.score-content` (`Session.tsx:726-730`) — and a sticky `.turn-head` changes
position, not size (`styles.css:1914-1928`), so nothing re-enters.

### While following, the bottom never moves down

Fixing sources one at a time guarantees nothing about the next row somebody
adds, so this is an invariant rather than a list.

**A floor spacer after `.score-content`, inside `.score`.** Outside
`.score-content`, because the rail and the dots are anchored to that element
(`styles.css:1891`); not observed, so resizing it cannot loop. `.score` is a
padded block container, and `--score-top` is that padding
(`styles.css:1865-1888`), so the sticky offset is untouched.

- **Absorb.** When the observer reports `.score-content` shrank while following,
  the spacer takes up the loss before paint. Nothing above moves.
- **Refill.** Growth consumes the spacer first.
- **Hold 1000ms, then ease out over 240ms.** A shrink nothing refills closes as a
  glide rather than a step. Any regrowth cancels the ease. Both numbers are UX
  choices, tied to the reported "about a second", not constants.
- **A shrink larger than the viewport is not absorbed.** The browser clamps it.
  A fixed 240ms over thousands of pixels is a blur, and a collapse that large is
  an ending the reader expects to see as a jump.
- **Released** when following stops, and when `turnKey` changes. A conversation
  change needs nothing: the pane is keyed by `conversationId` (`App.tsx:1567`,
  `Session.tsx:572-574`), so its refs start fresh.

**`stopFollowing()` owns every write of `false`.** Today it is written in four
places (`Session.tsx:1649`, `2067`, `2072`, `2075`). The spacer's rule is "zero
whenever not following", and a rule with four owners has none.

**Every threshold reader stays correct**, because the spacer sits below the
content and at the true bottom the gap is zero either way: `722`, `765`, `766`,
`903`, `2072`, `2107`. The carry restore (`1616-1645`) is reached only when
`following` is false (`1614`), where the spacer is zero.

### The prepend baseline measures `.score-content`

The one reader the spacer would break. `lastHeight` (`Session.tsx:877-887`) is
recorded on every message-count change, including while the spacer is non-zero;
after the reader scrolls up and a page lands, the compensation would fall short
by the spacer's last size. `.score-content` has no margin leaking out of it —
`.entry` uses `padding-block` — so its height delta equals the `scrollHeight`
delta exactly, and the two owners never touch.

### The answer holds through a turn

**`finalAnswerKey(view)`, pure and exported from `transcript.ts`**, replaces the
inline `finalKey`:

- **Idle:** the newest agent `message` with `status === 'complete'`, as today.
- **Busy:** the newest such message **above the newest trigger row**, where a
  trigger row is a user `message` or a `handoff` card. At a handoff the card is in
  the log before the receiver starts (`runtime.ts:2969-2985`), so the answer stays
  on the sender's reply. After a new question the trigger is the question.
  Intermediate messages inside a turn sit below the trigger and never take it.
- **Busy with no trigger row loaded:** null, which is today's behaviour.

**The two branches agree at the seam, and that agreement is the fix.** Between
the card landing and the receiver starting, `busy` is false and the idle branch
answers the sender's reply, because a `handoff` card is never a candidate. Once
the receiver starts, the busy branch answers the same key. Widen the trigger
definition and this is the property to re-check; step 2's handoff case pins it.

A function of the view rather than a reducer field or a ref: the read path folds
a suffix of the log, so a stored transition may not be in the fold, and a ref is
not rebuilt from the log at all.

**`Entry` gets a `held` prop**, passed by `Session` only to the final entry and
only while busy, so one row re-renders on a busy change rather than every row.
With it, the `final`-gated children — Recap, the intents, the presets, Go ahead —
render `inert` and greyed. Explain and Hand off are not `final`-gated today and
stay as they are.

## Rejected

- **`scroll-behavior: smooth` on `.score`.** Every pin would restart an
  animation, trading a flicker for a lag.
- **Treating a pending handoff as busy.** The renderer cannot know one is coming
  until the card lands, mid-gap.
- **Reading the `@mention` in the reply to predict routing.** That is main's
  decision, and main can decline it.
- **Removing the post-turn watch** (`Session.tsx:757-774`). Redundant once the
  above lands, and harmless; left untouched.

## Steps

Each is one micro task for deepseek, reviewed before the next.

1. `finalAnswerKey` in `transcript.ts`.
2. Its cases in `transcript.test.ts`: idle, busy after a question, busy after a
   handoff card, intermediate messages in a turn, no trigger loaded.
3. `Session.tsx` uses it for `finalKey` and passes `held` to that entry.
4. `Entry.tsx` accepts `held` and marks the `final`-gated children `inert`.
5. `styles.css` greys an inert action.
6. `Session.tsx`: `settle` pins in the observer callback.
7. `Session.tsx`: `stopFollowing()` replaces the four writes.
8. `Session.tsx`: the floor spacer, and its absorb, hold, ease and release.
9. `Session.tsx`: the prepend baseline measures `.score-content`.

## As built — 2026-09-15

Written by deepseek one micro step at a time, each reviewed against a snapshot
of its file before the next was sent. **Nothing has been typechecked, linted,
tested or run.**

- **Steps 2b and 8a–8c were added in flight.** 2b pins the `isAgentId` clause,
  which no earlier case could fail without. Step 8 was split so each review stayed
  small: the spacer and its release path, then absorb, refill, hold and glide,
  then the release on a new question.
- **Release before pin.** In the `turnKey` effect `releaseFloor.current()` runs
  before the pin, so the pin lands on the true bottom. Swapped, it would write the
  old bottom and leave the correction to the browser's clamp.
- **The prepend baseline is spacer-proof by construction.** It measures an element
  the spacer cannot change; `stopFollowing` zeroing the slack is a second line of
  defence, not the only one.
- **Known behaviour, not defects.** Widening the pane reflows the content shorter,
  and that shrink is absorbed and glided like any other. The first upward wheel
  tick drops the slack, moving the content by at most its height, in the direction
  of the gesture.
- **Comments that now describe the old behaviour were left in place**, under the
  rule against touching comments, for the user to decide.

## Exit criteria

Checked by hand:

- A handoff, by `@mention` and by the button, moves nothing at the bottom.
- The previous answer stays bright with greyed, unclickable buttons until the new
  reply completes, then the buttons move to the new reply once.
- A streaming reply follows with no visible lag.
- Scrolling up mid-turn stops following at once, and loading earlier pages keeps
  the paragraph being read still.
- A collapse taller than the screen jumps rather than glides.
- Switching tabs and back still restores the scroll position.

## Open questions and risks

- **Whether a wheel over an `inert` subtree still scrolls the transcript.**
  Unverified. If it does not, per-button `disabled` is the fallback.
- **The 1000ms hold and 240ms ease** are first guesses at a feel, to be adjusted
  by hand.
- **Nothing in this plan has been run.** The diagnosis and every exit criterion
  are unverified until someone drives the app.

## Part 2 — let go when you scroll up

**Added 2026-09-15, after Part 1 was written and before any of it was run.**
While a reply auto-scrolls, scrolling up a little does not stop it, and the chat
keeps jumping — with a trackpad, the scrollbar and the keyboard alike. Agreed
with deepseek from the source; line numbers refer to the file before Part 2.

### What was asked for

- **Any upward scroll stops following**, however it was made.
- **Following resumes only at the very bottom.**

### Why it keeps jumping

- **`onScroll` resumes within 32px of the bottom** (`Session.tsx:2160`). A small
  scroll up stops in `onWheel` (`2120`) and resumes on the scroll event it causes.
- **A scrollbar drag produces only scroll events**, and `onScroll` never stops
  following. `onTouchMove` stops only beyond 32px (`2125`).
- **Part 1's `stopFollowing` releases the floor** (`665-666`). Within the slack of
  the bottom, that clamps the reader straight back down.

### The shape

**Direction decides, and the gap guards it.** A `lastTop` ref, seeded from
`el.scrollTop` when the observer effect mounts. On scroll: moved up with a gap
over 1px calls `stopFollowing()`; moved down to a gap of 1px or less calls
`resumeFollowing()`. Growth never lowers `scrollTop`; our pins and the glide land
at gap 0; a shrink's clamp lowers it at gap 0. None of them stops or resumes, so
the failure recorded above `onWheel` — a position read as a gesture — cannot form.

**Every programmatic write was checked.** The pins set the maximum (observer,
glide, post-turn watch, `turnKey`); the prepend's `+= grew` rises at a large gap;
the carry restore runs only when not following (`1669`, `1698`).

**At the bottom there is no scroll event, so the input handlers resume.**
`onWheel` with `deltaY > 0`, `onKeyDown` with `End`, `PageDown` or `ArrowDown`,
and `onTouchMove` — each at a gap of 1px or less. The existing stops on
`deltaY < 0` and the up keys stay as the fast path, because they fire before the
scroll lands. `onTouchMove` stops nothing; `onScroll` does.

**`resumeFollowing()` owns a reader's resume**, as `stopFollowing()` owns the stop.
It returns at once when already following: our own pins raise `scrollTop` at gap 0
on every growth frame, and each would otherwise restart the hold. The send paths —
`accept`, `sendSelection`, `onSending` — keep their direct writes, because each
sends a user message and the `turnKey` effect releases right after.

**The floor freezes instead of releasing.** `stopFollowing` no longer calls the
ref, a deliberate partial revert of step 8a. The glide's `step` stops while
following is off, and a pending hold ends in that same `step`, so no timer
plumbing is needed. Nothing is absorbed while not following: the spacer sits below
the content and cannot hold anything still above a parked reader.

**`releaseFloor` becomes `settleFloor(immediately)`**, renamed in the same change
because its meaning widens. `true` releases now, for a new question. `false`
re-arms the hold, for a resume — so slack left when the reader scrolled away
glides off when they return, rather than staying as a blank strip under the last
row, which is the complaint `.turn-tail` records (`styles.css:1947-1960`).

### Steps

1. `releaseFloor` becomes `settleFloor(immediately)`; `turnKey` passes `true`;
   `stopFollowing` stops calling it.
2. The glide's `step` freezes while following is off.
3. `resumeFollowing()`.
4. `lastTop`, its seed, and the direction rule in `onScroll`.
5. The resumes in `onWheel`, `onKeyDown` and `onTouchMove`.

### Exit criteria

Checked by hand:

- During a streaming reply, the smallest scroll up — trackpad, scrollbar or
  keyboard — stops following, and the view stays where it was put.
- Scrolling back to the very bottom resumes; stopping a few pixels short does not.
- At the bottom with following off, a wheel down or `End` resumes.
- Space left under the last row glides away after returning to the bottom.
- A new question still starts at the bottom.

### Residual risks

- **A browser scroll from focusing something inside `.score`** would read as an
  upward gesture and stop following. Nothing does that today — `scrollIntoView`
  is used only by tab strips (`TerminalPanel.tsx:87`, `Workspace.tsx:1230`) — and
  `NoteEditor.tsx:182` shows this codebase has met the class before.
- **macOS elastic overscroll** is unverified; the gap guard makes it harmless
  either way.
- **Nothing in Part 2 has been run.**

### As built — Part 2

Written by deepseek in five steps, each reviewed against a snapshot of the file
before the next was sent. **Nothing has been typechecked, linted, tested or run.**

- **One writer each way.** `following.current = false` is written only inside
  `stopFollowing`, and a reader's resume only inside `resumeFollowing`; the three
  send paths keep their direct `true` writes.
- **No 32px threshold remains.** Every stop and resume test is at 1px.
- **The glide's guard precedes `setSlack`**, so a glide the reader interrupts keeps
  its remaining slack for the resume to glide away.
- **Comments above `onWheel` and `onScroll` still describe the old rule** — that
  stopping is a gesture the handlers own and position only resumes. Left in place
  under the rule against touching comments, for the user to decide.
