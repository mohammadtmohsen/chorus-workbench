import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectScripts } from './project-scripts.js'

const made: string[] = []

const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'chorus-scripts-'))
  made.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const manifest = (fields: Record<string, unknown>): string => JSON.stringify(fields)

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the package manager', () => {
  it('takes the declared packageManager over any lockfile', async () => {
    const root = project({
      'package.json': manifest({
        packageManager: 'npm@10.9.4',
        scripts: { dev: 'expo start', 'dev:clean': 'expo start -c' },
      }),
      'yarn.lock': '',
    })

    const detected = await detectScripts(root)

    expect(detected.manager).toBe('npm')
    expect(detected.managerSource).toBe('packageManager')
    expect(detected.scripts).toEqual([
      { name: 'dev', command: 'npm run dev' },
      { name: 'dev:clean', command: 'npm run dev:clean' },
    ])
  })

  it('falls back to the lockfile, including the text bun.lock, and then to npm', async () => {
    const scripts = manifest({ scripts: { dev: 'x' } })
    const withLock = (lockfile: string): Promise<unknown> =>
      detectScripts(project({ 'package.json': scripts, [lockfile]: '' }))

    expect(await withLock('bun.lock')).toMatchObject({
      manager: 'bun',
      managerSource: 'lockfile',
      scripts: [{ name: 'dev', command: 'bun run dev' }],
    })
    expect(await withLock('pnpm-lock.yaml')).toMatchObject({
      manager: 'pnpm',
      managerSource: 'lockfile',
    })
    expect(await withLock('yarn.lock')).toMatchObject({
      manager: 'yarn',
      scripts: [{ name: 'dev', command: 'yarn run dev' }],
    })
    expect(await detectScripts(project({ 'package.json': scripts }))).toMatchObject({
      manager: 'npm',
      managerSource: 'default',
    })
  })

  it('ignores a packageManager it does not know', async () => {
    const root = project({
      'package.json': manifest({ packageManager: 'deno@2.0.0' }),
      'package-lock.json': '{}',
    })

    expect(await detectScripts(root)).toMatchObject({ manager: 'npm', managerSource: 'lockfile' })
  })

  it('reports lockfiles that disagree, and not two that belong to one manager', async () => {
    const disagree = await detectScripts(
      project({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })
    )
    expect(disagree.manager).toBe('pnpm')
    expect(disagree.conflictingLockfiles).toEqual(['pnpm-lock.yaml', 'package-lock.json'])

    const agree = await detectScripts(
      project({ 'package.json': '{}', 'bun.lock': '', 'bun.lockb': '' })
    )
    expect(agree.manager).toBe('bun')
    expect(agree.conflictingLockfiles).toEqual([])
  })
})

describe('the scripts it offers', () => {
  it('quotes a name a shell would split or expand, and leaves ordinary names alone', async () => {
    const root = project({
      'package.json': manifest({
        scripts: {
          'ios:clean': 'x',
          '@scope/run.it': 'x',
          "build it's": 'x',
          'dev;$(touch x)': 'x',
        },
      }),
    })

    expect((await detectScripts(root)).scripts.map((script) => script.command)).toEqual([
      'npm run ios:clean',
      'npm run @scope/run.it',
      `npm run 'build it'\\''s'`,
      `npm run 'dev;$(touch x)'`,
    ])
  })

  it('leaves out a name starting with a dash, which every manager would read as an option', async () => {
    const root = project({
      'package.json': manifest({
        scripts: { '-x': 'x', '--version': 'x', dev: 'x', 'a-b': 'x' },
      }),
    })

    expect((await detectScripts(root)).scripts).toEqual([
      { name: 'dev', command: 'npm run dev' },
      { name: 'a-b', command: 'npm run a-b' },
    ])
  })

  it('skips entries that are not commands, and has none when scripts is missing', async () => {
    const odd = project({
      'package.json': manifest({ scripts: { dev: 'expo start', broken: 3, nested: { a: 'b' } } }),
    })
    expect((await detectScripts(odd)).scripts).toEqual([{ name: 'dev', command: 'npm run dev' }])

    expect((await detectScripts(project({ 'package.json': '{}' }))).scripts).toEqual([])
  })

  it('offers nothing, without failing, for a missing, unreadable, non-object or oversized package.json', async () => {
    const roots = [
      project({}),
      project({ 'package.json': '{not json' }),
      project({ 'package.json': '["dev"]' }),
      project({
        'package.json': manifest({
          packageManager: 'pnpm@9.0.0',
          scripts: { dev: 'x' },
          padding: 'x'.repeat(1_048_577),
        }),
      }),
    ]

    for (const root of roots) {
      expect(await detectScripts(root)).toEqual({
        manager: 'npm',
        managerSource: 'default',
        conflictingLockfiles: [],
        scripts: [],
        expo: false,
        variables: [],
      })
    }
  })
})

