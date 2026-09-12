/**
 * Bulk import of historical decision records for `dsh-decision-inbox`.
 *
 * The write-side counterpart of the export surface: a stable, versioned text
 * format other tools can produce long-term, plus one-shot application into a
 * live `DecisionRuntime`. Import is insert-only (existing decision ids are
 * never overwritten) and atomic (every record is validated before anything
 * commits, and the merge applies as a single state snapshot).
 *
 * Formats:
 * - `json`  (default): one `decision-inbox-import` wrapper document —
 *   `{"schema":"decision-inbox-import","version":1,"decisions":[...]}`.
 * - `ndjson`: one full decision record per line (blank lines are allowed),
 *   friendly to streaming producers and large archives.
 *
 * Records use exactly the persisted decision shape and invariants of the
 * state file: `id`, `ownerId`, `question`, `options`, `status`,
 * `deliveryStatus`, `createdAt`, `revision`, plus the optional lifecycle
 * fields (`expiresAt`, `answeredAt`, `answer`, `cancelledAt`, `cancelReason`,
 * `deliveredAt`). Format-level parsing is strict — malformed JSON, a wrong
 * wrapper schema/version, or a non-object record throws with the offending
 * line or index instead of silently dropping data. Record-invariant
 * validation happens in `DecisionRuntime.importRecords` before anything is
 * applied.
 *
 * @module dsh-decision-inbox/import
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DecisionAuditActor } from './audit.ts'
import type {
  DecisionImportResult,
  DecisionRuntime,
  ImportConflictPolicy,
  PersistedDecision,
} from './runtime.ts'

export type { DecisionImportResult, ImportConflictPolicy, PersistedDecision } from './runtime.ts'

export const DECISION_IMPORT_SCHEMA = 'decision-inbox-import'
export const DECISION_IMPORT_VERSION = 1

export type DecisionImportFormat = 'json' | 'ndjson'

export interface DecisionImportOptions {
  /** Input format; inferred from the file extension when omitted. */
  format?: DecisionImportFormat
  /** How an existing id with different content is treated. Defaults to `skip`. */
  onConflict?: ImportConflictPolicy
  /** Audit actor for the emitted `imported` events. Defaults to `system`. */
  actor?: DecisionAuditActor
}

const FORMATS = new Set<DecisionImportFormat>(['json', 'ndjson'])

/** Default format for a path: `.jsonl`/`.ndjson` reads as NDJSON, anything else as the JSON document. */
export function inferImportFormat(path: string): DecisionImportFormat {
  return /\.(jsonl|ndjson)$/iu.test(path) ? 'ndjson' : 'json'
}

function assertRecord(value: unknown, where: string): PersistedDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be a decision record object`)
  }
  return value as PersistedDecision
}

/**
 * Parse import text into decision records.
 *
 * Format-level parsing only: record invariants (trimmed strings, status
 * consistency, timestamps) are validated by `DecisionRuntime.importRecords`
 * before anything is applied. Parsing is strict: malformed JSON or a wrong
 * wrapper document throws with the offending line or index.
 */
export function parseDecisionImport(
  text: string,
  format: DecisionImportFormat,
  label = 'decision import',
): PersistedDecision[] {
  if (!FORMATS.has(format)) throw new Error(`unknown decision import format: ${String(format)}`)
  if (format === 'ndjson') {
    const records: PersistedDecision[] = []
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        throw new Error(`${label} line ${index + 1} is not valid JSON`, { cause: error })
      }
      records.push(assertRecord(value, `${label} line ${index + 1}`))
    }
    return records
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a decision-inbox-import document`)
  }
  const document = value as Record<string, unknown>
  if (document.schema !== DECISION_IMPORT_SCHEMA) {
    throw new Error(`${label} has unexpected schema ${JSON.stringify(document.schema)}; expected ${DECISION_IMPORT_SCHEMA}`)
  }
  if (document.version !== DECISION_IMPORT_VERSION) {
    throw new Error(`${label} has unsupported version ${String(document.version)}; expected ${DECISION_IMPORT_VERSION}`)
  }
  if (!Array.isArray(document.decisions)) {
    throw new Error(`${label} must contain a decisions array`)
  }
  return document.decisions.map((record, index) => assertRecord(record, `${label} decisions[${index}]`))
}

/**
 * Read an import artifact from an absolute file path, parse it, and apply it
 * to a live runtime in one atomic step. Returns the merge report; a missing
 * file throws, invalid records fail the whole import, and `onConflict` is
 * forwarded to `DecisionRuntime.importRecords`.
 */
export async function importDecisionRecords(
  runtime: DecisionRuntime,
  source: string,
  options: DecisionImportOptions = {},
): Promise<DecisionImportResult> {
  if (!isAbsolute(source)) throw new Error('decision import source path must be absolute')
  const format = options.format ?? inferImportFormat(source)
  let text: string
  try {
    text = await readFile(source, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`decision import source not found: ${source}`)
    }
    throw error
  }
  const records = parseDecisionImport(text, format, source)
  return await runtime.importRecords(records, {
    ...(options.onConflict === undefined ? {} : { onConflict: options.onConflict }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  })
}
