import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DecisionRuntime } from '../src/runtime.ts'
import {
  DECISION_ANSWER_SCHEMA,
  DECISION_ANSWER_VERSION,
  DECISION_CANCEL_SCHEMA,
  DECISION_CANCEL_VERSION,
  DECISION_SYNC_SCHEMA,
  DECISION_SYNC_VERSION,
  applyRemoteAnswer,
  applyRemoteCancel,
  buildSyncSnapshot,
  parseRemoteAnswer,
  parseRemoteCancel,
} from '../src/sync.ts'

function fixture() {
  let now = 1_000
  let id = 0
  const runtime = new DecisionRuntime({
    now: () => now,
    idFactory: () => `decision-sync-${++id}`,
  })
  return {
    runtime,
    advance(milliseconds: number) {
      now += milliseconds
    },
  }
}

function fakeAgent(id = 'session-1', steer = vi.fn()): Agent {
  return { id, steer } as unknown as Agent
}

describe('remote sync snapshot', () => {
  it('pulls pending and undelivered decisions across owners as persisted records', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'A?', options: [{ label: 'yes' }] })
    await runtime.create({ ownerId: 'session-b', question: 'B?' })
    await runtime.create({ ownerId: 'session-c', question: 'C?' })
    // Answered, but delivery never completed: stays actionable in the outbox.
    await runtime.answer('session-a', 'decision-sync-1', 'sure')
    // Answered and delivered in-process: no longer actionable.
    const steer = vi.fn()
    const resolve = (ownerId: string) => ownerId === 'session-b' ? fakeAgent('session-b', steer) : undefined
    const result = await applyRemoteAnswer(runtime, resolve, 'decision-sync-2', 'yes')
    expect(result).toMatchObject({ kind: 'answered', delivered: true })

    const snapshot = await buildSyncSnapshot(runtime, () => 42)

    expect(snapshot).toEqual({
      schema: DECISION_SYNC_SCHEMA,
      version: DECISION_SYNC_VERSION,
      exportedAt: 42,
      decisions: [
        expect.objectContaining({ id: 'decision-sync-1', ownerId: 'session-a', status: 'answered', deliveryStatus: 'pending' }),
        expect.objectContaining({ id: 'decision-sync-3', ownerId: 'session-c', status: 'pending', deliveryStatus: 'none' }),
      ],
    })
  })

  it('keeps answered-outbox decisions in the snapshot for retry and drops the rest', async () => {
    const { runtime, advance } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Retry me' })
    await runtime.answer('session-a', 'decision-sync-1', 'yes')
    await runtime.create({ ownerId: 'session-a', question: 'Cancel me' })
    await runtime.cancel('session-a', 'decision-sync-2')
    await runtime.create({ ownerId: 'session-a', question: 'Expire me', expiresInSeconds: 1 })

    advance(1_500)

    const snapshot = await buildSyncSnapshot(runtime)
    expect(snapshot.decisions.map(decision => decision.id)).toEqual(['decision-sync-1'])
    expect(snapshot.decisions[0]).toMatchObject({ status: 'answered', deliveryStatus: 'pending' })
  })

  it('expires past-due pending decisions before snapshotting', async () => {
    const { runtime, advance } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Soon', expiresInSeconds: 1 })
    advance(2_000)

    const snapshot = await buildSyncSnapshot(runtime)

    expect(snapshot.decisions).toEqual([])
    expect(await runtime.findById('decision-sync-1')).toMatchObject({ status: 'expired' })
  })

  it('returns defensive clones that do not alias runtime state', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Clone?', options: [{ label: 'yes' }] })
    const snapshot = await buildSyncSnapshot(runtime)

    snapshot.decisions[0]!.options = []
    snapshot.decisions[0]!.question = 'mutated'

    expect(await runtime.findById('decision-sync-1')).toMatchObject({
      question: 'Clone?',
      options: [{ label: 'yes' }],
    })
  })
})

describe('remote submission parsing', () => {
  it('parses a valid answer submission', () => {
    expect(parseRemoteAnswer({
      schema: DECISION_ANSWER_SCHEMA,
      version: DECISION_ANSWER_VERSION,
      id: 'decision-1',
      answer: 'SQLite',
    })).toEqual({ id: 'decision-1', answer: 'SQLite' })
  })

  it('rejects malformed answer submissions', () => {
    const valid = { schema: DECISION_ANSWER_SCHEMA, version: DECISION_ANSWER_VERSION, id: 'decision-1', answer: 'yes' }
    expect(() => parseRemoteAnswer(null)).toThrow(/must be a decision-inbox-answer document/)
    expect(() => parseRemoteAnswer({ ...valid, schema: 'decision-inbox-import' })).toThrow(/unexpected schema/)
    expect(() => parseRemoteAnswer({ ...valid, version: 2 })).toThrow(/unsupported version/)
    expect(() => parseRemoteAnswer({ ...valid, id: '  ' })).toThrow(/id must not be empty/)
    expect(() => parseRemoteAnswer({ ...valid, id: 'x'.repeat(513) })).toThrow(/id must be at most 512/)
    expect(() => parseRemoteAnswer({ ...valid, answer: 7 })).toThrow(/answer must be a string/)
    expect(() => parseRemoteAnswer({ ...valid, answer: ' ' })).toThrow(/answer must not be empty/)
  })

  it('parses cancellations with and without a reason', () => {
    const base = { schema: DECISION_CANCEL_SCHEMA, version: DECISION_CANCEL_VERSION, id: 'decision-1' }
    expect(parseRemoteCancel(base)).toEqual({ id: 'decision-1' })
    expect(parseRemoteCancel({ ...base, reason: 'obsolete' })).toEqual({ id: 'decision-1', reason: 'obsolete' })
  })

  it('rejects malformed cancellation submissions', () => {
    const valid = { schema: DECISION_CANCEL_SCHEMA, version: DECISION_CANCEL_VERSION, id: 'decision-1' }
    expect(() => parseRemoteCancel([])).toThrow(/must be a decision-inbox-cancel document/)
    expect(() => parseRemoteCancel({ ...valid, schema: 'decision-inbox-answer' })).toThrow(/unexpected schema/)
    expect(() => parseRemoteCancel({ ...valid, id: 3 })).toThrow(/id must be a string/)
    expect(() => parseRemoteCancel({ ...valid, reason: 'x'.repeat(1_001) })).toThrow(/reason must be a string of at most 1000/)
  })
})

