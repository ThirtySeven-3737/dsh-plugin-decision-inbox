import { randomUUID } from 'node:crypto'
import type { AuditSink, DecisionAuditActor, DecisionAuditDraft } from './audit.ts'

/** Lifecycle states visible to the agent and the user. */
export type DecisionStatus = 'pending' | 'answered' | 'cancelled' | 'expired'

/** Durable answer-delivery state. Claims stay process-local and are recovered as pending. */
export type DecisionDeliveryStatus = 'none' | 'pending' | 'delivered'

/** A short user-facing choice. Free-text answers remain allowed. */
export interface DecisionOption {
  label: string
  description?: string
}

/** Immutable public view of one decision request. */
export interface DecisionSnapshot {
  id: string
  question: string
  options: DecisionOption[]
  status: DecisionStatus
  deliveryStatus: DecisionDeliveryStatus
  createdAt: number
  expiresAt?: number
  answeredAt?: number
  answer?: string
  cancelledAt?: number
  cancelReason?: string
  deliveredAt?: number
  revision: number
}

/** Complete durable row, including the session that owns it. */
export interface PersistedDecision extends DecisionSnapshot {
  ownerId: string
}

/** Replace-all persistence boundary used by the serialized runtime. */
export interface DecisionPersistence {
  load(): Promise<readonly PersistedDecision[]>
  save(decisions: readonly PersistedDecision[]): Promise<void>
}

export interface CreateDecisionInput {
  ownerId: string
  question: string
  options?: readonly DecisionOption[]
  expiresInSeconds?: number
}

export type AnswerDecisionResult =
  | { kind: 'answered'; decision: DecisionSnapshot }
  | { kind: 'already-answered'; decision: DecisionSnapshot; matchesExisting: boolean }
  | { kind: 'not-pending'; decision: DecisionSnapshot }
  | { kind: 'not-found' }

export type CancelDecisionResult =
  | { kind: 'cancelled'; decision: DecisionSnapshot }
  | { kind: 'not-pending'; decision: DecisionSnapshot }
  | { kind: 'not-found' }

export type DeliveryClaimResult =
  | { kind: 'claimed'; decision: DecisionSnapshot }
  | { kind: 'unavailable' }

interface DecisionEntry extends PersistedDecision {}

/** Who triggered a mutation; recorded on audit events. Defaults to `system`. */
export interface DecisionMutationContext {
  actor?: DecisionAuditActor
}

/** Mutation kind reported on `aborted` audit events. */
export type DecisionAuditOperation = 'create' | 'answer' | 'cancel' | 'expiry' | 'delivery' | 'import'

/** How a bulk import treats a record whose id already exists with different content. */
export type ImportConflictPolicy = 'skip' | 'fail'

/** Merge report returned by `DecisionRuntime.importRecords`. */
export interface DecisionImportResult {
  /** Number of records offered to the import. */
  records: number
  /** Records inserted because their id was unknown. */
  imported: number
  /** Records skipped because an identical decision already exists. */
  unchanged: number
  /** Records skipped because a different decision with the same id exists (skip policy only). */
  conflicts: number
}

export interface ImportDecisionsOptions {
  /** How to treat an existing id with different content. Defaults to `skip`. */
  onConflict?: ImportConflictPolicy
  /** Audit actor for the emitted `imported` events. Defaults to `system`. */
  actor?: DecisionAuditActor
}

export interface DecisionRuntimeOptions {
  now?: () => number
  idFactory?: () => string
  persistence?: DecisionPersistence
  /** Optional append-only audit sink; without it no audit events are produced. */
  audit?: AuditSink
}

const STATUSES = new Set<DecisionStatus>(['pending', 'answered', 'cancelled', 'expired'])
const DELIVERY_STATUSES = new Set<DecisionDeliveryStatus>(['none', 'pending', 'delivered'])

