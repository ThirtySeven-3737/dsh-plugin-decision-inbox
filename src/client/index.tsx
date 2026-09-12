import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createDecisionInboxApi } from './api.ts'
import { DecisionInboxDock } from './DecisionInboxDock.tsx'
import { DECISION_INBOX_CSS } from './styles.ts'

export { createDecisionInboxApi } from './api.ts'
export type { DecisionInboxApi } from './api.ts'
export { DecisionInboxDock } from './DecisionInboxDock.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const existing = document.querySelector('style[data-plugin="dsh-decision-inbox"]')
    if (existing !== null) return () => {}
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-decision-inbox'
    style.textContent = DECISION_INBOX_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'decision-inbox: styles')

  const connection = ctx.get('connection') as unknown as ConnectionHandle
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'decision-inbox',
    order: 5,
    inject: (sessionId: SessionId) => ({ api: createDecisionInboxApi(connection, sessionId) }),
  }, DecisionInboxDock))
}
