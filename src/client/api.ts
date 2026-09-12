import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  DecisionAnswerValue,
  DecisionExportValue,
  DecisionInboxRpcResult,
  DecisionListValue,
  DecisionUiItem,
} from '../web-contract.ts'
import { DECISION_INBOX_RPC_CHANNEL } from '../web-contract.ts'

export interface DecisionInboxApi {
  list(signal?: AbortSignal): Promise<DecisionUiItem[]>
  answer(id: string, answer: string, signal?: AbortSignal): Promise<DecisionAnswerValue>
  /** Fetch a full audit-log export for download. */
  exportAudit(signal?: AbortSignal): Promise<DecisionExportValue>
}

function carried<T>(value: unknown): T {
  if (value === null || typeof value !== 'object') throw new Error('decision-inbox returned an invalid response')
  const result = value as DecisionInboxRpcResult<T>
  if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
  return result.value
}

export function createDecisionInboxApi(
  connection: ConnectionHandle,
  sessionId: SessionId,
): DecisionInboxApi {
  return {
    async list(signal) {
      const result = await connection.rpc.call(
        DECISION_INBOX_RPC_CHANNEL,
        'list',
        { sessionId },
        signal,
      )
      return carried<DecisionListValue>(result).decisions
    },
    async answer(id, answer, signal) {
      const result = await connection.rpc.call(
        DECISION_INBOX_RPC_CHANNEL,
        'answer',
        { sessionId, id, answer },
        signal,
      )
      return carried<DecisionAnswerValue>(result)
    },
    async exportAudit(signal) {
      const result = await connection.rpc.call(
        DECISION_INBOX_RPC_CHANNEL,
        'export',
        { sessionId },
        signal,
      )
      return carried<DecisionExportValue>(result)
    },
  }
}
