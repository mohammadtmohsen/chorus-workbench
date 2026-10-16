import type { StoredEvent } from '@chorus/event-store'
import type { AgentId } from '@chorus/shared'

const MAX_COMMAND_CHARS = 160
const MAX_OUTPUT_CHARS = 400

export const TRIM_MARKER = '\n… [trimmed] …\n'
export const CONTEXT_DEFERRED_PREFIX = '[Chorus] History deferred.\n'

export interface TranscriptLine {
  readonly seq: number
  readonly eventId: string
  readonly conversationId: string
  readonly kind: 'speech' | 'activity'
  readonly discussion: boolean
  readonly fromUser: boolean
  readonly text: string
}

/** Tracks a command from `started` to `completed`, which is where it renders. */
interface RunningCommand {
  readonly seq: number
  readonly eventId: string
  readonly conversationId: string
  readonly actor: string
  readonly command: string
  output: string
}

export function collectLines(
  events: readonly StoredEvent[],
  recipient: AgentId | null,
  includeOwnDiscussion = false
): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  const running = new Map<string, RunningCommand>()

  for (const event of events) {
    const payload = event.payload
    if (
      recipient !== null &&
      event.actor === recipient &&
      !(
        includeOwnDiscussion &&
        payload.type === 'agent.message.completed' &&
        payload.mode === 'discussion'
      )
    )
      continue
    const who = event.actor
    const at = { seq: event.seq, eventId: event.id, conversationId: event.conversationId }
    const speech = (text: string, discussion = false): TranscriptLine => ({
      ...at,
      kind: 'speech',
      discussion,
      fromUser: who === 'user',
      text,
    })
    const activity = (text: string): TranscriptLine => ({
      ...at,
      kind: 'activity',
      discussion: false,
      fromUser: false,
      text,
    })

    switch (payload.type) {
      case 'user.message':
        lines.push(
          payload.mode === 'discussion'
            ? speech(
                `user (read-only discussion, not an implementation instruction): ${payload.text.trim()}`,
                true
              )
            : speech(`user: ${payload.text.trim()}`)
        )
        break

      case 'agent.message.completed':
        if (who !== 'system') {
          lines.push(
            payload.mode === 'discussion'
              ? speech(`${who} (read-only discussion): ${payload.text.trim()}`, true)
              : speech(`${who}: ${payload.text.trim()}`)
          )
        }
        break

      case 'command.started':
        running.set(payload.itemRef, {
          ...at,
          actor: who,
          command: trimMiddle(payload.command.join(' '), MAX_COMMAND_CHARS),
          output: '',
        })
        break

      case 'command.output': {
        const found = running.get(payload.itemRef)
        // Only the tail is kept: a build log's interesting part is the end, and
        // holding the whole thing to throw it away is pointless.
        if (found !== undefined) {
          const output = found.output + payload.chunk
          found.output = sliceText(output, output.length - MAX_OUTPUT_CHARS)
        }
        break
      }

      case 'command.completed': {
        const found = running.get(payload.itemRef)
        if (found === undefined) break
        running.delete(payload.itemRef)
        lines.push(activity(renderCommand(found, payload.exitCode)))
        break
      }

      /*
       * A proposal is not a change.
       *
       * This case used to be the one that reported files, and it fires when the
       * operation *starts* — so a patch the user declined, or one that failed to
       * apply, was replayed to the other agent as a file that had changed.
       * `file.change.completed` carries the outcome, and it is what gets told.
       */
      case 'file.change.proposed':
        break

      case 'file.change.completed':
        // Only what landed. A declined patch is a file the other agent will find
        // exactly as it left it, and saying otherwise sends it looking for work
        // that was never done.
        if (payload.outcome === 'applied') {
          lines.push(
            activity(`· ${who} changed ${describeFiles(payload.files.map((f) => f.path))}`)
          )
        }
        break

      /*
       * The whole reason `file.edited.byUser` is a log event rather than a
       * push.
       *
       * An agent that read this file at the start of a turn is composing a
       * patch against a version that no longer exists. Without this line it
       * overwrites the person's fix and neither party learns why — and the
       * agent cannot discover it, because nothing else in the transcript says
       * a file moved under it.
       *
       * **Speech, not activity.** Activity is dropped first when the budget
       * binds, and "the file you are editing is not the file you read" is not
       * supporting detail — it changes what the agent should do next. This is
       * the only non-agent activity promoted to speech, and that is the
       * argument for it.
       */
      case 'file.edited.byUser':
        lines.push(
          speech(
            `user: I edited ${payload.path} myself (+${String(payload.added)} −${String(payload.removed)}). Re-read it before changing it.`
          )
        )
        break

      /*
       * Source control the person drove themselves.
       *
       * **`discarded` is the one that matters**, and it is why this is speech
       * rather than activity: an agent that just wrote those files is holding a
       * picture of a tree that no longer exists, and would otherwise go looking
       * for its own work and find the file as it was before it started.
       *
       * `staged` and `unstaged` are dropped. They move nothing on disk, an
       * agent has no use for the index, and replaying every click of a
       * checkbox would spend the catch-up budget on bookkeeping — which is
       * exactly what the budget rule exists to prevent.
       */
      case 'repo.changed.byUser': {
        if (payload.action === 'staged' || payload.action === 'unstaged') break
        const what =
          payload.action === 'discarded'
            ? `discarded my changes to ${describeFiles(payload.paths)} — anything you wrote there is gone, re-read before continuing`
            : payload.action === 'committed'
              ? `committed${payload.detail === null ? '' : `: ${trimMiddle(payload.detail, 120)}`}`
              : `pushed${payload.detail === null ? '' : ` ${payload.detail}`}`
        lines.push(speech(`user: I ${what}`))
        break
      }

      /*
       * Worth replaying: an agent asked to do something now works under rules
       * that changed while it was not being addressed, and "you may run
       * commands without asking" is a fact about the room, not about one turn.
       */
      /*
       * Where the project is counts as a fact about the room. An agent asked to
       * "check the tests" needs to know the answer moved.
       */
      case 'project.changed':
        lines.push(activity(`· the user set the project directory to ${payload.cwd}`))
        break

      /*
       * An approval the agent itself abandoned. It is Chorus bookkeeping about a
       * card, and the other agent has nothing to do differently for it — the
       * work it described never happened and was never reported as happening.
       */
      case 'approval.withdrawn':
        break

      /* A name the user chose for the room is theirs, not context for a turn. */
      case 'conversation.renamed':
        break

      /*
       * Whose room this is does not change what the other agent needs to know.
       *
       * Promotion changes how Chorus files a conversation, not what was said in
       * it — the transcript either side of it is unchanged, and an agent told
       * "this used to be an aside" could act on none of it.
       */
      case 'aside.promoted':
        break

      case 'policy.changed':
        lines.push(activity(`· the user changed permissions to "${payload.profileId}"`))
        break

      case 'error.raised':
        // A restart notice is recoverable and is noise to everyone else; a
        // failure that stuck is why the other agent went quiet.
        if (!payload.recoverable) {
          lines.push(activity(`· ${who} hit an error: ${trimMiddle(payload.message, 300)}`))
        }
        break

      /*
       * Listed rather than defaulted, so a new event type has to be considered
       * here instead of silently vanishing from the shared conversation.
       *
       * Deltas are superseded by the completed message. Reasoning is the agent's
       * private working, and it is enormous. `diff.updated` is the cumulative
       * diff, already covered one change at a time. The rest is Chorus's own
       * bookkeeping, or — for a handoff — context the recipient was handed in
       * full at the time.
       *
       * `notice.raised` is Chorus telling the *user* what the harness did — a
       * hook that ran, a retry, a rule that denied a tool. The other agent runs
       * under its own harness, so replaying ours would spend a strictly
       * budgeted catch-up on something it cannot act on. What a denial *caused*
       * still reaches it: the command that never ran is simply absent, and a
       * turn that gave up says so through `error.raised`.
       *
       * `tool.*` is left out for the reason the adapter gives for not reporting
       * non-Bash results in full: every other tool's result is the agent's own
       * working, and the agent narrates what it found. Twenty file reads would
       * spend the budget on the search rather than on what it turned up.
       * Commands stay in because a shell command changes the machine.
       */
      case 'reply.status':
        // Request progress belongs to the UI, not another agent's task context.
        break

      case 'handoff.outcome':
        // The recipient learns of a handoff by receiving it, and whether it was
        // submitted is the room's bookkeeping rather than anything to act on.
        break

      case 'assignment.bound':
        // Which task the user said is the forwarded work is for the original to
        // read through its own tool, not something an agent here acts on.
        break

      case 'task.opened':
      case 'task.revised':
      case 'task.closed':
        // Step lists and clocks are bookkeeping for the status strip. An agent's
        // plan reaches the other agent in that agent's own words, which is the
        // version it can act on.
        break

      case 'usage.blocked':
        // Another agent's account limit is not a limit on the recipient, and the
        // failed turn already reaches it through `error.raised`.
        break

      case 'conversation.created':
      case 'session.started':
      case 'session.ended':
      case 'turn.started':
      case 'turn.completed':
      case 'agent.message.delta':
      case 'agent.reasoning.delta':
      case 'diff.updated':
      case 'approval.requested':
      case 'approval.decided':
      case 'userinput.requested':
      case 'userinput.answered':
      case 'handoff.created':
      case 'usage.updated':
      case 'notice.raised':
      case 'tool.started':
      case 'tool.progress':
      case 'tool.completed':
      case 'context.compacted':
        /*
         * `context.compacted` is here for a related reason: it records that an
         * agent lost its own history, which says nothing about what the
         * conversation contains, and a handoff summary is about the latter.
         *
         * Questions are left out of a handoff summary for the same reason
         * approvals are: this is what the *user* was asked and answered, not
         * what the conversation said. Carrying them would also mean deciding
         * what to do with a secret answer, and the safest thing to do with one
         * is not move it across an agent boundary at all.
         *
         * `tool.completed`'s patch stays out for a different reason: the other
         * agent shares the working tree and can read the file or run git itself.
         * Replaying our rendering of a change it can observe directly would cost
         * tokens on every catch-up to tell it something already true on disk —
         * and would be wrong the moment the edit is amended after the fact.
         */
        break
    }
  }

  // A command with no `completed` was interrupted or the session ended under it.
  // Silence would read as "never ran", which is the wrong thing to believe.
  for (const found of running.values()) {
    lines.push({
      seq: found.seq,
      eventId: found.eventId,
      conversationId: found.conversationId,
      kind: 'activity',
      discussion: false,
      fromUser: false,
      text: `· ${found.actor} ran \`${found.command}\` (no result recorded)`,
    })
  }

  return lines.sort((a, b) => a.seq - b.seq)
}

