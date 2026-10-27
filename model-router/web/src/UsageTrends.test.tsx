import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UsageTrends } from './UsageTrends'
import { renderApp } from './test/harness'

const buckets = [
  {
    time: '2026-10-26T00:00:00Z',
    billing_kind: 'api',
    request_count: 1,
    usage_available_count: 1,
    input_tokens: 14,
    output_tokens: 5,
    estimated_cost_microusd: 50,
  },
  { time: '2026-10-26T01:00:00Z', billing_kind: 'api', request_count: 1, usage_available_count: 0 },
]
const filters = { days: 1 as const, app: '', model: '', state: '', toTime: '2026-10-26T01:30:00Z' }

test('charts offer keyboard-readable hourly values and keep unknown costs unknown in the table', async () => {
  const user = userEvent.setup()
  renderApp(<UsageTrends buckets={buckets} filters={filters} />)
  expect(screen.getAllByText('UTC · 每小时')).toHaveLength(3)
  const chart = screen.getByRole('img', { name: /^Token 趋势/ })
  await user.tab()
  await user.tab()
  await user.tab()
  expect(chart).toHaveFocus()
  const figure = chart.closest('figure')!
  expect(figure).toHaveTextContent('输入：未提供')
  await user.keyboard('{ArrowLeft}')
  expect(figure).toHaveTextContent('2026-10-26 00:00 UTC')
  expect(figure).toHaveTextContent('输入：14')
  expect(figure).toHaveTextContent('输出：5')
  const costFigure = screen.getByRole('img', { name: /^费用趋势/ }).closest('figure')!
  await user.click(within(costFigure).getByText('数据表', { selector: 'summary' }))
  const row = within(costFigure).getByRole('rowheader', { name: '2026-10-26 01:00' }).closest('tr')!
  expect(within(row).getByText('未提供')).toBeInTheDocument()
  expect(within(costFigure).getByRole('columnheader', { name: '订阅 API 等价' })).toBeInTheDocument()
})
