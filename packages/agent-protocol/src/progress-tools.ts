import { z } from 'zod'
import { boundFailure, type ProjectToolResult } from './project-tools.js'

export const PROGRESS_TOOL_NAMESPACE = 'chorus_progress'
export const PROGRESS_TOOL_NAME = 'report_progress'

export const PROGRESS_LIMITS = {
  steps: 100,
  idLength: 64,
  labelLength: 16,
  titleLength: 200,
  reasonLength: 300,
  depth: 4,
  dependencies: 20,
  estimateMinutes: 10_080,
} as const

export const PROGRESS_STEP_STATUSES = ['pending', 'active', 'done', 'skipped'] as const
export type ProgressStepStatus = (typeof PROGRESS_STEP_STATUSES)[number]

export const PROGRESS_SCOPES = ['current', 'new'] as const

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface ProgressStep {
  readonly id: string
  readonly label?: string
  readonly parentId?: string
  readonly title: string
  readonly status: ProgressStepStatus
  readonly estimateMinutes?: number
  readonly dependsOn?: readonly string[]
}

export interface ProgressReport {
  readonly steps: readonly ProgressStep[]
  readonly reason?: string
  readonly parallel?: boolean
  readonly awaitingUser?: boolean
  readonly complete?: boolean
  readonly scope?: (typeof PROGRESS_SCOPES)[number]
}

export type ProgressReporter = (
  report: ProgressReport
) => ProjectToolResult | Promise<ProjectToolResult>

const ID_TEXT = `A stable id for this step, kept the same in every report. Letters, digits, ".", "_" and "-", at most ${String(PROGRESS_LIMITS.idLength)} characters.`
const LABEL_TEXT = `How the step is numbered for the user, such as "4", "4.2" or "4.a". At most ${String(PROGRESS_LIMITS.labelLength)} characters.`
const PARENT_TEXT = 'The id of the step this one is part of. Omit for a main step.'
const TITLE_TEXT = `What the step does, in a few words. At most ${String(PROGRESS_LIMITS.titleLength)} characters.`
const STATUS_TEXT = '"pending", "active" while you work on it, "done", or "skipped".'
const ESTIMATE_TEXT =
  'Minutes of your own working time this step takes in total, not a person’s time. Give it on the smallest steps you can estimate; a parent’s estimate is used only when none of its sub-steps has one.'
const DEPENDS_TEXT = `Ids of steps that must finish before this one starts. At most ${String(PROGRESS_LIMITS.dependencies)}.`
const STEPS_TEXT = `Every step of your plan, in order, at most ${String(PROGRESS_LIMITS.steps)}. Each report replaces your previous one, so send all of them every time.`
const REASON_TEXT = `Why the plan or an estimate changed, in one line. At most ${String(PROGRESS_LIMITS.reasonLength)} characters.`
const PARALLEL_TEXT =
  'True only when you really run independent steps at the same time, for example with sub-agents. Steps then run as soon as their dependsOn steps finish. Otherwise they are counted one after another.'
const AWAITING_TEXT =
  'True when you are ending your turn to wait for the user’s decision before continuing.'
const COMPLETE_TEXT = 'True when the whole task the user asked for is finished.'
const SCOPE_TEXT =
  '"new" only when the user has asked for a different piece of work than the current task. Defaults to "current".'

const identifier = z.string().min(1).max(PROGRESS_LIMITS.idLength)

const StepSchema = z
  .object({
    id: identifier.regex(STEP_ID_PATTERN).describe(ID_TEXT),
    label: z
      .string()
      .trim()
      .min(1)
      .max(PROGRESS_LIMITS.labelLength)
      .optional()
      .describe(LABEL_TEXT),
    parentId: identifier.optional().describe(PARENT_TEXT),
    title: z.string().trim().min(1).max(PROGRESS_LIMITS.titleLength).describe(TITLE_TEXT),
    status: z.enum(PROGRESS_STEP_STATUSES).describe(STATUS_TEXT),
    estimateMinutes: z
      .number()
      .positive()
      .max(PROGRESS_LIMITS.estimateMinutes)
      .optional()
      .describe(ESTIMATE_TEXT),
    dependsOn: z
      .array(identifier)
      .max(PROGRESS_LIMITS.dependencies)
      .optional()
      .describe(DEPENDS_TEXT),
  })
  .strict()

