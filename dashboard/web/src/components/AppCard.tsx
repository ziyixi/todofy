import { ExternalLink } from 'lucide-react'
import type { AppCard as AppCardData, GuardAppView, OpsStatus } from '../../../worker/src/api-types.ts'
import { formatBytesBinary, formatDuration, formatNumber, formatRelative, formatTime } from '../lib/format'
import {
  APP_NAMES,
  HEALTH,
  KEY_COUNTERS,
  SEVERITY,
  appErrorLabel,
  counterInfo,
  deferredJobLabel,
  guardReasonLabel,
  modeInfo,
  signalLabel,
  type Tone,
} from '../lib/labels'
import { httpsUrl } from '../lib/url'
import { Card, Fact, Facts, Metrics, Notice, Pill, Time } from './ui'

/** A status older than this is marked as possibly outdated (the cron reads it every 30 minutes). */
const STATUS_STALE_MS = 60 * 60_000

function headline(card: AppCardData): { label: string; tone: Tone } {
  if (card.reachable === false) return { label: '无法连接', tone: 'danger' }
  if (!card.status) return { label: '暂无状态', tone: 'neutral' }
  return HEALTH[card.status.health] ?? { label: card.status.health, tone: 'neutral' }
}

function counterValue(name: string, value: number): string {
  const { kind } = counterInfo(name)
  if (kind === 'bytes') return formatBytesBinary(value)
  if (kind === 'seconds') return value === 0 ? '无' : formatDuration(value * 1000)
  return formatNumber(value)
}

export function AppCard({ card, guard, now }: { card: AppCardData; guard: GuardAppView; now: Date }) {
  const name = APP_NAMES[card.app]
  const status = card.status
  const head = headline(card)
  const id = `app-${card.app}`
  const link = httpsUrl(card.url)
  const stale = card.status_at !== null && now.getTime() - new Date(card.status_at).getTime() > STATUS_STALE_MS

  return (
    <Card
      id={id}
      title={name}
      className="app-card"
      actions={
        link ? (
          <a className="link-out" href={link} target="_blank" rel="noreferrer noopener">
            打开 {name}
            <ExternalLink size={14} aria-hidden="true" />
            <span className="visually-hidden">（新窗口）</span>
          </a>
        ) : null
      }
    >
      <div className="app-status">
        <Pill tone={head.tone} strong>
          {head.label}
        </Pill>
        <span className="small muted">
          {card.checked_at ? (
            <>
              检查于 <Time iso={card.checked_at} now={now} />
            </>
          ) : (
            '尚未检查'
          )}
        </span>
      </div>

      {card.reachable === false ? (
        <Notice tone="danger">
          最近一次 status() 调用失败：{appErrorLabel(card.error ?? 'unavailable')}（连续 {card.consecutive_failures} 次）。
          {card.status_at ? <>下方是 {formatTime(card.status_at, now)} 的最后一次成功状态。</> : '还没有成功读取过状态。'}
        </Notice>
      ) : null}
      {card.reachable !== false && stale && card.status_at ? (
        <Notice tone="warn">状态数据来自 {formatRelative(card.status_at, now)}，可能已过时。</Notice>
      ) : null}

      {status ? <StatusDetails status={status} guard={guard} now={now} app={card.app} /> : null}
    </Card>
  )
}

function StatusDetails({
  status,
  guard,
  now,
  app,
}: {
  status: OpsStatus
  guard: GuardAppView
  now: Date
  app: AppCardData['app']
}) {
  const effective = guard.state ?? status.guard
  const modes = Object.entries(status.modes)
  const keys = KEY_COUNTERS[app].filter((key) => Object.hasOwn(status.counters, key))
  const all = Object.entries(status.counters)

  return (
    <>
      <div className="subsection">
        <h3>运行模式</h3>
        <ul className="chips" aria-label="运行模式">
          {modes.map(([mode, value]) => {
            const info = modeInfo(mode, value)
            return (
              <li key={mode} className={`chip${info.usual ? '' : ' chip-attention'}`}>
                {info.label}：{value ? '开' : '关'}
                {info.usual ? null : <span className="visually-hidden">（非常规）</span>}
              </li>
            )
          })}
        </ul>
      </div>

      <div className="subsection">
        <h3>降载</h3>
        <div className="row-wrap">
          {effective.level === 'shed' ? <Pill tone="warn">降载中</Pill> : <Pill tone="ok">正常</Pill>}
          {effective.level === 'shed' && effective.reason ? (
            <span className="small">原因：{guardReasonLabel(effective.reason)}</span>
          ) : null}
          {effective.level === 'shed' && effective.until ? (
            <span className="small">
              直到 <Time iso={effective.until} now={now} />
            </span>
          ) : null}
        </div>
        {effective.level === 'shed' && effective.deferred.length > 0 ? (
          <p className="small muted">推迟的任务：{effective.deferred.map(deferredJobLabel).join('、')}</p>
        ) : null}
        {guard.last_error ? (
          <Notice tone="warn">上次下发降载设置失败：{appErrorLabel(guard.last_error)}，下次定时检查会重试。</Notice>
        ) : null}
      </div>

      <div className="subsection">
        <h3>当前信号</h3>
        {status.signals.length === 0 ? (
          <p className="small muted">没有活动信号。</p>
        ) : (
          <ul className="signal-list">
            {status.signals.map((signal) => {
              const severity = SEVERITY[signal.severity]
              const label = signalLabel(signal.code)
              return (
                <li key={signal.code} className="signal">
                  <div className="signal-head">
                    <Pill tone={severity.tone}>{severity.label}</Pill>
                    <span className="signal-label">{label}</span>
                    {label !== signal.code ? <code className="small muted">{signal.code}</code> : null}
                  </div>
                  {signal.since ? (
                    <p className="small muted">
                      开始于 <Time iso={signal.since} now={now} />
                    </p>
                  ) : null}
                  <Metrics metrics={signal.metrics} />
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="subsection">
        <h3>关键计数</h3>
        {keys.length === 0 ? (
          <p className="small muted">没有可读的计数。</p>
        ) : (
          <dl className="counters">
            {keys.map((key) => (
              <div key={key} className="counter">
                <dt>{counterInfo(key).label}</dt>
                <dd>{counterValue(key, status.counters[key] as number)}</dd>
              </div>
            ))}
          </dl>
        )}
        {all.length > keys.length ? (
          <details className="more">
            <summary>全部计数（{all.length}）</summary>
            <Facts>
              {all.map(([key, value]) => (
                <Fact key={key} label={counterInfo(key).label}>
                  {counterValue(key, value)}
                </Fact>
              ))}
            </Facts>
          </details>
        ) : null}
      </div>

      <Facts>
        <Fact label="上次备份">{status.last_backup_at ? <Time iso={status.last_backup_at} now={now} /> : '无记录'}</Fact>
        <Fact label="应用状态生成于">
          <Time iso={status.generated_at} now={now} />
        </Fact>
      </Facts>
    </>
  )
}
