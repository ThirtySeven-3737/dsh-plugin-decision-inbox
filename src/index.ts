/**
 * Non-blocking human decision requests for DeepSeek Harness agents.
 * @module dsh-decision-inbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DecisionRuntime,
  type DecisionDeliveryStatus,
  type DecisionOption,
  type DecisionSnapshot,
  type DecisionStatus,
} from './runtime.ts'
import { JsonFileDecisionPersistence } from './persistence.ts'
import { answerAndDeliver } from './delivery.ts'
import { auditPathFor, JsonlAuditLog, type DecisionAuditActor } from './audit.ts'
import {
  exportAuditLog,
  exportPathFor,
  stringSink,
  type AuditExportFormat,
  type AuditExportOptions,
  type AuditExportResult,
} from './export.ts'
import {
  importDecisionRecords,
  type DecisionImportFormat,
  type DecisionImportResult,
  type ImportConflictPolicy,
} from './import.ts'
import {
  applyRemoteAnswer as applyRemoteAnswerTo,
  applyRemoteCancel as applyRemoteCancelTo,
  buildSyncSnapshot,
  type RemoteAnswerResult,
  type RemoteCancelResult,
  type SyncAgentResolver,
  type SyncSnapshot,
} from './sync.ts'
import {
  assertSyncTrustedAuthority,
  registerSyncHttpRoutes,
  type SyncHttpOptions,
} from './sync-http.ts'
import { handleDecisionInboxRpc } from './web-rpc.ts'
import { DECISION_INBOX_RPC_CHANNEL } from './web-contract.ts'

export * from './runtime.ts'
export * from './persistence.ts'
export * from './delivery.ts'
export * from './audit.ts'
export * from './export.ts'
export * from './import.ts'
export * from './sync.ts'
export * from './sync-http.ts'
export * from './web-contract.ts'
export * from './web-rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    decisionInbox: DecisionInboxService
  }
}

export const DECISION_REQUEST_TOOL = 'decision_request'
export const DECISION_LIST_TOOL = 'decision_list'
export const DECISION_CANCEL_TOOL = 'decision_cancel'

export const AUTONOMOUS_DECISION_GUIDANCE = [
  'Proactively decide when a missing user preference is a consequential choice; the user does not need to request this tool by name.',
  'A choice is consequential when at least two reasonable paths exist, the user has not already established a preference or convention, and choosing incorrectly would materially change product behavior, public interfaces, data shape, architecture, scope, cost, or cause meaningful rework.',
  'Treat choices about long-lived external integration surfaces as consequential by default: export or import format, public API shape, command or RPC surface, storage schema, compatibility contract, migration strategy, and whether to expose a Web or CLI entry point. Do not silently pick a default for these merely because one option is easy to change later.',
  'For long-lived external integration work, if two or more viable formats or surfaces exist and no repository convention or user instruction already decides between them, your first action must be to create a non-blocking choice before implementation. After creating it, continue only with work that is valid for every listed option.',
  'Never replace a required non-blocking choice by implementing your own default and then mentioning in the final answer that the user can change it later.',
  'Example: a request to add import or export capability for other tools to consume long term normally requires a non-blocking choice about data format and exposed surface before format-specific or surface-specific code is written.',
  'Do not ask about routine implementation details, low-impact or easily reversible choices, or questions already answered by repository conventions; make a reasonable default for those and state it when useful.',
  'Prefer this non-blocking choice tool over the blocking user-question tool whenever the consequential question can be answered later and any useful inspection, analysis, verification, planning, or preparation can continue without the answer.',
  'Before calling it, separate answer-dependent work from independent work. Ask one concise question with short options and descriptions; mark a recommendation only when there is a defensible best default. Group tightly related choices and avoid repeated questions.',
  'This tool returns immediately: record the returned id, continue the independent work, and never poll or wait for the answer. Do not perform answer-dependent work or silently choose an option before the answer arrives.',
  'Use the blocking user-question tool only when no correct next action exists without the answer.',
  'Do not ask a blocking implementation-start question when the user has already asked you to handle the task; continue safe independent work and reserve user choices for concrete product, interface, scope, data, architecture, cost, or risk decisions.',
  'If this non-blocking choice tool is unavailable or returns an error, do not automatically downgrade to a blocking question. Continue safe independent work when possible; use a blocking question only if no correct next step remains.',
  'Never use this non-blocking choice tool for tool permissions, security approval, destructive-action approval, secrets, or authentication.',
  'A later answer to the returned id is authoritative user input; do not repeat side effects already applied for that id.',
] as const

export const DECISION_REQUEST_TOOL_DESCRIPTION = 'Proactively create a non-blocking question when an unresolved, consequential user preference has multiple reasonable choices and useful independent work can continue before the answer, especially for long-lived external integration choices such as import/export format, public API shape, or Web/CLI/RPC surface. For those integration choices, call this before implementation when no user instruction or repository convention already decides the path. Prefer this over blocking user questions for deferrable choices. Returns a pending decision id immediately. The user does not need to request this tool by name. Do not use it for routine reversible details or as a permission/approval mechanism.'

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision_id: { type: 'string', required: true },
    question: { type: 'string', required: true },
    options: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', required: true },
          description: { type: 'string' },
        },
      },
    },
    status: { type: 'string', required: true, enum: ['pending', 'answered', 'cancelled', 'expired'] },
    delivery_status: { type: 'string', required: true, enum: ['none', 'pending', 'delivered'] },
    created_at: { type: 'integer', required: true },
    expires_at: { type: 'integer' },
    answered_at: { type: 'integer' },
    answer: { type: 'string' },
    cancelled_at: { type: 'integer' },
    cancel_reason: { type: 'string' },
    delivered_at: { type: 'integer' },
    revision: { type: 'integer', required: true },
  },
} as const

export interface PublicDecision {
  decision_id: string
  question: string
  options: DecisionOption[]
  status: DecisionStatus
  delivery_status: DecisionDeliveryStatus
  created_at: number
  expires_at?: number
  answered_at?: number
  answer?: string
  cancelled_at?: number
  cancel_reason?: string
  delivered_at?: number
  revision: number
}

function publicDecision(snapshot: DecisionSnapshot): PublicDecision {
  return {
    decision_id: snapshot.id,
    question: snapshot.question,
    options: snapshot.options,
    status: snapshot.status,
    delivery_status: snapshot.deliveryStatus,
    created_at: snapshot.createdAt,
    revision: snapshot.revision,
    ...(snapshot.expiresAt === undefined ? {} : { expires_at: snapshot.expiresAt }),
    ...(snapshot.answeredAt === undefined ? {} : { answered_at: snapshot.answeredAt }),
    ...(snapshot.answer === undefined ? {} : { answer: snapshot.answer }),
    ...(snapshot.cancelledAt === undefined ? {} : { cancelled_at: snapshot.cancelledAt }),
    ...(snapshot.cancelReason === undefined ? {} : { cancel_reason: snapshot.cancelReason }),
    ...(snapshot.deliveredAt === undefined ? {} : { delivered_at: snapshot.deliveredAt }),
  }
}

function ownerId(agent: Agent): string {
  return String(agent.id)
}

interface ParsedCommand {
  verb: 'list' | 'answer' | 'cancel' | 'export' | 'import'
  status?: DecisionStatus
  id?: string
  value?: string
  path?: string
  format?: AuditExportFormat | DecisionImportFormat
  onConflict?: ImportConflictPolicy
  owner?: string
}

const VALID_STATUSES = new Set<DecisionStatus>(['pending', 'answered', 'cancelled', 'expired'])
const EXPORT_USAGE = 'usage: /decision export [<path>] [--format csv|json|ndjson] [--owner <ownerId>]'
const EXPORT_FORMATS = new Set<AuditExportFormat>(['csv', 'json', 'ndjson'])
const IMPORT_USAGE = 'usage: /decision import <path> [--format json|ndjson] [--on-conflict skip|fail]'
const IMPORT_FORMATS = new Set<DecisionImportFormat>(['json', 'ndjson'])

export function parseDecisionCommand(rawInput: string): ParsedCommand {
  const input = rawInput.trim()
  if (input === '') return { verb: 'list', status: 'pending' }
  const firstSpace = input.search(/\s/)
  const verb = (firstSpace < 0 ? input : input.slice(0, firstSpace)).toLowerCase()
  const rest = firstSpace < 0 ? '' : input.slice(firstSpace).trim()
  if (verb === 'list') {
    if (rest === '') return { verb: 'list', status: 'pending' }
    if (rest === 'all') return { verb: 'list' }
    if (VALID_STATUSES.has(rest as DecisionStatus)) return { verb: 'list', status: rest as DecisionStatus }
    throw new Error('usage: /decision list [pending|answered|cancelled|expired|all]')
  }
  if (verb === 'export') {
    const command: ParsedCommand = { verb: 'export' }
    const tokens = rest === '' ? [] : rest.split(/\s+/)
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!
      if (token === '--format') {
        const format = tokens[++index]
        if (format === undefined || !EXPORT_FORMATS.has(format as AuditExportFormat)) {
          throw new Error(EXPORT_USAGE)
        }
        command.format = format as AuditExportFormat
      } else if (token === '--owner') {
        const owner = tokens[++index]
        if (owner === undefined) throw new Error(EXPORT_USAGE)
        command.owner = owner
      } else if (token.startsWith('--')) {
        throw new Error(EXPORT_USAGE)
      } else if (command.path === undefined) {
        command.path = token
      } else {
        throw new Error(EXPORT_USAGE)
      }
    }
    return command
  }
  if (verb === 'import') {
    const command: ParsedCommand = { verb: 'import' }
    const tokens = rest === '' ? [] : rest.split(/\s+/)
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!
      if (token === '--format') {
        const format = tokens[++index]
        if (format === undefined || !IMPORT_FORMATS.has(format as DecisionImportFormat)) {
          throw new Error(IMPORT_USAGE)
        }
        command.format = format as DecisionImportFormat
      } else if (token === '--on-conflict') {
        const policy = tokens[++index]
        if (policy !== 'skip' && policy !== 'fail') throw new Error(IMPORT_USAGE)
        command.onConflict = policy
      } else if (token.startsWith('--')) {
        throw new Error(IMPORT_USAGE)
      } else if (command.path === undefined) {
        command.path = token
      } else {
        throw new Error(IMPORT_USAGE)
      }
    }
    if (command.path === undefined) throw new Error(IMPORT_USAGE)
    return command
  }
  if (verb !== 'answer' && verb !== 'cancel') {
    throw new Error(`usage: /decision [list ...|answer <id> <answer>|cancel <id> [reason]|export [<path>] [--format csv|json|ndjson] [--owner <id>]|import <path> [--format json|ndjson] [--on-conflict skip|fail]]`)
  }
  const idEnd = rest.search(/\s/)
  const id = idEnd < 0 ? rest : rest.slice(0, idEnd)
  const value = idEnd < 0 ? '' : rest.slice(idEnd).trim()
  if (id === '') throw new Error(`usage: /decision ${verb} <id>${verb === 'answer' ? ' <answer>' : ' [reason]'}`)
  if (verb === 'answer' && value === '') throw new Error('usage: /decision answer <id> <answer>')
  return { verb, id, ...(value === '' ? {} : { value }) }
}

function formatDecision(decision: DecisionSnapshot): string {
  const options = decision.options.length === 0
    ? ''
    : `\n  options: ${decision.options.map(option => option.label).join(' | ')}`
  const answer = decision.answer === undefined ? '' : `\n  answer: ${decision.answer}`
  const delivery = decision.status === 'answered' ? `; delivery=${decision.deliveryStatus}` : ''
  return `${decision.id} [${decision.status}${delivery}] ${decision.question}${options}${answer}`
}

export interface Config {
  /** Absolute path of the plugin-owned durable JSON sidecar. Omit only for ephemeral embedding/tests. */
  stateFile?: string
  /**
   * Absolute path of the append-only audit log. Defaults to
   * `<stateFile>` with `.json` replaced by `.audit.jsonl`. Omit together with
   * `stateFile` to disable audit logging.
   */
  auditFile?: string
  /**
   * Remote sync HTTP surface on the shared host web server
   * (`@deepseek-ai/dsh-host-webserver`): `GET /decision-inbox/sync` pulls
   * actionable decisions, `POST /decision-inbox/sync/answer` and
   * `POST /decision-inbox/sync/cancel` submit remotely. Loopback-only by
   * default; widen with `trustedHosts` and protect with `token`.
   */
  sync?: SyncHttpOptions
}

