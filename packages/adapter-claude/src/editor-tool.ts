import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { EditorEditCapability } from '@chorus/agent-protocol'
import { z } from 'zod'

/**
 * `editor_edit`, offered to Claude as an in-process MCP tool — Phase 6e.
 *
 * **In-process, so there is no server, no port and no credential.**
 * `createSdkMcpServer` runs the tool inside this process and the SDK routes
 * calls to it over its own transport. The alternative — a real MCP endpoint the
 * CLI connects to — would mean a listening socket, a token to authenticate it,
 * a lifetime to manage and a write into the user's own agent configuration. All
 * of that is avoidable for Claude, and it is the reason Claude goes first.
 *
 * **It is added to `mcpServers` and `strictMcpConfig` is never set.** That is
 * not an oversight: the SDK's flag means "ignore project `.mcp.json`, user
 * settings, plugins and agent frontmatter", and setting it would silently
 * disconnect every MCP server the person configured for themselves. Merging is
 * the default and merging is what is wanted — this is one more tool beside
 * theirs, not a replacement for their setup.
 *
 * **Every call is asked.** `mcpToolCall` is the one approval kind the policy
 * engine may never auto-decide (`engine.ts`, rule 1), so an edit through this
 * tool reaches the person no matter which profile the project is on. That is the
 * right default for something that changes what is on their screen, and it is
 * inherited rather than re-implemented here.
 */

/**
 * The schema, and it is deliberately not forgiving.
 *
 * A tool schema is a prompt: the model reads it and decides what to send. Every
 * loose field is a field it will eventually get wrong in a way that is only
 * caught at the far end, so `base_version` is required and integral rather than
 * optional-with-a-default. There is no safe default for "the version I read" —
 * a missing one can only mean "apply regardless", which is the clobber this
 * whole mechanism exists to prevent.
 *
 * Snake case because that is the convention across the CLI's own tools, and a
 * schema that reads differently from its neighbours invites the model to
 * improvise.
 */
const EDIT_SCHEMA = {
  path: z
    .string()
    .describe(
      'Path to the file, relative to the project root. Never absolute, never containing "..".'
    ),
  base_version: z
    .number()
    .int()
    .describe(
      'The editor model version this edit was written against, as returned by a previous editor_edit or read. If the file has changed since, the edit is refused as a conflict rather than applied.'
    ),
  start_line: z.number().int().min(1).describe('First line of the range to replace (1-based).'),
  start_column: z.number().int().min(1).describe('First column of the range to replace (1-based).'),
  end_line: z.number().int().min(1).describe('Last line of the range to replace (1-based).'),
  end_column: z.number().int().min(1).describe('Column just past the end of the range (1-based).'),
  new_text: z.string().describe('Text to put in place of that range. May be empty to delete.'),
}

const DESCRIPTION = [
  "Edit a file in the user's open editor rather than on disk.",
  '',
  'Prefer this over writing the file directly when the project has an editor open:',
  'the change lands in the live model, so it joins the undo stack, marks the file',
  'dirty instead of saving it, and appears in source control and diagnostics as if',
  'the user had typed it. Nothing is saved on their behalf.',
  '',
  'Requires base_version. Read the file first and pass the version you were given.',
  'If it does not match, the edit is refused with the current version — re-read and',
  'try again rather than retrying the same edit.',
].join('\n')

/**
 * Builds the server, or nothing when the host offers no editor.
 *
 * Returning `undefined` rather than a server whose tool always refuses is
 * deliberate: a tool the model can see is a tool it will try, and one that
 * always fails costs a turn and teaches it nothing. A host with no workbench
 * simply does not advertise the capability.
 */
export function editorMcpServer(
  edit: EditorEditCapability | undefined,
  projectRoot: string
): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
  if (edit === undefined) return undefined
  return {
    chorus_editor: createSdkMcpServer({
      name: 'chorus_editor',
      version: '1.0.0',
      instructions:
        "Tools for changing files in the user's open editor. Use these in preference to writing files directly while an editor is open.",
      tools: [
        tool('editor_edit', DESCRIPTION, EDIT_SCHEMA, async (args) => {
          const outcome = await edit(projectRoot, {
            path: args.path,
            baseVersion: args.base_version,
            range: {
              startLine: args.start_line,
              startColumn: args.start_column,
              endLine: args.end_line,
              endColumn: args.end_column,
            },
            newText: args.new_text,
          })

          /*
           * A refusal is returned as content with `isError`, not thrown. The
           * model has to be able to *read* why — "conflict, now at version 12"
           * is actionable and "the tool failed" is not — and an exception here
           * would be flattened into a transport error before it reached the
           * turn.
           */
          if (!outcome.ok) {
            const at =
              outcome.version === null
                ? ''
                : ` The file is now at version ${String(outcome.version)}.`
            return {
              isError: true,
              content: [
                { type: 'text' as const, text: `${outcome.refusal}: ${outcome.message}${at}` },
              ],
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Applied. The file is now at version ${String(outcome.version)}. It is unsaved — the user can undo it with one keystroke.`,
              },
            ],
          }
        }),
      ],
    }),
  }
}
