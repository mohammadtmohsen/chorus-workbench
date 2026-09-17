import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { powerShellLiteral, type RemoteHost, type RemoteResult } from './remote-host.js'
import {
  checkRemoteHost,
  ensureLocalToken,
  hostPlatformKey,
  powerShellQuotingHolds,
  provisionRemoteServer,
  QUOTE_PROBE,
  startRemoteServer,
  type StartedServer,
} from './remote-workbench.js'
import type { WorkbenchManifest } from './workbench-host.js'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '', getPath: () => '' },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
}))

const scratch = mkdtempSync(join(tmpdir(), 'chorus-remote-workbench-'))

const COMMIT = '987c9597516278c9fcf10d963a0592ce1384ab93'
const WINDOWS_SHA = 'b'.repeat(64)
const BASE = 'C:\\Users\\user\\AppData\\Local\\chorus-reh'
const DEADLINES = { command: 1_000, upload: 2_000, install: 3_000 }

const manifest: WorkbenchManifest = {
  client: {
    package: '@codingame/monaco-vscode-api',
    version: '33.0.9',
    vscodeVersion: '1.121.0',
    vscodeCommit: COMMIT,
    quality: 'stable',
  },
  server: {
    vendor: 'VSCodium',
    release: '1.121.03429',
    upstreamTag: '1.121.0',
    upstreamCommit: COMMIT,
    artifacts: {
      'darwin-arm64': {
        name: 'vscodium-reh-darwin-arm64-1.121.03429.tar.gz',
        size: 1,
        sha256: 'a'.repeat(64),
      },
      'win32-x64': {
        name: 'vscodium-reh-win32-x64-1.121.03429.tar.gz',
        size: 2,
        sha256: WINDOWS_SHA,
      },
    },
  },
}

type Upload = readonly [string, string, number]

const ok = (stdout: string): RemoteResult => ({ exitCode: 0, stdout, stderr: '' })

function recordingHost(replies: readonly RemoteResult[]): {
  readonly host: RemoteHost
  readonly scripts: string[]
  readonly uploads: Upload[]
} {
  const queue = [...replies]
  const scripts: string[] = []
  const uploads: Upload[] = []
  const host: RemoteHost = {
    runPowerShell: (script) => {
      scripts.push(script)
      const reply = queue.shift()
      return reply === undefined
        ? Promise.reject(new Error('an unexpected script'))
        : Promise.resolve(reply)
    },
    upload: (localPath, remotePath, deadlineMs) => {
      uploads.push([localPath, remotePath, deadlineMs])
      return Promise.resolve()
    },
  }
  return { host, scripts, uploads }
}

function provision(host: RemoteHost, asked: string[]): Promise<string> {
  return provisionRemoteServer({
    host,
    manifest,
    localArchive: (key) => {
      asked.push(key)
      return Promise.resolve(`/cache/${key}.tar.gz`)
    },
    deadlines: DEADLINES,
  })
}

describe('provisionRemoteServer', () => {
  it('uploads the archive for the host platform, not for this machine', async () => {
    const { host, uploads } = recordingHost([ok(`${BASE}\r\nAMD64\r\n`), ok('absent\r\n'), ok('')])
    const asked: string[] = []
    await expect(provision(host, asked)).resolves.toBe(`${BASE}\\1.121.03429-win32-x64`)
    expect(asked).toEqual(['win32-x64'])
    expect(uploads).toEqual([
      ['/cache/win32-x64.tar.gz', `${BASE}\\vscodium-reh-win32-x64-1.121.03429.tar.gz`, 2_000],
    ])
  })

  it('uploads nothing when the release is already on the host', async () => {
    const { host, scripts, uploads } = recordingHost([ok(`${BASE}\nAMD64`), ok('present')])
    const asked: string[] = []
    await expect(provision(host, asked)).resolves.toBe(`${BASE}\\1.121.03429-win32-x64`)
    expect(asked).toEqual([])
    expect(uploads).toEqual([])
    expect(scripts).toHaveLength(2)
  })

  it('counts a release as present only when its receipt names this archive', async () => {
    const { host, scripts } = recordingHost([ok(`${BASE}\nAMD64`), ok('present')])
    await provision(host, [])
    expect(scripts[1]).toContain("'chorus-receipt.txt'")
    expect(scripts[1]).toContain(`if ($installed -eq '${WINDOWS_SHA}') { 'present' }`)
  })

  it('extracts with the system tar.exe and patches with the server node.exe', async () => {
    const { host, scripts } = recordingHost([ok(`${BASE}\nAMD64`), ok('absent'), ok('')])
    await provision(host, [])
    const install = scripts[2] ?? ''
    expect(install).toContain(`'${WINDOWS_SHA}'`)
    expect(install).toContain("Join-Path $env:SystemRoot 'System32\\tar.exe'")
    expect(install).toContain(`& $node $patch $product '${COMMIT}'`)
    expect(install).toContain("if ($LASTEXITCODE -ne 0) { throw 'tar.exe could not extract")
    expect(install).toContain(`$partial = '${BASE}\\1.121.03429-win32-x64.partial'`)
    expect(install).toContain("Join-Path $partial 'chorus-receipt.txt') -Encoding ASCII -Value $hash")
    expect(install).toContain('Rename-Item -LiteralPath $partial')
    expect(install.indexOf('$_.CommandLine.Contains($final)')).toBeGreaterThan(-1)
    expect(install.indexOf('$_.CommandLine.Contains($final)')).toBeLessThan(
      install.indexOf('Get-FileHash')
    )
    expect(install).toContain("JSON.stringify({ ...product, commit }, null, 2) + ''\\n''")
  })

  it('refuses a host architecture nothing is published for, before uploading', async () => {
    const { host, uploads } = recordingHost([ok(`${BASE}\nARM64`)])
    await expect(provision(host, [])).rejects.toThrow(
      'No VSCodium server is published for win32-arm64'
    )
    expect(uploads).toEqual([])
  })

  it('fails with the host own words when a step exits non-zero', async () => {
    const failed: RemoteResult = { exitCode: 1, stdout: '', stderr: 'tar.exe could not extract' }
    const { host } = recordingHost([ok(`${BASE}\nAMD64`), ok('absent'), failed])
    await expect(provision(host, [])).rejects.toThrow(
      'Installing the server failed on the remote host: tar.exe could not extract'
    )
  })
})

