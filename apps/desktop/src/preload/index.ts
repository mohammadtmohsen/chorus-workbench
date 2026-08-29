import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  ACTIVITY_PUSH_CHANNEL,
  ActivityPush,
  DIAGNOSTIC_PUSH_CHANNEL,
  DiagnosticPush,
  EVENTS_PUSH_CHANNEL,
  IDE_PUSH_CHANNEL,
  IdeContextPush,
  CONTEXT_PUSH_CHANNEL,
  ContextUsagePush,
  TasksPush,
  TASKS_PUSH_CHANNEL,
  TerminalPush,
  TERMINAL_PUSH_CHANNEL,
  LIMITS_PUSH_CHANNEL,
  LimitsPush,
  SCALE_PUSH_CHANNEL,
  SETTINGS_PUSH_CHANNEL,
  EventsPush,
  IPC_CONTRACT,
  type ChorusApi,
  type IpcChannel,
  type IpcResponse,
} from '../shared/ipc.js'
import {
  WORKBENCH_SHELL_CONTRACT,
  type WorkbenchShellChannel,
  type WorkbenchShellResponse,
} from '../shared/workbench-ipc.js'

/**
 * One method per IPC message, generated from the contract. `ipcRenderer` itself
 * is never exposed — handing the renderer a generic `invoke(channel, ...)` would
 * make the allowlist meaningless (plan §4.4).
 */
function invoke<C extends IpcChannel>(channel: C) {
  return async (request?: unknown): Promise<IpcResponse<C>> => {
    const raw: unknown = await ipcRenderer.invoke(channel, request)
    // Validate on this side too: a mismatch here is our bug, and it should
    // surface at the boundary rather than as a render-time crash.
    const parsed = IPC_CONTRACT[channel].response.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
    }
    return parsed.data as IpcResponse<C>
  }
}

/**
 * The same generator over the workbench's shell-facing contract.
 *
 * A separate map rather than three more entries in `IPC_CONTRACT`, because the
 * channels are answered by a registrar that reads `event.sender` and that map's
 * registrar deliberately does not. What matters here is that these three carry no
 * secret: an opaque view id and a rectangle. The channel that does carry one is
 * `workbench:connection`, and it is generated into `preload/workbench.ts` only —
 * this file has no method for it and no way to reach it.
 */
function invokeWorkbench<C extends WorkbenchShellChannel>(channel: C) {
  return async (request: unknown): Promise<WorkbenchShellResponse<C>> => {
    const raw: unknown = await ipcRenderer.invoke(channel, request)
    const parsed = WORKBENCH_SHELL_CONTRACT[channel].response.safeParse(raw)
    if (!parsed.success) {
      throw new Error(`Malformed response on "${channel}": ${parsed.error.message}`)
    }
    return parsed.data as WorkbenchShellResponse<C>
  }
}

