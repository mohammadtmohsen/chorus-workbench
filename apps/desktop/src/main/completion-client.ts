import { performance } from 'node:perf_hooks'
import type { Logger } from '@chorus/shared'
import { readAgentKey, type SecretId } from './agent-secrets.js'
import { readSettings } from './settings.js'
import {
  COMPLETION_CHARACTERS_PER_SIDE,
  COMPLETION_CONTEXT_SNIPPETS,
  COMPLETION_PATH_LIMIT,
  COMPLETION_SNIPPET_SOURCE_CHARACTERS,
  assembleContext,
  type CompletionPayload,
  type CompletionReply,
} from '../shared/workbench-ipc.js'

export type CompletionProvider = 'deepseek' | 'codestral'

type CompletionLog = Pick<Logger, 'warn' | 'info'>

interface ResolvedCompletion {
  readonly provider: CompletionProvider
  readonly key: string
}

const TIMEOUT_MS = 2000
const MAX_TOKENS = 64
const STOP = ['\n\n']
const LANGUAGE_ID_LIMIT = 64

const SECRETS: Record<CompletionProvider, SecretId> = {
  deepseek: 'completion-deepseek',
  codestral: 'completion-codestral',
}

const ENDPOINTS: Record<CompletionProvider, { readonly url: string; readonly model: string }> = {
  deepseek: { url: 'https://api.deepseek.com/beta/completions', model: 'deepseek-flash' },
  codestral: { url: 'https://api.mistral.ai/v1/fim/completions', model: 'codestral-latest' },
}

export const PROVIDER_ORDER: readonly CompletionProvider[] = ['deepseek', 'codestral']

let log: CompletionLog = { warn: () => undefined, info: () => undefined }
let resolved: ResolvedCompletion | null | undefined

export function setCompletionLog(next: CompletionLog): void {
  log = next
}

export function invalidateCompletionCredential(): void {
  resolved = undefined
}

function resolveCompletion(userData: string): ResolvedCompletion | null {
  if (resolved !== undefined) return resolved

  const chosen = readSettings(userData).completionProvider
  const order: readonly CompletionProvider[] = chosen === 'auto' ? PROVIDER_ORDER : [chosen]

  for (const provider of order) {
    const key = readAgentKey(userData, SECRETS[provider])
    if (key !== null) {
      resolved = { provider, key }
      return resolved
    }
  }

  resolved = null
  return null
}

export function completionConfigured(userData: string): boolean {
  return resolveCompletion(userData) !== null
}

export function isCompletionPayload(value: unknown): value is CompletionPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const prefix = record['prefix']
  const suffix = record['suffix']
  const languageId = record['languageId']
  const path = record['path']

  if (typeof prefix !== 'string' || prefix.length > COMPLETION_CHARACTERS_PER_SIDE) return false
  if (typeof suffix !== 'string' || suffix.length > COMPLETION_CHARACTERS_PER_SIDE) return false
  if (typeof languageId !== 'string' || languageId.length > LANGUAGE_ID_LIMIT) return false
  if (path !== null && (typeof path !== 'string' || path.length > COMPLETION_PATH_LIMIT))
    return false

  const context = record['context']
  if (!Array.isArray(context) || context.length > COMPLETION_CONTEXT_SNIPPETS) return false
  for (const entry of context) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const snippet = entry as Record<string, unknown>
    const text = snippet['text']
    const snippetPath = snippet['path']
    if (typeof text !== 'string' || text.length > COMPLETION_SNIPPET_SOURCE_CHARACTERS) return false
    if (snippetPath === null) continue
    if (typeof snippetPath !== 'string' || snippetPath.length > COMPLETION_PATH_LIMIT) return false
  }
  return true
}

function readGeneratedText(provider: CompletionProvider, body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const choices = (body as Record<string, unknown>)['choices']
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first: unknown = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const choice = first as Record<string, unknown>

  let text: unknown
  if (provider === 'deepseek') {
    text = choice['text']
  } else {
    const message = choice['message']
    if (typeof message !== 'object' || message === null) return null
    text = (message as Record<string, unknown>)['content']
  }

  if (typeof text !== 'string') return null
  const trimmed = text.trimEnd()
  return trimmed === '' ? null : trimmed
}

interface CompletionOutcome {
  readonly finishReason: string | null
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
  readonly promptCacheHitTokens: number | null
  readonly promptCacheMissTokens: number | null
}

function reportedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function usageOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}
  const usage = (body as Record<string, unknown>)['usage']
  return typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {}
}

function readOutcome(body: unknown): CompletionOutcome {
  if (typeof body !== 'object' || body === null) {
    return {
      finishReason: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
    }
  }

  const record = body as Record<string, unknown>
  const usage = usageOf(body)
  const choices = record['choices']
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined
  const choice =
    typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {}
  const finishReason = choice['finish_reason']

  return {
    finishReason: typeof finishReason === 'string' ? finishReason : null,
    promptTokens: reportedCount(usage['prompt_tokens']),
    completionTokens: reportedCount(usage['completion_tokens']),
    totalTokens: reportedCount(usage['total_tokens']),
    promptCacheHitTokens: reportedCount(usage['prompt_cache_hit_tokens']),
    promptCacheMissTokens: reportedCount(usage['prompt_cache_miss_tokens']),
  }
}

const EDITOR_REPORT_KINDS = new Set<string>([
  'snoozed',
  'cancelled',
  'no-suggestion',
  'not-configured',
  'returned',
  'shown',
  'returned-not-shown',
  'language-service',
  'context-collection',
])

function reportedMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

export function recordEditorOutcome(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const record = raw as Record<string, unknown>
  const requestId = record['requestId']
  const outcome = record['outcome']
  if (typeof requestId !== 'string' || requestId === '') return
  if (typeof outcome !== 'string' || !EDITOR_REPORT_KINDS.has(outcome)) return

  const providerReturnedMs = reportedMs(record['providerReturnedMs'])
  const itemShownAfterReturnMs = reportedMs(record['itemShownAfterReturnMs'])
  const query = record['languageServiceQuery']
  const queryMs = reportedMs(record['queryMs'])
  const providerMissing = record['providerMissing'] === true
  const queryTimedOut = record['queryTimedOut'] === true
  const emptyQueries = reportedCount(record['emptyQueries'])
  const totalQueries = reportedCount(record['totalQueries'])
  const snippetResolveMs = reportedCount(record['snippetResolveMs'])
  const extents = record['snippetExtents']
  const snippetExtents = Array.isArray(extents)
    ? extents.filter((value): value is number => reportedCount(value) !== null).slice(0, 32)
    : null
  const paths = record['snippetPaths']
  const snippetPaths = Array.isArray(paths)
    ? paths
        .filter((value): value is string | null => value === null || typeof value === 'string')
        .slice(0, 32)
        .map((value) => (value === null ? null : value.slice(0, COMPLETION_PATH_LIMIT)))
    : null
  const context = record['memberContext']
  const memberContext = typeof context === 'boolean' ? context : null
  const matched = record['memberReceiverMatched']
  const memberReceiverMatched = typeof matched === 'boolean' ? matched : null
  const memberCount = reportedCount(record['memberCount'])
  const type = record['typeContext']
  const typeContext = typeof type === 'boolean' ? type : null
  const expanded = record['typeExpanded']
  const typeExpanded = typeof expanded === 'boolean' ? expanded : null
  const typeAnchors = reportedCount(record['typeAnchors'])
  const typeResolved = reportedCount(record['typeResolved'])
  const stale = record['typeStale']
  const typeStale = typeof stale === 'boolean' ? stale : null

  log.info('completion outcome', {
    requestId,
    outcome,
    ...(providerReturnedMs === undefined ? {} : { providerReturnedMs }),
    ...(itemShownAfterReturnMs === undefined ? {} : { itemShownAfterReturnMs }),
    ...(query === 'definitions' || query === 'typeDefinitions' ? { query } : {}),
    ...(queryMs === undefined ? {} : { queryMs }),
    ...(providerMissing ? { providerMissing } : {}),
    ...(queryTimedOut ? { queryTimedOut } : {}),
    ...(emptyQueries === null ? {} : { emptyQueries }),
    ...(totalQueries === null ? {} : { totalQueries }),
    ...(snippetResolveMs === null ? {} : { snippetResolveMs }),
    ...(snippetExtents === null ? {} : { snippetExtents }),
    ...(snippetPaths === null ? {} : { snippetPaths }),
    ...(memberContext === null ? {} : { memberContext }),
    ...(memberCount === null ? {} : { memberCount }),
    ...(memberReceiverMatched === null ? {} : { memberReceiverMatched }),
    ...(typeContext === null ? {} : { typeContext }),
    ...(typeAnchors === null ? {} : { typeAnchors }),
    ...(typeExpanded === null ? {} : { typeExpanded }),
    ...(typeResolved === null ? {} : { typeResolved }),
    ...(typeStale === null ? {} : { typeStale }),
  })
}

