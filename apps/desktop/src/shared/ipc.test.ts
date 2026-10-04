import { describe, expect, it } from 'vitest'
import {
  IPC_CHANNELS,
  IPC_CONTRACT,
  TerminalPush,
  TerminalRefShape,
  isIpcChannel,
  terminalRefKey,
} from './ipc.js'
import { extractVersion } from '../main/agent-probe.js'

describe('IPC contract', () => {
  it('gives every channel both a request and a response schema', () => {
    // A channel without both would skip validation on one side, which is the
    // hole the contract exists to close (plan §4.4).
    for (const channel of IPC_CHANNELS) {
      expect(IPC_CONTRACT[channel].request).toBeDefined()
      expect(IPC_CONTRACT[channel].response).toBeDefined()
    }
  })

  it('rejects channels outside the contract', () => {
    expect(isIpcChannel('app:getInfo')).toBe(true)
    expect(isIpcChannel('fs:readFile')).toBe(false)
    expect(isIpcChannel('__proto__')).toBe(false)
  })

  it('rejects a malformed response payload', () => {
    const result = IPC_CONTRACT['app:getInfo'].response.safeParse({ appVersion: 1 })
    expect(result.success).toBe(false)
  })
})

describe('starting a conversation in two steps', () => {
  const started = {
    conversationId: 'c1',
    participants: ['claude'],
    profileId: 'read-only',
    projectId: 'p1',
    cwd: '/tmp/repo',
    title: 'repo',
  }

  it('takes the same request to begin as to start', () => {
    const begin = IPC_CONTRACT['conversation:begin']
    expect(begin.request).toBe(IPC_CONTRACT['conversation:start'].request)
    expect(begin.response).toBe(IPC_CONTRACT['conversation:start'].response)
    expect(begin.request.safeParse({ projectId: '' }).success).toBe(false)
  })

  it('answers a ready, failed or cancelled outcome, and nothing else', () => {
    const outcome = IPC_CONTRACT['conversation:awaitStart'].response
    expect(outcome.safeParse({ status: 'ready', conversation: started }).success).toBe(true)
    expect(outcome.safeParse({ status: 'failed', message: 'claude fell over' }).success).toBe(true)
    expect(outcome.safeParse({ status: 'cancelled' }).success).toBe(true)
    expect(outcome.safeParse({ status: 'failed' }).success).toBe(false)
    expect(outcome.safeParse({ status: 'starting' }).success).toBe(false)
  })

  it('lists a starting room as starting, and one without the field as ready', () => {
    const active = IPC_CONTRACT['conversation:active'].response
    const open = { ...started, unread: 0 }
    const starting = active.parse({ sessions: [{ ...open, starting: true }] }).sessions[0]
    const ready = active.parse({ sessions: [open] }).sessions[0]
    expect(starting?.starting).toBe(true)
    expect(ready?.starting).toBeUndefined()
  })
})

