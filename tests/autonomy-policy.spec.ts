import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DecisionInboxService, {
  AUTONOMOUS_DECISION_GUIDANCE,
  DECISION_REQUEST_TOOL,
  DECISION_REQUEST_TOOL_DESCRIPTION,
} from '../src/index.ts'

function agent(): Agent {
  return { id: 'session-autonomy', steer: vi.fn() } as unknown as Agent
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(DecisionInboxService)
  return ctx
}

function requirePhrases(text: string, phrases: string[]): void {
  for (const phrase of phrases) expect(text).toContain(phrase)
}

describe('autonomous decision policy', () => {
  it('publishes the exact shared guidance into the system prompt', async () => {
    const ctx = await setup()
    const assembled = await ctx.systemPrompt.assemble()
    const section = assembled.sections.find(item => item.name === 'tool:non-blocking-user-choice')

    expect(section).toMatchObject({
      name: 'tool:non-blocking-user-choice',
      text: AUTONOMOUS_DECISION_GUIDANCE.join(' '),
    })
  })

  it('defines when the model should proactively create a non-blocking decision', () => {
    const guidance = AUTONOMOUS_DECISION_GUIDANCE.join(' ')

    requirePhrases(guidance, [
      'the user does not need to request this tool by name',
      'at least two reasonable paths exist',
      'the user has not already established a preference or convention',
      'product behavior, public interfaces, data shape, architecture, scope, cost',
      'meaningful rework',
      'long-lived external integration surfaces',
      'export or import format, public API shape, command or RPC surface',
      'whether to expose a Web or CLI entry point',
      'Do not silently pick a default for these merely because one option is easy to change later.',
      'your first action must be to create a non-blocking choice before implementation',
      'continue only with work that is valid for every listed option',
      'Never replace a required non-blocking choice by implementing your own default',
      'the user can change it later',
      'a request to add import or export capability for other tools to consume long term',
      'Prefer this non-blocking choice tool over the blocking user-question tool',
      'inspection, analysis, verification, planning, or preparation can continue without the answer',
      'separate answer-dependent work from independent work',
      'continue the independent work',
    ])
  })

  it('defines when the model must not create a non-blocking decision', () => {
    const guidance = AUTONOMOUS_DECISION_GUIDANCE.join(' ')

    requirePhrases(guidance, [
      'routine implementation details',
      'low-impact or easily reversible choices',
      'questions already answered by repository conventions',
      'make a reasonable default',
      'Use the blocking user-question tool only when no correct next action exists without the answer.',
      'Do not ask a blocking implementation-start question',
      'continue safe independent work',
      'do not automatically downgrade to a blocking question',
      'use a blocking question only if no correct next step remains',
      'Never use this non-blocking choice tool for tool permissions',
      'security approval, destructive-action approval, secrets, or authentication',
    ])
  })

  it('keeps plugin branding and internal function names out of model-visible guidance text', () => {
    const guidance = AUTONOMOUS_DECISION_GUIDANCE.join(' ')

    expect(guidance).not.toMatch(/dsh-decision-inbox|decision-inbox|decision_request|\/decision/iu)
  })

  it('mirrors the autonomous policy in the tool description visible to the model', async () => {
    const ctx = await setup()
    const requestTool = ctx.tools.schemas(agent()).find(tool => tool.name === DECISION_REQUEST_TOOL)

    expect(requestTool?.description).toBe(DECISION_REQUEST_TOOL_DESCRIPTION)
    requirePhrases(requestTool?.description ?? '', [
      'Proactively create a non-blocking question',
      'unresolved, consequential user preference',
      'multiple reasonable choices',
      'useful independent work can continue',
      'long-lived external integration choices',
      'import/export format, public API shape, or Web/CLI/RPC surface',
      'call this before implementation',
      'Prefer this over blocking user questions for deferrable choices',
      'The user does not need to request this tool by name',
      'routine reversible details',
      'permission/approval mechanism',
    ])
  })

  it('keeps real-model eval prompts natural and tool-name-free', async () => {
    const casesPath = join(process.cwd(), 'evals', 'autonomy-cases.json')
    const cases = JSON.parse(await readFile(casesPath, 'utf8')) as Array<{
      id: string
      prompt: string
      expectedTool: string
      independentMarker?: string
    }>

    expect(cases.length).toBeGreaterThanOrEqual(8)
    for (const testCase of cases) {
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/u)
      expect(testCase.prompt).not.toMatch(/decision_request|decision-inbox|decision inbox|\/decision/iu)
    }

    const triggerCases = cases.filter(testCase => testCase.expectedTool === DECISION_REQUEST_TOOL)
    expect(triggerCases.length).toBeGreaterThanOrEqual(6)
    for (const testCase of triggerCases) {
      expect(testCase.prompt).not.toMatch(/not decided|undecided|unresolved|two reasonable|while waiting|while .* open|answer-independent|independent work|before .* settled/iu)
      expect(testCase.prompt).not.toContain(testCase.independentMarker ?? '__missing_marker__')
    }
  })
})