export const PROGRESS_TOOL_SHAPE = {
  steps: z.array(StepSchema).min(1).max(PROGRESS_LIMITS.steps).describe(STEPS_TEXT),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(PROGRESS_LIMITS.reasonLength)
    .optional()
    .describe(REASON_TEXT),
  parallel: z.boolean().optional().describe(PARALLEL_TEXT),
  awaitingUser: z.boolean().optional().describe(AWAITING_TEXT),
  complete: z.boolean().optional().describe(COMPLETE_TEXT),
  scope: z.enum(PROGRESS_SCOPES).optional().describe(SCOPE_TEXT),
} as const

const ARGUMENTS = z.object(PROGRESS_TOOL_SHAPE).strict()

export const PROGRESS_NAMESPACE_DESCRIPTION =
  'Reports your plan and progress on the current task to Chorus, which shows the user the current step, how many steps are done, and an approximate time remaining. Reporting never authorizes more work.'

export const PROGRESS_TOOL_DESCRIPTION = [
  'Publish your plan for the task the user asked for, so Chorus can show the current step, completed steps and an approximate time remaining.',
  '',
  'Call it early with a rough plan, again when a step finishes or the plan changes, and with complete set to true when the whole task is finished. Each call replaces your previous plan, so send every step each time and keep each step’s id the same.',
  '',
  'Estimate in minutes of your own working time, not a person’s. Estimate the smallest steps you can; leave out estimates you cannot make rather than guessing. Set awaitingUser when you stop to wait for the user’s decision.',
  '',
  'This only reports progress. It never authorizes additional work, and it does not change anything the user allowed or ruled out, including whether to run tests or builds.',
].join('\n')

const stringSchema = (
  bounds: { readonly min: number; readonly max: number },
  description: string,
  pattern?: RegExp
): Readonly<Record<string, unknown>> => ({
  type: 'string',
  minLength: bounds.min,
  maxLength: bounds.max,
  ...(pattern === undefined ? {} : { pattern: pattern.source }),
  description,
})

export const PROGRESS_TOOL_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: PROGRESS_LIMITS.steps,
      description: STEPS_TEXT,
      items: {
        type: 'object',
        properties: {
          id: stringSchema({ min: 1, max: PROGRESS_LIMITS.idLength }, ID_TEXT, STEP_ID_PATTERN),
          label: stringSchema({ min: 1, max: PROGRESS_LIMITS.labelLength }, LABEL_TEXT),
          parentId: stringSchema({ min: 1, max: PROGRESS_LIMITS.idLength }, PARENT_TEXT),
          title: stringSchema({ min: 1, max: PROGRESS_LIMITS.titleLength }, TITLE_TEXT),
          status: { type: 'string', enum: [...PROGRESS_STEP_STATUSES], description: STATUS_TEXT },
          estimateMinutes: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: PROGRESS_LIMITS.estimateMinutes,
            description: ESTIMATE_TEXT,
          },
          dependsOn: {
            type: 'array',
            maxItems: PROGRESS_LIMITS.dependencies,
            items: stringSchema({ min: 1, max: PROGRESS_LIMITS.idLength }, ID_TEXT),
            description: DEPENDS_TEXT,
          },
        },
        required: ['id', 'title', 'status'],
        additionalProperties: false,
      },
    },
    reason: stringSchema({ min: 1, max: PROGRESS_LIMITS.reasonLength }, REASON_TEXT),
    parallel: { type: 'boolean', description: PARALLEL_TEXT },
    awaitingUser: { type: 'boolean', description: AWAITING_TEXT },
    complete: { type: 'boolean', description: COMPLETE_TEXT },
    scope: { type: 'string', enum: [...PROGRESS_SCOPES], description: SCOPE_TEXT },
  },
  required: ['steps'],
  additionalProperties: false,
}

export const NO_PROGRESS_REPORTER = 'Progress reporting is not available in this session.'

export type ProgressValidation =
  | { readonly ok: true; readonly report: ProgressReport }
  | { readonly ok: false; readonly issues: readonly string[] }

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.map(String).join('.')
    return where === '' ? issue.message : `${where}: ${issue.message}`
  })
}

