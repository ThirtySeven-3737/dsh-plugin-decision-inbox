import type { DecisionDeliveryStatus, DecisionOption, DecisionStatus } from './runtime.ts'
import type { RpcError, RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

export const DECISION_INBOX_RPC_CHANNEL = '/decision-inbox'

export interface DecisionUiItem {
  id: string
  question: string
  options: DecisionOption[]
  status: DecisionStatus
  deliveryStatus: DecisionDeliveryStatus
  createdAt: number
  revision: number
  expiresAt?: number
  answer?: string
}

export interface DecisionListValue {
  decisions: DecisionUiItem[]
}

/** Audit export payload handed to the browser for download. */
export interface DecisionExportValue {
  filename: string
  mime: string
  text: string
}

export type DecisionAnswerValue =
  | { kind: 'answered'; decision: DecisionUiItem; delivered: boolean }
  | { kind: 'already-answered'; decision: DecisionUiItem; delivered: boolean; matchesExisting: boolean }
  | { kind: 'not-pending'; decision: DecisionUiItem; delivered: false }
  | { kind: 'not-found'; delivered: false }

export type DecisionInboxRpcError = RpcError
export type DecisionInboxRpcResult<T> = RpcResult<T>
