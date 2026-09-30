import { useId } from 'react'
import {
  GUARD_SHED_PERCENT,
  QUOTA_CRITICAL_PERCENT,
  type QuotaPeriod,
  type QuotaRow,
  type UsageView,
} from '../../../worker/src/api-types.ts'
import { formatNumber, formatPercent, formatQuantity } from '../lib/format'
import { PERIODS, QUOTA, USAGE_STATUS, usageErrorLabel, type Tone } from '../lib/labels'
import { httpsUrl } from '../lib/url'
import { Card, Notice, Pill, Time } from './ui'

const PERIOD_ORDER: readonly QuotaPeriod[] = ['daily', 'monthly', 'storage']

/** Judged on the measured value like the Worker's guard, not on `percent` (rounded: 79.95 reads 80.0). */
function reaches(row: QuotaRow, percent: number): boolean {
  return row.used !== null && row.limit > 0 && row.used * 100 >= row.limit * percent
}

function rowTone(row: QuotaRow): { tone: Tone; label: string } {
  if (row.percent === null || row.used === null) return { tone: 'neutral', label: '无数据' }
  if (reaches(row, QUOTA_CRITICAL_PERCENT)) return { tone: 'danger', label: `超过 ${QUOTA_CRITICAL_PERCENT}%` }
  if (reaches(row, GUARD_SHED_PERCENT)) return { tone: 'warn', label: `超过 ${GUARD_SHED_PERCENT}%` }
  return { tone: 'ok', label: '正常' }
}

export function QuotaSection({ usage, now }: { usage: UsageView; now: Date }) {
  const status = USAGE_STATUS[usage.status]
  const groups = PERIOD_ORDER.map((period) => ({ period, rows: usage.rows.filter((row) => row.period === period) })).filter(
    (group) => group.rows.length > 0,
  )

  return (
    <Card id="quota" title="Cloudflare 用量（Workers Free）" actions={<Pill tone={status.tone}>{status.label}</Pill>}>
      <p className="small muted">
        整个 Cloudflare 账户的用量，包括其他 Worker、数据库和存储桶。达到 {GUARD_SHED_PERCENT}% 的每日项目或每月 R2
        操作会让两个应用自动降载。“按当前速度线性估算”只是把已用量按已过时间等比放大，不是预测：本 UTC
        日开头的一次集中任务会让估算偏高，每日项目在 00:00 UTC 后 3 小时内不估算。
      </p>
      <p className="small">
        {usage.fetched_at ? (
          <>
            数据获取于 <Time iso={usage.fetched_at} now={now} />
            {usage.day ? <span className="muted">，统计日 {usage.day}（UTC）</span> : null}
          </>
        ) : (
          '还没有成功获取过用量数据。'
        )}
      </p>

      {usage.status === 'not_configured' ? (
        <Notice tone="warn">未配置 Cloudflare 用量查询令牌（CF_ANALYTICS_TOKEN），无法显示用量，也不会自动降载。</Notice>
      ) : null}
      {usage.last_error && usage.status !== 'not_configured' ? (
        <Notice tone={usage.status === 'ok' ? 'info' : 'danger'}>
          {usage.status === 'ok' ? '上一次获取失败，已在之后成功：' : '获取用量失败：'}
          {usageErrorLabel(usage.last_error)}
          {usage.consecutive_failures > 0 ? `（连续 ${usage.consecutive_failures} 次）` : null}
          {usage.last_error_at ? (
            <>
              ，<Time iso={usage.last_error_at} now={now} />
            </>
          ) : null}
          。
          {usage.status !== 'ok'
            ? `${usage.rows.length > 0 ? '下方为上次成功获取的数据。' : ''}没有最新用量时不会自动进入降载。`
            : null}
        </Notice>
      ) : null}
      {usage.unclassified_r2_operations > 0 ? (
        <Notice tone="info">
          有 {formatNumber(usage.unclassified_r2_operations)} 次 R2 操作不在文档列出的类别中，已按 A 类计入。
        </Notice>
      ) : null}

      {groups.map(({ period, rows }) => (
        <div key={period} className="quota-group">
          <h3>
            {PERIODS[period].title}
            <span className="muted">
              （{PERIODS[period].note}
              {rows.every((row) => row.guard_trigger) ? '，计入自动降载' : rows.some((row) => row.guard_trigger) ? '' : '，不触发降载'}）
            </span>
          </h3>
          <ul className="quota-list">
            {rows.map((row) => (
              <QuotaItem key={row.id} row={row} />
            ))}
          </ul>
        </div>
      ))}
    </Card>
  )
}

function QuotaItem({ row }: { row: QuotaRow }) {
  const labelId = useId()
  const label = QUOTA[row.id] ?? row.id
  const tone = rowTone(row)
  const width = row.percent === null ? 0 : Math.min(100, Math.max(0, row.percent))
  const projected = row.projected_percent === null ? null : Math.min(100, Math.max(0, row.projected_percent))
  const source = httpsUrl(row.source)
  const valueText =
    row.used === null
      ? '无数据'
      : `已用 ${formatQuantity(row.used, row.unit)}，上限 ${formatQuantity(row.limit, row.unit)}，${formatPercent(row.percent ?? 0)}`

  return (
    <li className={`quota quota-${tone.tone}`}>
      <div className="quota-head">
        <span id={labelId} className="quota-label">
          {label}
        </span>
        <span className="quota-percent">
          {row.percent === null ? '无数据' : formatPercent(row.percent)}
          {row.percent !== null && tone.tone !== 'ok' ? <Pill tone={tone.tone}>{tone.label}</Pill> : null}
        </span>
      </div>
      <div
        className="meter"
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={row.percent === null ? undefined : width}
        aria-valuetext={valueText}
      >
        {projected !== null && projected > width ? <span className="meter-projection" style={{ width: `${projected}%` }} /> : null}
        <span className="meter-fill" style={{ width: `${width}%` }} />
        <span className="meter-mark" style={{ left: `${GUARD_SHED_PERCENT}%` }} aria-hidden="true" />
        <span className="meter-mark meter-mark-critical" style={{ left: `${QUOTA_CRITICAL_PERCENT}%` }} aria-hidden="true" />
      </div>
      <div className="quota-meta small">
        <span>
          {row.used === null ? '无数据' : formatQuantity(row.used, row.unit)} / {formatQuantity(row.limit, row.unit)}
          {row.truncated ? <span className="muted">（下限：查询结果已达行数上限）</span> : null}
        </span>
        {row.projected !== null && row.projected_percent !== null ? (
          <span className={row.projected_percent >= 100 ? 'text-warn' : 'muted'}>
            按当前速度线性估算，{row.period === 'daily' ? '本 UTC 日' : '本月'}结束约 {formatQuantity(row.projected, row.unit)}（
            {formatPercent(row.projected_percent)}）{row.projected_percent >= 100 ? '，按此速度将超出上限' : ''}
          </span>
        ) : null}
      </div>
      {row.breakdown.length > 0 || source ? (
        <div className="quota-extra small">
          {row.breakdown.length > 0 ? (
            <details className="more">
              <summary>主要来源</summary>
              <ul className="breakdown">
                {row.breakdown.map((item) => (
                  <li key={item.name}>
                    <code className="wrap">{item.name}</code>
                    <span>{formatQuantity(item.value, row.unit)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {source ? (
            <a href={source} target="_blank" rel="noreferrer noopener" className="muted">
              限额说明<span className="visually-hidden">：{label}（新窗口）</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
