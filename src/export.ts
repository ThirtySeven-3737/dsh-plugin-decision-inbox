/**
 * Streaming audit log export for `dsh-decision-inbox`.
 *
 * A framework-independent exporter that turns the append-only NDJSON audit log
 * into a deliverable artifact other tools can consume long-term. It reuses the
 * reader in `audit.ts`, so it inherits the same filters (`ownerId`, `types`,
 * `sinceTs`/`untilTs`, `afterSeq`) and the same corrupt-line tolerance: lines
 * that do not parse are skipped and reported, never fatal.
 *
 * Formats:
 * - `csv`  (default): flattened union table, RFC 4180 quoting, `\r\n` rows —
 *   spreadsheet- and database-import friendly, but lossy (options are joined).
 * - `json`:  a single `decision-audit-export` wrapper document with the event
 *   array plus metadata (`exportedAt`, `corruptLines`).
 * - `ndjson`: the lossless filtered event stream, one JSON event per line —
 *   identical in shape to the source log.
 *
 * Destinations are either an absolute file path (written atomically via a
 * same-directory temporary file plus rename) or any `AuditExportSink`. The
 * audit log is a single-writer store that may grow while an export runs; an
 * export reflects the file as it is read and does not take a lock.
 *
 * @module dsh-decision-inbox/export
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import {
  iterateAuditLog,
  type AuditFilter,
  type DecisionAuditEvent,
} from './audit.ts'

export type AuditExportFormat = 'csv' | 'json' | 'ndjson'

export const AUDIT_EXPORT_SCHEMA = 'decision-audit-export'
export const AUDIT_EXPORT_VERSION = 1

/** A chunked string destination; a file is the built-in implementation. */
export interface AuditExportSink {
  write(chunk: string): void | Promise<void>
}

/** Export options; `destination` is required by the module-level function. */
export interface AuditExportOptions {
  /** Output format; defaults to `csv`. */
  format?: AuditExportFormat
  /** Same filters as the reader; omitted exports everything. */
  filter?: AuditFilter
  /** Absolute destination file path, or an in-memory/stream sink. */
  destination: string | AuditExportSink
  /** Clock for the `exportedAt` stamp (JSON format); defaults to `Date.now`. */
  now?: () => number
}

export interface AuditExportResult {
  /** Number of events written. */
  events: number
  /** Number of skipped non-event lines in the source. */
  corruptLines: number
  /** UTF-8 bytes written to the destination. */
  bytes: number
  format: AuditExportFormat
  /** The destination file, set only when `destination` was a path. */
  path?: string
}

/** In-memory sink that collects chunks; `text()` returns the full export. */
export function stringSink(): AuditExportSink & { text(): string } {
  const chunks: string[] = []
  return {
    write(chunk) {
      chunks.push(chunk)
    },
    text() {
      return chunks.join('')
    },
  }
}

const FORMAT_EXTENSIONS: Record<AuditExportFormat, string> = {
  csv: 'csv',
  json: 'json',
  ndjson: 'ndjson',
}

const FORMATS = new Set<AuditExportFormat>(['csv', 'json', 'ndjson'])

/** Default export path for an audit log: same directory, format extension. */
export function exportPathFor(auditPath: string, format: AuditExportFormat): string {
  const extension = FORMAT_EXTENSIONS[format]
  return auditPath.endsWith('.jsonl')
    ? `${auditPath.slice(0, auditPath.length - '.jsonl'.length)}.${extension}`
    : `${auditPath}.${extension}`
}

const CSV_COLUMNS = [
  'seq', 'ts', 'actor', 'type',
  'decisionId', 'ownerId', 'revision', 'question', 'options', 'answer', 'cancelReason', 'expiresAt',
  'operation', 'reason', 'decisionIds',
  'decisions', 'pending', 'answered', 'cancelled', 'expired',
] as const

const CSV_HEADER = `${CSV_COLUMNS.join(',')}\r\n`

/** RFC 4180 field encoding: quote when the field contains a comma, quote, or line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** Flatten one event into the fixed union column layout; empty cells for fields that do not apply. */
function csvRow(event: DecisionAuditEvent): string {
  const fields: (string | number)[] = [event.seq, event.ts, event.actor, event.type]
  if ('decisionId' in event) {
    fields.push(
      event.decisionId,
      event.ownerId,
      event.revision,
      event.question ?? '',
      event.options === undefined ? '' : event.options.map(option => option.label).join(' | '),
      event.answer ?? '',
      event.cancelReason ?? '',
      event.expiresAt ?? '',
    )
  } else {
    fields.push('', '', '', '', '', '', '', '')
  }
  if (event.type === 'aborted') {
    fields.push(event.operation, event.reason, event.decisionIds.join(','))
  } else {
    fields.push('', '', '')
  }
  if (event.type === 'checkpoint') {
    fields.push(event.decisions, event.pending, event.answered, event.cancelled, event.expired)
  } else {
    fields.push('', '', '', '', '')
  }
  return `${fields.map(field => csvField(String(field))).join(',')}\r\n`
}

/**
 * Stream the audit log at `source` into `options.destination` in the requested
 * format, skipping corrupt lines, and return a count report.
 *
 * A missing source file exports as an empty artifact (CSV header only, empty
 * JSON `events` array, or an empty NDJSON file). A string destination is
 * written to a same-directory temporary file, fsynced, and atomically renamed,
 * so readers never observe a partial export.
 */
export async function exportAuditLog(
  source: string,
  options: AuditExportOptions,
): Promise<AuditExportResult> {
  if (!isAbsolute(source)) throw new Error('audit log source path must be absolute')
  const format = options.format ?? 'csv'
  if (!FORMATS.has(format)) throw new Error(`unknown audit export format: ${String(format)}`)
  const now = options.now ?? (() => Date.now())

  let filePath: string | undefined
  let temp: string | undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let sink = options.destination
  if (typeof sink === 'string') {
    if (!isAbsolute(sink)) throw new Error('audit export destination path must be absolute')
    filePath = sink
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    temp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
    handle = await open(temp, 'wx', 0o600)
    sink = { write: chunk => handle!.writeFile(chunk, 'utf8') }
  }

  let events = 0
  let corruptLines = 0
  let bytes = 0
  const write = async (chunk: string): Promise<void> => {
    bytes += Buffer.byteLength(chunk, 'utf8')
    await sink.write(chunk)
  }

  try {
    const iterator = iterateAuditLog(source, options.filter, () => { corruptLines++ })
    if (format === 'csv') {
      await write(CSV_HEADER)
      for await (const event of iterator) {
        events++
        await write(csvRow(event))
      }
    } else if (format === 'json') {
      await write(`{"schema":"${AUDIT_EXPORT_SCHEMA}","version":${AUDIT_EXPORT_VERSION},"exportedAt":${now()},"format":"json","events":[`)
      let first = true
      for await (const event of iterator) {
        await write(`${first ? '' : ','}${JSON.stringify(event)}`)
        first = false
        events++
      }
      await write(`],"corruptLines":${corruptLines}}\n`)
    } else {
      for await (const event of iterator) {
        events++
        await write(`${JSON.stringify(event)}\n`)
      }
    }

    if (handle !== undefined) {
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temp!, filePath!)
      temp = undefined
    }
    return {
      events,
      corruptLines,
      bytes,
      format,
      ...(filePath === undefined ? {} : { path: filePath }),
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (temp !== undefined) await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
