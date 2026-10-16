import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import {
  TRANSCRIPT_NAMESPACE_DESCRIPTION,
  TRANSCRIPT_TOOL_DESCRIPTION,
  TRANSCRIPT_TOOL_NAME,
  TRANSCRIPT_TOOL_NAMESPACE,
  TRANSCRIPT_TOOL_SHAPE,
  runTranscriptTool,
  type TranscriptReader,
} from '@chorus/agent-protocol'

export function transcriptTools(read: TranscriptReader) {
  return [
    tool(TRANSCRIPT_TOOL_NAME, TRANSCRIPT_TOOL_DESCRIPTION, TRANSCRIPT_TOOL_SHAPE, (args) => {
      const result = runTranscriptTool(read, args)
      return Promise.resolve({
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      })
    }),
  ]
}

export function transcriptMcpServer(
  read: TranscriptReader | undefined
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (read === undefined) return undefined
  return {
    [TRANSCRIPT_TOOL_NAMESPACE]: createSdkMcpServer({
      name: TRANSCRIPT_TOOL_NAMESPACE,
      version: '1.0.0',
      instructions: TRANSCRIPT_NAMESPACE_DESCRIPTION,
      tools: transcriptTools(read),
    }),
  }
}

export const READ_TRANSCRIPT_TOOL = `mcp__${TRANSCRIPT_TOOL_NAMESPACE}__${TRANSCRIPT_TOOL_NAME}`
