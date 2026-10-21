import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { Fact, Facts, Time } from './ui'

/** Safe connection observations from the existing Ops status; absence of activity is neutral. */
export function PersonalMcpDetails({ status, now }: { status: OpsStatus; now: Date }) {
  const { counters } = status
  const available = counters.active_subscriptions !== undefined
  const count = (key: string) => counters[key] ?? '未读取'
  const observedAt = (key: string) => {
    const value = counters[key]
    const at = value !== undefined && value > 0 ? new Date(value) : null
    return at !== null && Number.isFinite(at.getTime())
      ? <Time iso={at.toISOString()} now={now} /> : available ? '尚无记录' : '未读取'
  }
  return (
    <div className="subsection">
      <h4>ChatGPT 连接与订阅</h4>
      <Facts>
        <Fact label="当前订阅">{count('active_subscriptions')}</Fact>
        <Fact label="最近工具调用">{observedAt('last_tool_at_ms')}</Fact>
        <Fact label="最近订阅操作">{observedAt('last_subscription_at_ms')}</Fact>
        <Fact label="最近事件">{observedAt('last_event_at_ms')}</Fact>
        <Fact label="最近投递">{observedAt('last_delivery_at_ms')}</Fact>
        <Fact label="最近来源检查">{observedAt('last_source_check_at_ms')}</Fact>
        <Fact label="待投递">{count('pending_deliveries')}</Fact>
        <Fact label="回调已接收">{count('accepted_deliveries')}</Fact>
        <Fact label="投递失败">{count('failed_deliveries')}</Fact>
      </Facts>
      {counters.active_subscriptions === 0 ? <p className="small muted">暂无订阅。可在 ChatGPT 对话中创建订阅。</p> : null}
      <p className="small muted">工具调用时间只记录已认证的调用。回调已接收表示 ChatGPT 接管事件，后续处理结果请在对应对话查看。</p>
    </div>
  )
}
