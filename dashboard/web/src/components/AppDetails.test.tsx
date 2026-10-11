import { render, screen, within } from '@testing-library/react'
import type { OpsStatus } from '../../../worker/src/api-types.ts'
import watchOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/watch-ok.json'
import watchDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/watch-degraded.json'
import briefOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/brief-ok.json'
import briefDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/brief-degraded.json'
import { signalLabel } from '../lib/labels'
import { AppDetails } from './AppDetails'

const NOW = new Date('2026-10-01T14:05:00Z')

function show(status: OpsStatus) {
  render(
    <AppDetails
      card={{ entry: status.app, reachable: true, checked_at: status.generated_at, error: null, consecutive_failures: 0, status, status_at: status.generated_at }}
      entry={undefined}
      guard={undefined}
      now={NOW}
    />,
  )
}

describe('应用详情 of the watch app', () => {
  it('shows its healthy modes as usual and every counter by name, never a raw code', () => {
    show(watchOk as unknown as OpsStatus)
    const modes = screen.getByRole('list', { name: '运行模式' })
    expect(within(modes).getByText(/通知 Todofy：开/)).toBeInTheDocument()
    expect(within(modes).queryByText('（非常规）')).toBeNull()
    expect(modes.querySelector('.chip-attention')).toBeNull()
    for (const code of Object.keys(watchOk.counters)) expect(screen.queryByText(new RegExp(`^${code}\\b`))).toBeNull()
    expect(screen.getByText('今日交给 Todofy')).toBeInTheDocument()
  })

  it('names its signals (the code stays beside the name, as for every app)', () => {
    show(watchDegraded as unknown as OpsStatus)
    for (const signal of watchDegraded.signals) expect(signalLabel(signal.code)).not.toBe(signal.code)
    expect(screen.getByText('有监视已失效')).toBeInTheDocument()
    expect(screen.getByText('调度已停止')).toBeInTheDocument()
  })
})

describe('应用详情 of Brief', () => {
  it('shows archive mode and the reported monthly budget in dollars', () => {
    show(briefOk as unknown as OpsStatus)
    expect(screen.getByText(/未启用正式模式：开/)).toBeInTheDocument()
    expect(screen.getByText('US$ 80.00')).toBeInTheDocument()
  })

  it('names failures and the work deferred by its guard', () => {
    show(briefDegraded as unknown as OpsStatus)
    expect(screen.getByText('Claude 调用被拒绝')).toBeInTheDocument()
    expect(screen.getByText('简报发送结果待核对')).toBeInTheDocument()
    expect(screen.getByText('推迟的任务：候选条目向量计算、每周学习、已暂停来源探测')).toBeInTheDocument()
  })
})
