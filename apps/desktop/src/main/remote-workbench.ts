import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { app } from 'electron'
import {
  encodedPowerShell,
  powerShellLiteral,
  type RemoteHost,
  type RemoteResult,
  SshRemoteHost,
  windowsArgument,
} from './remote-host.js'
import { acquireTunnel, releaseTunnel } from './remote-tunnel.js'
import {
  cachedServerArchive,
  chooseTunnelPort,
  loadWorkbenchManifest,
  readServerPort,
  redactToken,
  serverArguments,
  workbenchShuttingDown,
  type WorkbenchManifest,
  type WorkbenchRuntime,
} from './workbench-host.js'

export interface RemoteServerDeadlines {
  readonly command: number
  readonly upload: number
  readonly install: number
}

export interface ProvisionOptions {
  readonly host: RemoteHost
  readonly manifest: WorkbenchManifest
  readonly localArchive: (platformKey: string) => Promise<string>
  readonly deadlines: RemoteServerDeadlines
}

export const QUOTE_PROBE = "'‘’‚‛"

const PROBE_SCRIPT = [
  "$base = Join-Path $env:LOCALAPPDATA 'chorus-reh'",
  'New-Item -ItemType Directory -Force -Path $base | Out-Null',
  'Write-Output $base',
  'Write-Output $env:PROCESSOR_ARCHITECTURE',
].join('\n')

const PATCH_COMMIT_JS = [
  "const fs = require('fs')",
  'const [, , file, commit] = process.argv',
  "const product = JSON.parse(fs.readFileSync(file, 'utf8'))",
  "fs.writeFileSync(file, JSON.stringify({ ...product, commit }, null, 2) + '\\n')",
].join('\n')

function succeeded(result: RemoteResult, step: string): string {
  if (result.exitCode !== 0) {
    const said = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim()
    throw new Error(`${step} failed on the remote host: ${said}`)
  }
  return result.stdout
}

export function hostPlatformKey(processorArchitecture: string): string {
  if (processorArchitecture === 'AMD64') return 'win32-x64'
  if (processorArchitecture === 'ARM64') return 'win32-arm64'
  throw new Error(`Unsupported remote processor architecture: ${processorArchitecture}`)
}

const RECEIPT_NAME = 'chorus-receipt.txt'

function presenceScript(finalDir: string, sha256: string): string {
  return [
    `$receipt = Join-Path ${powerShellLiteral(finalDir)} '${RECEIPT_NAME}'`,
    '$installed = if (Test-Path -LiteralPath $receipt) { (Get-Content -Raw -LiteralPath $receipt).Trim() }',
    `if ($installed -eq ${powerShellLiteral(sha256)}) { 'present' } else { 'absent' }`,
  ].join('\n')
}

function installScript(input: {
  readonly archive: string
  readonly finalDir: string
  readonly sha256: string
  readonly commit: string
}): string {
  return [
    `$archive = ${powerShellLiteral(input.archive)}`,
    `$final = ${powerShellLiteral(input.finalDir)}`,
    `$partial = ${powerShellLiteral(`${input.finalDir}.partial`)}`,
    '$holding = @(Get-CimInstance -ClassName Win32_Process | Where-Object {',
    "  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($final)",
    '}).Count',
    "if ($holding -gt 0) { throw 'A running workbench server still uses the tree to replace' }",
    '$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()',
    `if ($hash -ne ${powerShellLiteral(input.sha256)}) {`,
    '  Remove-Item -LiteralPath $archive -Force',
    "  throw 'The uploaded server archive does not match its checksum'",
    '}',
    'if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }',
    'New-Item -ItemType Directory -Path $partial | Out-Null',
    "& (Join-Path $env:SystemRoot 'System32\\tar.exe') -xzf $archive -C $partial",
    "if ($LASTEXITCODE -ne 0) { throw 'tar.exe could not extract the server archive' }",
    "$node = Join-Path $partial 'node.exe'",
    "$product = Join-Path $partial 'product.json'",
    'if (-not ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $product))) {',
    "  throw 'The extracted server has no node.exe or product.json'",
    '}',
    "$patch = Join-Path $partial 'chorus-patch-commit.js'",
    `Set-Content -LiteralPath $patch -Encoding ASCII -Value ${powerShellLiteral(PATCH_COMMIT_JS)}`,
    `& $node $patch $product ${powerShellLiteral(input.commit)}`,
    "if ($LASTEXITCODE -ne 0) { throw 'The server product.json could not be patched' }",
    'Remove-Item -LiteralPath $patch -Force',
    `Set-Content -LiteralPath (Join-Path $partial '${RECEIPT_NAME}') -Encoding ASCII -Value $hash`,
    'if (Test-Path -LiteralPath $final) { Remove-Item -LiteralPath $final -Recurse -Force }',
    'Rename-Item -LiteralPath $partial -NewName (Split-Path -Leaf $final)',
    'Remove-Item -LiteralPath $archive -Force',
  ].join('\n')
}

