import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKBENCH_CONNECTION_CHANNEL,
  WORKBENCH_USER_SETTINGS_READ_CHANNEL,
  WORKBENCH_USER_SETTINGS_WRITE_CHANNEL,
  WORKBENCH_CONTEXT_CHANNEL,
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
  CONTEXT_CHANNEL,
  asConnection,
} = await import('./workbench.js')

describe('the workbench preload', () => {
  it('names the same channels the shared contract does', () => {
    expect(CONNECTION_CHANNEL).toBe(WORKBENCH_CONNECTION_CHANNEL)
    expect(USER_SETTINGS_READ_CHANNEL).toBe(WORKBENCH_USER_SETTINGS_READ_CHANNEL)
    expect(USER_SETTINGS_WRITE_CHANNEL).toBe(WORKBENCH_USER_SETTINGS_WRITE_CHANNEL)
    expect(CONTEXT_CHANNEL).toBe(WORKBENCH_CONTEXT_CHANNEL)
  })

  it('exposes exactly four methods, and no fifth', () => {
    // The list, not the count: a method named here is a capability a document
    // running extension code is handed, so which ones they are is the assertion.
    expect(Object.keys(exposed ?? {})).toEqual([
      'connection',
      'readUserSettings',
      'writeUserSettings',
      /*
       * Phase 6 slice 6a. It reports and cannot ask: no reply, no path — the
       * value is already project-relative — and no way to name a project, since
       * main derives that from the sender.
       */
      'reportContext',
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
