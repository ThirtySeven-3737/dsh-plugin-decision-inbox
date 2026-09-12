import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { answerAndDeliver } from '../src/index.ts'
import {
  DecisionRuntime,
  type DecisionPersistence,
  type PersistedDecision,
} from '../src/runtime.ts'

class ControlledPersistence implements DecisionPersistence {
  decisions: PersistedDecision[] = []
  loadCalls = 0
  saveCalls = 0
  failNextSave = false
  failOnSaveCall?: number

  async load(): Promise<readonly PersistedDecision[]> {
    this.loadCalls += 1
    return structuredClone(this.decisions)
  }

  async save(decisions: readonly PersistedDecision[]): Promise<void> {
    this.saveCalls += 1
    if (this.failNextSave || this.saveCalls === this.failOnSaveCall) {
      this.failNextSave = false
      throw new Error('simulated disk failure')
    }
    this.decisions = structuredClone([...decisions])
  }
}

function fakeAgent(id: string, steer = vi.fn()): Agent {
  return { id, steer } as unknown as Agent
}

describe('concurrency and race hardening', () => {
  it('serializes a burst of concurrent creates without losing rows or duplicating ids', async () => {
    const persistence = new ControlledPersistence()
    let sequence = 0
    const runtime = new DecisionRuntime({
      persistence,
      now: () => 10_000,
      idFactory: () => `decision-load-${++sequence}`,
    })
    await runtime.initialize()

    const created = await Promise.all(Array.from({ length: 100 }, (_, index) => runtime.create({
      ownerId: `owner-${index % 5}`,
      question: `Question ${index}?`,
    })))

    expect(new Set(created.map(item => item.id))).toHaveLength(100)
    expect(persistence.decisions).toHaveLength(100)
    await Promise.all(Array.from({ length: 5 }, async (_, owner) => {
      expect(await runtime.list(`owner-${owner}`)).toHaveLength(20)
    }))
  })

  it('delivers only once when many identical answers arrive concurrently', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-answer-race' })
    const decision = await runtime.create({ ownerId: 'owner', question: 'Proceed?' })
    const steer = vi.fn()

    const results = await Promise.all(Array.from({ length: 50 }, () => (
      answerAndDeliver(runtime, fakeAgent('owner', steer), decision.id, 'yes')
    )))

    expect(results.filter(result => result.delivered)).toHaveLength(1)
    expect(steer).toHaveBeenCalledTimes(1)
    expect(await runtime.get('owner', decision.id)).toMatchObject({
      status: 'answered',
      answer: 'yes',
      deliveryStatus: 'delivered',
    })
  })

  it('allows exactly one terminal transition in an answer-versus-cancel race', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-terminal-race' })
    const decision = await runtime.create({ ownerId: 'owner', question: 'Proceed?' })

    const [answer, cancel] = await Promise.all([
      runtime.answer('owner', decision.id, 'yes'),
      runtime.cancel('owner', decision.id, 'too late'),
    ])

    expect(answer.kind).toBe('answered')
    expect(cancel.kind).toBe('not-pending')
    expect(await runtime.get('owner', decision.id)).toMatchObject({
      status: 'answered',
      answer: 'yes',
      revision: 2,
    })
  })

  it('keeps the first of conflicting concurrent answers and steers it once', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-conflict-race' })
    const decision = await runtime.create({ ownerId: 'owner', question: 'Blue or green?' })
    const steer = vi.fn()

    const [blue, green] = await Promise.all([
      answerAndDeliver(runtime, fakeAgent('owner', steer), decision.id, 'blue'),
      answerAndDeliver(runtime, fakeAgent('owner', steer), decision.id, 'green'),
    ])

    expect(blue).toMatchObject({ answer: { kind: 'answered' }, delivered: true })
    expect(green).toMatchObject({ answer: { kind: 'already-answered', matchesExisting: false }, delivered: false })
    expect(steer).toHaveBeenCalledTimes(1)
    expect((await runtime.get('owner', decision.id))?.answer).toBe('blue')
  })
})

