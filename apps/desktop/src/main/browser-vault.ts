import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import {
  BROWSER_ACCOUNTS_MAX,
  BrowserId,
  BrowserOrigin,
  BrowserPassword,
  BrowserUsername,
  isBrowserPasswordOrigin,
  type BrowserFailure,
  type BrowserPasswordAccount,
  type BrowserStorage,
} from '../shared/browser-ipc.js'
import {
  browserDataPath,
  readBounded,
  writeAtomically,
  type BoundedRead,
} from './browser-settings.js'

export const BROWSER_VAULT_FILE = 'passwords.bin'
export const BROWSER_VAULT_RECORDS_MAX = 2000
export const BROWSER_VAULT_ORIGIN_RECORDS_MAX = BROWSER_ACCOUNTS_MAX
export const BROWSER_VAULT_NEVER_MAX = 2000
export const BROWSER_VAULT_PLAINTEXT_MAX = 8 * 1024 * 1024
export const BROWSER_VAULT_FILE_MAX = 16 * 1024 * 1024
const FILE_MODE = 0o600

export function browserVaultPath(userDataPath: string): string {
  return join(browserDataPath(userDataPath), BROWSER_VAULT_FILE)
}

export interface BrowserVaultDecrypted {
  readonly result: string
  readonly shouldReEncrypt: boolean
}

export interface BrowserVaultCrypto {
  readonly protectedStorage: () => Promise<boolean>
  readonly encrypt: (plainText: string) => Promise<Buffer>
  readonly decrypt: (encrypted: Buffer) => Promise<BrowserVaultDecrypted>
}

export const electronVaultCrypto: BrowserVaultCrypto = {
  protectedStorage: async () => {
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') return false
    }
    return safeStorage.isAsyncEncryptionAvailable()
  },
  encrypt: (plainText) => safeStorage.encryptStringAsync(plainText),
  decrypt: async (encrypted) => {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted)
    return { result, shouldReEncrypt }
  },
}

const PasswordOrigin = BrowserOrigin.refine(isBrowserPasswordOrigin)

