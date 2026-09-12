import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { answerAndDeliver } from '../src/index.ts'
import { JsonFileDecisionPersistence } from '../src/persistence.ts'
import {
  DecisionRuntime,
  type DecisionPersistence,
  type PersistedDecision,
} from '../src/runtime.ts'

class MemoryPersistence implements DecisionPersistence {
  decisions: PersistedDecision[] = []

  async load(): Promise<readonly PersistedDecision[]> {
    return structuredClone(this.decisions)
  }

  async save(decisions: readonly PersistedDecision[]): Promise<void> {
    this.decisions = structuredClone([...decisions])
  }
}

function fakeAgent(id: string, steer = vi.fn()): Agent {
  return { id, steer } as unknown as Agent
}

const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

describe('restart recovery', () => {
  it('restores a pending decision in its original session', async () => {
    const persistence = new MemoryPersistence()
    const before = new DecisionRuntime({ persistence, idFactory: () => 'decision-restart' })
    await before.initialize()
    await before.create({ ownerId: 'owner', question: 'Full or incremental?' })

    const after = new DecisionRuntime({ persistence })
    await after.initialize()

    expect(await after.get('owner', 'decision-restart')).toMatchObject({
      status: 'pending',
      deliveryStatus: 'none',
      question: 'Full or incremental?',
    })
    expect(await after.get('other-owner', 'decision-restart')).toBeUndefined()
  })

  it('retries an answered but undelivered outbox item after restart', async () => {
    const persistence = new MemoryPersistence()
    const before = new DecisionRuntime({ persistence, idFactory: () => 'decision-outbox' })
    await before.initialize()
    await before.create({ ownerId: 'owner', question: 'Use staging?' })
    await before.answer('owner', 'decision-outbox', 'yes')

    const after = new DecisionRuntime({ persistence })
    await after.initialize()
    const steer = vi.fn()
    const result = await answerAndDeliver(after, fakeAgent('owner', steer), 'decision-outbox', 'yes')

    expect(result).toMatchObject({ answer: { kind: 'already-answered', matchesExisting: true }, delivered: true })
    expect(steer).toHaveBeenCalledTimes(1)
    expect(await after.get('owner', 'decision-outbox')).toMatchObject({
      deliveryStatus: 'delivered',
      deliveredAt: expect.any(Number),
    })
  })

  it('does not redeliver a completed outbox item after restart', async () => {
    const persistence = new MemoryPersistence()
    const before = new DecisionRuntime({ persistence, idFactory: () => 'decision-delivered' })
    await before.initialize()
    await before.create({ ownerId: 'owner', question: 'Use staging?' })
    await answerAndDeliver(before, fakeAgent('owner'), 'decision-delivered', 'yes')

    const after = new DecisionRuntime({ persistence })
    await after.initialize()
    const steer = vi.fn()
    const result = await answerAndDeliver(after, fakeAgent('owner', steer), 'decision-delivered', 'yes')

    expect(result).toMatchObject({ answer: { kind: 'already-answered', matchesExisting: true }, delivered: false })
    expect(steer).not.toHaveBeenCalled()
  })
})

describe('JsonFileDecisionPersistence', () => {
  it('atomically round-trips a runtime snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-decision-inbox-'))
    temporaryDirectories.add(directory)
    const path = join(directory, 'state.json')
    const persistence = new JsonFileDecisionPersistence(path)
    const before = new DecisionRuntime({ persistence, idFactory: () => 'decision-file' })
    await before.initialize()
    await before.create({
      ownerId: 'owner',
      question: 'JSON or YAML?',
      options: [{ label: 'JSON' }, { label: 'YAML', description: 'Human-readable' }],
    })

    const document = JSON.parse(await readFile(path, 'utf8')) as { version: number; decisions: unknown[] }
    expect(document).toMatchObject({ version: 1, decisions: [expect.objectContaining({ id: 'decision-file' })] })

    const after = new DecisionRuntime({ persistence })
    await after.initialize()
    expect(await after.list('owner')).toHaveLength(1)
  })

  it('fails loud on an unknown file version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-decision-inbox-'))
    temporaryDirectories.add(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, '{"version":2,"decisions":[]}\n', 'utf8')

    const runtime = new DecisionRuntime({ persistence: new JsonFileDecisionPersistence(path) })
    await expect(runtime.initialize()).rejects.toThrow(/unsupported decision persistence version 2/)
  })
})