const usageKeysReported = new Set<CompletionProvider>()

function reportUsageKeys(provider: CompletionProvider, body: unknown): void {
  if (usageKeysReported.has(provider)) return
  usageKeysReported.add(provider)
  log.info('completion usage keys', { provider, keys: Object.keys(usageOf(body)).sort() })
}

export async function requestCompletion(
  userData: string,
  requestId: string,
  payload: CompletionPayload,
  callerSignal: AbortSignal,
  timeoutMs: number = TIMEOUT_MS
): Promise<CompletionReply> {
  const credential = resolveCompletion(userData)
  if (credential === null) {
    log.info('completion skipped', { requestId, reason: 'no key for the chosen provider' })
    return { configured: false, text: null }
  }

  const provider = credential.provider
  const assembledContext = assembleContext(payload.languageId, payload.context)
  log.info('completion requested', {
    requestId,
    provider,
    prefix: payload.prefix.length,
    context: payload.context.length,
    contextChars: assembledContext.text.length,
    snippetsWhole: assembledContext.whole,
  })
  const endpoint = ENDPOINTS[provider]
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([callerSignal, timeoutSignal])
  const issuedAt = performance.now()

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: endpoint.model,
        prompt: `${assembledContext.text}${payload.prefix}`,
        suffix: payload.suffix,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stop: STOP,
        stream: false,
      }),
      signal,
    })

    const responseHeaderArrivalMs = Math.round(performance.now() - issuedAt)

    if (!response.ok) {
      log.warn('completion request refused', {
        requestId,
        provider,
        status: response.status,
        responseHeaderArrivalMs,
      })
      return { configured: true, text: null }
    }

    const body: unknown = await response.json()
    const responseBodyParsedMs = Math.round(performance.now() - issuedAt)
    const text = readGeneratedText(provider, body)
    const outcome = readOutcome(body)
    if (outcome.promptCacheHitTokens === null && outcome.promptCacheMissTokens === null) {
      reportUsageKeys(provider, body)
    }
    log.info('completion answered', {
      requestId,
      provider,
      chars: text === null ? 0 : text.length,
      responseHeaderArrivalMs,
      responseBodyParsedMs,
      ...outcome,
    })
    return { configured: true, text }
  } catch {
    if (callerSignal.aborted) return { configured: true, text: null }
    const elapsedMs = Math.round(performance.now() - issuedAt)
    if (timeoutSignal.aborted) {
      log.warn('completion request timed out', { requestId, provider, elapsedMs })
      return { configured: true, text: null }
    }
    log.warn('completion request failed', { requestId, provider, elapsedMs })
    return { configured: true, text: null }
  }
}

const PROBE_SIZES = [2400, 8000, 16_000] as const
const PROBE_REPEAT_DELAYS_MS = [0, 2000, 10_000] as const
const PROBE_LINE = 'const value = compute(input, options)\n'
const PROBE_TIMEOUT_MS = 20_000

function probePayload(characters: number): CompletionPayload {
  const prefix = PROBE_LINE.repeat(Math.ceil(characters / PROBE_LINE.length)).slice(0, characters)
  return { prefix, suffix: '', languageId: 'typescript', path: null, context: [] }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function probeCompletionCache(userData: string): Promise<void> {
  for (const size of PROBE_SIZES) {
    const payload = probePayload(size)
    const firstSentAt = performance.now()
    let previous = 0
    for (const intendedDelayMs of PROBE_REPEAT_DELAYS_MS) {
      if (intendedDelayMs > previous) await wait(intendedDelayMs - previous)
      previous = intendedDelayMs
      log.info('completion probe sending', {
        size,
        intendedDelayMs,
        actualElapsedMs: Math.round(performance.now() - firstSentAt),
      })
      await requestCompletion(
        userData,
        `probe-${String(size)}-${String(intendedDelayMs)}`,
        payload,
        new AbortController().signal,
        PROBE_TIMEOUT_MS
      )
    }
  }
}
