import { lstat, open, opendir } from 'node:fs/promises'
import { extname, join } from 'node:path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface DetectedScript {
  readonly name: string
  readonly command: string
}

export interface DetectedScripts {
  readonly manager: PackageManager
  readonly managerSource: 'packageManager' | 'lockfile' | 'default'
  readonly conflictingLockfiles: readonly string[]
  readonly scripts: readonly DetectedScript[]
  readonly expo: boolean
  readonly variables: readonly string[]
}

interface ScanBudget {
  entries: number
  directories: number
}

const PACKAGE_JSON_LIMIT = 1_048_576
const SOURCE_FILE_LIMIT = 524_288
const SOURCE_FILE_COUNT = 2_000
const SCAN_ENTRY_LIMIT = 20_000
const SCAN_DIRECTORY_LIMIT = 1_000

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const DECLARED_MANAGER = /^(npm|pnpm|yarn|bun)@/
const PLAIN_SCRIPT_NAME = /^[\w:.@/-]+$/
const EXPO_VARIABLE = /process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)(?![\w$])/g
const SOURCE_DIRECTORIES = ['app', 'src']
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function quoteScriptName(name: string): string {
  if (PLAIN_SCRIPT_NAME.test(name)) return name
  return `'${name.replaceAll("'", `'\\''`)}'`
}

function scriptCommand(manager: PackageManager, name: string): string {
  return `${manager} run ${quoteScriptName(name)}`
}

async function isPlainFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readBounded(path: string, limit: number): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > limit) return null
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(limit + 1)
      let filled = 0
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return filled > limit ? null : buffer.toString('utf8', 0, filled)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function readManifest(root: string): Promise<Record<string, unknown> | null> {
  const text = await readBounded(join(root, 'package.json'), PACKAGE_JSON_LIMIT)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isRecord(parsed) ? parsed : null
}

function declaredManager(manifest: Record<string, unknown> | null): PackageManager | null {
  const declared = manifest?.['packageManager']
  if (typeof declared !== 'string') return null
  const match = DECLARED_MANAGER.exec(declared.trim())
  const name = match?.[1]
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : null
}

function scriptNames(manifest: Record<string, unknown> | null): string[] {
  const scripts = manifest?.['scripts']
  if (!isRecord(scripts)) return []
  return Object.entries(scripts)
    .filter(([name, body]) => name !== '' && !name.startsWith('-') && typeof body === 'string')
    .map(([name]) => name)
}

function declaresExpo(manifest: Record<string, unknown> | null): boolean {
  return ['dependencies', 'devDependencies'].some((field) => {
    const dependencies = manifest?.[field]
    return isRecord(dependencies) && Object.hasOwn(dependencies, 'expo')
  })
}

async function presentLockfiles(
  root: string
): Promise<readonly (readonly [string, PackageManager])[]> {
  const present: (readonly [string, PackageManager])[] = []
  for (const entry of LOCKFILES) {
    if (await isPlainFile(join(root, entry[0]))) present.push(entry)
  }
  return present
}

async function collect(
  directory: string,
  budget: ScanBudget,
  files: string[],
  pending: string[] | null
): Promise<void> {
  try {
    for await (const entry of await opendir(directory)) {
      if (budget.entries >= SCAN_ENTRY_LIMIT || files.length >= SOURCE_FILE_COUNT) break
      budget.entries += 1
      const path = join(directory, entry.name)
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path)
      } else if (
        pending !== null &&
        entry.isDirectory() &&
        !SKIPPED_DIRECTORIES.has(entry.name) &&
        budget.directories < SCAN_DIRECTORY_LIMIT
      ) {
        budget.directories += 1
        pending.push(path)
      }
    }
  } catch {
    return
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const budget: ScanBudget = { entries: 0, directories: 0 }
  await collect(root, budget, files, null)
  const pending: string[] = []
  for (const name of SOURCE_DIRECTORIES) {
    const path = join(root, name)
    const real = await isPlainDirectory(path)
    if (real && budget.directories < SCAN_DIRECTORY_LIMIT) {
      budget.directories += 1
      pending.push(path)
    }
  }
  let next = pending.shift()
  while (
    next !== undefined &&
    files.length < SOURCE_FILE_COUNT &&
    budget.entries < SCAN_ENTRY_LIMIT
  ) {
    await collect(next, budget, files, pending)
    next = pending.shift()
  }
  return files
}

async function expoVariables(root: string): Promise<string[]> {
  const found = new Set<string>()
  for (const file of await sourceFiles(root)) {
    const text = await readBounded(file, SOURCE_FILE_LIMIT)
    if (text === null) continue
    for (const match of text.matchAll(EXPO_VARIABLE)) {
      const name = match[1]
      if (name !== undefined) found.add(name)
    }
  }
  return [...found].sort()
}

export async function detectScripts(root: string): Promise<DetectedScripts> {
  const manifest = await readManifest(root)
  const lockfiles = await presentLockfiles(root)
  const declared = declaredManager(manifest)
  const fromLockfile = lockfiles[0]?.[1] ?? null
  const manager = declared ?? fromLockfile ?? 'npm'
  const managerSource =
    declared !== null ? 'packageManager' : fromLockfile !== null ? 'lockfile' : 'default'
  const managers = new Set(lockfiles.map(([, each]) => each))
  const expo = declaresExpo(manifest)
  return {
    manager,
    managerSource,
    conflictingLockfiles: managers.size > 1 ? lockfiles.map(([file]) => file) : [],
    scripts: scriptNames(manifest).map((name) => ({ name, command: scriptCommand(manager, name) })),
    expo,
    variables: expo ? await expoVariables(root) : [],
  }
}
