import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconEditOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DecisionUiItem } from '../web-contract.ts'
import type { DecisionInboxApi } from './api.ts'

export interface DecisionInboxDockProps {
  api: DecisionInboxApi
  pollIntervalMs?: number
}

function displayOption(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/iu
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

export function DecisionInboxDock({ api, pollIntervalMs = 1_200 }: DecisionInboxDockProps) {
  const [decisions, setDecisions] = useState<DecisionUiItem[]>([])
  const [expanded, setExpanded] = useState(false)
  const [index, setIndex] = useState(0)
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const loadingRef = useRef(false)
  const knownCountRef = useRef(0)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const next = await api.list(signal)
      setDecisions(next)
      setIndex(current => Math.min(current, Math.max(0, next.length - 1)))
      if (knownCountRef.current === 0 && next.length > 0) setExpanded(true)
      knownCountRef.current = next.length
    } catch (error) {
      if (signal?.aborted) return
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      loadingRef.current = false
    }
  }, [api])

  useEffect(() => {
    const abort = new AbortController()
    void refresh(abort.signal)
    const timer = window.setInterval(() => { void refresh(abort.signal) }, pollIntervalMs)
    return () => {
      abort.abort()
      window.clearInterval(timer)
    }
  }, [pollIntervalMs, refresh])

  const decision = decisions[index]
  useEffect(() => {
    setCustomOpen(decision?.options.length === 0)
    setCustom('')
    setFeedback(null)
  }, [decision?.id])

  const submit = async (answer: string): Promise<void> => {
    if (decision === undefined || busy || answer.trim() === '') return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await api.answer(decision.id, answer.trim())
      if (result.kind === 'not-found') {
        setFeedback({ kind: 'error', text: '这个问题已不存在。' })
      } else if (result.kind === 'not-pending') {
        setFeedback({ kind: 'error', text: '这个问题已经由其他页面处理。' })
      } else if (result.kind === 'already-answered' && !result.matchesExisting) {
        setFeedback({ kind: 'error', text: '这个问题已经提交了不同的答案。' })
      } else {
        setFeedback({
          kind: result.delivered ? 'success' : 'error',
          text: result.delivered ? '答案已发送给 Agent。' : '答案已保存，但尚未发送；可以重试。',
        })
      }
      await refresh()
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const submitFromInput = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit(custom)
  }

  const downloadExport = async (): Promise<void> => {
    if (exporting) return
    setExporting(true)
    setFeedback(null)
    try {
      const file = await api.exportAudit()
      const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }))
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      setFeedback({ kind: 'success', text: `已导出审计日志：${file.filename}` })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setExporting(false)
    }
  }

  if (decision === undefined) return null
  const retrying = decision.status === 'answered' && decision.deliveryStatus === 'pending'

  return (
    <div className="dsh-di-dock" data-decision-inbox>
      <section className="dsh-di-card" aria-label="待决问题">
        <button
          type="button"
          className="dsh-di-toggle"
          aria-expanded={expanded}
          onClick={() => { setExpanded(value => !value) }}
        >
          <span className="dsh-di-dot" aria-hidden />
          <span className="dsh-di-label">待你决定</span>
          <span className="dsh-di-count">{decisions.length}</span>
          <span className="dsh-di-spacer" />
          <span className="dsh-di-chevron" data-open={expanded} aria-hidden>
            <IconChevronDownOutline14 />
          </span>
        </button>

        {expanded && (
          <div className="dsh-di-body">
            <div className="dsh-di-meta">
              <span>非阻塞问题</span>
              {decision.expiresAt !== undefined && <span>此问题会自动过期</span>}
            </div>
            <h2 className="dsh-di-question">{decision.question}</h2>

            {retrying
              ? (
                <div className="dsh-di-retry" role="status">
                  <span>已选择“{decision.answer}”，但尚未送达。</span>
                  <button type="button" disabled={busy} onClick={() => { void submit(decision.answer ?? '') }}>
                    重新发送
                  </button>
                </div>
              )
              : (
                <>
                  <div className="dsh-di-options" role="radiogroup" aria-label={decision.question}>
                    {decision.options.map((option, optionIndex) => {
                      const display = displayOption(option.label)
                      return (
                        <button
                          type="button"
                          className="dsh-di-option"
                          role="radio"
                          aria-checked="false"
                          disabled={busy}
                          key={option.label}
                          onClick={() => { void submit(option.label) }}
                        >
                          <span className="dsh-di-number" aria-hidden>{optionIndex + 1}</span>
                          <span className="dsh-di-option-copy">
                            <span className="dsh-di-option-label">{display.label}</span>
                            {display.recommended && <span className="dsh-di-recommended">推荐</span>}
                            {option.description !== undefined && (
                              <span className="dsh-di-description">{option.description}</span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                    {decision.options.length > 0 && !customOpen && (
                      <button
                        type="button"
                        className="dsh-di-option dsh-di-custom-trigger"
                        disabled={busy}
                        onClick={() => { setCustomOpen(true) }}
                      >
                        <span className="dsh-di-number" aria-hidden><IconEditOutline16 size={12} /></span>
                        <span className="dsh-di-option-label">其他答案</span>
                      </button>
                    )}
                  </div>
                  {customOpen && (
                    <div className="dsh-di-custom">
                      <input
                        autoFocus
                        className="dsh-di-input"
                        aria-label="自定义答案"
                        placeholder="输入你的答案"
                        value={custom}
                        disabled={busy}
                        onChange={event => { setCustom(event.target.value); setFeedback(null) }}
                        onKeyDown={submitFromInput}
                      />
                      <button
                        type="button"
                        className="dsh-di-submit"
                        disabled={busy || custom.trim() === ''}
                        onClick={() => { void submit(custom) }}
                      >
                        提交
                      </button>
                    </div>
                  )}
                </>
              )}

            <footer className="dsh-di-footer">
              {decisions.length > 1 && (
                <div className="dsh-di-nav" aria-label="切换待决问题">
                  <button type="button" aria-label="上一个问题" disabled={index === 0 || busy} onClick={() => { setIndex(value => value - 1) }}>
                    <IconChevronLeftOutline14 />
                  </button>
                  <span className="dsh-di-progress">{index + 1} / {decisions.length}</span>
                  <button type="button" aria-label="下一个问题" disabled={index === decisions.length - 1 || busy} onClick={() => { setIndex(value => value + 1) }}>
                    <IconChevronRightOutline14 />
                  </button>
                </div>
              )}
              <button
                type="button"
                className="dsh-di-export"
                disabled={exporting}
                onClick={() => { void downloadExport() }}
              >
                {exporting ? '导出中…' : '导出审计日志'}
              </button>
              <span className="dsh-di-feedback" data-kind={feedback?.kind} role="status">
                {feedback?.text}
              </span>
            </footer>
          </div>
        )}
      </section>
    </div>
  )
}