describe('durability failure semantics', () => {
  it('does not publish a create whose durable save failed', async () => {
    const persistence = new ControlledPersistence()
    const runtime = new DecisionRuntime({ persistence, idFactory: () => 'decision-save-failure' })
    await runtime.initialize()
    persistence.failNextSave = true

    await expect(runtime.create({ ownerId: 'owner', question: 'Persist me?' }))
      .rejects.toThrow('simulated disk failure')
    expect(await runtime.list('owner')).toEqual([])
    expect(persistence.decisions).toEqual([])
  })

  it('does not publish an answer whose durable save failed', async () => {
    const persistence = new ControlledPersistence()
    const runtime = new DecisionRuntime({ persistence, idFactory: () => 'decision-answer-save-failure' })
    await runtime.initialize()
    const decision = await runtime.create({ ownerId: 'owner', question: 'Persist answer?' })
    persistence.failNextSave = true

    await expect(runtime.answer('owner', decision.id, 'yes')).rejects.toThrow('simulated disk failure')
    expect(await runtime.get('owner', decision.id)).toMatchObject({
      status: 'pending',
      deliveryStatus: 'none',
      revision: 1,
    })
  })

  it('retries after delivery acknowledgement persistence fails and exposes the idempotency key', async () => {
    const persistence = new ControlledPersistence()
    const runtime = new DecisionRuntime({ persistence, idFactory: () => 'decision-ack-failure' })
    await runtime.initialize()
    const decision = await runtime.create({ ownerId: 'owner', question: 'Deploy?' })
    const steer = vi.fn()
    persistence.failOnSaveCall = persistence.saveCalls + 2

    await expect(answerAndDeliver(runtime, fakeAgent('owner', steer), decision.id, 'staging'))
      .rejects.toThrow('simulated disk failure')
    expect(await runtime.get('owner', decision.id)).toMatchObject({
      status: 'answered',
      deliveryStatus: 'pending',
      answer: 'staging',
    })

    const retried = await answerAndDeliver(runtime, fakeAgent('owner', steer), decision.id, 'staging')
    expect(retried.delivered).toBe(true)
    expect(steer).toHaveBeenCalledTimes(2)
    for (const call of steer.mock.calls) {
      const text = (call[0] as { content: Array<{ text: string }> }).content[0]?.text
      expect(text).toContain(`decision_id: ${decision.id}`)
      expect(text).toContain('idempotency key')
    }
  })

  it('loads durable state only once under concurrent initialization', async () => {
    const persistence = new ControlledPersistence()
    const runtime = new DecisionRuntime({ persistence })

    await Promise.all(Array.from({ length: 20 }, () => runtime.initialize()))

    expect(persistence.loadCalls).toBe(1)
  })

  it('rejects operations before a persistent runtime is initialized', async () => {
    const runtime = new DecisionRuntime({ persistence: new ControlledPersistence() })
    await expect(runtime.list('owner')).rejects.toThrow('not initialized')
  })
})

describe('lifecycle and input boundaries', () => {
  it('expires exactly at the deadline and persists one terminal transition', async () => {
    let now = 5_000
    const persistence = new ControlledPersistence()
    const runtime = new DecisionRuntime({ persistence, now: () => now, idFactory: () => 'decision-expiry-edge' })
    await runtime.initialize()
    const decision = await runtime.create({ ownerId: 'owner', question: 'Still valid?', expiresInSeconds: 1 })
    now = 6_000

    expect(await runtime.get('owner', decision.id)).toMatchObject({ status: 'expired', revision: 2 })
    expect(await runtime.get('owner', decision.id)).toMatchObject({ status: 'expired', revision: 2 })
  })

  it('round-trips Unicode, multiline answers, options, and cancellation reasons', async () => {
    const persistence = new ControlledPersistence()
    const before = new DecisionRuntime({
      persistence,
      idFactory: (() => {
        let id = 0
        return () => `decision-unicode-${++id}`
      })(),
    })
    await before.initialize()
    const answered = await before.create({
      ownerId: '会话-甲',
      question: '选择发布策略？🚀',
      options: [{ label: '渐进式', description: '先发布 10%' }, { label: '全量' }],
    })
    const cancelled = await before.create({ ownerId: '会话-甲', question: '旧问题？' })
    await before.answer('会话-甲', answered.id, '第一行\n第二行：保留 emoji ✅')
    await before.cancel('会话-甲', cancelled.id, '需求已变更')

    const after = new DecisionRuntime({ persistence })
    await after.initialize()
    expect(await after.get('会话-甲', answered.id)).toMatchObject({
      answer: '第一行\n第二行：保留 emoji ✅',
      options: [{ label: '渐进式', description: '先发布 10%' }, { label: '全量' }],
    })
    expect(await after.get('会话-甲', cancelled.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: '需求已变更',
    })
  })

  it.each([
    { name: 'empty owner', input: { ownerId: '  ', question: 'Q?' }, error: /ownerId must not be empty/ },
    { name: 'empty question', input: { ownerId: 'owner', question: '\n' }, error: /question must not be empty/ },
    { name: 'zero expiry', input: { ownerId: 'owner', question: 'Q?', expiresInSeconds: 0 }, error: /1 to 2592000/ },
    { name: 'fractional expiry', input: { ownerId: 'owner', question: 'Q?', expiresInSeconds: 1.5 }, error: /whole number/ },
    { name: 'too many options', input: { ownerId: 'owner', question: 'Q?', options: Array.from({ length: 13 }, (_, i) => ({ label: String(i) })) }, error: /at most 12/ },
  ])('rejects invalid create input: $name', async ({ input, error }) => {
    const runtime = new DecisionRuntime()
    await expect(runtime.create(input)).rejects.toThrow(error)
  })

  it('defensively clones option input and returned snapshots', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-clone' })
    const options = [{ label: 'A', description: 'original' }]
    const created = await runtime.create({ ownerId: 'owner', question: 'Choose?', options })
    options[0]!.label = 'mutated-input'
    created.options[0]!.description = 'mutated-output'

    expect(await runtime.get('owner', created.id)).toMatchObject({
      options: [{ label: 'A', description: 'original' }],
    })
  })
})
