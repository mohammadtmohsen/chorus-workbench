import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { IdeContextPush } from '../../shared/ipc.js'
import { quotePath } from './attach.js'
import { ComposerMenu, type MenuItem } from './ComposerMenu.js'
import { Attachments, type Attachment } from './Attachments.js'
import { formatContextBlock, versionFor, withEditorContext } from './editor-context.js'
import {
  applyMention,
  commandOptions,
  fileOptions,
  findCommandQuery,
  findMentionQuery,
  liveMention,
  mentionOptions,
  menuTakesKeys,
  menuVisible,
  type CommandInfo,
  type StampedMention,
} from './mention-menu.js'
import { withQuote } from './quote.js'

/**
 * The box you type into, and everything that decides what leaves it.
 *
 * Lifted out of `Session`, which was 1,653 lines with the composer's concerns —
 * the mention menu, attachments, the editor pill, submit — interleaved with the
 * transcript's: scroll following, turn pinning, the room made for a pinned
 * question. Two subjects sharing twenty-five pieces of state, where every
 * keystroke re-rendered the whole transcript because the draft lived beside it.
 *
 * It now does not. `draft` and `attached` are held here, so typing repaints a
 * textarea rather than a conversation, and the pane reads them back only when it
 * needs them — on unmount, for the carry.
 *
 * The seam is deliberately narrow: three imperative calls in (focus, quote,
 * attach), two notifications out, and one read. Anything wider and this is the
 * same file with a different name.
 */

export interface ComposerHandle {
  /** The pane focuses the box after approvals, drops, and its own mount. */
  focus: () => void
  /** Puts a passage from the transcript in the draft, as the quote offer does. */
  quote: (passage: string) => void
  /**
   * Puts text in the draft exactly as given.
   *
   * Separate from `quote`, which wraps whatever it is handed in `>` markers. An
   * aside brought forward arrives already formatted — it carries its own
   * quoting, a mention that decides routing, and a line saying where the answer
   * came from. Re-quoting all of that would bury the instruction inside the
   * evidence for it.
   */
  insert: (text: string) => void
  /**
   * A drop lands on the whole pane, not on the box.
   *
   * Files rather than the `DataTransfer` they arrived in: a paste and a drop
   * both carry one, and the composer's own attach button carries none — it has
   * an `<input type="file">` behind it, whose `files` is a `FileList`. All three
   * have files, which is the only thing this ever wanted.
   */
  attach: (files: readonly File[]) => Promise<void>
}

/** What the pane has to carry across an unmount on the composer's behalf. */
export interface ComposerState {
  draft: string
  attached: Attachment[]
}

export interface ComposerProps {
  readonly conversationId: string
  /** Whether this project's workbench is on screen — the Editor switch's state. */
  readonly workbenchShown: boolean
  readonly onToggleWorkbench: () => void
  readonly participants: readonly string[]
  /** Drives whether the one button offers Send or Stop. */
  readonly busy: boolean
  readonly working: readonly string[]
  /** What VS Code is showing for this pane's project. Metadata only. */
  readonly ide: IdeContextPush | null
  /**
   * The session's own actions, in the row where the work happens.
   *
   * They are in the drawer's menu too, and deliberately: that menu serves every
   * session in the list, including the ones open in no pane and therefore having
   * no composer to press. This is the copy for the session you are typing in.
   */
  /**
   * Branches this conversation into a side task carrying the draft as its brief.
   *
   * Undefined where there is no agent to fork from — the pane decides, because
   * only it knows whether anyone has actually started a session yet.
   */
  /** Show or hide this session's Changes panel. Absent outside a git repository. */
  /** Whether the panel is showing, so the button can say which way it goes. */
  readonly initial?: {
    readonly draft?: string
    readonly attached?: readonly Attachment[]
  }
  /**
   * Where to leave the draft, written on every render.
   *
   * A ref the *pane* owns, rather than something read back through the handle
   * on the way out: React detaches a child's ref before the parent's cleanup
   * runs, so by the time the pane wants the draft the handle is already null.
   * The e2e caught exactly that — a backgrounded tab came back empty.
   *
   * Assigning during render is the same thing the pane does for its own carry,
   * and it is what keeps a keystroke from re-rendering a conversation.
   */
  /**
   * What was said before, oldest first.
   *
   * Taken from the transcript rather than kept separately: the messages are
   * already reduced from the log, so recall survives a restart and a reopened
   * conversation for free — and there is no second list to fall out of step.
   */
  readonly history: readonly string[]
  readonly report: { current: ComposerState }
  readonly onError: (error: unknown) => void
  /** A message is on its way: follow the transcript and say we are waiting. */
  readonly onSending: () => void
  /** It never left, so nothing is coming and the waiting row must go. */
  readonly onSendFailed: () => void
}

/**
 * How often an open, unanswered menu may ask again, and how long it keeps that
 * up.
 *
 * Both menus used to ask a bounded number of times and then stop *while the
 * question was still open* — the slash list five times over nine seconds, the
 * file list exactly once — after which no amount of waiting produced anything
 * and one more keystroke produced everything (C-003). The person looking at an
 * empty menu is the signal that the answer still matters, so that is what the
 * asking is tied to now.
 *
 * **The floor is a rate limit and the gap grows past it.** 800ms is the closest
 * two asks may ever be, which is what stops an open menu spawning `git ls-files`
 * in a loop; the gap then widens by that much each time, so eight attempts span
 * about twenty-two seconds rather than six. Both numbers matter: the first
 * bounds the cost per second, the second bounds how long a genuinely stuck CLI
 * is waited on.
 *
 * Measured against the reproduction: a CLI reporting its commands at twelve
 * seconds is inside this and outside the old nine.
 */
const ASK_FLOOR_MS = 800
const ASK_CEILING = 8

