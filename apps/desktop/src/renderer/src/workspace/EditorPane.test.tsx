/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationArrangement } from '../../../shared/workspace-layout.js'
import type { SessionInfo } from '../Session.js'
import { EditorPane } from './EditorPane.js'
import { useWorkspaceStore } from './store.js'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('./PaneTabStrip.js', () => ({ PaneTabStrip: () => null }))
vi.mock('./PaneWorkbench.js', () => ({ PaneWorkbench: () => null }))
vi.mock('./ProjectNotes.js', () => ({ ProjectNotes: () => null }))
vi.mock('../TrafficPanel.js', () => ({ TrafficPanel: () => null }))
vi.mock('../ProjectTerminalPane.js', () => ({ ProjectTerminalPane: () => null }))
vi.mock('./hooks.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTrafficLive: () => false,
  useProjectRun: () => null,
}))

class FakeObserver {
  observe(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  cleanup()
})

const session = (conversationId: string): SessionInfo => ({
  conversationId,
  participants: ['claude'],
  projectId: 'p1',
  cwd: '/tmp/p1',
  profileId: 'read-only',
  title: conversationId,
})

const twoColumns: ConversationArrangement = {
  layout: {
    kind: 'branch',
    orientation: 'row',
    children: [
      { kind: 'leaf', paneId: 'g1' },
      { kind: 'leaf', paneId: 'g2' },
    ],
    sizes: [1, 1],
  },
  panes: {
    g1: { id: 'g1', tabs: ['source'], activeTabId: 'source' },
    g2: { id: 'g2', tabs: ['replacement'], activeTabId: 'replacement' },
  },
  focusedPaneId: 'g2',
}

function Chat(props: { readonly conversationId: string }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <textarea
      data-chat={props.conversationId}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
    />
  )
}

const props = (sessions: readonly SessionInfo[]): ComponentProps<typeof EditorPane> => ({
  paneId: 'pane-1',
  node: { kind: 'leaf', paneId: 'pane-1' },
  path: [],
  sessions: new Map(sessions.map((each) => [each.conversationId, each])),
  focusedPaneId: 'pane-1',
  drag: null,
  onTabPointerDown: () => undefined,
  consumeSuppressedClick: () => false,
  onStartInProject: () => undefined,
  onEndConversation: () => undefined,
  onActivate: () => undefined,
  onFocus: () => undefined,
  onClose: () => undefined,
  onReorder: () => undefined,
  onRename: () => undefined,
  projects: [],
  onRenameProject: () => undefined,
  onSetProjectNotes: () => undefined,
  onSetProjectNoteSize: () => undefined,
  onSendProjectNoteSelection: () => undefined,
  onCommitLayout: () => undefined,
  renderSession: (each) => <Chat key={each.conversationId} conversationId={each.conversationId} />,
  trafficTerminals: [],
})

const chat = (container: HTMLElement, conversationId: string): HTMLTextAreaElement | null =>
  container.querySelector<HTMLTextAreaElement>(`textarea[data-chat="${conversationId}"]`)

beforeEach(() => {
  useWorkspaceStore.setState({
    panes: { 'pane-1': { id: 'pane-1', tabs: ['p1'], activeTabId: 'p1' } },
    focusedPaneId: 'pane-1',
    conversationGroups: { p1: twoColumns },
  })
})

describe('a project row losing the column to the left of a chat', () => {
  it('keeps the chat on the right mounted, with what was typed in it', () => {
    const view = render(<EditorPane {...props([session('source'), session('replacement')])} />)
    const typed = chat(view.container, 'replacement')
    if (typed === null) throw new Error('the replacement chat is not drawn')
    fireEvent.change(typed, { target: { value: 'restart draft kept through boot' } })
    typed.setSelectionRange(4, 10)

    act(() => {
      useWorkspaceStore.getState().removeSession('source')
    })
    view.rerender(<EditorPane {...props([session('replacement')])} />)

    expect(useWorkspaceStore.getState().conversationGroups['p1']?.layout).toEqual({
      kind: 'leaf',
      paneId: 'g2',
    })
    expect(chat(view.container, 'source')).toBeNull()
    expect(chat(view.container, 'replacement')).toBe(typed)
    expect(typed.value).toBe('restart draft kept through boot')
    expect(typed.selectionStart).toBe(4)
    expect(typed.selectionEnd).toBe(10)
  })
})