describe('remote answer application', () => {
  it('answers by decision id alone and steers the owning agent exactly once', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Format?' })
    const steer = vi.fn()
    const resolve = (ownerId: string) => ownerId === 'session-a' ? fakeAgent('session-a', steer) : undefined

    const first = await applyRemoteAnswer(runtime, resolve, 'decision-sync-1', 'JSON')
    const duplicate = await applyRemoteAnswer(runtime, resolve, 'decision-sync-1', 'JSON')

    expect(first).toMatchObject({ kind: 'answered', delivered: true })
    expect(duplicate).toMatchObject({ kind: 'already-answered', matchesExisting: true, delivered: false })
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('commits durably and leaves the outbox when the owning agent is offline', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-gone', question: 'While away?' })

    const result = await applyRemoteAnswer(runtime, () => undefined, 'decision-sync-1', 'later')

    expect(result).toMatchObject({ kind: 'answered', delivered: false })
    expect(await runtime.findById('decision-sync-1')).toMatchObject({
      status: 'answered',
      deliveryStatus: 'pending',
      answer: 'later',
    })
  })

  it('retries an outbox delivery when the same answer is resubmitted to a live agent', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Retry?' })
    await applyRemoteAnswer(runtime, () => undefined, 'decision-sync-1', 'now')
    const steer = vi.fn()

    const retry = await applyRemoteAnswer(runtime, () => fakeAgent('session-a', steer), 'decision-sync-1', 'now')

    expect(retry).toMatchObject({ kind: 'already-answered', matchesExisting: true, delivered: true })
    expect(steer).toHaveBeenCalledTimes(1)
    expect(await runtime.findById('decision-sync-1')).toMatchObject({ deliveryStatus: 'delivered' })
  })

  it('refuses answers to unknown, cancelled, or differently-answered decisions', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Cancelled?' })
    await runtime.cancel('session-a', 'decision-sync-1')
    await runtime.create({ ownerId: 'session-a', question: 'Answered?' })
    await runtime.answer('session-a', 'decision-sync-2', 'first')

    expect(await applyRemoteAnswer(runtime, () => undefined, 'decision-sync-404', 'no'))
      .toEqual({ kind: 'not-found', delivered: false })
    expect(await applyRemoteAnswer(runtime, () => undefined, 'decision-sync-1', 'no'))
      .toMatchObject({ kind: 'not-pending' })
    expect(await applyRemoteAnswer(runtime, () => undefined, 'decision-sync-2', 'different'))
      .toMatchObject({ kind: 'already-answered', matchesExisting: false, delivered: false })
  })
})

describe('remote cancellation application', () => {
  it('cancels by decision id alone across owners', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-b', question: 'Keep?' })

    const result = await applyRemoteCancel(runtime, 'decision-sync-1', 'no longer needed')

    expect(result).toMatchObject({ kind: 'cancelled', decision: { status: 'cancelled', cancelReason: 'no longer needed' } })
  })

  it('reports not-found and not-pending states', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Done?' })
    await runtime.answer('session-a', 'decision-sync-1', 'yes')

    expect(await applyRemoteCancel(runtime, 'decision-sync-404')).toEqual({ kind: 'not-found' })
    expect(await applyRemoteCancel(runtime, 'decision-sync-1')).toMatchObject({ kind: 'not-pending' })
  })
})

describe('cross-owner runtime queries', () => {
  it('lists all decisions across owners in persisted order and filters by status', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'A?' })
    await runtime.create({ ownerId: 'session-b', question: 'B?' })
    await runtime.answer('session-a', 'decision-sync-1', 'yes')

    expect((await runtime.listAll()).map(decision => decision.id)).toEqual(['decision-sync-1', 'decision-sync-2'])
    expect((await runtime.listAll('pending')).map(decision => decision.id)).toEqual(['decision-sync-2'])
    expect(await runtime.listAll('pending')).toEqual([
      expect.objectContaining({ ownerId: 'session-b', status: 'pending' }),
    ])
  })

  it('finds decisions by id alone regardless of owner', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-b', question: 'Found?' })

    expect(await runtime.findById('decision-sync-1')).toMatchObject({ ownerId: 'session-b', question: 'Found?' })
    expect(await runtime.findById('decision-sync-404')).toBeUndefined()
  })
})
