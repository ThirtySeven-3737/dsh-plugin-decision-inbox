import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { answerAndDeliver } from './delivery.ts'
import { DecisionRuntime, type DecisionSnapshot } from './runtime.ts'
import type {
  DecisionAnswerValue,
  DecisionExportValue,
  DecisionInboxRpcResult,
  DecisionListValue,
  DecisionUiItem,
} from './web-contract.ts'

export type DecisionAgentResolver = (sessionId: string) => Agent | undefined

/** Optional host-side providers; `exportAudit` enables the `export` endpoint. */
export interface DecisionInboxRpcProviders {
  exportAudit?: () => Promise<DecisionExportValue>
}

function uiItem(decision: DecisionSnapshot): DecisionUiItem {
  return {
    id: decision.id,
    question: decision.question,
    options: decision.options,
    status: decision.status,
    deliveryStatus: decision.deliveryStatus,
    createdAt: decision.createdAt,
    revision: decision.revision,
    ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
    ...(decision.answer === undefined ? {} : { answer: decision.answer }),
  }
}

function objectPayload(payload: unknown): Record<string, unknown> | undefined {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined
}

function requiredString(payload: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const value = payload[name]
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) return undefined
  return value
}

function badRequest(message: string): DecisionInboxRpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function cancelled(): DecisionInboxRpcResult<never> {
  return { ok: false, error: { code: 'cancelled', message: 'decision request was cancelled', details: {} } }
}

function sessionNotFound(sessionId: string): DecisionInboxRpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'session-not-found',
      message: `session not found: ${sessionId}`,
      details: { sessionId: sessionId as SessionId },
    },
  }
}

function internal(error: unknown): DecisionInboxRpcResult<never> {
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

/** Transport-independent handler for the browser decision card. */
export async function handleDecisionInboxRpc(
  runtime: DecisionRuntime,
  resolveAgent: DecisionAgentResolver,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  providers: DecisionInboxRpcProviders = {},
): Promise<DecisionInboxRpcResult<DecisionListValue | DecisionAnswerValue | DecisionExportValue>> {
  if (signal.aborted) return cancelled()
  const input = objectPayload(payload)
  if (input === undefined) return badRequest('request payload must be an object')
  const sessionId = requiredString(input, 'sessionId', 512)
  if (sessionId === undefined) return badRequest('sessionId must be a non-empty string')
  const agent = resolveAgent(sessionId)
  if (agent === undefined) return sessionNotFound(sessionId)

  try {
    if (endpoint === 'list') {
      const decisions = (await runtime.list(String(agent.id)))
        .filter(decision => decision.status === 'pending'
          || (decision.status === 'answered' && decision.deliveryStatus === 'pending'))
        .map(uiItem)
      return { ok: true, value: { decisions } }
    }
    if (endpoint === 'answer') {
      const id = requiredString(input, 'id', 512)
      const answer = requiredString(input, 'answer', 8_000)
      if (id === undefined || answer === undefined) {
        return badRequest('id and answer must be non-empty strings')
      }
      const result = await answerAndDeliver(runtime, agent, id, answer)
      switch (result.answer.kind) {
        case 'answered':
          return { ok: true, value: { kind: 'answered', decision: uiItem(result.answer.decision), delivered: result.delivered } }
        case 'already-answered':
          return {
            ok: true,
            value: {
              kind: 'already-answered',
              decision: uiItem(result.answer.decision),
              matchesExisting: result.answer.matchesExisting,
              delivered: result.delivered,
            },
          }
        case 'not-pending':
          return { ok: true, value: { kind: 'not-pending', decision: uiItem(result.answer.decision), delivered: false } }
        case 'not-found':
          return { ok: true, value: { kind: 'not-found', delivered: false } }
      }
    }
    if (endpoint === 'export') {
      if (providers.exportAudit === undefined) return badRequest('audit export is not available on this host')
      return { ok: true, value: await providers.exportAudit() }
    }
    return badRequest(`unknown decision-inbox endpoint: ${endpoint}`)
  } catch (error) {
    return internal(error)
  }
}
