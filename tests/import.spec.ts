import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlAuditLog, parseAuditEvent, type DecisionImportedAuditEvent } from '../src/audit.ts'
import {
  DECISION_IMPORT_SCHEMA,
  DECISION_IMPORT_VERSION,
  importDecisionRecords,
  inferImportFormat,
  parseDecisionImport,
  type DecisionImportFormat,
} from '../src/import.ts'
import {
  DecisionRuntime,
  type DecisionPersistence,
  type PersistedDecision,
} from '../src/runtime.ts'

const temporaryDirectories = new Set<string>()

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(dir)
  return dir
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

const pendingRecord: PersistedDecision = {
  id: 'decision-old-1',
  ownerId: 'session-old',
  question: 'Blue or green?',
  options: [{ label: 'blue' }, { label: 'green', description: 'calm' }],
  status: 'pending',
  deliveryStatus: 'none',
  createdAt: 1_000,
  revision: 1,
}

const answeredRecord: PersistedDecision = {
  id: 'decision-old-2',
  ownerId: 'session-old',
  question: 'Deploy now?',
  options: [],
  status: 'answered',
  deliveryStatus: 'delivered',
  createdAt: 2_000,
  answeredAt: 2_500,
  answer: 'yes',
  deliveredAt: 2_600,
  revision: 2,
}

const cancelledRecord: PersistedDecision = {
  id: 'decision-old-3',
  ownerId: 'session-old',
  question: 'Keep the spike?',
  options: [],
  status: 'cancelled',
  deliveryStatus: 'none',
  createdAt: 3_000,
  cancelledAt: 3_100,
  cancelReason: 'obsolete',
  revision: 2,
}

class MemoryPersistence implements DecisionPersistence {
  records: PersistedDecision[] = []
  failNextSave = false

  async load(): Promise<readonly PersistedDecision[]> {
    return structuredClone(this.records)
  }

  async save(records: readonly PersistedDecision[]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false
      throw new Error('simulated save failure')
    }
    this.records = structuredClone([...records])
  }
}

interface RuntimeFixture {
  runtime: DecisionRuntime
  persistence: MemoryPersistence
  auditPath?: string
}

async function runtimeWith(records: PersistedDecision[] = [], audit = false): Promise<RuntimeFixture> {
  const persistence = new MemoryPersistence()
  persistence.records = structuredClone(records)
  const auditPath = audit
    ? join(await tempDir('decision-import-audit-'), 'decision-inbox.audit.jsonl')
    : undefined
  const runtime = new DecisionRuntime({
    persistence,
    now: () => 10_000,
    ...(auditPath === undefined ? {} : { audit: new JsonlAuditLog(auditPath) }),
  })
  await runtime.initialize()
  return { runtime, persistence, ...(auditPath === undefined ? {} : { auditPath }) }
}

describe('parseDecisionImport', () => {
  it('parses the versioned JSON wrapper document', () => {
    const text = JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: DECISION_IMPORT_VERSION,
      decisions: [pendingRecord, answeredRecord],
    })
    expect(parseDecisionImport(text, 'json')).toEqual([pendingRecord, answeredRecord])
  })

  it('parses NDJSON records and skips blank lines', () => {
    const text = `\n${JSON.stringify(pendingRecord)}\n\n${JSON.stringify(answeredRecord)}\n`
    expect(parseDecisionImport(text, 'ndjson')).toEqual([pendingRecord, answeredRecord])
  })

  it('rejects malformed wrapper documents with a precise message', () => {
    expect(() => parseDecisionImport('not json', 'json')).toThrow(/not valid JSON/)
    expect(() => parseDecisionImport('null', 'json')).toThrow(/must be a decision-inbox-import document/)
    expect(() => parseDecisionImport('[]', 'json')).toThrow(/must be a decision-inbox-import document/)
    expect(() => parseDecisionImport(JSON.stringify({
      schema: 'other-schema',
      version: DECISION_IMPORT_VERSION,
      decisions: [],
    }), 'json')).toThrow(/unexpected schema "other-schema"/)
    expect(() => parseDecisionImport(JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: 2,
      decisions: [],
    }), 'json')).toThrow(/unsupported version 2/)
    expect(() => parseDecisionImport(JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: DECISION_IMPORT_VERSION,
      decisions: {},
    }), 'json')).toThrow(/decisions array/)
    expect(() => parseDecisionImport(JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: DECISION_IMPORT_VERSION,
      decisions: [null],
    }), 'json')).toThrow(/decisions\[0\] must be a decision record object/)
  })

  it('rejects malformed NDJSON lines with their line number', () => {
    expect(() => parseDecisionImport(`${JSON.stringify(pendingRecord)}\nnot json\n`, 'ndjson'))
      .toThrow(/line 2 is not valid JSON/)
    expect(() => parseDecisionImport(`[]\n`, 'ndjson'))
      .toThrow(/line 1 must be a decision record object/)
  })

  it('rejects unknown formats', () => {
    expect(() => parseDecisionImport('{}', 'xml' as DecisionImportFormat)).toThrow(/unknown decision import format/)
  })
})

