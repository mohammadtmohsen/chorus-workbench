import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_CONNECTION_CHANNEL,
  WORKBENCH_BROWSER_EXTENSIONS_CHANGED_CHANNEL,
  WORKBENCH_BROWSER_EXTENSIONS_READ_CHANNEL,
  WORKBENCH_BROWSER_EXTENSIONS_WRITE_CHANNEL,
  WORKBENCH_CLIPBOARD_READ_CHANNEL,
  WORKBENCH_SECRET_DELETE_CHANNEL,
  WORKBENCH_SECRET_READ_CHANNEL,
  WORKBENCH_SECRET_WRITE_CHANNEL,
  WORKBENCH_STORAGE_READ_CHANNEL,
  WORKBENCH_STORAGE_WRITE_CHANNEL,
  WORKBENCH_USER_SETTINGS_READ_CHANNEL,
  WORKBENCH_USER_SETTINGS_WRITE_CHANNEL,
  WORKBENCH_CONTEXT_CHANNEL,
  WORKBENCH_EDIT_CHANNEL,
  WORKBENCH_SNAPSHOT_CHANNEL,
  WORKBENCH_EDIT_RESULT_CHANNEL,
} from '../shared/workbench-ipc.js'

/**
 * The workbench preload shares no runtime module with the shell's, because two
 * preload entries sharing one make Rollup emit a chunk a sandboxed preload cannot
 * load — and the file it broke was the *shell's*. The cost of that constraint is
 * a channel name written out twice, so this is the reader that catches the two
 * spellings drifting apart.
 */

const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
const invoke = vi.fn()

interface Exposed {
  connection: () => Promise<unknown>
  readUserSettings: () => Promise<string | null>
  writeUserSettings: (text: string) => Promise<void>
  readBrowserExtensions: () => Promise<string | null>
  writeBrowserExtensions: (text: string) => Promise<void>
  onBrowserExtensionsChanged: (handler: (text: string) => void) => void
}
let exposed: Exposed | null = null

/** A whole descriptor, because since step 2 a partial one must not survive. */
const DESCRIPTOR = {
  projectRoot: '/pushed',
  remoteAuthority: '127.0.0.1:51515',
  connectionToken: 'a-token',
  commit: '987c9597516278c9fcf10d963a0592ce1384ab93',
  quality: 'stable',
}

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      exposed = api as Exposed
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.set(channel, listener)
    },
    invoke,
  },
}))

const {
  CONNECTION_CHANNEL,
  USER_SETTINGS_READ_CHANNEL,
  USER_SETTINGS_WRITE_CHANNEL,
  BROWSER_EXTENSIONS_READ_CHANNEL,
  BROWSER_EXTENSIONS_WRITE_CHANNEL,
  BROWSER_EXTENSIONS_CHANGED_CHANNEL,
  STORAGE_READ_CHANNEL,
  STORAGE_WRITE_CHANNEL,
  SECRET_READ_CHANNEL,
  SECRET_WRITE_CHANNEL,
  SECRET_DELETE_CHANNEL,
  CONTEXT_CHANNEL,
  SNAPSHOT_CHANNEL,
  EDIT_CHANNEL,
  EDIT_RESULT_CHANNEL,
  CLIPBOARD_READ_CHANNEL,
  asConnection,
} = await import('./workbench.js')

