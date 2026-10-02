import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowRight, CheckCircle2, Clock3, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { AttemptResult } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { SummarizeDeliveryAttemptsRequest_Granularity, type SummarizeDeliveryAttemptsResponse } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { api, ApiError, timeOf, timestamp } from '../api/client'
import { overviewQuery } from '../api/queries'
import { ATTEMPT_RESULTS, countAll, countOf, resultLabel, resultName } from '../components/attemptResults'
import { Button, Card, Empty, ErrorState, formatInstant, Loading, PageHead, zoneAbbreviation } from '../components/UI'

type Period = '24h' | '7d' | '30d' | 'custom'
type Window = { from: string; to: string; bucket: 'hour' | 'day'; tz: string }
const DAY = 86_400_000
const periodOptions: Array<{ value: Period; label: string }> = [
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'custom', label: '自选日期' },
]
// The three results shown as metrics; UNKNOWN has its own notice when there is any.
const metrics: Array<{ result: AttemptResult; detail: string; icon: typeof CheckCircle2 }> = [
  { result: AttemptResult.SUCCEEDED, detail: '目标返回 2xx，表示已持久接管', icon: CheckCircle2 },
  { result: AttemptResult.RETRIED, detail: '本次请求暂时失败，已进入重试队列', icon: RotateCcw },
  { result: AttemptResult.FAILED, detail: '本次请求终止，不会自动重试', icon: TriangleAlert },
]