describe('inferImportFormat', () => {
  it('maps .jsonl and .ndjson to NDJSON and everything else to the JSON document', () => {
    expect(inferImportFormat('/data/history.json')).toBe('json')
    expect(inferImportFormat('/data/history.jsonl')).toBe('ndjson')
    expect(inferImportFormat('/data/history.NDJSON')).toBe('ndjson')
    expect(inferImportFormat('/data/history.txt')).toBe('json')
  })
})

describe('DecisionRuntime.importRecords', () => {
  it('inserts records with their original ids, timestamps, and revision', async () => {
    const { runtime } = await runtimeWith()
    const result = await runtime.importRecords([pendingRecord, answeredRecord])

    expect(result).toEqual({ records: 2, imported: 2, unchanged: 0, conflicts: 0 })
    expect(await runtime.list('session-old')).toHaveLength(2)
    const imported = await runtime.get('session-old', 'decision-old-1')
    expect(imported).toMatchObject({
      question: 'Blue or green?',
      createdAt: 1_000,
      revision: 1,
      status: 'pending',
    })
    expect((await runtime.get('session-old', 'decision-old-2'))?.answer).toBe('yes')
  })

  it('reports unchanged and conflicting ids without overwriting existing rows', async () => {
    const { runtime } = await runtimeWith([pendingRecord])
    const different = { ...pendingRecord, question: 'Different question?' }
    const result = await runtime.importRecords([structuredClone(pendingRecord), different])

    expect(result).toEqual({ records: 2, imported: 0, unchanged: 1, conflicts: 1 })
    expect((await runtime.get('session-old', 'decision-old-1'))?.question).toBe('Blue or green?')
    expect((await runtime.list('session-old'))[0]?.status).toBe('pending')
  })

  it('fails the whole import before any commit when a conflicting id meets the fail policy', async () => {
    const { runtime } = await runtimeWith([pendingRecord])
    const different = { ...pendingRecord, question: 'Different question?' }

    await expect(runtime.importRecords([answeredRecord, different], { onConflict: 'fail' }))
      .rejects.toThrow(/record 2 conflicts with existing decision decision-old-1/)
    expect(await runtime.list('session-old')).toHaveLength(1)
    expect(await runtime.get('session-old', 'decision-old-2')).toBeUndefined()
  })

  it('fails atomically on an invalid record and names its index', async () => {
    const { runtime } = await runtimeWith()
    const invalid = { ...answeredRecord, question: '   ' }

    await expect(runtime.importRecords([pendingRecord, invalid]))
      .rejects.toThrow(/record 2 is invalid/)
    expect(await runtime.list('session-old')).toEqual([])
  })

  it('treats duplicates inside the batch like existing ids', async () => {
    const { runtime } = await runtimeWith()
    const result = await runtime.importRecords([pendingRecord, structuredClone(pendingRecord)])

    expect(result).toEqual({ records: 2, imported: 1, unchanged: 1, conflicts: 0 })

    const other = { ...pendingRecord, question: 'Other?' }
    await expect(runtime.importRecords([pendingRecord, other], { onConflict: 'fail' }))
      .rejects.toThrow(/record 2 conflicts with existing decision decision-old-1/)
  })

  it('expires past-due pending records right after the import commits', async () => {
    const { runtime } = await runtimeWith()
    const pastDue = { ...pendingRecord, expiresAt: 5_000 }

    await runtime.importRecords([pastDue])
    expect((await runtime.get('session-old', 'decision-old-1'))?.status).toBe('expired')
  })

  it('keeps imported answered records with pending delivery claimable (restore semantics)', async () => {
    const { runtime } = await runtimeWith()
    const retryable: PersistedDecision = {
      id: 'decision-old-retry',
      ownerId: 'session-old',
      question: 'Retry me?',
      options: [],
      status: 'answered',
      deliveryStatus: 'pending',
      createdAt: 4_000,
      answeredAt: 4_500,
      answer: 'go',
      revision: 2,
    }
    await runtime.importRecords([retryable])

    expect(runtime.claimDelivery('session-old', 'decision-old-retry')).toMatchObject({
      kind: 'claimed',
      decision: { deliveryStatus: 'pending', answer: 'go' },
    })
  })

  it('works on an ephemeral runtime without persistence', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-ephemeral' })
    const result = await runtime.importRecords([pendingRecord])
    expect(result.imported).toBe(1)
    expect(await runtime.list('session-old')).toHaveLength(1)
  })

  it('emits one imported audit event per inserted record in createdAt order', async () => {
    const { runtime, auditPath } = await runtimeWith([], true)
    await runtime.importRecords([answeredRecord, pendingRecord])

    const lines = (await readFile(auditPath!, 'utf8')).split('\n').filter(line => line !== '')
    const imported = lines
      .map(line => parseAuditEvent(line))
      .filter((event): event is DecisionImportedAuditEvent => event?.type === 'imported')
    expect(imported).toHaveLength(2)
    expect(imported.map(event => event.decisionId)).toEqual(['decision-old-1', 'decision-old-2'])
    expect(imported[0]).toMatchObject({
      type: 'imported',
      decisionId: 'decision-old-1',
      ownerId: 'session-old',
      revision: 1,
      status: 'pending',
      deliveryStatus: 'none',
      question: 'Blue or green?',
      ts: 10_000,
      actor: 'system',
    })
    expect(imported[1]).toMatchObject({ type: 'imported', status: 'answered', deliveryStatus: 'delivered', answer: 'yes' })
  })

  it('audits first and appends an aborted event when the state save fails', async () => {
    const { runtime, persistence, auditPath } = await runtimeWith([], true)
    persistence.failNextSave = true

    await expect(runtime.importRecords([pendingRecord])).rejects.toThrow(/simulated save failure/)
    expect(await runtime.list('session-old')).toEqual([])

    const lines = (await readFile(auditPath!, 'utf8')).split('\n').filter(line => line !== '')
    const events = lines.map(line => parseAuditEvent(line)!)
    expect(events.map(event => event.type)).toEqual(['checkpoint', 'imported', 'aborted'])
    expect(events[2]).toMatchObject({
      type: 'aborted',
      operation: 'import',
      decisionIds: ['decision-old-1'],
    })

    await runtime.importRecords([pendingRecord])
    expect(await runtime.list('session-old')).toHaveLength(1)
  })
})