export async function provisionRemoteServer(options: ProvisionOptions): Promise<string> {
  const { host, manifest, deadlines } = options
  const probe = succeeded(
    await host.runPowerShell(PROBE_SCRIPT, deadlines.command),
    'Probing the host'
  )
  const [base, architecture] = probe.trim().split(/\r?\n/)
  if (base === undefined || architecture === undefined) {
    throw new Error(`The remote host's probe was not understood: ${probe}`)
  }
  const key = hostPlatformKey(architecture.trim())
  const artifact = manifest.server.artifacts[key]
  if (artifact === undefined) {
    throw new Error(`No ${manifest.server.vendor} server is published for ${key}`)
  }

  const finalDir = win32.join(base.trim(), `${manifest.server.release}-${key}`)
  const presence = succeeded(
    await host.runPowerShell(presenceScript(finalDir, artifact.sha256), deadlines.command),
    'Checking for the server'
  )
  if (presence.trim() === 'present') return finalDir

  const remoteArchive = win32.join(base.trim(), artifact.name)
  await host.upload(await options.localArchive(key), remoteArchive, deadlines.upload)
  const install = installScript({
    archive: remoteArchive,
    finalDir,
    sha256: artifact.sha256,
    commit: manifest.client.vscodeCommit,
  })
  succeeded(await host.runPowerShell(install, deadlines.install), 'Installing the server')
  return finalDir
}

export const REMOTE_SERVER_TASK = 'Chorus Workbench Server'

export interface RemoteServerLayout {
  readonly serverDir: string
  readonly tokenFile: string
  readonly serverDataDir: string
  readonly extensionsDir: string
  readonly userDataDir: string
  readonly stdoutLog: string
  readonly stderrLog: string
}

export function remoteServerLayout(serverDir: string): RemoteServerLayout {
  const base = win32.dirname(serverDir)
  const data = win32.join(base, 'data')
  return {
    serverDir,
    tokenFile: win32.join(base, 'connection-token'),
    serverDataDir: win32.join(data, 'server'),
    extensionsDir: win32.join(data, 'extensions'),
    userDataDir: win32.join(data, 'data'),
    stdoutLog: win32.join(base, 'server.out.log'),
    stderrLog: win32.join(base, 'server.err.log'),
  }
}

export const REMOTE_RECONNECTION_GRACE_SECONDS = 120

export function remoteServerArguments(layout: RemoteServerLayout, port: number): readonly string[] {
  const local = serverArguments({
    script: win32.join(layout.serverDir, 'out', 'server-main.js'),
    port,
    tokenFile: layout.tokenFile,
    serverDataDir: layout.serverDataDir,
    extensionsDir: layout.extensionsDir,
    userDataDir: layout.userDataDir,
  })
  const grace = local.indexOf('--reconnection-grace-time')
  if (grace === -1) {
    throw new Error('The server arguments no longer set a reconnection grace time')
  }
  return [
    ...local.slice(0, grace + 1),
    String(REMOTE_RECONNECTION_GRACE_SECONDS),
    ...local.slice(grace + 2),
    '--enable-remote-auto-shutdown',
  ]
}

export function ensureLocalToken(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) writeFileSync(path, randomUUID(), { mode: 0o600 })
  chmodSync(path, 0o600)
}

export interface StartDeadlines {
  readonly command: number
  readonly upload: number
  readonly serverStart: number
}

export interface StartOptions {
  readonly host: RemoteHost
  readonly serverDir: string
  readonly localTokenFile: string
  readonly port: number
  readonly deadlines: StartDeadlines
}

export interface StartedServer {
  readonly port: number
  readonly reattached: boolean
}

