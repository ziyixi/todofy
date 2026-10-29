import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { signalLabel } from '../lib/labels'
import { httpsUrl } from '../lib/url'
import { Fact, Facts, Pill, Time } from './ui'

const GUIDANCE: Readonly<Record<string, string>> = {
  newsletter_config_current: '自动检查继续运行；此处未核对检查之后的新发布。',
  newsletter_config_pending: '请等待下一次配置检查，再到 Fleet 核对生效版本。',
  newsletter_config_failed: '到 Fleet 查看错误码并处理配置同步；此状态不代表每日投递失败。',
  newsletter_config_stale: '超过 30 分钟没有配置检查，请到 Fleet 核对配置同步进程。',
  newsletter_config_pinned: '当前配置符合固定版本，自动更新暂不跟随远端发布。',
  newsletter_config_unobserved: '尚未取得完整配置观测，请等待配置同步与观察器报告。',
}

/** Configuration clocks come from Newsletter, independently of Home's successful status() poll. */
export function NewsletterConfigDetails({ status, now }: { status: OpsStatus; now: Date }) {
  const signal = status.signals.find((item) => item.code.startsWith('newsletter_config_'))
  const code = signal?.code ?? 'newsletter_config_unobserved'
  const url = httpsUrl(status.ui_url)
  const observedAt = (name: string) => {
    const value = status.counters[name]
    const at = value !== undefined ? new Date(value * 1000) : null
    return at !== null && Number.isFinite(at.getTime()) ? <Time iso={at.toISOString()} now={now} /> : '暂无观测'
  }
  return (
    <div className="subsection">
      <h4>内容配置</h4>
      <Pill tone={signal?.severity === 'warning' ? 'warn' : 'neutral'}>{signalLabel(code)}</Pill>
      <p className="small muted">{GUIDANCE[code]}</p>
      <Facts>
        <Fact label="最近配置检查">{observedAt('newsletter_config_last_attempt_at')}</Fact>
        <Fact label="最近成功检查">{observedAt('newsletter_config_last_success_at')}</Fact>
      </Facts>
      {url ? <a href={url} target="_blank" rel="noreferrer noopener">查看 Fleet 配置详情<span className="visually-hidden">（新标签页）</span></a> : null}
    </div>
  )
}
