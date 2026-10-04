import { describe, expect, it } from 'vitest'
import {
  NO_PROJECT_READER,
  PROJECT_FAILURE_BYTES,
  PROJECT_TOOL_INPUT_SCHEMAS,
  PROJECT_TOOL_NAMES,
  PROJECT_TOOL_SHAPES,
  runProjectTool,
  type ProjectReader,
} from './project-tools.js'

interface Calls {
  readonly terminal: { lines: number }[]
  readonly traffic: { count: number; skip: number }[]
  readonly request: { captureId: string; requestId: string }[]
}

const recording = (): { reader: ProjectReader; calls: Calls } => {
  const calls: Calls = { terminal: [], traffic: [], request: [] }
  const reader: ProjectReader = {
    terminal: (request) => {
      calls.terminal.push({ ...request })
      return Promise.resolve('terminal')
    },
    traffic: (request) => {
      calls.traffic.push({ ...request })
      return Promise.resolve('traffic')
    },
    request: (request) => {
      calls.request.push({ ...request })
      return Promise.resolve('request')
    },
  }
  return { reader, calls }
}

const nothingCalled = (calls: Calls): void => {
  expect(calls.terminal).toEqual([])
  expect(calls.traffic).toEqual([])
  expect(calls.request).toEqual([])
}

describe('runProjectTool', () => {
  it('fails without a reader, for every tool, rather than answering empty', async () => {
    for (const name of PROJECT_TOOL_NAMES) {
      expect(await runProjectTool(undefined, name, {})).toEqual({
        ok: false,
        text: NO_PROJECT_READER,
      })
    }
  })

  it('refuses a tool it does not know, including run and stop', async () => {
    const { reader, calls } = recording()
    for (const name of ['run', 'stop', 'read_terminal ', 'READ_TERMINAL', '']) {
      const result = await runProjectTool(reader, name, {})
      expect(result.ok).toBe(false)
      expect(result.text).toMatch(/Unknown project tool/)
    }
    nothingCalled(calls)
  })

  it('applies the defaults when arguments are omitted or null', async () => {
    const { reader, calls } = recording()
    expect(await runProjectTool(reader, 'read_terminal', undefined)).toEqual({
      ok: true,
      text: 'terminal',
    })
    expect(await runProjectTool(reader, 'read_traffic', null)).toEqual({
      ok: true,
      text: 'traffic',
    })
    expect(calls.terminal).toEqual([{ lines: 200 }])
    expect(calls.traffic).toEqual([{ count: 20, skip: 0 }])
  })

  it('passes valid bounds through unchanged', async () => {
    const { reader, calls } = recording()
    await runProjectTool(reader, 'read_terminal', { lines: 1 })
    await runProjectTool(reader, 'read_terminal', { lines: 400 })
    await runProjectTool(reader, 'read_traffic', { count: 50, skip: 1_000 })
    await runProjectTool(reader, 'read_request', { captureId: 'c', requestId: 'r'.repeat(64) })
    expect(calls.terminal).toEqual([{ lines: 1 }, { lines: 400 }])
    expect(calls.traffic).toEqual([{ count: 50, skip: 1_000 }])
    expect(calls.request).toEqual([{ captureId: 'c', requestId: 'r'.repeat(64) }])
  })

  it('refuses every out-of-range, mistyped or extra argument before reading', async () => {
    const { reader, calls } = recording()
    const invalid: [string, unknown][] = [
      ['read_terminal', { lines: 0 }],
      ['read_terminal', { lines: 401 }],
      ['read_terminal', { lines: 1.5 }],
      ['read_terminal', { lines: '10' }],
      ['read_terminal', { lines: 10, projectId: 'p2' }],
      ['read_terminal', 'lines'],
      ['read_traffic', { count: 0 }],
      ['read_traffic', { count: 51 }],
      ['read_traffic', { skip: -1 }],
      ['read_traffic', { skip: 1_001 }],
      ['read_traffic', { projectId: 'p2' }],
      ['read_request', {}],
      ['read_request', { captureId: 'c' }],
      ['read_request', { captureId: '', requestId: 'r' }],
      ['read_request', { captureId: 'c', requestId: 'r'.repeat(65) }],
      ['read_request', { captureId: 7, requestId: 'r' }],
      ['read_request', { captureId: 'c', requestId: 'r', projectId: 'p2' }],
    ]
    for (const [name, args] of invalid) {
      const result = await runProjectTool(reader, name, args)
      expect(result.ok, `${name} ${JSON.stringify(args)}`).toBe(false)
      expect(result.text).toMatch(/^Invalid arguments: /)
    }
    nothingCalled(calls)
  })

  it('turns a reader failure into a failed result instead of throwing', async () => {
    const reader: ProjectReader = {
      terminal: () => Promise.reject(new Error('gone')),
      traffic: () => {
        throw new Error('thrown')
      },
      request: () => Promise.reject(new Error('also gone')),
    }
    expect(await runProjectTool(reader, 'read_terminal', {})).toEqual({ ok: false, text: 'gone' })
    expect(await runProjectTool(reader, 'read_traffic', {})).toEqual({ ok: false, text: 'thrown' })
    expect(
      await runProjectTool(reader, 'read_request', { captureId: 'c', requestId: 'r' })
    ).toEqual({ ok: false, text: 'also gone' })
  })
})

