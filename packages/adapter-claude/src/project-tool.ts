import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  PROJECT_NAMESPACE_DESCRIPTION,
  PROJECT_TOOL_DESCRIPTIONS,
  PROJECT_TOOL_NAMES,
  PROJECT_TOOL_NAMESPACE,
  PROJECT_TOOL_SHAPES,
  runProjectTool,
  type ProjectReader,
  type ProjectToolName,
} from '@chorus/agent-protocol'

const answer = async (
  reader: ProjectReader,
  name: ProjectToolName,
  args: unknown
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
  const result = await runProjectTool(reader, name, args)
  return {
    content: [{ type: 'text', text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  }
}

export function projectTools(reader: ProjectReader) {
  return [
    tool(
      'read_terminal',
      PROJECT_TOOL_DESCRIPTIONS.read_terminal,
      PROJECT_TOOL_SHAPES.read_terminal,
      (args) => answer(reader, 'read_terminal', args)
    ),
    tool(
      'read_traffic',
      PROJECT_TOOL_DESCRIPTIONS.read_traffic,
      PROJECT_TOOL_SHAPES.read_traffic,
      (args) => answer(reader, 'read_traffic', args)
    ),
    tool(
      'read_request',
      PROJECT_TOOL_DESCRIPTIONS.read_request,
      PROJECT_TOOL_SHAPES.read_request,
      (args) => answer(reader, 'read_request', args)
    ),
  ]
}

export function projectMcpServer(
  reader: ProjectReader | undefined
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (reader === undefined) return undefined
  return {
    [PROJECT_TOOL_NAMESPACE]: createSdkMcpServer({
      name: PROJECT_TOOL_NAMESPACE,
      version: '1.0.0',
      instructions: PROJECT_NAMESPACE_DESCRIPTION,
      tools: projectTools(reader),
    }),
  }
}

export const PROJECT_TOOL_IDS: ReadonlySet<string> = new Set(
  PROJECT_TOOL_NAMES.map((name) => `mcp__${PROJECT_TOOL_NAMESPACE}__${name}`)
)
