import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AGENT_IDS } from '@chorus/shared'
import { describe, expect, it } from 'vitest'
import {
  collaborationPair,
  isExpandedCollaboration,
  isTeamCommand,
  originalCollaborationText,
} from './collaboration.js'

const TASK = '@codex work with @claude on saved searches'
const LEGACY = `@codex Run this task collaboratively with claude.

# TASK

${TASK}

# ROLES AND SCOPE

You, codex, are the lead and coordinator. claude is your collaborator.

# 0. HOW TO HAND OVER — THE RUN STOPS WITHOUT THIS

Scope and handoff instructions.

- A reply whose next step belongs to claude and which does not end with an @claude line stops the run.`

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8').trimEnd()
}

const SHIPPED_0_20_0 = fixture('collaboration-prompt-0.20.0.txt')
const APPENDED = fixture('collaboration-prompt-appended.txt')
const APPENDED_EARLY = fixture('collaboration-prompt-appended-early.txt')
const TYPED = '@claude work with @deepseek on saved searches'

function render(
  template: string,
  values: { readonly leader: string; readonly partner: string; readonly task: string }
): string {
  return template.replace(
    /\{\{(leader|partner|task)\}\}/g,
    (_, key: keyof typeof values) => values[key]
  )
}

function shipped(task: string, leader = 'codex', partner = 'claude'): string {
  return render(SHIPPED_0_20_0, { leader, partner, task })
}

function appendedPrompt(template: string): string {
  return render(template, { leader: 'claude', partner: 'deepseek', task: '' })
}

function appended(template: string, typed = TYPED): string {
  return `${typed}\n\n${appendedPrompt(template)}`
}

describe('collaborationPair', () => {
  it.each([
    ['codex', 'claude'],
    ['codex', 'deepseek'],
    ['claude', 'codex'],
    ['claude', 'deepseek'],
    ['deepseek', 'codex'],
    ['deepseek', 'claude'],
  ])('uses mention order for %s and %s', (leader, partner) => {
    expect(collaborationPair(`@${leader} work with @${partner}`, AGENT_IDS)).toEqual({
      leader,
      partner,
    })
  })

  it('requires two distinct explicit participating names', () => {
    expect(collaborationPair('@codex review what claude wrote', AGENT_IDS)).toBeNull()
    expect(collaborationPair('@codex @codex fix it', AGENT_IDS)).toBeNull()
    expect(collaborationPair('@deepseek @codex fix it', ['codex', 'claude'])).toBeNull()
    expect(collaborationPair('email@codex.dev @claude', AGENT_IDS)).toBeNull()
  })

  it('skips unknown names and duplicates and stops after the second distinct match', () => {
    expect(
      collaborationPair('@nobody @CODEX @codex work with @deepseek and @claude', AGENT_IDS)
    ).toEqual({ leader: 'codex', partner: 'deepseek' })
  })
})

