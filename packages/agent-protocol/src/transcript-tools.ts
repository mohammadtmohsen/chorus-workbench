import { z } from 'zod'
import type { TranscriptReader, TranscriptRequest, TranscriptScope } from './adapter.js'
import { boundFailure, type ProjectToolResult } from './project-tools.js'

export const TRANSCRIPT_TOOL_NAMESPACE = 'chorus_transcript'
export const TRANSCRIPT_TOOL_NAME = 'read_transcript'

export const TRANSCRIPT_COUNT = { min: 1, max: 50, fallback: 20 } as const
export const TRANSCRIPT_SKIP = { min: 0, max: 100_000, fallback: 0 } as const
export const TRANSCRIPT_OFFSET = { min: 0, max: 100_000_000 } as const
export const TRANSCRIPT_QUERY_LENGTH = { min: 1, max: 200 } as const
export const TRANSCRIPT_ID_LENGTH = { min: 1, max: 128 } as const
export const TRANSCRIPT_SCOPES = [
  'snapshot',
  'updates',
  'forwarded',
] as const satisfies readonly TranscriptScope[]

const SKIP_TEXT = `How many of the newest entries (or matches) to skip, to page back. Defaults to 0, at most ${String(TRANSCRIPT_SKIP.max)}.`
const COUNT_TEXT = `How many entries to return. Defaults to ${String(TRANSCRIPT_COUNT.fallback)}, at most ${String(TRANSCRIPT_COUNT.max)}.`
const CONVERSATION_TEXT =
  'Limit the read to one conversation: this one or an earlier conversation it continues. Defaults to all of them. With scope "forwarded", a conversation forwarded directly from this one.'
const QUERY_TEXT = `Case-insensitive literal text to search for, up to ${String(TRANSCRIPT_QUERY_LENGTH.max)} characters. Not a regular expression.`
const EVENT_TEXT =
  'Read one record in full by the event id shown in brackets, such as [#42 0190…]. Long records come in parts; pass offset to continue.'
const OFFSET_TEXT =
  'Byte offset into the record named by eventId, from the previous reply. Defaults to 0.'
const SCOPE_TEXT =
  '"snapshot" (default) reads records up to the moment this conversation was opened. "updates" reads what was written later in the earlier conversations it continues, which is not part of this task unless the user says so. "forwarded" reads the conversations forwarded from this one: without conversationId it lists them, newest first; with one, it reports the task the user marked as that forwarded work, from that task\'s own records.'
const FORWARDED_LIST_ONLY =
  'not accepted when listing forwarded conversations; pass conversationId to read one'

export const TRANSCRIPT_TOOL_SHAPE = {
  skip: z
    .number()
    .int()
    .min(TRANSCRIPT_SKIP.min)
    .max(TRANSCRIPT_SKIP.max)
    .optional()
    .describe(SKIP_TEXT),
  count: z
    .number()
    .int()
    .min(TRANSCRIPT_COUNT.min)
    .max(TRANSCRIPT_COUNT.max)
    .optional()
    .describe(COUNT_TEXT),
  conversationId: z
    .string()
    .min(TRANSCRIPT_ID_LENGTH.min)
    .max(TRANSCRIPT_ID_LENGTH.max)
    .optional()
    .describe(CONVERSATION_TEXT),
  query: z
    .string()
    .min(TRANSCRIPT_QUERY_LENGTH.min)
    .max(TRANSCRIPT_QUERY_LENGTH.max)
    .optional()
    .describe(QUERY_TEXT),
  eventId: z
    .string()
    .min(TRANSCRIPT_ID_LENGTH.min)
    .max(TRANSCRIPT_ID_LENGTH.max)
    .optional()
    .describe(EVENT_TEXT),
  offset: z
    .number()
    .int()
    .min(TRANSCRIPT_OFFSET.min)
    .max(TRANSCRIPT_OFFSET.max)
    .optional()
    .describe(OFFSET_TEXT),
  scope: z.enum(TRANSCRIPT_SCOPES).optional().describe(SCOPE_TEXT),
} as const

export const TRANSCRIPT_NAMESPACE_DESCRIPTION =
  'Reads the recorded history of this shared conversation and of the earlier conversations it continues. Check it rather than guessing about something the user or another agent said earlier.'

