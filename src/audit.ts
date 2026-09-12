/**
 * Append-only decision audit log for `dsh-decision-inbox`.
 *
 * The audit log is a stable, machine-readable NDJSON file (one JSON event per
 * line) that other tools can read long-term. Every applied state mutation is
 * recorded as an immutable event; the state file remains the authority, and
 * the event stream answers "who did what, when".
 *
 * Consistency model (documented in the README):
 * - Events are fsynced to the audit file BEFORE the state snapshot is saved,
 *   so an applied change can never miss its audit record.
 * - If the state save fails afterwards, an `aborted` event is appended and the
 *   mutation fails. A crash between the two writes can therefore leave audit
 *   events without a matching state change; readers should treat the state
 *   file as authoritative for the current state.
 *
 * @module dsh-decision-inbox/audit
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { DecisionDeliveryStatus, DecisionOption, DecisionStatus } from './runtime.ts'

export const DECISION_AUDIT_SCHEMA = 'decision-audit-event'
export const DECISION_AUDIT_VERSION = 1

/** Who triggered a recorded state mutation. */
export type DecisionAuditActor = 'agent' | 'user' | 'system'

/** Discriminated audit event kinds. */
export type DecisionAuditEventType =
  | 'created'
  | 'answered'
  | 'cancelled'
  | 'expired'
  | 'delivered'
  | 'imported'
  | 'checkpoint'
  | 'aborted'

interface DecisionAuditBase {
  schema: typeof DECISION_AUDIT_SCHEMA
  version: typeof DECISION_AUDIT_VERSION
  /** Monotonic per-file sequence number, assigned by the sink in append order. */
  seq: number
  /** Event time in epoch milliseconds (the runtime clock). */
  ts: number
  actor: DecisionAuditActor
}

/** A decision lifecycle transition, carrying the type-specific payload. */
export interface DecisionLifecycleAuditEvent extends DecisionAuditBase {
  type: 'created' | 'answered' | 'cancelled' | 'expired' | 'delivered'
  decisionId: string
  ownerId: string
  revision: number
  /** `created`: the question and offered options. */
  question?: string
  options?: DecisionOption[]
  expiresAt?: number
  /** `answered`: the user's answer text. */
  answer?: string
  /** `cancelled`: the optional cancellation reason. */
  cancelReason?: string
}

/** Written once after durable state is loaded, so external tools can detect restarts. */
export interface DecisionCheckpointAuditEvent extends DecisionAuditBase {
  type: 'checkpoint'
  decisions: number
  pending: number
  answered: number
  cancelled: number
  expired: number
}

/** Written when a state save fails after its audit events were already appended. */
export interface DecisionAbortedAuditEvent extends DecisionAuditBase {
  type: 'aborted'
  /** The mutation kind whose state save failed: create|answer|cancel|expiry|delivery|import. */
  operation: string
  reason: string
  decisionIds: string[]
}

/**
 * Written once per record when a bulk import inserts it into the state.
 * Carries the record's full lifecycle snapshot, including its `status` and
 * `deliveryStatus` at import time.
 */
export interface DecisionImportedAuditEvent extends DecisionAuditBase {
  type: 'imported'
  decisionId: string
  ownerId: string
  revision: number
  status: DecisionStatus
  deliveryStatus: DecisionDeliveryStatus
  question: string
  options: DecisionOption[]
  expiresAt?: number
  answer?: string
  cancelReason?: string
}

export type DecisionAuditEvent =
  | DecisionLifecycleAuditEvent
  | DecisionImportedAuditEvent
  | DecisionCheckpointAuditEvent
  | DecisionAbortedAuditEvent

/** An event before its file-assigned `seq`; sinks stamp `seq` in append order. */
export type DecisionAuditDraft =
  | Omit<DecisionLifecycleAuditEvent, 'seq'>
  | Omit<DecisionImportedAuditEvent, 'seq'>
  | Omit<DecisionCheckpointAuditEvent, 'seq'>
  | Omit<DecisionAbortedAuditEvent, 'seq'>

/** Append-only audit sink. Implementations must assign `seq` in append order. */
export interface AuditSink {
  append(events: readonly DecisionAuditDraft[]): Promise<void>
}

