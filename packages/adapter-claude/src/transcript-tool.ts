import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { TranscriptReader } from '@chorus/agent-protocol'
import { z } from 'zod'

const READ_SCHEMA = {
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('How many of the newest entries to skip, to page back. Defaults to 0, the newest.'),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many entries to return. Defaults to 20, at most 50.'),
}

const DESCRIPTION = [
  'Read earlier entries of this shared Chorus conversation in full: what the user and each agent said, and what each agent ran.',
  '',
  'The catch-up handed to you before a message is shortened, and older entries are left out of it.',
  'Use this when it says entries were omitted, when something you need was cut with "[trimmed]",',
  'or when you need what was said before you were addressed.',
  '',
  'Entries come oldest first. Raise skip to page further back.',
].join('\n')

export function transcriptMcpServer(
  read: TranscriptReader | undefined
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (read === undefined) return undefined
  return {
    chorus_transcript: createSdkMcpServer({
      name: 'chorus_transcript',
      version: '1.0.0',
      instructions:
        'Reads the full history of this shared conversation. Check it rather than guessing about something the user or another agent said earlier.',
      tools: [
        tool('read_transcript', DESCRIPTION, READ_SCHEMA, (args) =>
          Promise.resolve({
            content: [
              {
                type: 'text' as const,
                text: read({ skip: args.skip ?? 0, count: args.count ?? 20 }),
              },
            ],
          })
        ),
      ],
    }),
  }
}

export const READ_TRANSCRIPT_TOOL = 'mcp__chorus_transcript__read_transcript'
