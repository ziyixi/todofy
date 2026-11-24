import { useId } from 'react'
import {
  BREAKDOWN_UNCLASSIFIED,
  GUARD_SHED_PERCENT,
  QUOTA_CRITICAL_PERCENT,
  QUOTA_SHOW_REMAINING,
  type QuotaBreakdownItem,
  type QuotaPeriod,
  type QuotaPlan,
  type QuotaRow,
} from '../../../worker/src/api-types.ts'
import { formatAmountShort, formatLimitShort, formatNumber, formatPercent, formatQuantity } from '../lib/format'
import { PERIODS, QUOTA, type Tone } from '../lib/labels'
import { nameOf, resourceOf, unclassifiedLabel, unregisteredLabel, workerOf, type Reg } from '../lib/registry'
import { httpsUrl } from '../lib/url'
import { Pill } from './ui'

/** Phone labels of the mini bars (the full name stays the meter's accessible name). */
const QUOTA_SHORT: Partial<Record<QuotaRow['id'], string>> = {
  workers_cpu_ms: 'CPU 时间',
  d1_rows_read: 'D1 读取',
  do_requests: 'DO 请求',
  do_duration: 'DO 时长',
  ai_neurons: 'AI neurons',
}

export const PERIOD_ORDER: readonly QuotaPeriod[] = ['daily', 'monthly', 'storage']

/** Judged on the measured value like the Worker's guard, not on `percent` (rounded: 79.95 reads 80.0). */
function reaches(row: QuotaRow, percent: number): boolean {
  return row.used !== null && row.limit > 0 && row.used * 100 >= row.limit * percent
}

/**
 * What is left of the allowance, rounded down (never overstates the headroom), for the rows that state
 * it (QUOTA_SHOW_REMAINING: Workers AI); null for the others and without data.
 */
export function quotaRemaining(row: QuotaRow): number | null {
  if (!QUOTA_SHOW_REMAINING.includes(row.id) || row.used === null) return null
  return Math.max(0, Math.floor(row.limit - row.used))
}

