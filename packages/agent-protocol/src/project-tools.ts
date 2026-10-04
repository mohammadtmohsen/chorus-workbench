import { z } from 'zod'

export const PROJECT_TOOL_NAMESPACE = 'chorus_project'

export interface ProjectReader {
  readonly terminal: (request: { readonly lines: number }) => Promise<string>
  readonly traffic: (request: { readonly count: number; readonly skip: number }) => Promise<string>
  readonly request: (request: {
    readonly captureId: string
    readonly requestId: string
  }) => Promise<string>
}

export const PROJECT_TERMINAL_LINES = { min: 1, max: 400, fallback: 200 } as const
export const PROJECT_TRAFFIC_COUNT = { min: 1, max: 50, fallback: 20 } as const
export const PROJECT_TRAFFIC_SKIP = { min: 0, max: 1_000, fallback: 0 } as const
export const PROJECT_ID_LENGTH = { min: 1, max: 64 } as const

const LINES_TEXT = `How many of the newest lines to return. Defaults to ${String(PROJECT_TERMINAL_LINES.fallback)}, at most ${String(PROJECT_TERMINAL_LINES.max)}.`
const COUNT_TEXT = `How many requests to return, newest first. Defaults to ${String(PROJECT_TRAFFIC_COUNT.fallback)}, at most ${String(PROJECT_TRAFFIC_COUNT.max)}.`
const SKIP_TEXT = `How many of the newest requests to skip, to page back. Defaults to 0, at most ${String(PROJECT_TRAFFIC_SKIP.max)}.`
const CAPTURE_TEXT = 'The captureId read_traffic returned.'
const REQUEST_TEXT = 'The requestId of one row read_traffic returned.'

export const PROJECT_TOOL_SHAPES = {
  read_terminal: {
    lines: z
      .number()
      .int()
      .min(PROJECT_TERMINAL_LINES.min)
      .max(PROJECT_TERMINAL_LINES.max)
      .optional()
      .describe(LINES_TEXT),
  },
  read_traffic: {
    count: z
      .number()
      .int()
      .min(PROJECT_TRAFFIC_COUNT.min)
      .max(PROJECT_TRAFFIC_COUNT.max)
      .optional()
      .describe(COUNT_TEXT),
    skip: z
      .number()
      .int()
      .min(PROJECT_TRAFFIC_SKIP.min)
      .max(PROJECT_TRAFFIC_SKIP.max)
      .optional()
      .describe(SKIP_TEXT),
  },
  read_request: {
    captureId: z
      .string()
      .min(PROJECT_ID_LENGTH.min)
      .max(PROJECT_ID_LENGTH.max)
      .describe(CAPTURE_TEXT),
    requestId: z
      .string()
      .min(PROJECT_ID_LENGTH.min)
      .max(PROJECT_ID_LENGTH.max)
      .describe(REQUEST_TEXT),
  },
} as const

export type ProjectToolName = keyof typeof PROJECT_TOOL_SHAPES

export const PROJECT_TOOL_NAMES: readonly ProjectToolName[] = [
  'read_terminal',
  'read_traffic',
  'read_request',
]

export const PROJECT_NAMESPACE_DESCRIPTION =
  'Read-only access to this conversation’s project in Chorus: the output of the dev command Chorus runs beside Traffic, and the HTTP requests Traffic captured from it. Nothing here starts, stops or types into anything.'

export const PROJECT_TOOL_DESCRIPTIONS: Readonly<Record<ProjectToolName, string>> = {
  read_terminal: [
    'Read the newest output of this project’s dev command, from the terminal Chorus runs it in.',
    'Returns the run state, the command’s label, its exit code once it has exited, then the last lines.',
    'Read only: it cannot type into the terminal, or start or stop the command.',
  ].join('\n'),
  read_traffic: [
    'List the newest HTTP requests Traffic captured for this project, newest first.',
    'Each row has requestId, method, path, status, outcome, the backend code and next action when the response named them, and the transport failure when there was no response.',
    'Returns the captureId to pass to read_request. Raise skip to page back.',
  ].join('\n'),
  read_request: [
    'Read one captured request: method, URLs, timing, headers with credentials masked, and the request and response bodies, each cut to 8 KiB.',
    'Pass the captureId and requestId read_traffic returned. A request from a capture that has since been cleared or restarted answers cleared, never another request.',
  ].join('\n'),
}