const VaultRecord = z
  .object({
    id: BrowserId,
    origin: PasswordOrigin,
    username: BrowserUsername,
    password: BrowserPassword,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
type VaultRecord = z.infer<typeof VaultRecord>

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function accountKey(record: VaultRecord): string {
  return JSON.stringify([record.origin, record.username])
}

function matches(record: VaultRecord, origin: string, username: string): boolean {
  return record.origin === origin && record.username === username
}

function originsWithinLimit(records: readonly VaultRecord[]): boolean {
  const counts = new Map<string, number>()
  for (const record of records) {
    const count = (counts.get(record.origin) ?? 0) + 1
    if (count > BROWSER_VAULT_ORIGIN_RECORDS_MAX) return false
    counts.set(record.origin, count)
  }
  return true
}

const VaultContent = z
  .object({
    version: z.literal(1),
    records: z.array(VaultRecord).max(BROWSER_VAULT_RECORDS_MAX),
    never: z.array(PasswordOrigin).max(BROWSER_VAULT_NEVER_MAX),
  })
  .strict()
  .refine((content) => unique(content.records.map((record) => record.id)))
  .refine((content) => unique(content.records.map(accountKey)))
  .refine((content) => unique(content.never))
  .refine((content) => originsWithinLimit(content.records))
type VaultContent = z.infer<typeof VaultContent>

export type BrowserVaultMode = 'save' | 'update' | 'same' | 'never'

export interface BrowserVaultAccounts {
  readonly storage: BrowserStorage
  readonly accounts: readonly BrowserPasswordAccount[]
  readonly neverSave: boolean
}

export interface BrowserVaultCredential {
  readonly username: string
  readonly password: string
}

type Loaded =
  | { readonly kind: 'ready'; readonly content: VaultContent }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'unreadable' }

function emptyContent(): VaultContent {
  return { version: 1, records: [], never: [] }
}

function parseContent(text: string): VaultContent | null {
  if (Buffer.byteLength(text, 'utf8') > BROWSER_VAULT_PLAINTEXT_MAX) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = VaultContent.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function failureOf(kind: Exclude<Loaded['kind'], 'ready'>): BrowserFailure {
  switch (kind) {
    case 'unavailable':
      return 'storage-unavailable'
    case 'locked':
      return 'storage-locked'
    case 'corrupt':
      return 'storage-corrupt'
    case 'unreadable':
      return 'storage-unreadable'
  }
}

function storable(origin: string, username: string, password: string): boolean {
  return (
    isBrowserPasswordOrigin(origin) &&
    BrowserUsername.safeParse(username).success &&
    BrowserPassword.safeParse(password).success
  )
}

function upsert(
  records: readonly VaultRecord[],
  entry: { readonly origin: string; readonly username: string; readonly password: string },
  now: number
): VaultRecord[] {
  const index = records.findIndex((record) => matches(record, entry.origin, entry.username))
  if (index === -1) {
    return [...records, { id: randomUUID(), ...entry, createdAt: now, updatedAt: now }]
  }
  return records.map((record, at) =>
    at === index ? { ...record, password: entry.password, updatedAt: now } : record
  )
}

export class BrowserVault {
  private readonly path: string
  private readonly crypto: BrowserVaultCrypto
  private tail: Promise<void> = Promise.resolve()
  private loaded: Loaded | null = null

  constructor(userDataPath: string, crypto: BrowserVaultCrypto = electronVaultCrypto) {
    this.path = browserVaultPath(userDataPath)
    this.crypto = crypto
  }

  storage(): Promise<BrowserStorage> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return loaded.kind
      return (await this.protectedStorage()) ? 'ready' : 'unavailable'
    })
  }

  accounts(origin: string): Promise<BrowserVaultAccounts> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return { storage: loaded.kind, accounts: [], neverSave: false }
      const storage = (await this.protectedStorage()) ? 'ready' : 'unavailable'
      if (!isBrowserPasswordOrigin(origin)) return { storage, accounts: [], neverSave: false }
      const accounts = loaded.content.records
        .filter((record) => record.origin === origin)
        .sort((left, right) => left.username.localeCompare(right.username))
        .slice(0, BROWSER_ACCOUNTS_MAX)
        .map((record) => ({ id: record.id, origin: record.origin, username: record.username }))
      return { storage, accounts, neverSave: loaded.content.never.includes(origin) }
    })
  }

  classify(origin: string, username: string, password: string): Promise<BrowserVaultMode | null> {
    return this.run(async () => {
      if (!storable(origin, username, password)) return null
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return null
      if (loaded.content.never.includes(origin)) return 'never'
      const existing = loaded.content.records.find((record) => matches(record, origin, username))
      if (existing === undefined) return 'save'
      return existing.password === password ? 'same' : 'update'
    })
  }

  save(origin: string, username: string, password: string): Promise<BrowserFailure | null> {
    return this.run(async () => {
      if (!storable(origin, username, password)) return 'not-eligible'
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      const { records } = loaded.content
      const known = records.some((record) => matches(record, origin, username))
      const atOrigin = records.filter((record) => record.origin === origin).length
      if (!known && records.length >= BROWSER_VAULT_RECORDS_MAX) return 'limit'
      if (!known && atOrigin >= BROWSER_VAULT_ORIGIN_RECORDS_MAX) return 'limit'
      return this.commit({
        version: 1,
        records: upsert(records, { origin, username, password }, Date.now()),
        never: loaded.content.never.filter((entry) => entry !== origin),
      })
    })
  }

  never(origin: string): Promise<BrowserFailure | null> {
    return this.run(async () => {
      if (!isBrowserPasswordOrigin(origin)) return 'not-eligible'
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      const blocked = loaded.content.never
      if (blocked.includes(origin)) return null
      if (blocked.length >= BROWSER_VAULT_NEVER_MAX) return 'limit'
      return this.commit({ ...loaded.content, never: [...blocked, origin] })
    })
  }

  allow(origin: string): Promise<BrowserFailure | null> {
    return this.run(async () => {
      if (!isBrowserPasswordOrigin(origin)) return 'not-eligible'
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      const blocked = loaded.content.never
      if (!blocked.includes(origin)) return null
      const remaining = blocked.filter((entry) => entry !== origin)
      return this.commit({ ...loaded.content, never: remaining })
    })
  }

  remove(origin: string, accountId: string): Promise<BrowserFailure | null> {
    return this.run(async () => {
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return failureOf(loaded.kind)
      const { records } = loaded.content
      const kept = records.filter((record) => record.id !== accountId || record.origin !== origin)
      if (kept.length === records.length) return 'not-found'
      return this.commit({ ...loaded.content, records: kept })
    })
  }

  credential(origin: string, accountId: string): Promise<BrowserVaultCredential | null> {
    return this.run(async () => {
      if (!isBrowserPasswordOrigin(origin)) return null
      const loaded = await this.load()
      if (loaded.kind !== 'ready') return null
      const record = loaded.content.records.find(
        (entry) => entry.id === accountId && entry.origin === origin
      )
      return record === undefined ? null : { username: record.username, password: record.password }
    })
  }

  reload(): Promise<void> {
    return this.run(() => {
      if (this.loaded?.kind !== 'ready') this.loaded = null
      return Promise.resolve()
    })
  }

  flush(): Promise<void> {
    return this.run(() => Promise.resolve())
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async protectedStorage(): Promise<boolean> {
    try {
      return await this.crypto.protectedStorage()
    } catch {
      return false
    }
  }

  private async load(): Promise<Loaded> {
    const cached = this.loaded
    if (cached !== null && cached.kind !== 'unavailable' && cached.kind !== 'unreadable') {
      return cached
    }
    this.loaded = await this.decode(await readBounded(this.path, BROWSER_VAULT_FILE_MAX))
    return this.loaded
  }

  private async decode(read: BoundedRead): Promise<Loaded> {
    if (read.kind === 'missing') return { kind: 'ready', content: emptyContent() }
    if (read.kind === 'error') return { kind: 'unreadable' }
    if (read.kind === 'too-large') return { kind: 'corrupt' }
    if (!(await this.protectedStorage())) return { kind: 'unavailable' }
    let decrypted: BrowserVaultDecrypted
    try {
      decrypted = await this.crypto.decrypt(read.bytes)
    } catch {
      return { kind: 'locked' }
    }
    const content = parseContent(decrypted.result)
    if (content === null) return { kind: 'corrupt' }
    if (decrypted.shouldReEncrypt) await this.persist(content)
    return { kind: 'ready', content }
  }

  private async commit(next: VaultContent): Promise<BrowserFailure | null> {
    const failure = await this.persist(next)
    if (failure === null) this.loaded = { kind: 'ready', content: next }
    return failure
  }

  private async persist(content: VaultContent): Promise<BrowserFailure | null> {
    if (!(await this.protectedStorage())) return 'storage-unavailable'
    let text: string
    try {
      text = JSON.stringify(VaultContent.parse(content))
    } catch {
      return 'failed'
    }
    if (Buffer.byteLength(text, 'utf8') > BROWSER_VAULT_PLAINTEXT_MAX) return 'limit'
    let encrypted: Buffer
    try {
      encrypted = await this.crypto.encrypt(text)
      if ((await this.crypto.decrypt(encrypted)).result !== text) return 'storage-unavailable'
    } catch {
      return 'storage-unavailable'
    }
    if (encrypted.length > BROWSER_VAULT_FILE_MAX) return 'limit'
    try {
      await writeAtomically(this.path, encrypted, FILE_MODE)
    } catch {
      return 'failed'
    }
    return null
  }
}
