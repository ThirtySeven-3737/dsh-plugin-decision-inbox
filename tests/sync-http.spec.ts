import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DecisionRuntime } from '../src/runtime.ts'
import {
  DECISION_ANSWER_SCHEMA,
  DECISION_ANSWER_VERSION,
  DECISION_CANCEL_SCHEMA,
  DECISION_CANCEL_VERSION,
  DECISION_SYNC_SCHEMA,
  DECISION_SYNC_VERSION,
} from '../src/sync.ts'
import {
  DECISION_INBOX_ANSWER_PATH,
  DECISION_INBOX_CANCEL_PATH,
  DECISION_INBOX_SYNC_PATH,
  assertSyncTrustedAuthority,
  handleSyncHttp,
  isTrustedSyncRequest,
  readSyncBody,
  type SyncHttpDeps,
} from '../src/sync-http.ts'

function fixture() {
  const runtime = new DecisionRuntime({
    idFactory: (() => {
      let id = 0
      return () => `decision-http-${++id}`
    })(),
  })
  return { runtime }
}

function fakeAgent(id = 'session-1', steer = vi.fn()): Agent {
  return { id, steer } as unknown as Agent
}

function deps(runtime: DecisionRuntime, extra: Partial<SyncHttpDeps> = {}): SyncHttpDeps {
  return { runtime, resolveAgent: () => undefined, ...extra }
}

const loopback = { host: '127.0.0.1:3080' }

function request(partial: Record<string, unknown>): {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
} {
  return {
    method: partial.method as string ?? 'GET',
    path: partial.path as string ?? DECISION_INBOX_SYNC_PATH,
    headers: { host: '127.0.0.1:3080', ...partial.headers as Record<string, string> },
    ...(partial.body === undefined ? {} : { body: partial.body as string }),
  }
}

describe('sync trust fence', () => {
  it('accepts loopback authorities without configuration', () => {
    expect(isTrustedSyncRequest({ host: '127.0.0.1:3080' }, [])).toBe(true)
    expect(isTrustedSyncRequest({ host: 'localhost' }, [])).toBe(true)
    expect(isTrustedSyncRequest({ host: '[::1]:3080' }, [])).toBe(true)
    expect(isTrustedSyncRequest({ host: '127.9.9.9' }, [])).toBe(true)
  })

  it('refuses non-loopback hosts unless declared, with port-exact semantics', () => {
    expect(isTrustedSyncRequest({ host: '192.168.1.5:3080' }, [])).toBe(false)
    expect(isTrustedSyncRequest({ host: '192.168.1.5:3080' }, ['192.168.1.5'])).toBe(true)
    expect(isTrustedSyncRequest({ host: '192.168.1.5:9999' }, ['192.168.1.5'])).toBe(true)
    expect(isTrustedSyncRequest({ host: '192.168.1.5:3080' }, ['192.168.1.5:3080'])).toBe(true)
    expect(isTrustedSyncRequest({ host: '192.168.1.5:9999' }, ['192.168.1.5:3080'])).toBe(false)
    expect(isTrustedSyncRequest({ host: 'harness.internal' }, ['harness.internal'])).toBe(true)
  })

  it('refuses browser cross-site markers and mismatched origins', () => {
    expect(isTrustedSyncRequest({ host: '192.168.1.5', 'sec-fetch-site': 'cross-site' }, ['192.168.1.5'])).toBe(false)
    expect(isTrustedSyncRequest(
      { host: 'harness.lan', origin: 'http://harness.lan' },
      ['harness.lan'],
    )).toBe(true)
    expect(isTrustedSyncRequest(
      { host: 'harness.lan', origin: 'http://evil.example' },
      ['harness.lan'],
    )).toBe(false)
    expect(isTrustedSyncRequest({ host: 'harness.lan', origin: 'null' }, ['harness.lan'])).toBe(false)
  })

  it('refuses missing or unparsable hosts', () => {
    expect(isTrustedSyncRequest({}, [])).toBe(false)
    expect(isTrustedSyncRequest({ host: 'bad port:99999' }, [])).toBe(false)
  })

  it('validates trustedHosts entries at load time', () => {
    expect(() => assertSyncTrustedAuthority('harness.internal')).not.toThrow()
    expect(() => assertSyncTrustedAuthority('harness.internal:3080')).not.toThrow()
    expect(() => assertSyncTrustedAuthority('192.168.1.5:80')).not.toThrow()
    expect(() => assertSyncTrustedAuthority('harness.internal/path')).toThrow(/bare host\[:port\] authority/)
    expect(() => assertSyncTrustedAuthority('user@harness.internal')).toThrow(/bare host\[:port\] authority/)
    expect(() => assertSyncTrustedAuthority('harness.internal:99999')).toThrow(/bare host\[:port\] authority/)
    expect(() => assertSyncTrustedAuthority('harness.internal:3080 ')).toThrow(/bare host\[:port\] authority/)
  })
})

