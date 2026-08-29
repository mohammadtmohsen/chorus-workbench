import { useTranslation } from 'react-i18next'
import { ALL_AGENTS, shortenPath, type AgentId, type SessionInfo } from '../Session.js'
import { useEveryPlanning, useWorkspaceActions } from './hooks.js'
import type { ProjectInfo } from './session-row.js'

/**
 * Everything a **project** can be configured to be, in one block.
 *
 * It was `SessionSettings` and every control in it asked the same question one
 * level too low. A permission profile is an answer about a *place* — "agents may
 * write in this repository" — so asking it per conversation both repeated the
 * question and let two rooms in one directory disagree about what could be run
 * there. The cast is the same: a project you work on with Codex is a fact about
 * the project, not about the third conversation you opened in it. The folder was
 * always a project fact and was merely being displayed from a conversation.
 *
 * Plan mode is the one that is not durable, and it is here anyway. It is runtime
 * state — the store holds it, nothing persists it, and CLAUDE.md's "state is not
 * history" is why. What "project level" means for it is therefore *fan-out*
 * rather than storage: the toggle sets every live conversation in the project at
 * once, and reads as On only when they all are.
 *
 * It renders no surface of its own: no portal, no positioning, no dismissal.
 * Those differ between a menu opened by a click and a card opened by a pointer,
 * and they are the host's business. This is the contents.
 */

export interface ProjectSettingsProps {
  readonly project: ProjectInfo
  /** Every conversation in this project. Plan mode fans out over exactly these. */
  readonly sessions: readonly SessionInfo[]
  readonly home: string
  readonly profiles: readonly {
    readonly id: string
    readonly name: string
    readonly summary: string
  }[]
  readonly installed: readonly AgentId[]
  readonly onToggleAgent: (agentId: AgentId, present: boolean) => Promise<void>
  readonly onChooseProfile: (profileId: string) => Promise<void>
  /** Opens the folder picker and points this project at what comes back. */
  readonly onRelocate: () => Promise<void>
  /** Drops the project from the registry. Its conversations stay in the log. */
  readonly onForget: () => Promise<void>
}

