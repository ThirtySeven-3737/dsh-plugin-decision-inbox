import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import DecisionInboxService, { type Config } from '../src/index.ts'
import {
  DECISION_ANSWER_SCHEMA,
  DECISION_ANSWER_VERSION,
  DECISION_CANCEL_SCHEMA,
  DECISION_CANCEL_VERSION,
  DECISION_SYNC_SCHEMA,
  DECISION_SYNC_VERSION,
} from '../src/sync.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

async function setup(sync?: Config['sync']): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(DecisionInboxService, { ...(sync === undefined ? {} : { sync }) })
  contexts.add(ctx)
  return ctx
}

function url(ctx: Context, path: string): string {
  return `http://127.0.0.1:${ctx.webServer.port}${path}`
}

describe('sync HTTP end-to-end (real web server)', () => {
  it('serves the snapshot, answers, and cancels over real HTTP', async () => {
    const ctx = await setup()
    await ctx.decisionInbox.runtime.create({ ownerId: 'session-1', question: 'Real HTTP?' })
    await ctx.decisionInbox.runtime.create({ ownerId: 'session-2', question: 'Cancel over HTTP?' })

    const snapshot = await fetch(url(ctx, '/decision-inbox/sync'))
    expect(snapshot.status).toBe(200)
    expect(snapshot.headers.get('content-type')).toContain('application/json')
    const document = await snapshot.json() as {
      schema: string
      version: number
      decisions: { id: string; ownerId: string; status: string }[]
    }
    expect(document.schema).toBe(DECISION_SYNC_SCHEMA)
    expect(document.version).toBe(DECISION_SYNC_VERSION)
    expect(document.decisions).toHaveLength(2)

    const answer = await fetch(url(ctx, '/decision-inbox/sync/answer'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: DECISION_ANSWER_SCHEMA,
        version: DECISION_ANSWER_VERSION,
        id: document.decisions[0]!.id,
        answer: 'yes',
      }),
    })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({
      kind: 'answered',
      delivered: false, // no agent registry in this composition: durable outbox
      decision: { status: 'answered', deliveryStatus: 'pending', answer: 'yes' },
    })

    const cancel = await fetch(url(ctx, '/decision-inbox/sync/cancel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: DECISION_CANCEL_SCHEMA,
        version: DECISION_CANCEL_VERSION,
        id: document.decisions[1]!.id,
        reason: 'done',
      }),
    })
    expect(cancel.status).toBe(200)
    expect(await cancel.json()).toMatchObject({
      kind: 'cancelled',
      decision: { status: 'cancelled', cancelReason: 'done' },
    })

    // The cancelled item is gone; the answered one stays actionable because
    // delivery never completed (no agent registry in this composition) — the
    // durable outbox keeps it in the snapshot for retry.
    const after = await fetch(url(ctx, '/decision-inbox/sync')).then(response => response.json()) as {
      decisions: { id: string; status: string; deliveryStatus: string }[]
    }
    expect(after.decisions).toHaveLength(1)
    expect(after.decisions[0]).toMatchObject({ status: 'answered', deliveryStatus: 'pending' })
  })

  it('enforces the bearer token when configured', async () => {
    const ctx = await setup({ token: 's3cret' })

    const missing = await fetch(url(ctx, '/decision-inbox/sync'))
    expect(missing.status).toBe(401)

    const wrong = await fetch(url(ctx, '/decision-inbox/sync'), {
      headers: { authorization: 'Bearer nope' },
    })
    expect(wrong.status).toBe(401)

    const right = await fetch(url(ctx, '/decision-inbox/sync'), {
      headers: { authorization: 'Bearer s3cret' },
    })
    expect(right.status).toBe(200)
  })

  it('stays off when sync.enabled is false', async () => {
    const ctx = await setup({ enabled: false })
    const response = await fetch(url(ctx, '/decision-inbox/sync'))
    expect(response.status).toBe(404)
  })
})
