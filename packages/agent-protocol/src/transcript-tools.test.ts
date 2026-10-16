import { describe, expect, it } from 'vitest'
import type { TranscriptRequest } from './adapter.js'
import {
  NO_TRANSCRIPT_READER,
  TRANSCRIPT_TOOL_INPUT_SCHEMA,
  TRANSCRIPT_TOOL_SHAPE,
  runTranscriptTool,
} from './transcript-tools.js'

const reading =
  (asked: TranscriptRequest[]) =>
  (request: TranscriptRequest): string => {
    asked.push(request)
    return 'records'
  }

describe('runTranscriptTool', () => {
  it('applies the defaults and passes nothing it was not given', () => {
    const asked: TranscriptRequest[] = []
    expect(runTranscriptTool(reading(asked), undefined)).toEqual({ ok: true, text: 'records' })
    expect(asked).toEqual([{ skip: 0, count: 20 }])
  })

  it('passes every field of a full request through', () => {
    const asked: TranscriptRequest[] = []
    const request = {
      skip: 3,
      count: 7,
      conversationId: 'conv-1',
      query: 'Retry-After',
      eventId: 'evt-9',
      offset: 4_096,
      scope: 'updates' as const,
    }
    expect(runTranscriptTool(reading(asked), request)).toEqual({ ok: true, text: 'records' })
    expect(asked).toEqual([request])
  })

  it('refuses invalid arguments without reading', () => {
    for (const args of [
      { count: 0 },
      { count: 51 },
      { skip: -1 },
      { offset: -5 },
      { query: '' },
      { query: 'x'.repeat(201) },
      { scope: 'everything' },
      { pattern: '.*' },
    ]) {
      const asked: TranscriptRequest[] = []
      const result = runTranscriptTool(reading(asked), args)
      expect(result.ok, JSON.stringify(args)).toBe(false)
      expect(result.text).toMatch(/^Invalid arguments: /)
      expect(asked).toEqual([])
    }
  })

  it('passes a forwarded read of one conversation through, with search and record fields', () => {
    const asked: TranscriptRequest[] = []
    const request = {
      skip: 1,
      count: 5,
      conversationId: 'child-1',
      query: 'pnpm test',
      eventId: 'evt-3',
      offset: 10,
      scope: 'forwarded' as const,
    }
    expect(runTranscriptTool(reading(asked), request)).toEqual({ ok: true, text: 'records' })
    expect(asked).toEqual([request])
  })

  it('lists forwarded conversations with paging only, refusing a search or record read', () => {
    const asked: TranscriptRequest[] = []
    expect(runTranscriptTool(reading(asked), { scope: 'forwarded', skip: 20, count: 50 })).toEqual({
      ok: true,
      text: 'records',
    })
    expect(asked).toEqual([{ skip: 20, count: 50, scope: 'forwarded' }])

    for (const args of [
      { scope: 'forwarded', query: 'B' },
      { scope: 'forwarded', eventId: 'evt-1' },
      { scope: 'forwarded', offset: 0 },
    ]) {
      const refused: TranscriptRequest[] = []
      const result = runTranscriptTool(reading(refused), args)
      expect(result.ok, JSON.stringify(args)).toBe(false)
      expect(result.text).toMatch(/^Invalid arguments: (query|eventId|offset): not accepted/)
      expect(refused).toEqual([])
    }
    expect(runTranscriptTool(reading([]), { query: 'B' }).ok).toBe(true)
  })

  it('offers the forwarded scope to both providers', () => {
    const properties = TRANSCRIPT_TOOL_INPUT_SCHEMA['properties'] as Record<
      string,
      { readonly enum?: readonly string[] }
    >
    expect(properties['scope']?.enum).toEqual(['snapshot', 'updates', 'forwarded'])
    expect(TRANSCRIPT_TOOL_SHAPE.scope.safeParse('forwarded').success).toBe(true)
  })

  it('fails without a reader instead of answering empty', () => {
    expect(runTranscriptTool(undefined, {})).toEqual({ ok: false, text: NO_TRANSCRIPT_READER })
  })

  it('reports a reader that throws as a bounded failure', () => {
    const result = runTranscriptTool(() => {
      throw new Error(`gone ${'x'.repeat(5_000)}`)
    }, {})
    expect(result.ok).toBe(false)
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(1_024)
  })

  it('describes the same fields to both providers', () => {
    const properties = TRANSCRIPT_TOOL_INPUT_SCHEMA['properties'] as Record<string, unknown>
    expect(Object.keys(properties).sort()).toEqual(Object.keys(TRANSCRIPT_TOOL_SHAPE).sort())
  })
})