export const TRANSCRIPT_TOOL_DESCRIPTION = [
  'Read what Chorus recorded in this shared conversation and in the earlier conversations it continues: what the user and each agent said, the commands agents ran with their exit status, files changed, and errors.',
  '',
  'Context handed to you before a message is shortened. Use this when entries were omitted, when something you need was cut with "[trimmed]", or when you need what was said before you were addressed.',
  '',
  'Pass query to search, eventId (and offset) to read one record in full, skip and count to page from the newest. Entries come oldest first, each marked [#seq event-id].',
  '',
  'It exposes recorded messages, command evidence, file changes and tool metadata. Private reasoning, unrecorded tool results and private provider memory are unavailable. If a detail is not found, check the source, scope and pagination before concluding it is absent.',
  '',
  'scope "forwarded" follows work the user forwarded from this conversation into another one. Without conversationId it lists those conversations (skip and count page them; query, eventId and offset are refused). With conversationId it reports the task the user marked as that forwarded work: status only from that task\'s own records, and everything else as activity observed in the other conversation while the task was tracked, which is not status. query then searches that activity, and eventId reads one cited record. Until the user marks a task, nothing is reported as its status. Every answer says how far the log had got when it was read. Reading never changes the other conversation.',
].join('\n')

const integer = (
  bounds: { readonly min: number; readonly max: number },
  description: string
): Readonly<Record<string, unknown>> => ({
  type: 'integer',
  minimum: bounds.min,
  maximum: bounds.max,
  description,
})

const text = (
  bounds: { readonly min: number; readonly max: number },
  description: string
): Readonly<Record<string, unknown>> => ({
  type: 'string',
  minLength: bounds.min,
  maxLength: bounds.max,
  description,
})

export const TRANSCRIPT_TOOL_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    skip: integer(TRANSCRIPT_SKIP, SKIP_TEXT),
    count: integer(TRANSCRIPT_COUNT, COUNT_TEXT),
    conversationId: text(TRANSCRIPT_ID_LENGTH, CONVERSATION_TEXT),
    query: text(TRANSCRIPT_QUERY_LENGTH, QUERY_TEXT),
    eventId: text(TRANSCRIPT_ID_LENGTH, EVENT_TEXT),
    offset: integer(TRANSCRIPT_OFFSET, OFFSET_TEXT),
    scope: { type: 'string', enum: [...TRANSCRIPT_SCOPES], description: SCOPE_TEXT },
  },
  required: [],
  additionalProperties: false,
}

const ARGUMENTS = z
  .object(TRANSCRIPT_TOOL_SHAPE)
  .strict()
  .superRefine((args, context) => {
    if (args.scope !== 'forwarded' || args.conversationId !== undefined) return
    for (const key of ['query', 'eventId', 'offset'] as const) {
      if (args[key] !== undefined) {
        context.addIssue({ code: 'custom', path: [key], message: FORWARDED_LIST_ONLY })
      }
    }
  })

export const NO_TRANSCRIPT_READER = 'The conversation history is not available in this session.'

function transcriptRequestOf(args: z.infer<typeof ARGUMENTS>): TranscriptRequest {
  return {
    skip: args.skip ?? TRANSCRIPT_SKIP.fallback,
    count: args.count ?? TRANSCRIPT_COUNT.fallback,
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(args.query === undefined ? {} : { query: args.query }),
    ...(args.eventId === undefined ? {} : { eventId: args.eventId }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
    ...(args.scope === undefined ? {} : { scope: args.scope }),
  }
}

export function runTranscriptTool(
  reader: TranscriptReader | undefined,
  args: unknown
): ProjectToolResult {
  if (reader === undefined) return { ok: false, text: NO_TRANSCRIPT_READER }
  const parsed = ARGUMENTS.safeParse(args ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      text: boundFailure(
        `Invalid arguments: ${parsed.error.issues
          .map((issue) => {
            const where = issue.path.map(String).join('.')
            return where === '' ? issue.message : `${where}: ${issue.message}`
          })
          .join('; ')}`
      ),
    }
  }
  try {
    return { ok: true, text: reader(transcriptRequestOf(parsed.data)) }
  } catch (error) {
    return { ok: false, text: boundFailure(error instanceof Error ? error.message : String(error)) }
  }
}
