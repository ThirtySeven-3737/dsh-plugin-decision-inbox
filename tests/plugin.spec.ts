import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DecisionInboxService, {
  DECISION_CANCEL_TOOL,
  DECISION_IMPORT_SCHEMA,
  DECISION_IMPORT_VERSION,
  DECISION_LIST_TOOL,
  DECISION_REQUEST_TOOL,
} from '../src/index.ts'

function agent(steer = vi.fn()): Agent {
  return { id: 'session-integration', steer } as unknown as Agent
}

async function setup(config: ConstructorParameters<typeof DecisionInboxService>[1] = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(DecisionInboxService, config)
  return ctx
}

const temporaryDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })))
  temporaryDirectories.clear()
})

describe('DSH plugin integration', () => {
  it('registers three model tools and its decision command', async () => {
    const ctx = await setup()
    const currentAgent = agent()

    expect(ctx.tools.schemas(currentAgent).map(tool => tool.name)).toEqual([
      DECISION_REQUEST_TOOL,
      DECISION_LIST_TOOL,
      DECISION_CANCEL_TOOL,
    ])
    expect(ctx.commands.list(currentAgent)).toContainEqual(expect.objectContaining({ name: 'decision' }))
  })

  it('returns pending immediately, then delivers the later command answer once', async () => {
    const ctx = await setup()
    const steer = vi.fn()
    const currentAgent = agent(steer)
    const signal = new AbortController().signal

    const created = await ctx.tools.execute({
      callId: CallId('decision-create'),
      name: DECISION_REQUEST_TOOL,
      arguments: {
        question: 'Which storage should the prototype use?',
        options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }],
      },
      agent: currentAgent,
      signal,
    })

    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ status: 'pending', delivery_status: 'none' })
    const decisionId = (created.value as { decision_id: string }).decision_id
    expect(decisionId).toMatch(/^decision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)

    const command = ctx.commands.find(currentAgent, 'decision')
    if (command === undefined) throw new Error('decision command was not registered')
    const first = await command.handler({
      commandId: 'command-1',
      agent: currentAgent,
      rawInput: `answer ${decisionId} SQLite`,
      signal,
    } as Parameters<typeof command.handler>[0])
    const duplicate = await command.handler({
      commandId: 'command-2',
      agent: currentAgent,
      rawInput: `answer ${decisionId} SQLite`,
      signal,
    } as Parameters<typeof command.handler>[0])

    expect(first).toMatchObject({ kind: 'success', text: expect.stringContaining('was steered') })
    expect(duplicate).toMatchObject({ kind: 'success', text: expect.stringContaining('not delivered twice') })
    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'user' },
      content: [{ type: 'text', text: expect.stringContaining(`decision_id: ${decisionId}`) }],
    })
  })

  it('adds autonomous-trigger, non-blocking, and safety guidance to the system prompt', async () => {
    const ctx = await setup()
    const assembled = await ctx.systemPrompt.assemble()
    const text = assembled.sections
      .map(section => section.text)
      .join('\n')

    expect(text).toContain('the user does not need to request this tool by name')
    expect(text).toContain('at least two reasonable paths exist')
    expect(text).toContain('long-lived external integration surfaces')
    expect(text).toContain('export or import format, public API shape, command or RPC surface')
    expect(text).toContain('your first action must be to create a non-blocking choice before implementation')
    expect(text).toContain('Never replace a required non-blocking choice by implementing your own default')
    expect(text).toContain('routine implementation details')
    expect(text).toContain('Prefer this non-blocking choice tool over the blocking user-question tool')
    expect(text).toContain('separate answer-dependent work from independent work')
    expect(text).toContain('continue the independent work')
    expect(text).toContain('Use the blocking user-question tool only when no correct next action exists without the answer')
    expect(text).toContain('Do not ask a blocking implementation-start question')
    expect(text).toContain('Never use this non-blocking choice tool for tool permissions')
  })

  it('exports the audit log through the /decision command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-export-command-'))
    temporaryDirectories.add(dir)
    const ctx = await setup({ stateFile: join(dir, 'decision-inbox.json') })
    const currentAgent = agent()
    const signal = new AbortController().signal

    await ctx.tools.execute({
      callId: CallId('decision-export-create'),
      name: DECISION_REQUEST_TOOL,
      arguments: { question: 'Export this?', options: [{ label: 'yes' }] },
      agent: currentAgent,
      signal,
    })

    const command = ctx.commands.find(currentAgent, 'decision')
    if (command === undefined) throw new Error('decision command was not registered')
    const result = await command.handler({
      commandId: 'command-export',
      agent: currentAgent,
      rawInput: 'export',
      signal,
    } as Parameters<typeof command.handler>[0])

    expect(result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('exported 2 audit events to'),
    })
    const exported = await readFile(join(dir, 'decision-inbox.audit.csv'), 'utf8')
    expect(exported.startsWith('seq,ts,actor,type,')).toBe(true)
    expect(exported).toContain('Export this?')
    expect(exported).toContain('checkpoint')

    const scoped = await command.handler({
      commandId: 'command-export-owner',
      agent: currentAgent,
      rawInput: `export ${join(dir, 'owner.csv')} --format csv --owner session-integration`,
      signal,
    } as Parameters<typeof command.handler>[0])
    expect(scoped).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('exported 1 audit events to'),
    })
    expect(await readFile(join(dir, 'owner.csv'), 'utf8')).toContain('Export this?')
  })

  it('reports when audit export is disabled', async () => {
    const ctx = await setup()
    const currentAgent = agent()
    const command = ctx.commands.find(currentAgent, 'decision')
    if (command === undefined) throw new Error('decision command was not registered')
    const result = await command.handler({
      commandId: 'command-export-disabled',
      agent: currentAgent,
      rawInput: 'export',
      signal: new AbortController().signal,
    } as Parameters<typeof command.handler>[0])

    expect(result).toEqual({
      kind: 'error',
      text: expect.stringContaining('audit logging is disabled'),
    })
  })

  it('imports decisions through the /decision command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-import-command-'))
    temporaryDirectories.add(dir)
    const ctx = await setup({ stateFile: join(dir, 'decision-inbox.json') })
    const currentAgent = agent()
    const signal = new AbortController().signal

    const importPath = join(dir, 'history.json')
    await writeFile(importPath, JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: DECISION_IMPORT_VERSION,
      decisions: [{
        id: 'decision-imported-1',
        ownerId: 'session-integration',
        question: 'Imported question?',
        options: [],
        status: 'pending',
        deliveryStatus: 'none',
        createdAt: 1_000,
        revision: 1,
      }],
    }), 'utf8')

    const command = ctx.commands.find(currentAgent, 'decision')
    if (command === undefined) throw new Error('decision command was not registered')
    const result = await command.handler({
      commandId: 'command-import',
      agent: currentAgent,
      rawInput: `import ${importPath}`,
      signal,
    } as Parameters<typeof command.handler>[0])

    expect(result).toEqual({
      kind: 'success',
      text: `imported 1 decisions from ${importPath}`,
    })

    const listed = await ctx.tools.execute({
      callId: CallId('decision-import-list'),
      name: DECISION_LIST_TOOL,
      arguments: {},
      agent: currentAgent,
      signal,
    })
    expect(listed.isError).toBe(false)
    expect(listed.value).toHaveLength(1)
    expect((listed.value as { decision_id: string }[])[0]).toMatchObject({
      decision_id: 'decision-imported-1',
      status: 'pending',
      question: 'Imported question?',
    })

    const audit = await readFile(join(dir, 'decision-inbox.audit.jsonl'), 'utf8')
    expect(audit).toContain('"type":"imported"')
    expect(audit).toContain('"decisionId":"decision-imported-1"')
    expect(audit).toContain('"actor":"user"')
  })

  it('reports conflicts under the fail policy without changing existing rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decision-import-command-'))
    temporaryDirectories.add(dir)
    const ctx = await setup({ stateFile: join(dir, 'decision-inbox.json') })
    const currentAgent = agent()
    const signal = new AbortController().signal

    const created = await ctx.tools.execute({
      callId: CallId('decision-import-conflict-create'),
      name: DECISION_REQUEST_TOOL,
      arguments: { question: 'Original question?' },
      agent: currentAgent,
      signal,
    })
    const decisionId = (created.value as { decision_id: string }).decision_id

    const importPath = join(dir, 'history.json')
    await writeFile(importPath, JSON.stringify({
      schema: DECISION_IMPORT_SCHEMA,
      version: DECISION_IMPORT_VERSION,
      decisions: [{
        id: decisionId,
        ownerId: 'session-integration',
        question: 'Conflicting question?',
        options: [],
        status: 'pending',
        deliveryStatus: 'none',
        createdAt: 1_000,
        revision: 1,
      }],
    }), 'utf8')

    const command = ctx.commands.find(currentAgent, 'decision')
    if (command === undefined) throw new Error('decision command was not registered')
    const failed = await command.handler({
      commandId: 'command-import-conflict',
      agent: currentAgent,
      rawInput: `import ${importPath} --on-conflict fail`,
      signal,
    } as Parameters<typeof command.handler>[0])
    expect(failed).toMatchObject({
      kind: 'error',
      text: expect.stringContaining(`conflicts with existing decision ${decisionId}`),
    })

    const skipped = await command.handler({
      commandId: 'command-import-skip',
      agent: currentAgent,
      rawInput: `import ${importPath}`,
      signal,
    } as Parameters<typeof command.handler>[0])
    expect(skipped).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('imported 0 decisions (1 conflicts skipped)'),
    })

    const listed = await ctx.tools.execute({
      callId: CallId('decision-import-conflict-list'),
      name: DECISION_LIST_TOOL,
      arguments: {},
      agent: currentAgent,
      signal,
    })
    expect(listed.value).toHaveLength(1)
    expect((listed.value as { question: string }[])[0]?.question).toBe('Original question?')
  })
})
