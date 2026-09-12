import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { DecisionPersistence, PersistedDecision } from './runtime.ts'

interface DecisionFileV1 {
  version: 1
  decisions: PersistedDecision[]
}

/** Atomic JSON sidecar stored under the configured DSH home. */
export class JsonFileDecisionPersistence implements DecisionPersistence {
  readonly path: string

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('decision persistence path must be absolute')
    this.path = path
  }

  async load(): Promise<readonly PersistedDecision[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`decision persistence file is not valid JSON: ${this.path}`, { cause: error })
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`decision persistence file must contain an object: ${this.path}`)
    }
    const file = parsed as Record<string, unknown>
    if (file.version !== 1) {
      throw new Error(`unsupported decision persistence version ${String(file.version)} at ${this.path}`)
    }
    if (!Array.isArray(file.decisions)) {
      throw new Error(`decision persistence file has no decisions array: ${this.path}`)
    }
    return file.decisions as PersistedDecision[]
  }

  async save(decisions: readonly PersistedDecision[]): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`
    const file: DecisionFileV1 = { version: 1, decisions: decisions.map(decision => structuredClone(decision)) }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temp, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temp, this.path)
    } catch (error) {
      await handle?.close().catch(() => {})
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
}
