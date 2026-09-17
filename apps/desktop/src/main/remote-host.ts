import { spawn } from 'node:child_process'

export interface RemoteResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RemoteHost {
  runPowerShell(script: string, deadlineMs: number): Promise<RemoteResult>
  upload(localPath: string, remotePath: string, deadlineMs: number): Promise<void>
}

export type Execute = (
  command: string,
  argv: readonly string[],
  deadlineMs: number
) => Promise<RemoteResult>

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'] as const

const POWERSHELL_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
].join('\n')

function usableHost(host: string): string {
  if (host === '' || host.startsWith('-')) throw new Error(`Not a usable ssh host: ${host}`)
  return host
}

export function powerShellLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`
}

export function windowsArgument(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  return `"${escaped}"`
}

export function encodedPowerShell(script: string): string {
  return Buffer.from(`${POWERSHELL_PRELUDE}\n${script}`, 'utf16le').toString('base64')
}

export function sshPowerShellArgv(host: string, script: string): readonly string[] {
  return [
    ...SSH_OPTIONS,
    '--',
    usableHost(host),
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedPowerShell(script),
  ]
}

export function sshTunnelArgv(
  host: string,
  localPort: number,
  remotePort: number
): readonly string[] {
  return [
    ...SSH_OPTIONS,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
    '-N',
    '-L',
    `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    '--',
    usableHost(host),
  ]
}

export function scpUploadArgv(
  host: string,
  localPath: string,
  remotePath: string
): readonly string[] {
  const forward = remotePath.replace(/\\/g, '/')
  const sftpPath = /^[A-Za-z]:\//.test(forward) ? `/${forward}` : forward
  if (!/^\/[A-Za-z]:\//.test(sftpPath)) {
    throw new Error(`A remote upload path must be a Windows drive path: ${remotePath}`)
  }
  return ['-s', ...SSH_OPTIONS, '--', localPath, `${usableHost(host)}:${sftpPath}`]
}

export const capture: Execute = (command, argv, deadlineMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const deadline = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} did not finish within ${String(deadlineMs)} ms`))
    }, deadlineMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(deadline)
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })

export class SshRemoteHost implements RemoteHost {
  constructor(
    private readonly host: string,
    private readonly execute: Execute = capture
  ) {}

  runPowerShell(script: string, deadlineMs: number): Promise<RemoteResult> {
    return this.execute('ssh', sshPowerShellArgv(this.host, script), deadlineMs)
  }

  async upload(localPath: string, remotePath: string, deadlineMs: number): Promise<void> {
    const argv = scpUploadArgv(this.host, localPath, remotePath)
    const result = await this.execute('scp', argv, deadlineMs)
    if (result.exitCode !== 0) {
      throw new Error(`Upload to ${this.host} failed: ${result.stderr.trim()}`)
    }
  }
}