const api: ChorusApi = {
  getAppInfo: invoke('app:getInfo'),
  chooseWorkbenchProject: () => invokeWorkbench('workbench:chooseProject')({}),
  openWorkbench: invokeWorkbench('workbench:open'),
  setWorkbenchBounds: invokeWorkbench('workbench:setBounds'),
  closeWorkbench: invokeWorkbench('workbench:close'),
  setWorkbenchVisible: invokeWorkbench('workbench:setVisible'),
  probeAgents: invoke('agents:probe'),
  startConversation: invoke('conversation:start'),
  sendMessage: invoke('conversation:send'),
  interrupt: invoke('conversation:interrupt'),
  closeConversation: invoke('conversation:close'),
  addAgent: invoke('conversation:addAgent'),
  removeAgent: invoke('conversation:removeAgent'),
  restoreConversations: () => invoke('conversation:restore')({}),
  markSeen: invoke('conversation:markSeen'),
  rememberDraft: invoke('conversation:draft'),
  setPlanMode: invoke('conversation:planMode'),
  completeFiles: invoke('files:complete'),
  listCommands: invoke('conversation:commands'),
  transcript: invoke('conversation:transcript'),
  listConversations: () => invoke('conversation:list')({}),
  knownModels: () => invoke('agents:models')({}),
  mcpServers: () => invoke('agents:mcp')({}),
  accounts: () => invoke('agents:account')({}),
  plugins: () => invoke('agents:plugins')({}),
  stopTask: invoke('tasks:stop'),
  reopenConversation: invoke('conversation:reopen'),
  previewFile: invoke('files:preview'),
  stashFile: invoke('files:stash'),
  // Renderers cannot read a File's path any more; only the bridge can.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  writeConversationLayout: invoke('conversation:layout'),
  refreshLimits: invoke('limits:refresh'),
  attachTerminal: invoke('terminal:attach'),
  detachTerminal: invoke('terminal:detach'),
  disposeTerminal: invoke('terminal:dispose'),
  killTerminal: invoke('terminal:kill'),
  writeTerminal: invoke('terminal:write'),
  resizeTerminal: invoke('terminal:resize'),
  ackTerminal: invoke('terminal:ack'),
  clearTerminal: invoke('terminal:clear'),
  describeTerminal: invoke('terminal:describe'),
  setBadge: invoke('app:setBadge'),
  focusWindow: invoke('app:focus'),
  copyText: invoke('app:copyText'),
  renameConversation: invoke('conversation:rename'),
  adoptProject: invoke('project:adopt'),
  listProjects: invoke('project:list'),
  renameProject: invoke('project:rename'),
  forgetProject: invoke('project:forget'),
  relocateProject: invoke('project:relocate'),
  setProjectProfile: invoke('project:setProfile'),
  setProjectAgents: invoke('project:setAgents'),
  chooseDirectory: invoke('files:chooseDirectory'),
  readSettings: () => invoke('settings:read')({}),
  writeSettings: invoke('settings:write'),
  history: invoke('conversation:history'),
  decideApproval: invoke('approval:decide'),
  answerQuestion: invoke('userinput:answer'),
  profiles: invoke('policy:profiles'),
  setProfile: invoke('policy:set'),
  readDiagnostics: invoke('diagnostics:read'),
  exportDiagnostics: invoke('diagnostics:export'),
  ideSnapshot: invoke('ide:snapshot'),
  ideExtensionStatus: () => invoke('ide:extensionStatus')({}),
  ideInstallExtension: () => invoke('ide:installExtension')({}),
  ideOpenProject: invoke('ide:openProject'),
  ideOpenFile: invoke('ide:openFile'),
  prepareHandoff: invoke('handoff:prepare'),
  sendHandoff: invoke('handoff:send'),
  openAside: invoke('aside:open'),
  askAside: invoke('aside:ask'),
  restateAside: invoke('aside:restate'),
  promoteAside: invoke('aside:promote'),
  forwardAside: invoke('aside:forward'),
  closeAside: invoke('aside:close'),
  listAsides: invoke('aside:list'),

  onEvents: (listener) => {
    // The payload is validated before it reaches renderer code: main is
    // trusted, but a shape mismatch should fail here, not three components deep.
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = EventsPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(EVENTS_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(EVENTS_PUSH_CHANNEL, wrapped)
    }
  },
  onIdeContext: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      // Validated here as well as in main: a shape mismatch should fail at the
      // boundary rather than as a blank pill with no explanation.
      const parsed = IdeContextPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(IDE_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(IDE_PUSH_CHANNEL, wrapped)
    }
  },
  onLimits: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = LimitsPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(LIMITS_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(LIMITS_PUSH_CHANNEL, wrapped)
    }
  },
  onContextUsage: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = ContextUsagePush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(CONTEXT_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(CONTEXT_PUSH_CHANNEL, wrapped)
    }
  },
  onTasks: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = TasksPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(TASKS_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(TASKS_PUSH_CHANNEL, wrapped)
    }
  },
  onActivity: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = ActivityPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(ACTIVITY_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(ACTIVITY_PUSH_CHANNEL, wrapped)
    }
  },
  onTerminalOutput: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = TerminalPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(TERMINAL_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(TERMINAL_PUSH_CHANNEL, wrapped)
    }
  },
  onDiagnostic: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = DiagnosticPush.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(DIAGNOSTIC_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(DIAGNOSTIC_PUSH_CHANNEL, wrapped)
    }
  },
  onSettings: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      const parsed = IPC_CONTRACT['settings:read'].response.safeParse(payload)
      if (parsed.success) listener(parsed.data)
    }
    ipcRenderer.on(SETTINGS_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(SETTINGS_PUSH_CHANNEL, wrapped)
    }
  },
  onScale: (listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      // Validated like every other push: main is trusted, but a shape mismatch
      // should fail here rather than as a NaN in the badge.
      if (typeof payload === 'number' && Number.isFinite(payload)) listener(payload)
    }
    ipcRenderer.on(SCALE_PUSH_CHANNEL, wrapped)
    return () => {
      ipcRenderer.removeListener(SCALE_PUSH_CHANNEL, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('chorus', api)