describe('importDecisionRecords', () => {
  it('reads and applies a JSON import file with extension inference', async () => {
    const dir = await tempDir('decision-import-file-')
    const source = join(dir, 'history.json')
    await writeFile(source, JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: DECISION_IMPORT_VERSION,
      decisions: [pendingRecord, cancelledRecord],
    }), 'utf8')
    const { runtime } = await runtimeWith()

    const result = await importDecisionRecords(runtime, source)

    expect(result).toEqual({ records: 2, imported: 2, unchanged: 0, conflicts: 0 })
    expect(await runtime.list('session-old')).toHaveLength(2)
    expect((await runtime.get('session-old', 'decision-old-3'))?.status).toBe('cancelled')
  })

  it('honors an explicit format override for a non-standard extension', async () => {
    const dir = await tempDir('decision-import-file-')
    const source = join(dir, 'history.txt')
    await writeFile(source, `${JSON.stringify(pendingRecord)}\n`, 'utf8')
    const { runtime } = await runtimeWith()

    const result = await importDecisionRecords(runtime, source, { format: 'ndjson' })

    expect(result.imported).toBe(1)
    expect(await runtime.list('session-old')).toHaveLength(1)
  })

  it('reports a missing source file', async () => {
    const dir = await tempDir('decision-import-file-')
    const { runtime } = await runtimeWith()

    await expect(importDecisionRecords(runtime, join(dir, 'missing.json'))).rejects.toThrow(/source not found/)
  })

  it('requires an absolute source path', async () => {
    const { runtime } = await runtimeWith()
    await expect(importDecisionRecords(runtime, 'relative/history.json')).rejects.toThrow(/must be absolute/)
  })
})
