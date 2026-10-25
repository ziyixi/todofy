import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { codexInference, NOW, withCodex } from '../test/fixtures'
import { AppDetails } from './AppDetails'

const base = () => withCodex().ops.apps.find((app) => app.entry === 'codex-gateway')!

function show(inference: OpsStatus['codex_inference']) {
  const card = base()
  render(<AppDetails card={{ ...card, status: { ...card.status!, codex_inference: inference } }} entry={undefined} guard={undefined} now={NOW} />)
}

const metric = (label: string) => within(screen.getByText(label, { selector: '.counter dt' }).closest('.counter') as HTMLElement)

describe('Codex inference observations', () => {
  it('shows persistent history after a process restart and keeps repeated request sequences', () => {
    const reactErrors = vi.spyOn(console, 'error')
    show(codexInference({ started_at: '2026-09-29T16:59:00.000Z', request_count: 1,
      success_count: 0, failure_count: 0, input_tokens: 0, output_tokens: 0, usage_reported_count: 0,
      last_completed_at: undefined, last_duration_ms: undefined, average_duration_ms: undefined, last_error_code: '',
      recent_requests: codexInference().recent_requests.map((request) => ({ ...request, sequence: 1 })),
    }))
    expect(screen.getByText('进程状态')).toBeInTheDocument()
    expect(screen.getByText('正常')).toBeInTheDocument()
    expect(metric('已完成请求').getByText('2')).toBeInTheDocument()
    expect(metric('采样时进行中').getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '今天' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('开始记录').nextElementSibling?.querySelector('time')).toHaveAttribute('datetime', '2026-09-28T14:00:00.000Z')
    expect(screen.getByText('最近完成').nextElementSibling?.querySelector('time')).toHaveAttribute('datetime', '2026-09-29T16:58:00.000Z')
    expect(screen.getByText('最近耗时').nextElementSibling).toHaveTextContent('110 秒')
    expect(screen.getByText('最近错误：推理超时')).toBeInTheDocument()
    const rows = within(screen.getByRole('table', { name: '最近完成的推理请求，最多 8 条' })).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole('rowheader').querySelector('time')).toHaveAttribute('datetime', '2026-09-29T16:58:00.000Z')
    expect(within(rows[1]!).getByRole('rowheader').querySelector('time')).toHaveAttribute('datetime', '2026-09-29T16:54:00.000Z')
    expect(within(rows[0]!).getByText('失败')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('推理超时')).toBeInTheDocument()
    expect(within(rows[0]!).getAllByText('未提供')).toHaveLength(2)
    expect(within(rows[1]!).getByText('成功')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('6,400')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('5.4 秒')).toBeInTheDocument()
    expect(screen.getByText('SDK 版本').nextElementSibling).toHaveTextContent('0.163.0')
    expect(screen.queryByText('降载')).not.toBeInTheDocument()
    expect(screen.queryByText('上次备份')).not.toBeInTheDocument()
    expect(screen.queryByText('计数')).not.toBeInTheDocument()
    expect(reactErrors).not.toHaveBeenCalled()
  })

  it('keeps a missing snapshot unknown and an empty persistent history neutral when daily rows are omitted', () => {
    const view = render(<AppDetails card={{ ...base(), status: { ...base().status!, codex_inference: undefined } }} entry={undefined} guard={undefined} now={NOW} />)
    expect(screen.getByText('尚未采集推理记录。进程状态见上方。')).toBeInTheDocument()
    expect(screen.queryByText('已完成请求')).not.toBeInTheDocument()
    view.unmount()
    show(codexInference({ request_count: 0, success_count: 0, failure_count: 0, active_count: 0,
      input_tokens: 0, output_tokens: 0, usage_reported_count: 0, last_completed_at: undefined,
      last_duration_ms: undefined, average_duration_ms: undefined, last_error_code: '', recent_requests: [], daily_usage: undefined }))
    expect(metric('已完成请求').getByText('0')).toBeInTheDocument()
    expect(screen.getByText('所选范围尚无已完成请求。')).toBeInTheDocument()
    expect(screen.getByText('暂无已完成请求。')).toBeInTheDocument()
    expect(metric('输入 token').getByText('尚无记录')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '今天' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(/当前为旧版进程数据/)).not.toBeInTheDocument()
  })

  it('does not turn missing token usage into zero, and names only safe errors', () => {
    const days = (codexInference().daily_usage ?? []).map((day) => ({ ...day, usage_reported_count: 0, input_tokens: 0, output_tokens: 0 }))
    show(codexInference({ usage_reported_count: 0, input_tokens: 0, output_tokens: 0,
      last_error_code: '', daily_usage: days,
      recent_requests: codexInference().recent_requests.map((request) => ({ ...request, error_code: 'unrecognized_private_error' })),
    }))
    expect(metric('输入 token').getByText('未提供')).toBeInTheDocument()
    expect(metric('输出 token').getByText('未提供')).toBeInTheDocument()
    expect(screen.getByText(/已取得 0 \/ 2 次已完成请求的用量/)).toBeInTheDocument()
    expect(screen.getByText('最近错误：推理失败，错误类型未识别')).toBeInTheDocument()
    expect(screen.queryByText(/unrecognized_private_error/)).not.toBeInTheDocument()
  })

  it('marks an old gateway sample even when the Home projection was just generated', () => {
    show(codexInference({ observed_at: '2026-09-29T15:40:00.000Z' }))
    expect(screen.getByText('采样已超过 1 小时，下方为历史记录。')).toBeInTheDocument()
    const clock = screen.getByText('采样于').nextElementSibling?.querySelector('time')
    expect(clock).toHaveAttribute('datetime', '2026-09-29T15:40:00.000Z')
    expect(metric('已完成请求').getByText('2')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '最近推理请求，可横向滚动' })).toHaveAttribute('tabindex', '0')
  })

  it('uses UTC calendar boundaries and the same daily rows for seven-day and thirty-day totals', async () => {
    const user = userEvent.setup()
    const extraDay = (day: string, requests: number) => ({ day, request_count: requests, success_count: 0, failure_count: requests,
      input_tokens: 0, output_tokens: 0, usage_reported_count: 0, total_duration_ms: requests * 1_000 })
    show(codexInference({ daily_usage: [...(codexInference().daily_usage ?? []),
      extraDay('2026-09-23', 1), extraDay('2026-09-22', 10), extraDay('2026-08-31', 20), extraDay('2026-08-30', 100)],
    }))
    const daily = () => within(screen.getByRole('table', { name: '每日推理用量（UTC）' }))
    // NOW is already September 30 in the configured browser time zone (Asia/Shanghai).
    expect(daily().getByRole('rowheader', { name: '2026-09-29' })).toBeInTheDocument()
    expect(daily().queryByRole('rowheader', { name: '2026-09-28' })).not.toBeInTheDocument()
    expect(screen.getByText('所选范围平均耗时').nextElementSibling).toHaveTextContent('57.7 秒')

    await user.click(screen.getByRole('button', { name: '近 7 天' }))
    expect(metric('已完成请求').getByText('7')).toBeInTheDocument()
    expect(metric('成功').getByText('5')).toBeInTheDocument()
    expect(metric('失败').getByText('2')).toBeInTheDocument()
    expect(metric('输入 token').getByText('16,400')).toBeInTheDocument()
    expect(metric('输出 token').getByText('800')).toBeInTheDocument()
    expect(screen.getByText('所选范围平均耗时').nextElementSibling).toHaveTextContent('20.1 秒')
    expect(daily().getAllByRole('rowheader').map((row) => row.textContent)).toEqual(['2026-09-29', '2026-09-28', '2026-09-23'])
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: '近 30 天' }))
    expect(metric('已完成请求').getByText('37')).toBeInTheDocument()
    expect(daily().getByRole('rowheader', { name: '2026-08-31' })).toBeInTheDocument()
    expect(daily().queryByRole('rowheader', { name: '2026-08-30' })).not.toBeInTheDocument()
    expect(screen.getByText('所选范围平均耗时').nextElementSibling).toHaveTextContent('4.6 秒')
    expect(screen.getByRole('region', { name: '每日推理用量，可横向滚动' })).toHaveAttribute('tabindex', '0')
    expect(screen.queryByText('2026-09-27')).not.toBeInTheDocument()
  })

  it.each([undefined, []])('labels an older gateway as process-only data while persistent history awaits upgrade (%j)', (dailyUsage) => {
    show(codexInference({ history_since: undefined, daily_usage: dailyUsage }))
    expect(screen.getByText('当前为旧版进程数据，持久化每日用量等待网关升级后采集。')).toBeInTheDocument()
    expect(metric('请求总数').getByText('3')).toBeInTheDocument()
    expect(screen.getByText('进程平均耗时').nextElementSibling).toHaveTextContent('57.7 秒')
    expect(screen.queryByText('开始记录')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '推理统计范围（UTC）' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '每日推理用量（UTC）' })).not.toBeInTheDocument()
    expect(screen.queryByText(/跨重启保留/)).not.toBeInTheDocument()
  })
})
