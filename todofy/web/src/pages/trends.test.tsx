import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { niceCeiling, TrendChart } from '../components/TrendChart'
import { dailyMetrics, metricsDay } from '../test/fixtures'
import { apiError, mockApi, renderApp } from '../test/harness'

describe('budget page trends', () => {
  it('asks for 30 days and draws each chart with a text summary', async () => {
    const { calls } = mockApi({})
    renderApp('/budget')
    const trends = await screen.findByRole('region', { name: '近 30 天趋势' })
    const charts = await within(trends).findAllByRole('figure')
    expect(calls.find((call) => call.path === '/api/v1/metricDays')?.search).toBe('?page_size=30')
    expect(charts.map((chart) => within(chart).getByRole('img').getAttribute('aria-label')?.split('，')[0])).toEqual([
      '邮件（封）',
      '从收到到完成',
      'Gemini token（按模型）',
      '外部请求（次）',
    ])
    const mail = within(trends).getByRole('figure', { name: '邮件（封）' })
    expect(within(mail).getByRole('img')).toHaveAccessibleName(/收到：最高 70，最近一天 70/)
    const latency = within(trends).getByRole('figure', { name: '从收到到完成' })
    expect(within(latency).getByRole('img')).toHaveAccessibleName(/P90：最高 4 分钟，最近一天 4 分钟/)
    const tokens = within(trends).getByRole('figure', { name: 'Gemini token（按模型）' })
    // Largest 30-day total first.
    expect(within(tokens).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash'])
    // Stacked bars: one rect per model on each of the three recorded days.
    expect(tokens.querySelectorAll('rect')).toHaveLength(6)
  })

  it('gives every series of a chart its own colour, and every line its own dash', async () => {
    // Six models (a changed model list) on the recorded days: more than the five chart colours.
    const tokens = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`model-${n}`, n * 1000]))
    const days = dailyMetrics().metric_days ?? []
    mockApi({
      'GET /api/v1/metricDays': { metric_days: days.map((day) => (day.recorded ? { ...day, gemini_tokens: tokens } : day)) },
    })
    renderApp('/budget')
    const trends = await screen.findByRole('region', { name: '近 30 天趋势' })
    const charts = await within(trends).findAllByRole('figure')
    expect(charts).toHaveLength(4)
    const tokenChart = within(trends).getByRole('figure', { name: 'Gemini token（按模型）' })
    // The four largest models keep their own colour; the other two share '其他'.
    expect(within(tokenChart).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'model-6',
      'model-5',
      'model-4',
      'model-3',
      '其他',
    ])
    await userEvent.setup().click(within(tokenChart).getByText('数据表'))
    const lastRow = within(tokenChart).getAllByRole('row').at(-1)!
    expect(within(lastRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '6,000',
      '5,000',
      '4,000',
      '3,000',
      '3,000',
    ])
    for (const chart of charts) {
      const name = chart.getAttribute('aria-labelledby')
      const colours = within(chart)
        .getAllByRole('listitem')
        .map((item) => [...item.classList].find((token) => token.startsWith('series-')))
      expect(colours.every(Boolean), `${name}: every legend item has a series colour`).toBe(true)
      expect(new Set(colours).size, `${name}: colours are pairwise distinct`).toBe(colours.length)
      const lines = [...chart.querySelectorAll('path.trend-line')].map((path) => path.getAttribute('stroke-dasharray') ?? '')
      expect(new Set(lines).size, `${name}: dashes are pairwise distinct`).toBe(lines.length)
      const keys = [...chart.querySelectorAll('.trend-key line')].map((line) => line.getAttribute('stroke-dasharray') ?? '')
      expect(keys, `${name}: the legend shows each line's dash`).toEqual(lines)
      // No chart series uses a status tone (accent and ok are both green).
      expect(chart.querySelector('[class*="tone-"]')).toBeNull()
    }
  })

  it('offers every number as a table, marking days that were not counted', async () => {
    const user = userEvent.setup()
    mockApi({})
    renderApp('/budget')
    const mail = await screen.findByRole('figure', { name: '邮件（封）' })
    await user.click(within(mail).getByText('数据表'))
    const table = within(mail).getByRole('table', { name: '邮件（封）（UTC 日期）' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(31)
    expect(rows[1]).toHaveTextContent('2026-08-29未记录')
    expect(within(rows[30]!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['70', '61', '1'])
  })

  it('explains an empty history instead of drawing flat lines', async () => {
    mockApi({ 'GET /api/v1/metricDays': { metric_days: (dailyMetrics().metric_days ?? []).map((day) => ({ ...day, recorded: false })) } })
    renderApp('/budget')
    expect(await screen.findByText('还没有每日统计')).toBeInTheDocument()
    expect(screen.queryByRole('figure')).not.toBeInTheDocument()
  })

  it('shows a failure of the metrics read without hiding the budgets', async () => {
    mockApi({ 'GET /api/v1/metricDays': apiError(503, 'UNAVAILABLE', 'req-metrics') })
    renderApp('/budget')
    expect(await screen.findByRole('alert')).toHaveTextContent('req-metrics')
    expect(screen.getByRole('region', { name: 'Gemini' })).toBeInTheDocument()
  })
})

describe('trend chart', () => {
  it('rounds the scale up to 1, 2 or 5 times a power of ten', () => {
    expect([0, 1, 3, 7, 10, 11, 180, 400_001].map(niceCeiling)).toEqual([1, 1, 5, 10, 10, 20, 200, 500_000])
  })

  it('breaks a line at a gap and draws no mark for it', () => {
    const days = ['2026-09-25', '2026-09-26', '2026-09-27']
    const { container } = render(
      <TrendChart
        title="t"
        days={days}
        recorded={[true, true, true]}
        variant="line"
        format={String}
        series={[{ label: 'a', color: 1, values: [1, null, 2] }]}
      />,
    )
    expect(container.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2)
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(screen.getByRole('img')).toHaveAccessibleName('t，最近 3 天。a：最高 2，最近一天 2')
  })

  it('keeps unrecorded days out of the marks', () => {
    const { container } = render(
      <TrendChart
        title="bars"
        days={['2026-09-26', '2026-09-27']}
        recorded={[false, true]}
        variant="bar"
        format={String}
        series={[{ label: 'm', color: 1, values: [null, metricsDay('2026-09-27').gemini_call_count ?? 0] }]}
      />,
    )
    expect(container.querySelectorAll('rect')).toHaveLength(1)
  })
})