function statusScript(layout: RemoteServerLayout, port: number): string {
  return [
    `$dataDir = ${powerShellLiteral(layout.serverDataDir)}`,
    `$tokenFile = ${powerShellLiteral(layout.tokenFile)}`,
    '$running = @(Get-CimInstance -ClassName Win32_Process | Where-Object {',
    "  $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($dataDir)",
    '}).Count',
    "$tokenHash = ''",
    'if (Test-Path -LiteralPath $tokenFile) {',
    '  $tokenHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tokenFile).Hash.ToLowerInvariant()',
    '}',
    '$client = New-Object System.Net.Sockets.TcpClient',
    '$listening = $false',
    `try { $listening = $client.ConnectAsync('127.0.0.1', ${String(port)}).Wait(1000) }`,
    'catch { $listening = $false }',
    'finally { $client.Close() }',
    'Write-Output $running',
    'Write-Output $tokenHash',
    'Write-Output $listening',
  ].join('\n')
}

function launcherScript(layout: RemoteServerLayout, port: number): string {
  const commandLine = remoteServerArguments(layout, port).map(windowsArgument).join(' ')
  const node = win32.join(layout.serverDir, 'node.exe')
  return [
    `$out = ${powerShellLiteral(layout.stdoutLog)}`,
    `$err = ${powerShellLiteral(layout.stderrLog)}`,
    `Start-Process -WindowStyle Hidden -WorkingDirectory ${powerShellLiteral(layout.serverDir)} \``,
    `  -FilePath ${powerShellLiteral(node)} -ArgumentList ${powerShellLiteral(commandLine)} \``,
    '  -RedirectStandardOutput $out -RedirectStandardError $err',
  ].join('\n')
}

function registerScript(layout: RemoteServerLayout, launcher: string): string {
  const task = powerShellLiteral(REMOTE_SERVER_TASK)
  const logs = `${powerShellLiteral(layout.stdoutLog)}, ${powerShellLiteral(layout.stderrLog)}`
  return [
    `Remove-Item -LiteralPath ${logs} -Force -ErrorAction SilentlyContinue`,
    `$launcher = ${powerShellLiteral(encodedPowerShell(launcher))}`,
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $launcher"',
    '$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments',
    '$me = (whoami).Trim()',
    '$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive',
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `',
    '  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `Register-ScheduledTask -TaskName ${task} -Action $action -Principal $principal \``,
    '  -Settings $settings -Force | Out-Null',
    `Start-ScheduledTask -TaskName ${task}`,
  ].join('\n')
}

function waitScript(layout: RemoteServerLayout, seconds: number): string {
  return [
    `$out = ${powerShellLiteral(layout.stdoutLog)}`,
    `$err = ${powerShellLiteral(layout.stderrLog)}`,
    `$until = (Get-Date).AddSeconds(${String(seconds)})`,
    'while ((Get-Date) -lt $until) {',
    '  if (Test-Path -LiteralPath $out) {',
    '    $text = Get-Content -Raw -LiteralPath $out',
    "    if ($text -match 'listening on \\d+|Server bound to|Web UI available at') {",
    "      Write-Output 'started'",
    '      Write-Output $text',
    '      exit 0',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    "Write-Output 'timed-out'",
    `$task = Get-ScheduledTaskInfo -TaskName ${powerShellLiteral(REMOTE_SERVER_TASK)}`,
    "Write-Output ('LastTaskResult: ' + $task.LastTaskResult)",
    'if (Test-Path -LiteralPath $err) { Get-Content -Tail 20 -LiteralPath $err }',
  ].join('\n')
}

