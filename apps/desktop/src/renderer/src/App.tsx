import { useCallback, useEffect, useRef, useState } from 'react'
import { ErrorNotice } from './ErrorNotice.js'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AgentProbeResult, IpcResponse } from '../../shared/ipc.js'
import { ChorusLogo } from './ChorusLogo.js'
import { LogViewer } from './LogViewer.js'
import { fail, Session, type AgentId, type SessionCarry, type SessionInfo } from './Session.js'
import { trimCarry } from './carry.js'
import { EMPTY_VIEW } from './transcript.js'
import { noticesFrom, roomsWaiting, shouldRaise, trackPending, type Notice } from './notify.js'
import { HistoryPanel } from './HistoryPanel.js'
import { INSTALL, Settings, type Defaults } from './Settings.js'
import { Workspace } from './workspace/Workspace.js'
import { sameWorkspaceSnapshot, useWorkspaceStore, workspaceSnapshot } from './workspace/store.js'
import { reorderSessions } from './workspace/session-row.js'
import { setRunningPlatform } from './shortcuts.js'

/**
 * Raises one banner, and makes clicking it land somewhere useful.
 *
 * Bringing the window forward is not enough on its own: a notification that
 * drops you into whichever pane you left open is a second thing to do rather
 * than the thing done, so it opens the conversation it was about.
 */
function raise(notice: Notice, title: string, t: TFunction, projectId: string): void {
  try {
    const banner = new Notification(t(`notify.${notice.kind}`, { agent: notice.actor }), {
      body: title,
      // One banner per conversation: a room that finishes twice while you are
      // away should replace its own notice, not stack.
      tag: notice.conversationId,
    })
    banner.onclick = () => {
      void window.chorus.focusWindow()
      useWorkspaceStore.getState().openProject(projectId)
      useWorkspaceStore.getState().clearConversationUnread(notice.conversationId)
    }
  } catch {
    // Denied at the OS level, or unsupported. Silence is the only sane response
    // to a failure whose only symptom would be another failure.
  }
}

/**
 * How long to sit on read-watermarks before writing them down.
 *
 * `open-sessions.json` is rewritten whole on every `markSeen`, and a streaming
 * turn would otherwise trigger one per push. A second of lag costs nothing: the
 * worst case is a card that says one unread instead of none.
 */
const SEEN_DEBOUNCE_MS = 1_000

