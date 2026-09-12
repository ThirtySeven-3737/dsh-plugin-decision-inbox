// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionUiItem } from '../src/web-contract.ts'
import type { DecisionInboxApi } from '../src/client/api.ts'
import { DecisionInboxDock } from '../src/client/DecisionInboxDock.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => <span aria-hidden>⌄</span>,
  IconChevronLeftOutline14: () => <span aria-hidden>‹</span>,
  IconChevronRightOutline14: () => <span aria-hidden>›</span>,
  IconEditOutline16: () => <span aria-hidden>✎</span>,
}))

afterEach(cleanup)

function decision(overrides: Partial<DecisionUiItem> = {}): DecisionUiItem {
  return {
    id: 'decision-ui-1',
    question: '最终发布清单使用哪种格式？',
    options: [{ label: 'JSON (推荐)', description: '适合自动处理' }, { label: 'YAML' }],
    status: 'pending',
    deliveryStatus: 'none',
    createdAt: 1,
    revision: 1,
    ...overrides,
  }
}

function api(list: DecisionUiItem[]): DecisionInboxApi & {
  list: ReturnType<typeof vi.fn>
  answer: ReturnType<typeof vi.fn>
  exportAudit: ReturnType<typeof vi.fn>
} {
  return {
    list: vi.fn().mockResolvedValue(list),
    answer: vi.fn().mockResolvedValue({
      kind: 'answered', decision: list[0], delivered: true,
    }),
    exportAudit: vi.fn().mockResolvedValue({
      filename: 'decision-inbox-audit.csv',
      mime: 'text/csv;charset=utf-8',
      text: 'seq,ts\n1,2\n',
    }),
  } as unknown as DecisionInboxApi & {
    list: ReturnType<typeof vi.fn>
    answer: ReturnType<typeof vi.fn>
    exportAudit: ReturnType<typeof vi.fn>
  }
}

describe('DecisionInboxDock', () => {
  it('opens automatically and submits an option without exposing a decision id or command', async () => {
    const client = api([decision()])
    client.list.mockResolvedValueOnce([decision()]).mockResolvedValueOnce([])
    render(<DecisionInboxDock api={client} pollIntervalMs={60_000} />)

    expect(await screen.findByText('最终发布清单使用哪种格式？')).toBeTruthy()
    expect(screen.queryByText('decision-ui-1')).toBeNull()
    expect(screen.queryByText(/\/decision/u)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /JSON/u }))

    await waitFor(() => { expect(client.answer).toHaveBeenCalledWith('decision-ui-1', 'JSON (推荐)') })
    await waitFor(() => { expect(screen.queryByLabelText('待决问题')).toBeNull() })
  })

  it('supports a free-text answer when the model supplied no options', async () => {
    const item = decision({ id: 'decision-custom', question: '填写发布渠道', options: [] })
    const client = api([item])
    client.list.mockResolvedValueOnce([item]).mockResolvedValueOnce([])
    render(<DecisionInboxDock api={client} pollIntervalMs={60_000} />)

    const input = await screen.findByRole('textbox', { name: '自定义答案' })
    fireEvent.change(input, { target: { value: '灰度发布' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(client.answer).toHaveBeenCalledWith('decision-custom', '灰度发布') })
  })

  it('pages through multiple pending questions in one compact card', async () => {
    const first = decision()
    const second = decision({ id: 'decision-ui-2', question: '发布说明使用哪种语言？' })
    const client = api([first, second])
    render(<DecisionInboxDock api={client} pollIntervalMs={60_000} />)

    expect(await screen.findByText('1 / 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一个问题' }))
    expect(screen.getByText('发布说明使用哪种语言？')).toBeTruthy()
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  it('renders a retry action for a durably saved but undelivered answer', async () => {
    const item = decision({
      status: 'answered', deliveryStatus: 'pending', answer: 'JSON', options: [],
    })
    const client = api([item])
    render(<DecisionInboxDock api={client} pollIntervalMs={60_000} />)

    fireEvent.click(await screen.findByRole('button', { name: '重新发送' }))
    await waitFor(() => { expect(client.answer).toHaveBeenCalledWith('decision-ui-1', 'JSON') })
  })

  it('downloads an audit export from the card footer', async () => {
    const file = {
      filename: 'decision-inbox-audit.csv',
      mime: 'text/csv;charset=utf-8',
      text: 'seq,ts\n1,2\n',
    }
    const client = api([decision()])
    client.exportAudit.mockResolvedValue(file)
    const createObjectURL = vi.fn(() => 'blob:decision-inbox-export')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    render(<DecisionInboxDock api={client} pollIntervalMs={60_000} />)

    fireEvent.click(await screen.findByRole('button', { name: '导出审计日志' }))

    await waitFor(() => { expect(client.exportAudit).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getByText(/已导出审计日志/u)).toBeTruthy() })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:decision-inbox-export')
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })
})
