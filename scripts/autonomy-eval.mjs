#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const endpoint = process.env.DEEPSEEK_API_BASE_URL ?? 'https://api.deepseek.com/chat/completions'
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
const casesPath = process.env.AUTONOMY_EVAL_CASES ?? join(root, 'evals', 'autonomy-cases.json')
const temperature = Number(process.env.AUTONOMY_EVAL_TEMPERATURE ?? '0')

async function exportedStringConst(name) {
  const source = await readFile(join(root, 'src', 'index.ts'), 'utf8')
  const pattern = new RegExp(`export const ${name} = '([^']+)'`)
  const match = source.match(pattern)
  if (match?.[1] === undefined) throw new Error(`Could not read ${name} from src/index.ts`)
  return match[1]
}

async function exportedStringArrayConst(name) {
  const source = await readFile(join(root, 'src', 'index.ts'), 'utf8')
  const start = source.indexOf(`export const ${name} = [`)
  if (start < 0) throw new Error(`Could not read ${name} from src/index.ts`)
  const end = source.indexOf('] as const', start)
  if (end < 0) throw new Error(`Could not read ${name} array terminator from src/index.ts`)
  const block = source.slice(start, end)
  const values = [...block.matchAll(/'([^']+)'/gu)].map(match => match[1])
  if (values.length === 0) throw new Error(`${name} in src/index.ts has no string entries`)
  return values
}

if (args.has('--help')) {
  console.log([
    'Usage: pnpm eval:autonomy [--json]',
    '',
    'Environment:',
    '  DEEPSEEK_API_KEY              API key. If absent, env.txt or ../env.txt is read.',
    '  DEEPSEEK_API_BASE_URL         Defaults to https://api.deepseek.com/chat/completions.',
    '  DEEPSEEK_MODEL                Defaults to deepseek-chat.',
    '  AUTONOMY_EVAL_CASES           Defaults to evals/autonomy-cases.json.',
    '  AUTONOMY_EVAL_TEMPERATURE     Defaults to 0.',
  ].join('\n'))
  process.exit(0)
}

async function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim()

  for (const candidate of [join(root, 'env.txt'), join(root, '..', 'env.txt')]) {
    if (!existsSync(candidate)) continue
    const raw = await readFile(candidate, 'utf8')
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const equals = trimmed.indexOf('=')
      if (equals >= 0) {
        const key = trimmed.slice(0, equals).trim()
        const value = trimmed.slice(equals + 1).trim().replace(/^['"]|['"]$/gu, '')
        if (/^(DEEPSEEK_)?API_KEY$/iu.test(key) && value !== '') return value
      } else {
        return trimmed.replace(/^['"]|['"]$/gu, '')
      }
    }
  }

  throw new Error('Missing DEEPSEEK_API_KEY. Set it, or place the key in env.txt.')
}

function tools(policy) {
  return [
    {
      type: 'function',
      function: {
        name: policy.decisionRequestTool,
        description: policy.decisionRequestToolDescription,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string', description: 'A specific question the user can answer later.' },
            options: {
              type: 'array',
              description: 'Optional short choices; the user may still give a free-text answer.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
            expires_in_seconds: { type: 'integer', description: 'Optional expiry from 1 second to 30 days.' },
          },
          required: ['question'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ask_user_question',
        description: 'Ask the user a blocking question. Use this when no correct next step exists until the user answers.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string' },
            options: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['question'],
        },
      },
    },
  ]
}

function firstToolName(responseJson) {
  const calls = responseJson?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(calls) || calls.length === 0) return 'none'
  const first = calls[0]
  return first?.function?.name ?? 'unknown'
}

function firstMessage(responseJson) {
  return responseJson?.choices?.[0]?.message
}

async function requestCompletion(apiKey, body, id) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON response for ${id}: HTTP ${response.status} ${text.slice(0, 300)}`)
  }

  if (!response.ok) {
    const message = json?.error?.message ?? text.slice(0, 300)
    throw new Error(`HTTP ${response.status} for ${id}: ${message}`)
  }

  return json
}

async function evaluateCase(apiKey, testCase) {
  const markerInstruction = testCase.independentMarker === undefined
    ? ''
    : `If a non-blocking choice tool returns pending and there is useful answer-independent work, continue that work in prose and include ${testCase.independentMarker} when that independent work is complete.`
  const messages = [
    {
      role: 'system',
      content: [
        testCase.policy.autonomousDecisionGuidance.join(' '),
        'This is an evaluation. Choose tools exactly as you would in the product.',
        'The user prompt will not name any optional tool; infer from the situation.',
        markerInstruction,
      ].join(' '),
    },
    { role: 'user', content: testCase.prompt },
  ]
  const body = {
    model,
    temperature,
    messages,
    tools: tools(testCase.policy),
    tool_choice: 'auto',
  }

  const json = await requestCompletion(apiKey, body, testCase.id)

  const actualTool = firstToolName(json)
  const result = {
    id: testCase.id,
    expectedTool: testCase.expectedTool,
    actualTool,
    continued: undefined,
    pass: actualTool === testCase.expectedTool,
  }

  if (actualTool === testCase.policy.decisionRequestTool && testCase.independentMarker !== undefined) {
    const assistant = firstMessage(json)
    const call = assistant?.tool_calls?.[0]
    if (call?.id === undefined) {
      result.continued = false
      result.pass = false
      return result
    }

    const followup = await requestCompletion(apiKey, {
      ...body,
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: assistant.content ?? null,
          tool_calls: assistant.tool_calls,
        },
        {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            decision_id: `decision-eval-${testCase.id}`,
            question: 'evaluation question',
            options: [{ label: 'A' }, { label: 'B' }],
            status: 'pending',
            delivery_status: 'none',
            created_at: 1,
            revision: 1,
          }),
        },
      ],
    }, `${testCase.id}:followup`)
    const content = String(firstMessage(followup)?.content ?? '')
    result.continued = content.includes(testCase.independentMarker)
    result.pass = result.pass && result.continued
  }

  return {
    ...result,
  }
}

async function main() {
  const apiKey = await readApiKey()
  const cases = JSON.parse(await readFile(casesPath, 'utf8'))
  const policy = {
    autonomousDecisionGuidance: await exportedStringArrayConst('AUTONOMOUS_DECISION_GUIDANCE'),
    decisionRequestTool: await exportedStringConst('DECISION_REQUEST_TOOL'),
    decisionRequestToolDescription: await exportedStringConst('DECISION_REQUEST_TOOL_DESCRIPTION'),
  }
  const results = []

  for (const testCase of cases) {
    results.push(await evaluateCase(apiKey, { ...testCase, policy }))
  }

  const failed = results.filter(result => !result.pass)

  if (args.has('--json')) {
    console.log(JSON.stringify({ endpoint, model, temperature, results }, null, 2))
  } else {
    console.log(`Autonomy eval: ${results.length - failed.length}/${results.length} passed (${model})`)
    for (const result of results) {
      const mark = result.pass ? 'PASS' : 'FAIL'
      const continued = result.continued === undefined ? '' : `; continued=${result.continued}`
      console.log(`${mark} ${result.id}: expected ${result.expectedTool}, got ${result.actualTool}${continued}`)
    }
  }

  if (failed.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
