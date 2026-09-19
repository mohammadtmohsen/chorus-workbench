import { getService } from '@codingame/monaco-vscode-api'
import { ILanguageFeaturesService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/languageFeatures.service'
import { Range } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/range'
import { IInlineCompletionsService } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/inlineCompletionsService.service'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { isCodeEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'
import { CancellationTokenSource } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import type { CancellationToken } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import type { Position } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/position'
import type { ITextModel } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/model'
import type {
  InlineCompletion,
  InlineCompletions,
  InlineCompletionsProvider,
} from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages'
import { platformForRoot } from '@chorus/ide-protocol/paths'
import {
  COMPLETION_CHARACTERS_PER_SIDE,
  COMPLETION_TOKENS_PER_SIDE,
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

function prefixRange(model: ITextModel, position: Position): Range {
  const budget = COMPLETION_BUDGET.charactersPerSide
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
  projectRoot: string
): CompletionPayload {
  return {
    prefix: model.getValueInRange(prefixRange(model, position)),
    suffix: model.getValueInRange(suffixRange(model, position)),
    languageId: model.getLanguageId(),
    path: relativeTo(projectRoot, model.uri.path, platformForRoot(projectRoot, 'darwin')),
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
        const insertText = await window.chorusWorkbench.requestCompletion(
          requestId,
          completionPayload(model, position, projectRoot)
        )
        if (cancelled(token)) {
          reportOutcome({ requestId, outcome: 'cancelled' })
          return undefined
        }
        if (insertText === null) {
          reportOutcome({ requestId, outcome: 'no-suggestion' })
          return undefined
        }

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