describe('sync bearer token', () => {
  it('requires the token when configured and accepts it when presented', async () => {
    const { runtime } = fixture()
    const withToken = { ...deps(runtime), token: 's3cret' }

    const missing = await handleSyncHttp(withToken, request({}))
    expect(missing.status).toBe(401)
    expect(missing.json).toMatchObject({ error: { code: 'unauthorized' } })

    const wrong = await handleSyncHttp(withToken, request({ headers: { authorization: 'Bearer nope' } }))
    expect(wrong.status).toBe(401)

    const right = await handleSyncHttp(withToken, request({ headers: { authorization: 'Bearer s3cret' } }))
    expect(right.status).toBe(200)
  })
})

describe('sync snapshot route', () => {
  it('serves the actionable snapshot as the versioned document', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'A?' })
    await runtime.create({ ownerId: 'session-b', question: 'B?' })
    await runtime.answer('session-a', 'decision-http-1', 'yes')

    const outcome = await handleSyncHttp(deps(runtime), request({}))

    expect(outcome.status).toBe(200)
    expect(outcome.json).toEqual({
      schema: DECISION_SYNC_SCHEMA,
      version: DECISION_SYNC_VERSION,
      exportedAt: expect.any(Number),
      decisions: [
        expect.objectContaining({ id: 'decision-http-1', status: 'answered', deliveryStatus: 'pending' }),
        expect.objectContaining({ id: 'decision-http-2', status: 'pending' }),
      ],
    })
  })

  it('refuses non-trusted hosts with 403 and wrong methods with 405', async () => {
    const { runtime } = fixture()

    const forbidden = await handleSyncHttp(deps(runtime), request({ headers: { host: 'evil.example' } }))
    expect(forbidden.status).toBe(403)

    const wrongMethod = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_SYNC_PATH, headers: loopback, body: '{}' },
    )
    expect(wrongMethod.status).toBe(405)
  })

  it('answers 404 for unknown routes', async () => {
    const { runtime } = fixture()
    const outcome = await handleSyncHttp(deps(runtime), request({ path: '/decision-inbox/other' }))
    expect(outcome.status).toBe(404)
  })
})

