import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DecisionRuntime, type AnswerDecisionResult, type DecisionSnapshot } from './runtime.ts'

function ownerId(agent: Agent): string {
  return String(agent.id)
}

function answerMessage(decision: DecisionSnapshot) {
  const text = [
    'The user answered a previously requested non-blocking decision.',
    `decision_id: ${decision.id}`,
    `question: ${JSON.stringify(decision.question)}`,
    `answer: ${JSON.stringify(decision.answer)}`,
    'This delivery may be a retry after process recovery. Treat decision_id as an idempotency key and do not repeat side effects already applied for it.',
    'Apply this answer to the remaining work. Do not ask the same decision again.',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

export interface AnswerAndDeliverResult {
  answer: AnswerDecisionResult
  delivered: boolean
}

/** Commit an answer and steer it to its exact owning agent once. */
export async function answerAndDeliver(
  runtime: DecisionRuntime,
  agent: Agent,
  id: string,
  answer: string,
): Promise<AnswerAndDeliverResult> {
  const owner = ownerId(agent)
  const result = await runtime.answer(owner, id, answer, { actor: 'user' })
  const shouldTryDelivery = result.kind === 'answered'
    || (result.kind === 'already-answered' && result.matchesExisting)
  if (!shouldTryDelivery) return { answer: result, delivered: false }

  const claim = runtime.claimDelivery(owner, id)
  if (claim.kind !== 'claimed') return { answer: result, delivered: false }
  try {
    agent.steer(answerMessage(claim.decision))
    await runtime.completeDelivery(owner, id)
  } catch (error) {
    runtime.releaseDelivery(owner, id)
    throw error
  }
  return { answer: result, delivered: true }
}