describe('the workbench preload', () => {
  it('names the same channels the shared contract does', () => {
    expect(CONNECTION_CHANNEL).toBe(WORKBENCH_CONNECTION_CHANNEL)
    expect(USER_SETTINGS_READ_CHANNEL).toBe(WORKBENCH_USER_SETTINGS_READ_CHANNEL)
    expect(USER_SETTINGS_WRITE_CHANNEL).toBe(WORKBENCH_USER_SETTINGS_WRITE_CHANNEL)
    expect(BROWSER_EXTENSIONS_READ_CHANNEL).toBe(WORKBENCH_BROWSER_EXTENSIONS_READ_CHANNEL)
    expect(BROWSER_EXTENSIONS_WRITE_CHANNEL).toBe(WORKBENCH_BROWSER_EXTENSIONS_WRITE_CHANNEL)
    expect(BROWSER_EXTENSIONS_CHANGED_CHANNEL).toBe(WORKBENCH_BROWSER_EXTENSIONS_CHANGED_CHANNEL)
    expect(STORAGE_READ_CHANNEL).toBe(WORKBENCH_STORAGE_READ_CHANNEL)
    expect(STORAGE_WRITE_CHANNEL).toBe(WORKBENCH_STORAGE_WRITE_CHANNEL)
    expect(SECRET_READ_CHANNEL).toBe(WORKBENCH_SECRET_READ_CHANNEL)
    expect(SECRET_WRITE_CHANNEL).toBe(WORKBENCH_SECRET_WRITE_CHANNEL)
    expect(SECRET_DELETE_CHANNEL).toBe(WORKBENCH_SECRET_DELETE_CHANNEL)
    expect(CONTEXT_CHANNEL).toBe(WORKBENCH_CONTEXT_CHANNEL)
    expect(SNAPSHOT_CHANNEL).toBe(WORKBENCH_SNAPSHOT_CHANNEL)
    expect(EDIT_CHANNEL).toBe(WORKBENCH_EDIT_CHANNEL)
    expect(EDIT_RESULT_CHANNEL).toBe(WORKBENCH_EDIT_RESULT_CHANNEL)
    expect(CLIPBOARD_READ_CHANNEL).toBe(WORKBENCH_CLIPBOARD_READ_CHANNEL)
  })

  it('exposes exactly seventeen methods, and no eighteenth', () => {
    // The list, not the count: a method named here is a capability a document
    // running extension code is handed, so which ones they are is the assertion.
    expect(Object.keys(exposed ?? {})).toEqual([
      'connection',
      'readUserSettings',
      'writeUserSettings',
      'readBrowserExtensions',
      'writeBrowserExtensions',
      'onBrowserExtensionsChanged',
      /*
       * The storage pair. Unlike the settings pair these carry an argument — the
       * storage scope — because there are several scopes and main cannot derive
       * which is meant. It is a property name inside one JSON file and never a
       * filename, which is what keeps "a document running extension code can name
       * something" from becoming path traversal.
       *
       * This is also where a workspace-trust answer is remembered, which is the
       * point — a security prompt re-asked on every launch is one people learn to
       * click through — and the reason the pair is worth this much scrutiny.
       */
      'readStorage',
      'applyStorageDelta',
      'onStorageChanged',
      /*
       * The credential trio, and the three names most worth arguing about in
       * this list. They exist because `BrowserSecretStorageService` hardcodes
       * in-memory storage, so every sign-in died at quit. Main encrypts through
       * the OS keychain rather than writing a token as text — the file is
       * useless on another machine or another account — and a profile with no
       * keychain stores nothing rather than storing plaintext.
       */
      'readSecret',
      'writeSecret',
      'deleteSecret',
      /*
       * Reading the system clipboard, and it is on this list rather than in the
       * session's permissions on purpose. `clipboard-read` granted to the
       * partition reaches every iframe and extension webview in it; this reaches
       * one `WebContents` main already knows it opened. It takes no argument and
       * has no write beside it, so what a surface gains is one value it can
       * *learn* and nothing it can change.
       *
       * Beside the credential trio because it is the same kind of thing — a
       * capability the browser refuses, moved to main where the sender can be
       * checked — and this assertion is on order as well as membership, so its
       * position here is the position in the preload.
       */
      'readClipboard',
      /*
       * An OAuth callback, pushed in by main. It cannot be asked for and cannot
       * be enumerated: a surface is told about exactly one URL, exactly once, and
       * only when main has evidence — a browser this surface opened in the last
       * few minutes — that the callback is its own. That evidence lives in
       * `awaitingCallback`, not here.
       */
      'onUrl',
      /*
       * Phase 6 slice 6a. It reports and cannot ask: no reply, no path — the
       * value is already project-relative — and no way to name a project, since
       * main derives that from the sender.
       */
      'reportContext',
      /*
       * Phase 6d. The only method that lets main *ask this document for
       * something*, and the one worth the most scrutiny in this list: it hands a
       * document running third-party extension code a channel that mutates the
       * person's open files. What bounds it is that the handler is registered by
       * Chorus's own module, the request is validated there, and the project root
       * is closed over rather than carried — a surface cannot be told to edit
       * another project's file, because it has no way to name one.
       */
      /*
       * Phase 6e. Answers "what is the editor showing", with the selected text —
       * which the push channel deliberately omits, because it fires per
       * keystroke. This one is asked once, when a message is sent.
       */
      'onSnapshotRequest',
      /*
       * The ask flow's diff. Like `onEditRequest` it lets main *ask this
       * document for something*, and it is the wider of the two in one respect
       * — it can put a tab in front of the person — but it only ever shows.
       * Nothing it carries is written anywhere: both sides are text held in
       * memory for as long as the card is open.
       */
      'onAskDiffRequest',
      'onEditRequest',
    ])
  })

  it('registers its listener at the top of the script, before anything asks', () => {
    // The push is sequenced on the view's `did-finish-load`, which is still
    // earlier than the workbench's own module graph finishing. Nothing else can
    // be listening by then.
    expect(listeners.has(CONNECTION_CHANNEL)).toBe(true)
  })

  it('answers from the buffer without a pull once the push has arrived', async () => {
    listeners.get(CONNECTION_CHANNEL)?.(null, DESCRIPTOR)
    await expect(exposed?.connection()).resolves.toEqual(DESCRIPTOR)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects a descriptor that is not one, rather than passing it on', () => {
    expect(asConnection({ ...DESCRIPTOR, projectRoot: '' })).toBeNull()
    expect(asConnection({ ...DESCRIPTOR, projectRoot: 7 })).toBeNull()
    expect(asConnection(null)).toBeNull()
    expect(asConnection(DESCRIPTOR)).toEqual(DESCRIPTOR)
  })

  it('refuses a descriptor missing any one field, and the token most of all', () => {
    /*
     * Each field dropped in turn, because "it has a projectRoot" was the whole
     * check until step 2 widened this. A descriptor arriving without its token
     * would otherwise reach the workbench as a connection with no credential, and
     * the failure would surface as an unauthorised WebSocket several layers in
     * rather than at the boundary where it belongs.
     */
    for (const field of Object.keys(DESCRIPTOR)) {
      const { [field]: _dropped, ...rest } = DESCRIPTOR as Record<string, unknown>
      expect(asConnection(rest)).toBeNull()
    }
  })

  /**
   * The trust waiver has to survive this function, and it did not.
   *
   * `asConnection` rebuilds the object from a hardcoded list of names, so a field
   * added to the shared schema and not added here is dropped without a word. That
   * is exactly what happened: main spread `workspaceTrust: 'waived'` into the
   * descriptor, the renderer read it, and the workbench still raised the trust
   * dialog — because five names went in and five came out. These two assertions
   * are the reader for it, and they are written in both directions because the
   * dangerous one is not "the waiver was lost" but "something that is not the
   * waiver was let through".
   */
  it('carries the trust waiver through, and lets nothing else through as one', () => {
    expect(asConnection({ ...DESCRIPTOR, workspaceTrust: 'waived' })).toHaveProperty(
      'workspaceTrust',
      'waived'
    )
    // Anything that is not the exact string is dropped rather than translated,
    // and the absence is what enforces trust — so every rejection here is safe.
    for (const wrong of [true, 'Waived', 'enforced', 1, null, {}]) {
      expect(asConnection({ ...DESCRIPTOR, workspaceTrust: wrong })).not.toHaveProperty(
        'workspaceTrust'
      )
    }
  })

  /**
   * E5's boundary, and the two properties that keep it narrow.
   *
   * The read must **name nothing** — a surface that could name a file would be a
   * surface that could read one — and a reply that is not text must become `null`
   * rather than reach the workbench, because `null` is what makes a profile seed
   * nothing and keep Code-OSS's defaults. The unsafe direction is not "the
   * settings were lost"; it is "something that is not settings was seeded".
   */
  describe('user settings', () => {
    beforeEach(() => {
      invoke.mockReset()
    })

    it('asks for the profile settings without naming anything', async () => {
      invoke.mockResolvedValue('{"files.autoSave":"off"}')
      await expect(exposed?.readUserSettings()).resolves.toBe('{"files.autoSave":"off"}')
      expect(invoke).toHaveBeenCalledWith(WORKBENCH_USER_SETTINGS_READ_CHANNEL)
      // One argument — the channel — and no second. A path would be the second.
      expect(invoke.mock.calls[0]).toHaveLength(1)
    })

    it('degrades an answer that is not text to a clean profile', async () => {
      for (const wrong of [42, null, undefined, {}, ['{}']]) {
        invoke.mockResolvedValue(wrong)
        await expect(exposed?.readUserSettings()).resolves.toBeNull()
      }
    })

    it('hands the text to main on the write channel', async () => {
      invoke.mockResolvedValue(undefined)
      await exposed?.writeUserSettings('{"files.autoSave":"off"}')
      expect(invoke).toHaveBeenCalledWith(
        WORKBENCH_USER_SETTINGS_WRITE_CHANNEL,
        '{"files.autoSave":"off"}'
      )
    })
  })
})