describe('bounding a failed result', () => {
  const bytesOf = (text: string): number => new TextEncoder().encode(text).length

  const rejecting = (message: string): ProjectReader => ({
    terminal: () => Promise.reject(new Error(message)),
    traffic: () => Promise.reject(new Error(message)),
    request: () => Promise.reject(new Error(message)),
  })

  it('cuts the validation message for an oversized unknown key', async () => {
    const { reader, calls } = recording()
    const result = await runProjectTool(reader, 'read_terminal', { ['k'.repeat(10_000)]: 1 })
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/^Invalid arguments: /)
    expect(bytesOf(result.text)).toBeLessThanOrEqual(PROJECT_FAILURE_BYTES)
    expect(result.text.endsWith('…')).toBe(true)
    nothingCalled(calls)
  })

  it('cuts a multibyte reader error on a character boundary, marker included', async () => {
    const euros = await runProjectTool(rejecting('€'.repeat(1_000)), 'read_terminal', {})
    expect(euros.ok).toBe(false)
    expect(bytesOf(euros.text)).toBeLessThanOrEqual(PROJECT_FAILURE_BYTES)
    expect(euros.text).toBe(`${'€'.repeat(340)}…`)

    const faces = await runProjectTool(rejecting('😀'.repeat(500)), 'read_traffic', {})
    expect(bytesOf(faces.text)).toBeLessThanOrEqual(PROJECT_FAILURE_BYTES)
    expect(faces.text).toBe(`${'😀'.repeat(255)}…`)
    expect(faces.text).not.toContain('�')
  })

  it('cuts an oversized unknown tool name', async () => {
    const { reader, calls } = recording()
    const result = await runProjectTool(reader, `run_${'x'.repeat(5_000)}`, {})
    expect(result.ok).toBe(false)
    expect(bytesOf(result.text)).toBeLessThanOrEqual(PROJECT_FAILURE_BYTES)
    nothingCalled(calls)
  })

  it('leaves a failure that fits, and a successful read, exactly as they were', async () => {
    const fits = 'a'.repeat(PROJECT_FAILURE_BYTES)
    expect(await runProjectTool(rejecting(fits), 'read_terminal', {})).toEqual({
      ok: false,
      text: fits,
    })
    const long = 'x'.repeat(100_000)
    const reader: ProjectReader = {
      terminal: () => Promise.resolve(long),
      traffic: () => Promise.resolve(long),
      request: () => Promise.resolve(long),
    }
    expect(await runProjectTool(reader, 'read_terminal', {})).toEqual({ ok: true, text: long })
  })
})

describe('the Codex input schemas', () => {
  it('describe exactly the arguments the zod shapes accept', () => {
    for (const name of PROJECT_TOOL_NAMES) {
      const schema = PROJECT_TOOL_INPUT_SCHEMAS[name]
      expect(schema['type']).toBe('object')
      expect(schema['additionalProperties']).toBe(false)
      expect(Object.keys(schema['properties'] as object).sort()).toEqual(
        Object.keys(PROJECT_TOOL_SHAPES[name]).sort()
      )
    }
    expect(PROJECT_TOOL_INPUT_SCHEMAS.read_request['required']).toEqual(['captureId', 'requestId'])
    expect(PROJECT_TOOL_INPUT_SCHEMAS.read_terminal['required']).toEqual([])
    expect(PROJECT_TOOL_INPUT_SCHEMAS.read_traffic['required']).toEqual([])
  })
})