export function ProjectSettings(props: ProjectSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { setPlanning } = useWorkspaceActions()
  const planning = useEveryPlanning(props.sessions.map((session) => session.conversationId))

  /*
   * The cast the project has been *told*, falling back to what is actually in
   * its conversations.
   *
   * A project that has never been asked has `agentIds === null`, and showing an
   * empty cast for it would be wrong twice over: it has agents, and the toggles
   * would offer to add one that is already there. The union of what is running
   * is the honest answer for that case — it is what the person would see if they
   * looked. **Only null falls back**: `[]` is a project somebody deliberately
   * emptied and must render empty.
   */
  const cast = props.project.agentIds ?? [
    ...new Set(props.sessions.flatMap((session) => session.participants)),
  ]

  return (
    <div className="session-settings">
      <p className="session-settings-label">{t('conversation.cast')}</p>
      <ul className="session-settings-agents">
        {ALL_AGENTS.map((agent) => {
          const here = cast.includes(agent)
          const available = props.installed.includes(agent)
          return (
            <li key={agent}>
              <button
                type="button"
                className={`voice voice--${agent}`}
                data-on={here}
                aria-pressed={here}
                disabled={!here && !available}
                title={
                  available
                    ? t(here ? 'conversation.removeAgent' : 'conversation.addAgent', { agent })
                    : t('agents.notFound', { agent })
                }
                onClick={() => {
                  void props.onToggleAgent(agent, here)
                }}
              >
                <span className="voice-dot" aria-hidden="true" />
                {agent}
              </button>
            </li>
          )
        })}
      </ul>

      {/*
        A label, not a control, and now for the reason it always should have
        been: this is the project's own root. Moving it is `relocate`, one
        explicit operation that restarts everything running against the old
        path, and it does not belong behind a hover card.

        **Unless the folder has gone**, which is the one case where the label has
        to become a control. There is no other surface that can answer it: the
        rail draws a tile, the tab strip draws conversations, and everything else
        that touches a project root fails on it rather than offering to fix it.
        So the two ways out live here, next to the path they are about.
      */}
      <p className="session-settings-label">{t('conversation.projectFolder')}</p>
      <div className="session-settings-folder" data-missing={props.project.missing}>
        <p className="path session-settings-path" title={props.project.root}>
          {shortenPath(props.project.root)}
        </p>
      </div>
      {props.project.missing && (
        <div className="session-settings-missing">
          <p className="notice notice--bad" role="alert">
            {t('project.folderMissing')}
          </p>
          <div className="session-settings-missing-actions">
            <button
              type="button"
              className="btn btn--go"
              onClick={() => {
                void props.onRelocate()
              }}
            >
              {t('project.locateFolder')}
            </button>
          </div>
        </div>
      )}

      <p className="session-settings-label">{t('aside.profileLabel')}</p>
      <ul className="session-settings-profiles" role="listbox">
        {props.profiles.map((profile) => {
          /*
           * A project that has never been asked shows nothing selected rather
           * than guessing. The renderer does not know what main's default
           * profile is, and inventing one here would put a tick beside a value
           * nobody chose — which is exactly the state this setting exists to
           * end. The first choice writes it.
           */
          const selected = profile.id === props.project.profileId
          return (
            <li key={profile.id}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                data-on={selected}
                className="profile-option"
                onClick={() => {
                  if (selected) return
                  void props.onChooseProfile(profile.id)
                }}
              >
                <span className="profile-option-name">{profile.name}</span>
                <span className="profile-option-summary">{profile.summary}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <p className="session-settings-label">{t('plan.label')}</p>
      {/*
        Plan mode for a whole project, which is a fan-out rather than a setting.

        **On only when every conversation is**, and that asymmetry is
        deliberate. A control reading On while one of four rooms is still free
        to edit files would claim a guarantee the project does not have, and the
        safe direction for a mode whose whole purpose is restraint is to
        under-report it. An empty project reads Off and is disabled: it is not
        in plan mode, it is in no mode.
      */}
      <button
        type="button"
        className="session-settings-plan"
        aria-pressed={planning}
        disabled={props.sessions.length === 0}
        title={
          props.sessions.length === 0
            ? t('plan.label')
            : planning
              ? t('plan.leave')
              : t('plan.enter')
        }
        onClick={() => {
          const next = !planning
          for (const session of props.sessions) {
            const conversationId = session.conversationId
            window.chorus
              .setPlanMode({ conversationId, on: next })
              /*
               * Each session's own answer, not the click's intent: a mode that
               * failed to change must not leave the control claiming it did.
               * They settle independently, so a project can briefly be
               * half-planning — which the "every" rule renders as Off,
               * correctly.
               */
              .then((result) => {
                setPlanning(conversationId, result.planning)
              })
              .catch(() => {
                // The previous state is the truthful one.
              })
          }
        }}
      >
        {planning ? t('preview.planOn') : t('preview.planOff')}
      </button>

      {/*
        Last, and alone, because it is the only thing on this card that cannot be
        undone. Everything above it — the profile, the cast, plan mode — is a
        setting you can set back. This deletes the project, its conversations and
        every event they recorded, and re-adding the folder afterwards gives you
        a new empty project rather than this one.

        **It does not confirm**, which was asked for explicitly and is worth
        saying out loud here rather than leaving as an absence. The separation
        and the wording are therefore the whole safety margin: it is the only
        `--danger` control on the card, and it says what it removes rather than
        the bare "Remove project" it used to say when it only ever appeared
        beside a folder that had already vanished.
      */}
      <div className="session-settings-danger">
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            void props.onForget()
          }}
        >
          {t('project.removeProject')}
        </button>
        <p className="session-settings-danger-note">{t('project.removeProjectNote')}</p>
      </div>
    </div>
  )
}
