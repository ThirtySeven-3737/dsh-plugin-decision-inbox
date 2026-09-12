/**
 * Remote sync surface for `dsh-decision-inbox`.
 *
 * A transport-independent core for long-term remote-tool integration: a
 * versioned snapshot document that external tools pull to see actionable
 * decisions, plus strict parsers and application helpers for remotely
 * submitted answers and cancellations. The transport (host HTTP routes, a
 * standalone listener, or a shared directory) is composed on top of this
 * module; the documents and result shapes below are the stable contract.
 *
 * Documents:
 * - `decision-inbox-sync` v1 (pull): one wrapper document
 *   `{"schema":"decision-inbox-sync","version":1,"exportedAt":<epoch ms>,
 *   "decisions":[...]}`. Records use exactly the persisted decision shape of
 *   the import format (`id`, `ownerId`, `question`, `options`, `status`,
 *   `deliveryStatus`, `createdAt`, `revision`, plus the optional lifecycle
 *   fields). The snapshot carries every `pending` decision and every
 *   `answered` decision whose delivery is still `pending`, across all
 *   sessions.
 * - `decision-inbox-answer` v1 (submit):
 *   `{"schema":"decision-inbox-answer","version":1,"id":"<id>","answer":"<text>"}`.
 * - `decision-inbox-cancel` v1 (submit):
 *   `{"schema":"decision-inbox-cancel","version":1,"id":"<id>","reason":"<optional text>"}`.
 *
 * Parsing is strict, like the import format: a wrong schema/version or a
 * malformed field throws with a descriptive message instead of silently
 * misapplying a remote submission.
 *
 * @module dsh-decision-inbox/sync
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { answerAndDeliver, type AnswerAndDeliverResult } from './delivery.ts'
import { DecisionRuntime, type DecisionSnapshot, type PersistedDecision } from './runtime.ts'

export const DECISION_SYNC_SCHEMA = 'decision-inbox-sync'
export const DECISION_SYNC_VERSION = 1

export const DECISION_ANSWER_SCHEMA = 'decision-inbox-answer'
export const DECISION_ANSWER_VERSION = 1

export const DECISION_CANCEL_SCHEMA = 'decision-inbox-cancel'
export const DECISION_CANCEL_VERSION = 1

/** Pull snapshot: actionable decisions in the persisted record shape. */
export interface SyncSnapshot {
  schema: typeof DECISION_SYNC_SCHEMA
  version: typeof DECISION_SYNC_VERSION
  exportedAt: number
  decisions: PersistedDecision[]
}

/** Parsed remote answer submission. */
export interface RemoteAnswerRequest {
  id: string
  answer: string
}

/** Parsed remote cancellation submission. */
export interface RemoteCancelRequest {
  id: string
  reason?: string
}

/**
 * Resolves the live owning agent for a persisted `ownerId`; returns
 * `undefined` when the session is not live in this process (the answer still
 * commits durably and joins the outbox for later delivery).
 */
export type SyncAgentResolver = (ownerId: string) => Agent | undefined

export type RemoteAnswerResult =
  | { kind: 'answered'; decision: DecisionSnapshot; delivered: boolean }
  | { kind: 'already-answered'; decision: DecisionSnapshot; matchesExisting: boolean; delivered: boolean }
  | { kind: 'not-pending'; decision: DecisionSnapshot; delivered: false }
  | { kind: 'not-found'; delivered: false }

export type RemoteCancelResult =
  | { kind: 'cancelled'; decision: DecisionSnapshot }
  | { kind: 'not-pending'; decision: DecisionSnapshot }
  | { kind: 'not-found' }