const integer = (
  bounds: { readonly min: number; readonly max: number },
  description: string
): Readonly<Record<string, unknown>> => ({
  type: 'integer',
  minimum: bounds.min,
  maximum: bounds.max,
  description,
})

const identifier = (description: string): Readonly<Record<string, unknown>> => ({
  type: 'string',
  minLength: PROJECT_ID_LENGTH.min,
  maxLength: PROJECT_ID_LENGTH.max,
  description,
})

export const PROJECT_TOOL_INPUT_SCHEMAS: Readonly<
  Record<ProjectToolName, Readonly<Record<string, unknown>>>
> = {
  read_terminal: {
    type: 'object',
    properties: { lines: integer(PROJECT_TERMINAL_LINES, LINES_TEXT) },
    required: [],
    additionalProperties: false,
  },
  read_traffic: {
    type: 'object',
    properties: {
      count: integer(PROJECT_TRAFFIC_COUNT, COUNT_TEXT),
      skip: integer(PROJECT_TRAFFIC_SKIP, SKIP_TEXT),
    },
    required: [],
    additionalProperties: false,
  },
  read_request: {
    type: 'object',
    properties: {
      captureId: identifier(CAPTURE_TEXT),
      requestId: identifier(REQUEST_TEXT),
    },
    required: ['captureId', 'requestId'],
    additionalProperties: false,
  },
}

const ARGUMENTS = {
  read_terminal: z.object(PROJECT_TOOL_SHAPES.read_terminal).strict(),
  read_traffic: z.object(PROJECT_TOOL_SHAPES.read_traffic).strict(),
  read_request: z.object(PROJECT_TOOL_SHAPES.read_request).strict(),
}

export interface ProjectToolResult {
  readonly ok: boolean
  readonly text: string
}

export const NO_PROJECT_READER = 'Project tools are not available in this conversation.'

export const PROJECT_FAILURE_BYTES = 1_024

const FAILURE_MARKER = '…'

const utf8Bytes = (point: string): number => {
  const code = point.codePointAt(0) ?? 0
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  return code < 0x10000 ? 3 : 4
}

export function boundFailure(text: string): string {
  const room = PROJECT_FAILURE_BYTES - utf8Bytes(FAILURE_MARKER)
  let used = 0
  let index = 0
  let cutAt = -1
  for (const point of text) {
    used += utf8Bytes(point)
    if (cutAt === -1 && used > room) cutAt = index
    if (used > PROJECT_FAILURE_BYTES) return `${text.slice(0, cutAt)}${FAILURE_MARKER}`
    index += point.length
  }
  return text
}

const failed = (text: string): ProjectToolResult => ({ ok: false, text: boundFailure(text) })

export function isProjectTool(name: string): name is ProjectToolName {
  return (PROJECT_TOOL_NAMES as readonly string[]).includes(name)
}

const invalid = (error: z.ZodError): ProjectToolResult =>
  failed(
    `Invalid arguments: ${error.issues
      .map((issue) => {
        const where = issue.path.map(String).join('.')
        return where === '' ? issue.message : `${where}: ${issue.message}`
      })
      .join('; ')}`
  )

export async function runProjectTool(
  reader: ProjectReader | undefined,
  tool: string,
  args: unknown
): Promise<ProjectToolResult> {
  if (reader === undefined) return failed(NO_PROJECT_READER)
  if (!isProjectTool(tool)) return failed(`Unknown project tool: ${tool}`)
  const input = args ?? {}
  try {
    switch (tool) {
      case 'read_terminal': {
        const parsed = ARGUMENTS.read_terminal.safeParse(input)
        if (!parsed.success) return invalid(parsed.error)
        const lines = parsed.data.lines ?? PROJECT_TERMINAL_LINES.fallback
        return { ok: true, text: await reader.terminal({ lines }) }
      }
      case 'read_traffic': {
        const parsed = ARGUMENTS.read_traffic.safeParse(input)
        if (!parsed.success) return invalid(parsed.error)
        const count = parsed.data.count ?? PROJECT_TRAFFIC_COUNT.fallback
        const skip = parsed.data.skip ?? PROJECT_TRAFFIC_SKIP.fallback
        return { ok: true, text: await reader.traffic({ count, skip }) }
      }
      case 'read_request': {
        const parsed = ARGUMENTS.read_request.safeParse(input)
        if (!parsed.success) return invalid(parsed.error)
        const { captureId, requestId } = parsed.data
        return { ok: true, text: await reader.request({ captureId, requestId }) }
      }
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