describe('startRemoteServer', () => {
  const REMOTE_BASE = 'C:\\Users\\Ahmad Q\\AppData\\Local\\chorus-reh'
  const SERVER_DIR = `${REMOTE_BASE}\\1.121.03429-win32-x64`
  const START = { command: 1_000, upload: 2_000, serverStart: 30_000 }
  const tokenFile = join(scratch, 'officepc', 'connection-token')
  const notRunning = ok('0\n\nFalse')

  beforeAll(() => {
    ensureLocalToken(tokenFile)
  })

  const localHash = (): string => createHash('sha256').update(readFileSync(tokenFile)).digest('hex')

  const start = (host: RemoteHost): Promise<StartedServer> =>
    startRemoteServer({
      host,
      serverDir: SERVER_DIR,
      localTokenFile: tokenFile,
      port: 47500,
      deadlines: START,
    })

  const launcherOf = (register: string): string => {
    const encoded = /\$launcher = '([A-Za-z0-9+/=]+)'/.exec(register)?.[1] ?? ''
    return Buffer.from(encoded, 'base64').toString('utf16le')
  }

  it('reattaches to a live server holding this token, without uploading or starting', async () => {
    const { host, scripts, uploads } = recordingHost([ok(`1\n${localHash()}\nTrue`)])
    await expect(start(host)).resolves.toEqual({ port: 47500, reattached: true })
    expect(scripts).toHaveLength(1)
    expect(uploads).toEqual([])
  })

  it('refuses a live server that holds another token', async () => {
    const { host, uploads } = recordingHost([ok(`1\n${'c'.repeat(64)}\nTrue`)])
    await expect(start(host)).rejects.toThrow('already running on the host')
    expect(uploads).toEqual([])
  })

  it('uploads the token beside the server and starts it through an interactive task', async () => {
    const { host, scripts, uploads } = recordingHost([
      notRunning,
      ok(''),
      ok('started\nExtension host agent listening on 47500\n'),
    ])
    await expect(start(host)).resolves.toEqual({ port: 47500, reattached: false })
    expect(uploads).toEqual([[tokenFile, `${REMOTE_BASE}\\connection-token`, 2_000]])
    const register = scripts[1] ?? ''
    expect(register).toContain('New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive')
    expect(register).toContain("Register-ScheduledTask -TaskName 'Chorus Workbench Server'")
    expect(register).toContain('-EncodedCommand $launcher')
    expect(register.indexOf('Remove-Item')).toBeLessThan(register.indexOf('Start-ScheduledTask'))
  })

  it('launches the local server arguments plus auto-shutdown, quoted for Windows', async () => {
    const { host, scripts } = recordingHost([
      notRunning,
      ok(''),
      ok('started\nExtension host agent listening on 47500\n'),
    ])
    await start(host)
    const launcher = launcherOf(scripts[1] ?? '')
    expect(launcher).toContain('Start-Process -WindowStyle Hidden')
    expect(launcher).toContain(`"${REMOTE_BASE}\\data\\server"`)
    expect(launcher).toContain('--port 47500-47500')
    expect(launcher).toContain('--reconnection-grace-time 120 --telemetry-level off')
    expect(launcher).toContain('--log info --enable-remote-auto-shutdown')
  })

  it('fails with what the server said, token redacted, when it never reports a port', async () => {
    const said = 'timed-out\nError: listen EADDRINUSE 127.0.0.1:47500 ?tkn=secret-token\n'
    const { host, scripts } = recordingHost([notRunning, ok(''), ok(said)])
    await expect(start(host)).rejects.toThrow(
      'did not start: Error: listen EADDRINUSE 127.0.0.1:47500 ?tkn=REDACTED'
    )
    expect(scripts[2]).toContain("Get-ScheduledTaskInfo -TaskName 'Chorus Workbench Server'")
  })

  it('refuses a server that bound some other port', async () => {
    const { host } = recordingHost([
      notRunning,
      ok(''),
      ok('started\nExtension host agent listening on 47501\n'),
    ])
    await expect(start(host)).rejects.toThrow('bound 47501, not 47500')
  })
})