export function stepLeaves(steps: readonly ProgressStep[]): ReadonlyMap<string, readonly string[]> {
  const children = new Map<string, string[]>()
  for (const step of steps) {
    if (step.parentId === undefined) continue
    const siblings = children.get(step.parentId) ?? []
    siblings.push(step.id)
    children.set(step.parentId, siblings)
  }
  const leaves = new Map<string, readonly string[]>()
  const collect = (id: string, seen: Set<string>): readonly string[] => {
    const known = leaves.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return []
    seen.add(id)
    const kids = children.get(id) ?? []
    const found = kids.length === 0 ? [id] : kids.flatMap((kid) => collect(kid, seen))
    leaves.set(id, found)
    return found
  }
  for (const step of steps) collect(step.id, new Set())
  return leaves
}

export function stepAncestors(steps: readonly ProgressStep[], id: string): readonly string[] {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const chain: string[] = []
  const seen = new Set<string>([id])
  let parent = byId.get(id)?.parentId
  while (parent !== undefined && !seen.has(parent)) {
    chain.push(parent)
    seen.add(parent)
    parent = byId.get(parent)?.parentId
  }
  return chain
}

export function leafPrerequisites(
  steps: readonly ProgressStep[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const byId = new Map(steps.map((step) => [step.id, step]))
  const leaves = stepLeaves(steps)
  const result = new Map<string, ReadonlySet<string>>()
  for (const step of steps) {
    if ((leaves.get(step.id) ?? []).length !== 1 || leaves.get(step.id)?.[0] !== step.id) continue
    const needs = new Set<string>()
    for (const owner of [step.id, ...stepAncestors(steps, step.id)]) {
      for (const dependency of byId.get(owner)?.dependsOn ?? []) {
        for (const leaf of leaves.get(dependency) ?? []) needs.add(leaf)
      }
    }
    result.set(step.id, needs)
  }
  return result
}

function structuralIssues(steps: readonly ProgressStep[]): string[] {
  const issues: string[] = []
  const byId = new Map<string, ProgressStep>()
  for (const step of steps) {
    if (byId.has(step.id)) issues.push(`steps: duplicate id "${step.id}"`)
    else byId.set(step.id, step)
  }
  if (issues.length > 0) return issues

  for (const step of steps) {
    if (step.parentId === undefined) continue
    if (step.parentId === step.id) issues.push(`steps.${step.id}: a step cannot be its own parent`)
    else if (!byId.has(step.parentId)) {
      issues.push(`steps.${step.id}: parentId "${step.parentId}" names no step`)
    }
  }
  if (issues.length > 0) return issues

  for (const step of steps) {
    const seen = new Set<string>([step.id])
    let depth = 1
    let parent = step.parentId
    while (parent !== undefined) {
      if (seen.has(parent)) {
        issues.push(`steps.${step.id}: its parents form a cycle`)
        break
      }
      seen.add(parent)
      depth += 1
      parent = byId.get(parent)?.parentId
    }
    if (depth > PROGRESS_LIMITS.depth) {
      issues.push(`steps.${step.id}: nested deeper than ${String(PROGRESS_LIMITS.depth)} levels`)
    }
  }
  if (issues.length > 0) return issues

  for (const step of steps) {
    const named = new Set<string>()
    for (const dependency of step.dependsOn ?? []) {
      if (named.has(dependency)) issues.push(`steps.${step.id}: "${dependency}" is listed twice`)
      named.add(dependency)
      if (dependency === step.id) issues.push(`steps.${step.id}: a step cannot depend on itself`)
      else if (!byId.has(dependency)) {
        issues.push(`steps.${step.id}: dependsOn "${dependency}" names no step`)
      }
    }
  }
  if (issues.length > 0) return issues

  const prerequisites = leafPrerequisites(steps)
  const state = new Map<string, 'visiting' | 'done'>()
  const cyclic = new Set<string>()
  const visit = (leaf: string): boolean => {
    const mark = state.get(leaf)
    if (mark === 'done') return false
    if (mark === 'visiting') return true
    state.set(leaf, 'visiting')
    let found = false
    for (const next of prerequisites.get(leaf) ?? []) {
      if (visit(next)) {
        found = true
        cyclic.add(leaf)
      }
    }
    state.set(leaf, 'done')
    return found
  }
  for (const leaf of prerequisites.keys()) visit(leaf)
  for (const leaf of cyclic) issues.push(`steps.${leaf}: its dependencies form a cycle`)
  return issues
}

function completionIssues(steps: readonly ProgressStep[]): string[] {
  const leaves = stepLeaves(steps)
  const unfinished = steps.filter((step) => {
    const own = leaves.get(step.id)
    const leaf = own?.length === 1 && own[0] === step.id
    return leaf && step.status !== 'done' && step.status !== 'skipped'
  })
  return unfinished.length === 0
    ? []
    : [
        `complete is true but ${unfinished.map((step) => `"${step.id}"`).join(', ')} ${unfinished.length === 1 ? 'is' : 'are'} not done or skipped`,
      ]
}

export function validateProgressReport(args: unknown): ProgressValidation {
  const parsed = ARGUMENTS.safeParse(args ?? {})
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const steps: ProgressStep[] = parsed.data.steps.map((step) => ({
    id: step.id,
    title: step.title,
    status: step.status,
    ...(step.label === undefined ? {} : { label: step.label }),
    ...(step.parentId === undefined ? {} : { parentId: step.parentId }),
    ...(step.estimateMinutes === undefined ? {} : { estimateMinutes: step.estimateMinutes }),
    ...(step.dependsOn === undefined || step.dependsOn.length === 0
      ? {}
      : { dependsOn: step.dependsOn }),
  }))
  const issues = structuralIssues(steps)
  if (issues.length > 0) return { ok: false, issues }
  const { reason, parallel, awaitingUser, complete, scope } = parsed.data
  const incomplete = complete === true ? completionIssues(steps) : []
  if (incomplete.length > 0) return { ok: false, issues: incomplete }
  return {
    ok: true,
    report: {
      steps,
      ...(reason === undefined ? {} : { reason }),
      ...(parallel === undefined ? {} : { parallel }),
      ...(awaitingUser === undefined ? {} : { awaitingUser }),
      ...(complete === undefined ? {} : { complete }),
      ...(scope === undefined ? {} : { scope }),
    },
  }
}

export async function runProgressTool(
  reporter: ProgressReporter | undefined,
  args: unknown
): Promise<ProjectToolResult> {
  if (reporter === undefined) return { ok: false, text: NO_PROGRESS_REPORTER }
  const validation = validateProgressReport(args)
  if (!validation.ok) {
    return { ok: false, text: boundFailure(`Invalid arguments: ${validation.issues.join('; ')}`) }
  }
  try {
    const result = await reporter(validation.report)
    return result.ok ? result : { ok: false, text: boundFailure(result.text) }
  } catch (error) {
    return { ok: false, text: boundFailure(error instanceof Error ? error.message : String(error)) }
  }
}

export interface NativePlanStep {
  readonly text: string
  readonly done: boolean
  readonly active?: boolean
}

function titleHash(text: string): string {
  let hash = 0x811c9dc5
  for (const point of text) {
    hash ^= point.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function nativeProgressSteps(plan: readonly NativePlanStep[]): ProgressStep[] {
  const seen = new Map<string, number>()
  return plan
    .map((step) => step.text.trim().replace(/\s+/g, ' '))
    .flatMap((title, index) => {
      if (title === '') return []
      const step = plan[index]
      const status: ProgressStepStatus =
        step?.done === true ? 'done' : step?.active === true ? 'active' : 'pending'
      return [{ title: title.slice(0, PROGRESS_LIMITS.titleLength), status }]
    })
    .slice(0, PROGRESS_LIMITS.steps)
    .map((step, index) => {
      const key = titleHash(step.title.toLowerCase())
      const occurrence = (seen.get(key) ?? 0) + 1
      seen.set(key, occurrence)
      return {
        id: occurrence === 1 ? `n${key}` : `n${key}-${String(occurrence)}`,
        label: String(index + 1),
        ...step,
      }
    })
}

export const PROGRESS_INSTRUCTION = [
  'When the user gives you work in this conversation, report it with the report_progress tool if it is available: a rough plan early, an update when a step finishes or the plan changes, and complete set to true only when the whole task is finished.',
  'If the tool is not available, keep your own checklist current instead.',
  'Reporting progress never authorizes work the user did not ask for, and it changes none of their instructions, including whether to run tests or builds.',
].join(' ')