export function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  /** Where "no folder" resolves to, so a card can say which it is looking at. */
  const [home, setHome] = useState('')
  const [probes, setProbes] = useState<AgentProbeResult[] | null>(null)
  const [profiles, setProfiles] = useState<{ id: string; name: string; summary: string }[]>([])
  /** The registry, most recently opened first — the order the rail draws in. */
  const [projects, setProjects] = useState<IpcResponse<'project:list'>['projects']>([])
  const [defaults, setDefaults] = useState<Defaults>({
    /* Matches the main process's default, and has to keep matching it: this
       stands only until `readSettings` answers, but a session started inside
       that window opens with whatever is written here. */
    agents: ['claude', 'codex'],
    cwd: '',
    profileId: 'read-only',
  })
  /**
   * Whether `readSettings` has answered yet.
   *
   * Not "did it succeed" — only that the question has been asked and returned,
   * so the auto-start effect below knows `defaults` is as good as it is going
   * to get. Without this the first session of a launch could be created from
   * the placeholder above, which is the home-directory bug.
   */
  const [settingsRead, setSettingsRead] = useState(false)
  /**
   * The language explanations come back in, or empty when none is set.
   *
   * Held here rather than in each pane because it decides whether a button
   * exists under every reply, so a pane cannot wait for a selection to learn it.
   * Read on mount and again whenever the settings sheet closes — the sheet is
   * the only place it can change from inside the app, and `readSettings` is a
   * file read, so re-reading on a dialog close costs nothing worth measuring.
   *
   * Kept out of `defaults`, which is what a *new session* opens with. This is
   * about every session already open.
   */
  const [explainLanguage, setExplainLanguage] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  /** So the opening session of a launch is opened once, and only on a launch. */
  const autoStarted = useRef(false)
  const carries = useRef(new Map<string, SessionCarry>())
  /**
   * Unanswered approvals and questions per conversation, for the dock badge.
   *
   * A ref rather than state: nothing renders from it, and holding it outside the
   * subscription means a language change re-subscribing cannot reset the count.
   */
  const pending = useRef<Readonly<Record<string, readonly string[]>>>({})
  /**
   * How far each on-screen conversation has been read, waiting to be written down.
   *
   * Batched rather than sent per push: a streaming turn produces many, the file
   * behind it is rewritten whole on every call, and being a second behind costs
   * nothing — the worst case is a card that says one unread instead of none.
   */
  const seen = useRef<Readonly<Record<string, number>>>({})
  const seenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showingLogs, setShowingLogs] = useState(false)
  const [showingSettings, setShowingSettings] = useState(false)
  const [showingHistory, setShowingHistory] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [restored, setRestored] = useState(false)
  const [zoom, setZoom] = useState<number | null>(null)

  const markSeenSoon = useCallback(() => {
    clearTimeout(seenTimer.current)
    seenTimer.current = setTimeout(() => {
      const batch = seen.current
      seen.current = {}
      for (const [conversationId, seq] of Object.entries(batch)) {
        // Fire and forget: the runtime ignores a watermark that moves backwards,
        // and a lost one costs a card that overstates by one after the next launch.
        void window.chorus.markSeen({ conversationId, seq })
      }
    }, SEEN_DEBOUNCE_MS)
  }, [])

  useEffect(
    () => () => {
      clearTimeout(seenTimer.current)
    },
    []
  )

  const updateSessions = useCallback((change: (current: SessionInfo[]) => SessionInfo[]) => {
    setSessions((current) => {
      const next = change(current)
      sessionsRef.current = next
      return next
    })
  }, [])

  /**
   * Puts a conversation from the history list on screen.
   *
   * One that is already open only needs focusing — reopening it would ask the
   * runtime to start a second set of agents for a room that already has them.
   * Anything else comes back through the runtime, which starts its agents and
   * hands them the transcript as catch-up.
   */
  const openFromHistory = useCallback(
    async (conversationId: string) => {
      const already = sessionsRef.current.find(
        (session) => session.conversationId === conversationId
      )
      if (already !== undefined) {
        useWorkspaceStore.getState().openProject(already.projectId)
        useWorkspaceStore.getState().clearConversationUnread(conversationId)
        return
      }
      const reopened = await window.chorus.reopenConversation({ conversationId })
      updateSessions((current) => [...current, reopened])
      useWorkspaceStore.getState().openProject(reopened.projectId)
      useWorkspaceStore.getState().adoptConversation(reopened.projectId, reopened.conversationId)
      useWorkspaceStore.getState().clearConversationUnread(reopened.conversationId)
    },
    [updateSessions]
  )

  /*
   * Status is global and deliberately tiny. Active Session components still
   * reduce full transcripts; this listener lets closed/background tabs say an
   * agent is working or waiting without keeping markdown trees mounted.
   */
  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        useWorkspaceStore.getState().ingestEvents(events)
      }),
    []
  )

  /*
   * Notifications and the dock badge.
   *
   * Beside the other global listeners, and for the same reason: this has to work
   * for conversations whose `Session` is not mounted, which is most of them once
   * more than four are open. The judgement about what deserves a banner lives in
   * `notify.ts` so it can be tested; this is only the plumbing.
   */
  useEffect(
    () =>
      window.chorus.onEvents((events) => {
        pending.current = trackPending(pending.current, events)
        void window.chorus.setBadge({ count: roomsWaiting(pending.current) })

        const panes = useWorkspaceStore.getState().panes
        const visibleConversationIds = Object.values(panes)
          .map((pane) => pane.activeTabId)
          .filter((id): id is string => id !== null)

        /*
         * Record how far each visible card has been read, so the next launch can
         * count what was missed rather than claiming nothing happened.
         *
         * The sequence comes from the batch, not from the store: two subscribers
         * read the same push and their order is undefined, so the pulse may not
         * have folded these events yet. What is in hand cannot be stale.
         */
        for (const id of visibleConversationIds) {
          const highest = events.reduce(
            (best, event) => (event.conversationId === id && event.seq > best ? event.seq : best),
            0
          )
          if (highest > (seen.current[id] ?? 0)) {
            seen.current = { ...seen.current, [id]: highest }
          }
        }
        markSeenSoon()

        // Absent in a test renderer, and not worth a failed turn.
        if (!('Notification' in window)) return
        for (const notice of noticesFrom(events)) {
          if (
            !shouldRaise(notice, { windowFocused: document.hasFocus(), visibleConversationIds })
          ) {
            continue
          }
          const session = sessionsRef.current.find(
            (s) => s.conversationId === notice.conversationId
          )
          raise(notice, session?.title ?? '', t, session?.projectId ?? '')
        }
      }),
    [t, markSeenSoon]
  )

  /*
   * Context fill, on its own channel because it is not a logged event.
   *
   * Subscribed here beside the event listener for the same reason: it has to
   * reach cards whose `Session` is not mounted, and this is the one place that
   * is always listening.
   */
  useEffect(
    () =>
      window.chorus.onContextUsage((usage) => {
        useWorkspaceStore.getState().ingestContextUsage(usage)
      }),
    []
  )

  /*
   * The editor's context, on the same footing and for the same reason — Phase 6.
   *
   * It was a listener inside `Session`, and only the active tab of each group is
   * mounted: a push for a conversation in a background tab reached nothing, and
   * switching back re-created the component with both slots empty. Nothing put
   * it back, because main replays on runtime events and not on a React component
   * mounting — so the composer's `ideAttached` was false for a reason that had
   * nothing to do with the editor.
   *
   * Context is state, not history. It belongs where the pulse lives.
   */
  useEffect(
    () =>
      window.chorus.onIdeContext((push) => {
        useWorkspaceStore.getState().ingestIdeContext(push)
      }),
    []
  )

  /* What each agent left running, on its own channel and for the same reason. */
  useEffect(
    () =>
      window.chorus.onTasks((push) => {
        useWorkspaceStore.getState().ingestTasks(push)
      }),
    []
  )

  /*
   * What each agent says it is doing, on its own channel for the same reason
   * again — and this one is the reason the family exists. It arrives many times
   * a turn, which is exactly what must never be written to the log.
   */
  useEffect(
    () =>
      window.chorus.onActivity((push) => {
        useWorkspaceStore.getState().ingestActivity(push)
      }),
    []
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    /*
     * The hydration itself is not a rearrangement, and echoing it back to disk
     * is actively destructive.
     *
     * `hydrate` flips `hydrated` false→true, which the selector below counts as
     * a change, so the very first emission is the store repeating what was just
     * read. On a *first* run that is worse than redundant: the file's `null`
     * workspace is what tells `reconcileWorkspace` "this predates the shell,
     * open everything", and overwriting it with the seeded empty snapshot
     * relabels it "the user closed every tab". That write also lands before the
     * auto-started session has opened its pane, so the next launch restores a
     * running session into an empty editor and the force-open path can never
     * fire again.
     *
     * Only what happens after the seed is the user's doing.
     */
    let seeded = false
    const stop = useWorkspaceStore.subscribe(
      (state) => ({ ...workspaceSnapshot(state), hydrated: state.hydrated }),
      (next) => {
        if (!next.hydrated) return
        if (!seeded) {
          seeded = true
          return
        }
        clearTimeout(timer)
        timer = setTimeout(() => {
          window.chorus
            .writeConversationLayout({
              order: sessionsRef.current.map((session) => session.conversationId),
              /*
               * Taken from the snapshot function, not typed out field by field.
               *
               * It *was* typed out, and that is the same defect the equality
               * comment below records from the other side: a field added to
               * `WorkspaceSnapshot` and forgotten here is silently never
               * persisted. Reading it through `workspaceSnapshot` means adding a
               * field cannot be forgotten, because there is nothing to remember.
               *
               * Current state rather than the `next` that triggered this: the
               * write is 180ms debounced, so `next` is by then one of several
               * changes that have happened, and the last one is the one worth
               * saving. The other two write paths — `reorder` and `commitLayout`
               * — already send the whole current snapshot for the same reason.
               */
              workspace: workspaceSnapshot(useWorkspaceStore.getState()),
            })
            .catch(fail(setError))
        }, 180)
      },
      {
        /*
         * Compare every field the write above sends, not a list of them.
         *
         * This was six fields typed out by hand, and it silently stopped
         * matching what `workspaceSnapshot` carries: `terminals` and
         * `globalTerminal` were never added, so opening or resizing a terminal
         * panel compared *equal* and was never written. `sameWorkspaceSnapshot`
         * reads its keys off the schema, so the next field is covered by
         * construction. `hydrated` stays explicit because it is not part of the
         * snapshot — it is the guard that stops hydration echoing back to disk.
         */
        equalityFn: (left, right) =>
          left.hydrated === right.hydrated && sameWorkspaceSnapshot(left, right),
      }
    )
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [])

  useEffect(() => {
    window.chorus
      .getAppInfo()
      .then(({ appVersion: version, home: where, platform }) => {
        setAppVersion(version)
        setHome(where)
        // Held at module scope in `shortcuts.ts` rather than in state: the
        // keyboard handlers read it at event time, and Workspace's listener
        // effect is deliberately `[]` so a prop would be captured stale.
        setRunningPlatform(platform)
      })
      .catch(() => {
        setAppVersion(null)
      })
    /*
     * One listener for the app, writing into the store — Phase 6.
     *
     * It was a listener per `Session`, and only the active tab of each group is
     * mounted: a push for a conversation whose tab was in the background reached
     * nothing, and switching back re-created the component with empty state. The
     * editor context is state rather than an event, so it belongs where the
     * pulse does — outside the component that draws it.
     */
    window.chorus.probeAgents().then(setProbes).catch(fail(setError))
    window.chorus.profiles().then(setProfiles).catch(fail(setError))
    window.chorus
      .listProjects({})
      .then(({ projects: listed }) => {
        setProjects(listed)
      })
      .catch(fail(setError))
    window.chorus
      .readSettings()
      .then(({ agents, cwd, profileId, explainLanguage: language }) => {
        setDefaults({ agents, cwd, profileId })
        setExplainLanguage(language)
      })
      .catch(fail(setError))
      /*
       * Answered, whether or not it answered well.
       *
       * The auto-start effect waits on this, so it has to be set on the failure
       * path too — a settings file that cannot be read must still leave the app
       * able to open a session, just with the built-in defaults.
       */
      .finally(() => {
        setSettingsRead(true)
      })

    /*
     * The visual grace may expire, but a new session still waits for the real
     * restore result. That distinction prevents one slow provider from creating
     * another duplicate session on every launch.
     */
    const grace = setTimeout(() => {
      setRestoring(false)
    }, 1_500)
    window.chorus
      .restoreConversations()
      .then(({ sessions: reopened, workspace }) => {
        /*
         * Merged out here, and the store written after — C-048.
         *
         * This whole block used to sit inside `updateSessions`, which passes its
         * argument to `setSessions` as an **updater**. React invokes an updater
         * during the render phase, so every store write in here was a write
         * while `App` was rendering, and `EditorPane` subscribes to that store:
         * "Cannot update a component (EditorPane) while rendering a different
         * component (App)", once, at boot.
         *
         * The board had cleared `hydrate` on the grounds that it is "inside a
         * promise rather than render". It is inside a promise — the promise
         * merely *calls* `updateSessions`, and the body runs later, when React
         * gets to it. That is the gap the entry was missing.
         *
         * `sessionsRef.current` is what the updater's `current` would have been:
         * `updateSessions` keeps it in step on every write, and restore happens
         * once at boot with nothing else racing it.
         */
        const current = sessionsRef.current
        {
          const merged = [
            ...reopened.filter(
              (candidate) =>
                !current.some((session) => session.conversationId === candidate.conversationId)
            ),
            ...current,
          ]
          /*
           * A draft typed before the last quit.
           *
           * Seeded into the carry rather than passed to the pane directly,
           * because the carry is already the one path a draft travels — the
           * composer reads it there whether it came from a backgrounded tab or
           * from disk.
           */
          for (const session of reopened) {
            if (session.draft === '') continue
            const held = carries.current.get(session.conversationId)
            carries.current.set(session.conversationId, {
              view: held?.view ?? EMPTY_VIEW,
              draft: session.draft,
              attached: held?.attached ?? [],
              following: held?.following ?? true,
              scrollTop: held?.scrollTop ?? 0,
            })
          }
          useWorkspaceStore.getState().hydrate(
            workspace,
            merged.map((session) => session.conversationId),
            [...new Set(merged.map((session) => session.projectId))],
            // Counted by the main process out of the log, against the watermark
            // saved when each card was last on screen.
            Object.fromEntries(reopened.map((session) => [session.conversationId, session.unread])),
            /*
             * Which conversations each project holds. The two flat lists above
             * cannot express it, and the inner columns are built from exactly
             * this — a project missing here has its arrangement dropped rather
             * than kept pointing at conversations nobody is running.
             */
            merged.reduce<Record<string, string[]>>((byProject, session) => {
              ;(byProject[session.projectId] ??= []).push(session.conversationId)
              return byProject
            }, {})
          )
          /*
           * Plan mode, seeded after the hydrate that clears it.
           *
           * It used to live inside the toggle that set it, so nothing outside
           * that one control could say whether a session was reading-only. The
           * preview says it now, and the runtime is the only thing that knows —
           * the mode belongs to a running agent, not to a saved file.
           */
          for (const session of reopened) {
            if (session.planning) {
              useWorkspaceStore.getState().setPlanning(session.conversationId, true)
            }
          }
          /*
           * Last, and not through an updater. Everything above has already been
           * decided from `current`, so this is a plain assignment of a value
           * rather than a function React may call whenever it likes.
           */
          updateSessions(() => merged)
        }
      })
      .catch(fail(setError))
      .finally(() => {
        clearTimeout(grace)
        setRestoring(false)
        setRestored(true)
      })
    return () => {
      clearTimeout(grace)
    }
  }, [updateSessions])

  const remember = useCallback((patch: Partial<Defaults>) => {
    setDefaults((current) => ({ ...current, ...patch }))
    window.chorus.writeSettings(patch).catch(fail(setError))
  }, [])

  /*
   * The one setting a pane draws continuously, kept current from anywhere.
   *
   * Main echoes every write to every window, so this covers the sheet, a second
   * window and anything writing through the channel directly. `closeSettings`
   * below still re-reads: a push can only report a write that happened, and a
   * sheet closed without one should still leave this holding the truth.
   */
  useEffect(
    () =>
      window.chorus.onSettings((settings) => {
        setExplainLanguage(settings.explainLanguage)
      }),
    []
  )

  /**
   * Closing the settings sheet, and re-reading the one setting the panes draw.
   *
   * The sheet owns the language field and persists it on every keystroke, so the
   * file is authoritative and this component's copy is not. Re-read here rather
   * than lifted into a prop the sheet writes back: the sheet is `Settings`'s to
   * own, and the alternative — a push channel — is what `SCALE_PUSH_CHANNEL`
   * exists for and is worth its five files only for something that changes
   * behind the user's back. This does not.
   */
  const closeSettings = useCallback(() => {
    setShowingSettings(false)
    window.chorus
      .readSettings()
      .then(({ explainLanguage: language }) => {
        setExplainLanguage(language)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = window.chorus.onScale((next) => {
      setZoom(next)
      clearTimeout(timer)
      timer = setTimeout(() => {
        setZoom(null)
      }, 1_400)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [])

  /*
   * The projects rail's data. Refreshed rather than patched after anything that
   * could change it, because `openConversations` is a count main computes and a
   * renderer guessing at it would drift the moment a session ended anywhere else.
   */
  const refreshProjects = useCallback(async () => {
    try {
      const { projects: listed } = await window.chorus.listProjects({})
      setProjects(listed)
      return listed
    } catch (error) {
      fail(setError)(error)
      return []
    }
  }, [])

  /*
   * Starting a session, now in a project rather than in a directory.
   *
   * `defaults.cwd` used to decide this, which meant a session could be created
   * in a folder nobody had adopted — and on the first launch of all, before
   * settings had loaded, in the home directory. There is no path in this
   * function any more: without a project there is nothing to start, and Add
   * Project is the affordance that fixes that.
   */
  const startIn = useCallback(
    (projectId: string) => {
      setError(null)
      setStarting(true)
      window.chorus
        .startConversation({
          agents: defaults.agents,
          projectId,
          profileId: defaults.profileId,
        })
        .then(async (session) => {
          updateSessions((current) => [...current, session])
          useWorkspaceStore.getState().openProject(session.projectId)
          /* A tab for it, in the focused group. Without this the conversation
             streams into a project that has nowhere to show it until relaunch. */
          useWorkspaceStore.getState().adoptConversation(session.projectId, session.conversationId)
          useWorkspaceStore.getState().clearConversationUnread(session.conversationId)
          await refreshProjects()
        })
        .catch(fail(setError))
        .finally(() => {
          setStarting(false)
        })
    },
    [defaults, updateSessions, refreshProjects]
  )

  /*
   * `+` starts in the most recently opened project, which is what the list is
   * ordered by. It is disabled when there are none, so this is a guard rather
   * than a fallback — silently adopting something would be inventing a project
   * the person did not choose.
   */
  /*
   * The most recent project **whose folder is still there**.
   *
   * Skipping the missing ones is what stops one stale project taking the app
   * down with it. `startConversation` resolves the root in main and throws
   * `ProjectRootMissingError` when it has gone; on launch that rejection reached
   * `setError`, and because a boot error renders `Stuck` instead of the
   * workspace, a renamed checkout meant the whole app was one error screen —
   * with no route to the project card that could have fixed it.
   *
   * Restore already worked this way: `restoreOpenConversations` catches the same
   * refusal per conversation and carries on. This is the same rule one level up,
   * and the two now agree.
   */
  const start = useCallback(() => {
    const mostRecent = projects.find((project) => !project.missing)
    if (mostRecent === undefined) return
    startIn(mostRecent.id)
  }, [projects, startIn])

  /*
   * A rail tile switches to a project. It does not start a conversation.
   *
   * It used to call `startIn`, so every click on a project opened a *new* room —
   * clicking the project you were already in gave you a second one, and there is
   * no way to click a tile meaning "show me that project" without also creating
   * something. Switching is what the gesture reads as.
   *
   * A project with nothing open lands on an empty column, which is the honest
   * result and not a dead end: the strip's `+` starts a conversation there, and
   * that is the one control whose whole job is to say so.
   */
  const showProject = useCallback((projectId: string) => {
    useWorkspaceStore.getState().openProject(projectId)
  }, [])

  const addProject = useCallback(async () => {
    setError(null)
    try {
      const { project } = await window.chorus.adoptProject({})
      if (project === null) return
      const listed = await refreshProjects()
      // A folder that was already a project opens rather than announcing itself;
      // a new one starts its first conversation, because an empty project has
      // nothing to show and Add Project is not a filing exercise.
      if (project.created || listed.every((p) => p.openConversations === 0)) {
        startIn(project.id)
      }
    } catch (error) {
      fail(setError)(error)
    }
  }, [refreshProjects, startIn])

  /*
   * The first session waits for the settings, not just for the restore.
   *
   * `restored` and `readSettings` are two independent round trips, and this
   * effect used to fire on the first of them. When restore won — which it
   * usually does, being a database read against a small JSON read — `start()`
   * ran with `defaults.cwd` still at its placeholder `''`, and the runtime
   * reads an empty directory as "start at home". So the opening session of a
   * launch opened on the **home directory** instead of the configured folder,
   * and the Changes panel dutifully listed every dotfile in it.
   *
   * It looked like a path-resolution bug and was a race. Nothing resolved
   * wrongly: `''` really does mean home, and the session really was started
   * before anyone had said otherwise.
   *
   * Confirmed rather than assumed: the settings on this machine name a real
   * folder, and the session still opened at home.
   */
  /*
   * Two conditions were implicit before and are not any more.
   *
   * It needs a **project**, because `start()` cannot invent one; and it must fire
   * **once per launch**, because the moment it also waited on `projects` it
   * became able to fire when the first project was adopted — racing
   * `addProject`'s own start and giving two conversations for one click. "The
   * opening session of a launch" was always the intent; it used to be enforced
   * by the fact that `sessions.length > 0` right afterwards, which is a
   * consequence rather than a guard.
   */
  useEffect(() => {
    if (autoStarted.current) return
    if (!restored || !settingsRead || starting || sessions.length > 0 || error !== null) return
    if (projects.length === 0) return
    autoStarted.current = true
    start()
  }, [restored, settingsRead, starting, sessions.length, error, projects.length, start])

  /**
   * An aside stops being a footnote and becomes a room.
   *
   * The list is refreshed from main rather than assembled here: promotion gives
   * the conversation a profile, a title and a cwd, and guessing any of them in
   * the renderer is how a tab ends up describing something other than what was
   * opened.
   */
  const promoteAside = useCallback(
    (asideId: string, profileId: string) => {
      void (async () => {
        try {
          const promoted = await window.chorus.promoteAside({ asideId, profileId })
          updateSessions((current) => [...current, promoted])
          useWorkspaceStore.getState().openProject(promoted.projectId)
          useWorkspaceStore
            .getState()
            .adoptConversation(promoted.projectId, promoted.conversationId)
          useWorkspaceStore.getState().clearConversationUnread(promoted.conversationId)
        } catch (error) {
          fail(setError)(error)
        }
      })()
    },
    [updateSessions]
  )

  /**
   * A side task, branched off the conversation you are typing in.
   *
   * `promoteAside`'s twin, and deliberately the same three lines: main decides
   * the room's profile, title and cwd, the renderer adds the tab it is handed
   * and guesses none of them. The conversation it came from is left alone —
   * nothing is appended to it and its agent is not interrupted, which is the
   * entire point of the action.
   */
  /**
   * A session card dropped at a new place in the rail.
   *
   * The order is computed once, here, and the same value is both rendered and
   * written down. Reading it back off `sessionsRef` to persist would write the
   * order as it was *before* React applied the update — the list would look
   * right until the next launch and then come back as it started.
   */
  const moveSession = useCallback(
    (conversationId: string, slot: number) => {
      const current = sessionsRef.current
      const order = reorderSessions(
        current.map((session) => session.conversationId),
        conversationId,
        slot
      )
      const byId = new Map(current.map((session) => [session.conversationId, session]))
      const next = order.flatMap((id) => {
        const session = byId.get(id)
        return session === undefined ? [] : [session]
      })
      updateSessions(() => next)
      window.chorus
        .writeConversationLayout({
          order: [...order],
          workspace: workspaceSnapshot(useWorkspaceStore.getState()),
        })
        .catch(fail(setError))
    },
    [updateSessions]
  )

  const endNow = useCallback(
    (conversationId: string) => {
      const ending = sessionsRef.current.find((s) => s.conversationId === conversationId)
      carries.current.delete(conversationId)
      updateSessions((current) =>
        current.filter((session) => session.conversationId !== conversationId)
      )
      useWorkspaceStore.getState().removeSession(conversationId)
      /*
       * The project's tab closes only when its last conversation has gone, and
       * that decision is here because this is the layer that can see the others.
       *
       * Ending one of three conversations used to close the tab it was in,
       * because the tab was the conversation. Under project tabs the same call
       * would take the other two off screen while they carried on running in
       * main — the sharpest form of the UI disagreeing with what is actually
       * alive.
       */
      if (ending !== undefined) {
        const siblings = sessionsRef.current.some(
          (session) => session.projectId === ending.projectId
        )
        if (!siblings) useWorkspaceStore.getState().removeProject(ending.projectId)
      }
      window.chorus.closeConversation({ conversationId }).catch(fail(setError))
      void refreshProjects()
    },
    [updateSessions, refreshProjects]
  )

  /*
   * End takes effect immediately — there is no confirmation.
   *
   * There was one, and it asked "End this session?" with a warning when an agent
   * was mid-turn. It went because the question it asked was not the one that
   * mattered: the transcript is an append-only log, so ending a room destroys
   * nothing and reopening it from history brings it back. What the dialog cost
   * was a click on the one action people take dozens of times a day, and the
   * habit of clicking through a confirmation without reading it — which is worth
   * more than the keystroke, because the *other* confirmations in this app guard
   * things that genuinely cannot be undone.
   */
  const rename = useCallback(
    (conversationId: string, title: string) => {
      window.chorus
        .renameConversation({ conversationId, title })
        .then(({ title: applied }) => {
          updateSessions((current) =>
            current.map((session) =>
              session.conversationId === conversationId ? { ...session, title: applied } : session
            )
          )
        })
        .catch(fail(setError))
    },
    [updateSessions]
  )

  const keepCarry = useCallback((conversationId: string, carry: SessionCarry) => {
    carries.current.set(conversationId, trimCarry(carry))
  }, [])

  /**
   * Who is in a conversation, changed from wherever the cast is shown.
   *
   * **A cast is not a preference, and this used to write one back as if it
   * were** — `remember({ agents })` on every toggle, so bringing the other agent
   * into one conversation silently decided what every future conversation would
   * start with. The drift is invisible from where it is caused: the sheet says
   * "new sessions start with", nobody edited it, and it now reads differently
   * because of a chip pressed in a session days ago.
   *
   * It also costs real money in the wrong direction. A cast that grows never
   * shrinks back on its own, so the sticky value is always the *more* expensive
   * one — two provider processes and two waits on every new session, including
   * the one the app opens for you at launch.
   *
   * So the default is only ever what the settings sheet says. Bringing an agent
   * into this conversation changes this conversation.
   */
  const setParticipants = useCallback(
    (conversationId: string, participants: AgentId[]) => {
      updateSessions((current) =>
        current.map((candidate) =>
          candidate.conversationId === conversationId ? { ...candidate, participants } : candidate
        )
      )
    },
    [updateSessions]
  )

  /** What a conversation may do, changed from wherever the profile is shown. */
  const applyProfile = useCallback(
    async (conversationId: string, profileId: string) => {
      try {
        const { profileId: applied } = await window.chorus.setProfile({ conversationId, profileId })
        updateSessions((current) =>
          current.map((candidate) =>
            candidate.conversationId === conversationId
              ? { ...candidate, profileId: applied }
              : candidate
          )
        )
        remember({ profileId: applied })
      } catch (error) {
        fail(setError)(error)
      }
    },
    [updateSessions, remember]
  )

  /*
  /*
   * `setCwd`, `chooseFolder`, `setFolder` and then `chooseStartFolder` all stood
   * here in turn, and all four are gone.
   *
   * The first three were the renderer's half of a conversation owning a mutable
   * directory. `chooseStartFolder` replaced them for one slice as a picker that
   * chose where the *next* session opened — honest, but still a path in the
   * renderer's hands, and still a folder that nobody had adopted. `addProject`
   * above is what it becomes: the same dialog, opened by main, producing a
   * project rather than a string.
   */

  /*
   * The IPC and the error live here rather than in the control, because the
   * cast is now shown in two places and neither of them owns a place to report
   * a failure. The caller awaits this only to know when to stop disabling
   * itself.
   */
  const toggleAgent = useCallback(
    async (conversationId: string, agentId: AgentId, present: boolean) => {
      const session = sessionsRef.current.find((s) => s.conversationId === conversationId)
      if (session === undefined) return
      try {
        await (present
          ? window.chorus.removeAgent({ conversationId, agentId })
          : window.chorus.addAgent({ conversationId, agentId }))
        setParticipants(
          conversationId,
          present
            ? session.participants.filter((p) => p !== agentId)
            : [...session.participants, agentId]
        )
      } catch (error) {
        fail(setError)(error)
      }
    },
    [setParticipants]
  )

  /**
   * The three project-level writes the rail's card makes.
   *
   * Each refreshes the project list rather than patching it. The list is small,
   * main is the thing that decided what the value became — `setProjectAgents`
   * folds duplicates, `setProjectProfile` resolves the id through the policy
   * engine — and patching it here would be a second copy of that arithmetic,
   * drifting. It is the same argument `refreshProjects` already makes for
   * adopt and forget.
   *
   * Agents also reach every live conversation in the project, so the *session*
   * list has to be refreshed too: main added or removed participants, and
   * nothing else would tell the panes.
   */
  const renameProject = useCallback(
    (projectId: string, name: string) => {
      const clean = name.trim()
      if (clean === '') return
      window.chorus
        .renameProject({ projectId, name: clean })
        .then(() => refreshProjects())
        .catch(fail(setError))
    },
    [refreshProjects]
  )

  const chooseProjectProfile = useCallback(
    async (projectId: string, profileId: string) => {
      try {
        await window.chorus.setProjectProfile({ projectId, profileId })
        await refreshProjects()
      } catch (error) {
        fail(setError)(error)
      }
    },
    [refreshProjects]
  )

  /*
   * The two ways out of a project whose folder has gone, and the only place
   * either is offered.
   *
   * `setError(null)` first because the banner that is almost certainly on screen
   * is the one describing this exact project — leaving it up through a successful
   * relocate would say the folder is missing directly above a card showing its
   * new path.
   *
   * Neither starts a conversation afterwards. The project reappears in the rail
   * with its folder found, and opening a room in it is the person's next click
   * rather than something recovery does on their behalf.
   */
  const relocateProject = useCallback(
    async (projectId: string) => {
      setError(null)
      try {
        const { root } = await window.chorus.relocateProject({ projectId })
        // Cancelled the picker. Nothing changed and nothing is wrong.
        if (root === null) return
        await refreshProjects()
      } catch (error) {
        fail(setError)(error)
      }
    },
    [refreshProjects]
  )

  const forgetProject = useCallback(
    async (projectId: string) => {
      setError(null)
      try {
        await window.chorus.forgetProject({ projectId })
        await refreshProjects()
      } catch (error) {
        fail(setError)(error)
      }
    },
    [refreshProjects]
  )

  const toggleProjectAgent = useCallback(
    async (projectId: string, agentId: AgentId, present: boolean) => {
      /*
       * The cast to write is derived from what the card is showing, which for a
       * never-asked project is the union of its conversations' participants —
       * see `ProjectSettings`. Deriving it again here rather than passing it
       * down keeps the toggle's argument a single agent, and the two derivations
       * agree because both read the same session list.
       */
      const project = projects.find((candidate) => candidate.id === projectId)
      if (project === undefined) return
      const mine = sessionsRef.current.filter((session) => session.projectId === projectId)
      const current: readonly AgentId[] = project.agentIds ?? [
        ...new Set(mine.flatMap((session) => session.participants)),
      ]
      const next = present
        ? current.filter((id) => id !== agentId)
        : [...new Set([...current, agentId])]
      try {
        await window.chorus.setProjectAgents({ projectId, agentIds: next })
        await refreshProjects()
        /*
         * Main reconciled every live conversation in the project, so the panes
         * have to be told. Patched from `next` rather than re-listed: main's
         * fanout is `allSettled`, so a conversation whose agent failed to launch
         * would be overwritten here by a list that has not caught up either —
         * and one extra `conversation:list` per toggle buys nothing over the
         * value main just confirmed.
         */
        for (const session of mine) {
          setParticipants(session.conversationId, [...next])
        }
      } catch (error) {
        fail(setError)(error)
      }
    },
    [projects, refreshProjects, setParticipants]
  )

  /*
   * Writes the arrangement now, without waiting on the 180ms debounce.
   *
   * For a change that ends the moment the pointer comes up — a finished resize,
   * a dropped row — the debounce is all risk and no benefit: it exists to
   * coalesce a stream of updates, and there is no stream. Quitting inside that
   * window would silently discard the change and reopen at the old value.
   */
  const commitLayout = useCallback(() => {
    window.chorus
      .writeConversationLayout({
        order: sessionsRef.current.map((session) => session.conversationId),
        workspace: workspaceSnapshot(useWorkspaceStore.getState()),
      })
      .catch(fail(setError))
  }, [])

  /*
   * Reorder writes through the same way, but builds its own order: the
   * debounced subscription only fires on *workspace store* changes, and the
   * sidebar's order lives in React state beside it, so a dragged row would
   * otherwise sit in the right place until the next relaunch and then jump
   * back. Anything the caller forgot keeps its place at the end, so a stale
   * list cannot drop a live session.
   */

  const installed = (probes ?? []).filter((probe) => probe.installed).map((probe) => probe.id)

  const badge =
    zoom === null ? null : (
      <div className="zoom-badge" role="status" aria-live="polite">
        {`${String(Math.round(zoom * 100))}%`}
      </div>
    )

  const sheets = (
    <>
      {showingHistory && (
        <HistoryPanel
          onClose={() => {
            setShowingHistory(false)
          }}
          onPick={openFromHistory}
        />
      )}
      {showingSettings && (
        <Settings
          probes={probes}
          onClose={closeSettings}
          onOpenLogs={() => {
            closeSettings()
            setShowingLogs(true)
          }}
        />
      )}
      {showingLogs && (
        <LogViewer
          onClose={() => {
            setShowingLogs(false)
          }}
          onError={setError}
        />
      )}
    </>
  )

  if (restoring) {
    return <div className="empty" aria-busy="true" />
  }
  /*
   * No projects yet: the first-launch screen, and the only way out of it.
   *
   * This branch used to be the same blank `aria-busy` div as `restoring`, and it
   * was survivable only because the auto-start effect immediately created a
   * session in `defaults.cwd`. A session cannot be created without a project any
   * more, so that escape is gone and the blank div became permanent — no rail,
   * therefore no Add Project, therefore no way to ever leave it. It rendered as
   * a black window.
   *
   * The plan describes exactly this screen: "the clean product starts with an
   * empty Projects rail and one primary action: Add Project."
   */
  if (sessions.length === 0 && projects.length === 0 && error === null) {
    return (
      <>
        <div className="empty">
          <ChorusLogo label={t('app.name')} />
          <h1>{t('app.name')}</h1>
          <p>{t('project.firstRun')}</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              void addProject()
            }}
          >
            {t('rail.addProject')}
          </button>
        </div>
        {sheets}
      </>
    )
  }
  /*
   * With projects but no open conversation we fall through to the full stage
   * rather than to a blank div. The rail is the way back in — clicking a project
   * starts a conversation in it — and hiding it because nothing is open is what
   * made the no-project case unrecoverable one branch above.
   *
   * **That paragraph described an intent the code did not have.** The condition
   * was `sessions.length === 0` alone, so having projects and no open room
   * returned `Stuck` — no rail, no project card, and therefore no route to the
   * one control that could fix whatever had gone wrong. A project whose folder
   * was renamed outside Chorus reached it on every launch: the auto-start threw
   * `ProjectRootMissingError`, the error screen printed the message, and its two
   * buttons were Try again, which threw again, and Settings.
   *
   * So `Stuck` is now only for the two cases that genuinely have nothing behind
   * them — **no projects at all**, or **no agent CLI installed**, which is the
   * screen it was written for and whose advice the stage does not carry. The
   * error itself is not lost by falling through: the stage renders it as a
   * dismissible `ErrorNotice`, which is the right weight for "one thing failed"
   * rather than "the app did not start".
   */
  if (sessions.length === 0 && (projects.length === 0 || noAgentInstalled(probes))) {
    return (
      <>
        <Stuck
          error={error}
          starting={starting}
          probes={probes}
          onRetry={() => {
            setError(null)
          }}
          onSettings={() => {
            setShowingSettings(true)
          }}
        />
        {sheets}
      </>
    )
  }

  return (
    <div className="stage">
      {/*
       * One compact row, and nothing in it but the name and the build.
       *
       * It was 40px of wrapping header with a padding rule that reserved the
       * sidebar's width; it is 31px now, holds the wordmark and the version, and
       * carries no actions — those all moved to the rail and the session menu.
       * That is the whole of its job, plus two it does by existing: it is the
       * window's drag region, and it is where `titleBarStyle: hiddenInset` puts
       * the traffic lights, so nothing below it has to leave room for them.
       */}
      <header className="masthead">
        <h1 className="wordmark">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
          {appVersion !== null && (
            <span className="app-version" data-app-version>
              {appVersion}
            </span>
          )}
        </h1>
      </header>

      {error !== null && (
        <ErrorNotice
          message={error}
          className="notice--workspace"
          onDismiss={() => {
            setError(null)
          }}
        />
      )}

      <Workspace
        sessions={sessions}
        starting={starting}
        onNewSession={start}
        onStartInProject={startIn}
        onRename={rename}
        onEnd={endNow}
        onCommitLayout={commitLayout}
        onReorderSessions={moveSession}
        onOpenSettings={() => {
          setShowingSettings(true)
        }}
        onOpenHistory={() => {
          setShowingHistory(true)
        }}
        profiles={profiles}
        installed={installed}
        onToggleAgent={toggleAgent}
        onRenameProject={renameProject}
        onToggleProjectAgent={toggleProjectAgent}
        onChooseProjectProfile={chooseProjectProfile}
        onRelocateProject={relocateProject}
        onForgetProject={forgetProject}
        projects={projects}
        onAddProject={addProject}
        onOpenProject={showProject}
        home={home}
        onChooseProfile={applyProfile}
        renderSession={(session, focused, paneId) => (
          <Session
            key={session.conversationId}
            session={session}
            active={focused}
            onActivate={() => {
              useWorkspaceStore.getState().focusPane(paneId)
            }}
            carry={carries.current.get(session.conversationId)}
            onCarry={keepCarry}
            onPromoteAside={promoteAside}
            /* Read once here rather than per pane: it decides whether Explain
               exists under every reply, and four panes asking the same question
               of the same file is four answers that must agree. */
            explainLanguage={explainLanguage}
          />
        )}
      />

      {sheets}
      {badge}
    </div>
  )
}

/**
 * The screen a machine with no CLI actually reaches.
 *
 * Worth stating, because it was not obvious and the first attempt at improving
 * this put the advice somewhere else. With no agent, `startConversation` throws,
 * `sessions` stays empty and the workspace — with its rail, and the Settings
 * sheet the advice was written into — never mounts at all. This is the whole of
 * what a new user sees.
 *
 * So the same guidance is here, and it comes first. `props.error` still follows
 * it, because `spawn claude ENOENT` is the truth and someone will paste it into
 * a search box; it is simply not the first thing to read.
 *
 * Only when the probe says nothing is installed. Any other startup failure — a
 * missing directory, a corrupt store — is unrelated, and offering "install the
 * CLI" for it would be worse than the raw message.
 */
/**
 * Whether the probe came back saying no agent CLI is on this machine.
 *
 * Exported and pure because it is now asked in two places — `Stuck` draws the
 * install advice from it, and `App` uses it to decide whether `Stuck` is the
 * right screen at all. Two copies of this condition would drift into a screen
 * that offers install instructions and one that does not, for the same machine.
 *
 * `null` is "not probed yet" and is deliberately not "nothing installed": the
 * probe is a round trip, and answering `true` while it is in flight would flash
 * install instructions at everyone on every launch.
 */
export function noAgentInstalled(probes: AgentProbeResult[] | null): boolean {
  return probes !== null && probes.length > 0 && probes.every((probe) => !probe.installed)
}

function Stuck(props: {
  error: string | null
  starting: boolean
  probes: AgentProbeResult[] | null
  onRetry: () => void
  onSettings: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const nothingInstalled = noAgentInstalled(props.probes)
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1 className="wordmark wordmark--large">
          <ChorusLogo className="wordmark-logo" label={t('app.name')} />
        </h1>
        {nothingInstalled && (
          <div className="empty-help">
            <p className="empty-help-lead">{t('agents.noneAtAll')}</p>
            {props.probes?.map((probe) => (
              <p key={probe.id} className="empty-help-row">
                <span className="empty-help-name">{probe.id}</span>
                <code className="cast-install">{INSTALL[probe.id]}</code>
              </p>
            ))}
            <p className="empty-help-foot">{t('agents.oneIsEnough')}</p>
          </div>
        )}
        <p className="notice notice--bad" role="alert">
          {props.error}
        </p>
        <button
          type="button"
          className="btn btn--go btn--wide"
          onClick={props.onRetry}
          disabled={props.starting}
        >
          {props.starting ? t('conversation.starting') : t('conversation.tryAgain')}
        </button>
        <button type="button" className="btn btn--quiet" onClick={props.onSettings}>
          {t('settings.open')}
        </button>
      </div>
    </div>
  )
}