/** Default audit file path derived from the state file path. */
export function auditPathFor(stateFile: string): string {
  return stateFile.endsWith('.json')
    ? `${stateFile.slice(0, stateFile.length - '.json'.length)}.audit.jsonl`
    : `${stateFile}.audit.jsonl`
}

/**
 * Append-only NDJSON audit log: one JSON event per line, fsynced per append.
 *
 * Appends are serialized per instance. The file is a single-writer store, like
 * the state file: run only one DSH process per `DSH_HOME`.
 */
export class JsonlAuditLog implements AuditSink {
  readonly path: string
  private nextSeq: number | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('audit log path must be absolute')
    this.path = path
  }

  async append(events: readonly DecisionAuditDraft[]): Promise<void> {
    if (events.length === 0) return
    const run = this.tail.then(async () => {
      let seq = await this.startSequence()
      const lines = events.map(event => `${JSON.stringify({ ...event, seq: seq++ })}\n`)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const handle = await open(this.path, 'a', 0o600)
      try {
        await handle.writeFile(lines.join(''), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.nextSeq = seq
    })
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /** Discover the next sequence number from the existing file once per instance. */
  private async startSequence(): Promise<number> {
    if (this.nextSeq !== undefined) return this.nextSeq
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.nextSeq = 1
        return this.nextSeq
      }
      throw error
    }
    let last = 0
    for (const line of text.split('\n')) {
      const event = parseAuditEvent(line)
      if (event !== undefined && event.seq > last) last = event.seq
    }
    this.nextSeq = last + 1
    return this.nextSeq
  }
}

const EVENT_TYPES = new Set<DecisionAuditEventType>([
  'created', 'answered', 'cancelled', 'expired', 'delivered', 'imported', 'checkpoint', 'aborted',
])
const LIFECYCLE_TYPES = new Set<DecisionAuditEventType>([
  'created', 'answered', 'cancelled', 'expired', 'delivered',
])
const ACTORS = new Set<DecisionAuditActor>(['agent', 'user', 'system'])
const STATUSES = new Set<DecisionStatus>(['pending', 'answered', 'cancelled', 'expired'])
const DELIVERY_STATUSES = new Set<DecisionDeliveryStatus>(['none', 'pending', 'delivered'])

/**
 * Parse one NDJSON line into an audit event.
 *
 * Returns `undefined` for empty lines, invalid JSON, unknown schema/version,
 * and structurally invalid events, so readers can skip and count corrupt
 * lines instead of failing a whole export.
 */