describe('the terminal reference', () => {
  it('accepts both scopes', () => {
    expect(TerminalRefShape.safeParse({ scope: 'global', id: 't1' }).success).toBe(true)
    expect(
      TerminalRefShape.safeParse({ scope: 'session', conversationId: 'c1', id: 't1' }).success
    ).toBe(true)
  })

  /*
   * The whole reason this is a union rather than a nullable conversation id: a
   * malformed reference fails here, at the boundary, instead of becoming a
   * lookup miss three layers in — or worse, a session lookup for `undefined`
   * that happens to find the global terminal.
   */
  it('rejects a session reference with no conversation', () => {
    expect(TerminalRefShape.safeParse({ scope: 'session', id: 't1' }).success).toBe(false)
  })

  it('rejects a scope it has never heard of', () => {
    expect(TerminalRefShape.safeParse({ scope: 'pane', paneId: 'p1', id: 't1' }).success).toBe(
      false
    )
  })

  it('rejects the shape a nullable id would have produced', () => {
    expect(TerminalRefShape.safeParse({ conversationId: null }).success).toBe(false)
  })

  /*
   * A ref with no `id` names a scope, not a shell, and a scope now holds several.
   * Defaulting it to something here would be worse than rejecting: every caller
   * that forgot one would silently address the same terminal.
   */
  it('requires an id in both scopes, since a scope holds several shells', () => {
    expect(TerminalRefShape.safeParse({ scope: 'global' }).success).toBe(false)
    expect(TerminalRefShape.safeParse({ scope: 'session', conversationId: 'c1' }).success).toBe(
      false
    )
  })

  /*
   * `id` is part of the tuple, not the whole of it. Two conversations minting the
   * same id is reachable — the renderer mints them and they ride through an
   * editable file — so nothing downstream may treat `id` as globally unique.
   */
  it('keeps the conversation in a session reference, alongside the id', () => {
    const parsed = TerminalRefShape.safeParse({ scope: 'session', conversationId: 'c1', id: 't1' })
    expect(parsed.success && parsed.data.scope === 'session' && parsed.data.conversationId).toBe(
      'c1'
    )
  })

  it("accepts a project's run, and only under the id 'run'", () => {
    const run = { scope: 'project', projectId: 'p1', id: 'run' }
    expect(TerminalRefShape.safeParse(run).success).toBe(true)
    expect(TerminalRefShape.safeParse({ ...run, id: 't1' }).success).toBe(false)
    expect(TerminalRefShape.safeParse({ scope: 'project', id: 'run' }).success).toBe(false)
  })

  it('accepts a project shell under any id, never without its project', () => {
    const shell = { scope: 'shell', projectId: 'p1', id: 'main' }
    const parsed = TerminalRefShape.safeParse(shell)
    expect(parsed.success && parsed.data).toEqual(shell)
    expect(TerminalRefShape.safeParse({ scope: 'shell', id: 'main' }).success).toBe(false)
    expect(terminalRefKey({ scope: 'shell', projectId: 'p1', id: 'run' })).not.toBe(
      terminalRefKey({ scope: 'project', projectId: 'p1', id: 'run' })
    )
    expect(terminalRefKey({ scope: 'shell', projectId: 'p1', id: 'main' })).not.toBe(
      terminalRefKey({ scope: 'shell', projectId: 'p2', id: 'main' })
    )
  })
})

