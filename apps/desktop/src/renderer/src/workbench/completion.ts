import { getService } from '@codingame/monaco-vscode-api'
import { ILanguageFeaturesService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/languageFeatures.service'
import { Range } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/range'
import { IInlineCompletionsService } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/inlineCompletionsService.service'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { ITextModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service'
import { IModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/model.service'
import { isCodeEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'
import { CancellationTokenSource } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import type { CancellationToken } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import { Position } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/position'
import type { ITextModel } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/model'
import type { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type { IRange } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/range'
import {
  CompletionItemKind,
  CompletionTriggerKind,
} from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages'
import type {
  CompletionItem,
  Definition,
  Hover,
  InlineCompletion,
  InlineCompletions,
  InlineCompletionsProvider,
  Location,
} from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages'
import { platformForRoot } from '@chorus/ide-protocol/paths'
import {
  COMPLETION_CHARACTERS_PER_SIDE,
  COMPLETION_CONTEXT_CHARACTERS,
  COMPLETION_CONTEXT_SNIPPETS,
  COMPLETION_SNIPPET_SOURCE_CHARACTERS,
  COMPLETION_TOKENS_PER_SIDE,
  assembleContext,
  commentPrefix,
  contextualise,
  type CompletionContextSnippet,
  type EditorReport,
  type CompletionPayload,
} from '../../../shared/workbench-ipc.js'
import { relativeTo } from './context.js'

const GROUP = 'chorus'

interface PendingCompletion {
  readonly requestId: string
  readonly returnedAt: number
  shown: boolean
}

const pending = new WeakMap<object, PendingCompletion>()

let snoozeReported = false

function reportOutcome(report: EditorReport): void {
  window.chorusWorkbench.reportEditorOutcome(report)
}

function cancelled(token: CancellationToken): boolean {
  return token.isCancellationRequested
}

export const COMPLETION_BUDGET = {
  tokensPerSide: COMPLETION_TOKENS_PER_SIDE,
  charactersPerSide: COMPLETION_CHARACTERS_PER_SIDE,
} as const

function prefixRange(model: ITextModel, position: Position, budget: number): Range {
  let startLine = position.lineNumber
  let startColumn = Math.max(1, position.column - budget)
  let remaining = budget - (position.column - startColumn)

  while (startColumn === 1 && startLine > 1) {
    const previous = startLine - 1
    const length = model.getLineLength(previous) + 1

    if (length > remaining) {
      if (remaining < 1) break
      startLine = previous
      startColumn = Math.max(1, model.getLineMaxColumn(previous) + 1 - remaining)
      break
    }

    remaining -= length
    startLine = previous
  }

  return new Range(startLine, startColumn, position.lineNumber, position.column)
}

function suffixRange(model: ITextModel, position: Position): Range {
  const budget = COMPLETION_BUDGET.charactersPerSide
  let endLine = position.lineNumber
  let endColumn = Math.min(model.getLineMaxColumn(endLine), position.column + budget)
  let remaining = budget - (endColumn - position.column)

  while (endColumn === model.getLineMaxColumn(endLine) && endLine < model.getLineCount()) {
    const following = endLine + 1
    const length = model.getLineLength(following) + 1

    if (length > remaining) {
      if (remaining < 1) break
      endLine = following
      endColumn = remaining
      break
    }

    remaining -= length
    endLine = following
    endColumn = model.getLineMaxColumn(following)
  }

  return new Range(position.lineNumber, position.column, endLine, endColumn)
}

export function completionPayload(
  model: ITextModel,
  position: Position,
  projectRoot: string,
  context: readonly CompletionContextSnippet[]
): CompletionPayload {
  const platform = platformForRoot(projectRoot, 'darwin')
  const languageId = model.getLanguageId()
  const assembled = assembleContext(languageId, context).text
  const budget = Math.max(0, COMPLETION_CHARACTERS_PER_SIDE - assembled.length)

  return {
    prefix: model.getValueInRange(prefixRange(model, position, budget)),
    suffix: model.getValueInRange(suffixRange(model, position)),
    languageId,
    path: relativeTo(projectRoot, model.uri.path, platform),
    context,
  }
}

const QUERY_POSITION_LIMIT = 8
const CURSOR_SCAN_LINES = 40
const DECLARATION_SCAN_LINES = 40
const CANDIDATES_PER_SOURCE = 32
const LINE_SCAN_COLUMNS = 2000

function wordsOnLine(model: ITextModel, lineNumber: number, into: Position[]): void {
  const maxColumn = Math.min(model.getLineMaxColumn(lineNumber), LINE_SCAN_COLUMNS + 1)
  let column = 1
  while (column < maxColumn && into.length < CANDIDATES_PER_SOURCE) {
    const word = model.getWordAtPosition(new Position(lineNumber, column))
    if (word === null) {
      column += 1
      continue
    }
    into.push(new Position(lineNumber, word.startColumn))
    column = word.endColumn + 1
  }
}

function scanLines(model: ITextModel, from: number, to: number, cursor: Position): Position[] {
  const found: Position[] = []
  for (let line = from; line <= to; line += 1) {
    if (found.length >= CANDIDATES_PER_SOURCE) break
    wordsOnLine(model, line, found)
  }
  const distance = (position: Position): number => Math.abs(position.lineNumber - cursor.lineNumber)
  return found.sort((a, b) => distance(a) - distance(b))
}

function keyOf(position: Position): string {
  return `${String(position.lineNumber)}:${String(position.column)}`
}

export function queryPositions(model: ITextModel, cursor: Position): Position[] {
  const lineCount = model.getLineCount()
  const near = scanLines(
    model,
    Math.max(1, cursor.lineNumber - CURSOR_SCAN_LINES),
    Math.min(lineCount, cursor.lineNumber + CURSOR_SCAN_LINES),
    cursor
  )
  const declarations = scanLines(model, 1, Math.min(lineCount, DECLARATION_SCAN_LINES), cursor)

  const out: Position[] = []
  const seen = new Set<string>()
  const take = (position: Position | undefined): boolean => {
    if (position === undefined || out.length >= QUERY_POSITION_LIMIT) return false
    const key = keyOf(position)
    if (seen.has(key)) return true
    seen.add(key)
    out.push(position)
    return true
  }

  for (let index = 0; out.length < QUERY_POSITION_LIMIT; index += 1) {
    const first = take(near[index])
    const second = take(declarations[index])
    if (!first && !second) break
  }

  return out
}

const MEMBER_LIST_LIMIT = 64
const MEMBER_RECEIVER_LIMIT = 64

const MEMBER_WORD_CHARACTER = /[\p{L}\p{N}_$]/u
const MEMBER_RECEIVER_CHARACTER = /[\p{L}\p{N}_$[\]()?.]/u

interface MemberSite {
  readonly position: Position
  readonly receiver: string
}

export interface MemberContext {
  readonly receiver: string
  readonly position: Position
  readonly members: readonly string[]
}

interface MemberSelection {
  readonly members: readonly string[] | null
  readonly matched: boolean
}

type EditorFacts = Pick<
  EditorReport,
  | 'memberContext'
  | 'memberCount'
  | 'memberReceiverMatched'
  | 'typeContext'
  | 'typeAnchors'
  | 'typeExpanded'
>

function memberSite(model: ITextModel, position: Position): MemberSite | null {
  const line = model.getLineContent(position.lineNumber)
  let index = position.column - 2

  while (index >= 0 && MEMBER_WORD_CHARACTER.test(line.charAt(index))) index -= 1
  while (index >= 0 && (line.charAt(index) === ' ' || line.charAt(index) === '\t')) index -= 1
  if (index < 0 || line.charAt(index) !== '.') return null
  if (index > 0 && line.charAt(index - 1) === '.') return null

  let start = index - 1
  let length = 0
  while (
    start >= 0 &&
    length < MEMBER_RECEIVER_LIMIT &&
    MEMBER_RECEIVER_CHARACTER.test(line.charAt(start))
  ) {
    start -= 1
    length += 1
  }

  const receiver = line.slice(start + 1, index)
  if (receiver === '') return null
  return { position: new Position(position.lineNumber, index + 2), receiver }
}

const MEMBER_EXCLUDED_KINDS: ReadonlySet<CompletionItemKind> = new Set([
  CompletionItemKind.Text,
  CompletionItemKind.Snippet,
  CompletionItemKind.Keyword,
  CompletionItemKind.File,
  CompletionItemKind.Folder,
])

function memberNames(suggestions: readonly CompletionItem[]): string[] {
  const names: string[] = []
  for (const item of suggestions) {
    if (MEMBER_EXCLUDED_KINDS.has(item.kind)) continue
    const name = typeof item.label === 'string' ? item.label : item.label.label
    if (name !== '') names.push(name)
  }
  return names
}

async function collectMembers(
  features: ILanguageFeaturesService,
  model: ITextModel,
  site: MemberSite,
  token: CancellationToken
): Promise<MemberContext | null> {
  for (const provider of features.completionProvider.ordered(model)) {
    const list = await Promise.resolve(
      provider.provideCompletionItems(
        model,
        site.position,
        { triggerKind: CompletionTriggerKind.Invoke },
        token
      )
    ).catch(() => null)
    if (list === null || list === undefined) continue

    try {
      const names = memberNames(list.suggestions)
      if (names.length === 0) continue
      if (names.length > MEMBER_LIST_LIMIT) return null
      return { receiver: site.receiver, position: site.position, members: names }
    } finally {
      list.dispose?.()
    }
  }

  return null
}

function memberBlockText(
  languageId: string,
  members: readonly string[],
  room: number
): { readonly text: string; readonly count: number } | null {
  const marker = commentPrefix(languageId)
  const taken: string[] = []
  let characters = 0

  for (const member of members) {
    const addition = (taken.length === 0 ? 0 : 1) + marker.length + 1 + member.length
    if (characters + addition > room) break
    characters += addition
    taken.push(member)
  }

  return taken.length === 0 ? null : { text: taken.join('\n'), count: taken.length }
}

function memberSelection(
  model: ITextModel,
  position: Position,
  captured: MemberContext | null
): MemberSelection {
  if (captured === null) return { members: null, matched: false }

  const site = memberSite(model, position)
  if (site === null) return { members: null, matched: false }
  if (
    site.receiver !== captured.receiver ||
    site.position.lineNumber !== captured.position.lineNumber ||
    site.position.column !== captured.position.column
  ) {
    return { members: null, matched: false }
  }

  return { members: captured.members, matched: true }
}

interface PackedContext {
  readonly context: readonly CompletionContextSnippet[]
  readonly types: boolean
  readonly members: number
}

function definitionBlocks(
  projectRoot: string,
  snippets: readonly ResolvedSnippet[]
): CompletionContextSnippet[] {
  const platform = platformForRoot(projectRoot, 'darwin')
  return snippets.map((snippet) => ({
    text: snippet.text,
    path: relativeTo(projectRoot, snippet.uri.path, platform),
  }))
}

function packContext(
  languageId: string,
  types: string | null,
  members: readonly string[] | null,
  definitions: readonly CompletionContextSnippet[]
): PackedContext {
  const context: CompletionContextSnippet[] = []
  let total = 0
  const step = (): number => (context.length === 0 ? 1 : 2)

  const admit = (snippet: CompletionContextSnippet): boolean => {
    const block = contextualise(languageId, snippet)
    const addition = block.length + step()
    if (total + addition > COMPLETION_CONTEXT_CHARACTERS) return false
    total += addition
    context.push(snippet)
    return true
  }

  const admittedTypes = types !== null && admit({ text: types, path: null })

  let admittedMembers = 0
  if (members !== null && context.length < COMPLETION_CONTEXT_SNIPPETS) {
    const room = COMPLETION_CONTEXT_CHARACTERS - total - step()
    const bounded = memberBlockText(languageId, members, room)
    if (bounded !== null && admit({ text: bounded.text, path: null })) {
      admittedMembers = bounded.count
    }
  }

  for (const snippet of definitions) {
    if (context.length >= COMPLETION_CONTEXT_SNIPPETS) break
    admit(snippet)
  }

  return { context, types: admittedTypes, members: admittedMembers }
}

const ANCHOR_SCAN_CHARACTERS = 400

interface AnchorRef {
  readonly position: Position
  readonly token: string
}

export interface TypeContext {
  readonly detected: readonly AnchorRef[]
  readonly resolved: number
  readonly text: string
  readonly expanded: boolean
}

interface TypeSelection {
  readonly text: string | null
  readonly anchors: number
  readonly resolved: number
  readonly expanded: boolean
  readonly stale: boolean
}

interface HoverText {
  readonly text: string
  readonly expanded: boolean
}

function openParen(line: string, cursor: number, limit: number): number {
  let index = cursor
  let depth = 0

  if (line.charAt(index) === ')') {
    depth = 1
    index -= 1
  }

  while (index >= limit) {
    const character = line.charAt(index)
    if (character === ')') depth += 1
    else if (character === '(') {
      depth -= 1
      if (depth <= 0) return index
    }
    index -= 1
  }

  return -1
}

function callAnchors(model: ITextModel, position: Position): AnchorRef[] {
  const line = model.getLineContent(position.lineNumber)
  const cursor = position.column - 2
  if (cursor < 0) return []

  const limit = Math.max(0, cursor - ANCHOR_SCAN_CHARACTERS)
  const closed = line.charAt(cursor) === ')'
  const open = openParen(line, cursor, limit)
  if (open < 0) return []

  let end = open - 1
  while (end >= limit && (line.charAt(end) === ' ' || line.charAt(end) === '\t')) end -= 1
  if (end < limit) return []

  let start = end
  while (start >= limit && MEMBER_WORD_CHARACTER.test(line.charAt(start))) start -= 1

  const callee = line.slice(start + 1, end + 1)
  if (callee === '') return []

  const anchors: AnchorRef[] = [
    { position: new Position(position.lineNumber, start + 2), token: callee },
  ]

  let argumentEnd = closed ? cursor - 1 : cursor
  while (
    argumentEnd > open &&
    (line.charAt(argumentEnd) === ' ' || line.charAt(argumentEnd) === '\t')
  ) {
    argumentEnd -= 1
  }

  let argumentStart = argumentEnd
  let length = 0
  while (
    argumentStart > open &&
    length < MEMBER_RECEIVER_LIMIT &&
    MEMBER_RECEIVER_CHARACTER.test(line.charAt(argumentStart))
  ) {
    argumentStart -= 1
    length += 1
  }

  const argument = line.slice(argumentStart + 1, argumentEnd + 1)
  const last = argument.charAt(argument.length - 1)
  if (last !== '' && last !== '.' && last !== '?') {
    anchors.push({
      position: new Position(position.lineNumber, argumentEnd + 1),
      token: argument,
    })
  }

  return anchors
}

function sameAnchors(derived: readonly AnchorRef[], captured: readonly AnchorRef[]): boolean {
  if (derived.length !== captured.length) return false

  for (let index = 0; index < derived.length; index += 1) {
    const left = derived[index]
    const right = captured[index]
    if (left === undefined || right === undefined) return false
    if (left.token !== right.token) return false
    if (left.position.lineNumber !== right.position.lineNumber) return false
    if (left.position.column !== right.position.column) return false
  }

  return true
}

function hoverText(hover: Hover): string | null {
  const lines: string[] = []

  for (const content of hover.contents) {
    const entry = content.value.split('\n')
    const opening = entry.find((line) => line.trim() !== '')
    if (opening?.trim().startsWith('```') !== true) continue

    for (const line of entry) {
      if (line.trim().startsWith('```')) continue
      lines.push(line)
    }
  }

  const text = lines.join('\n').trim()
  return text === '' ? null : text
}

async function hoverFor(
  features: ILanguageFeaturesService,
  model: ITextModel,
  at: Position,
  token: CancellationToken
): Promise<HoverText | null> {
  for (const provider of features.hoverProvider.ordered(model)) {
    const first = await Promise.resolve(provider.provideHover(model, at, token)).catch(() => null)
    if (first === null || first === undefined) continue

    const plain = hoverText(first)
    if (plain === null) continue
    if (first.canIncreaseVerbosity !== true) return { text: plain, expanded: false }

    const deeper = await Promise.resolve(
      provider.provideHover(model, at, token, {
        verbosityRequest: { previousHover: first, verbosityDelta: 1 },
      })
    ).catch(() => null)
    if (deeper === null || deeper === undefined) return { text: plain, expanded: false }

    const expanded = hoverText(deeper)
    return expanded === null ? { text: plain, expanded: false } : { text: expanded, expanded: true }
  }

  return null
}

async function collectTypes(
  features: ILanguageFeaturesService,
  model: ITextModel,
  position: Position,
  token: CancellationToken
): Promise<TypeContext | null> {
  const found = callAnchors(model, position)
  if (found.length === 0) return null

  const anchors: AnchorRef[] = []
  const parts: string[] = []
  let expanded = false

  for (const anchor of found) {
    const hover = await hoverFor(features, model, anchor.position, token)
    if (hover === null) continue
    anchors.push(anchor)
    if (hover.expanded) expanded = true
    parts.push(`${anchor.token}\n${hover.text}`)
  }

  return { detected: found, resolved: anchors.length, text: parts.join('\n\n'), expanded }
}

function typeSelection(
  model: ITextModel,
  position: Position,
  captured: TypeContext | null
): TypeSelection {
  if (captured === null) {
    return { text: null, anchors: 0, resolved: 0, expanded: false, stale: false }
  }

  const anchors = callAnchors(model, position)
  const counts = { anchors: captured.detected.length, resolved: captured.resolved }
  if (!sameAnchors(anchors, captured.detected)) {
    return { text: null, ...counts, expanded: captured.expanded, stale: true }
  }

  return {
    text: captured.text === '' ? null : captured.text,
    ...counts,
    expanded: captured.expanded,
    stale: false,
  }
}

export async function registerInlineCompletions(projectRoot: string): Promise<void> {
  const [features, snooze] = await Promise.all([
    getService(ILanguageFeaturesService),
    getService(IInlineCompletionsService),
  ])

  snooze.onDidChangeIsSnoozing((isSnoozing) => {
    if (!isSnoozing) snoozeReported = false
  })

  const provider: InlineCompletionsProvider = {
    displayName: 'Chorus',
    groupId: GROUP,

    async provideInlineCompletions(
      model,
      position,
      _context,
      token
    ): Promise<InlineCompletions | undefined> {
      if (snooze.isSnoozing()) {
        if (!snoozeReported) {
          snoozeReported = true
          reportOutcome({ requestId: crypto.randomUUID(), outcome: 'snoozed' })
        }
        return undefined
      }

      const enteredAt = performance.now()
      const requestId = crypto.randomUUID()

      if (cancelled(token)) {
        reportOutcome({ requestId, outcome: 'cancelled' })
        return undefined
      }

      const cancellation = token.onCancellationRequested(() => {
        window.chorusWorkbench.cancelCompletion(requestId)
      })

      try {
        const collected = collectedContext(model)
        const capturedMember = collected?.member ?? null
        const capturedType = collected?.type ?? null
        const member = memberSelection(model, position, capturedMember)
        const types = typeSelection(model, position, capturedType)
        const packed = packContext(
          model.getLanguageId(),
          types.text,
          member.members,
          definitionBlocks(projectRoot, collected?.snippets ?? [])
        )
        const facts: EditorFacts = {
          ...(capturedMember === null
            ? {}
            : {
                memberContext: packed.members > 0,
                memberCount: packed.members,
                memberReceiverMatched: member.matched,
              }),
          ...(capturedType === null
            ? {}
            : {
                typeContext: packed.types,
                typeAnchors: types.anchors,
                typeResolved: types.resolved,
                typeExpanded: types.expanded,
                typeStale: types.stale,
              }),
        }
        const reply = await window.chorusWorkbench.requestCompletion(
          requestId,
          completionPayload(model, position, projectRoot, packed.context)
        )
        setCollectionArmed(reply.configured, projectRoot)
        if (cancelled(token)) {
          reportOutcome({ requestId, outcome: 'cancelled', ...facts })
          return undefined
        }
        if (reply.text === null) {
          reportOutcome({
            requestId,
            outcome: reply.configured ? 'no-suggestion' : 'not-configured',
            ...facts,
          })
          return undefined
        }
        const insertText = reply.text

        const items: InlineCompletion[] = [
          {
            insertText,
            range: new Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          },
        ]
        const completions: InlineCompletions = { items }
        pending.set(completions, {
          requestId,
          returnedAt: performance.now(),
          shown: false,
        })
        reportOutcome({
          requestId,
          outcome: 'returned',
          providerReturnedMs: Math.round(performance.now() - enteredAt),
          ...facts,
        })
        return completions
      } finally {
        cancellation.dispose()
      }
    },

    handleItemDidShow: (completions) => {
      const entry = pending.get(completions)
      if (entry === undefined || entry.shown) return
      entry.shown = true
      reportOutcome({
        requestId: entry.requestId,
        outcome: 'shown',
        itemShownAfterReturnMs: Math.round(performance.now() - entry.returnedAt),
      })
    },

    disposeInlineCompletions: (completions) => {
      const entry = pending.get(completions)
      if (entry === undefined || entry.shown) return undefined
      entry.shown = true
      reportOutcome({ requestId: entry.requestId, outcome: 'returned-not-shown' })
      return undefined
    },
  }

  features.inlineCompletionsProvider.register(
    [{ scheme: 'file' }, { scheme: 'vscode-remote' }],
    provider
  )
}

const LANGUAGE_SERVICE_ROUNDS = 100
const LANGUAGE_SERVICE_INTERVAL_MS = 2000
const LANGUAGE_SERVICE_TIMEOUT_MS = 500

let languageServiceSeq = 0

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function timeQuery(
  features: ILanguageFeaturesService,
  query: 'definitions' | 'typeDefinitions',
  model: ITextModel,
  position: Position
): Promise<void> {
  languageServiceSeq += 1
  const requestId = `ls-${query}-${String(languageServiceSeq)}`
  const source = new CancellationTokenSource()

  const definitions = query === 'definitions' ? features.definitionProvider.ordered(model) : []
  const typeDefinitions =
    query === 'typeDefinitions' ? features.typeDefinitionProvider.ordered(model) : []

  if (definitions.length === 0 && typeDefinitions.length === 0) {
    reportOutcome({
      requestId,
      outcome: 'language-service',
      languageServiceQuery: query,
      providerMissing: true,
    })
    return
  }

  const timer = setTimeout(() => {
    source.cancel()
  }, LANGUAGE_SERVICE_TIMEOUT_MS)
  const startedAt = performance.now()

  try {
    await Promise.all([
      ...definitions.map((provider) => provider.provideDefinition(model, position, source.token)),
      ...typeDefinitions.map((provider) =>
        provider.provideTypeDefinition(model, position, source.token)
      ),
    ])
    reportOutcome({
      requestId,
      outcome: 'language-service',
      languageServiceQuery: query,
      queryMs: Math.round(performance.now() - startedAt),
    })
  } catch {
    reportOutcome({
      requestId,
      outcome: 'language-service',
      languageServiceQuery: query,
      ...(source.token.isCancellationRequested ? { queryTimedOut: true } : {}),
    })
  } finally {
    clearTimeout(timer)
    source.dispose()
  }
}

export async function startLanguageServiceSampling(): Promise<void> {
  const features = await getService(ILanguageFeaturesService)
  const editors = await getService(IEditorService)

  for (let round = 0; round < LANGUAGE_SERVICE_ROUNDS; round += 1) {
    await wait(LANGUAGE_SERVICE_INTERVAL_MS)

    const control = editors.activeTextEditorControl
    if (!isCodeEditor(control)) continue
    const model = control.getModel()
    const position = control.getPosition()
    if (model === null || position === null) continue

    await timeQuery(features, 'definitions', model, position)
    await timeQuery(features, 'typeDefinitions', model, position)
  }
}

const COLLECTION_DEBOUNCE_MS = 300
const COLLECTION_QUERY_TIMEOUT_MS = 1500
const COLLECTION_CONCURRENCY = 4

export interface CollectedContext {
  readonly locations: readonly Location[]
  readonly snippets: readonly ResolvedSnippet[]
  readonly member: MemberContext | null
  readonly type: TypeContext | null
  readonly emptyQueries: number
  readonly totalQueries: number
}

const collected = new WeakMap<ITextModel, CollectedContext>()
let collectionSeq = 0

export function collectedContext(model: ITextModel): CollectedContext | null {
  return collected.get(model) ?? null
}

function locationsOf(definition: Definition | null | undefined): Location[] {
  if (definition === undefined || definition === null) return []
  const list = Array.isArray(definition) ? definition : [definition]
  return list.map((item) => ({ uri: item.uri, range: item.range }))
}

async function runBounded<T>(work: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < work.length) {
      const index = next
      next += 1
      const task = work[index]
      if (task === undefined) continue
      results[index] = await task()
    }
  }
  const workers = Math.min(limit, work.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

async function collectOnce(
  features: ILanguageFeaturesService,
  model: ITextModel,
  position: Position,
  projectRoot: string,
  source: CancellationTokenSource
): Promise<void> {
  const previous = collected.get(model)
  const site = memberSite(model, position)
  const member = site === null ? null : await collectMembers(features, model, site, source.token)
  const type = await collectTypes(features, model, position, source.token)

  if (member !== null || type !== null) {
    collected.set(model, {
      locations: previous?.locations ?? [],
      snippets: previous?.snippets ?? [],
      member: member ?? previous?.member ?? null,
      type: type ?? previous?.type ?? null,
      emptyQueries: previous?.emptyQueries ?? 0,
      totalQueries: previous?.totalQueries ?? 0,
    })
  }

  const definitions = features.definitionProvider.ordered(model)
  const typeDefinitions = features.typeDefinitionProvider.ordered(model)

  const work: (() => Promise<Location[]>)[] = []
  for (const at of queryPositions(model, position)) {
    for (const provider of definitions) {
      work.push(async () => locationsOf(await provider.provideDefinition(model, at, source.token)))
    }
    for (const provider of typeDefinitions) {
      work.push(async () =>
        locationsOf(await provider.provideTypeDefinition(model, at, source.token))
      )
    }
  }

  if (work.length === 0 && member === null && type === null) return

  const results = await runBounded(work, COLLECTION_CONCURRENCY)
  if (source.token.isCancellationRequested) return

  const locations: Location[] = []
  const seen = new Set<string>()
  for (const found of results.flat()) {
    const key = snippetKey(found)
    if (seen.has(key)) continue
    seen.add(key)
    locations.push(found)
  }
  const emptyQueries = results.filter((found) => found.length === 0).length

  const resolveStarted = performance.now()
  const snippets = await resolveSnippets(locations)
  const snippetResolveMs = Math.round(performance.now() - resolveStarted)
  if (cancelled(source.token)) return

  collected.set(model, {
    locations,
    snippets,
    member: member ?? previous?.member ?? null,
    type: type ?? previous?.type ?? null,
    emptyQueries,
    totalQueries: results.length,
  })
  collectionSeq += 1
  const platform = platformForRoot(projectRoot, 'darwin')
  reportOutcome({
    requestId: `collect-${String(collectionSeq)}`,
    outcome: 'context-collection',
    emptyQueries,
    totalQueries: results.length,
    snippetResolveMs,
    snippetExtents: snippets.map((snippet) => snippet.lines),
    snippetPaths: snippets.map((snippet) => relativeTo(projectRoot, snippet.uri.path, platform)),
  })
}

let collectionFeatures: ILanguageFeaturesService | null = null
let collectionEditors: IEditorService | null = null
let collectionRoot: string | null = null
let collectionEditorChange: { dispose: () => void } | null = null
let collectionEditorSubscriptions: { dispose: () => void }[] = []
let collectionPending: CancellationTokenSource | null = null
let collectionTimer: ReturnType<typeof setTimeout> | null = null
let collectionArmed = false

function scheduleCollection(): void {
  const features = collectionFeatures
  const editors = collectionEditors
  const root = collectionRoot
  if (features === null || editors === null || root === null) return

  if (collectionTimer !== null) clearTimeout(collectionTimer)
  collectionTimer = setTimeout(() => {
    collectionTimer = null
    const control = editors.activeTextEditorControl
    if (!isCodeEditor(control)) return
    const model = control.getModel()
    const position = control.getPosition()
    if (model === null || position === null) return

    collectionPending?.cancel()
    collectionPending?.dispose()
    const source = new CancellationTokenSource()
    collectionPending = source
    const expiry = setTimeout(() => {
      source.cancel()
    }, COLLECTION_QUERY_TIMEOUT_MS)
    void collectOnce(features, model, position, root, source).finally(() => {
      clearTimeout(expiry)
    })
  }, COLLECTION_DEBOUNCE_MS)
}

function wireCollectionEditor(): void {
  for (const subscription of collectionEditorSubscriptions) subscription.dispose()
  collectionEditorSubscriptions = []

  const control = collectionEditors?.activeTextEditorControl
  if (!isCodeEditor(control)) return
  collectionEditorSubscriptions.push(
    control.onDidChangeCursorPosition(() => {
      scheduleCollection()
    })
  )
  collectionEditorSubscriptions.push(
    control.onDidChangeModelContent(() => {
      scheduleCollection()
    })
  )
}

async function armCollection(projectRoot: string): Promise<void> {
  if (collectionWired()) return

  const [features, editors] = await Promise.all([
    getService(ILanguageFeaturesService),
    getService(IEditorService),
  ])
  if (collectionWired() || !collectionArmed) return

  collectionRoot = projectRoot
  collectionFeatures = features
  collectionEditors = editors
  collectionEditorChange = editors.onDidActiveEditorChange(() => {
    wireCollectionEditor()
  })
  wireCollectionEditor()
}

function disarmCollection(): void {
  if (!collectionArmed) return
  collectionArmed = false
  collectionRoot = null

  collectionEditorChange?.dispose()
  collectionEditorChange = null
  for (const subscription of collectionEditorSubscriptions) subscription.dispose()
  collectionEditorSubscriptions = []
  if (collectionTimer !== null) clearTimeout(collectionTimer)
  collectionTimer = null
  collectionPending?.cancel()
  collectionPending?.dispose()
  collectionPending = null
}

function collectionWired(): boolean {
  return collectionEditorChange !== null
}

function setCollectionArmed(configured: boolean, projectRoot: string): void {
  if (!configured) {
    disarmCollection()
    return
  }
  if (collectionArmed) return
  collectionArmed = true
  void armCollection(projectRoot)
}

const SNIPPET_RESOLVE_CONCURRENCY = 2
const SNIPPET_CACHE_LIMIT = 256

export interface ResolvedSnippet {
  readonly uri: URI
  readonly text: string
  readonly lines: number
}

interface CachedSnippet {
  readonly targetVersion: number
  readonly text: string
  readonly lines: number
}

const snippets = new Map<string, CachedSnippet>()

function snippetKey(location: Location): string {
  const start = `${String(location.range.startLineNumber)}:${String(location.range.startColumn)}`
  return `${location.uri.toString()}#${start}`
}

interface SnippetExtract {
  readonly text: string
  readonly lines: number
}

function snippetText(model: ITextModel, range: IRange): SnippetExtract {
  const last = Math.min(model.getLineCount(), range.endLineNumber)
  const taken: string[] = []
  let characters = 0

  for (let line = range.startLineNumber; line <= last; line += 1) {
    const content = model.getLineContent(line)
    taken.push(content)
    characters += content.length + 1
    if (characters > COMPLETION_SNIPPET_SOURCE_CHARACTERS) break
  }

  const joined = taken.join('\n')
  return {
    text:
      joined.length > COMPLETION_SNIPPET_SOURCE_CHARACTERS
        ? joined.slice(0, COMPLETION_SNIPPET_SOURCE_CHARACTERS)
        : joined,
    lines: last - range.startLineNumber + 1,
  }
}

async function resolveSnippet(
  models: IModelService,
  service: ITextModelService,
  location: Location
): Promise<ResolvedSnippet | null> {
  const key = snippetKey(location)
  const cached = snippets.get(key)
  if (cached !== undefined) {
    const loaded = models.getModel(location.uri)
    if (loaded !== null && loaded.getVersionId() === cached.targetVersion) {
      return { uri: location.uri, text: cached.text, lines: cached.lines }
    }
  }

  const reference = await service.createModelReference(location.uri).catch(() => null)
  if (reference === null) return null

  try {
    const model = reference.object.textEditorModel
    const extract = snippetText(model, location.range)

    if (snippets.size >= SNIPPET_CACHE_LIMIT) {
      const oldest = snippets.keys().next().value
      if (oldest !== undefined) snippets.delete(oldest)
    }
    snippets.set(key, {
      targetVersion: model.getVersionId(),
      text: extract.text,
      lines: extract.lines,
    })
    return { uri: location.uri, text: extract.text, lines: extract.lines }
  } catch {
    return null
  } finally {
    reference.dispose()
  }
}

export async function resolveSnippets(
  locations: readonly Location[]
): Promise<readonly ResolvedSnippet[]> {
  const [models, service] = await Promise.all([
    getService(IModelService),
    getService(ITextModelService),
  ])

  const work = locations.map((location) => () => resolveSnippet(models, service, location))
  const found = await runBounded(work, SNIPPET_RESOLVE_CONCURRENCY)
  return found.filter((snippet): snippet is ResolvedSnippet => snippet !== null)
}
