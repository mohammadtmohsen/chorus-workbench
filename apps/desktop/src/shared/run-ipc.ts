import { z } from 'zod'

export const RunCommandShape = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(40),
  command: z.string().min(1).max(500),
})
export type RunCommandShape = z.infer<typeof RunCommandShape>

export const RunCommandsShape = z
  .object({
    version: z.literal(1),
    defaultId: z.string().min(1).max(64),
    commands: z.array(RunCommandShape).min(1).max(12),
  })
  .refine(
    (value) => new Set(value.commands.map((each) => each.id)).size === value.commands.length,
    { message: 'command ids must be unique' }
  )
  .refine((value) => value.commands.some((each) => each.id === value.defaultId), {
    message: 'defaultId must name a saved command',
  })
export type RunCommandsShape = z.infer<typeof RunCommandsShape>

export const RunFailureShape = z.enum([
  'not-local',
  'unsupported-platform',
  'unsupported-shell',
  'no-command',
  'no-origin',
  'no-variable',
  'capture-failed',
  'no-redirect',
  'spawn-failed',
  'cancelled',
  'stop-incomplete',
])
export type RunFailureShape = z.infer<typeof RunFailureShape>

export const RunProcessShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('starting'), token: z.number().int(), active: RunCommandShape }),
  z.object({
    kind: z.literal('running'),
    token: z.number().int(),
    active: RunCommandShape,
    pgid: z.number().int(),
  }),
  z.object({ kind: z.literal('stopping'), token: z.number().int(), active: RunCommandShape }),
  z.object({
    kind: z.literal('exited'),
    token: z.number().int(),
    active: RunCommandShape,
    code: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal('failed'),
    reason: RunFailureShape,
    active: RunCommandShape.nullable(),
  }),
])
export type RunProcessShape = z.infer<typeof RunProcessShape>

export const RunSnapshotShape = z.object({
  process: RunProcessShape,
  cleanupPending: z.boolean(),
})
export type RunSnapshotShape = z.infer<typeof RunSnapshotShape>

export const RunStateShape = RunSnapshotShape.extend({
  commands: RunCommandsShape.nullable(),
  available: z.boolean(),
})
export type RunState = z.infer<typeof RunStateShape>

export const DetectedScriptsShape = z.object({
  manager: z.enum(['npm', 'pnpm', 'yarn', 'bun']),
  managerSource: z.enum(['packageManager', 'lockfile', 'default']),
  conflictingLockfiles: z.array(z.string()),
  scripts: z.array(z.object({ name: z.string(), command: z.string() })),
  expo: z.boolean(),
  variables: z.array(z.string()),
})
export type DetectedScriptsShape = z.infer<typeof DetectedScriptsShape>

const RunProject = z.object({ projectId: z.string().min(1) }).strict()

export const RUN_CONTRACT = {
  'run:state': { request: RunProject, response: RunStateShape },
  'run:detect': { request: RunProject, response: DetectedScriptsShape },
  'run:configure': {
    request: RunProject.extend({ commands: RunCommandsShape.nullable() }).strict(),
    response: RunStateShape,
  },
  'run:start': {
    request: RunProject.extend({ commandId: z.string().min(1).max(64).optional() }).strict(),
    response: RunSnapshotShape,
  },
  'run:restart': { request: RunProject, response: RunSnapshotShape },
  'run:stop': { request: RunProject, response: RunSnapshotShape },
  'run:stopRecording': { request: RunProject, response: RunSnapshotShape },
} as const

export type RunContract = typeof RUN_CONTRACT
export type RunChannel = keyof RunContract
export type RunRequest<C extends RunChannel> = z.infer<RunContract[C]['request']>
export type RunResponse<C extends RunChannel> = z.infer<RunContract[C]['response']>

export const RUN_CHANNELS = Object.keys(RUN_CONTRACT) as RunChannel[]

export const RUN_PUSH_CHANNEL = 'run:changed'

export const RunPush = RunStateShape.extend({ projectId: z.string().min(1) })
export type RunPush = z.infer<typeof RunPush>

export interface RunApi {
  readonly readRunState: (request: RunRequest<'run:state'>) => Promise<RunResponse<'run:state'>>
  readonly detectRunScripts: (
    request: RunRequest<'run:detect'>
  ) => Promise<RunResponse<'run:detect'>>
  readonly configureRun: (
    request: RunRequest<'run:configure'>
  ) => Promise<RunResponse<'run:configure'>>
  readonly startRun: (request: RunRequest<'run:start'>) => Promise<RunResponse<'run:start'>>
  readonly restartRun: (request: RunRequest<'run:restart'>) => Promise<RunResponse<'run:restart'>>
  readonly stopRun: (request: RunRequest<'run:stop'>) => Promise<RunResponse<'run:stop'>>
  readonly stopRunRecording: (
    request: RunRequest<'run:stopRecording'>
  ) => Promise<RunResponse<'run:stopRecording'>>
  readonly onRun: (listener: (push: RunPush) => void) => () => void
}
