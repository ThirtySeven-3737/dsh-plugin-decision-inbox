/**
 * Host HTTP transport for the `dsh-decision-inbox` remote sync surface.
 *
 * Registers three exact routes on the shared DSH web server
 * (`ctx.webServer`, provided by `@deepseek-ai/dsh-host-webserver`):
 *
 * - `GET  /decision-inbox/sync`        pull the actionable-decision snapshot
 * - `POST /decision-inbox/sync/answer` submit a `decision-inbox-answer` v1
 * - `POST /decision-inbox/sync/cancel` submit a `decision-inbox-cancel` v1
 *
 * Trust model: the same Host-header fence DSH applies to its `/api` gateway
 * (DNS-rebinding plus cross-site defense), implemented locally so this
 * package does not depend on unpublished package internals. Loopback hosts
 * always pass; any bare canonical `host[:port]` authority declared in
 * `sync.trustedHosts` passes too; browser cross-site markers and mismatched
 * `Origin` headers are refused. When `sync.token` is configured, every sync
 * request must additionally carry `Authorization: Bearer <token>` (compared
 * in constant time), so the routes can be widened beyond loopback with a
 * credential.
 *
 * Answers and cancellations run through the same durable-first pipeline as
 * the Web card: an answer commits before delivery, steers the owning agent
 * when it is live, and otherwise stays in the durable outbox for retry.
 *
 * Responses are JSON. Success bodies carry the persisted decision record;
 * errors carry `{"error":{"code","message"}}` with status 400 (bad request),
 * 401 (unauthorized), 403 (forbidden), 404 (unknown decision or route), 405
 * (wrong method), 409 (decision not pending), 413 (body too large).
 *
 * @module dsh-decision-inbox/sync-http
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  applyRemoteAnswer,
  applyRemoteCancel,
  buildSyncSnapshot,
  parseRemoteAnswer,
  parseRemoteCancel,
  type RemoteAnswerRequest,
  type RemoteCancelRequest,
  type SyncAgentResolver,
} from './sync.ts'
import { DecisionRuntime } from './runtime.ts'

export const DECISION_INBOX_SYNC_PATH = '/decision-inbox/sync'
export const DECISION_INBOX_ANSWER_PATH = '/decision-inbox/sync/answer'
export const DECISION_INBOX_CANCEL_PATH = '/decision-inbox/sync/cancel'

/** Maximum buffered request body; the largest submission (answer) is 8 KB. */
export const MAX_SYNC_REQUEST_BODY_BYTES = 64 * 1024

/** Remote sync HTTP surface configuration. */
export interface SyncHttpOptions {
  /**
   * Non-loopback authorities allowed to reach the sync routes. Entries are
   * bare canonical `host[:port]` authorities; an explicit port matches that
   * exact authority, a port-less host matches any port. Defaults to
   * loopback-only.
   */
  trustedHosts?: string[]
  /**
   * Optional shared bearer token. When set, every sync request must carry
   * `Authorization: Bearer <token>` (constant-time comparison).
   */
  token?: string
  /**
   * Set `false` to disable the sync routes. Defaults to enabled whenever the
   * web server service is composed.
   */
  enabled?: boolean
}

/** Dependencies of the sync HTTP surface. */
export interface SyncHttpDeps {
  runtime: DecisionRuntime
  resolveAgent: SyncAgentResolver
  trustedHosts?: readonly string[]
  token?: string
}

