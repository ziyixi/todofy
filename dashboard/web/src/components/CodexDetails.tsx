import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { formatNumber } from '../lib/format'
import { Fact, Facts, Notice, Pill, Time } from './ui'

type InferenceStatus = NonNullable<OpsStatus['codex_inference']>
const SAMPLE_STALE_MS = 60 * 60_000

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

function RecentRequests({ inference, now }: { inference: InferenceStatus; now: Date }) {
  return (
    <div className="subsection">
      <h4>最近完成的请求</h4>
      {inference.recent_requests.length === 0 ? (
        <p className="small muted">{inference.request_count === 0 ? '本次启动以来还没有推理请求。' : '暂无已完成请求。'}</p>
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
                <tr key={request.sequence}>
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

/** Safe process-local inference metadata. Fleet samples it; opening this panel starts no model turn. */
export function CodexDetails({ status, now }: { status: OpsStatus; now: Date }) {
  const inference = status.codex_inference
  if (!inference) {
    return <Notice tone="neutral">尚未采集推理记录。进程状态见上方。</Notice>
  }
  const completed = inference.success_count + inference.failure_count
  const hasUsage = inference.usage_reported_count > 0
  const stale = now.getTime() - Date.parse(inference.observed_at) > SAMPLE_STALE_MS
  const usageValue = (value: number) => hasUsage ? formatNumber(value) : completed > 0 ? '未提供' : '尚无记录'
  return (
    <>
      <div className="subsection">
        <h4>推理记录</h4>
        <p className="small muted">约每 5 分钟采样。统计从本次进程启动开始，重启后归零。</p>
        <Facts>
          <Fact label="采样于"><Time iso={inference.observed_at} now={now} /></Fact>
          <Fact label="启动于"><Time iso={inference.started_at} now={now} /></Fact>
          <Fact label="默认模型"><code>{inference.model}</code> · {inference.effort}</Fact>
          <Fact label="SDK 版本"><code>{inference.sdk_version}</code></Fact>
        </Facts>
        {stale ? <Notice tone="warn">采样已超过 1 小时，下方为历史记录。</Notice> : null}
        <dl className="counters codex-counters">
          <div className="counter"><dt>请求总数</dt><dd>{formatNumber(inference.request_count)}</dd></div>
          <div className="counter"><dt>成功</dt><dd>{formatNumber(inference.success_count)}</dd></div>
          <div className="counter"><dt>失败</dt><dd>{formatNumber(inference.failure_count)}</dd></div>
          <div className="counter"><dt>采样时进行中</dt><dd>{formatNumber(inference.active_count)}</dd></div>
          <div className="counter"><dt>输入 token</dt><dd>{usageValue(inference.input_tokens)}</dd></div>
          <div className="counter"><dt>输出 token</dt><dd>{usageValue(inference.output_tokens)}</dd></div>
        </dl>
        <p className="small muted">已取得 {formatNumber(inference.usage_reported_count)} / {formatNumber(completed)} 次已完成请求的用量。输入 token 包含缓存。</p>
        <Facts>
          <Fact label="最近完成">{inference.last_completed_at ? <Time iso={inference.last_completed_at} now={now} /> : '尚无记录'}</Fact>
          <Fact label="最近耗时">{inference.last_duration_ms !== undefined ? duration(inference.last_duration_ms) : '尚无记录'}</Fact>
          <Fact label="平均耗时">{inference.average_duration_ms !== undefined ? duration(inference.average_duration_ms) : '尚无记录'}</Fact>
        </Facts>
        {inference.last_error_code ? <Notice tone="warn">最近错误：{errorLabel(inference.last_error_code)}</Notice> : null}
      </div>
      <RecentRequests inference={inference} now={now} />
    </>
  )
}