describe('checkRemoteHost', () => {
  it('reports a reachable Windows host, its platform and quoting, changing nothing', async () => {
    const { host, scripts, uploads } = recordingHost([ok('AMD64\r\n'), ok(QUOTE_PROBE)])
    await expect(checkRemoteHost(host, 1_000)).resolves.toEqual({
      reachable: true,
      platform: 'win32-x64',
      quotingHolds: true,
      detail: '',
    })
    expect(uploads).toEqual([])
    expect(scripts).toEqual([
      'Write-Output $env:PROCESSOR_ARCHITECTURE',
      `[Console]::Out.Write(${powerShellLiteral(QUOTE_PROBE)})`,
    ])
  })

  it('answers unreachable in the words ssh used, rather than throwing', async () => {
    const stderr = [
      '** WARNING: connection is not using a post-quantum key exchange algorithm.',
      'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known',
    ].join('\n')
    const { host, scripts } = recordingHost([{ exitCode: 255, stdout: '', stderr }])
    await expect(checkRemoteHost(host, 1_000)).resolves.toEqual({
      reachable: false,
      platform: null,
      quotingHolds: false,
      detail: 'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known',
    })
    expect(scripts).toHaveLength(1)
  })

  it('answers unreachable when the connection never finishes', async () => {
    const stalled: RemoteHost = {
      runPowerShell: () => Promise.reject(new Error('ssh did not finish within 1000 ms')),
      upload: () => Promise.resolve(),
    }
    await expect(checkRemoteHost(stalled, 1_000)).resolves.toEqual({
      reachable: false,
      platform: null,
      quotingHolds: false,
      detail: 'ssh did not finish within 1000 ms',
    })
  })

  it('tells a host without Windows PowerShell apart from one it could not reach', async () => {
    const stderr = 'bash: powershell.exe: command not found\n'
    const { host } = recordingHost([{ exitCode: 127, stdout: '', stderr }])
    await expect(checkRemoteHost(host, 1_000)).resolves.toEqual({
      reachable: true,
      platform: null,
      quotingHolds: false,
      detail: 'bash: powershell.exe: command not found',
    })
  })

  it('reports quoting that does not survive the trip', async () => {
    const { host } = recordingHost([ok('ARM64'), ok('mangled')])
    await expect(checkRemoteHost(host, 1_000)).resolves.toMatchObject({
      reachable: true,
      platform: 'win32-arm64',
      quotingHolds: false,
    })
  })
})

describe('ensureLocalToken', () => {
  it('writes a private token once and keeps it', () => {
    const path = join(scratch, 'kept', 'connection-token')
    ensureLocalToken(path)
    const first = readFileSync(path, 'utf8')
    ensureLocalToken(path)
    expect(readFileSync(path, 'utf8')).toBe(first)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('hostPlatformKey', () => {
  it('names the host by its own processor, and refuses one it does not know', () => {
    expect(hostPlatformKey('AMD64')).toBe('win32-x64')
    expect(hostPlatformKey('ARM64')).toBe('win32-arm64')
    expect(() => hostPlatformKey('x86')).toThrow()
  })
})

describe('powerShellQuotingHolds', () => {
  it('holds only when every quote character comes back exactly as sent', async () => {
    const intact = recordingHost([ok(QUOTE_PROBE)])
    await expect(powerShellQuotingHolds(intact.host, 1_000)).resolves.toBe(true)
    const doubled = recordingHost([ok(`${QUOTE_PROBE}\u2019`)])
    await expect(powerShellQuotingHolds(doubled.host, 1_000)).resolves.toBe(false)
  })
})
