import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { assemble } from './log-lines.js'

export interface LogcatChild {
  kill(): void
  onLine(listener: (line: string) => void): void
  onExit(listener: (code: number | null) => void): void
}

export type LogcatSpawner = (filters: string) => LogcatChild

export interface LogcatServiceOptions {
  readonly spawn?: LogcatSpawner
}

export interface LogcatState {
  readonly running: boolean
  readonly filters: string | null
  readonly exitCode: number | null
}

export class LogcatService {
  private readonly lines = new Set<(line: string) => void>()
  private readonly exits = new Set<(code: number | null) => void>()
  private readonly spawner: LogcatSpawner

  private child: LogcatChild | null = null
  private filters: string | null = null
  private exitCode: number | null = null

  constructor(options: LogcatServiceOptions = {}) {
    this.spawner = options.spawn ?? adbLogcat
  }

  subscribe(listener: (line: string) => void): () => void {
    this.lines.add(listener)
    return () => {
      this.lines.delete(listener)
    }
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exits.add(listener)
    return () => {
      this.exits.delete(listener)
    }
  }

  state(): LogcatState {
    return { running: this.child !== null, filters: this.filters, exitCode: this.exitCode }
  }

  start(filters: string): void {
    if (this.child !== null) return
    const child = this.spawner(filters)
    this.child = child
    this.filters = filters
    this.exitCode = null

    child.onLine((line) => {
      for (const listener of this.lines) listener(line)
    })
    child.onExit((code) => {
      if (this.child !== child) return
      this.child = null
      this.exitCode = code
      for (const listener of this.exits) listener(code)
    })
  }

  stop(): void {
    const child = this.child
    if (child === null) return
    this.child = null
    child.kill()
    for (const listener of this.exits) listener(null)
  }

  close(): void {
    this.stop()
  }
}

export const linesFrom = (stream: Readable, emit: (line: string) => void): void => {
  let carry = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    const read = assemble(carry, chunk)
    carry = read.carry
    for (const line of read.lines) emit(line)
  })
}

export const adbLogcat: LogcatSpawner = (filters) => {
  const specs = filters.split(/\s+/).filter((spec) => spec !== '')
  const child = spawn('adb', ['logcat', '-v', 'brief', '-s', ...specs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = child.stdout
  const errors = child.stderr

  const onLines = new Set<(line: string) => void>()
  const onExits = new Set<(code: number | null) => void>()
  let settled = false

  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    for (const listener of onExits) listener(code)
  }

  const emit = (line: string): void => {
    for (const listener of onLines) listener(line)
  }

  linesFrom(out, emit)
  linesFrom(errors, emit)
  child.on('error', () => {
    finish(null)
  })
  child.on('close', (code) => {
    finish(code)
  })

  return {
    kill: () => {
      child.kill()
    },
    onLine: (listener) => {
      onLines.add(listener)
    },
    onExit: (listener) => {
      onExits.add(listener)
    },
  }
}
