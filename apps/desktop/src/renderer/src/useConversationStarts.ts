import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { IpcResponse } from '../../shared/ipc.js'
import type { WindowRole } from '../../shared/detached-window-ipc.js'
import type { SessionInfo } from './Session.js'
import { useWorkspaceStore } from './workspace/store.js'

/*
 * An object rather than two optional strings in a row, and that is a
 * decision about the next mistake rather than about this call.
 *
 * Both are conversation ids, both are optional, and they mean opposite
 * things — one is the room being thrown away, the other the room being
 * carried forward. Positionally, transposing them is invisible at the
 * call site and silent at runtime: you would end the wrong conversation
 * and carry the one you meant to end. Named, it cannot happen.
 */
export interface StartOptions {
  /**
   * A conversation this one replaces, ended once the new one exists.
   *
   * **After, never before**, and the ordering is the whole of why this is
   * a parameter rather than two calls at the call site. `endNow` closes
   * the project's tab when the conversation it ends was the last one in
   * it — so ending first would tear the project down and rebuild it
   * around the replacement, which is a visible flash and a pane that
   * loses its place. Started first, the new conversation is the sibling
   * that keeps the project open, and the end is a tab closing beside it.
   *
   * It also means a failed start ends nothing. The failure path is
   * reached instead, and the person still has the conversation they were
   * in.
   */
  readonly replacing?: string
  /**
   * A conversation the new one goes on from, transcript and all.
   *
   * **Always named by a caller, never inferred here.** An earlier build
   * guessed it — the conversation active in the project's focused group —
   * so every `+` silently carried whatever happened to be on screen. That
   * makes the cheapest gesture in the app the expensive one, and gives no
   * way to say "start clean" except by starting and restarting. Continuing
   * is now its own control on the conversation you want to continue, and
   * `+` means what it says again.
   */
  readonly continueFrom?: string
}

export interface ConversationStartsDeps {
  readonly role: WindowRole
  readonly profileId: string
  readonly sessionsRef: RefObject<SessionInfo[]>
  readonly revision: RefObject<number>
  readonly closedIds: RefObject<Set<string>>
  readonly updateSessions: (change: (current: SessionInfo[]) => SessionInfo[]) => void
  readonly finishEnd: (conversationId: string) => void
  readonly refreshProjects: () => Promise<unknown>
  readonly reportError: (error: unknown) => void
  readonly clearError: () => void
  readonly forgetDetached: (projectId: string) => void
}

type StartOutcome = IpcResponse<'conversation:awaitStart'>

const sameAgents = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((agent, index) => agent === b[index])

export function advanceSession(session: SessionInfo, latest: SessionInfo): SessionInfo {
  if (latest.starting === true) return session
  if (session.starting !== true && sameAgents(session.participants, latest.participants)) {
    return session
  }
  return { ...session, participants: latest.participants, starting: false }
}

