import { screen, within } from '@testing-library/react'
import type { GtdDay, GtdScope } from '@ziyixi/proto/todofy/ui/v1/history_wire'
import { describe, expect, it } from 'vitest'
import { gtdReview, gtdScope } from '../test/fixtures'
import { apiError, mockApi, renderApp } from '../test/harness'

function scope(patch: Partial<GtdScope> = {}): GtdScope {
  return gtdScope({
    open_count: 23,
    fresh_count: 12,
    recent_count: 5,
    stale_count: 4,
    old_count: 2,
    oldest_age_days: 41,
    overdue_count: 3,
    undated_count: 40,
    created_last_week_count: 35,
    completed_last_week_count: 42,
    closed_last_day_count: undefined,
    open_mail_count: undefined,
    ...patch,
  })
}

/** ListGtdDays: 30 days ending 2026-10-04, newest first, the newest `recordedDays` recorded. */
function gtdDays(recordedDays = 2, last?: Partial<GtdDay>): { gtd_days: GtdDay[] } {
  const days = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 8, 5 + index)).toISOString().slice(0, 10))
  const oldestFirst = days.map((day, index): GtdDay => {
    const recorded = index >= 30 - recordedDays
    return recorded
      ? { name: `gtdDays/${day}`, recorded, all_projects: scope({ open_count: 57, open_mail_count: 9, closed_last_day_count: 4 }), inbox: scope() }
      : { name: `gtdDays/${day}` }
  })
  if (last) oldestFirst[29] = { ...oldestFirst[29]!, ...last }
  return { gtd_days: oldestFirst.toReversed() }
}

const REVIEWS = { gtd_reviews: [gtdReview({ name: 'gtdReviews/2026-w40', create_time: '2026-10-04T17:00:02Z' })] }

describe('GTD page', () => {
  it('shows the latest snapshot as counts, the review and three trends', async () => {
    const { calls } = mockApi({ 'GET /api/v1/gtdDays': gtdDays(), 'GET /api/v1/gtdReviews': REVIEWS })
    renderApp('/gtd')
    const snapshot = await screen.findByRole('region', { name: '快照 2026-10-04' })
    expect(calls.find((call) => call.path === '/api/v1/gtdDays')?.search).toBe('?page_size=30')
    expect(calls.find((call) => call.path === '/api/v1/gtdReviews')?.search).toBe('?page_size=1')
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
      '1–14 天前收到、仍开着的邮件任务': '9',
    })
    // The ID is lower case (AIP-122); the page shows the ISO week.
    expect(within(screen.getByRole('region', { name: '每周回顾' })).getByText('2026-W40 · 已创建')).toBeInTheDocument()
    const charts = within(screen.getByRole('region', { name: '近 30 天趋势' })).getAllByRole('figure')
    expect(charts).toHaveLength(3)
  })

  it('explains an empty ledger and says when completions are unknown', async () => {
    mockApi({ 'GET /api/v1/gtdDays': gtdDays(0), 'GET /api/v1/gtdReviews': {} })
    renderApp('/gtd')
    expect(await screen.findByText('还没有 Todoist 快照')).toBeInTheDocument()
    expect(await screen.findByText('还没有回顾任务')).toBeInTheDocument()

    const partial = gtdDays(1, {
      all_projects: scope({ complete: false, completed_last_week_count: undefined, created_last_week_count: undefined }),
      inbox: undefined,
    })
    mockApi({ 'GET /api/v1/gtdDays': partial, 'GET /api/v1/gtdReviews': REVIEWS })
    renderApp('/gtd')
    expect(await screen.findByText('任务过多，快照不完整')).toBeInTheDocument()
    expect(screen.getAllByText('不可用 / 不可用').length).toBeGreaterThan(0)
    expect(screen.getAllByText('未设置收件箱项目').length).toBeGreaterThan(0)
  })

  it('shows an API failure with a retry', async () => {
    mockApi({ 'GET /api/v1/gtdDays': apiError(503, 'UNAVAILABLE'), 'GET /api/v1/gtdReviews': REVIEWS })
    renderApp('/gtd')
    expect(await screen.findByRole('button', { name: /重试/ })).toBeInTheDocument()
  })
})
