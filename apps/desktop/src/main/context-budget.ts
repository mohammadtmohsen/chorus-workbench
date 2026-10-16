import type { AgentSession, ContextUsage } from '@chorus/agent-protocol'

export type ContextWindow = Pick<ContextUsage, 'usedTokens' | 'maxTokens'>

const CONTEXT_BYTES = 24_000
const ANSWER_RESERVE = 8_192
const FRAME_RESERVE = 2_048

export function contextBudget(
  input: string,
  usage?: ContextWindow,
  maximum = CONTEXT_BYTES
): number {
  const ceiling = Math.max(Math.min(maximum, CONTEXT_BYTES), 0)
  if (
    usage === undefined ||
    !Number.isFinite(usage.usedTokens) ||
    !Number.isFinite(usage.maxTokens) ||
    usage.maxTokens <= 0
  )
    return ceiling
  return Math.max(
    Math.min(
      ceiling,
      Math.floor(usage.maxTokens - Math.max(usage.usedTokens, 0)) -
        ANSWER_RESERVE -
        FRAME_RESERVE -
        Buffer.byteLength(input, 'utf8')
    ),
    0
  )
}

export function fitContext(text: string, maximum: number): string {
  const encoded = Buffer.from(text, 'utf8')
  const ceiling = Math.max(Math.floor(maximum), 0)
  if (encoded.length <= ceiling) return text
  let end = Math.min(ceiling, encoded.length)
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return encoded.subarray(0, end).toString('utf8')
}

export function fitContextTail(
  text: string,
  maximum: number,
  marker = '[Older context omitted]\n'
): string {
  const encoded = Buffer.from(text, 'utf8')
  const ceiling = Math.max(Math.floor(maximum), 0)
  if (encoded.length <= ceiling) return text
  const prefix = Buffer.byteLength(marker, 'utf8') < ceiling ? marker : ''
  let start = encoded.length - Math.max(ceiling - Buffer.byteLength(prefix, 'utf8'), 0)
  while (start < encoded.length && ((encoded[start] ?? 0) & 0xc0) === 0x80) start += 1
  return `${prefix}${encoded.subarray(start).toString('utf8')}`
}

export function fitContextExcerpt(text: string, maximum: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text
  const marker = '\n[trimmed]\n'
  const room = Math.max(maximum - Buffer.byteLength(marker, 'utf8'), 0)
  if (room === 0) return fitContext(text, maximum)
  const head = fitContext(text, Math.floor(room / 2))
  return `${head}${marker}${fitContextTail(text, room - Buffer.byteLength(head, 'utf8'), '')}`
}

export function deferredContext(retrieval: boolean): string {
  return (
    '[Chorus] Additional recorded history is deferred because this session has little context room. ' +
    'It has not been included in this message. Continue with the current request and the context you already hold. ' +
    (retrieval
      ? 'When room becomes available, use read_transcript to recover any missing decision or evidence. Do not guess.'
      : 'If a required detail is missing, ask for it rather than guessing; older records cannot be read in this session.')
  )
}

export function hasTranscript(session: AgentSession): boolean {
  return session.transcriptTool === 'registered' || session.transcriptTool === 'unconfirmed'
}
