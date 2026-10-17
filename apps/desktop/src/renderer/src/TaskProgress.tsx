import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TranscriptAssignment } from '../../shared/ipc.js'
import { reduceTask, type TaskBundle } from '../../shared/task-progress.js'
import {
  elapsedParts,
  liveStrip,
  taskStrip,
  tickingLive,
  tickingStrip,
  workDurationParts,
  type DurationPart,
  type LiveSource,
  type StripForecast,
  type StripHandoffLine,
  type StripLiveRow,
  type StripModel,
} from './task-strip.js'

const TICK_MS = 1_000

export function TaskProgress(props: {
  readonly conversationId: string
  readonly task: TaskBundle | null
  readonly assignment: TranscriptAssignment
  readonly syncing: boolean
  readonly working: readonly string[]
  readonly workingSince: Readonly<Record<string, number>>
  readonly live: LiveSource
  readonly onError: (error: unknown) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  const [closing, setClosing] = useState<string | null>(null)
  const [binding, setBinding] = useState<string | null>(null)
  const snapshot = useMemo(
    () => (props.task === null ? null : reduceTask(props.task, now)),
    [props.task, now]
  )
  const model: StripModel | null = taskStrip({
    snapshot,
    syncing: props.syncing,
    working: props.working,
    workingSince: props.workingSince,
    now,
  })
  const live = liveStrip(props.live, now)
  const ticking = tickingStrip(model) || tickingLive(live)

  useEffect(() => {
    if (!ticking) return undefined
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, TICK_MS)
    return () => {
      clearInterval(timer)
    }
  }, [ticking])

  if (model === null && !tickingLive(live)) return null

  const duration = (parts: readonly DurationPart[]): string =>
    parts.map((part) => t(`taskProgress.unit.${part.unit}`, { count: part.value })).join(' ')
  const work = (ms: number): string => duration(workDurationParts(ms))
  const elapsed = (ms: number): string => duration(elapsedParts(ms))
  const agent = (id: string): string => t(`actor.${id}`, { defaultValue: id })

  const liveRow = (row: StripLiveRow): React.JSX.Element => (
    <li key={row.key} className={`task-progress-live-row entry--${row.agentId}`}>
      <span className="task-progress-agent">{agent(row.agentId)}</span>
      {(row.mode === 'chat' || live.mixed) && (
        <span className="task-progress-badge">
          {t(row.mode === 'chat' ? 'taskProgress.live.chat' : 'taskProgress.live.work')}
        </span>
      )}
      {row.from !== null && (
        <span className="task-progress-from">
          {t('taskProgress.live.from', { agent: agent(row.from) })}
        </span>
      )}
      {row.blocked !== null && (
        <span className="task-progress-blocked">
          {t(`taskProgress.live.blocked.${row.blocked}`)}
        </span>
      )}
      {row.operation !== null ? (
        <>
          <span className="task-progress-now">
            {t('taskProgress.live.running', {
              name:
                row.operation.kind === 'command' ? `$ ${row.operation.name}` : row.operation.name,
            })}
          </span>
          {row.operation.detail !== null && (
            <span className="task-progress-detail">{row.operation.detail}</span>
          )}
          <span className="task-progress-clock">
            {t('taskProgress.live.runningFor', { duration: elapsed(row.operation.forMs) })}
          </span>
          {row.moreOperations > 0 && (
            <span className="task-progress-more">
              {t('taskProgress.live.more', { count: row.moreOperations })}
            </span>
          )}
        </>
      ) : (
        row.blocked === null && (
          <span className="task-progress-now">{t(`taskProgress.live.phase.${row.phase}`)}</span>
        )
      )}
      {row.elapsedMs !== null && (
        <span className="task-progress-clock">
          {t('taskProgress.live.elapsed', { duration: elapsed(row.elapsedMs) })}
        </span>
      )}
      {row.updatedMs !== null && (
        <span className="task-progress-age">
          {t('taskProgress.live.updated', { duration: elapsed(row.updatedMs) })}
        </span>
      )}
    </li>
  )

  const handoffLine = (line: StripHandoffLine): React.JSX.Element => (
    <li key={line.handoffId} className="task-progress-handoff">
      <span className="task-progress-agent">
        {t('taskProgress.live.handoff', { from: agent(line.from), to: agent(line.to) })}
      </span>
      <span className={`task-progress-outcome task-progress-outcome--${line.outcome}`}>
        {t(`taskProgress.live.outcome.${line.outcome}`)}
      </span>
      <span className="task-progress-age">
        {t('taskProgress.live.ago', { duration: elapsed(line.ageMs) })}
      </span>
    </li>
  )

  const liveBlock = (caption: boolean): React.JSX.Element | null =>
    tickingLive(live) ? (
      <div className="task-progress-live">
        {caption && (
          <span className="task-progress-live-caption">{t('taskProgress.live.now')}</span>
        )}
        <ul className="task-progress-live-list" aria-label={t('taskProgress.live.label')}>
          {live.rows.map(liveRow)}
          {live.handoffs.map(handoffLine)}
        </ul>
      </div>
    ) : null

  if (model === null) {
    return (
      <section className="task-progress task-progress--live" aria-label={t('taskProgress.label')}>
        <div className="task-progress-head">
          <span className="task-progress-state" role="status">
            {t(
              live.rows.length > 0
                ? 'taskProgress.live.chatActive'
                : 'taskProgress.live.recentHandoffs'
            )}
          </span>
        </div>
        {liveBlock(false)}
      </section>
    )
  }

  if (model.kind === 'activity') {
    return (
      <section
        className="task-progress task-progress--working"
        aria-label={t('taskProgress.label')}
      >
        <div className="task-progress-head">
          <span className="task-progress-state" role="status">
            {t('taskProgress.state.working')}
          </span>
          {model.elapsedMs !== null && (
            <span className="task-progress-clock">
              {t('taskProgress.elapsed', { duration: elapsed(model.elapsedMs) })}
            </span>
          )}
        </div>
        {liveBlock(false)}
      </section>
    )
  }

  const stateLabel =
    model.state === 'waiting' && model.waiting !== null
      ? t(`taskProgress.waiting.${model.waiting}`)
      : t(`taskProgress.state.${model.state}`)

  const forecastLine = (forecast: StripForecast): React.JSX.Element | null => {
    switch (forecast.kind) {
      case 'remaining':
        return (
          <span
            className={
              forecast.frozen
                ? 'task-progress-forecast task-progress-forecast--held'
                : 'task-progress-forecast'
            }
            title={t('taskProgress.rangeHint')}
          >
            {t('taskProgress.remaining', { duration: work(forecast.pointMs) })}
            <span className="task-progress-range">
              {t('taskProgress.range', {
                low: work(forecast.lowMs),
                high: work(forecast.highMs),
              })}
            </span>
            {forecast.rough && (
              <span className="task-progress-badge">{t('taskProgress.rough')}</span>
            )}
            {forecast.paced && (
              <span className="task-progress-badge" title={t('taskProgress.pacedHint')}>
                {t('taskProgress.paced')}
              </span>
            )}
            {forecast.frozen && (
              <span className="task-progress-held">{t('taskProgress.onHold')}</span>
            )}
          </span>
        )
      case 'over':
        return (
          <span className="task-progress-forecast task-progress-forecast--over">
            {forecast.overMs > 0
              ? t('taskProgress.over', { duration: work(forecast.overMs) })
              : t('taskProgress.estimateReached')}
          </span>
        )
      case 'unestimated':
        return (
          <span className="task-progress-forecast task-progress-forecast--none">
            {t('taskProgress.unestimated')}
          </span>
        )
      case 'finishing':
        return <span className="task-progress-forecast">{t('taskProgress.finishing')}</span>
      case 'stepsDone':
        return <span className="task-progress-forecast">{t('taskProgress.stepsDone')}</span>
      case 'none':
        return model.closed ? null : (
          <span className="task-progress-forecast task-progress-forecast--none">
            {t('taskProgress.noEstimate')}
          </span>
        )
    }
  }

  const partial =
    (model.forecast.kind === 'remaining' || model.forecast.kind === 'over') &&
    model.forecast.partial

  const close = (): void => {
    const taskId = model.taskId
    setClosing(taskId)
    void window.chorus
      .closeTask({ conversationId: props.conversationId, taskId, reason: 'abandoned' })
      .then(({ closed }) => {
        if (!closed) props.onError(new Error(t('taskProgress.closeStale')))
      })
      .catch(props.onError)
      .finally(() => {
        setClosing(null)
      })
  }

  const bind = (): void => {
    const taskId = model.taskId
    setBinding(taskId)
    void window.chorus
      .bindAssignment({ conversationId: props.conversationId, taskId })
      .then(({ bound }) => {
        if (!bound) props.onError(new Error(t('taskProgress.forwarded.stale')))
      })
      .catch(props.onError)
      .finally(() => {
        setBinding(null)
      })
  }

  const change = model.change
  const changeParts =
    change === null
      ? []
      : [
          change.deltaMs === null
            ? null
            : t(change.deltaMs > 0 ? 'taskProgress.change.more' : 'taskProgress.change.less', {
                duration: work(Math.abs(change.deltaMs)),
              }),
          change.added > 0 ? t('taskProgress.change.added', { count: change.added }) : null,
          change.removed > 0 ? t('taskProgress.change.removed', { count: change.removed }) : null,
          change.split > 0 ? t('taskProgress.change.split', { count: change.split }) : null,
          change.reason,
        ].filter((part): part is string => part !== null && part !== '')

  return (
    <section
      className={`task-progress task-progress--${model.state}`}
      aria-label={t('taskProgress.label')}
    >
      <div className="task-progress-head">
        <span className="task-progress-state" role="status">
          {stateLabel}
        </span>
        {model.resetsAt !== null && (
          <span className="task-progress-reset">
            {t('taskProgress.resets', {
              time: new Date(model.resetsAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </span>
        )}
        {forecastLine(model.forecast)}
        {!model.closed && (
          <button
            type="button"
            className="task-progress-close"
            title={t('taskProgress.closeHint')}
            disabled={closing === model.taskId}
            onClick={close}
          >
            {t('taskProgress.close')}
          </button>
        )}
        {props.assignment.linked &&
          (props.assignment.boundTaskId === model.taskId ? (
            <span className="task-progress-badge" title={t('taskProgress.forwarded.boundHint')}>
              {t('taskProgress.forwarded.bound')}
            </span>
          ) : (
            <button
              type="button"
              className="task-progress-close task-progress-bind"
              title={t('taskProgress.forwarded.markHint')}
              disabled={binding !== null}
              onClick={bind}
            >
              {t('taskProgress.forwarded.mark')}
            </button>
          ))}
      </div>
      <div className="task-progress-clocks">
        <span className="task-progress-clock">
          {t(model.closed ? 'taskProgress.total' : 'taskProgress.elapsed', {
            duration: elapsed(model.elapsedMs),
          })}
        </span>
        {model.waitingMs >= TICK_MS && (
          <span className="task-progress-clock">
            {t('taskProgress.waited', { duration: elapsed(model.waitingMs) })}
          </span>
        )}
        {model.pausedMs >= TICK_MS && (
          <span className="task-progress-clock">
            {t('taskProgress.pausedFor', { duration: elapsed(model.pausedMs) })}
          </span>
        )}
      </div>
      {model.lanes.map((lane) => (
        <div key={lane.agentId} className={`task-progress-step entry--${lane.agentId}`}>
          <span className="task-progress-agent">{agent(lane.agentId)}</span>
          <span className="task-progress-position">
            {t('taskProgress.step', { index: lane.mainIndex, total: lane.mainTotal })}
          </span>
          <span className="task-progress-title">
            {t('taskProgress.stepTitle', { label: lane.label, title: lane.title })}
          </span>
          {lane.substeps !== null && (
            <span className="task-progress-substeps">
              {t('taskProgress.substeps', { done: lane.substeps.done, total: lane.substeps.total })}
            </span>
          )}
        </div>
      ))}
      {model.progress !== null && (
        <div className="task-progress-steps">
          <progress
            className="task-progress-bar"
            value={model.progress.done}
            max={model.progress.total}
            aria-label={t('taskProgress.mainSteps', {
              done: model.progress.done,
              total: model.progress.total,
            })}
          />
          <span className="task-progress-count">
            {t('taskProgress.mainSteps', {
              done: model.progress.done,
              total: model.progress.total,
            })}
          </span>
        </div>
      )}
      {partial && <p className="task-progress-note">{t('taskProgress.partial')}</p>}
      {changeParts.length > 0 && (
        <p className="task-progress-note">
          {t('taskProgress.change.revised', { details: changeParts.join(' · ') })}
        </p>
      )}
      {liveBlock(model.lanes.length > 0)}
    </section>
  )
}
