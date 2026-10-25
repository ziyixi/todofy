import { render, screen, within } from '@testing-library/react'
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
  it('shows process health separately from successful and failed inference records', () => {
    show(codexInference())
    expect(screen.getByText('进程状态')).toBeInTheDocument()
    expect(screen.getByText('正常')).toBeInTheDocument()
    expect(metric('请求总数').getByText('3')).toBeInTheDocument()
    expect(metric('采样时进行中').getByText('1')).toBeInTheDocument()
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
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
  })

  it('keeps a missing snapshot unknown and an unused process neutral', () => {
    const view = render(<AppDetails card={{ ...base(), status: { ...base().status!, codex_inference: undefined } }} entry={undefined} guard={undefined} now={NOW} />)
    expect(screen.getByText('尚未采集推理记录。进程状态见上方。')).toBeInTheDocument()
    expect(screen.queryByText('请求总数')).not.toBeInTheDocument()
    view.unmount()
    show(codexInference({ request_count: 0, success_count: 0, failure_count: 0, active_count: 0,
      input_tokens: 0, output_tokens: 0, usage_reported_count: 0, last_completed_at: undefined,
      last_duration_ms: undefined, average_duration_ms: undefined, last_error_code: '', recent_requests: [] }))
    expect(metric('请求总数').getByText('0')).toBeInTheDocument()
    expect(screen.getByText('本次启动以来还没有推理请求。')).toBeInTheDocument()
    expect(metric('输入 token').getByText('尚无记录')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not turn missing token usage into zero, and names only safe errors', () => {
    show(codexInference({ usage_reported_count: 0, input_tokens: 0, output_tokens: 0,
      last_error_code: 'unrecognized_private_error' }))
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
    expect(metric('请求总数').getByText('3')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '最近推理请求，可横向滚动' })).toHaveAttribute('tabindex', '0')
  })
})