export function parseAuditEvent(text: string): DecisionAuditEvent | undefined {
  if (text.trim() === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schema !== DECISION_AUDIT_SCHEMA) return undefined
  if (record.version !== DECISION_AUDIT_VERSION) return undefined
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 1) return undefined
  if (!Number.isSafeInteger(record.ts) || (record.ts as number) < 0) return undefined
  if (typeof record.actor !== 'string' || !ACTORS.has(record.actor as DecisionAuditActor)) return undefined
  if (typeof record.type !== 'string' || !EVENT_TYPES.has(record.type as DecisionAuditEventType)) return undefined
  const type = record.type as DecisionAuditEventType

  const optionalString = (name: string): boolean => {
    const field = record[name]
    return field === undefined || typeof field === 'string'
  }
  const optionalInteger = (name: string): boolean => {
    const field = record[name]
    return field === undefined || (Number.isSafeInteger(field) && (field as number) >= 0)
  }
  const validOptions = (): boolean => {
    if (!Array.isArray(record.options)) return false
    for (const option of record.options) {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) return false
      const item = option as Record<string, unknown>
      if (typeof item.label !== 'string' || item.label === '') return false
      if (item.description !== undefined && typeof item.description !== 'string') return false
    }
    return true
  }

  if (LIFECYCLE_TYPES.has(type)) {
    if (typeof record.decisionId !== 'string' || record.decisionId === '') return undefined
    if (typeof record.ownerId !== 'string' || record.ownerId === '') return undefined
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) return undefined
    if (!optionalString('question') || !optionalString('answer') || !optionalString('cancelReason')) return undefined
    if (!optionalInteger('expiresAt')) return undefined
    if (record.options !== undefined && !validOptions()) return undefined
    if (type === 'created' && (typeof record.question !== 'string' || !Array.isArray(record.options))) return undefined
    if (type === 'answered' && typeof record.answer !== 'string') return undefined
    if (type === 'cancelled' && record.cancelReason !== undefined && typeof record.cancelReason !== 'string') return undefined
    return value as unknown as DecisionAuditEvent
  }
  if (type === 'imported') {
    if (typeof record.decisionId !== 'string' || record.decisionId === '') return undefined
    if (typeof record.ownerId !== 'string' || record.ownerId === '') return undefined
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) return undefined
    if (typeof record.status !== 'string' || !STATUSES.has(record.status as DecisionStatus)) return undefined
    if (typeof record.deliveryStatus !== 'string'
      || !DELIVERY_STATUSES.has(record.deliveryStatus as DecisionDeliveryStatus)) return undefined
    if (typeof record.question !== 'string' || !validOptions()) return undefined
    if (!optionalString('answer') || !optionalString('cancelReason') || !optionalInteger('expiresAt')) return undefined
    return value as unknown as DecisionAuditEvent
  }
  if (type === 'checkpoint') {
    for (const name of ['decisions', 'pending', 'answered', 'cancelled', 'expired']) {
      const field = record[name]
      if (!Number.isSafeInteger(field) || (field as number) < 0) return undefined
    }
    return value as unknown as DecisionAuditEvent
  }
  // aborted
  if (typeof record.operation !== 'string' || record.operation === '') return undefined
  if (typeof record.reason !== 'string') return undefined
  if (!Array.isArray(record.decisionIds) || record.decisionIds.some(id => typeof id !== 'string')) return undefined
  return value as unknown as DecisionAuditEvent
}

/** Reader-side event filter. */
export interface AuditFilter {
  ownerId?: string
  types?: readonly DecisionAuditEventType[]
  /** Inclusive lower bound on `ts` (epoch ms). */
  sinceTs?: number
  /** Inclusive upper bound on `ts` (epoch ms). */
  untilTs?: number
  /** Exclusive lower bound on `seq`, for resumable exports. */
  afterSeq?: number
}

/** Whether an event passes a filter. `checkpoint`/`aborted` events match only without an `ownerId` filter. */
export function matchesAuditFilter(event: DecisionAuditEvent, filter: AuditFilter): boolean {
  if (filter.afterSeq !== undefined && event.seq <= filter.afterSeq) return false
  if (filter.sinceTs !== undefined && event.ts < filter.sinceTs) return false
  if (filter.untilTs !== undefined && event.ts > filter.untilTs) return false
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false
  if (filter.ownerId !== undefined && (!('ownerId' in event) || event.ownerId !== filter.ownerId)) return false
  return true
}

/**
 * Stream audit events from an NDJSON file, skipping corrupt lines.
 *
 * A missing file yields an empty stream; other I/O errors propagate.
 * `onCorrupt` reports skipped lines with their 1-based line number.
 */
export async function* iterateAuditLog(
  path: string,
  filter?: AuditFilter,
  onCorrupt?: (lineNumber: number, text: string) => void,
): AsyncGenerator<DecisionAuditEvent> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    let lineNumber = 0
    for await (const line of handle.readLines()) {
      lineNumber++
      const event = parseAuditEvent(line)
      if (event === undefined) {
        onCorrupt?.(lineNumber, line)
        continue
      }
      if (filter !== undefined && !matchesAuditFilter(event, filter)) continue
      yield event
    }
  } finally {
    await handle.close()
  }
}

export interface AuditReadResult {
  events: DecisionAuditEvent[]
  /** Number of skipped non-event lines. */
  corruptLines: number
}

/** Read the whole (filtered) audit log into memory, reporting corrupt lines. */
export async function readAuditLog(path: string, filter?: AuditFilter): Promise<AuditReadResult> {
  const events: DecisionAuditEvent[] = []
  let corruptLines = 0
  for await (const event of iterateAuditLog(path, filter, () => { corruptLines++ })) {
    events.push(event)
  }
  return { events, corruptLines }
}