/** Cordis service and DSH plugin entry point. */
export class DecisionInboxService extends Service {
  static inject = ['tools', 'systemPrompt']
  readonly runtime: DecisionRuntime
  /** Resolved absolute audit log path; `undefined` when audit logging is disabled. */
  readonly auditPath: string | undefined
  private agentResolver: SyncAgentResolver = () => undefined
  private readonly syncOptions: SyncHttpOptions | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'decisionInbox')
    if (config.stateFile !== undefined && config.stateFile.trim().length === 0) {
      throw new Error('decision-inbox stateFile must not be empty')
    }
    if (config.auditFile !== undefined && config.auditFile.trim().length === 0) {
      throw new Error('decision-inbox auditFile must not be empty')
    }
    if (config.sync !== undefined) {
      if (config.sync.token !== undefined && config.sync.token.trim() === '') {
        throw new Error('decision-inbox sync token must not be empty')
      }
      for (const entry of config.sync.trustedHosts ?? []) {
        assertSyncTrustedAuthority(entry)
      }
    }
    this.syncOptions = config.sync
    const auditPath = config.auditFile
      ?? (config.stateFile === undefined ? undefined : auditPathFor(config.stateFile))
    this.auditPath = auditPath
    this.runtime = new DecisionRuntime({
      ...(config.stateFile === undefined
        ? {}
        : { persistence: new JsonFileDecisionPersistence(config.stateFile) }),
      ...(auditPath === undefined ? {} : { audit: new JsonlAuditLog(auditPath) }),
    })

    ctx.systemPrompt.section({
      name: 'tool:non-blocking-user-choice',
      order: 107,
      text: AUTONOMOUS_DECISION_GUIDANCE.join(' '),
    })

    ctx.tools.register(defineTool({
      name: DECISION_REQUEST_TOOL,
      description: DECISION_REQUEST_TOOL_DESCRIPTION,
      parameters: {
        question: { type: 'string', required: true, description: 'A specific question the user can answer later.' },
        options: {
          type: 'array',
          description: 'Optional short choices; the user may still give a free-text answer.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true },
              description: { type: 'string' },
            },
          },
        },
        expires_in_seconds: { type: 'integer', description: 'Optional expiry from 1 second to 30 days.' },
      },
      output: {
        schema: DECISION_SCHEMA,
        render: (_args, decision) => [{ type: 'text', text: `${decision.decision_id} [${decision.status}] ${decision.question}` }],
      },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('decision_request requires a calling agent')
        const decision = await this.runtime.create({
          ownerId: ownerId(exec.agent),
          question: args.question,
          ...(args.options === undefined ? {} : { options: args.options }),
          ...(args.expires_in_seconds === undefined ? {} : { expiresInSeconds: args.expires_in_seconds }),
        }, { actor: 'agent' })
        return publicDecision(decision)
      },
      presentCall: args => ({ card: 'generic', title: 'Ask later', kind: 'other', rawInput: args.question }),
    }))

    ctx.tools.register(defineTool({
      name: DECISION_LIST_TOOL,
      description: 'List this session\'s non-blocking decisions. This never waits for an answer.',
      parameters: {
        status: { type: 'string', enum: ['pending', 'answered', 'cancelled', 'expired'] },
      },
      output: {
        schema: { type: 'array', items: DECISION_SCHEMA },
        render: (_args, decisions) => [{
          type: 'text',
          text: decisions.length === 0
            ? '(no decisions)'
            : decisions.map(decision => `${decision.decision_id} [${decision.status}] ${decision.question}`).join('\n'),
        }],
      },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('decision_list requires a calling agent')
        return (await this.runtime.list(ownerId(exec.agent), args.status)).map(publicDecision)
      },
      presentCall: () => ({ card: 'generic', title: 'List decisions', kind: 'read' }),
    }))

    ctx.tools.register(defineTool({
      name: DECISION_CANCEL_TOOL,
      description: 'Cancel one pending non-blocking decision created by this session.',
      parameters: {
        decision_id: { type: 'string', required: true },
        reason: { type: 'string' },
      },
      output: {
        schema: DECISION_SCHEMA,
        render: (_args, decision) => [{ type: 'text', text: `${decision.decision_id} [${decision.status}]` }],
      },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('decision_cancel requires a calling agent')
        const result = await this.runtime.cancel(ownerId(exec.agent), args.decision_id, args.reason, { actor: 'agent' })
        if (result.kind === 'not-found') throw new Error(`decision not found: ${args.decision_id}`)
        return publicDecision(result.decision)
      },
      presentCall: args => ({ card: 'generic', title: `Cancel decision ${args.decision_id}`, kind: 'execute' }),
    }))

    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'decision',
        description: 'List, answer, cancel, export, or import non-blocking agent decisions',
        input: { hint: '[list ...|answer <id> <answer>|cancel <id> [reason]|export [<path>] [--format csv|json|ndjson] [--owner <id>]|import <path> [--format json|ndjson] [--on-conflict skip|fail]]' },
        handler: async ({ agent, rawInput }) => {
          try {
            const command = parseDecisionCommand(rawInput)
            if (command.verb === 'list') {
              const decisions = await this.runtime.list(ownerId(agent), command.status)
              return {
                kind: 'success',
                text: decisions.length === 0 ? '(no matching decisions)' : decisions.map(formatDecision).join('\n\n'),
              }
            }
            if (command.verb === 'export') {
              const result = await this.exportAudit({
                ...(command.format === undefined ? {} : { format: command.format }),
                ...(command.path === undefined ? {} : { destination: command.path }),
                ...(command.owner === undefined ? {} : { filter: { ownerId: command.owner } }),
              })
              return {
                kind: 'success',
                text: result.corruptLines === 0
                  ? `exported ${result.events} audit events to ${result.path}`
                  : `exported ${result.events} audit events (${result.corruptLines} corrupt lines skipped) to ${result.path}`,
              }
            }
            if (command.verb === 'import') {
              const importFormat = command.format === 'csv' ? undefined : command.format
              const result = await this.importDecisions({
                source: command.path!,
                ...(importFormat === undefined ? {} : { format: importFormat }),
                ...(command.onConflict === undefined ? {} : { onConflict: command.onConflict }),
                actor: 'user',
              })
              const notes: string[] = []
              if (result.unchanged > 0) notes.push(`${result.unchanged} unchanged`)
              if (result.conflicts > 0) notes.push(`${result.conflicts} conflicts skipped`)
              return {
                kind: 'success',
                text: notes.length === 0
                  ? `imported ${result.imported} decisions from ${command.path}`
                  : `imported ${result.imported} decisions (${notes.join(', ')}) from ${command.path}`,
              }
            }
            if (command.verb === 'cancel') {
              const result = await this.runtime.cancel(ownerId(agent), command.id!, command.value, { actor: 'user' })
              if (result.kind === 'not-found') return { kind: 'error', text: `decision not found: ${command.id}` }
              if (result.kind === 'not-pending') return { kind: 'error', text: `${command.id} is ${result.decision.status}, not pending` }
              return { kind: 'success', text: `cancelled ${command.id}` }
            }

            const result = await answerAndDeliver(this.runtime, agent, command.id!, command.value!)
            if (result.answer.kind === 'not-found') return { kind: 'error', text: `decision not found: ${command.id}` }
            if (result.answer.kind === 'not-pending') {
              return { kind: 'error', text: `${command.id} is ${result.answer.decision.status}, not pending` }
            }
            if (result.answer.kind === 'already-answered' && !result.answer.matchesExisting) {
              return { kind: 'error', text: `${command.id} was already answered differently` }
            }
            return {
              kind: 'success',
              text: result.delivered
                ? `answered ${command.id}; the owning agent was steered with your answer`
                : `${command.id} already had this answer; it was not delivered twice`,
            }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
    })

    // Resolve owning agents for remote sync submissions; optional, so
    // minimal embeddings/tests keep the no-agent fallback (answers still
    // commit durably and join the outbox).
    ctx.inject(['agents'], (agentsCtx) => {
      this.agentResolver = ownerId => agentsCtx.agents.get(ownerId as Agent['id'])
    })

    // Remote sync HTTP surface on the shared host web server; optional, so
    // headless/TUI profiles that do not compose the web server simply never
    // expose the routes.
    if (this.syncOptions?.enabled !== false) {
      ctx.inject(['webServer'], (webCtx) => {
        registerSyncHttpRoutes(webCtx, {
          runtime: this.runtime,
          resolveAgent: ownerId => this.agentResolver(ownerId),
          ...(this.syncOptions?.trustedHosts === undefined ? {} : { trustedHosts: this.syncOptions.trustedHosts }),
          ...(this.syncOptions?.token === undefined ? {} : { token: this.syncOptions.token }),
        })
      })
    }

    // The Web UI is optional: headless/TUI profiles keep the model tools and
    // slash fallback even when no browser Connection service is composed.
    ctx.inject(['connection', 'agents'], (webCtx) => {
      webCtx.connection.rpc.handle(
        DECISION_INBOX_RPC_CHANNEL,
        (endpoint, payload, signal) => handleDecisionInboxRpc(
          this.runtime,
          sessionId => webCtx.agents.get(sessionId as Agent['id']),
          endpoint,
          payload,
          signal,
          {
            exportAudit: async () => {
              const now = Date.now()
              const sink = stringSink()
              await this.exportAudit({ format: 'csv', destination: sink, now: () => now })
              return {
                filename: `decision-inbox-audit-${new Date(now).toISOString().slice(0, 10)}.csv`,
                mime: 'text/csv;charset=utf-8',
                text: sink.text(),
              }
            },
          },
        ),
        { authority: 'trusted-host' },
      )
    })
  }

  /**
   * Stream the audit log into a destination (file path or sink) for external
   * tooling. Defaults to CSV at the derived `<auditPath>.csv` when neither
   * `format` nor `destination` is given. Throws when audit logging is disabled
   * (no `stateFile`/`auditFile` configured).
   */
  exportAudit(options: Omit<AuditExportOptions, 'destination'> & {
    destination?: AuditExportOptions['destination']
  } = {}): Promise<AuditExportResult> {
    if (this.auditPath === undefined) {
      throw new Error('decision-inbox audit logging is disabled; configure stateFile or auditFile to enable exports')
    }
    const format = options.format ?? 'csv'
    const destination = options.destination ?? exportPathFor(this.auditPath, format)
    return exportAuditLog(this.auditPath, { ...options, format, destination })
  }

  /**
   * Read a versioned import artifact (JSON document or NDJSON records) from an
   * absolute path and merge it into the durable store atomically for other
   * tools. Insert-only: existing ids are never overwritten. Returns the merge
   * report; throws on invalid input or, with `onConflict: 'fail'`, on any
   * conflicting id. Imported records are attributed to `actor` in the audit
   * log (defaults to `system`).
   */
  importDecisions(options: {
    source: string
    format?: DecisionImportFormat
    onConflict?: ImportConflictPolicy
    actor?: DecisionAuditActor
  }): Promise<DecisionImportResult> {
    return importDecisionRecords(this.runtime, options.source, options)
  }

  /**
   * Build the versioned pull snapshot for remote tools: every `pending`
   * decision plus answered decisions whose delivery is still `pending`, across
   * all sessions, in the persisted record shape (`decision-inbox-sync` v1).
   */
  syncPending(): Promise<SyncSnapshot> {
    return buildSyncSnapshot(this.runtime)
  }

  /**
   * Apply an answer submitted by a remote tool, addressed by decision id
   * alone. Commits durably even when the owning agent is not live (the
   * durable outbox retries delivery later); `delivered: true` reports an
   * in-process steer.
   */
  remoteAnswer(id: string, answer: string): Promise<RemoteAnswerResult> {
    return applyRemoteAnswerTo(this.runtime, this.agentResolver, id, answer)
  }

  /** Apply a cancellation submitted by a remote tool, addressed by decision id alone. */
  remoteCancel(id: string, reason?: string): Promise<RemoteCancelResult> {
    return applyRemoteCancelTo(this.runtime, id, reason)
  }

  /** Load durable state before Cordis publishes the service and its tools. */
  protected async [Service.init](): Promise<void> {
    await this.runtime.initialize()
  }
}

export default DecisionInboxService
