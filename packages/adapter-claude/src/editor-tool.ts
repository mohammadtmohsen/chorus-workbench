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
  old_text: z
    .string()
    .describe(
      'The exact text currently in that range. Checked before anything is replaced, so a right-version-wrong-range edit is refused instead of overwriting the wrong lines. It is also what the user is shown as the "before" side of the diff.'
    ),
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
  'Requires base_version and old_text. Read the file first, pass the version you',
  'were given, and quote the exact text you are replacing.',
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
            oldText: args.old_text,
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

/** How the tool arrives in `canUseTool` once the SDK has namespaced it. */
export const EDITOR_EDIT_TOOL = 'mcp__chorus_editor__editor_edit'

/**
 * Turns the tool's arguments into what the approval card needs to show.
 *
 * **A unified diff over the replaced range only**, not the whole file. The
 * transcript already renders patches with `parseDiff`, so producing one here
 * means the editor-edit card is drawn by the same code as every other diff in
 * the app rather than by a second implementation that would drift from it.
 *
 * The hunk header counts lines rather than guessing: an agent deleting three
 * lines and adding one has to produce `-N,3 +N,1`, and a header that disagrees
 * with the body is a patch every renderer draws differently.
 *
 * Returns `null` when the arguments are not the shape the schema promises. The
 * caller then falls through to the generic MCP approval, which is worse to look
 * at but is never wrong — better than a card built from half-read values.
 */
export function editorEditApproval(input: Readonly<Record<string, unknown>>): {
  path: string
  version: number
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number }
  patch: string
} | null {
  const path = input['path']
  const version = input['base_version']
  const oldText = input['old_text']
  const newText = input['new_text']
  const nums = ['start_line', 'start_column', 'end_line', 'end_column'] as const
  if (typeof path !== 'string' || path === '') return null
  if (typeof version !== 'number' || typeof oldText !== 'string' || typeof newText !== 'string') {
    return null
  }
  if (!nums.every((k) => typeof input[k] === 'number')) return null

  const startLine = input['start_line'] as number
  /*
   * A trailing newline would otherwise produce a phantom empty line on both
   * sides of the diff, which reads as a change nobody made.
   */
  const split = (text: string): string[] => (text === '' ? [] : text.split('\n'))
  const before = split(oldText)
  const after = split(newText)
  const patch = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${String(startLine)},${String(before.length)} +${String(startLine)},${String(after.length)} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join('\n')

  return {
    path,
    version,
    range: {
      startLine,
      startColumn: input['start_column'] as number,
      endLine: input['end_line'] as number,
      endColumn: input['end_column'] as number,
    },
    patch,
  }
}