export async function startRemoteServer(options: StartOptions): Promise<StartedServer> {
  const { host, port, deadlines } = options
  const layout = remoteServerLayout(options.serverDir)
  const localHash = createHash('sha256').update(readFileSync(options.localTokenFile)).digest('hex')

  const status = succeeded(
    await host.runPowerShell(statusScript(layout, port), deadlines.command),
    'Checking the server'
  )
  const [running, tokenHash, listening] = status.trim().split(/\r?\n/).map((line) => line.trim())
  const count = Number(running)
  if (running === '' || !Number.isInteger(count)) {
    throw new Error(`The server check on the host was not understood: ${status}`)
  }
  if (count > 0) {
    if (tokenHash === localHash && listening === 'True') return { port, reattached: true }
    throw new Error(
      'A Chorus workbench server is already running on the host with another token or port'
    )
  }

  await host.upload(options.localTokenFile, layout.tokenFile, deadlines.upload)
  const register = registerScript(layout, launcherScript(layout, port))
  succeeded(await host.runPowerShell(register, deadlines.command), 'Starting the server')
  const seconds = Math.ceil(deadlines.serverStart / 1000)
  const waitDeadline = deadlines.command + deadlines.serverStart
  const waited = succeeded(
    await host.runPowerShell(waitScript(layout, seconds), waitDeadline),
    'Waiting for the server'
  )
  const [outcome, ...rest] = waited.split(/\r?\n/)
  const said = redactToken(rest.join('\n')).trim()
  if (outcome?.trim() !== 'started') {
    throw new Error(`The workbench server on the host did not start: ${said}`)
  }
  const bound = readServerPort(said)
  if (bound !== port) {
    throw new Error(`The server on the host bound ${String(bound)}, not ${String(port)}`)
  }
  return { port, reattached: false }
}

export const REMOTE_SERVER_PORT = 47_500
export const TUNNEL_UP_DEADLINE_MS = 60_000

const PROVISION_DEADLINES: RemoteServerDeadlines = {
  command: 30_000,
  upload: 600_000,
  install: 600_000,
}

const START_DEADLINES: StartDeadlines = { command: 30_000, upload: 30_000, serverStart: 60_000 }

interface PreparedServer {
  readonly tokenFile: string
  readonly commit: string
  readonly quality: string
}

const preparing = new Map<string, Promise<PreparedServer>>()

function remoteHostDir(host: string): string {
  return join(app.getPath('userData'), 'remote-hosts', host)
}

async function prepareRemoteServer(host: string): Promise<PreparedServer> {
  const { manifest } = loadWorkbenchManifest()
  const tokenFile = join(remoteHostDir(host), 'connection-token')
  ensureLocalToken(tokenFile)
  const remote = new SshRemoteHost(host)
  const download = new AbortController().signal
  const serverDir = await provisionRemoteServer({
    host: remote,
    manifest,
    localArchive: (key) => cachedServerArchive(key, download),
    deadlines: PROVISION_DEADLINES,
  })
  await startRemoteServer({
    host: remote,
    serverDir,
    localTokenFile: tokenFile,
    port: REMOTE_SERVER_PORT,
    deadlines: START_DEADLINES,
  })
  return { tokenFile, commit: manifest.client.vscodeCommit, quality: manifest.client.quality }
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export async function acquireRemoteWorkbenchRuntime(
  host: string,
  holder: string
): Promise<WorkbenchRuntime> {
  if (workbenchShuttingDown()) {
    throw new Error('Chorus is shutting down; no workbench project can open.')
  }
  const inFlight =
    preparing.get(host) ??
    prepareRemoteServer(host).finally(() => {
      preparing.delete(host)
    })
  preparing.set(host, inFlight)
  const prepared = await inFlight

  const localPort = await chooseTunnelPort(join(remoteHostDir(host), 'tunnel-port'))
  const tunnel = acquireTunnel({ host, localPort, remotePort: REMOTE_SERVER_PORT }, holder)
  if (!(await settlesWithin(tunnel.firstUp, TUNNEL_UP_DEADLINE_MS))) {
    const reason = tunnel.lastFailure === '' ? 'ssh gave no reason' : tunnel.lastFailure
    await releaseTunnel(host, holder)
    throw new Error(
      `The tunnel to ${host} did not come up within ${String(TUNNEL_UP_DEADLINE_MS / 1000)} s: ${reason}`
    )
  }
  return {
    remoteAuthority: `127.0.0.1:${String(localPort)}`,
    connectionToken: readFileSync(prepared.tokenFile, 'utf8').trim(),
    commit: prepared.commit,
    quality: prepared.quality,
  }
}

export function releaseRemoteWorkbenchRuntime(host: string, holder: string): Promise<void> {
  return releaseTunnel(host, holder)
}

export async function powerShellQuotingHolds(
  host: RemoteHost,
  deadlineMs: number
): Promise<boolean> {
  const script = `[Console]::Out.Write(${powerShellLiteral(QUOTE_PROBE)})`
  const result = await host.runPowerShell(script, deadlineMs)
  return result.exitCode === 0 && result.stdout === QUOTE_PROBE
}