/** A JSON response decision for the transport. */
export interface SyncHttpOutcome {
  status: number
  json: unknown
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or `undefined` when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Canonical form of a parsed authority: hostname, plus port when written explicitly. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Assert one configured `sync.trustedHosts` entry is a bare `host[:port]`
 * authority in canonical form, mirroring the `/api` gateway validation: a
 * malformed entry fails the plugin load loudly instead of silently changing
 * the grant.
 */
export function assertSyncTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`decision-inbox sync trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether the request authority matches a configured trustedHosts entry. */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * The Host-header trust fence for sync requests: loopback or a declared
 * trusted authority, no browser cross-site markers, and any attached Origin
 * must match the request authority exactly. This is a DNS-rebinding and
 * confused-deputy defense, not authentication; combine with `token` for a
 * credential.
 */
export function isTrustedSyncRequest(
  headers: IncomingHttpHeaders,
  trustedHosts: readonly string[],
): boolean {
  const host = header(headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Extract the bearer token credential, or `undefined` when absent/malformed. */
function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = header(headers, 'authorization')
  if (authorization === undefined) return undefined
  return /^Bearer\s+(\S+)$/iu.exec(authorization)?.[1]
}

/** Constant-time token comparison over SHA-256 digests (equal lengths). */
function tokensEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(actualDigest, expectedDigest)
}

/**
 * Buffer a request body up to `maxBytes`. Returns `too-large` without
 * buffering the remainder when the cap is exceeded, so oversized uploads are
 * refused before they are fully read.
 */
export async function readSyncBody(
  req: IncomingMessage,
  maxBytes: number = MAX_SYNC_REQUEST_BODY_BYTES,
): Promise<{ kind: 'ok'; text: string } | { kind: 'too-large'; limit: number }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    total += buffer.length
    if (total > maxBytes) return { kind: 'too-large', limit: maxBytes }
    chunks.push(buffer)
  }
  return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }
}

function badRequest(message: string): SyncHttpOutcome {
  return { status: 400, json: { error: { code: 'bad-request', message } } }
}

function methodNotAllowed(allowed: string): SyncHttpOutcome {
  return {
    status: 405,
    json: { error: { code: 'method-not-allowed', message: `sync route requires ${allowed}` } },
  }
}

function notFound(message: string): SyncHttpOutcome {
  return { status: 404, json: { error: { code: 'not-found', message } } }
}

function parseJsonBody(body: string | undefined): { kind: 'ok'; value: unknown } | { kind: 'error'; message: string } {
  if (body === undefined || body.trim() === '') {
    return { kind: 'error', message: 'request body must be a JSON document' }
  }
  try {
    return { kind: 'ok', value: JSON.parse(body) }
  } catch {
    return { kind: 'error', message: 'request body is not valid JSON' }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleAnswer(deps: SyncHttpDeps, body: string | undefined): Promise<SyncHttpOutcome> {
  const parsed = parseJsonBody(body)
  if (parsed.kind === 'error') return badRequest(parsed.message)
  let submission: RemoteAnswerRequest
  try {
    submission = parseRemoteAnswer(parsed.value)
  } catch (error) {
    return badRequest(errorMessage(error))
  }
  const result = await applyRemoteAnswer(deps.runtime, deps.resolveAgent, submission.id, submission.answer)
  if (result.kind === 'not-found') return notFound(`decision not found: ${submission.id}`)
  const record = await deps.runtime.findById(submission.id)
  switch (result.kind) {
    case 'answered':
      return { status: 200, json: { kind: 'answered', delivered: result.delivered, decision: record } }
    case 'already-answered':
      return {
        status: 200,
        json: {
          kind: 'already-answered',
          matchesExisting: result.matchesExisting,
          delivered: result.delivered,
          decision: record,
        },
      }
    case 'not-pending':
      return {
        status: 409,
        json: {
          error: {
            code: 'not-pending',
            message: `decision ${submission.id} is ${result.decision.status}, not pending`,
          },
          decision: record,
        },
      }
  }
}

async function handleCancel(deps: SyncHttpDeps, body: string | undefined): Promise<SyncHttpOutcome> {
  const parsed = parseJsonBody(body)
  if (parsed.kind === 'error') return badRequest(parsed.message)
  let submission: RemoteCancelRequest
  try {
    submission = parseRemoteCancel(parsed.value)
  } catch (error) {
    return badRequest(errorMessage(error))
  }
  const result = await applyRemoteCancel(deps.runtime, submission.id, submission.reason)
  if (result.kind === 'not-found') return notFound(`decision not found: ${submission.id}`)
  const record = await deps.runtime.findById(submission.id)
  if (result.kind === 'not-pending') {
    return {
      status: 409,
      json: {
        error: {
          code: 'not-pending',
          message: `decision ${submission.id} is ${result.decision.status}, not pending`,
        },
        decision: record,
      },
    }
  }
  return { status: 200, json: { kind: 'cancelled', decision: record } }
}

/**
 * Transport-independent sync HTTP handler: maps one parsed request to a JSON
 * status/body outcome. Applies the Host trust fence and optional bearer
 * token before any routing; parse failures answer 400 without touching the
 * runtime.
 */
export async function handleSyncHttp(
  deps: SyncHttpDeps,
  request: { method: string; path: string; headers: IncomingHttpHeaders; body?: string },
): Promise<SyncHttpOutcome> {
  const trustedHosts = deps.trustedHosts ?? []
  if (!isTrustedSyncRequest(request.headers, trustedHosts)) {
    return {
      status: 403,
      json: { error: { code: 'forbidden', message: 'sync request failed the host trust fence' } },
    }
  }
  if (deps.token !== undefined) {
    const supplied = bearerToken(request.headers)
    if (supplied === undefined || !tokensEqual(supplied, deps.token)) {
      return {
        status: 401,
        json: { error: { code: 'unauthorized', message: 'a valid bearer token is required for decision-inbox sync' } },
      }
    }
  }
  try {
    const { method, path } = request
    if (path === DECISION_INBOX_SYNC_PATH) {
      if (method !== 'GET') return methodNotAllowed('GET')
      return { status: 200, json: await buildSyncSnapshot(deps.runtime) }
    }
    if (path === DECISION_INBOX_ANSWER_PATH) {
      if (method !== 'POST') return methodNotAllowed('POST')
      return await handleAnswer(deps, request.body)
    }
    if (path === DECISION_INBOX_CANCEL_PATH) {
      if (method !== 'POST') return methodNotAllowed('POST')
      return await handleCancel(deps, request.body)
    }
    return notFound(`unknown decision-inbox sync route: ${method} ${path}`)
  } catch (error) {
    return {
      status: 500,
      json: { error: { code: 'internal', message: errorMessage(error) } },
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Register the three sync routes on the shared host web server, effect-scoped
 * so they unregister with the calling fiber. The web server service is
 * optional; profiles that do not compose it (headless/TUI) simply never
 * expose the routes.
 */
export function registerSyncHttpRoutes(ctx: Context, deps: SyncHttpDeps): void {
  const register = (path: string, readsBody: boolean, label: string): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        // node:http always sets url on server requests.
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const method = req.method ?? 'GET'
        if (!readsBody) {
          const outcome = await handleSyncHttp(deps, { method, path: pathname, headers: req.headers })
          sendJson(res, outcome.status, outcome.json)
          return
        }
        const body = await readSyncBody(req)
        const outcome = body.kind === 'too-large'
          ? {
              status: 413,
              json: { error: { code: 'payload-too-large', message: `sync request body exceeds ${body.limit} bytes` } },
            }
          : await handleSyncHttp(deps, { method, path: pathname, headers: req.headers, body: body.text })
        sendJson(res, outcome.status, outcome.json)
      },
    }), label)
  }
  register(DECISION_INBOX_SYNC_PATH, false, 'decision-inbox: sync snapshot route')
  register(DECISION_INBOX_ANSWER_PATH, true, 'decision-inbox: sync answer route')
  register(DECISION_INBOX_CANCEL_PATH, true, 'decision-inbox: sync cancel route')
}
