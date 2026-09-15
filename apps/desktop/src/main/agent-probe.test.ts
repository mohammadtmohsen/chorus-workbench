import type { AgentProbeResult } from '../shared/ipc.js'
import { describe, expect, it } from 'vitest'
import { deepseekFrom } from './agent-probe.js'

/**
 * DeepSeek's row is Claude's answer with one extra condition.
 *
 * It runs on the same `claude` binary, so probing it separately would spawn
 * `claude --version` twice and print the same string under two names. The rule
 * this covers is the one thing that differs: the key.
 */
const CLAUDE_OK: AgentProbeResult = {
  id: 'claude',
  installed: true,
  version: '2.1.220',
  problem: null,
  reason: null,
  foundAt: null,
}

const CLAUDE_MISSING: AgentProbeResult = {
  id: 'claude',
  installed: false,
  version: null,
  problem: 'spawn claude ENOENT',
  reason: 'missing',
  foundAt: null,
}

describe('the DeepSeek probe row', () => {
  it('is ready when the CLI is there and a key is stored', () => {
    const row = deepseekFrom(CLAUDE_OK, true)
    expect(row).toMatchObject({ id: 'deepseek', installed: true, version: '2.1.220' })
  })

  it('asks for a key rather than for an install when only the key is missing', () => {
    /*
     * The loop this avoids: `missing` renders an install command, and telling
     * someone to install a CLI that is already on their machine sends them
     * round exactly the path this file's missing/failed split exists to stop.
     */
    const row = deepseekFrom(CLAUDE_OK, false)
    expect(row.reason).toBe('needsKey')
    expect(row.installed).toBe(false)
    // The version is kept: the install is fine and saying so is the point.
    expect(row.version).toBe('2.1.220')
  })

  it('reports the install problem, not the key, when the CLI is missing', () => {
    // Both are missing here. Asking for a key first would be the wrong advice:
    // a key is no use without the binary that carries it.
    const row = deepseekFrom(CLAUDE_MISSING, false)
    expect(row.reason).toBe('missing')
    expect(row.id).toBe('deepseek')
  })

  it('never leaves Claude’s id on the derived row', () => {
    for (const claude of [CLAUDE_OK, CLAUDE_MISSING]) {
      for (const hasKey of [true, false]) {
        expect(deepseekFrom(claude, hasKey).id).toBe('deepseek')
      }
    }
  })
})