function renderCommand(found: RunningCommand, exitCode: number | null): string {
  const head = `· ${found.actor} ran \`${found.command}\``
  if (exitCode === null) return `${head} (no exit code)`
  if (exitCode === 0) return `${head} → ok`

  const tail = found.output.trim()
  return tail === ''
    ? `${head} → failed (exit ${String(exitCode)})`
    : `${head} → failed (exit ${String(exitCode)})\n  output: ${tail.replaceAll('\n', '\n  ')}`
}

/** Three names is a list; ten is a wall, and the count is what matters by then. */
function describeFiles(paths: readonly string[]): string {
  if (paths.length <= 3) return paths.join(', ')
  return `${paths.slice(0, 3).join(', ')} and ${String(paths.length - 3)} more`
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

const boundary = (text: string, index: number, forward: boolean): number => {
  const at = Math.min(Math.max(index, 0), text.length)
  if (at === 0 || at === text.length || !isLowSurrogate(text.charCodeAt(at))) return at
  return forward ? at + 1 : at - 1
}

export function sliceText(text: string, start: number, end = text.length): string {
  return text.slice(boundary(text, start, true), boundary(text, end, false))
}

export function trimMiddle(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  // Both ends: the opening says what it is about, the close usually carries the
  // conclusion or the question.
  const half = Math.floor((limit - 20) / 2)
  if (half <= 0) return sliceText(trimmed, 0, Math.max(limit, 0))
  return `${sliceText(trimmed, 0, half)}${TRIM_MARKER}${sliceText(trimmed, trimmed.length - half)}`
}

const pointBytes = (code: number): number =>
  code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4

export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const point of text) bytes += pointBytes(point.codePointAt(0) ?? 0)
  return bytes
}

