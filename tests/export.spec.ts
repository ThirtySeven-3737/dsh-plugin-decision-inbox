import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionAuditEvent } from '../src/audit.ts'
import { exportAuditLog, exportPathFor, stringSink } from '../src/export.ts'

const temporaryDirectories = new Set<string>()

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'decision-export-'))
  temporaryDirectories.add(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

const created: DecisionAuditEvent = {
  schema: 'decision-audit-event',
  version: 1,
  seq: 1,
  ts: 1_000,
  actor: 'agent',
  type: 'created',
  decisionId: 'd1',
  ownerId: 's1',
  revision: 1,
  question: 'Use "blue", or\nnew line?',
  options: [{ label: 'blue, dark' }, { label: 'green' }],
  expiresAt: 2_000,
}

const answered: DecisionAuditEvent = {
  schema: 'decision-audit-event',
  version: 1,
  seq: 2,
  ts: 2_000,
  actor: 'user',
  type: 'answered',
  decisionId: 'd1',
  ownerId: 's1',
  revision: 2,
  answer: 'yes',
}

const checkpoint: DecisionAuditEvent = {
  schema: 'decision-audit-event',
  version: 1,
  seq: 3,
  ts: 3_000,
  actor: 'system',
  type: 'checkpoint',
  decisions: 1,
  pending: 0,
  answered: 1,
  cancelled: 0,
  expired: 0,
}

const aborted: DecisionAuditEvent = {
  schema: 'decision-audit-event',
  version: 1,
  seq: 4,
  ts: 4_000,
  actor: 'system',
  type: 'aborted',
  operation: 'answer',
  reason: 'disk full',
  decisionIds: ['d1'],
}

async function sourceFile(): Promise<string> {
  const path = await tempFile('audit.jsonl')
  await writeFile(path, [
    `${JSON.stringify(created)}\n`,
    'garbage line\n',
    `${JSON.stringify(answered)}\n`,
    `${JSON.stringify(checkpoint)}\n`,
    `${JSON.stringify(aborted)}\n`,
  ].join(''), 'utf8')
  return path
}

/** Minimal RFC 4180 line parser for asserting cell values independent of the writer. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}

describe('exportPathFor', () => {
  it('derives a format extension next to the audit log', () => {
    expect(exportPathFor('/data/decision-inbox.audit.jsonl', 'csv')).toBe('/data/decision-inbox.audit.csv')
    expect(exportPathFor('/data/decision-inbox.audit.jsonl', 'json')).toBe('/data/decision-inbox.audit.json')
    expect(exportPathFor('/data/decision-inbox.audit.jsonl', 'ndjson')).toBe('/data/decision-inbox.audit.ndjson')
  })

  it('appends the extension when the audit path has no .jsonl suffix', () => {
    expect(exportPathFor('/data/audit', 'csv')).toBe('/data/audit.csv')
  })
})

describe('exportAuditLog', () => {
  it('requires absolute source and destination paths', async () => {
    await expect(exportAuditLog('relative/audit.jsonl', { destination: '/data/out.csv' }))
      .rejects.toThrow(/source path must be absolute/)
    await expect(exportAuditLog('/data/audit.jsonl', { destination: 'relative/out.csv' }))
      .rejects.toThrow(/destination path must be absolute/)
  })

  it('rejects unknown formats at runtime', async () => {
    await expect(exportAuditLog('/data/audit.jsonl', {
      format: 'xml' as never,
      destination: stringSink(),
    })).rejects.toThrow(/unknown audit export format/)
  })

  it('exports a CSV file with a union header, quoting, and a count report', async () => {
    const source = await sourceFile()
    const destination = await tempFile('audit.csv')

    const result = await exportAuditLog(source, { format: 'csv', destination })

    expect(result).toEqual({
      events: 4,
      corruptLines: 1,
      format: 'csv',
      path: destination,
      bytes: expect.any(Number),
    })
    const text = await readFile(destination, 'utf8')
    const lines = text.split('\r\n').filter(line => line !== '')
    expect(lines).toHaveLength(5)
    expect(parseCsvLine(lines[0]!)).toEqual([
      'seq', 'ts', 'actor', 'type',
      'decisionId', 'ownerId', 'revision', 'question', 'options', 'answer', 'cancelReason', 'expiresAt',
      'operation', 'reason', 'decisionIds',
      'decisions', 'pending', 'answered', 'cancelled', 'expired',
    ])
    const createdRow = parseCsvLine(lines[1]!)
    expect(createdRow).toHaveLength(20)
    expect(createdRow[0]).toBe('1')
    expect(createdRow[3]).toBe('created')
    expect(createdRow[4]).toBe('d1')
    expect(createdRow[5]).toBe('s1')
    expect(createdRow[7]).toBe('Use "blue", or\nnew line?')
    expect(createdRow[8]).toBe('blue, dark | green')
    expect(createdRow[11]).toBe('2000')
    const answeredRow = parseCsvLine(lines[2]!)
    expect(answeredRow[3]).toBe('answered')
    expect(answeredRow[9]).toBe('yes')
    expect(answeredRow[6]).toBe('2')
    const checkpointRow = parseCsvLine(lines[3]!)
    expect(checkpointRow[3]).toBe('checkpoint')
    expect(checkpointRow.slice(15)).toEqual(['1', '0', '1', '0', '0'])
    const abortedRow = parseCsvLine(lines[4]!)
    expect(abortedRow[3]).toBe('aborted')
    expect(abortedRow[12]).toBe('answer')
    expect(abortedRow[13]).toBe('disk full')
    expect(abortedRow[14]).toBe('d1')
  })

  it('wraps JSON exports in a versioned document with metadata', async () => {
    const source = await sourceFile()
    const destination = await tempFile('audit.json')

    const result = await exportAuditLog(source, {
      format: 'json',
      destination,
      now: () => 42_000,
    })

    expect(result).toMatchObject({ events: 4, corruptLines: 1, format: 'json' })
    const parsed = JSON.parse(await readFile(destination, 'utf8')) as Record<string, unknown>
    expect(parsed.schema).toBe('decision-audit-export')
    expect(parsed.version).toBe(1)
    expect(parsed.exportedAt).toBe(42_000)
    expect(parsed.format).toBe('json')
    expect(parsed.corruptLines).toBe(1)
    const events = parsed.events as DecisionAuditEvent[]
    expect(events).toHaveLength(4)
    expect(events[0]).toEqual(created)
    expect(events.map(event => event.type)).toEqual(['created', 'answered', 'checkpoint', 'aborted'])
  })

  it('exports the lossless filtered NDJSON stream', async () => {
    const source = await sourceFile()
    const destination = await tempFile('audit.ndjson')

    const result = await exportAuditLog(source, {
      format: 'ndjson',
      destination,
      filter: { ownerId: 's1' },
    })

    expect(result).toMatchObject({ events: 2, corruptLines: 1, format: 'ndjson' })
    const lines = (await readFile(destination, 'utf8')).split('\n').filter(line => line !== '')
    expect(lines.map(line => (JSON.parse(line) as DecisionAuditEvent).seq)).toEqual([1, 2])
  })

  it('supports an in-memory sink destination', async () => {
    const source = await sourceFile()
    const sink = stringSink()

    const result = await exportAuditLog(source, { format: 'ndjson', destination: sink })

    expect(result.path).toBeUndefined()
    expect(result.events).toBe(4)
    expect(sink.text().split('\n').filter(line => line !== '')).toHaveLength(4)
  })

  it('reads a missing source as an empty export', async () => {
    const source = await tempFile('missing.jsonl')
    const csv = await tempFile('empty.csv')
    const json = await tempFile('empty.json')
    const ndjson = await tempFile('empty.ndjson')

    const csvResult = await exportAuditLog(source, { format: 'csv', destination: csv })
    const jsonResult = await exportAuditLog(source, { format: 'json', destination: json })
    const ndjsonResult = await exportAuditLog(source, { format: 'ndjson', destination: ndjson })

    expect(csvResult).toMatchObject({ events: 0, corruptLines: 0 })
    expect(await readFile(csv, 'utf8')).toBe('seq,ts,actor,type,decisionId,ownerId,revision,question,options,answer,cancelReason,expiresAt,operation,reason,decisionIds,decisions,pending,answered,cancelled,expired\r\n')
    expect(jsonResult).toMatchObject({ events: 0, corruptLines: 0 })
    expect(JSON.parse(await readFile(json, 'utf8'))).toMatchObject({ schema: 'decision-audit-export', events: [], corruptLines: 0 })
    expect(ndjsonResult).toMatchObject({ events: 0, corruptLines: 0 })
    expect(await readFile(ndjson, 'utf8')).toBe('')
  })

  it('creates missing destination directories', async () => {
    const source = await sourceFile()
    const parent = await mkdtemp(join(tmpdir(), 'decision-export-parent-'))
    temporaryDirectories.add(parent)
    const destination = join(parent, 'nested', 'dir', 'audit.csv')

    const result = await exportAuditLog(source, { format: 'csv', destination })

    expect(result.path).toBe(destination)
    expect((await readFile(destination, 'utf8')).startsWith('seq,ts,')).toBe(true)
  })

  it('exports imported events with their record fields', async () => {
    const source = await tempFile('imported.jsonl')
    await writeFile(source, `${JSON.stringify({
      schema: 'decision-audit-event',
      version: 1,
      seq: 1,
      ts: 5_000,
      actor: 'user',
      type: 'imported',
      decisionId: 'd9',
      ownerId: 's9',
      revision: 3,
      status: 'answered',
      deliveryStatus: 'delivered',
      question: 'Old, question?',
      options: [{ label: 'a, b' }],
      answer: 'yes',
    })}\n`, 'utf8')
    const destination = await tempFile('imported.csv')

    const result = await exportAuditLog(source, { format: 'csv', destination })

    expect(result).toMatchObject({ events: 1, corruptLines: 0 })
    const lines = (await readFile(destination, 'utf8')).split('\r\n').filter(line => line !== '')
    const row = parseCsvLine(lines[1]!)
    expect(row[3]).toBe('imported')
    expect(row[4]).toBe('d9')
    expect(row[5]).toBe('s9')
    expect(row[7]).toBe('Old, question?')
    expect(row[8]).toBe('a, b')
    expect(row[9]).toBe('yes')
  })
})