// Windows, labels and the API buckets all follow one zone: the browser's, read
// again for every window, or UTC when the Worker cannot use it. Date's local
// methods follow the browser zone, so a UTC fallback uses the UTC methods; the
// local Date constructor resolves a midnight that DST skips to its first valid
// instant, like the API does.
function browserZone(): string | null {
  // The Worker's checks: an offset such as "+03:00" or "Etc/Unknown" is refused.
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!zone || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone) || zone === 'Etc/Unknown') return null
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch { return null }
}
const zoneRefusal = (error: unknown) => error instanceof ApiError && error.reason === 'INVALID_TIME_ZONE'
function dateOf(ms: number, tz: string): [number, number, number] {
  const date = new Date(ms)
  return tz === 'UTC' ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()] : [date.getFullYear(), date.getMonth() + 1, date.getDate()]
}
function localDate(ms: number, tz: string): string {
  const [year, month, day] = dateOf(ms, tz)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
function localMidnight(year: number, month: number, day: number, tz: string): number {
  return tz === 'UTC' ? Date.UTC(year, month - 1, day) : new Date(year, month - 1, day).getTime()
}
function daysAgo(now: number, days: number, tz: string): number {
  const [year, month, day] = dateOf(now, tz)
  return localMidnight(year, month, day - days, tz)
}
function dateParts(value: string, tz: string): [number, number, number] | null {
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!parts) return null
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  return localDate(localMidnight(year, month, day, tz), tz) === value ? [year, month, day] : null
}
function customWindow(fromDate: string, toDate: string, tz: string): { value: Window | null; error: string | null } {
  const from = dateParts(fromDate, tz), last = dateParts(toDate, tz)
  if (from === null || last === null) return { value: null, error: '请选择有效的开始和结束日期。' }
  // Count calendar days, so 23- and 25-hour DST days do not shift the limit.
  const days = (Date.UTC(last[0], last[1] - 1, last[2]) - Date.UTC(from[0], from[1] - 1, from[2])) / DAY + 1
  if (days < 1) return { value: null, error: '结束日期不能早于开始日期。' }
  if (days > 90) return { value: null, error: '一次最多查看 90 天。' }
  return { value: { from: new Date(localMidnight(...from, tz)).toISOString(), to: new Date(localMidnight(last[0], last[1], last[2] + 1, tz)).toISOString(), bucket: 'day', tz }, error: null }
}
function presetWindow(period: Exclude<Period, 'custom'>, now: number, tz: string): Window {
  if (period === '24h') return { from: new Date(now - DAY).toISOString(), to: new Date(now).toISOString(), bucket: 'hour', tz }
  const days = period === '7d' ? 7 : 30
  return { from: new Date(daysAgo(now, days - 1, tz)).toISOString(), to: new Date(now).toISOString(), bucket: 'day', tz }
}
// Labels use the zone the API bucketed in, never whatever zone is current now.
function bucketLabel(value: string, bucket: Window['bucket'], timeZone: string, full = false): string {
  const options: Intl.DateTimeFormatOptions = { timeZone, month: 'numeric', day: 'numeric' }
  if (full) options.year = 'numeric'
  if (bucket === 'hour') { options.hour = '2-digit'; options.hourCycle = 'h23' }
  const date = new Date(value), label = new Intl.DateTimeFormat('zh-CN', options).format(date)
  // The abbreviation tells the two buckets of a repeated fall-back hour apart.
  return full && bucket === 'hour' ? `${label} ${zoneAbbreviation(date, timeZone)}` : label
}
/** SummarizeDeliveryAttempts of `window`: the attempts by result, by hour or day of its zone. */
function deliveryStats(window: Window): Promise<SummarizeDeliveryAttemptsResponse> {
  return api.summarizeDeliveryAttempts({ parent: 'deliveries/-', startTime: timestamp(window.from), endTime: timestamp(window.to),
    granularity: window.bucket === 'hour' ? SummarizeDeliveryAttemptsRequest_Granularity.HOUR : SummarizeDeliveryAttemptsRequest_Granularity.DAY, timeZone: window.tz })
}
/** Labels follow what the Worker bucketed by, as they follow its zone. */
function granularityOf(stats: SummarizeDeliveryAttemptsResponse): Window['bucket'] {
  return stats.granularity === SummarizeDeliveryAttemptsRequest_Granularity.HOUR ? 'hour' : 'day'
}
function drilldown(result: AttemptResult, from: string, to: string): string {
  return `/deliveries?${new URLSearchParams({ attempt_result: resultName(result), from, to }).toString()}`
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>('7d')
  const [asOf, setAsOf] = useState(() => Date.now())
  // Set once the Worker refuses the browser zone; the dashboard then uses UTC.
  const [zoneRefused, setZoneRefused] = useState(false)
  const [initialDates] = useState(() => { const now = Date.now(), tz = browserZone() ?? 'UTC'; return { from: localDate(daysAgo(now, 6, tz), tz), to: localDate(now, tz) } })
  const [draftFrom, setDraftFrom] = useState(initialDates.from)
  const [draftTo, setDraftTo] = useState(initialDates.to)
  const [chosenCustom, setChosenCustom] = useState(initialDates)
  // The zone is read again whenever a window is computed, so from/to, tz and
  // the query key agree even after the OS zone changes under an open tab.
  const { range: activeWindow, browser } = useMemo(() => {
    const browser = zoneRefused ? null : browserZone(), tz = browser ?? 'UTC'
    const range = period === 'custom' ? customWindow(chosenCustom.from, chosenCustom.to, tz).value ?? customWindow(chosenCustom.from, chosenCustom.to, 'UTC').value! : presetWindow(period, asOf, tz)
    return { range, browser }
  }, [period, chosenCustom, asOf, zoneRefused])
  const validation = customWindow(draftFrom, draftTo, activeWindow.tz)
  useEffect(() => {
    if (period === 'custom') return
    const advance = () => { if (!document.hidden) setAsOf(Date.now()) }
    const timer = globalThis.setInterval(advance, 900_000)
    document.addEventListener('visibilitychange', advance)
    return () => { globalThis.clearInterval(timer); document.removeEventListener('visibilitychange', advance) }
  }, [period])
  const overview = useQuery({ ...overviewQuery, refetchInterval: 300_000, refetchIntervalInBackground: false })
  const stats = useQuery({
    queryKey: ['delivery-stats', activeWindow.from, activeWindow.to, activeWindow.bucket, activeWindow.tz],
    queryFn: () => deliveryStats(activeWindow),
    staleTime: 300_000,
  })
  // A zone the Worker's Intl lacks: recompute the window in UTC instead of failing.
  const zoneError = stats.isError && zoneRefusal(stats.error) && activeWindow.tz !== 'UTC'
  useEffect(() => { if (zoneError) setZoneRefused(true) }, [zoneError])
  const shownZone = stats.data ? stats.data.timeZone : activeWindow.tz, local = shownZone === browser
  const zoneWords = local ? '浏览器时区' : ' UTC '
  const total = stats.data ? countAll(stats.data.totals) : 0
  const maxBucket = Math.max(1, ...(stats.data?.buckets.map(item => countAll(item.counts)) || []))
  // The range the Worker counted: the drill-downs ask for exactly it. A DST day lasts 23 or 25 hours, so a bucket's
  // end is the API's, never its start + 24 h.
  const from = timeOf(stats.data?.startTime) ?? activeWindow.from, to = timeOf(stats.data?.endTime) ?? activeWindow.to
  const granularity = stats.data ? granularityOf(stats.data) : activeWindow.bucket

  function choosePeriod(next: Period) {
    setPeriod(next)
    if (next !== 'custom') setAsOf(Date.now())
  }
  function applyCustom(event: FormEvent) {
    event.preventDefault()
    if (validation.value) setChosenCustom({ from: draftFrom, to: draftTo })
  }
  function refresh() {
    if (period === 'custom') void stats.refetch()
    else setAsOf(Date.now())
  }

  return <>
    <PageHead eyebrow="DASHBOARD · WEBHOOK" title="投递概览" description="按投递尝试完成时间查看成功、重试和失败趋势。" action={<Button variant="secondary" onClick={refresh} disabled={stats.isFetching}><RefreshCw size={16}/> 刷新</Button>} />
    <div className="dashboard-toolbar" aria-label="统计时段">
      <div className="dashboard-periods">{periodOptions.map(option => <button type="button" key={option.value} className={`dashboard-period ${period === option.value ? 'active' : ''}`} aria-pressed={period === option.value} onClick={() => choosePeriod(option.value)}>{option.label}</button>)}</div>
      <span className="dashboard-timezone">{local ? `时间按浏览器时区 ${shownZone}（${zoneAbbreviation(new Date(asOf), shownZone)}）` : '浏览器时区无法用于统计，时间按 UTC 显示'}</span>
    </div>
    {period === 'custom' && <form className="dashboard-date-form" onSubmit={applyCustom}>
      <label>开始日期 <input type="date" value={draftFrom} onChange={event => setDraftFrom(event.target.value)} /></label>
      <label>结束日期（含） <input type="date" value={draftTo} onChange={event => setDraftTo(event.target.value)} /></label>
      <Button variant="secondary" type="submit" disabled={!validation.value || (draftFrom === chosenCustom.from && draftTo === chosenCustom.to)}>应用日期</Button>
      {validation.error && <span className="dashboard-date-error" role="alert">{validation.error}</span>}
    </form>}
    <div className="dashboard-range"><Clock3 size={15}/><span>当前区间：{formatInstant(activeWindow.from, shownZone)} 至 {formatInstant(activeWindow.to, shownZone)}（不含结束时刻）</span></div>
    {stats.isPending || zoneError ? <Card><Loading label="正在读取投递统计…"/></Card> : stats.isError ? <Card><ErrorState error={stats.error} retry={() => void stats.refetch()}/></Card> : <>
      <div className="dashboard-metrics">{metrics.map(({ result, detail, icon: Icon }) => <Link to={drilldown(result, from, to)} className={`dashboard-metric dashboard-metric-${resultName(result)}`} key={result} aria-label={`查看此区间${resultLabel(result)}的投递事件`}><span className="dashboard-metric-top"><span>{resultLabel(result)}的尝试</span><Icon size={19}/></span><strong>{countOf(stats.data.totals, result).toLocaleString('zh-CN')}</strong><small>{detail}</small><span className="dashboard-metric-action">查看相关事件 <ArrowRight size={14}/></span></Link>)}</div>
      {countOf(stats.data.totals, AttemptResult.UNKNOWN) > 0 && <div className="dashboard-unknown" role="status"><TriangleAlert size={17}/><span>另有 <strong>{countOf(stats.data.totals, AttemptResult.UNKNOWN)}</strong> 次尝试结果不明（可能在请求中断时发生），需要逐条核对。</span><Link to={drilldown(AttemptResult.UNKNOWN, from, to)}>查看事件 <ArrowRight size={14}/></Link></div>}
      {overview.data && <div className="dashboard-current-status"><span>当前已停止的事件：<strong>{overview.data.failedDeliveryCount}</strong> 条。这里按事件当前状态计数，也包括未发出 HTTP 请求就停止的事件。</span><Link to="/deliveries?status=failed">查看当前失败事件 <ArrowRight size={14}/></Link></div>}
      {total === 0 ? <Card><Empty title="这段时间没有投递尝试" detail="新邮件进入转发流程后，这里会显示 webhook 尝试。仅归档的邮件不会计入。" action={<Link className="button button-secondary" to="/deliveries">查看投递记录</Link>}/></Card> : <Card className="dashboard-chart-card">
        <div className="dashboard-chart-heading"><div><h2>投递趋势</h2><p>每一段显示按{zoneWords}划分的小时或日期内完成的尝试；一次事件可能发生多次尝试。</p></div><Link className="text-link" to="/deliveries">全部记录 <ArrowRight size={15}/></Link></div>
        <div className="dashboard-legend" aria-hidden="true">{ATTEMPT_RESULTS.filter(result => result !== AttemptResult.UNKNOWN || countOf(stats.data.totals, result) > 0).map(result => <span key={result} className={resultName(result)}>{resultLabel(result)}</span>)}</div>
        <div className="dashboard-chart-scroll"><div className="dashboard-chart" role="img" aria-label={`此区间共 ${total} 次投递尝试：${ATTEMPT_RESULTS.map(result => `${resultLabel(result)} ${countOf(stats.data.totals, result)} 次`).join('，')}。每个时段的精确值见下方明细表。`}>
          {stats.data.buckets.map((item, index) => { const start = timeOf(item.startTime) ?? ''; return <div className="dashboard-chart-column" key={start}><div className="dashboard-bar-stack">{ATTEMPT_RESULTS.map(result => countOf(item.counts, result) > 0 && <span key={result} className={`dashboard-bar-${resultName(result)}`} style={{ height: `${countOf(item.counts, result) / maxBucket * 100}%` }}/>)}</div><span className="dashboard-chart-label">{index % Math.max(1, Math.ceil(stats.data.buckets.length / 8)) === 0 || index === stats.data.buckets.length - 1 ? bucketLabel(start, granularity, shownZone) : '\u00a0'}</span></div> })}
        </div></div>
        <details className="dashboard-details"><summary>查看每个时段的准确数量</summary><div className="table-wrap"><table className="data-table dashboard-table"><caption>按{zoneWords}时段统计的投递尝试；数字可打开对应投递事件</caption><thead><tr><th scope="col">时段（{shownZone}）</th>{ATTEMPT_RESULTS.map(result => <th scope="col" key={result}>{resultLabel(result)}</th>)}</tr></thead><tbody>{stats.data.buckets.map(item => { const start = timeOf(item.startTime) ?? '', end = timeOf(item.endTime) ?? to, label = bucketLabel(start, granularity, shownZone, true); return <tr key={start}><th scope="row">{label}</th>{ATTEMPT_RESULTS.map(result => { const count = countOf(item.counts, result); return <td key={result}>{count ? <Link to={drilldown(result, new Date(Math.max(Date.parse(start), Date.parse(from))).toISOString(), end)} aria-label={`${label} ${resultLabel(result)} ${count} 次，查看相关事件`}>{count}</Link> : '0'}</td> })}</tr> })}</tbody></table></div></details>
      </Card>}
      <p className="dashboard-scope">只统计真实邮件的 webhook 请求；连接测试和未发出的任务不计入。成功指目标服务返回 2xx 并接管请求，不表示下游业务已经完成。图表按尝试计数，点击数字打开相关事件；同一事件重试多次时，事件列表条数可能小于这里的次数。旧版记录中，部分显示为“进入重试”的尝试可能当时已耗尽重试额度；历史结果无法可靠补算。</p>
    </>}
  </>
}