export function useConversationStarts(deps: ConversationStartsDeps): {
  readonly starting: boolean
  readonly startIn: (projectId: string, options?: StartOptions) => void
} {
  const {
    role,
    profileId,
    sessionsRef,
    revision,
    closedIds,
    updateSessions,
    finishEnd,
    refreshProjects,
    reportError,
    clearError,
    forgetDetached,
  } = deps
  const [inFlight, setInFlight] = useState(0)
  const pendingBegins = useRef(0)
  const replacing = useRef(new Set<string>())
  const latestRead = useRef(0)

  const reconcile = useCallback(() => {
    const apply = (active: readonly SessionInfo[]): void => {
      const scoped =
        role.kind === 'detached'
          ? active.filter((session) => session.projectId === role.projectId)
          : active
      const listed = new Set(scoped.map((session) => session.conversationId))
      if (pendingBegins.current === 0) {
        for (const id of [...closedIds.current]) {
          if (!listed.has(id)) closedIds.current.delete(id)
        }
      }
      const visible = scoped.filter((session) => !closedIds.current.has(session.conversationId))
      const latest = new Map<string, SessionInfo>(
        visible.map((session) => [session.conversationId, session])
      )
      const current = sessionsRef.current
      const known = new Set(current.map((session) => session.conversationId))
      const added = visible.filter((session) => !known.has(session.conversationId))
      const removed = current.filter((session) => !latest.has(session.conversationId))
      const kept = current.flatMap((session) => {
        const fresh = latest.get(session.conversationId)
        return fresh === undefined ? [] : [advanceSession(session, fresh)]
      })
      const changed = kept.some((session, index) => session !== current[index])
      if (added.length === 0 && removed.length === 0 && !changed) return
      updateSessions(() => [...added, ...kept])
      const store = useWorkspaceStore.getState()
      for (const session of removed) store.removeSession(session.conversationId)
      if (role.kind === 'detached') {
        for (const session of added) {
          store.adoptConversation(session.projectId, session.conversationId)
        }
        return
      }
      for (const projectId of Object.keys(store.detached)) {
        if (!scoped.some((session) => session.projectId === projectId)) {
          store.clearDetached(projectId)
          forgetDetached(projectId)
        }
      }
    }
    const read = (): void => {
      const ticket = ++latestRead.current
      const seen = revision.current
      window.chorus
        .readActiveSessions()
        .then(({ sessions: active }) => {
          if (ticket !== latestRead.current) return
          if (seen !== revision.current) {
            read()
            return
          }
          apply(active)
        })
        .catch(reportError)
    }
    read()
  }, [role, sessionsRef, revision, closedIds, updateSessions, reportError, forgetDetached])

  useEffect(() => window.chorus.onConversationsChanged(reconcile), [reconcile])

  const settle = useCallback(
    (conversationId: string, outcome: StartOutcome, source: string | undefined) => {
      const open = (id: string): boolean =>
        sessionsRef.current.some((session) => session.conversationId === id)
      if (outcome.status !== 'ready') {
        closedIds.current.add(conversationId)
        if (open(conversationId)) {
          updateSessions((current) =>
            current.filter((session) => session.conversationId !== conversationId)
          )
          useWorkspaceStore.getState().removeSession(conversationId)
        }
        if (outcome.status === 'failed') reportError(new Error(outcome.message))
        reconcile()
        return
      }
      if (!open(conversationId)) return
      const ready = { participants: outcome.conversation.participants, starting: false }
      updateSessions((current) =>
        current.map((session) =>
          session.conversationId === conversationId
            ? advanceSession(session, { ...session, ...ready })
            : session
        )
      )
      // `finishEnd` and not `endNow`: restart has already asked its own
      // question by the time this runs, and asking again would be two
      // dialogs for one gesture.
      if (source !== undefined && open(source)) finishEnd(source)
      reconcile()
      void refreshProjects()
    },
    [sessionsRef, closedIds, updateSessions, reportError, reconcile, finishEnd, refreshProjects]
  )

  const startIn = useCallback(
    (projectId: string, options: StartOptions = {}) => {
      const source = options.replacing
      if (source !== undefined) {
        if (replacing.current.has(source)) return
        replacing.current.add(source)
      }
      clearError()
      setInFlight((count) => count + 1)
      pendingBegins.current += 1
      window.chorus
        .beginConversation({
          projectId,
          profileId,
          ...(options.continueFrom === undefined ? {} : { continueFrom: options.continueFrom }),
        })
        .then(
          (begun) => {
            pendingBegins.current -= 1
            if (closedIds.current.has(begun.conversationId)) return null
            const exists = sessionsRef.current.some(
              (session) => session.conversationId === begun.conversationId
            )
            if (!exists) updateSessions((current) => [...current, { ...begun, starting: true }])
            const store = useWorkspaceStore.getState()
            store.openProject(begun.projectId)
            /* A tab for it, in the focused group. Without this the conversation
               streams into a project that has nowhere to show it until relaunch. */
            if (store.detached[begun.projectId] === undefined) {
              store.adoptConversation(begun.projectId, begun.conversationId)
            }
            store.clearConversationUnread(begun.conversationId)
            reconcile()
            return begun.conversationId
          },
          (error: unknown) => {
            pendingBegins.current -= 1
            throw error
          }
        )
        .then(async (conversationId) => {
          if (conversationId === null) return
          settle(conversationId, await window.chorus.awaitStart({ conversationId }), source)
        })
        .catch(reportError)
        .finally(() => {
          if (source !== undefined) replacing.current.delete(source)
          setInFlight((count) => count - 1)
        })
    },
    [profileId, closedIds, sessionsRef, updateSessions, reconcile, settle, reportError, clearError]
  )

  return { starting: inFlight > 0, startIn }
}
