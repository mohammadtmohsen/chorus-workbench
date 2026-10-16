import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  PROGRESS_NAMESPACE_DESCRIPTION,
  PROGRESS_TOOL_DESCRIPTION,
  PROGRESS_TOOL_NAME,
  PROGRESS_TOOL_NAMESPACE,
  PROGRESS_TOOL_SHAPE,
  runProgressTool,
  type ProgressReporter,
} from '@chorus/agent-protocol'

export function progressTools(report: ProgressReporter) {
  return [
    tool(PROGRESS_TOOL_NAME, PROGRESS_TOOL_DESCRIPTION, PROGRESS_TOOL_SHAPE, async (args) => {
      const result = await runProgressTool(report, args)
      return {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      }
    }),
  ]
}

export function progressMcpServer(
  report: ProgressReporter | undefined
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (report === undefined) return undefined
  return {
    [PROGRESS_TOOL_NAMESPACE]: createSdkMcpServer({
      name: PROGRESS_TOOL_NAMESPACE,
      version: '1.0.0',
      instructions: PROGRESS_NAMESPACE_DESCRIPTION,
      tools: progressTools(report),
    }),
  }
}

export const REPORT_PROGRESS_TOOL = `mcp__${PROGRESS_TOOL_NAMESPACE}__${PROGRESS_TOOL_NAME}`
