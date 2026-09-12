import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createDecisionInboxApi } from '../src/client/api.ts'

describe('decision inbox browser API', () => {
  it('addresses list and answer calls to the bound session on the private channel', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { decisions: [] } })
      .mockResolvedValueOnce({ ok: true, value: { kind: 'not-found', delivered: false } })
    const connection = { rpc: { call } } as unknown as ConnectionHandle
    const api = createDecisionInboxApi(connection, 'session-ui' as SessionId)

    await expect(api.list()).resolves.toEqual([])
    await expect(api.answer('decision-1', 'JSON')).resolves.toEqual({ kind: 'not-found', delivered: false })
    expect(call.mock.calls).toEqual([
      ['/decision-inbox', 'list', { sessionId: 'session-ui' }, undefined],
      ['/decision-inbox', 'answer', { sessionId: 'session-ui', id: 'decision-1', answer: 'JSON' }, undefined],
    ])
  })

  it('turns a transport error into a user-facing failure', async () => {
    const connection = {
      rpc: {
        call: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'session-not-found', message: 'gone', details: { sessionId: 'gone' } },
        }),
      },
    } as unknown as ConnectionHandle
    const api = createDecisionInboxApi(connection, 'gone' as SessionId)

    await expect(api.list()).rejects.toThrow('gone (session-not-found)')
  })

  it('requests an audit export for the bound session', async () => {
    const file = { filename: 'decision-inbox-audit.csv', mime: 'text/csv;charset=utf-8', text: 'seq\n' }
    const call = vi.fn().mockResolvedValue({ ok: true, value: file })
    const connection = { rpc: { call } } as unknown as ConnectionHandle
    const api = createDecisionInboxApi(connection, 'session-ui' as SessionId)

    await expect(api.exportAudit()).resolves.toEqual(file)
    expect(call.mock.calls).toEqual([
      ['/decision-inbox', 'export', { sessionId: 'session-ui' }, undefined],
    ])
  })
})