describe('terminal channels', () => {
  it('round-trips an attach request and its answer', () => {
    const request = IPC_CONTRACT['terminal:attach'].request.safeParse({
      ref: { scope: 'session', conversationId: 'c1', id: 't1' },
      cols: 80,
      rows: 24,
    })
    expect(request.success).toBe(true)

    const response = IPC_CONTRACT['terminal:attach'].response.safeParse({
      epoch: 1,
      generation: 0,
      snapshot: '[31mred',
      seq: 7,
      cols: 80,
      rows: 24,
      exitCode: null,
    })
    expect(response.success).toBe(true)
  })

  it('answers an attach with null when there is no run to attach to', () => {
    expect(IPC_CONTRACT['terminal:attach'].response.safeParse(null).success).toBe(true)
  })

  it('lets attach omit a size, since the panel may not be laid out yet', () => {
    const parsed = IPC_CONTRACT['terminal:attach'].request.safeParse({
      ref: { scope: 'global', id: 't1' },
    })
    expect(parsed.success).toBe(true)
  })

  it('requires an epoch on everything that follows an attach', () => {
    for (const channel of [
      'terminal:detach',
      'terminal:write',
      'terminal:resize',
      'terminal:ack',
    ] as const) {
      const parsed = IPC_CONTRACT[channel].request.safeParse({
        ref: { scope: 'global', id: 't1' },
      })
      expect(parsed.success, channel).toBe(false)
    }
  })

  it('carries data and exit on one push channel, discriminated', () => {
    expect(
      TerminalPush.safeParse({
        kind: 'data',
        ref: { scope: 'global', id: 't1' },
        epoch: 2,
        generation: 0,
        seq: 9,
        data: 'hi\r\n',
      }).success
    ).toBe(true)
    expect(
      TerminalPush.safeParse({
        kind: 'exit',
        ref: { scope: 'global', id: 't1' },
        epoch: 2,
        generation: 0,
        code: 0,
      }).success
    ).toBe(true)
  })

  it('carries a replacement on the same channel, with its generation', () => {
    const ref = { scope: 'project', projectId: 'p1', id: 'run' }
    expect(TerminalPush.safeParse({ kind: 'replaced', ref, generation: 3 }).success).toBe(true)
    expect(TerminalPush.safeParse({ kind: 'replaced', ref }).success).toBe(false)
  })

  it('rejects output or an exit that does not say which run it came from', () => {
    const ref = { scope: 'project', projectId: 'p1', id: 'run' }
    const output = { kind: 'data', ref, epoch: 2, seq: 9, data: 'hi' }
    const exit = { kind: 'exit', ref, epoch: 2, code: 0 }
    expect(TerminalPush.safeParse(output).success).toBe(false)
    expect(TerminalPush.safeParse(exit).success).toBe(false)
  })

  it('rejects a data push with no sequence number to align against', () => {
    expect(
      TerminalPush.safeParse({
        kind: 'data',
        ref: { scope: 'global', id: 't1' },
        epoch: 2,
        generation: 0,
        data: 'hi',
      }).success
    ).toBe(false)
  })

  /*
   * `kill` takes no epoch, and that is the contract rather than an oversight.
   * Only the active tab of a panel is mounted, so a background tab has no
   * attachment to quote one from — while `dispose` keeps its guard for the
   * mounted view that is its only caller.
   */
  it('takes a kill with no epoch, unlike dispose', () => {
    const ref = { scope: 'global', id: 't1' }
    expect(IPC_CONTRACT['terminal:kill'].request.safeParse({ ref }).success).toBe(true)
    expect(IPC_CONTRACT['terminal:dispose'].request.safeParse({ ref }).success).toBe(false)
  })

  it('refuses to kill or dispose a project run, which only run:stop may end', () => {
    const ref = { scope: 'project', projectId: 'p1', id: 'run' }
    expect(IPC_CONTRACT['terminal:kill'].request.safeParse({ ref }).success).toBe(false)
    expect(IPC_CONTRACT['terminal:dispose'].request.safeParse({ ref, epoch: 1 }).success).toBe(
      false
    )
    const session = { scope: 'session', conversationId: 'c1', id: 't1' }
    expect(IPC_CONTRACT['terminal:kill'].request.safeParse({ ref: session }).success).toBe(true)
    expect(
      IPC_CONTRACT['terminal:dispose'].request.safeParse({ ref: session, epoch: 1 }).success
    ).toBe(true)
  })

  it('lets a project shell be killed or disposed like any other terminal', () => {
    const ref = { scope: 'shell', projectId: 'p1', id: 'run' }
    expect(IPC_CONTRACT['terminal:kill'].request.safeParse({ ref }).success).toBe(true)
    expect(IPC_CONTRACT['terminal:dispose'].request.safeParse({ ref, epoch: 1 }).success).toBe(true)
  })

  it('still lets a view attach, type into, resize and detach from a project run', () => {
    const ref = { scope: 'project', projectId: 'p1', id: 'run' }
    expect(IPC_CONTRACT['terminal:attach'].request.safeParse({ ref }).success).toBe(true)
    expect(
      IPC_CONTRACT['terminal:write'].request.safeParse({ ref, epoch: 1, data: 'r' }).success
    ).toBe(true)
    expect(
      IPC_CONTRACT['terminal:resize'].request.safeParse({ ref, epoch: 1, cols: 80, rows: 24 })
        .success
    ).toBe(true)
    expect(IPC_CONTRACT['terminal:detach'].request.safeParse({ ref, epoch: 1 }).success).toBe(true)
  })

  it('still requires a terminal to kill', () => {
    expect(IPC_CONTRACT['terminal:kill'].request.safeParse({}).success).toBe(false)
    expect(
      IPC_CONTRACT['terminal:kill'].request.safeParse({ ref: { scope: 'global' } }).success
    ).toBe(false)
  })

  it('describes a terminal that was never opened as null', () => {
    expect(IPC_CONTRACT['terminal:describe'].response.safeParse(null).success).toBe(true)
  })
})

describe('extractVersion', () => {
  it('parses the real output of both CLIs', () => {
    expect(extractVersion('codex-cli 0.146.0')).toBe('0.146.0')
    expect(extractVersion('2.1.220 (Claude Code)')).toBe('2.1.220')
  })

  it('handles prerelease suffixes and surrounding whitespace', () => {
    expect(extractVersion('  1.2.3-beta.4  \n')).toBe('1.2.3-beta.4')
  })

  it('returns null when there is no version to find', () => {
    expect(extractVersion('command not found')).toBeNull()
  })
})