describe('historical collaboration messages', () => {
  it('recovers the short task with trailing context and attachment paths intact', () => {
    const extra = '\n\nWorkbench context:\n```ts\nconst task = 1\n```\n\n"/tmp/image one.png"'
    expect(originalCollaborationText(LEGACY + extra)).toBe(TASK + extra)
  })

  it('unwraps an already nested history entry', () => {
    const nested = LEGACY.replace(TASK, LEGACY)
    expect(originalCollaborationText(nested)).toBe(TASK)
  })

  it('leaves incomplete and quoted envelopes alone', () => {
    expect(originalCollaborationText(LEGACY.slice(0, -25))).toBe(LEGACY.slice(0, -25))
    const quoted = `Explain this prompt:\n\n${LEGACY}`
    expect(originalCollaborationText(quoted)).toBe(quoted)
    expect(isExpandedCollaboration(quoted)).toBe(false)
    expect(originalCollaborationText(TASK)).toBe(TASK)
  })

  it('recovers the task from the prompt 0.20.0 shipped, keeping context and paths', () => {
    const extra = '\n\nWorkbench context:\n```ts\nconst task = 1\n```\n\n"/tmp/image one.png"'
    expect(originalCollaborationText(shipped(TASK))).toBe(TASK)
    expect(originalCollaborationText(shipped(TASK) + extra)).toBe(TASK + extra)
    const reversed = '@deepseek work with @codex'
    expect(originalCollaborationText(shipped(reversed, 'deepseek', 'codex'))).toBe(reversed)
  })

  it('unwraps a 0.20.0 prompt nested in itself or in the current template', () => {
    expect(originalCollaborationText(shipped(shipped(TASK)))).toBe(TASK)
    expect(originalCollaborationText(shipped(LEGACY))).toBe(TASK)
    expect(originalCollaborationText(LEGACY.replace(TASK, () => shipped(TASK)))).toBe(TASK)
  })

  it('leaves an incomplete or quoted 0.20.0 prompt alone', () => {
    const incomplete = shipped(TASK).slice(0, -25)
    expect(originalCollaborationText(incomplete)).toBe(incomplete)
    const quoted = `Explain this prompt:\n\n${shipped(TASK)}`
    expect(originalCollaborationText(quoted)).toBe(quoted)
    expect(isExpandedCollaboration(shipped(TASK))).toBe(true)
  })

  it.each([
    ['appended', APPENDED],
    ['early appended', APPENDED_EARLY],
  ])('recovers the typed text from the %s prompt, keeping context and paths', (_, template) => {
    const extra =
      "\n\nEditor context: `src/a.ts:3` `v1`\n\n```ts\nconst a = 1\n```\n\n'/tmp/image one.png'"
    expect(originalCollaborationText(appended(template))).toBe(TYPED)
    expect(originalCollaborationText(appended(template) + extra)).toBe(TYPED + extra)
  })

  it('unwraps an appended prompt nested in another or in an envelope', () => {
    expect(originalCollaborationText(appended(APPENDED, appended(APPENDED)))).toBe(TYPED)
    expect(originalCollaborationText(appended(APPENDED, appended(APPENDED_EARLY)))).toBe(TYPED)
    expect(originalCollaborationText(shipped(appended(APPENDED)))).toBe(TYPED)
  })

  it('leaves pasted, unaddressed and incomplete appended prompts alone', () => {
    const pasted = `Explain this prompt:\n\n${appendedPrompt(APPENDED)}`
    expect(originalCollaborationText(pasted)).toBe(pasted)
    const inline = `@claude replace the prompt with this ${appendedPrompt(APPENDED_EARLY)}`
    expect(originalCollaborationText(inline)).toBe(inline)
    for (const template of [APPENDED, APPENDED_EARLY]) {
      const incomplete = appended(template).slice(0, -25)
      expect(originalCollaborationText(incomplete)).toBe(incomplete)
    }
  })

  it('recognizes an unknown envelope even when its task cannot be safely recovered', () => {
    const old = LEGACY.replace('# ROLES AND SCOPE', '# ROLES')
    expect(originalCollaborationText(old)).toBe(old)
    expect(isExpandedCollaboration(old)).toBe(true)
    expect(isExpandedCollaboration(TASK)).toBe(false)
  })

  it('does not mistake a nested known template for an unknown outer template', () => {
    const nested = LEGACY.replace('# ROLES AND SCOPE', '# ROLES').replace(TASK, LEGACY)
    expect(originalCollaborationText(nested)).toBe(nested)
    expect(isExpandedCollaboration(nested)).toBe(true)
  })
})

describe('/team', () => {
  it('recognizes only the leading command token', () => {
    expect(isTeamCommand('/team')).toBe(true)
    expect(isTeamCommand('  /team\nextra context')).toBe(true)
    expect(isTeamCommand('/teamwork')).toBe(false)
    expect(isTeamCommand('please discuss /team')).toBe(false)
    expect(isTeamCommand('@codex review /team')).toBe(false)
  })
})
