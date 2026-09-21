import { beforeEach, describe, expect, it } from 'vitest'
import { clearResolveCache, compare, resolveCommand, type ResolveDeps } from './which.js'

describe('compare', () => {
  it('orders by number, not by text', () => {
    // The bug this exists for: 0.42.0 sorted above 0.146.0 as strings, and
    // 0.42.0 is old enough that `codex app-server` will not start.
    expect(compare([0, 146, 0], [0, 42, 0])).toBeGreaterThan(0)
  })

  it('compares major before minor before patch', () => {
    expect(compare([1, 0, 0], [0, 999, 999])).toBeGreaterThan(0)
    expect(compare([1, 2, 0], [1, 1, 99])).toBeGreaterThan(0)
    expect(compare([1, 2, 3], [1, 2, 4])).toBeLessThan(0)
  })

  it('treats equal versions as equal', () => {
    expect(compare([2, 1, 220], [2, 1, 220])).toBe(0)
  })

  it('treats a missing part as zero', () => {
    expect(compare([1], [1, 0, 0])).toBe(0)
    expect(compare([1, 1], [1, 0, 5])).toBeGreaterThan(0)
  })
})

/**
 * Windows resolution end to end, against the machine this was found on.
 *
 * `command.test.ts` proves each parser in isolation. This proves the thing that
 * was actually wrong: which parser `upgrade` believes. Both shims are read
 * verbatim off `%APPDATA%\npm` on a real Windows box, and the two agents there
 * disagree — codex still runs a `.js`, claude 2.1.278 runs a native
 * `claude.exe`. A resolver that handles only one of them leaves the other
 * reporting healthy and failing at its first turn.
 *
 * `node.exe` is deliberately absent from `PRESENT`. It is quoted in the codex
 * shim and it comes first, so it is the wrong answer an executable-first
 * resolver would have taken.
 */
describe('resolveCommand on Windows, against shims off a real machine', () => {
  const NPM = 'C:\\Users\\user\\AppData\\Roaming\\npm'
  const CLAUDE_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`
  const CODEX_JS = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`

  const CLAUDE_CMD = [
    '@ECHO off',
    'CALL :find_dp0',
    `"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*`,
  ].join('\r\n')

  const CODEX_CMD = [
    '@ECHO off',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n')

  const PRESENT = new Set([`${NPM}\\claude.cmd`, `${NPM}\\codex.cmd`, CLAUDE_EXE, CODEX_JS])

  const deps: ResolveDeps = {
    platform: 'win32',
    env: {
      APPDATA: 'C:\\Users\\user\\AppData\\Roaming',
      PATH: NPM,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    },
    home: 'C:\\Users\\user',
    exists: (path) => PRESENT.has(path),
    readFile: (path) => {
      if (path === `${NPM}\\claude.cmd`) return CLAUDE_CMD
      if (path === `${NPM}\\codex.cmd`) return CODEX_CMD
      return null
    },
    realpath: (path) => path,
    shellCandidates: () => Promise.resolve([]),
    versionOf: ({ file }) => {
      if (file === CLAUDE_EXE) return Promise.resolve([2, 1, 278])
      if (file === 'node') return Promise.resolve([0, 153, 4])
      return Promise.resolve(null)
    },
  }

  beforeEach(() => {
    clearResolveCache()
  })

  it('launches claude as its native binary, with cmd.exe out of the way', async () => {
    expect(await resolveCommand('claude', deps)).toEqual({
      file: CLAUDE_EXE,
      argsPrefix: [],
      kind: 'native',
    })
  })

  it('still launches codex through node, not through the node.exe it does not have', async () => {
    expect(await resolveCommand('codex', deps)).toEqual({
      file: 'node',
      argsPrefix: [CODEX_JS],
      kind: 'node-script',
      scriptPath: CODEX_JS,
    })
  })

  /*
   * The degrade, kept rather than assumed. A shim whose target has been moved
   * or renamed must fall back to `cmd-shim` — which still launches — rather
   * than to a confident path at nothing.
   */
  it('falls back to the shim when the binary it names is gone', async () => {
    const moved: ResolveDeps = {
      ...deps,
      exists: (path) => path === `${NPM}\\claude.cmd`,
      versionOf: () => Promise.resolve([2, 1, 278]),
    }
    expect(await resolveCommand('claude', moved)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      argsPrefix: ['/d', '/s', '/c', `${NPM}\\claude.cmd`],
      kind: 'cmd-shim',
    })
  })
})
