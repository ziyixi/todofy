import { useState } from 'react'
import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { formatNumber, utcDay, utcDayBefore } from '../lib/format'
import { Button, Fact, Facts, Notice, Pill, Time } from './ui'

type InferenceStatus = NonNullable<OpsStatus['codex_inference']>
type DailyUsage = NonNullable<InferenceStatus['daily_usage']>[number]
type UsageTotals = Omit<DailyUsage, 'day'>
const SAMPLE_STALE_MS = 60 * 60_000
const PERIODS = [{ days: 1, label: '今天' }, { days: 7, label: '近 7 天' }, { days: 30, label: '近 30 天' }] as const

const ERROR_LABELS: Readonly<Record<string, string>> = {
  codex_configuration: '推理配置异常',
  codex_startup: '推理进程启动失败',
  codex_account: '订阅状态检查失败',
  codex_skills: '运行环境检查失败',
  codex_auth: '订阅登录需要更新',
  codex_quota: '订阅额度暂不可用',
  codex_timeout: '推理超时',
  codex_unavailable: '推理服务暂不可用',
  codex_bad_answer: '推理结果不符合约定',
  codex_cancelled: '推理请求已中断',
}

function errorLabel(code: string): string {
  return Object.hasOwn(ERROR_LABELS, code) ? ERROR_LABELS[code] as string : '推理失败，错误类型未识别'
}

function duration(ms: number): string {
  return ms < 1_000 ? `${formatNumber(ms)} ms` : `${formatNumber(ms / 1_000)} 秒`
}

function usageValue(value: number, reported: number, completed: number): string {
  return reported > 0 ? formatNumber(value) : completed > 0 ? '未提供' : '尚无记录'
}

function UsageCounters({ usage, active, persistent }: {
  usage: Pick<InferenceStatus, 'request_count' | 'success_count' | 'failure_count' | 'input_tokens' | 'output_tokens' | 'usage_reported_count'>
  active: number
  persistent: boolean
}) {
  const completed = usage.success_count + usage.failure_count
  return (
    <>
      <dl className="counters codex-counters">
        <div className="counter"><dt>{persistent ? '已完成请求' : '请求总数'}</dt><dd>{formatNumber(usage.request_count)}</dd></div>
        <div className="counter"><dt>成功</dt><dd>{formatNumber(usage.success_count)}</dd></div>
        <div className="counter"><dt>失败</dt><dd>{formatNumber(usage.failure_count)}</dd></div>
        <div className="counter"><dt>采样时进行中</dt><dd>{formatNumber(active)}</dd></div>
        <div className="counter"><dt>输入 token</dt><dd>{usageValue(usage.input_tokens, usage.usage_reported_count, completed)}</dd></div>
        <div className="counter"><dt>输出 token</dt><dd>{usageValue(usage.output_tokens, usage.usage_reported_count, completed)}</dd></div>
      </dl>
      <p className="small muted">已取得 {formatNumber(usage.usage_reported_count)} / {formatNumber(completed)} 次已完成请求的用量。输入 token 包含缓存。</p>
    </>
  )
}

