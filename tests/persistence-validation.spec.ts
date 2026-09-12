import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonFileDecisionPersistence } from '../src/persistence.ts'
import { DecisionRuntime, type PersistedDecision } from '../src/runtime.ts'

const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

function validDecision(overrides: Partial<PersistedDecision> = {}): PersistedDecision {
  return {
    id: 'decision-valid',
    ownerId: 'owner',
    question: 'Valid?',
    options: [],
    status: 'pending',
    deliveryStatus: 'none',
    createdAt: 1_000,
    revision: 1,
    ...overrides,
  }
}

async function runtimeFromDocument(document: unknown): Promise<DecisionRuntime> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-decision-validation-'))
  temporaryDirectories.add(directory)
  const path = join(directory, 'state.json')
  await writeFile(path, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
  return new DecisionRuntime({ persistence: new JsonFileDecisionPersistence(path) })
}

describe('persistence document validation', () => {
  it.each([
    { name: 'invalid JSON', document: '{', error: /not valid JSON/ },
    { name: 'array root', document: [], error: /must contain an object/ },
    { name: 'missing version', document: { decisions: [] }, error: /unsupported decision persistence version/ },
    { name: 'missing decisions', document: { version: 1 }, error: /no decisions array/ },
    { name: 'duplicate ids', document: { version: 1, decisions: [validDecision(), validDecision()] }, error: /duplicate persisted decision id/ },
  ])('fails loudly for $name', async ({ document, error }) => {
    const runtime = await runtimeFromDocument(document)
    await expect(runtime.initialize()).rejects.toThrow(error)
  })

  it.each([
    {
      name: 'answered without answer',
      decision: validDecision({ status: 'answered', deliveryStatus: 'pending', answeredAt: 2_000 }),
      error: /answered decision .* is incomplete/,
    },
    {
      name: 'answered with delivery none',
      decision: validDecision({ status: 'answered', answer: 'yes', answeredAt: 2_000 }),
      error: /has no delivery state/,
    },
    {
      name: 'delivered without deliveredAt',
      decision: validDecision({ status: 'answered', deliveryStatus: 'delivered', answer: 'yes', answeredAt: 2_000 }),
      error: /inconsistent delivery state/,
    },
    {
      name: 'pending containing an answer',
      decision: validDecision({ answer: 'yes', answeredAt: 2_000 }),
      error: /pending decision .* contains answer delivery state/,
    },
    {
      name: 'cancelled without cancelledAt',
      decision: validDecision({ status: 'cancelled' }),
      error: /cancelled decision .* is incomplete/,
    },
    {
      name: 'expired without expiresAt',
      decision: validDecision({ status: 'expired' }),
      error: /expired decision .* has no expiry/,
    },
    {
      name: 'invalid status',
      decision: validDecision({ status: 'unknown' as PersistedDecision['status'] }),
      error: /invalid status/,
    },
    {
      name: 'zero revision',
      decision: validDecision({ revision: 0 }),
      error: /invalid revision/,
    },
    {
      name: 'untrimmed id',
      decision: validDecision({ id: ' decision-valid ' }),
      error: /id must be trimmed/,
    },
  ])('rejects inconsistent row: $name', async ({ decision, error }) => {
    const runtime = await runtimeFromDocument({ version: 1, decisions: [decision] })
    await expect(runtime.initialize()).rejects.toThrow(error)
  })

  it('expires an overdue pending row during startup and persists the repair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-decision-startup-expiry-'))
    temporaryDirectories.add(directory)
    const path = join(directory, 'state.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      decisions: [validDecision({ expiresAt: 1 })],
    }), 'utf8')
    const runtime = new DecisionRuntime({
      persistence: new JsonFileDecisionPersistence(path),
      now: () => 2,
    })

    await runtime.initialize()

    expect(await runtime.get('owner', 'decision-valid')).toMatchObject({ status: 'expired', revision: 2 })
    const restarted = new DecisionRuntime({ persistence: new JsonFileDecisionPersistence(path), now: () => 3 })
    await restarted.initialize()
    expect(await restarted.get('owner', 'decision-valid')).toMatchObject({ status: 'expired', revision: 2 })
  })
})
