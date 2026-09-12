import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { answerAndDeliver, parseDecisionCommand } from '../src/index.ts'
import { DecisionRuntime } from '../src/runtime.ts'

function fixture() {
  let now = 1_000
  let id = 0
  const runtime = new DecisionRuntime({
    now: () => now,
    idFactory: () => `decision-${++id}`,
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

describe('DecisionRuntime', () => {
  it('creates a pending decision without waiting for an answer', async () => {
    const { runtime } = fixture()
    const decision = await runtime.create({
      ownerId: 'session-1',
      question: 'Which database should we use?',
      options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }],
    })

    expect(decision).toMatchObject({
      id: 'decision-1',
      status: 'pending',
      revision: 1,
      question: 'Which database should we use?',
    })
  })

  it('keeps decisions isolated by owning session', async () => {
    const { runtime } = fixture()
    const decision = await runtime.create({ ownerId: 'session-a', question: 'A?' })

    expect(await runtime.list('session-b')).toEqual([])
    expect(await runtime.answer('session-b', decision.id, 'no')).toEqual({ kind: 'not-found' })
    expect((await runtime.get('session-a', decision.id))?.status).toBe('pending')
  })

  it('expires pending decisions lazily and refuses late answers', async () => {
    const { runtime, advance } = fixture()
    const decision = await runtime.create({ ownerId: 'session-1', question: 'Still needed?', expiresInSeconds: 2 })
    advance(2_000)

    expect(await runtime.answer('session-1', decision.id, 'yes')).toMatchObject({
      kind: 'not-pending',
      decision: { status: 'expired' },
    })
  })

  it('rejects duplicate option labels', async () => {
    const { runtime } = fixture()
    await expect(runtime.create({
      ownerId: 'session-1',
      question: 'Choose',
      options: [{ label: 'A' }, { label: 'A' }],
    })).rejects.toThrow(/duplicate option label/)
  })
})

describe('answer delivery', () => {
  it('steers the answer to the owner exactly once', async () => {
    const { runtime } = fixture()
    const decision = await runtime.create({ ownerId: 'session-1', question: 'Use blue?' })
    const steer = vi.fn()
    const agent = fakeAgent('session-1', steer)

    const first = await answerAndDeliver(runtime, agent, decision.id, 'yes')
    const duplicate = await answerAndDeliver(runtime, agent, decision.id, 'yes')

    expect(first.delivered).toBe(true)
    expect(duplicate).toMatchObject({ answer: { kind: 'already-answered', matchesExisting: true }, delivered: false })
    expect(steer).toHaveBeenCalledTimes(1)
    expect(await runtime.get('session-1', decision.id)).toMatchObject({
      status: 'answered',
      deliveryStatus: 'delivered',
      answer: 'yes',
      deliveredAt: 1_000,
    })
  })

  it('does not overwrite or redeliver a conflicting second answer', async () => {
    const { runtime } = fixture()
    const decision = await runtime.create({ ownerId: 'session-1', question: 'Use blue?' })
    const steer = vi.fn()
    const agent = fakeAgent('session-1', steer)

    await answerAndDeliver(runtime, agent, decision.id, 'yes')
    const conflict = await answerAndDeliver(runtime, agent, decision.id, 'no')

    expect(conflict).toMatchObject({ answer: { kind: 'already-answered', matchesExisting: false }, delivered: false })
    expect(steer).toHaveBeenCalledTimes(1)
    expect((await runtime.get('session-1', decision.id))?.answer).toBe('yes')
  })

  it('releases a failed delivery so the same answer can be retried', async () => {
    const { runtime } = fixture()
    const decision = await runtime.create({ ownerId: 'session-1', question: 'Use blue?' })
    const brokenAgent = fakeAgent('session-1', vi.fn(() => { throw new Error('inbox unavailable') }))

    await expect(answerAndDeliver(runtime, brokenAgent, decision.id, 'yes')).rejects.toThrow('inbox unavailable')
    expect((await runtime.get('session-1', decision.id))?.deliveryStatus).toBe('pending')

    const steer = vi.fn()
    const retry = await answerAndDeliver(runtime, fakeAgent('session-1', steer), decision.id, 'yes')
    expect(retry.delivered).toBe(true)
    expect(steer).toHaveBeenCalledTimes(1)
  })
})

describe('command parser', () => {
  it('defaults to pending list and preserves answer text', () => {
    expect(parseDecisionCommand('')).toEqual({ verb: 'list', status: 'pending' })
    expect(parseDecisionCommand(' answer decision-7   use SQLite for now ')).toEqual({
      verb: 'answer',
      id: 'decision-7',
      value: 'use SQLite for now',
    })
  })

  it('rejects an answer without text', () => {
    expect(() => parseDecisionCommand('answer decision-7')).toThrow(/<answer>/)
  })

  it('parses export with optional path, format, and owner flags', () => {
    expect(parseDecisionCommand('export')).toEqual({ verb: 'export' })
    expect(parseDecisionCommand('export /tmp/audit.json')).toEqual({ verb: 'export', path: '/tmp/audit.json' })
    expect(parseDecisionCommand('export --format ndjson --owner session-1')).toEqual({
      verb: 'export',
      format: 'ndjson',
      owner: 'session-1',
    })
    expect(parseDecisionCommand('export out.csv --format csv')).toEqual({ verb: 'export', path: 'out.csv', format: 'csv' })
  })

  it('rejects malformed export arguments', () => {
    expect(() => parseDecisionCommand('export --format xml')).toThrow(/--format/)
    expect(() => parseDecisionCommand('export --owner')).toThrow(/--owner/)
    expect(() => parseDecisionCommand('export a b')).toThrow(/--format/)
    expect(() => parseDecisionCommand('export --bogus')).toThrow(/--format/)
  })

  it('parses import with path, format, and conflict policy flags', () => {
    expect(parseDecisionCommand('import /tmp/history.json')).toEqual({ verb: 'import', path: '/tmp/history.json' })
    expect(parseDecisionCommand('import /tmp/history.jsonl --format ndjson --on-conflict fail')).toEqual({
      verb: 'import',
      path: '/tmp/history.jsonl',
      format: 'ndjson',
      onConflict: 'fail',
    })
    expect(parseDecisionCommand('import /tmp/history.json --on-conflict skip')).toEqual({
      verb: 'import',
      path: '/tmp/history.json',
      onConflict: 'skip',
    })
  })

  it('rejects malformed import arguments', () => {
    expect(() => parseDecisionCommand('import')).toThrow(/--on-conflict/)
    expect(() => parseDecisionCommand('import --format csv /tmp/h.json')).toThrow(/--format/)
    expect(() => parseDecisionCommand('import /tmp/h.json --on-conflict overwrite')).toThrow(/--on-conflict/)
    expect(() => parseDecisionCommand('import /tmp/a.json /tmp/b.json')).toThrow(/--on-conflict/)
    expect(() => parseDecisionCommand('import /tmp/h.json --bogus')).toThrow(/--on-conflict/)
  })
})
