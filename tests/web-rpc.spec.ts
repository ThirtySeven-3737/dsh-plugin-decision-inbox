import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DecisionRuntime } from '../src/runtime.ts'
import { handleDecisionInboxRpc } from '../src/web-rpc.ts'

function agent(id: string, steer = vi.fn()): Agent {
  return { id, steer } as unknown as Agent
}

describe('decision inbox Web RPC', () => {
  it('lists only actionable decisions owned by the addressed session', async () => {
    const runtime = new DecisionRuntime({
      idFactory: (() => {
        let id = 0
        return () => `decision-web-${++id}`
      })(),
    })
    await runtime.create({ ownerId: 'session-a', question: 'A?', options: [{ label: 'yes' }] })
    await runtime.create({ ownerId: 'session-b', question: 'B?' })
    const current = agent('session-a')

    const result = await handleDecisionInboxRpc(
      runtime,
      id => id === 'session-a' ? current : undefined,
      'list',
      { sessionId: 'session-a' },
      new AbortController().signal,
    )

    expect(result).toEqual({
      ok: true,
      value: {
        decisions: [expect.objectContaining({
          id: 'decision-web-1',
          question: 'A?',
          options: [{ label: 'yes' }],
          status: 'pending',
        })],
      },
    })
  })

  it('answers from a button without a slash command and steers exactly once', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-web-answer' })
    await runtime.create({ ownerId: 'session-a', question: 'Format?', options: [{ label: 'JSON' }] })
    const steer = vi.fn()
    const current = agent('session-a', steer)
    const resolve = (id: string) => id === 'session-a' ? current : undefined
    const signal = new AbortController().signal

    const first = await handleDecisionInboxRpc(runtime, resolve, 'answer', {
      sessionId: 'session-a', id: 'decision-web-answer', answer: 'JSON',
    }, signal)
    const duplicate = await handleDecisionInboxRpc(runtime, resolve, 'answer', {
      sessionId: 'session-a', id: 'decision-web-answer', answer: 'JSON',
    }, signal)

    expect(first).toMatchObject({ ok: true, value: { kind: 'answered', delivered: true } })
    expect(duplicate).toMatchObject({
      ok: true,
      value: { kind: 'already-answered', matchesExisting: true, delivered: false },
    })
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('keeps an answer visible as retryable when steering fails', async () => {
    const runtime = new DecisionRuntime({ idFactory: () => 'decision-web-retry' })
    await runtime.create({ ownerId: 'session-a', question: 'Ship?', options: [{ label: 'yes' }] })
    const current = agent('session-a', vi.fn(() => { throw new Error('steer unavailable') }))
    const resolve = () => current
    const signal = new AbortController().signal

    const answer = await handleDecisionInboxRpc(runtime, resolve, 'answer', {
      sessionId: 'session-a', id: 'decision-web-retry', answer: 'yes',
    }, signal)
    const list = await handleDecisionInboxRpc(runtime, resolve, 'list', { sessionId: 'session-a' }, signal)

    expect(answer).toMatchObject({ ok: false, error: { code: 'internal', message: 'steer unavailable' } })
    expect(list).toMatchObject({
      ok: true,
      value: { decisions: [{ status: 'answered', deliveryStatus: 'pending', answer: 'yes' }] },
    })
  })

  it('rejects malformed, cancelled, and unknown-session calls', async () => {
    const runtime = new DecisionRuntime()
    const aborted = new AbortController()
    aborted.abort()

    await expect(handleDecisionInboxRpc(runtime, () => undefined, 'list', null, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handleDecisionInboxRpc(runtime, () => undefined, 'list', { sessionId: 'missing' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    await expect(handleDecisionInboxRpc(runtime, () => undefined, 'list', { sessionId: 'x' }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('exports the audit log through the export endpoint', async () => {
    const runtime = new DecisionRuntime()
    const current = agent('session-a')
    const file = {
      filename: 'decision-inbox-audit.csv',
      mime: 'text/csv;charset=utf-8',
      text: 'seq,ts\n1,2\n',
    }
    const exportAudit = vi.fn().mockResolvedValue(file)

    const result = await handleDecisionInboxRpc(
      runtime,
      id => id === 'session-a' ? current : undefined,
      'export',
      { sessionId: 'session-a' },
      new AbortController().signal,
      { exportAudit },
    )

    expect(result).toEqual({ ok: true, value: file })
    expect(exportAudit).toHaveBeenCalledTimes(1)
  })

  it('rejects the export endpoint without a provider or a session', async () => {
    const runtime = new DecisionRuntime()
    const current = agent('session-a')

    await expect(handleDecisionInboxRpc(
      runtime,
      id => id === 'session-a' ? current : undefined,
      'export',
      { sessionId: 'session-a' },
      new AbortController().signal,
    )).resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(handleDecisionInboxRpc(
      runtime,
      () => undefined,
      'export',
      { sessionId: 'missing' },
      new AbortController().signal,
      { exportAudit: vi.fn() },
    )).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })
})
