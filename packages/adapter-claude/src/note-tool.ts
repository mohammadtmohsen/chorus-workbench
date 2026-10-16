import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  NOTE_NAMESPACE_DESCRIPTION,
  NOTE_READ_TOOL_NAME,
  NOTE_TOOL_DESCRIPTIONS,
  NOTE_TOOL_NAMES,
  NOTE_TOOL_NAMESPACE,
  NOTE_TOOL_SHAPES,
  NOTE_WRITE_TOOL_NAME,
  runNoteTool,
  type NoteAccess,
  type NoteToolName,
} from '@chorus/agent-protocol'

const answer = (
  access: NoteAccess,
  name: NoteToolName,
  args: unknown
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
  const result = runNoteTool(access, name, args)
  return Promise.resolve({
    content: [{ type: 'text', text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  })
}

export function noteTools(access: NoteAccess) {
  const read = tool(
    NOTE_READ_TOOL_NAME,
    NOTE_TOOL_DESCRIPTIONS.read_note,
    NOTE_TOOL_SHAPES.read_note,
    (args) => answer(access, NOTE_READ_TOOL_NAME, args)
  )
  if (access.write === undefined) return [read]
  return [
    read,
    tool(
      NOTE_WRITE_TOOL_NAME,
      NOTE_TOOL_DESCRIPTIONS.write_note,
      NOTE_TOOL_SHAPES.write_note,
      (args) => answer(access, NOTE_WRITE_TOOL_NAME, args)
    ),
  ]
}

export function noteMcpServer(
  access: NoteAccess | undefined
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (access === undefined) return undefined
  return {
    [NOTE_TOOL_NAMESPACE]: createSdkMcpServer({
      name: NOTE_TOOL_NAMESPACE,
      version: '1.0.0',
      instructions: NOTE_NAMESPACE_DESCRIPTION,
      tools: noteTools(access),
    }),
  }
}

export const READ_NOTE_TOOL = `mcp__${NOTE_TOOL_NAMESPACE}__${NOTE_READ_TOOL_NAME}`

export const NOTE_TOOL_IDS: ReadonlySet<string> = new Set(
  NOTE_TOOL_NAMES.map((name) => `mcp__${NOTE_TOOL_NAMESPACE}__${name}`)
)
