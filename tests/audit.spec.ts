import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { answerAndDeliver } from '../src/index.ts'
import {
  JsonlAuditLog,
  auditPathFor,
  iterateAuditLog,
  parseAuditEvent,
  readAuditLog,
  type AuditSink,
  type DecisionAuditDraft,
  type DecisionAuditEvent,
  type DecisionLifecycleAuditEvent,
} from '../src/audit.ts'
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

function fakeAgent(id = 'session-1', steer = vi.fn()): Agent {
  return { id, steer } as unknown as Agent
}

const temporaryDirectories = new Set<string>()

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'decision-audit-'))
  temporaryDirectories.add(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

function createdDraft(decisionId: string): DecisionAuditDraft {
  return {
    schema: 'decision-audit-event',
    version: 1,
    ts: 1_000,
    actor: 'agent',
    type: 'created',
    decisionId,
    ownerId: 'session-1',
    revision: 1,
    question: 'Q?',
    options: [],
  }
}

describe('auditPathFor', () => {
  it('derives an .audit.jsonl path next to the state file', () => {
    expect(auditPathFor('/data/decision-inbox.json')).toBe('/data/decision-inbox.audit.jsonl')
  })

  it('appends the suffix when the state file has no .json extension', () => {
    expect(auditPathFor('/data/state')).toBe('/data/state.audit.jsonl')
  })
})

describe('JsonlAuditLog', () => {
  it('appends one JSON event per line and stamps monotonic sequence numbers', async () => {
    const path = await tempFile('audit.jsonl')
    const log = new JsonlAuditLog(path)
    await log.append([createdDraft('d1'), createdDraft('d2')])
    await log.append([createdDraft('d3')])

    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(3)
    const events = lines.map(line => JSON.parse(line) as DecisionAuditEvent)
    expect(events.map(event => event.seq)).toEqual([1, 2, 3])
    expect(events[0]).toMatchObject({ type: 'created', decisionId: 'd1', question: 'Q?' })
  })

  it('continues sequence numbers across writer instances', async () => {
    const path = await tempFile('audit.jsonl')
    await new JsonlAuditLog(path).append([createdDraft('d1')])
    await new JsonlAuditLog(path).append([createdDraft('d2')])

    const { events } = await readAuditLog(path)
    expect(events.map(event => event.seq)).toEqual([1, 2])
  })

  it('recovers the sequence number past corrupt lines', async () => {
    const path = await tempFile('audit.jsonl')
    await writeFile(path, 'garbage\n', 'utf8')
    await new JsonlAuditLog(path).append([createdDraft('d1')])

    const { events, corruptLines } = await readAuditLog(path)
    expect(events.map(event => event.seq)).toEqual([1])
    expect(corruptLines).toBe(1)
  })

  it('requires an absolute path', () => {
    expect(() => new JsonlAuditLog('relative/audit.jsonl')).toThrow(/absolute/)
  })
})

describe('parseAuditEvent', () => {
  const created: DecisionLifecycleAuditEvent = {
    schema: 'decision-audit-event',
    version: 1,
    seq: 1,
    ts: 1_000,
    actor: 'agent',
    type: 'created',
    decisionId: 'd1',
    ownerId: 'session-1',
    revision: 1,
    question: 'Q?',
    options: [{ label: 'yes' }],
  }

  it('round-trips a valid event', () => {
    expect(parseAuditEvent(JSON.stringify(created))).toEqual(created)
  })

  it('rejects non-events and structurally invalid lines', () => {
    expect(parseAuditEvent('')).toBeUndefined()
    expect(parseAuditEvent('not json')).toBeUndefined()
    expect(parseAuditEvent('null')).toBeUndefined()
    expect(parseAuditEvent('[]')).toBeUndefined()
    const cases: Record<string, unknown>[] = [
      { ...created, schema: 'other-schema' },
      { ...created, version: 2 },
      { ...created, seq: 0 },
      { ...created, seq: 1.5 },
      { ...created, ts: -1 },
      { ...created, actor: 'bot' },
      { ...created, type: 'edited' },
      { ...created, decisionId: '' },
      { ...created, ownerId: 42 },
      { ...created, revision: 0 },
      { ...created, question: 42 },
      { ...created, options: 'none' },
      { ...created, options: [{ label: 7 }] },
      { ...created, expiresAt: -5 },
    ]
    for (const record of cases) {
      expect(parseAuditEvent(JSON.stringify(record))).toBeUndefined()
    }
  })

  it('enforces type-specific payload fields', () => {
    expect(parseAuditEvent(JSON.stringify({ ...created, type: 'answered' }))).toBeUndefined()
    expect(parseAuditEvent(JSON.stringify({ ...created, type: 'cancelled', cancelReason: 7 }))).toBeUndefined()
    const answered = { ...created, type: 'answered', answer: 'yes' }
    expect(parseAuditEvent(JSON.stringify(answered))).toMatchObject({ type: 'answered', answer: 'yes' })
  })

  it('validates checkpoint and aborted events', () => {
    const checkpoint = {
      schema: 'decision-audit-event',
      version: 1,
      seq: 1,
      ts: 0,
      actor: 'system',
      type: 'checkpoint',
      decisions: 1,
      pending: 1,
      answered: 0,
      cancelled: 0,
      expired: 0,
    }
    expect(parseAuditEvent(JSON.stringify(checkpoint))).toMatchObject({ type: 'checkpoint' })
    expect(parseAuditEvent(JSON.stringify({ ...checkpoint, decisions: -1 }))).toBeUndefined()
    expect(parseAuditEvent(JSON.stringify({ ...checkpoint, pending: 'many' }))).toBeUndefined()

    const aborted = {
      schema: 'decision-audit-event',
      version: 1,
      seq: 1,
      ts: 0,
      actor: 'system',
      type: 'aborted',
      operation: 'create',
      reason: 'disk full',
      decisionIds: ['d1'],
    }
    expect(parseAuditEvent(JSON.stringify(aborted))).toMatchObject({ type: 'aborted', operation: 'create' })
    expect(parseAuditEvent(JSON.stringify({ ...aborted, operation: '' }))).toBeUndefined()
    expect(parseAuditEvent(JSON.stringify({ ...aborted, decisionIds: [1] }))).toBeUndefined()
  })

  it('validates imported events', () => {
    const imported = {
      schema: 'decision-audit-event',
      version: 1,
      seq: 1,
      ts: 5_000,
      actor: 'user',
      type: 'imported',
      decisionId: 'd9',
      ownerId: 'session-old',
      revision: 2,
      status: 'answered',
      deliveryStatus: 'delivered',
      question: 'Old question?',
      options: [{ label: 'yes' }],
      answer: 'yes',
    }
    expect(parseAuditEvent(JSON.stringify(imported))).toMatchObject({ type: 'imported', status: 'answered' })
    const cases: Record<string, unknown>[] = [
      { ...imported, status: 'unknown' },
      { ...imported, deliveryStatus: 'lost' },
      { ...imported, question: 42 },
      { ...imported, options: [{ label: '' }] },
      { ...imported, answer: 7 },
      { ...imported, revision: 0 },
    ]
    for (const record of cases) {
      expect(parseAuditEvent(JSON.stringify(record))).toBeUndefined()
    }
  })
})

describe('readAuditLog and iterateAuditLog', () => {
  it('reads a missing file as an empty log', async () => {
    const path = await tempFile('missing.jsonl')
    expect(await readAuditLog(path)).toEqual({ events: [], corruptLines: 0 })
    const seen: DecisionAuditEvent[] = []
    for await (const event of iterateAuditLog(path)) seen.push(event)
    expect(seen).toEqual([])
  })

  it('skips and counts corrupt lines', async () => {
    const path = await tempFile('audit.jsonl')
    const log = new JsonlAuditLog(path)
    await log.append([createdDraft('d1')])
    await appendFile(path, 'not json\n', 'utf8')
    await appendFile(path, `${JSON.stringify(createdDraft('d2'))} trailing junk\n`, 'utf8')
    await log.append([createdDraft('d3')])

    const { events, corruptLines } = await readAuditLog(path)
    expect(events.map(event => event.seq)).toEqual([1, 2])
    expect(corruptLines).toBe(2)
  })

  it('filters by owner, type, time range, and sequence', async () => {
    const path = await tempFile('audit.jsonl')
    await writeFile(path, [
      JSON.stringify({ ...createdDraft('d1'), seq: 1, ownerId: 's1', ts: 1_000 }),
      JSON.stringify({ ...createdDraft('d2'), seq: 2, ownerId: 's1', ts: 2_000 }),
      JSON.stringify({ ...createdDraft('d3'), seq: 3, ownerId: 's2', ts: 3_000 }),
      JSON.stringify({
        schema: 'decision-audit-event',
        version: 1,
        seq: 4,
        ts: 4_000,
        actor: 'system',
        type: 'checkpoint',
        decisions: 1,
        pending: 0,
        answered: 0,
        cancelled: 0,
        expired: 1,
      }),
    ].map(line => `${line}\n`).join(''), 'utf8')

    expect((await readAuditLog(path, { ownerId: 's1' })).events.map(event => event.seq)).toEqual([1, 2])
    expect((await readAuditLog(path, { types: ['checkpoint'] })).events.map(event => event.seq)).toEqual([4])
    expect((await readAuditLog(path, { sinceTs: 2_000, untilTs: 3_000 })).events.map(event => event.seq)).toEqual([2, 3])
    expect((await readAuditLog(path, { afterSeq: 2 })).events.map(event => event.seq)).toEqual([3, 4])
  })

  it('streams events one at a time', async () => {
    const path = await tempFile('audit.jsonl')
    await writeFile(path, `${JSON.stringify({ ...createdDraft('d1'), seq: 1 })}\n`, 'utf8')
    const seen: DecisionAuditEvent[] = []
    for await (const event of iterateAuditLog(path, { afterSeq: 0 })) seen.push(event)
    expect(seen.map(event => event.seq)).toEqual([1])
  })
})

describe('DecisionRuntime audit integration', () => {
  it('emits lifecycle events with actor attribution', async () => {
    const path = await tempFile('audit.jsonl')
    let now = 1_000
    let id = 0
    const runtime = new DecisionRuntime({
      audit: new JsonlAuditLog(path),
      now: () => now,
      idFactory: () => `decision-${++id}`,
    })

    await runtime.create({ ownerId: 'session-1', question: 'A?', options: [{ label: 'yes' }] }, { actor: 'agent' })
    await runtime.cancel('session-1', 'decision-1', 'obsolete', { actor: 'user' })
    await runtime.create({ ownerId: 'session-1', question: 'B?', expiresInSeconds: 10 }, { actor: 'agent' })
    await answerAndDeliver(runtime, fakeAgent('session-1'), 'decision-2', 'ok')
    await runtime.create({ ownerId: 'session-2', question: 'C?', expiresInSeconds: 10 }, { actor: 'agent' })
    now += 10_000
    await runtime.list('session-2')

    const { events, corruptLines } = await readAuditLog(path)
    expect(corruptLines).toBe(0)
    expect(events.map(event => event.type)).toEqual([
      'created', 'cancelled', 'created', 'answered', 'delivered', 'created', 'expired',
    ])
    expect(events.map(event => event.actor)).toEqual([
      'agent', 'user', 'agent', 'user', 'system', 'agent', 'system',
    ])
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(events[0]).toMatchObject({
      type: 'created',
      decisionId: 'decision-1',
      question: 'A?',
      options: [{ label: 'yes' }],
      revision: 1,
    })
    expect(events[1]).toMatchObject({ type: 'cancelled', decisionId: 'decision-1', cancelReason: 'obsolete', revision: 2 })
    expect(events[3]).toMatchObject({ type: 'answered', decisionId: 'decision-2', answer: 'ok', revision: 2 })
    expect(events[4]).toMatchObject({ type: 'delivered', decisionId: 'decision-2', revision: 3 })
    expect(events[6]).toMatchObject({ type: 'expired', decisionId: 'decision-3', ownerId: 'session-2' })
  })

  it('writes a startup checkpoint after loading persisted state', async () => {
    const persistence = new MemoryPersistence()
    const path = await tempFile('audit.jsonl')

    const first = new DecisionRuntime({ persistence, audit: new JsonlAuditLog(path) })
    await first.initialize()
    await first.create({ ownerId: 'owner', question: 'Q?' }, { actor: 'agent' })

    const second = new DecisionRuntime({ persistence, audit: new JsonlAuditLog(path) })
    await second.initialize()

    const { events } = await readAuditLog(path)
    expect(events.map(event => event.type)).toEqual(['checkpoint', 'created', 'checkpoint'])
    expect(events.map(event => event.seq)).toEqual([1, 2, 3])
    expect(events[0]).toMatchObject({ decisions: 0, pending: 0, answered: 0, cancelled: 0, expired: 0 })
    expect(events[2]).toMatchObject({ decisions: 1, pending: 1, answered: 0, cancelled: 0, expired: 0 })
  })

  it('appends an aborted event when the state save fails', async () => {
    class FailingPersistence implements DecisionPersistence {
      async load(): Promise<readonly PersistedDecision[]> {
        return []
      }

      async save(): Promise<void> {
        throw new Error('disk full')
      }
    }
    const path = await tempFile('audit.jsonl')
    const runtime = new DecisionRuntime({
      persistence: new FailingPersistence(),
      audit: new JsonlAuditLog(path),
      idFactory: () => 'decision-x',
    })
    await runtime.initialize()

    await expect(runtime.create({ ownerId: 'owner', question: 'Q?' }, { actor: 'agent' }))
      .rejects.toThrow('disk full')

    const { events } = await readAuditLog(path)
    expect(events.map(event => event.type)).toEqual(['checkpoint', 'created', 'aborted'])
    expect(events[2]).toMatchObject({
      type: 'aborted',
      operation: 'create',
      actor: 'agent',
      reason: 'disk full',
      decisionIds: ['decision-x'],
    })
  })

  it('defaults the actor to system when no context is provided', async () => {
    const path = await tempFile('audit.jsonl')
    const runtime = new DecisionRuntime({ audit: new JsonlAuditLog(path) })
    await runtime.create({ ownerId: 'owner', question: 'Q?' })
    const { events } = await readAuditLog(path)
    expect(events[0]).toMatchObject({ type: 'created', actor: 'system' })
  })

  it('passes created drafts to the configured sink', async () => {
    const sink: AuditSink = { append: async () => {} }
    const spy = vi.spyOn(sink, 'append')
    const runtime = new DecisionRuntime({
      audit: sink,
      now: () => 500,
      idFactory: () => 'decision-spy',
    })
    await runtime.create({ ownerId: 'owner', question: 'Spy?', options: [{ label: 'yes' }] })

    expect(spy).toHaveBeenCalledTimes(1)
    const drafts = spy.mock.calls[0]![0]
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      type: 'created',
      decisionId: 'decision-spy',
      ownerId: 'owner',
      question: 'Spy?',
      options: [{ label: 'yes' }],
      ts: 500,
      actor: 'system',
    })
  })
})
