import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { GtdDaily, GtdScope } from '../api/types'
import { apiError, mockApi, renderApp } from '../test/harness'

function scope(patch: Partial<GtdScope> = {}): GtdScope {
  return {
    open: 23,
    age_0_7: 12,
    age_8_14: 5,
    age_15_30: 4,
    age_31_plus: 2,
    oldest_days: 41,
    overdue: 3,
    undated: 40,
    created_7d: 35,
    completed_7d: 42,
    completed_source: 'api',
    closed_1d: null,
    mail_open: null,
    complete: true,
    ...patch,
  }
}

function gtdDaily(recordedDays = 2): GtdDaily {
  const days = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 8, 5 + index)).toISOString().slice(0, 10))
  return {
    days: days.map((day, index) => {
      const recorded = index >= 30 - recordedDays
      return {
        day,
        recorded,
        all: recorded ? scope({ open: 57, mail_open: 9, closed_1d: 4 }) : null,
        inbox: recorded ? scope() : null,
      }
    }),
    latest_review: { week: '2026-W40', state: 'created', created_at: '2026-10-04T17:00:02Z', completed_at: null },
  }
}

describe('GTD page', () => {
  it('shows the latest snapshot as counts, the review and three trends', async () => {
    const { calls } = mockApi({ 'GET /api/v1/gtd/daily': gtdDaily() })
    renderApp('/gtd')
    const snapshot = await screen.findByRole('region', { name: '快照 2026-10-04' })
    expect(calls.find((call) => call.path === '/api/v1/gtd/daily')?.search).toBe('?days=30')
    const facts = Object.fromEntries(
      within(snapshot)
        .getAllByRole('term')
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
    )
    expect(facts).toMatchObject({
      收件箱开放: '23',
      收件箱最老: '41 天',
      全部开放: '57',
      逾期: '3',
      '近 7 天新建 / 完成': '35 / 42',
      '14 天内仍开着的邮件任务': '9',
    })
    expect(within(screen.getByRole('region', { name: '每周回顾' })).getByText('2026-W40 · 已创建')).toBeInTheDocument()
    const charts = within(screen.getByRole('region', { name: '近 30 天趋势' })).getAllByRole('figure')
    expect(charts).toHaveLength(3)
  })

  it('explains an empty ledger and says when completions are unknown', async () => {
    mockApi({ 'GET /api/v1/gtd/daily': { ...gtdDaily(0), latest_review: null } })
    renderApp('/gtd')
    expect(await screen.findByText('还没有 Todoist 快照')).toBeInTheDocument()
    expect(screen.getByText('还没有回顾任务')).toBeInTheDocument()

    const partial = gtdDaily(1)
    const last = partial.days[29]!
    partial.days[29] = { ...last, all: scope({ complete: false, completed_7d: null, created_7d: null }), inbox: null }
    mockApi({ 'GET /api/v1/gtd/daily': partial })
    renderApp('/gtd')
    expect(await screen.findByText('任务过多，快照不完整')).toBeInTheDocument()
    expect(screen.getAllByText('不可用 / 不可用').length).toBeGreaterThan(0)
    expect(screen.getAllByText('未设置收件箱项目').length).toBeGreaterThan(0)
  })

  it('shows an API failure with a retry', async () => {
    mockApi({ 'GET /api/v1/gtd/daily': apiError(503, 'unavailable') })
    renderApp('/gtd')
    expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument()
  })
})