export function clipToBytes(text: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const point of text) {
    used += pointBytes(point.codePointAt(0) ?? 0)
    if (used > maxBytes) return text.slice(0, end)
    end += point.length
  }
  return text
}

function clipTailToBytes(text: string, maxBytes: number): string {
  let used = 0
  let start = text.length
  while (start > 0) {
    let from = start - 1
    const low = text.charCodeAt(from)
    if (low >= 0xdc00 && low <= 0xdfff && from > 0) {
      const high = text.charCodeAt(from - 1)
      if (high >= 0xd800 && high <= 0xdbff) from -= 1
    }
    used += pointBytes(text.codePointAt(from) ?? 0)
    if (used > maxBytes) break
    start = from
  }
  return text.slice(start)
}

export function fitBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text
  const room = maxBytes - utf8Bytes(TRIM_MARKER)
  if (room <= 0) return clipToBytes(text, Math.max(maxBytes, 0))
  const head = clipToBytes(text, Math.ceil(room / 2))
  return `${head}${TRIM_MARKER}${clipTailToBytes(text, room - utf8Bytes(head))}`
}

export function sliceBytes(
  text: string,
  offset: number,
  maxBytes: number
): { readonly text: string; readonly start: number; readonly end: number; readonly total: number } {
  let position = 0
  let startIndex = text.length
  let start = -1
  let endIndex = text.length
  let end = -1
  let index = 0
  for (const point of text) {
    const size = pointBytes(point.codePointAt(0) ?? 0)
    if (start === -1 && position >= offset) {
      start = position
      startIndex = index
    }
    if (start !== -1 && end === -1 && position + size - start > maxBytes) {
      end = position
      endIndex = index
    }
    position += size
    index += point.length
  }
  const total = position
  if (start === -1) start = total
  if (end === -1) end = total
  return { text: text.slice(startIndex, endIndex), start, end, total }
}
