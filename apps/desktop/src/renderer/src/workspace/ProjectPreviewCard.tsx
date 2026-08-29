import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { compactTokens, money } from '../format.js'
import { useProjectFacts } from './hooks.js'
import { ProjectSettings } from './ProjectSettings.js'
import type { PreviewController } from './SessionPreview.js'
import type { ProjectInfo } from './session-row.js'

/**
 * One read-only card for a **project**, shown from its rail tile.
 *
 * It was a conversation card, and the rail it opened from listed conversations.
 * Both moved up together: the rail lists projects, so the card describes the
 * place — its folder, what agents may do in it, who is in it — and the
 * conversations appear as a list *inside* it rather than as four tiles in a
 * column.
 *
 * The settings block is shared with the project menu, not copied — see
 * `ProjectSettings`. Two implementations of a permission chooser is two places
 * for the list of profiles to disagree about which one is selected.
 *
 * Actions on a hover card remain a rule broken deliberately, and the licence is
 * unchanged: this card is hoverable for WCAG 2.2, so reaching a control inside
 * it is a movement rather than a slip, and both destructive ones open the
 * confirmation dialog `App` owns.
 */
export function ProjectPreviewCard(props: {
  readonly controller: PreviewController
  readonly anchor: DOMRect
  readonly project: ProjectInfo
  /** This project's conversations, newest last — the order the rail built. */
  readonly sessions: readonly SessionInfo[]
  readonly home: string
  readonly installed: readonly AgentId[]
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly onRename: (name: string) => void
  readonly onShowConversation: (conversationId: string) => void
  readonly onToggleAgent: (agentId: AgentId, present: boolean) => Promise<void>
  readonly onChooseProfile: (profileId: string) => Promise<void>
  /** Both only reachable while the project's folder is missing — see `ProjectSettings`. */
  readonly onRelocate: () => Promise<void>
  readonly onForget: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState(false)
  const card = useRef<HTMLDivElement | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  const facts = useProjectFacts(props.sessions.map((session) => session.conversationId))

  const dismiss = props.controller.dismiss
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [dismiss])

  /*
   * Measured once it is real, then held.
   *
   * The card's height depends on how much this project has to say — how many
   * conversations, a running task list, a path of any length — so a position
   * predicted before it renders puts the bottom of it below the window on any
   * tile near the foot of a long list. Hidden for the frame it takes to measure,
   * because being seen in the wrong place first is worse than one frame of
   * nothing.
   */
  useLayoutEffect(() => {
    if (card.current === null) return
    const box = card.current.getBoundingClientRect()
    const margin = 8
    const left = Math.min(
      props.anchor.right + margin,
      Math.max(margin, window.innerWidth - box.width - margin)
    )
    const top = Math.min(
      Math.max(margin, props.anchor.top),
      Math.max(margin, window.innerHeight - box.height - margin)
    )
    setPlaced({ left: Math.round(left), top: Math.round(top) })
  }, [props.anchor])

  return createPortal(
    <div
      ref={card}
      className="session-preview"
      role="tooltip"
      data-project={props.project.id}
      style={{
        left: placed?.left ?? 0,
        top: placed?.top ?? 0,
        visibility: placed === null ? 'hidden' : 'visible',
      }}
      /* Hoverable, which WCAG 2.2 requires of anything shown on hover. */
      onPointerEnter={props.controller.hold}
      onPointerLeave={props.controller.leave}
    >
      {/*
        Double-click renames the project, which is where renaming lives now.

        It renamed a conversation before, for a reason that transfers exactly: a
        tile is two letters and a tab is truncated, and this card already shows
        the whole name and is already where you go to ask about the thing.
      */}
      {renaming ? (
        <input
          className="session-preview-rename"
          defaultValue={props.project.name}
          autoFocus
          aria-label={t('project.renameTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
            }
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              props.onRename(event.currentTarget.value)
              setRenaming(false)
            }
          }}
          onBlur={(event) => {
            props.onRename(event.currentTarget.value)
            setRenaming(false)
          }}
        />
      ) : (
        <p
          className="session-preview-title"
          title={props.project.name}
          onDoubleClick={() => {
            setRenaming(true)
          }}
        >
          {props.project.name}
        </p>
      )}
      <p className="path session-preview-path">{shortenPath(props.project.root)}</p>

      <dl className="session-preview-facts">
        {facts.tokens > 0 && (
          <>
            <dt>{t('preview.spend')}</dt>
            <dd className="session-preview-figure">
              {compactTokens(facts.tokens)}
              {facts.costUsd != null && ` · ${money(facts.costUsd)}`}
            </dd>
          </>
        )}
        {facts.contextPercent !== null && (
          <>
            <dt>{t('preview.context')}</dt>
            <dd className="session-preview-figure">
              {t('context.short', { percent: facts.contextPercent })}
            </dd>
          </>
        )}
        {facts.tasks.length > 0 && (
          <>
            <dt>{t('preview.tasks')}</dt>
            <dd>
              <ul className="session-preview-tasks">
                {facts.tasks.map((task) => (
                  <li key={`${task.conversationId}:${task.agentId}:${task.id}`}>
                    <span className={`session-preview-task-kind voice--${task.agentId}`}>
                      {task.kind}
                    </span>
                    <span className="session-preview-task-what">{task.description}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      {/*
        The pointer is held while a dialog is open: a confirmation takes focus
        to another surface, the pointer leaves the card on its way there, and
        without this the card would close behind it and drop the answer.
      */}
      <div className="session-preview-settings" onPointerEnter={props.controller.hold}>
        <ProjectSettings
          project={props.project}
          sessions={props.sessions}
          home={props.home}
          profiles={props.profiles}
          installed={props.installed}
          onToggleAgent={props.onToggleAgent}
          onChooseProfile={props.onChooseProfile}
          onRelocate={props.onRelocate}
          onForget={props.onForget}
        />
      </div>

      {/*
        The project's conversations, which is what the rail stopped listing.

        Three buttons per row and all three conversation-scoped, because that
        is what they act on: Summary and Changes are that room's panels, End is
        that room's lifecycle. Icon-only, since labelled buttons in a 300px card
        are truncated words — each carries its name in `title` and `aria-label`,
        which is what a screen reader and a hover both read.

        Summary and Changes are here rather than dropped: they had no door at all
        before the card grew one, and moving the card up a level must not close
        it again.
      */}
      <p className="session-settings-label">{t('workspace.sessions')}</p>
      {props.sessions.length === 0 ? (
        <p className="session-preview-empty">{t('project.noConversations')}</p>
      ) : (
        <ul className="project-preview-conversations">
          {props.sessions.map((session) => (
            <li key={session.conversationId}>
              <button
                type="button"
                className="project-preview-conversation"
                title={session.title}
                onClick={() => {
                  props.onShowConversation(session.conversationId)
                }}
              >
                {session.title}
              </button>
              <span className="project-preview-conversation-actions"></span>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body
  )
}
