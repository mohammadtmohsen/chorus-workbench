import type { StoredEvent } from '@chorus/event-store'
import type { TranscriptLine } from './transcript-lines.js'

const EVIDENCE_TYPES: ReadonlySet<StoredEvent['type']> = new Set([
  'command.started',
  'command.output',
  'command.completed',
  'file.change.proposed',
  'file.change.completed',
  'tool.started',
  'tool.completed',
])

export function evidenceLines(
  events: readonly StoredEvent[],
  readable: ReadonlySet<string>
): TranscriptLine[] {
  return events
    .filter((event) => EVIDENCE_TYPES.has(event.payload.type) && !readable.has(event.id))
    .map((event) => ({
      seq: event.seq,
      eventId: event.id,
      conversationId: event.conversationId,
      kind: 'activity',
      fromUser: event.actor === 'user',
      discussion: false,
      text: `${event.actor} ${event.payload.type}:\n${JSON.stringify(event.payload)}`,
    }))
}

interface Command {
  readonly actor: string
  readonly command: string
  readonly cwd: string
  readonly startedId: string
  output: string
}

export function commandRecords(events: readonly StoredEvent[]): Map<string, string> {
  const records = new Map<string, string>()
  const running = new Map<string, Command>()
  const render = (found: Command, ending: string): string =>
    `· ${found.actor} ran \`${found.command}\` in ${found.cwd} ${ending}` +
    (found.output === '' ? '\n(no output recorded)' : `\nFull recorded output:\n${found.output}`)
  for (const event of events) {
    const payload = event.payload
    if (payload.type === 'command.started') {
      running.set(payload.itemRef, {
        actor: event.actor,
        command: payload.command.join(' '),
        cwd: payload.cwd,
        startedId: event.id,
        output: '',
      })
    } else if (payload.type === 'command.output') {
      const found = running.get(payload.itemRef)
      if (found !== undefined) found.output += payload.chunk
    } else if (payload.type === 'command.completed') {
      const found = running.get(payload.itemRef)
      if (found === undefined) continue
      running.delete(payload.itemRef)
      records.set(
        event.id,
        render(
          found,
          payload.exitCode === null ? '(no exit code)' : `→ exit ${String(payload.exitCode)}`
        )
      )
    }
  }
  for (const found of running.values()) {
    records.set(found.startedId, render(found, '(no result recorded)'))
  }
  return records
}
