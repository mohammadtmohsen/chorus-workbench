import { describe, expect, it } from 'vitest'
import {
  capture,
  encodedPowerShell,
  type Execute,
  powerShellLiteral,
  scpUploadArgv,
  SshRemoteHost,
  sshPowerShellArgv,
  sshTunnelArgv,
  windowsArgument,
} from './remote-host.js'

const decode = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le')

describe('sshPowerShellArgv', () => {
  it('ends options before the host, and sends the script as one base64 word', () => {
    const argv = sshPowerShellArgv('officepc', "Get-Item 'C:/Users/user/chorus reh'")
    const host = argv.indexOf('officepc')
    expect(argv[host - 1]).toBe('--')
    expect(argv.slice(host + 1, -1)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ])
    expect(argv[argv.length - 1]).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('decodes back to the script, after a prelude that stops on errors and writes UTF-8', () => {
    const script = 'Write-Output "ünïcode $env:USERNAME"; exit 3'
    const decoded = decode(encodedPowerShell(script))
    expect(decoded.endsWith(`\n${script}`)).toBe(true)
    expect(decoded).toContain("$ErrorActionPreference = 'Stop'")
    expect(decoded).toContain('[System.Text.UTF8Encoding]::new($false)')
  })

  it('refuses a host that ssh would read as an option', () => {
    expect(() => sshPowerShellArgv('-oProxyCommand=x', 'hostname')).toThrow()
    expect(() => sshPowerShellArgv('', 'hostname')).toThrow()
  })
})

describe('powerShellLiteral', () => {
  it('doubles every character PowerShell reads as a single quote', () => {
    expect(powerShellLiteral("it's")).toBe("'it''s'")
    expect(powerShellLiteral('a\u2019b\u2018c')).toBe("'a\u2019\u2019b\u2018\u2018c'")
    expect(powerShellLiteral('$env:PATH `n')).toBe("'$env:PATH `n'")
  })
})

describe('sshTunnelArgv', () => {
  it('forwards loopback to loopback, exits when the forward fails, and notices a dead link', () => {
    expect(sshTunnelArgv('officepc', 48_000, 47_500)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=3',
      '-N',
      '-L',
      '127.0.0.1:48000:127.0.0.1:47500',
      '--',
      'officepc',
    ])
    expect(() => sshTunnelArgv('-oProxyCommand=x', 48_000, 47_500)).toThrow()
  })
})

describe('windowsArgument', () => {
  it('leaves a plain word alone and quotes one a Windows command line would split', () => {
    expect(windowsArgument('--port')).toBe('--port')
    expect(windowsArgument('C:\\Users\\Ahmad Q\\data')).toBe('"C:\\Users\\Ahmad Q\\data"')
    expect(windowsArgument('')).toBe('""')
  })

  it('escapes quotes and the backslashes that would otherwise swallow them', () => {
    expect(windowsArgument('say "hi"')).toBe('"say \\"hi\\""')
    expect(windowsArgument('a\\"b')).toBe('"a\\\\\\"b"')
    expect(windowsArgument('C:\\with space\\')).toBe('"C:\\with space\\\\"')
  })
})

describe('scpUploadArgv', () => {
  it('uses SFTP, ends options before the local path, and writes the path SFTP expects', () => {
    const destination = 'C:\\Users\\user\\chorus-reh\\a.tar.gz'
    expect(scpUploadArgv('officepc', '-archive.tar.gz', destination)).toEqual([
      '-s',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '--',
      '-archive.tar.gz',
      'officepc:/C:/Users/user/chorus-reh/a.tar.gz',
    ])
    const argv = scpUploadArgv('officepc', 'a', '/C:/x/a')
    expect(argv[argv.length - 1]).toBe('officepc:/C:/x/a')
  })

  it('refuses a destination that is not a Windows drive path, and an unusable host', () => {
    expect(() => scpUploadArgv('officepc', 'a', 'chorus-reh/a')).toThrow()
    expect(() => scpUploadArgv('-oProxyCommand=x', 'a', 'C:/x/a')).toThrow()
  })
})

describe('capture', () => {
  it('reports the exit code and output of the command it ran', async () => {
    const script = 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'
    await expect(capture(process.execPath, ['-e', script], 10_000)).resolves.toEqual({
      exitCode: 3,
      stdout: 'out',
      stderr: 'err',
    })
  })

  it('gives up at its deadline instead of waiting on a stalled command', async () => {
    const stalled = capture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 200)
    await expect(stalled).rejects.toThrow('did not finish within 200 ms')
  })
})

describe('SshRemoteHost', () => {
  it('hands each call its deadline', async () => {
    const calls: [string, number][] = []
    const execute: Execute = (command, _argv, deadlineMs) => {
      calls.push([command, deadlineMs])
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }
    const host = new SshRemoteHost('officepc', execute)
    await host.runPowerShell('hostname', 1_000)
    await host.upload('a', 'C:/x/a', 2_000)
    expect(calls).toEqual([
      ['ssh', 1_000],
      ['scp', 2_000],
    ])
  })

  it('fails an upload with what scp said when scp exits non-zero', async () => {
    const execute: Execute = () =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: 'scp: C:/x/a: No such file\n' })
    const host = new SshRemoteHost('officepc', execute)
    await expect(host.upload('a', 'C:/x/a', 1_000)).rejects.toThrow(
      'Upload to officepc failed: scp: C:/x/a: No such file'
    )
  })
})