function assertDocument(
  value: unknown,
  schema: string,
  version: number,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a ${schema} document`)
  }
  const document = value as Record<string, unknown>
  if (document.schema !== schema) {
    throw new Error(`${label} has unexpected schema ${JSON.stringify(document.schema)}; expected ${schema}`)
  }
  if (document.version !== version) {
    throw new Error(`${label} has unsupported version ${String(document.version)}; expected ${version}`)
  }
  return document
}

function requiredText(
  document: Record<string, unknown>,
  name: string,
  maxLength: number,
  label: string,
): string {
  const value = document[name]
  if (typeof value !== 'string') throw new Error(`${label} ${name} must be a string`)
  if (value.trim() === '') throw new Error(`${label} ${name} must not be empty`)
  if (value.length > maxLength) {
    throw new Error(`${label} ${name} must be at most ${maxLength} characters`)
  }
  return value
}

/**
 * Build the pull snapshot: every pending decision plus answered decisions
 * still waiting for delivery, across all owners, as persisted records.
 */
export async function buildSyncSnapshot(
  runtime: DecisionRuntime,
  now: () => number = () => Date.now(),
): Promise<SyncSnapshot> {
  const decisions = (await runtime.listAll())
    .filter(decision => decision.status === 'pending'
      || (decision.status === 'answered' && decision.deliveryStatus === 'pending'))
  return {
    schema: DECISION_SYNC_SCHEMA,
    version: DECISION_SYNC_VERSION,
    exportedAt: now(),
    decisions,
  }
}

/** Parse and validate a remote answer submission. */
export function parseRemoteAnswer(payload: unknown): RemoteAnswerRequest {
  const document = assertDocument(payload, DECISION_ANSWER_SCHEMA, DECISION_ANSWER_VERSION, 'decision-inbox-answer')
  return {
    id: requiredText(document, 'id', 512, 'decision-inbox-answer'),
    answer: requiredText(document, 'answer', 8_000, 'decision-inbox-answer'),
  }
}

/** Parse and validate a remote cancellation submission. */
export function parseRemoteCancel(payload: unknown): RemoteCancelRequest {
  const document = assertDocument(payload, DECISION_CANCEL_SCHEMA, DECISION_CANCEL_VERSION, 'decision-inbox-cancel')
  const id = requiredText(document, 'id', 512, 'decision-inbox-cancel')
  if (document.reason === undefined) return { id }
  const reason = document.reason
  if (typeof reason !== 'string' || reason.length > 1_000) {
    throw new Error('decision-inbox-cancel reason must be a string of at most 1000 characters')
  }
  return { id, reason }
}

function toRemoteAnswerResult(result: AnswerAndDeliverResult): RemoteAnswerResult {
  switch (result.answer.kind) {
    case 'answered':
      return { kind: 'answered', decision: result.answer.decision, delivered: result.delivered }
    case 'already-answered':
      return {
        kind: 'already-answered',
        decision: result.answer.decision,
        matchesExisting: result.answer.matchesExisting,
        delivered: result.delivered,
      }
    case 'not-pending':
      return { kind: 'not-pending', decision: result.answer.decision, delivered: false }
    case 'not-found':
      return { kind: 'not-found', delivered: false }
  }
}

/**
 * Apply an answer submitted by a remote tool, addressed by decision id alone.
 *
 * The answer commits durably first, exactly like a Web card answer. When the
 * owning agent is live it is steered in-process and `delivered` is `true`;
 * when it is not, the answer stays in the durable outbox (`deliveryStatus:
 * 'pending'`) for later retry and `delivered` is `false`. A duplicate
 * submission with the same answer is not delivered twice.
 */
export async function applyRemoteAnswer(
  runtime: DecisionRuntime,
  resolveAgent: SyncAgentResolver,
  id: string,
  answer: string,
): Promise<RemoteAnswerResult> {
  const found = await runtime.findById(id)
  if (found === undefined) return { kind: 'not-found', delivered: false }
  const agent = resolveAgent(found.ownerId)
  if (agent === undefined) {
    const result = await runtime.answer(found.ownerId, id, answer, { actor: 'user' })
    return toRemoteAnswerResult({ answer: result, delivered: false })
  }
  return toRemoteAnswerResult(await answerAndDeliver(runtime, agent, id, answer))
}

/** Apply a cancellation submitted by a remote tool, addressed by decision id alone. */
export async function applyRemoteCancel(
  runtime: DecisionRuntime,
  id: string,
  reason?: string,
): Promise<RemoteCancelResult> {
  const found = await runtime.findById(id)
  if (found === undefined) return { kind: 'not-found' }
  return await runtime.cancel(found.ownerId, id, reason, { actor: 'user' })
}
