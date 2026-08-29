import type { AgentId, SessionInfo } from '../Session.js'
import { ProjectPreviewCard } from './ProjectPreviewCard.js'
import { createSignal, useSignal, type Signal } from './signal.js'
import { useShellOverlay } from './overlay.js'
import type { ProjectInfo } from './session-row.js'

/**
 * One read-only card, shown from either representation of a session.
 *
 * The rail shortcut is two letters and the drawer row is a title — neither has
 * room for the project path, the cast, the profile, what a session has spent or
 * how full its context is. All of that used to be mounted permanently in every
 * card, which is how a list of six sessions became six small control panels.
 *
 * It is deliberately informational. Actions live in `SessionMenu`, because a
 * surface that disappears when the pointer crosses a 6px gap is a bad home for
 * "End session". If direct actions ever earn their place here they arrive with
 * an explicit pin state, not by accident.
 */

/** Long enough that crossing the list does not open anything. */
const DWELL_MS = 200

/**
 * The gap between a trigger and the card is a real distance, and a pointer
 * crosses it in more than zero milliseconds. Without this grace the card closes
 * under a pointer that is on its way into it, which reads as flicker.
 */
const CLOSE_GRACE_MS = 120

export interface PreviewTarget {
  /**
   * The **project** the card is about.
   *
   * It was a conversation id, and the rail it came from listed conversations.
   * Both moved up together — the rail's tiles are projects now, so the trigger
   * can only name one, and the card describes the place rather than one room in
   * it.
   */
  readonly projectId: string
  /** The trigger's box at the moment it was asked for; the card places itself. */
  readonly anchor: DOMRect
}

export interface PreviewController {
  readonly target: Signal<PreviewTarget | null>
  /** Hover or focus arrived. Opens after the dwell unless something cancels. */
  readonly open: (projectId: string, anchor: DOMRect) => void
  /** Hover or focus left. Closes after the grace unless something holds it. */
  readonly leave: () => void
  /** The pointer reached the card, or a trigger came back. Cancels the close. */
  readonly hold: () => void
  /** Escape, a click, a drag starting. Closes now and cancels any pending open. */
  readonly dismiss: () => void
}

export function createPreviewController(): PreviewController {
  const target = createSignal<PreviewTarget | null>(null)
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
  }
  return {
    target,
    open: (projectId, anchor) => {
      clear()
      /*
       * Already showing this project: re-anchor immediately rather than waiting
       * the dwell out again. Moving between two triggers for the same project
       * should move the card, not close and reopen it.
       */
      if (target.get()?.projectId === projectId) {
        target.set({ projectId, anchor })
        return
      }
      openTimer = setTimeout(() => {
        target.set({ projectId, anchor })
      }, DWELL_MS)
    },
    leave: () => {
      clearTimeout(openTimer)
      clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        target.set(null)
      }, CLOSE_GRACE_MS)
    },
    hold: () => {
      clearTimeout(closeTimer)
    },
    dismiss: () => {
      clear()
      target.set(null)
    },
  }
}

/**
 * The props a trigger needs to drive the preview, as one object.
 *
 * Written here rather than repeated in the rail and the row, because the four
 * handlers have to agree: focus opens as well as hover, and `pointerleave` and
 * `blur` both have to be a *leave* rather than a close, or the card cannot
 * survive the pointer travelling into it.
 */
export function previewTriggerProps(
  controller: PreviewController,
  projectId: string
): {
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
  onFocus: (event: React.FocusEvent<HTMLElement>) => void
  onBlur: () => void
} {
  const show = (element: HTMLElement): void => {
    controller.open(projectId, element.getBoundingClientRect())
  }
  return {
    onPointerEnter: (event) => {
      show(event.currentTarget)
    },
    onPointerLeave: () => {
      controller.leave()
    },
    onFocus: (event) => {
      show(event.currentTarget)
    },
    onBlur: () => {
      controller.leave()
    },
  }
}

/**
 * The one preview in the app, mounted beside the rail rather than inside it.
 *
 * Its own component so that opening it re-renders this and nothing else. Mount
 * it under `Workspace` and every hover would re-render every pane; mount one per
 * tile and twenty projects would mean twenty hidden cards subscribed to twenty
 * folds of the pulse map.
 *
 * It gates and keys; the card draws. That split is what the one-component-per-
 * file rule asks for here — the card needs to remount when the project changes,
 * or the position measured for the previous one is held for a frame and the
 * rename box stays open across two different projects.
 */
export function ProjectPreviewHost(props: {
  readonly controller: PreviewController
  readonly projects: readonly ProjectInfo[]
  readonly sessions: readonly SessionInfo[]
  /* `summary` joins the shape the menu already required: the card renders the
     same permission chooser, and a profile without its sentence is a list of
     three names that do not say what they do. */
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly home: string
  readonly installed: readonly AgentId[]
  readonly onRename: (projectId: string, name: string) => void
  readonly onShowConversation: (projectId: string, conversationId: string) => void
  readonly onToggleAgent: (projectId: string, agentId: AgentId, present: boolean) => Promise<void>
  readonly onChooseProfile: (projectId: string, profileId: string) => Promise<void>
  /** Reachable only from a project whose folder has gone. */
  readonly onRelocate: (projectId: string) => Promise<void>
  readonly onForget: (projectId: string) => Promise<void>
}): React.JSX.Element | null {
  const target = useSignal(props.controller.target)
  const project = props.projects.find((candidate) => candidate.id === target?.projectId)
  /* The host stays mounted and the card comes and goes, so this one is
     conditional rather than mount-gated — and it has to run before the early
     return below, or the hook order changes the first time a card opens. The
     card is portalled over the workbench, which composites above the DOM and
     would otherwise swallow it whole. */
  useShellOverlay(target !== null && project !== undefined)
  if (target === null || project === undefined) return null

  const mine = props.sessions.filter((session) => session.projectId === project.id)
  return (
    <ProjectPreviewCard
      key={project.id}
      controller={props.controller}
      anchor={target.anchor}
      project={project}
      sessions={mine}
      home={props.home}
      installed={props.installed}
      profiles={props.profiles}
      onRename={(name) => {
        props.onRename(project.id, name)
      }}
      onShowConversation={(conversationId) => {
        props.controller.dismiss()
        props.onShowConversation(project.id, conversationId)
      }}
      onToggleAgent={async (agentId, present) => {
        await props.onToggleAgent(project.id, agentId, present)
      }}
      onChooseProfile={async (profileId) => {
        await props.onChooseProfile(project.id, profileId)
      }}
      onRelocate={async () => {
        props.controller.dismiss()
        await props.onRelocate(project.id)
      }}
      onForget={async () => {
        props.controller.dismiss()
        await props.onForget(project.id)
      }}
    />
  )
}