describe('the Expo variables it suggests', () => {
  const expoProject = (files: Record<string, string>): string =>
    project({
      'package.json': manifest({ dependencies: { expo: '~57.0.26' } }),
      ...files,
    })

  it('finds each EXPO_PUBLIC name read from process.env in app, src and root config, once', async () => {
    const root = expoProject({
      'src/config/api.ts': [
        'export const API = process.env.EXPO_PUBLIC_API_BASE_URL ?? "x"',
        'process.env.EXPO_PUBLIC_API_BASE_URL',
      ].join('\n'),
      'app/(auth)/login.tsx': 'const key = process.env.EXPO_PUBLIC_MAPS_KEY',
      'app.config.ts': 'export default { extra: process.env.EXPO_PUBLIC_RELEASE }',
      'src/readme.md': 'process.env.EXPO_PUBLIC_NOT_SOURCE',
      'src/other.ts': 'process.env.API_URL; process.env.expo_public_lower',
    })

    const detected = await detectScripts(root)

    expect(detected.expo).toBe(true)
    expect(detected.variables).toEqual([
      'EXPO_PUBLIC_API_BASE_URL',
      'EXPO_PUBLIC_MAPS_KEY',
      'EXPO_PUBLIC_RELEASE',
    ])
  })

  it('takes only whole names, never the start of a longer identifier', async () => {
    const root = expoProject({
      'src/env.ts': [
        'process.env.EXPO_PUBLIC_API_URL_suffix',
        'process.env.EXPO_PUBLIC_API_URL$extra',
        'process.env.EXPO_PUBLIC_API_URLx',
        'process.env.EXPO_PUBLIC_SEMI;',
        'call(process.env.EXPO_PUBLIC_PAREN)',
        'process.env.EXPO_PUBLIC_METHOD.trim()',
        'process.env.EXPO_PUBLIC_END',
      ].join('\n'),
    })

    expect((await detectScripts(root)).variables).toEqual([
      'EXPO_PUBLIC_END',
      'EXPO_PUBLIC_METHOD',
      'EXPO_PUBLIC_PAREN',
      'EXPO_PUBLIC_SEMI',
    ])
  })

  it('does not scan a project that is not Expo', async () => {
    const root = project({
      'package.json': manifest({ dependencies: { next: '15.0.0' } }),
      'src/env.ts': 'process.env.EXPO_PUBLIC_API_BASE_URL',
    })

    expect(await detectScripts(root)).toMatchObject({ expo: false, variables: [] })
  })

  it('skips node_modules, symlinks and files over 512 KiB', async () => {
    const outside = project({ 'leak.ts': 'process.env.EXPO_PUBLIC_OUTSIDE' })
    const root = expoProject({
      'src/node_modules/pkg/index.js': 'process.env.EXPO_PUBLIC_DEPENDENCY',
      'src/huge.ts': `process.env.EXPO_PUBLIC_HUGE\n${'x'.repeat(524_289)}`,
      'src/ok.ts': 'process.env.EXPO_PUBLIC_OK',
    })
    symlinkSync(outside, join(root, 'src', 'linked'))
    symlinkSync(join(outside, 'leak.ts'), join(root, 'src', 'leak.ts'))
    symlinkSync(outside, join(root, 'app'))

    expect((await detectScripts(root)).variables).toEqual(['EXPO_PUBLIC_OK'])
  })

  it('visits no more than 1,000 directories, counting src itself', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_001; index += 1) {
      files[`src/d${String(index)}/env.ts`] = `process.env.EXPO_PUBLIC_D${String(index)}`
    }
    const root = expoProject(files)

    expect((await detectScripts(root)).variables).toHaveLength(999)
  })

  it('stops after 20,000 directory entries, whatever they hold', async () => {
    const root = expoProject({ 'src/z/deep/env.ts': 'process.env.EXPO_PUBLIC_BEHIND' })
    mkdirSync(join(root, 'src', 'a'))
    for (let index = 0; index < 20_001; index += 1) {
      writeFileSync(join(root, 'src', 'a', `note-${String(index)}.txt`), '')
    }

    expect((await detectScripts(root)).variables).toEqual([])
  })

  it('reads no more than 2,000 source files', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 2_050; index += 1) {
      files[`src/file-${String(index)}.ts`] = `process.env.EXPO_PUBLIC_V${String(index)}`
    }
    const root = expoProject(files)

    expect((await detectScripts(root)).variables).toHaveLength(2_000)
  })
})
