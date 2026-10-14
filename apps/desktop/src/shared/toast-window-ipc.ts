import { z } from 'zod'
import { WorkbenchRect } from './workbench-ipc.js'

export const TOAST_WINDOW_NAME = 'chorus-notifications'
export const TOAST_WINDOW_BOUNDS_CHANNEL = 'toast:setBounds'
export const TOAST_WINDOW_INTERACTION_CHANNEL = 'toast:setInteraction'
export const ToastWindowBoundsRequest = z
  .object({
    rect: WorkbenchRect.nullable(),
    regions: z.array(WorkbenchRect).max(4096),
    restoreFocus: z.boolean(),
  })
  .strict()
export const ToastWindowBoundsResponse = z
  .object({ ok: z.literal(true), focused: z.boolean() })
  .strict()
export const ToastWindowInteractionRequest = z.object({ interactive: z.boolean() }).strict()
export const ToastWindowInteractionResponse = z.object({ ok: z.literal(true) }).strict()

export interface ChorusToastApi {
  readonly setBounds: (
    request: z.infer<typeof ToastWindowBoundsRequest>
  ) => Promise<z.infer<typeof ToastWindowBoundsResponse>>
  readonly setInteraction: (
    request: z.infer<typeof ToastWindowInteractionRequest>
  ) => Promise<z.infer<typeof ToastWindowInteractionResponse>>
}