export function quotaTone(row: QuotaRow): { tone: Tone; label: string } {
  if (row.percent === null || row.used === null) return { tone: 'neutral', label: '无数据' }
  if (reaches(row, QUOTA_CRITICAL_PERCENT)) return { tone: 'danger', label: `超过 ${QUOTA_CRITICAL_PERCENT}%` }
  if (reaches(row, GUARD_SHED_PERCENT)) return { tone: 'warn', label: `超过 ${GUARD_SHED_PERCENT}%` }
  return { tone: 'ok', label: '正常' }
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/** The bar with the 80 % (自动降载) and 95 % (严重) ticks; a meter with its full value in words. */
function Meter({ row, labelId, compact = false }: { row: QuotaRow; labelId: string; compact?: boolean }) {
  const width = row.percent === null ? 0 : clamp(row.percent)
  const projected = row.projected_percent === null ? null : clamp(row.projected_percent)
  const remaining = quotaRemaining(row)
  const valueText =
    row.used === null
      ? '无数据'
      : `已用 ${formatQuantity(row.used, row.unit)}，上限 ${formatQuantity(row.limit, row.unit)}，${formatPercent(row.percent ?? 0)}${
          remaining === null ? '' : `，剩余 ${formatQuantity(remaining, row.unit)}`
        }`
  return (
    <div
      className={`meter${compact ? ' meter-compact' : ''}`}
      role="meter"
      aria-labelledby={labelId}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={row.percent === null ? undefined : width}
      aria-valuetext={valueText}
    >
      {!compact && projected !== null && projected > width ? <span className="meter-projection" style={{ width: `${projected}%` }} /> : null}
      {row.used !== null ? <span className="meter-fill" style={{ width: `${width}%` }} /> : null}
      <span className="meter-mark" style={{ left: `${GUARD_SHED_PERCENT}%` }} title={row.guard_trigger ? '自动降载' : '80% 提醒线'} aria-hidden="true" />
      <span className="meter-mark" style={{ left: `${QUOTA_CRITICAL_PERCENT}%` }} title="严重" aria-hidden="true" />
    </div>
  )
}

/** How one contributor is shown: its words, whether they are a raw key (code), and the key itself. */
interface BreakdownLabel {
  readonly text: string
  readonly code: boolean
  readonly registered: boolean
  /** The measured key (D1/DO ID, bucket name), kept as the tooltip for debugging. */
  readonly title?: string
}

/**
 * A breakdown name. A D1/DO/R2 item the Worker joined to the registry (`kind`): "MailCoordinator ·
 * Mail Hero", "未登记 · 55c248f9" worded as in the resource table, or 未归类 without the dimension,
 * the key as its tooltip. Otherwise a script with its entry, or the raw key (unknown scripts, Workers
 * AI models, responses without `kind`).
 */
export function breakdownLabel(reg: Reg, item: QuotaBreakdownItem): BreakdownLabel {
  if (item.kind !== undefined) {
    const def = resourceOf(reg, item.resource)
    if (def) return { text: `${def.name} · ${nameOf(reg, def.entry)}`, code: false, registered: true, title: item.name }
    // A resource this page's registry does not know yet (a newer Worker build): its id, never 未登记.
    if (item.resource) return { text: item.resource, code: true, registered: true, title: item.name }
    // Measured without its database/namespace/bucket: 未归类 (R2: 未归类操作, like the table), not an ID.
    if (item.name === BREAKDOWN_UNCLASSIFIED) return { text: unclassifiedLabel(item.kind), code: false, registered: true, title: item.name }
    return { text: unregisteredLabel(item.kind, item.name), code: false, registered: false, title: item.name }
  }
  const worker = workerOf(reg, item.name)
  return { text: worker ? `${item.name}（${nameOf(reg, worker.entry)}）` : item.name, code: true, registered: true }
}

function BreakdownName({ reg, item }: { reg: Reg; item: QuotaBreakdownItem }) {
  const label = breakdownLabel(reg, item)
  if (label.code) {
    return (
      <code className="wrap" title={label.title}>
        {label.text}
      </code>
    )
  }
  return (
    <span className={label.registered ? 'wrap' : 'wrap muted'} title={label.title}>
      {label.text}
    </span>
  )
}

/**
 * One quota: value and bar on one compact row; the linear estimate and the top-5 breakdown behind one
 * disclosure, except an estimate reaching the 80 % line, which stays visible (design §3.5:
 * compact rows, the forecast on demand).
 */
export function QuotaItem({ row, reg, plan = 'free' }: { row: QuotaRow; reg: Reg; plan?: QuotaPlan }) {
  const labelId = useId()
  const label = QUOTA[row.id] ?? row.id
  const tone = quotaTone(row)
  const source = httpsUrl(row.source)
  const isPaidMonthly = plan === 'paid' && row.period === 'monthly'
  const periodWord = row.period === 'daily' ? '本 UTC 日' : isPaidMonthly ? '本账期' : '本月'
  const exceedText = isPaidMonthly
    ? '，按此速度将超出包含量；超出后 Workers / Durable Objects 会被消费上限全部拦截到账期结束'
    : '，按此速度将超出上限'
  const forecast =
    row.projected !== null && row.projected_percent !== null ? (
      <span className={row.projected_percent >= 100 ? 'text-warn' : 'muted'}>
        按当前速度线性估算，{periodWord}结束约 {formatQuantity(row.projected, row.unit)}（
        {formatPercent(row.projected_percent)}）{row.projected_percent >= 100 ? exceedText : ''}
      </span>
    ) : null
  const urgent = row.projected_percent !== null && row.projected_percent >= GUARD_SHED_PERCENT
  const hidden = forecast !== null && !urgent
  const remaining = quotaRemaining(row)
  const summary = hidden && row.breakdown.length > 0 ? '估算与主要来源' : hidden ? '估算' : '主要来源'
  return (
    <li className={`quota quota-${tone.tone}`}>
      <div className="quota-head">
        <span id={labelId} className="quota-label">
          {label}
        </span>
        <span className="quota-percent">
          {row.percent === null ? '无数据' : formatPercent(row.percent)}
          {row.percent !== null && tone.tone !== 'ok' ? <Pill tone={tone.tone}>{tone.label}</Pill> : null}
          {row.percent !== null && tone.tone === 'ok' && isPaidMonthly && row.projected_percent !== null && row.projected_percent >= 100 ? (
            <Pill tone="warn">预计超额</Pill>
          ) : null}
        </span>
      </div>
      <Meter row={row} labelId={labelId} />
      <div className="quota-meta small">
        <span>
          {row.used === null ? '无数据' : formatQuantity(row.used, row.unit)} / {formatQuantity(row.limit, row.unit)}
          {row.truncated ? <span className="muted">（下限：查询结果已达行数上限）</span> : null}
        </span>
        {/* Its own line: the headroom is the number that matters (the group note says it never sheds). */}
        {remaining !== null ? <strong className="quota-remaining">剩余 {formatQuantity(remaining, row.unit)}</strong> : null}
        {plan === 'paid' && row.id === 'ai_neurons' ? <span className="muted">每天 1 万 neurons 以内免费，超出按量计费</span> : null}
        {plan === 'paid' && row.id === 'do_requests' ? (
          <span className="muted">已按命名空间归属剔除跨 Worker 的 Service Binding 调用；分析接口按 RPC 调用与闹钟计，账单按会话计</span>
        ) : null}
        {urgent ? forecast : null}
      </div>
      {row.breakdown.length > 0 || hidden || source ? (
        <div className="quota-extra small">
          {row.breakdown.length > 0 || hidden ? (
            <details className="more">
              <summary>{summary}</summary>
              {hidden ? <p className="quota-forecast">{forecast}</p> : null}
              {row.breakdown.length > 0 ? (
                <ul className="breakdown">
                  {row.breakdown.map((item) => (
                    <li key={item.name}>
                      <BreakdownName reg={reg} item={item} />
                      <span className="breakdown-value">{formatQuantity(item.value, row.unit)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}
          {source ? (
            <a href={source} target="_blank" rel="noreferrer noopener" className="muted">
              限额说明<span className="visually-hidden">：{label}（新标签页）</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** Whether a group counts for the guard; a mixed group (每日, with Workers AI) names its exceptions. */
function groupGuardNote(items: readonly QuotaRow[]): string {
  if (items.every((row) => row.guard_trigger)) return '，计入自动降载'
  if (!items.some((row) => row.guard_trigger)) return '，不触发降载'
  const except = items.filter((row) => !row.guard_trigger).map((row) => QUOTA[row.id] ?? row.id)
  return `，计入自动降载（${except.join('、')} 除外）`
}

/** The account allowances in three groups (每日 / 每月 / 存储), each with its reset rule. */
export function QuotaGroups({
  rows,
  reg,
  plan = 'free',
  billingStart,
  billingEnd,
}: {
  rows: readonly QuotaRow[]
  reg: Reg
  plan?: QuotaPlan
  billingStart?: string | null
  billingEnd?: string | null
}) {
  const groups = PERIOD_ORDER.map((period) => ({ period, rows: rows.filter((row) => row.period === period) })).filter(
    (group) => group.rows.length > 0,
  )
  const groupTitle = (period: QuotaPeriod): string =>
    period === 'monthly' && plan === 'paid' ? '本账期含额（Workers Paid 与 R2）' : PERIODS[period].title
  const groupNote = (period: QuotaPeriod, items: readonly QuotaRow[]): string => {
    if (plan === 'paid' && period === 'monthly') {
      const windowText =
        billingStart && billingEnd ? `账期 ${billingStart} – ${billingEnd} UTC（按订阅续费日累计，跨自然月不清零）` : '按 Workers Paid 订阅账期累计，跨自然月不清零'
      return `${windowText}，已用 ≥ 80% 或预计 ≥ 100% 提醒，不触发日常服务降载`
    }
    if (plan === 'paid' && period === 'daily') {
      return '每天 00:00 UTC 重置 · 每天 1 万 neurons 以内免费，超出按量计费，不触发降载'
    }
    return `${PERIODS[period].note}${groupGuardNote(items)}`
  }
  return (
    <div className="quota-columns">
      {groups.map(({ period, rows: items }) => (
        <section key={period} className="panel quota-group" aria-labelledby={`quota-${period}`}>
          <h4 id={`quota-${period}`}>{groupTitle(period)}</h4>
          <p className="small muted">{groupNote(period, items)}</p>
          <ul className="quota-list">
            {items.map((row) => (
              <QuotaItem key={row.id} row={row} reg={reg} plan={plan} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * A mini bar of 首页: name, bar, "712 / 10 万 · 0.7%" (phones: name and percent only); a row that
 * states its remaining allowance shows it on every width: "300 / 1 万 · 3% · 剩余 9,700" (phones:
 * "剩余 9,700", the percent is the bar).
 */
export function MiniQuota({ row }: { row: QuotaRow }) {
  const labelId = useId()
  const tone = quotaTone(row)
  const percent = row.percent === null ? '无数据' : formatPercent(row.percent)
  const remaining = quotaRemaining(row)
  return (
    <li className={`mini-quota quota-${tone.tone}`}>
      <span id={labelId} className="visually-hidden">
        {QUOTA[row.id] ?? row.id}
      </span>
      <span className="mini-quota-name" aria-hidden="true">
        <span className="name-long">{QUOTA[row.id] ?? row.id}</span>
        <span className="name-short">{QUOTA_SHORT[row.id] ?? QUOTA[row.id] ?? row.id}</span>
      </span>
      <Meter row={row} labelId={labelId} compact />
      <span className="mini-quota-value">
        {row.used === null ? (
          '无数据'
        ) : (
          <>
            <span className="mini-quota-amount">
              {formatAmountShort(row.used, row.unit)} / {formatLimitShort(row.limit, row.unit)} ·{' '}
            </span>
            {remaining === null ? (
              percent
            ) : (
              <>
                <span className="mini-quota-amount">{percent} · </span>
                <span className="mini-quota-remaining">剩余 {formatNumber(remaining)}</span>
              </>
            )}
            {tone.tone === 'warn' || tone.tone === 'danger' ? <span className="visually-hidden">，{tone.label}</span> : null}
          </>
        )}
      </span>
    </li>
  )
}