function assertNonEmpty(name: string, value: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${name} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`)
  return normalized
}

function cloneOption(option: DecisionOption): DecisionOption {
  return option.description === undefined
    ? { label: option.label }
    : { label: option.label, description: option.description }
}

function sameOptions(a: readonly DecisionOption[], b: readonly DecisionOption[]): boolean {
  if (a.length !== b.length) return false
  return a.every((option, index) => {
    const other = b[index]!
    return option.label === other.label && option.description === other.description
  })
}

function sameDecision(a: DecisionEntry, b: DecisionEntry): boolean {
  return a.id === b.id
    && a.ownerId === b.ownerId
    && a.question === b.question
    && sameOptions(a.options, b.options)
    && a.status === b.status
    && a.deliveryStatus === b.deliveryStatus
    && a.createdAt === b.createdAt
    && a.revision === b.revision
    && a.expiresAt === b.expiresAt
    && a.answeredAt === b.answeredAt
    && a.answer === b.answer
    && a.cancelledAt === b.cancelledAt
    && a.cancelReason === b.cancelReason
    && a.deliveredAt === b.deliveredAt
}

function optionalInteger(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`persisted decision ${name} must be a non-negative safe integer`)
  }
  return value as number
}

/**
 * Framework-independent, crash-recoverable decision state machine.
 *
 * Mutations are serialized and become visible only after the replacement
 * snapshot is durable. Delivery claims are intentionally process-local: an
 * interrupted claim reopens as `pending` delivery after restart.
 */
export class DecisionRuntime {
  private entries = new Map<string, DecisionEntry>()
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly persistence: DecisionPersistence | undefined
  private readonly audit: AuditSink | undefined
  private readonly deliveryClaims = new Set<string>()
  private operationTail: Promise<void> = Promise.resolve()
  private initializePromise?: Promise<void>
  private initialized: boolean

  constructor(options: DecisionRuntimeOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => `decision-${randomUUID()}`)
    this.persistence = options.persistence
    this.audit = options.audit
    this.initialized = options.persistence === undefined
  }

  /** Load and validate durable rows exactly once before serving operations. */
  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    this.initializePromise ??= this.loadAndCheckpoint()
    return this.initializePromise
  }

  async create(input: CreateDecisionInput, context: DecisionMutationContext = {}): Promise<DecisionSnapshot> {
    const actor = context.actor ?? 'system'
    const ownerId = assertNonEmpty('ownerId', input.ownerId, 512)
    const question = assertNonEmpty('question', input.question, 4_000)
    const options = this.validateOptions(input.options ?? [])
    if (input.expiresInSeconds !== undefined
      && (!Number.isSafeInteger(input.expiresInSeconds)
        || input.expiresInSeconds < 1
        || input.expiresInSeconds > 2_592_000)) {
      throw new Error('expiresInSeconds must be a whole number from 1 to 2592000')
    }

    return await this.enqueue(async () => {
      const createdAt = this.now()
      const expiresAt = input.expiresInSeconds === undefined
        ? undefined
        : createdAt + input.expiresInSeconds * 1_000
      let id = assertNonEmpty('decision id', this.idFactory(), 512)
      for (let attempt = 0; this.entries.has(id); attempt++) {
        if (attempt >= 99) throw new Error('idFactory produced too many duplicate decision ids')
        id = assertNonEmpty('decision id', this.idFactory(), 512)
      }

      const entry: DecisionEntry = {
        id,
        ownerId,
        question,
        options,
        status: 'pending',
        deliveryStatus: 'none',
        createdAt,
        revision: 1,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }
      const next = new Map(this.entries)
      next.set(id, entry)
      await this.commit(next, 'create', actor)
      return this.snapshot(entry)
    })
  }

  async list(ownerId: string, status?: DecisionStatus): Promise<DecisionSnapshot[]> {
    return await this.enqueue(async () => {
      await this.refreshExpiries(ownerId)
      const result = [...this.entries.values()]
        .filter(entry => entry.ownerId === ownerId && (status === undefined || entry.status === status))
        .map(entry => this.snapshot(entry))
      return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    })
  }

  async get(ownerId: string, id: string): Promise<DecisionSnapshot | undefined> {
    return await this.enqueue(async () => {
      await this.refreshExpiries(ownerId, id)
      const entry = this.owned(ownerId, id)
      return entry === undefined ? undefined : this.snapshot(entry)
    })
  }

  /**
   * List persisted decisions across all owners, in the persisted record
   * shape and ordering of the state file. Host-level flows (remote sync,
   * bulk tooling) use this instead of the owner-scoped `list`.
   */
  async listAll(status?: DecisionStatus): Promise<PersistedDecision[]> {
    return await this.enqueue(async () => {
      await this.refreshExpiries()
      const result = [...this.entries.values()]
        .filter(entry => status === undefined || entry.status === status)
        .map(entry => this.persistedSnapshot(entry))
      return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    })
  }

  /**
   * Resolve one decision by id alone, across owners. Remote submissions
   * address a decision by id without naming its owning session.
   */
  async findById(id: string): Promise<PersistedDecision | undefined> {
    return await this.enqueue(async () => {
      await this.refreshExpiries(undefined, id)
      const entry = this.entries.get(id)
      return entry === undefined ? undefined : this.persistedSnapshot(entry)
    })
  }

  async answer(ownerId: string, id: string, answer: string, context: DecisionMutationContext = {}): Promise<AnswerDecisionResult> {
    const actor = context.actor ?? 'system'
    const normalized = assertNonEmpty('answer', answer, 8_000)
    return await this.enqueue(async () => {
      await this.refreshExpiries(ownerId, id)
      const entry = this.owned(ownerId, id)
      if (entry === undefined) return { kind: 'not-found' }
      if (entry.status === 'answered') {
        return {
          kind: 'already-answered',
          decision: this.snapshot(entry),
          matchesExisting: entry.answer === normalized,
        }
      }
      if (entry.status !== 'pending') return { kind: 'not-pending', decision: this.snapshot(entry) }

      const nextEntry: DecisionEntry = {
        ...entry,
        status: 'answered',
        deliveryStatus: 'pending',
        answer: normalized,
        answeredAt: this.now(),
        revision: entry.revision + 1,
      }
      const next = new Map(this.entries)
      next.set(id, nextEntry)
      await this.commit(next, 'answer', actor)
      return { kind: 'answered', decision: this.snapshot(nextEntry) }
    })
  }

  async cancel(ownerId: string, id: string, reason?: string, context: DecisionMutationContext = {}): Promise<CancelDecisionResult> {
    const actor = context.actor ?? 'system'
    const cancelReason = reason === undefined || reason.trim() === ''
      ? undefined
      : assertNonEmpty('cancel reason', reason, 1_000)
    return await this.enqueue(async () => {
      await this.refreshExpiries(ownerId, id)
      const entry = this.owned(ownerId, id)
      if (entry === undefined) return { kind: 'not-found' }
      if (entry.status !== 'pending') return { kind: 'not-pending', decision: this.snapshot(entry) }

      const nextEntry: DecisionEntry = {
        ...entry,
        status: 'cancelled',
        deliveryStatus: 'none',
        cancelledAt: this.now(),
        revision: entry.revision + 1,
        ...(cancelReason === undefined ? {} : { cancelReason }),
      }
      const next = new Map(this.entries)
      next.set(id, nextEntry)
      await this.commit(next, 'cancel', actor)
      return { kind: 'cancelled', decision: this.snapshot(nextEntry) }
    })
  }

  /**
   * Bulk-import historical decision records.
   *
   * Every record must satisfy the same invariants as a persisted row, and the
   * whole import is atomic: all records are validated before anything
   * commits, and the merge applies as one state snapshot. Existing ids are
   * never overwritten — identical records count as `unchanged`, different
   * ones either skip (`conflicts`) or fail the import (`onConflict: 'fail'`).
   * Imported records keep their original id, timestamps, and revision.
   * Pending records whose `expiresAt` already passed flip to `expired` right
   * after the import commits, exactly like loaded state; answered records
   * with `deliveryStatus: 'pending'` join the durable outbox and can be
   * retried from their owner's card.
   */
  async importRecords(
    records: readonly PersistedDecision[],
    options: ImportDecisionsOptions = {},
  ): Promise<DecisionImportResult> {
    const onConflict = options.onConflict ?? 'skip'
    const actor = options.actor ?? 'system'
    return await this.enqueue(async () => {
      const next = new Map(this.entries)
      const inserted: DecisionEntry[] = []
      let unchanged = 0
      let conflicts = 0
      for (let index = 0; index < records.length; index++) {
        let entry: DecisionEntry
        try {
          entry = this.validatePersisted(records[index])
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`decision import record ${index + 1} is invalid: ${message}`, { cause: error })
        }
        const existing = next.get(entry.id)
        if (existing === undefined) {
          inserted.push(entry)
          next.set(entry.id, entry)
          continue
        }
        if (sameDecision(existing, entry)) {
          unchanged++
          continue
        }
        if (onConflict === 'fail') {
          throw new Error(`decision import record ${index + 1} conflicts with existing decision ${entry.id}`)
        }
        conflicts++
      }
      if (inserted.length === 0) {
        return { records: records.length, imported: 0, unchanged, conflicts }
      }
      await this.commitImported(inserted, next, actor)
      await this.refreshExpiries()
      return { records: records.length, imported: inserted.length, unchanged, conflicts }
    })
  }

  /** Atomically reserve one durable pending outbox item inside this process. */
  claimDelivery(ownerId: string, id: string): DeliveryClaimResult {
    this.assertInitialized()
    const entry = this.owned(ownerId, id)
    if (entry === undefined
      || entry.status !== 'answered'
      || entry.deliveryStatus !== 'pending'
      || this.deliveryClaims.has(id)) {
      return { kind: 'unavailable' }
    }
    this.deliveryClaims.add(id)
    return { kind: 'claimed', decision: this.snapshot(entry) }
  }

  /** Mark an outbox item delivered only after `agent.steer` has returned. */
  async completeDelivery(ownerId: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      const entry = this.owned(ownerId, id)
      if (entry === undefined
        || !this.deliveryClaims.has(id)
        || entry.status !== 'answered'
        || entry.deliveryStatus !== 'pending') {
        throw new Error(`decision ${id} has no active delivery claim`)
      }
      const nextEntry: DecisionEntry = {
        ...entry,
        deliveryStatus: 'delivered',
        deliveredAt: this.now(),
        revision: entry.revision + 1,
      }
      const next = new Map(this.entries)
      next.set(id, nextEntry)
      await this.commit(next, 'delivery', 'system')
      this.deliveryClaims.delete(id)
    })
  }

  releaseDelivery(ownerId: string, id: string): void {
    this.assertInitialized()
    if (this.owned(ownerId, id)?.deliveryStatus === 'pending') this.deliveryClaims.delete(id)
  }

  private async loadPersisted(): Promise<void> {
    const records = await this.persistence!.load()
    const loaded = new Map<string, DecisionEntry>()
    for (const raw of records) {
      const entry = this.validatePersisted(raw as unknown)
      if (loaded.has(entry.id)) throw new Error(`duplicate persisted decision id: ${entry.id}`)
      loaded.set(entry.id, entry)
    }
    this.entries = loaded
    this.initialized = true
    await this.refreshExpiries()
  }

  /** Write a startup checkpoint event after durable state is loaded. */
  private async loadAndCheckpoint(): Promise<void> {
    await this.loadPersisted()
    if (this.audit === undefined) return
    let pending = 0
    let answered = 0
    let cancelled = 0
    let expired = 0
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending') pending++
      else if (entry.status === 'answered') answered++
      else if (entry.status === 'cancelled') cancelled++
      else expired++
    }
    await this.audit.append([{
      schema: 'decision-audit-event',
      version: 1,
      ts: this.now(),
      actor: 'system',
      type: 'checkpoint',
      decisions: this.entries.size,
      pending,
      answered,
      cancelled,
      expired,
    }])
  }

  private validatePersisted(raw: unknown): DecisionEntry {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('persisted decision must be an object')
    }
    const record = raw as Record<string, unknown>
    const stringField = (name: string, max: number): string => {
      if (typeof record[name] !== 'string') throw new Error(`persisted decision ${name} must be a string`)
      const normalized = assertNonEmpty(`persisted decision ${name}`, record[name] as string, max)
      if (normalized !== record[name]) throw new Error(`persisted decision ${name} must be trimmed`)
      return normalized
    }
    const id = stringField('id', 512)
    const ownerId = stringField('ownerId', 512)
    const question = stringField('question', 4_000)
    if (!Array.isArray(record.options)) throw new Error('persisted decision options must be an array')
    const options = this.validateOptions(record.options.map((option) => {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) {
        throw new Error('persisted decision option must be an object')
      }
      const item = option as Record<string, unknown>
      if (typeof item.label !== 'string') throw new Error('persisted decision option label must be a string')
      if (item.description !== undefined && typeof item.description !== 'string') {
        throw new Error('persisted decision option description must be a string')
      }
      return {
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description as string }),
      }
    }))
    if (!STATUSES.has(record.status as DecisionStatus)) throw new Error(`persisted decision ${id} has invalid status`)
    if (!DELIVERY_STATUSES.has(record.deliveryStatus as DecisionDeliveryStatus)) {
      throw new Error(`persisted decision ${id} has invalid deliveryStatus`)
    }
    const createdAt = optionalInteger(record, 'createdAt')
    const revision = optionalInteger(record, 'revision')
    if (createdAt === undefined) throw new Error(`persisted decision ${id} is missing createdAt`)
    if (revision === undefined || revision < 1) throw new Error(`persisted decision ${id} has invalid revision`)
    const expiresAt = optionalInteger(record, 'expiresAt')
    const answeredAt = optionalInteger(record, 'answeredAt')
    const cancelledAt = optionalInteger(record, 'cancelledAt')
    const deliveredAt = optionalInteger(record, 'deliveredAt')
    const answer = record.answer === undefined ? undefined : stringField('answer', 8_000)
    const cancelReason = record.cancelReason === undefined ? undefined : stringField('cancelReason', 1_000)
    const status = record.status as DecisionStatus
    const deliveryStatus = record.deliveryStatus as DecisionDeliveryStatus

    if (status === 'answered') {
      if (answer === undefined || answeredAt === undefined) throw new Error(`persisted answered decision ${id} is incomplete`)
      if (deliveryStatus === 'none') throw new Error(`persisted answered decision ${id} has no delivery state`)
      if ((deliveryStatus === 'delivered') !== (deliveredAt !== undefined)) {
        throw new Error(`persisted answered decision ${id} has inconsistent delivery state`)
      }
      if (cancelledAt !== undefined || cancelReason !== undefined) throw new Error(`persisted answered decision ${id} is also cancelled`)
    } else {
      if (answer !== undefined || answeredAt !== undefined || deliveredAt !== undefined || deliveryStatus !== 'none') {
        throw new Error(`persisted ${status} decision ${id} contains answer delivery state`)
      }
      if (status === 'cancelled' && cancelledAt === undefined) throw new Error(`persisted cancelled decision ${id} is incomplete`)
      if (status !== 'cancelled' && (cancelledAt !== undefined || cancelReason !== undefined)) {
        throw new Error(`persisted ${status} decision ${id} contains cancellation state`)
      }
      if (status === 'expired' && expiresAt === undefined) throw new Error(`persisted expired decision ${id} has no expiry`)
    }

    return {
      id,
      ownerId,
      question,
      options,
      status,
      deliveryStatus,
      createdAt,
      revision,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(answeredAt === undefined ? {} : { answeredAt }),
      ...(answer === undefined ? {} : { answer }),
      ...(cancelledAt === undefined ? {} : { cancelledAt }),
      ...(cancelReason === undefined ? {} : { cancelReason }),
      ...(deliveredAt === undefined ? {} : { deliveredAt }),
    }
  }

  private async refreshExpiries(ownerId?: string, id?: string): Promise<void> {
    const now = this.now()
    let next: Map<string, DecisionEntry> | undefined
    for (const [entryId, entry] of this.entries) {
      if (ownerId !== undefined && entry.ownerId !== ownerId) continue
      if (id !== undefined && entryId !== id) continue
      if (entry.status !== 'pending' || entry.expiresAt === undefined || entry.expiresAt > now) continue
      next ??= new Map(this.entries)
      next.set(entryId, {
        ...entry,
        status: 'expired',
        deliveryStatus: 'none',
        revision: entry.revision + 1,
      })
    }
    if (next !== undefined) await this.commit(next, 'expiry', 'system')
  }

  private owned(ownerId: string, id: string): DecisionEntry | undefined {
    const entry = this.entries.get(id)
    return entry?.ownerId === ownerId ? entry : undefined
  }

  private validateOptions(input: readonly DecisionOption[]): DecisionOption[] {
    if (input.length > 12) throw new Error('options must contain at most 12 choices')
    const seen = new Set<string>()
    return input.map((option, index) => {
      const label = assertNonEmpty(`options[${index}].label`, option.label, 120)
      if (seen.has(label)) throw new Error(`duplicate option label: ${label}`)
      seen.add(label)
      const description = option.description === undefined || option.description.trim() === ''
        ? undefined
        : assertNonEmpty(`options[${index}].description`, option.description, 500)
      return description === undefined ? { label } : { label, description }
    })
  }

  private snapshot(entry: DecisionEntry): DecisionSnapshot {
    return {
      id: entry.id,
      question: entry.question,
      options: entry.options.map(cloneOption),
      status: entry.status,
      deliveryStatus: entry.deliveryStatus,
      createdAt: entry.createdAt,
      revision: entry.revision,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.answeredAt === undefined ? {} : { answeredAt: entry.answeredAt }),
      ...(entry.answer === undefined ? {} : { answer: entry.answer }),
      ...(entry.cancelledAt === undefined ? {} : { cancelledAt: entry.cancelledAt }),
      ...(entry.cancelReason === undefined ? {} : { cancelReason: entry.cancelReason }),
      ...(entry.deliveredAt === undefined ? {} : { deliveredAt: entry.deliveredAt }),
    }
  }

  private async commit(
    next: Map<string, DecisionEntry>,
    operation: DecisionAuditOperation,
    actor: DecisionAuditActor,
    drafts: readonly DecisionAuditDraft[] = this.auditDrafts(next, actor),
  ): Promise<void> {
    // Audit first: fsync the event stream before the state snapshot is saved,
    // so an applied change can never miss its audit record. If the state save
    // fails, an `aborted` event is appended and the mutation fails.
    if (this.audit !== undefined && drafts.length > 0) {
      await this.audit.append(drafts)
    }
    try {
      if (this.persistence !== undefined) {
        const records = [...next.values()]
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map(entry => this.persistedSnapshot(entry))
        await this.persistence.save(records)
      }
    } catch (error) {
      if (this.audit !== undefined && drafts.length > 0) {
        await this.audit.append([this.abortedDraft(operation, actor, error, drafts)]).catch(() => {})
      }
      throw error
    }
    this.entries = next
  }

  /** Commit inserted import rows with one `imported` audit event per record. */
  private async commitImported(
    inserted: readonly DecisionEntry[],
    next: Map<string, DecisionEntry>,
    actor: DecisionAuditActor,
  ): Promise<void> {
    const ts = this.now()
    const ordered = [...inserted].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const drafts: DecisionAuditDraft[] = ordered.map(entry => ({
      schema: 'decision-audit-event',
      version: 1,
      ts,
      actor,
      type: 'imported',
      decisionId: entry.id,
      ownerId: entry.ownerId,
      revision: entry.revision,
      status: entry.status,
      deliveryStatus: entry.deliveryStatus,
      question: entry.question,
      options: entry.options.map(cloneOption),
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.answer === undefined ? {} : { answer: entry.answer }),
      ...(entry.cancelReason === undefined ? {} : { cancelReason: entry.cancelReason }),
    }))
    await this.commit(next, 'import', actor, drafts)
  }

  /** Derive one audit event per changed entry, ordered like the persisted records. */
  private auditDrafts(next: Map<string, DecisionEntry>, actor: DecisionAuditActor): DecisionAuditDraft[] {
    if (this.audit === undefined) return []
    const ts = this.now()
    const drafts: DecisionAuditDraft[] = []
    const ordered = [...next.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    for (const entry of ordered) {
      const before = this.entries.get(entry.id)
      if (before === undefined) {
        drafts.push({
          schema: 'decision-audit-event',
          version: 1,
          ts,
          actor,
          type: 'created',
          decisionId: entry.id,
          ownerId: entry.ownerId,
          revision: entry.revision,
          question: entry.question,
          options: entry.options.map(cloneOption),
          ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
        })
        continue
      }
      if (before.revision === entry.revision) continue
      const common = {
        schema: 'decision-audit-event',
        version: 1,
        ts,
        actor,
        decisionId: entry.id,
        ownerId: entry.ownerId,
        revision: entry.revision,
      } as const
      if (before.status === 'pending' && entry.status === 'answered' && entry.answer !== undefined) {
        drafts.push({ ...common, type: 'answered', answer: entry.answer })
      } else if (before.status === 'pending' && entry.status === 'cancelled') {
        drafts.push({
          ...common,
          type: 'cancelled',
          ...(entry.cancelReason === undefined ? {} : { cancelReason: entry.cancelReason }),
        })
      } else if (before.status === 'pending' && entry.status === 'expired') {
        drafts.push({ ...common, type: 'expired' })
      } else if (before.status === 'answered' && entry.status === 'answered'
        && before.deliveryStatus === 'pending' && entry.deliveryStatus === 'delivered') {
        drafts.push({ ...common, type: 'delivered' })
      }
    }
    return drafts
  }

  private abortedDraft(
    operation: DecisionAuditOperation,
    actor: DecisionAuditActor,
    error: unknown,
    drafts: readonly DecisionAuditDraft[],
  ): DecisionAuditDraft {
    const decisionIds: string[] = []
    for (const draft of drafts) {
      if (draft.type !== 'checkpoint' && draft.type !== 'aborted') decisionIds.push(draft.decisionId)
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      schema: 'decision-audit-event',
      version: 1,
      ts: this.now(),
      actor,
      type: 'aborted',
      operation,
      reason: message.slice(0, 1_000),
      decisionIds,
    }
  }

  private persistedSnapshot(entry: DecisionEntry): PersistedDecision {
    return {
      ...this.snapshot(entry),
      ownerId: entry.ownerId,
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized()
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('decision runtime is not initialized')
  }
}