export const Composer = forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref): React.JSX.Element {
    const { t } = useTranslation()
    const { conversationId, participants } = props

    const [draft, setDraftState] = useState(props.initial?.draft ?? '')
    /**
     * How many times the draft has been written, ever.
     *
     * The mention carries the revision it was read from, and text equality is
     * not enough on its own: two different edits produce the same string, so
     * `send` then recall — or simply retyping the same word — would bring a
     * stale mention back to life carrying offsets from an earlier edit. A
     * counter cannot be forged that way.
     *
     * A ref, not state: it changes only alongside a `setDraftState` that is
     * already causing the render, and a second state write would render twice.
     */
    const rev = useRef(0)
    /**
     * The only way the draft is written, so nothing can change it unnoticed.
     *
     * Six callers write the draft — the parse's own `onChange`, `choose`,
     * `send`, `quote`, `insert` and history recall — and four of them do it from
     * outside the textarea with no change event at all. Routing every one
     * through here is what makes "the mention describes the current draft" a
     * fact rather than a thing each caller has to remember.
     */
    const writeDraft = useCallback((next: string | ((current: string) => string)) => {
      rev.current += 1
      setDraftState(next)
    }, [])
    const [attached, setAttached] = useState<Attachment[]>([...(props.initial?.attached ?? [])])
    /*
     * Which of the composer's own menus is open, and where it hangs from.
     *
     * One slot rather than one flag each: two of these open from controls a
     * centimetre apart, and two independent booleans is how both end up on
     * screen at once.
     */
    const [menu, setMenu] = useState<{
      kind: 'add'
      anchor: DOMRect
      trigger: HTMLElement | null
    } | null>(null)

    const openMenuFrom = (kind: 'add', event: React.MouseEvent<HTMLElement>): void => {
      const trigger = event.currentTarget
      setMenu({ kind, anchor: trigger.getBoundingClientRect(), trigger })
    }
    /**
     * The mention being typed, stamped with the text it was read from.
     *
     * The stamp is what makes staleness impossible to represent, and it is
     * needed because `leftBox` below stops the blur from clearing this (C-003).
     * A mention is a pair of offsets into a particular string; the moment the
     * string changes it describes a range in text that no longer exists, and
     * `applyMention` would splice at the wrong place — deleting whatever now
     * sits there.
     *
     * `onChange` covers what a person types. It does not cover `quote`,
     * `insert` or `send`, which call `setDraft` from outside the box and fire no
     * change event at all; `quote` and `insert` also refocus, which is exactly
     * the sequence that would reopen a menu against rewritten text.
     *
     * Comparing the stamp costs a string compare per render and needs no caller
     * to remember anything, which is why this rather than re-deriving on every
     * programmatic write: re-deriving needs the caret, and the caret is the one
     * thing that cannot be trusted around a focus event.
     */
    const [mention, setMention] = useState<StampedMention | null>(null)
    /**
     * Whether the box has the caret, kept apart from what is in the box.
     *
     * These were one value and that was C-003. `onBlur` cleared the mention to
     * close the menu — right about the menu, wrong about the mention, and
     * nothing ever undid it: `refreshMention` runs on change, select and
     * keydown, and focus returning is none of those. So the box kept its `/`,
     * the menu stayed shut, and only another keystroke could reopen it.
     *
     * Reproduced at the OS level rather than argued: steal focus with another
     * app and give it back, and the record comes back `mention: none`,
     * `rows: 0`, `value: "/"`, `caret: 1` — identical to the failing run on the
     * board. Note `focused: true` throughout, which is what made that record
     * look impossible: a window losing focus fires `blur` on the element while
     * `document.activeElement` still points at it.
     *
     * The obvious repair — `onFocus={refreshMention}` — was tried and measured
     * *worse than doing nothing*, 2 of 5 menu specs against 5 of 5, because a
     * focus event can fire with the caret still at 0 and `findCommandQuery`
     * reads `text.slice(0, caret)`. Nothing here reads the caret on focus, so
     * that race has nowhere to happen.
     *
     * **"Has the box been left" rather than "does the box have the caret", and
     * the difference is the whole correctness of this.** The first version of
     * this fix held `focused`, defaulting to `false`, and it broke the slash
     * menu in 2 of 5 full runs — the same score as the repair it replaced. The
     * record said why: `mention: "/0:"`, `commands: "50"`, `rows: 0`. Everything
     * needed was present and the menu was still shut, because `onFocus` had
     * never fired.
     *
     * It had never fired because **Chromium defers a focus event while the
     * document itself is unfocused**. A window that does not have the OS's focus
     * — a freshly launched Electron, an app behind another — takes
     * `el.focus()`, sets `document.activeElement`, and dispatches nothing until
     * the window is focused. So `focused` stayed `false` and the menu could
     * never open.
     *
     * Asking whether the box was *left* has no such hole: nothing has been left
     * at mount, which is true without needing an event to say so, and a focus
     * event that never arrives leaves the answer correct rather than stuck.
     */
    const [leftBox, setLeftBox] = useState(false)
    /**
     * What this conversation accepts, asked once and kept.
     *
     * Per conversation because the list is the project's: its own
     * `.claude/commands`, its skills, its plugins. Fetched on mount rather than
     * when the menu opens, so the first `/` shows a list instead of a pause.
     */
    const [commands, setCommands] = useState<CommandInfo[]>([])
    /**
     * Files matching the mention being typed.
     *
     * Asked of the main process per keystroke rather than held: the renderer has
     * no filesystem access, and a project's file list is both large and liable
     * to change under you. Debounced, because a keystroke is not a question
     * worth spawning `git ls-files` for on its own.
     */
    const [files, setFiles] = useState<string[]>([])
    /**
     * Whether the menu is still waiting on an answer, and if not, why it has
     * none.
     *
     * An empty menu used to be one thing on screen and three things underneath:
     * a lookup still running, a lookup that ran out of attempts, and a directory
     * that can never answer. They rendered identically — as nothing at all,
     * because the menu only opened when it had rows — so neither a person nor a
     * spec could tell "not yet" from "never" (C-003). A spec in particular could
     * only wait, and then time out saying nothing about which it had hit.
     *
     * One field rather than one per surface: a `/` menu and an `@` menu cannot
     * be open at the same time, because `refreshMention` resolves to a single
     * query.
     */
    const [lookup, setLookup] = useState<'asking' | 'exhausted' | 'unavailable' | null>(null)
    /**
     * How far back through what was said we are, counting from the end.
     *
     * Zero is the live draft. Entered only from an empty box and left the moment
     * anything is typed, which is what keeps arrow keys meaning "move the caret"
     * in a message being written — the alternative is a draft that jumps away
     * mid-sentence.
     */
    const recalled = useRef(0)
    const [highlighted, setHighlighted] = useState(0)
    const input = useRef<HTMLTextAreaElement | null>(null)
    /* The file chooser behind the attach button. Hidden, and never focusable. */
    const picker = useRef<HTMLInputElement | null>(null)

    /*
     * Everything downstream reads this, never `mention` — that is the invariant.
     *
     * Declared here rather than beside its consumers because `useCallback`
     * dependency arrays evaluate during render, and a value used above its own
     * declaration throws a TDZ `ReferenceError` on first paint that typecheck
     * does not catch.
     */
    const liveStamp = liveMention(mention, draft, rev.current)
    const active = liveStamp?.query ?? null

    const hasDraft = draft.trim() !== '' || attached.length > 0
    props.report.current = { draft, attached }

    useEffect(() => {
      /*
       * The box grows with what is in it, up to a ceiling set in CSS.
       *
       * Collapsed to `auto` first: `scrollHeight` is the content height *or* the
       * current box height, whichever is larger, so without the reset the field
       * would grow and never shrink back.
       */
      const el = input.current
      if (el === null) return
      el.style.height = 'auto'
      el.style.height = `${String(el.scrollHeight)}px`
    }, [draft])

    useEffect(() => {
      /*
       * One warm-up ask, so the first `/` shows a list rather than a pause.
       *
       * A pane mounts the moment its conversation exists, which is before the
       * session has finished starting, so this answer is often empty — and that
       * is now fine. It used to carry its own retry, four tries over about nine
       * seconds, because it was the only thing asking; a CLI slower than that
       * budget left the menu empty for the life of the pane.
       *
       * **It is no longer what correctness rests on.** The menu asks for itself
       * while it is open and unanswered (`ASK_FLOOR_MS` below), which is bounded
       * by someone actually waiting rather than by a guess at how long a CLI
       * takes to start. Two independent retry loops asked the same question at
       * overlapping times — measured at 243ms apart, under the floor one of them
       * was enforcing — so this went back to being what its comment always said
       * it was: a warm-up, not a guarantee.
       */
      let live = true
      window.chorus
        .listCommands({ conversationId })
        .then((result) => {
          if (live && result.commands.length > 0) setCommands(result.commands)
        })
        .catch(() => {
          // No session to ask yet, or a CLI too old to be asked. Either way the
          // menu will ask again for itself when someone opens it.
        })
      return () => {
        live = false
      }
    }, [conversationId])

    /*
     * The query itself, not the object carrying it — the same reason as
     * `wantsCommands`, and here it is also literally what is being asked. Null
     * until there is an `@` with something after it: a bare `@` means the cast,
     * and offering the whole repository beside two agent names is not a menu.
     */
    const fileQuery = active?.trigger === '@' && active.query !== '' ? active.query : null
    useEffect(() => {
      if (fileQuery === null) {
        setFiles([])
        return
      }
      let live = true
      let attempts = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      setLookup('asking')
      const again = (): void => {
        if (attempts >= ASK_CEILING) {
          setLookup('exhausted')
          return
        }
        timer = setTimeout(ask, attempts * ASK_FLOOR_MS)
      }
      const ask = (): void => {
        attempts += 1
        window.chorus
          .completeFiles({ conversationId, query: fileQuery })
          .then((result) => {
            if (!live) return
            /*
             * Where the three states pay for themselves.
             *
             * `ready` is an answer even when it is empty — git looked and found
             * nothing, and asking a second time is asking the same question.
             * `unavailable` is a directory with no git or no repository in it,
             * where every retry would spawn a process to be told the same thing.
             * Only `retryable` is a question that never got put, and only that
             * one is worth putting again.
             *
             * All three used to arrive as `[]`, which is why one failed lookup
             * emptied this menu for as long as the query stayed the same.
             */
            if (result.state === 'retryable') {
              again()
              return
            }
            setLookup(result.state === 'unavailable' ? 'unavailable' : null)
            setFiles(result.files)
          })
          .catch(() => {
            // The IPC call itself failed, which says nothing about git — the one
            // thing it cannot be is an answer.
            if (live) again()
          })
      }
      // Debounced: a keystroke is not a question worth spawning `git ls-files`
      // for on its own.
      timer = setTimeout(ask, 90)
      return () => {
        live = false
        if (timer !== undefined) clearTimeout(timer)
      }
    }, [conversationId, fileQuery])

    useEffect(() => {
      /*
       * Written down a second after you stop typing.
       *
       * Not on every keystroke: `open-sessions.json` is rewritten whole, and a
       * sentence would rewrite it forty times. A second of lag costs the last
       * second of typing in a crash, which is the right trade against making the
       * file the bottleneck for the box.
       */
      const timer = setTimeout(() => {
        void window.chorus.rememberDraft({ conversationId, draft })
      }, 1_000)
      return () => {
        clearTimeout(timer)
      }
    }, [conversationId, draft])

    /**
     * Which branch last decided the mention, for the record rather than for logic.
     *
     * Six things can make the menu unavailable — the parse finding nothing, the
     * `dismissed` branch, `choose`, Escape, `liveMention` rejecting the stamp,
     * and `leftBox` hiding it — and until now the attribute said `none` for
     * several of them. Two failing runs could not be explained because of it.
     *
     * A ref rather than state: writing this must never cause a render, or the
     * instrument changes the thing it measures.
     */
    const why = useRef<'parsed' | 'no-parse' | 'dismissed' | 'chosen' | 'escaped'>('no-parse')

    /** Identifies one mention being typed, so a refresh can tell it from the next. */
    const queryKey = useRef<string | null>(null)
    /** The query Escape dismissed; it stays shut until you type a different one. */
    const dismissed = useRef<string | null>(null)

    /**
     * Re-reads the caret after any edit or cursor move.
     *
     * Runs on every keystroke *and* every selection change, so it has to be able
     * to tell "the same mention as a moment ago" from a new one — otherwise it
     * resets the highlight under an arrow key, and re-opens a menu that Escape
     * just closed. Both happened.
     */
    const refreshMention = useCallback(() => {
      const el = input.current
      if (el === null) return
      /*
       * Typing in the box is proof the box has the caret.
       *
       * This runs on change, on select and on keydown — all of which require the
       * box to be where input is going. So any of them is better evidence than a
       * focus event, and unlike a focus event it cannot fail to arrive.
       *
       * Without this the fix for C-003 broke the very menu it was fixing, in 2
       * of 5 full runs, with `mention: "/0:"`, `commands: "50"` and `rows: 0` —
       * everything present and the menu still shut. A window that blurs
       * spontaneously (this machine does, unprompted) sets `leftBox`, and while
       * it stays unfocused **no focus event ever comes to clear it**, so typing
       * set the mention and the menu stayed hidden behind a flag nothing could
       * reset. Before the fix, typing always reopened the menu because there was
       * no gate at all; that asymmetry is what this line removes.
       */
      setLeftBox(false)
      /*
       * A command first, because its rule is the narrow one.
       *
       * `/` only counts leading the message, so at most one of these can match
       * and the order is really about which question to ask first. A mention
       * can appear anywhere, including after a command's arguments.
       */
      const found =
        findCommandQuery(el.value, el.selectionStart) ??
        findMentionQuery(el.value, el.selectionStart)
      // The trigger is part of the identity: `/x` and `@x` at the same offset
      // are different menus, and Escape on one must not silence the other.
      const key = found === null ? null : `${found.trigger}${String(found.start)}:${found.query}`

      if (key !== queryKey.current) {
        queryKey.current = key
        setHighlighted(0)
      }
      if (key !== null && key === dismissed.current) {
        why.current = 'dismissed'
        setMention(null)
        return
      }
      dismissed.current = null
      why.current = found === null ? 'no-parse' : 'parsed'
      /*
       * One snapshot: the query, the text it came from, the revision that text
       * was, and the caret it was read at. Everything `choose` needs later, so
       * nothing has to be read again at click time and found to have moved.
       */
      setMention(
        found === null
          ? null
          : { query: found, from: el.value, rev: rev.current, caret: el.selectionStart }
      )
    }, [])

    /**
     * Types something into the box at the caret and hands the box back.
     *
     * Extracted when `@` became one button per agent: three buttons doing the
     * same four steps by hand is three places for the caret arithmetic to
     * disagree. `at + text.length` rather than `at + 1` is the whole reason it
     * could not stay inline — the old version only ever inserted one character.
     *
     * `refreshMention` afterwards because the character may *be* a trigger: `#`
     * opens the file picker exactly as typing it does, which is the point of the
     * button. A whole mention with a trailing space parses as no query, so the
     * agent buttons pass through it harmlessly rather than needing a second path.
     */
    const insertAtCaret = (text: string): void => {
      const box = input.current
      const at = box?.selectionStart ?? draft.length
      writeDraft(`${draft.slice(0, at)}${text}${draft.slice(at)}`)
      box?.focus()
      window.requestAnimationFrame(() => {
        box?.setSelectionRange(at + text.length, at + text.length)
        refreshMention()
      })
    }

    /*
     * And asked again the moment someone actually wants them.
     *
     * The retry above races the session's start against a clock, which is the
     * wrong shape: on a loaded machine the CLI can take longer than any window
     * worth waiting, and the menu is then empty for the life of the pane. This
     * removes the timing question instead of tuning it — a slash typed against
     * an empty list asks for one right then, because a person opening the menu
     * is the only signal that the answer matters yet.
     *
     * Guarded by `asking` so a fast typist does not queue one request per
     * keystroke, and only for `/`: the cast and the files have their own
     * sources.
     */
    /*
     * A boolean rather than the `mention` object, and that is the fix.
     *
     * `refreshMention` builds a new object on every keystroke *and* every
     * selection change, so an effect depending on `mention` restarts constantly
     * — which would reset the attempt count and defeat the rate limit. What this
     * question actually turns on is whether a slash menu is open at all; the
     * query it carries never changes the answer, because the list is the
     * conversation's rather than the query's.
     */
    const wantsCommands = active?.trigger === '/'
    useEffect(() => {
      if (!wantsCommands || commands.length > 0) return
      let live = true
      let attempts = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      setLookup('asking')
      const again = (): void => {
        // Widening, so eight attempts cover a CLI that is slow rather than only
        // one that is late. Never closer together than the floor.
        if (attempts >= ASK_CEILING) {
          setLookup('exhausted')
          return
        }
        timer = setTimeout(ask, attempts * ASK_FLOOR_MS)
      }
      const ask = (): void => {
        attempts += 1
        window.chorus
          .listCommands({ conversationId })
          .then((result) => {
            if (!live) return
            /*
             * An empty answer is asked about again rather than accepted, and
             * this is the ambiguity the plan takes on knowingly: the adapter
             * folds "no capability", "the request threw" and "this project has
             * no commands" into the same `[]`, so the renderer cannot tell them
             * apart. Both terminal cases short-circuit inside the adapter
             * without reaching a CLI, so asking again costs an IPC round trip
             * and nothing else — bounded by the ceiling above.
             */
            if (result.commands.length === 0) {
              again()
              return
            }
            setLookup(null)
            setCommands(result.commands)
          })
          .catch(() => {
            if (live) again()
          })
      }
      ask()
      return () => {
        live = false
        if (timer !== undefined) clearTimeout(timer)
      }
    }, [wantsCommands, commands.length, conversationId])

    /*
     * Agents first, then files.
     *
     * There are two agents and thousands of files, so ordering by count would
     * bury the thing `@` originally meant. Agents also match on a prefix and
     * files on a substring, which means a bare `@` shows the cast and typing
     * anything past a name starts finding files.
     */
    /*
     * Nobody is asking, so there is nothing to report.
     *
     * Each lookup sets its own state while it runs; this is what clears it when
     * the menu closes, so a `/` that gave up does not leave `exhausted` showing
     * under the `@` typed after it.
     */
    useEffect(() => {
      if (!wantsCommands && fileQuery === null) setLookup(null)
    }, [wantsCommands, fileQuery])

    const options =
      active === null
        ? []
        : active.trigger === '/'
          ? commandOptions(commands, active.query)
          : [...mentionOptions(participants as never, active.query), ...fileOptions(files)]
    /*
     * The menu opens for a state as well as for rows.
     *
     * `options.length > 0` alone is what made an unanswered question invisible:
     * there was nothing to draw, so nothing was drawn, so waiting looked exactly
     * like having nothing to offer. A menu carrying one status line says which of
     * the two it is — and gives a spec something to assert against other than a
     * timeout (C-003).
     *
     * Only when there are no rows. An `@` that already matches an agent is not
     * improved by a "looking…" line under it while git answers in thirty
     * milliseconds.
     */
    const menuOpen = menuVisible(!leftBox, options.length, active, lookup)

    /** The composer's own box, which is what the portalled menu is placed from. */
    const anchor = useRef<HTMLFormElement | null>(null)
    /**
     * Where the menu sits in viewport coordinates, or null until it is measured.
     *
     * **The menu has to leave the pane, because `.dock` scrolls.** It carries
     * `overflow-y: auto` so a tall approval card's buttons stay reachable, and a
     * scroll container clips whatever overflows it. At rest the dock is only as
     * tall as the composer, so a bare `@` — a 35.5px menu drawn above the box —
     * had 5px of itself inside the clip and the rest cut off. It was in the DOM
     * the whole time, which is why the spec asserting on `querySelector` passed
     * a screenshot that plainly showed the bug. Relaxing the dock's overflow
     * would trade this for the unreachable-buttons one it was added to fix.
     *
     * `bottom` rather than `top`, so the list grows upward from the composer
     * without anything having to measure how tall it is — the same behaviour the
     * `bottom: calc(100% + …)` rule had, minus the clip.
     */
    const [menuAt, setMenuAt] = useState<{
      left: number
      width: number
      bottom: number
    } | null>(null)

    useLayoutEffect(() => {
      if (!menuOpen) {
        setMenuAt(null)
        return
      }
      const place = (): void => {
        const el = anchor.current
        if (el === null) return
        const box = el.getBoundingClientRect()
        // 6px is `calc(var(--step) * 2)`, the gap the absolute rule carried.
        const next = { left: box.left, width: box.width, bottom: window.innerHeight - box.top + 6 }
        // A scroll asks on every event; only an actual move is worth a render.
        setMenuAt((current) =>
          current !== null &&
          current.left === next.left &&
          current.width === next.width &&
          current.bottom === next.bottom
            ? current
            : next
        )
      }
      place()
      /*
       * Three things move the composer under an open menu, and leaving any of
       * them out strands the popup where the box used to be: the window
       * resizing, an ancestor scrolling — the dock, once an approval card is up
       * — and the composer growing under its own content, an attachment landing
       * or the textarea taking another line.
       *
       * `scroll` does not bubble, so it is heard in the capture phase or not at
       * all.
       */
      window.addEventListener('resize', place)
      document.addEventListener('scroll', place, true)
      const watch = new ResizeObserver(place)
      if (anchor.current !== null) watch.observe(anchor.current)
      return () => {
        window.removeEventListener('resize', place)
        document.removeEventListener('scroll', place, true)
        watch.disconnect()
      }
    }, [menuOpen])

    const choose = useCallback(
      (index: number) => {
        const el = input.current
        const option = options[index]
        if (el === null || liveStamp === null || option === undefined) return
        /*
         * **Every argument from the one validated snapshot.**
         *
         * This read `el.value` and `el.selectionStart` live, pairing them with a
         * stamped query — three sources, and the caret in particular can have
         * moved since the query was parsed. `findMentionQuery` derives the query
         * from `text.slice(0, caret)`, so a caret that has moved makes the
         * replaced region stop matching the rows on screen, and the option lands
         * over text nobody was offering to replace.
         *
         * `liveStamp` being non-null already means `draft` is exactly the text
         * the query was read from, at the revision it was read at. So the draft
         * and the stamped caret are the consistent pair, and the DOM is not
         * consulted at all.
         */
        const next = applyMention(draft, liveStamp.query, liveStamp.caret, option)
        writeDraft(next.text)
        why.current = 'chosen'
        setMention(null)
        // After React has written the new value, or the caret lands wherever the
        // browser last left it.
        requestAnimationFrame(() => {
          el.focus()
          el.setSelectionRange(next.caret, next.caret)
        })
      },
      [draft, liveStamp, options]
    )

    /**
     * Files become paths in the draft, not attachments.
     *
     * An agent reads a file the same way you would, so a drop needs no upload and
     * no change to what a message is. A clipboard image has no path — only bytes —
     * so those are written down first and the path is what you get.
     */
    const attach = useCallback(async (dropped: readonly File[]): Promise<void> => {
      const files = [...dropped]
      if (files.length === 0) return

      const paths = await Promise.all(
        files.map(async (file) => {
          const path = window.chorus.pathForFile(file)
          if (path !== '') return path
          // Pasted rather than dragged: it exists nowhere until we put it somewhere.
          const bytes = new Uint8Array(await file.arrayBuffer())
          let binary = ''
          for (const byte of bytes) binary += String.fromCharCode(byte)
          const stashed = await window.chorus.stashFile({
            name: file.name === '' ? 'pasted' : file.name,
            base64: btoa(binary),
          })
          return stashed.path
        })
      )

      await addPaths(paths)
    }, [])

    /**
     * Paths become attachments, whatever produced them.
     *
     * A drop and a paste arrive as `File`s; a folder arrives as a path from a
     * native dialog and has no `File` at all. Both end here, so an attachment
     * means the same thing however it was added.
     */
    const addPaths = useCallback(async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0) return
      const previews = await Promise.all(
        paths.map(async (path) => ({ path, ...(await window.chorus.previewFile({ path })) }))
      )
      setAttached((current) => [
        ...current,
        ...previews.filter((p) => !current.some((c) => c.path === p.path)),
      ])
      input.current?.focus()
    }, [])

    /*
     * What the `+` offers.
     *
     * `Current selection` appears only when there is one — a disabled row
     * promising context that does not exist is worse than no row — and it is
     * inert when the selection is already going, so the menu reports the state
     * as well as setting it.
     */
    const addItems: MenuItem[] = [
      {
        key: 'file',
        label: t('conversation.addFile'),
        onChoose: () => {
          picker.current?.click()
        },
      },
      {
        key: 'folder',
        label: t('conversation.addFolder'),
        onChoose: () => {
          void window.chorus.chooseDirectory().then((chosen) => {
            // A dialog that changes nothing when cancelled, and a path when not:
            // this one never touches the project directory, unlike the chooser
            // in the session menu that shares its look.
            if (chosen.path !== null) void addPaths([chosen.path])
          })
        },
      },
    ]

    /*
     * Always, whenever there is something to send.
     *
     * This was `&& ideIncluded`. **Dropping the switch drops a disclosure
     * control**, and that is worth writing down rather than discovering: the
     * pill said which file was going and the chip said which editor it came
     * from, and neither exists now. What is sent is a path and a line range from
     * whatever is focused in the workbench — it is the person's own editor, in
     * their own window — so the trade is deliberate, not an oversight.
     */
    const ideAttached = props.ide !== null && props.ide.status === 'ready'
    /* `12` for a single line, `12-18` for a range — a `12-12` reads as a mistake. */
    const lineLabel = (file: { startLine: number; endLine: number }): string =>
      file.startLine === file.endLine
        ? String(file.startLine)
        : `${String(file.startLine)}-${String(file.endLine)}`
    const { onError, onSending, onSendFailed } = props

    const send = useCallback(() => {
      /*
       * The paths join the message on the way out, not while you are writing it.
       *
       * The agent still receives text with paths in it — that has not changed —
       * but a draft is no longer a place where a screenshot looks like forty
       * characters of noise.
       */
      const paths = attached.map((item) => quotePath(item.path)).join(' ')
      const text = [draft.trim(), paths].filter((part) => part !== '').join(' ')
      if (text === '') return

      /*
       * The editor context is captured now, not when the pill was drawn.
       *
       * The pill can be a few hundred milliseconds old — it is debounced — and
       * the user may have moved the selection since. Sending what the pill said
       * would attach the wrong lines to the question, which is worse than
       * attaching none.
       */
      const compose = async (): Promise<string> => {
        if (!ideAttached) return text
        const snapshot = await window.chorus.ideSnapshot({ conversationId })
        if (snapshot.outcome !== 'ok') {
          // The draft is never lost to this. The user is told what happened and
          // decides whether to retry or send without the context.
          throw new Error(
            snapshot.outcome === 'tooLarge'
              ? t('ide.error.tooLarge')
              : t('ide.error.unavailable', { reason: t(`ide.status.${snapshot.reason}`) })
          )
        }
        // The version, if these lines are not the working tree's. Without it an
        // agent opens the path and answers about content that has moved.
        const version = versionFor(snapshot.provenance, snapshot.relativePath)
        const block = formatContextBlock(
          { ...snapshot },
          {
            /*
             * "VS Code context" is a lie about the embedded editor, and the
             * agent repeats it back — the reported message opened with "VS Code
             * context:" for a file open in Chorus's own workbench.
             */
            heading: t(snapshot.editor === 'workbench' ? 'ide.headingWorkbench' : 'ide.heading'),
            unsaved: t('ide.unsaved'),
            version: version === null ? '' : t(version.key, version.params),
          }
        )
        return withEditorContext(text, block)
      }

      // You just spoke; you want to see the answer.
      onSending()
      compose()
        .then(async (body) => {
          // Cleared only once the context is in hand, so a failed snapshot leaves
          // the draft and its attachments exactly as they were.
          writeDraft('')
          setAttached([])
          await window.chorus.sendMessage({ conversationId, text: body })
        })
        .catch((error: unknown) => {
          // Nothing is coming: the message never left, so the row would be
          // waiting for a turn that will not start.
          onSendFailed()
          onError(error)
        })
    }, [conversationId, draft, attached, ideAttached, t, onError, onSending, onSendFailed])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => input.current?.focus(),
        quote: (passage: string) => {
          writeDraft((current) => withQuote(current, passage))
          input.current?.focus()
        },
        insert: (text: string) => {
          writeDraft((current) =>
            current.trim() === '' ? text : `${current.replace(/\s+$/, '')}\n\n${text}`
          )
          input.current?.focus()
        },
        attach,
      }),
      [attach]
    )

    return (
      <form
        ref={anchor}
        className="composer"
        /*
         * What the composer believes, where a failing run can read it.
         *
         * The menu's own status row says whether a lookup is running, and on the
         * first real failure after that shipped it said `no status row` —
         * nothing in flight, nothing given up. Which is genuinely useful and
         * also the end of what the menu can tell anyone: if nobody was waiting,
         * the question is what the *composer* thought was being typed, and that
         * lives in state no spec can reach (C-003).
         *
         * Two attributes rather than a debug channel, because the alternative is
         * the shape that already failed here: instrumentation added during an
         * investigation, removed when it ended, and absent the next time the bug
         * appears. These cost two strings per render and are the difference
         * between a named cause and another afternoon.
         */
        /*
         * **The raw mention, not the live one, and that distinction is C-003's
         * second afternoon.**
         *
         * This briefly reported `active`, which is null both when nothing was
         * parsed *and* when a mention exists whose stamp no longer matches the
         * draft. Two completely different defects printed the same `none`, and
         * two failing runs could not be told apart because of it. The whole
         * value of this attribute is that one string means one thing.
         */
        data-mention={
          mention === null
            ? 'none'
            : `${mention.query.trigger}${String(mention.query.start)}:${mention.query.query}`
        }
        /*
         * Whether the stamp still describes the box, and `leftBox` beside it,
         * because those are the other two ways the menu goes away without the
         * mention being touched.
         *
         * Lengths rather than the text: `data-draft-len` already exists because
         * duplicating what someone is typing into a second place is not
         * something this file does, and a stamp is a copy of the draft. A
         * mismatch in length or in `live` names the branch without keeping a
         * word of it.
         */
        data-mention-live={mention === null ? 'none' : active === null ? 'stale' : 'live'}
        data-mention-why={why.current}
        data-stamp-len={mention === null ? -1 : mention.from.length}
        data-stamp-rev={mention === null ? -1 : mention.rev}
        data-draft-rev={rev.current}
        data-left-box={leftBox}
        data-commands={commands.length}
        /*
         * The two that separate the last pair of candidates.
         *
         * A real failure was caught with `value: "/"`, `caret: 1`,
         * `focused: true`, `commands: 50` — and `mention: none`. Since
         * `refreshMention` runs synchronously in `onChange`, and
         * `findCommandQuery('/', 1)` cannot return null, exactly two things can
         * produce that:
         *
         * - **`onChange` never fired**, so nothing re-read the box. Then React's
         *   `draft` is still the previous text and its length gives it away —
         *   the spec types `look at src/foo` first, so 15 rather than 1.
         * - **`dismissed` held `/0:`**, which is the one branch that nulls a
         *   mention that was found. Nothing in the spec presses Escape, so this
         *   would be a defect in how it is set or cleared.
         *
         * The length rather than the draft: the textarea already carries the
         * text, and duplicating it into an attribute would put what someone is
         * typing in a second place for no gain.
         */
        data-draft-len={draft.length}
        data-dismissed={dismissed.current ?? 'none'}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        {/*
         * The context row: what will be sent with the message, and the two ways
         * to add to it.
         *
         * It was the pill alone, floating above the box on a line of its own —
         * so the composer was a path and a field, and everything a person does
         * before pressing Send had no home. The row is the home: the selection
         * on the left, the ways to add on the right.
         */}
        <div className="composer-context">
          {/*
            What will ride along with the message — restored, with a new reason.
            
            The pill was deleted in Phase 9 as "a read-only pill restating what
            is already on screen two inches to the left". That was true when a
            coordinate was all that travelled. It is not true now: the embedded
            editor sends the selected **text**, so this names what leaves the
            machine rather than what is visible on it — and the editor can be
            switched off in this pane, in which case nothing is visible at all.
            
            Deliberately not a switch. The Included chip is still gone and
            context is still always sent; this reports, and reporting is the
            thing that was lost.
          */}
          {ideAttached && props.ide.file !== null && (
            <span
              className="composer-ide-pill"
              title={t('ide.attachedTitle', {
                path: props.ide.file.relativePath,
                lines: lineLabel(props.ide.file),
              })}
            >
              <span className="path">{props.ide.file.relativePath}</span>
              <span className="composer-ide-lines">:{lineLabel(props.ide.file)}</span>
            </span>
          )}

          {/*
           * The way to add a file that is not the one open in the editor.
           *
           * A real picker behind a real button: dropping and pasting have always
           * worked and neither is discoverable, so the affordance the approved
           * composition shows is the one thing that says attaching is possible.
           * The input is the control; the button is its label, because a bare
           * `<input type="file">` cannot be styled and its own text is the
           * browser's.
           */}
          <input
            ref={picker}
            className="sr-only"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const chosen = [...(event.target.files ?? [])]
              // Cleared so choosing the same file twice still fires a change.
              event.target.value = ''
              void attach(chosen)
            }}
          />
          <button
            type="button"
            className="composer-add"
            aria-label={t('conversation.attach')}
            title={t('conversation.attach')}
            onClick={() => {
              picker.current?.click()
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" />
            </svg>
          </button>
          {/*
            Everything else that can be added, behind one button.

            The paperclip stays the one-click file picker it has always been;
            this is the menu for the things that have no `<input type="file">` —
            a folder, which only a native dialog can choose, and the editor's
            selection, which is context rather than a file at all.
          */}
          <button
            type="button"
            className="composer-more"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'add'}
            aria-label={t('conversation.addContext')}
            title={t('conversation.addContext')}
            onClick={(event) => {
              openMenuFrom('add', event)
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        {menuOpen &&
          /*
           * Portalled, and the reason is the dock's clip — see `menuAt` above.
           * Everything else about the menu stays here: the keys, the highlight,
           * `aria-controls` (which resolves by id, wherever the list lives) and
           * `onMouseDown`, which still reaches this component because React
           * routes portal events through the React tree rather than the DOM one.
           */
          createPortal(
            <ul
              className="mention-menu"
              id={`mentions-${conversationId}`}
              role="listbox"
              /* Hidden for the one commit it takes to measure. A layout effect
                 places it before the browser paints, so this should never be
                 seen — it is here so that a frame lost to something else shows
                 nothing rather than a menu at the viewport's top-left. */
              style={
                menuAt === null
                  ? { visibility: 'hidden' }
                  : { left: menuAt.left, width: menuAt.width, bottom: menuAt.bottom }
              }
            >
              {options.map((option, i) => (
                <li key={option.label}>
                  <button
                    type="button"
                    className="mention-option"
                    role="option"
                    aria-selected={i === highlighted}
                    data-on={i === highlighted}
                    // Pointer down, not click: the textarea blurs on click and
                    // the menu would be gone before the choice registered.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(i)
                    }}
                    onMouseEnter={() => {
                      setHighlighted(i)
                    }}
                  >
                    <span className="mention-dots" aria-hidden="true">
                      {option.agents.map((agent) => (
                        <span key={agent} className={`voice-dot voice--${agent}`} />
                      ))}
                    </span>
                    <span className="mention-name">
                      {/* A bare option inserts no trigger, so it must not show
                        one: a file row reading "@src/a.ts" would promise a
                        mention it does not write. */}
                      {option.bare === true ? '' : (active?.trigger ?? '@')}
                      {option.label}
                    </span>
                    <span className="mention-detail">{option.detail}</span>
                  </button>
                </li>
              ))}
              {options.length === 0 && lookup !== null && (
                /*
                 * `data-lookup` is not decoration. A spec asserting on the visible
                 * words would be asserting on a translation, and the point of this
                 * row is that a run can say *which* state it ended in rather than
                 * timing out with nothing to report.
                 */
                <li className="mention-status" data-lookup={lookup} aria-live="polite">
                  {lookup === 'asking' && t('conversation.lookingUp')}
                  {lookup === 'exhausted' && t('conversation.noneFound')}
                  {lookup === 'unavailable' && t('conversation.lookupUnavailable')}
                </li>
              )}
            </ul>,
            document.body
          )}
        {menu !== null && (
          <ComposerMenu
            anchor={menu.anchor}
            trigger={menu.trigger}
            label={t('conversation.addContext')}
            items={addItems}
            onClose={() => {
              setMenu(null)
            }}
          />
        )}
        <Attachments
          items={attached}
          onRemove={(path) => {
            setAttached((current) => current.filter((item) => item.path !== path))
          }}
        />
        {/*
        The box and the one control that acts on it, side by side.

        Send sat under the field while the row beneath still held six other
        controls; with those gone it was a button alone on a line of its
        own. Aligned to the bottom rather than the middle, because the field
        grows with what is typed into it and the button should stay where
        the last line is.
      */}
        <div className="composer-line">
          <textarea
            ref={input}
            value={draft}
            rows={1}
            aria-label={t('conversation.messageLabel')}
            /*
             * Named, when there is somebody to name.
             *
             * The composition reads `Ask Codex or Claude…`, which is the cast
             * rather than a slogan — so it is interpolated from who is actually
             * seated. Hardcoding the golden's words would say "or Claude" to a
             * room Claude had left.
             */
            placeholder={
              participants.length === 0
                ? t('conversation.nobodyHere')
                : participants.length === 1
                  ? t('conversation.placeholderOne', {
                      agent: t(`actor.${participants[0] ?? ''}`),
                    })
                  : participants.length === 2
                    ? t('conversation.placeholderTwo', {
                        first: t(`actor.${participants[0] ?? ''}`),
                        second: t(`actor.${participants[1] ?? ''}`),
                      })
                    : t('conversation.placeholder')
            }
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={`mentions-${conversationId}`}
            aria-autocomplete="list"
            onChange={(e) => {
              writeDraft(e.target.value)
              refreshMention()
            }}
            onSelect={refreshMention}
            onPaste={(e) => {
              // Text pastes as text; anything else becomes a path.
              if (e.clipboardData.files.length === 0) return
              e.preventDefault()
              void attach([...e.clipboardData.files])
            }}
            /*
             * These two say only where the caret is, and that is the fix for
             * C-003.
             *
             * `onBlur` used to call `setMention(null)`. Closing the menu on blur
             * is right — it floats over the transcript and should not outlive
             * the box being left — but expressing that by discarding *what is
             * being typed* meant nothing could bring it back: `refreshMention`
             * runs on change, select and keydown, and focus returning is none of
             * those. The box kept its `/` and the menu stayed shut until another
             * character was typed.
             *
             * `onFocus={refreshMention}` was the obvious repair and it measured
             * **worse than doing nothing** — 2 of 5 menu specs against 5 of 5 —
             * because a focus event can fire with the caret still at 0, and
             * `findCommandQuery` reads `text.slice(0, caret)`. Nothing here
             * reads the caret, so there is no such race to lose: the mention was
             * never discarded, so it does not need re-deriving.
             *
             * What keeps it honest across the gap is the stamp on `mention` —
             * if anything rewrote the draft while the box was away, `liveMention`
             * returns null and the menu stays shut.
             */
            onFocus={() => {
              setLeftBox(false)
            }}
            onBlur={() => {
              /*
               * **A window losing focus is not the box being left**, and telling
               * the two apart is what finally made this correct.
               *
               * The menu should not outlive you clicking somewhere else in the
               * app — that is what this handler is for. But alt-tabbing to
               * another application is not leaving the box: the caret is still
               * in it, and still in it when you come back. Treating the two the
               * same is what made the first two attempts at this fix worse than
               * no fix at all — the slash menu failed 2 of 5 full runs, then 1
               * of 10 alone, every time with `mention: "/0:"`, `commands: "50"`
               * and `rows: 0`, because this machine blurs its windows
               * spontaneously and the menu went with them.
               *
               * `document.hasFocus()` is exactly the distinction: false here
               * means the whole window went away, so there is nothing to close.
               */
              if (!document.hasFocus()) return
              setLeftBox(true)
            }}
            onKeyDown={(e) => {
              /*
               * The menu takes the keys it needs first — Enter in particular.
               * Sending the message when the user meant to pick a name is the
               * failure this whole feature exists to prevent.
               */
              /*
               * Visible *and* holding rows — see `menuTakesKeys` for why neither
               * half may be dropped. It was rows alone until C-003's fix made
               * visibility and rows able to disagree, at which point an
               * off-screen menu could still swallow an arrow key.
               */
              if (menuTakesKeys(menuOpen, options.length)) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const step = e.key === 'ArrowDown' ? 1 : options.length - 1
                  setHighlighted((current) => (current + step) % options.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  choose(highlighted)
                  return
                }
              }
              /*
               * Escape closes whatever is open, rows or not.
               *
               * Deliberately outside the block above: a menu saying "looking…"
               * is still a menu in your way, and one you could not dismiss would
               * be worse than the silence it replaced.
               */
              if (menuOpen && e.key === 'Escape') {
                e.preventDefault()
                dismissed.current = queryKey.current
                why.current = 'escaped'
                setMention(null)
                return
              }
              /*
               * Up brings back what was said, but only from an empty box.
               *
               * In a draft being written the arrows have to keep moving the caret;
               * a field that jumps to last week's message because the caret
               * reached line one is worse than no recall at all. Down walks back
               * towards the empty box and stops there.
               */
              if (
                (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
                props.history.length > 0 &&
                (draft === '' || recalled.current > 0)
              ) {
                const step = e.key === 'ArrowUp' ? 1 : -1
                const next = Math.min(Math.max(recalled.current + step, 0), props.history.length)
                if (next === recalled.current) return
                e.preventDefault()
                recalled.current = next
                writeDraft(next === 0 ? '' : (props.history[props.history.length - next] ?? ''))
                return
              }

              if (e.key !== 'Enter') return
              // Mid-composition Enter commits the candidate — for Japanese,
              // Chinese or Korean input that keypress belongs to the IME, not
              // to us, and sending there would swallow the word being typed.
              if (e.nativeEvent.isComposing) return
              // Shift holds the line; every other Enter sends. Cmd and Ctrl keep
              // working because that is what they did before.
              if (e.shiftKey) return
              e.preventDefault()
              send()
            }}
          />
          {/*
          Everything about the session sits in the composer's own row.

          A separate strip above the transcript put who is here, where they
          are and what they may do at the top of the pane, while the thing you
          act with was at the bottom — so changing permissions meant crossing
          the whole transcript. Here it is all one place, and the keyboard hint
          that used to live in this row is gone: ↵ sends is the convention, and
          saying so forever is a label for the first minute.
        */}
          <div className="composer-tools">
            {/*
              The cast, as one button each, and `#` as the character it inserts.
              
              `@` was a single button that typed the character and let the mention
              menu offer the choice. Two agents is a list of two, and a menu for a
              two-item list is a click and a read to save typing six letters — so
              the choice moved onto the row and each button inserts the whole
              mention. `#` stays a character button, because the thing it opens is
              a file picker over a list nobody can enumerate in a toolbar.
              
              **Only the conversation's own participants.** Mentioning an agent
              that is not in the room addresses nobody, and the cast is a project
              setting reachable from the project card — offering `@codex` where
              codex was deliberately removed would be offering to talk to an empty
              chair.
            */}
            {/*
             * The editor switch, on the same row as the cast.
             *
             * It sat above, on the context row, which is where the pill and the
             * Included chip used to live — so it inherited a position chosen for
             * two controls that no longer exist. Beside `@claude` and `@codex` it
             * is among the other things you press while composing, which is what
             * it now is: a control over the editor, not a report about a file.
             *
             * Two controls stood here and both are gone. The **pill** named the
             * file and lines that would ride along with the message; the
             * **Included chip** was the switch that decided whether they did. The
             * switch went first — an editor open beside a conversation is context,
             * and asking every time was a question with one sensible answer — and
             * with nothing to decide, a read-only pill restating what is already
             * on screen two inches to the left earned nothing.
             *
             * What replaces them is a control over the *editor* rather than over
             * the message: it shows and hides the workbench in this pane. The
             * label and icon are unchanged from the provenance chip it grew out
             * of, so it stays recognisable even though it has moved.
             *
             * **Always rendered**, including when no file is open and when the
             * bridge is unavailable. It is a layout control now, not a report
             * about a selection, and a switch that vanishes when there is nothing
             * selected is a switch you cannot find when you want the editor back.
             */}
            <button
              type="button"
              className="ide-source"
              aria-pressed={props.workbenchShown}
              title={props.workbenchShown ? t('ide.hideEditor') : t('ide.showEditor')}
              onClick={props.onToggleWorkbench}
            >
              <svg className="ide-source-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M17 3.5 9.5 11 5 7.5 3 9l4 3-4 3 2 1.5L9.5 13l7.5 7.5 4-2v-13l-4-2Zm0 4.2v8.6L12 12l5-4.3Z" />
              </svg>
              {t('ide.editorWorkbench')}
            </button>
            {participants.map((agent) => (
              <button
                key={agent}
                type="button"
                className={`composer-trigger composer-mention voice--${agent}`}
                aria-label={t('conversation.mentionAgent', { agent })}
                title={t('conversation.mentionAgent', { agent })}
                onClick={() => {
                  insertAtCaret(`@${agent} `)
                }}
              >
                <span className="voice-dot" aria-hidden="true" />
                {/* The `@` is part of the label, not decoration: the button
                    inserts a mention, and showing what it types is what makes
                    that legible without a tooltip. */}
                <span aria-hidden="true">@{agent}</span>
              </button>
            ))}
            {/*
              What this session may do, from where the message is written.

              Opens the shell's own session menu on its settings — the cast, the
              folder, the permission profile, plan mode. Not a second menu that
              does the same job: the one that exists is the one that opens.
            */}
            {/*
            One button, and what it does is decided by what you have typed.

            Sending mid-turn steers rather than restarts — the message reaches
            the running turn and the agent takes it in, verified against a
            real one — so Send and Stop are not the opposed pair they look
            like. Which leaves a rule simple enough to need no label: if there
            is something in the box the button sends it, and if there is not,
            the only thing left to want is to stop what is running.

            That also settles what the pair got wrong in both directions. One
            button that *became* Stop hid the way to steer and abandoned the
            turn when pressed; two buttons side by side asked which is which
            every time. Glyphs rather than words, because a label would crowd
            the text being written; the names live on `aria-label`.
          */}
            {props.busy && !hasDraft ? (
              <button
                type="button"
                className="send send--stop"
                aria-label={t('conversation.stopAll', { agents: props.working.join(', ') })}
                title={t('conversation.stopAll', { agents: props.working.join(', ') })}
                onClick={() => {
                  window.chorus.interrupt({ conversationId }).catch(onError)
                }}
              >
                <span className="send-square" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                className="send"
                /*
                 * Marked while a turn runs, because the two states did the same
                 * thing and looked identical.
                 *
                 * Sending mid-turn steers — the agent keeps working and takes
                 * the message in — and that stays, deliberately; `specs.mjs`
                 * pins it. What was wrong is that the button then read exactly
                 * like the idle one, so a reply still arriving looked finished.
                 * Reported as "the send button becomes ready while the response
                 * is still coming", alongside a `busy` that was false for every
                 * turn after the first and made it literally true.
                 */
                data-steering={props.busy ? 'true' : undefined}
                aria-label={props.busy ? t('conversation.steer') : t('conversation.send')}
                /* Titled in both states. It carried one only while an agent was
                   working, so the app's primary action was the one button with
                   nothing to say for itself on hover. */
                title={props.busy ? t('conversation.steer') : t('conversation.send')}
                disabled={!hasDraft || participants.length === 0}
              >
                <span aria-hidden="true">↑</span>
              </button>
            )}
          </div>
        </div>
      </form>
    )
  }
)