describe('sync answer route', () => {
  function answerBody(id: string, answer: string): string {
    return JSON.stringify({ schema: DECISION_ANSWER_SCHEMA, version: DECISION_ANSWER_VERSION, id, answer })
  }

  it('answers with the persisted record and delivered state', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Format?' })
    const steer = vi.fn()
    const live = deps(runtime, {
      resolveAgent: ownerId => ownerId === 'session-a' ? fakeAgent('session-a', steer) : undefined,
    })

    const outcome = await handleSyncHttp(
      live,
      { method: 'POST', path: DECISION_INBOX_ANSWER_PATH, headers: loopback, body: answerBody('decision-http-1', 'JSON') },
    )

    expect(outcome.status).toBe(200)
    expect(outcome.json).toMatchObject({
      kind: 'answered',
      delivered: true,
      decision: { id: 'decision-http-1', ownerId: 'session-a', status: 'answered', deliveryStatus: 'delivered' },
    })
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('commits without delivery when the owning agent is offline', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-gone', question: 'While away?' })

    const outcome = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_ANSWER_PATH, headers: loopback, body: answerBody('decision-http-1', 'later') },
    )

    expect(outcome.status).toBe(200)
    expect(outcome.json).toMatchObject({
      kind: 'answered',
      delivered: false,
      decision: { status: 'answered', deliveryStatus: 'pending', answer: 'later' },
    })
  })

  it('maps not-found to 404 and not-pending to 409', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Cancelled?' })
    await runtime.cancel('session-a', 'decision-http-1')

    const missing = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_ANSWER_PATH, headers: loopback, body: answerBody('decision-http-404', 'no') },
    )
    expect(missing.status).toBe(404)
    expect(missing.json).toMatchObject({ error: { code: 'not-found' } })

    const late = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_ANSWER_PATH, headers: loopback, body: answerBody('decision-http-1', 'no') },
    )
    expect(late.status).toBe(409)
    expect(late.json).toMatchObject({ error: { code: 'not-pending' } })
  })

  it('rejects malformed bodies with 400 without touching the runtime', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Safe?' })
    const post = (body: string | undefined) => handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_ANSWER_PATH, headers: loopback, ...(body === undefined ? {} : { body }) },
    )

    expect((await post(undefined)).status).toBe(400)
    expect((await post('not json')).status).toBe(400)
    expect((await post(JSON.stringify({ schema: DECISION_ANSWER_SCHEMA, version: 9, id: 'x', answer: 'y' }))).status).toBe(400)
    expect((await post(JSON.stringify({ schema: DECISION_ANSWER_SCHEMA, version: 1, id: ' ', answer: 'y' }))).status).toBe(400)

    expect(await runtime.findById('decision-http-1')).toMatchObject({ status: 'pending' })
  })
})

describe('sync cancel route', () => {
  function cancelBody(id: string, reason?: string): string {
    return JSON.stringify({
      schema: DECISION_CANCEL_SCHEMA,
      version: DECISION_CANCEL_VERSION,
      id,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  it('cancels by decision id alone', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-b', question: 'Keep?' })

    const outcome = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_CANCEL_PATH, headers: loopback, body: cancelBody('decision-http-1', 'obsolete') },
    )

    expect(outcome.status).toBe(200)
    expect(outcome.json).toMatchObject({
      kind: 'cancelled',
      decision: { id: 'decision-http-1', status: 'cancelled', cancelReason: 'obsolete' },
    })
  })

  it('maps not-found to 404 and not-pending to 409', async () => {
    const { runtime } = fixture()
    await runtime.create({ ownerId: 'session-a', question: 'Done?' })
    await runtime.answer('session-a', 'decision-http-1', 'yes')

    const missing = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_CANCEL_PATH, headers: loopback, body: cancelBody('decision-http-404') },
    )
    expect(missing.status).toBe(404)

    const late = await handleSyncHttp(
      deps(runtime),
      { method: 'POST', path: DECISION_INBOX_CANCEL_PATH, headers: loopback, body: cancelBody('decision-http-1') },
    )
    expect(late.status).toBe(409)
  })

  it('rejects a wrong wrapper document with 400', async () => {
    const { runtime } = fixture()
    const outcome = await handleSyncHttp(
      deps(runtime),
      {
        method: 'POST',
        path: DECISION_INBOX_CANCEL_PATH,
        headers: loopback,
        body: JSON.stringify({ schema: DECISION_ANSWER_SCHEMA, version: 1, id: 'x', answer: 'y' }),
      },
    )
    expect(outcome.status).toBe(400)
  })
})

describe('sync body buffering', () => {
  it('returns the full text when under the cap', async () => {
    const result = await readSyncBody(Readable.from(['{"a":', '1}']) as never, 64)
    expect(result).toEqual({ kind: 'ok', text: '{"a":1}' })
  })

  it('reports too-large once the cap is exceeded', async () => {
    const result = await readSyncBody(Readable.from(['123456789']) as never, 4)
    expect(result).toEqual({ kind: 'too-large', limit: 4 })
  })
})