function RecordedUsage({ inference, now }: { inference: InferenceStatus; now: Date }) {
  const [period, setPeriod] = useState<number>(1)
  const today = utcDay(now)
  const firstDay = utcDayBefore(today, period - 1)
  const days = (inference.daily_usage ?? []).filter((item) => item.day >= firstDay && item.day <= today)
  const totals = days.reduce<UsageTotals>((sum, item) => ({
    request_count: sum.request_count + item.request_count,
    success_count: sum.success_count + item.success_count,
    failure_count: sum.failure_count + item.failure_count,
    input_tokens: sum.input_tokens + item.input_tokens,
    output_tokens: sum.output_tokens + item.output_tokens,
    usage_reported_count: sum.usage_reported_count + item.usage_reported_count,
    total_duration_ms: sum.total_duration_ms + item.total_duration_ms,
  }), { request_count: 0, success_count: 0, failure_count: 0, input_tokens: 0, output_tokens: 0, usage_reported_count: 0, total_duration_ms: 0 })
  return (
    <>
      <div className="codex-periods" role="group" aria-label="推理统计范围（UTC）">
        {PERIODS.map(({ days, label }) => (
          <Button key={days} variant={period === days ? 'primary' : 'secondary'} aria-pressed={period === days} onClick={() => setPeriod(days)}>{label}</Button>
        ))}
      </div>
      <p className="small muted">{firstDay === today ? today : `${firstDay} 至 ${today}`}（UTC），按请求完成日统计。</p>
      <UsageCounters usage={totals} active={inference.active_count} persistent />
      <Facts>
        <Fact label="所选范围平均耗时">{totals.request_count > 0 ? duration(totals.total_duration_ms / totals.request_count) : '尚无记录'}</Fact>
      </Facts>
      <h4>每日用量</h4>
      {days.length === 0 ? <p className="small muted">所选范围尚无已完成请求。</p> : (
        <div className="table-wrap codex-request-scroll" tabIndex={0} role="region" aria-label="每日推理用量，可横向滚动">
          <table className="res-table codex-requests">
            <caption className="visually-hidden">每日推理用量（UTC）</caption>
            <thead><tr>
              <th scope="col">日期（UTC）</th><th scope="col">已完成</th><th scope="col">成功</th><th scope="col">失败</th>
              <th scope="col">输入 token</th><th scope="col">输出 token</th><th scope="col">用量记录</th><th scope="col">平均耗时</th>
            </tr></thead>
            <tbody>{days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{day.day}</th>
                <td className="num">{formatNumber(day.request_count)}</td>
                <td className="num">{formatNumber(day.success_count)}</td>
                <td className="num">{formatNumber(day.failure_count)}</td>
                <td className="num">{usageValue(day.input_tokens, day.usage_reported_count, day.request_count)}</td>
                <td className="num">{usageValue(day.output_tokens, day.usage_reported_count, day.request_count)}</td>
                <td className="num">{formatNumber(day.usage_reported_count)} / {formatNumber(day.request_count)}</td>
                <td className="num">{day.request_count > 0 ? duration(day.total_duration_ms / day.request_count) : '尚无记录'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  )
}

function RecentRequests({ inference, now }: { inference: InferenceStatus; now: Date }) {
  return (
    <div className="subsection">
      <h4>最近完成的请求</h4>
      {inference.recent_requests.length === 0 ? (
        <p className="small muted">暂无已完成请求。</p>
      ) : (
        <div className="table-wrap codex-request-scroll" tabIndex={0} role="region" aria-label="最近推理请求，可横向滚动">
          <table className="res-table codex-requests">
            <caption className="visually-hidden">最近完成的推理请求，最多 8 条</caption>
            <thead>
              <tr>
                <th scope="col">完成时间</th>
                <th scope="col">模型 / effort</th>
                <th scope="col">耗时</th>
                <th scope="col">结果</th>
                <th scope="col">输入 token</th>
                <th scope="col">输出 token</th>
              </tr>
            </thead>
            <tbody>
              {inference.recent_requests.map((request) => (
                <tr key={`${request.completed_at}:${request.sequence}`}>
                  <th scope="row"><Time iso={request.completed_at} now={now} relative={false} /></th>
                  <td><code>{request.model}</code><span className="small muted codex-effort">{request.effort}</span></td>
                  <td className="num">{duration(request.duration_ms)}</td>
                  <td>
                    <Pill tone={request.error_code ? 'danger' : 'ok'}>{request.error_code ? '失败' : '成功'}</Pill>
                    {request.error_code ? <span className="small codex-error">{errorLabel(request.error_code)}</span> : null}
                  </td>
                  <td className="num">{request.usage_available ? formatNumber(request.input_tokens) : '未提供'}</td>
                  <td className="num">{request.usage_available ? formatNumber(request.output_tokens) : '未提供'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Fleet samples content-free inference metadata; opening this panel starts no model turn. */
export function CodexDetails({ status, now }: { status: OpsStatus; now: Date }) {
  const inference = status.codex_inference
  if (!inference) {
    return <Notice tone="neutral">尚未采集推理记录。进程状态见上方。</Notice>
  }
  const persistent = Boolean(inference.history_since)
  const latest = inference.recent_requests[0]
  const lastCompletedAt = persistent ? latest?.completed_at : inference.last_completed_at
  const lastDurationMs = persistent ? latest?.duration_ms : inference.last_duration_ms
  const lastErrorCode = persistent ? latest?.error_code : inference.last_error_code
  const stale = now.getTime() - Date.parse(inference.observed_at) > SAMPLE_STALE_MS
  return (
    <>
      <div className="subsection">
        <h4>推理记录</h4>
        <p className="small muted">约每 5 分钟采样。</p>
        <Facts>
          <Fact label="采样于"><Time iso={inference.observed_at} now={now} /></Fact>
          {inference.history_since ? <Fact label="开始记录"><Time iso={inference.history_since} now={now} /></Fact> : null}
          <Fact label="进程启动于"><Time iso={inference.started_at} now={now} /></Fact>
          <Fact label="默认模型"><code>{inference.model}</code> · {inference.effort}</Fact>
          <Fact label="SDK 版本"><code>{inference.sdk_version}</code></Fact>
        </Facts>
        {stale ? <Notice tone="warn">采样已超过 1 小时，下方为历史记录。</Notice> : null}
        {persistent ? (
          <>
            <p className="small muted">每日用量和最近请求跨重启保留。开始记录之前的历史未补录。</p>
            <RecordedUsage inference={inference} now={now} />
          </>
        ) : (
          <>
            <Notice tone="neutral">当前为旧版进程数据，持久化每日用量等待网关升级后采集。</Notice>
            <UsageCounters usage={inference} active={inference.active_count} persistent={false} />
          </>
        )}
        <Facts>
          <Fact label="最近完成">{lastCompletedAt ? <Time iso={lastCompletedAt} now={now} /> : '尚无记录'}</Fact>
          <Fact label="最近耗时">{lastDurationMs !== undefined ? duration(lastDurationMs) : '尚无记录'}</Fact>
          {!persistent ? <Fact label="进程平均耗时">{inference.average_duration_ms !== undefined ? duration(inference.average_duration_ms) : '尚无记录'}</Fact> : null}
        </Facts>
        {lastErrorCode ? <Notice tone="warn">最近错误：{errorLabel(lastErrorCode)}</Notice> : null}
      </div>
      <RecentRequests inference={inference} now={now} />
    </>
  )
}
