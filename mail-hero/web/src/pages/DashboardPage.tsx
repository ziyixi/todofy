import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowRight, CheckCircle2, Clock3, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { api } from '../api/client'
import type { DeliveryStats, DeliveryStatsCounts } from '../api/types'
import { Button, Card, Empty, ErrorState, Loading, PageHead } from '../components/UI'

type Period = '24h' | '7d' | '30d' | 'custom'
type Outcome = 'succeeded' | 'retried' | 'failed' | 'unknown'
type Window = { from: string; to: string; bucket: 'hour' | 'day' }
const DAY = 86_400_000
const periodOptions: Array<{ value: Period; label: string }> = [
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 个 UTC 日' },
  { value: '30d', label: '最近 30 个 UTC 日' },
  { value: 'custom', label: '自选日期' },
]
const outcomes: Array<{ key: Outcome; label: string; detail: string; icon: typeof CheckCircle2 }> = [
  { key: 'succeeded', label: '成功', detail: '目标返回 2xx，表示已持久接管', icon: CheckCircle2 },
  { key: 'retried', label: '进入重试', detail: '本次请求暂时失败，已进入重试队列', icon: RotateCcw },
  { key: 'failed', label: '失败', detail: '本次请求终止，不会自动重试', icon: TriangleAlert },
]

function utcDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }
function utcDayStart(ms: number): number { return Date.parse(`${utcDate(ms)}T00:00:00.000Z`) }
function dateInputMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) && utcDate(ms) === value ? ms : null
}
function customWindow(fromDate: string, toDate: string): { value: Window | null; error: string | null } {
  const from = dateInputMs(fromDate), last = dateInputMs(toDate)
  if (from === null || last === null) return { value: null, error: '请选择有效的开始和结束日期。' }
  if (last < from) return { value: null, error: '结束日期不能早于开始日期。' }
  if (last - from >= 90 * DAY) return { value: null, error: '一次最多查看 90 个 UTC 日。' }
  return { value: { from: new Date(from).toISOString(), to: new Date(last + DAY).toISOString(), bucket: 'day' }, error: null }
}
function presetWindow(period: Exclude<Period, 'custom'>, now: number): Window {
  if (period === '24h') return { from: new Date(now - DAY).toISOString(), to: new Date(now).toISOString(), bucket: 'hour' }
  const days = period === '7d' ? 7 : 30
  return { from: new Date(utcDayStart(now) - (days - 1) * DAY).toISOString(), to: new Date(now).toISOString(), bucket: 'day' }
}
function utcInstant(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
}
function bucketLabel(value: string, bucket: Window['bucket'], full = false): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC', month: 'numeric', day: 'numeric' }
  if (full) options.year = 'numeric'
  if (bucket === 'hour') { options.hour = '2-digit'; options.hourCycle = 'h23' }
  return new Intl.DateTimeFormat('zh-CN', options).format(new Date(value))
}
function bucketEnd(stats: DeliveryStats, index: number): string {
  const start = Date.parse(stats.buckets[index].start)
  const next = start + (stats.bucket === 'hour' ? 3_600_000 : DAY)
  return new Date(Math.min(next, Date.parse(stats.to))).toISOString()
}
function drilldown(outcome: Outcome, from: string, to: string): string {
  return `/deliveries?${new URLSearchParams({ attempt_outcome: outcome, from, to }).toString()}`
}
function countAll(counts: DeliveryStatsCounts): number {
  return counts.succeeded + counts.retried + counts.failed + counts.unknown
}

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>('7d')
  const [asOf, setAsOf] = useState(() => Date.now())
  const [draftFrom, setDraftFrom] = useState(() => utcDate(Date.now() - 6 * DAY))
  const [draftTo, setDraftTo] = useState(() => utcDate(Date.now()))
  const [chosenCustom, setChosenCustom] = useState(() => customWindow(utcDate(Date.now() - 6 * DAY), utcDate(Date.now())).value!)
  const validation = customWindow(draftFrom, draftTo)
  const activeWindow = useMemo(() => period === 'custom' ? chosenCustom : presetWindow(period, asOf), [period, chosenCustom, asOf])
  useEffect(() => {
    if (period === 'custom') return
    const advance = () => { if (!document.hidden) setAsOf(Date.now()) }
    const timer = globalThis.setInterval(advance, 900_000)
    document.addEventListener('visibilitychange', advance)
    return () => { globalThis.clearInterval(timer); document.removeEventListener('visibilitychange', advance) }
  }, [period])
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 300_000, refetchInterval: 300_000, refetchIntervalInBackground: false })
  const stats = useQuery({
    queryKey: ['delivery-stats', activeWindow.from, activeWindow.to, activeWindow.bucket],
    queryFn: () => api.deliveryStats(activeWindow),
    staleTime: 300_000,
  })
  const total = stats.data ? countAll(stats.data.totals) : 0
  const maxBucket = Math.max(1, ...(stats.data?.buckets.map(countAll) || []))

  function choosePeriod(next: Period) {
    setPeriod(next)
    if (next !== 'custom') setAsOf(Date.now())
  }
  function applyCustom(event: FormEvent) {
    event.preventDefault()
    if (validation.value) setChosenCustom(validation.value)
  }
  function refresh() {
    if (period === 'custom') void stats.refetch()
    else setAsOf(Date.now())
  }

  return <>
    <PageHead eyebrow="DASHBOARD · WEBHOOK" title="投递概览" description="按投递尝试完成时间查看成功、重试和失败趋势。" action={<Button variant="secondary" onClick={refresh} disabled={stats.isFetching}><RefreshCw size={16}/> 刷新</Button>} />
    <div className="dashboard-toolbar" aria-label="统计时段">
      <div className="dashboard-periods">{periodOptions.map(option => <button type="button" key={option.value} className={`dashboard-period ${period === option.value ? 'active' : ''}`} aria-pressed={period === option.value} onClick={() => choosePeriod(option.value)}>{option.label}</button>)}</div>
      <span className="dashboard-timezone">所有时段按 UTC 统计</span>
    </div>
    {period === 'custom' && <form className="dashboard-date-form" onSubmit={applyCustom}>
      <label>开始日期 <input type="date" value={draftFrom} onChange={event => setDraftFrom(event.target.value)} /></label>
      <label>结束日期（含） <input type="date" value={draftTo} onChange={event => setDraftTo(event.target.value)} /></label>
      <Button variant="secondary" type="submit" disabled={!validation.value || (validation.value.from === chosenCustom.from && validation.value.to === chosenCustom.to)}>应用日期</Button>
      {validation.error && <span className="dashboard-date-error" role="alert">{validation.error}</span>}
    </form>}
    <div className="dashboard-range"><Clock3 size={15}/><span>当前区间：{utcInstant(activeWindow.from)} 至 {utcInstant(activeWindow.to)} UTC（不含结束时刻）</span></div>
    {stats.isPending ? <Card><Loading label="正在读取投递统计…"/></Card> : stats.isError ? <Card><ErrorState error={stats.error} retry={() => void stats.refetch()}/></Card> : <>
      <div className="dashboard-metrics">{outcomes.map(({ key, label, detail, icon: Icon }) => <Link to={drilldown(key, stats.data.from, stats.data.to)} className={`dashboard-metric dashboard-metric-${key}`} key={key} aria-label={`查看此区间${label}的投递事件`}><span className="dashboard-metric-top"><span>{label}的尝试</span><Icon size={19}/></span><strong>{stats.data.totals[key].toLocaleString('zh-CN')}</strong><small>{detail}</small><span className="dashboard-metric-action">查看相关事件 <ArrowRight size={14}/></span></Link>)}</div>
      {stats.data.totals.unknown > 0 && <div className="dashboard-unknown" role="status"><TriangleAlert size={17}/><span>另有 <strong>{stats.data.totals.unknown}</strong> 次尝试结果不明（可能在请求中断时发生），需要逐条核对。</span><Link to={drilldown('unknown', stats.data.from, stats.data.to)}>查看事件 <ArrowRight size={14}/></Link></div>}
      {overview.data?.failed_count != null && <div className="dashboard-current-status"><span>当前已停止的事件：<strong>{overview.data.failed_count}</strong> 条。这里按事件当前状态计数，也包括未发出 HTTP 请求就停止的事件。</span><Link to="/deliveries?status=failed">查看当前失败事件 <ArrowRight size={14}/></Link></div>}
      {total === 0 ? <Card><Empty title="这段时间没有投递尝试" detail="新邮件进入转发流程后，这里会显示 webhook 尝试。仅归档的邮件不会计入。" action={<Link className="button button-secondary" to="/deliveries">查看投递记录</Link>}/></Card> : <Card className="dashboard-chart-card">
        <div className="dashboard-chart-heading"><div><h2>投递趋势</h2><p>每一段显示该 UTC 小时或日期内完成的尝试；一次事件可能发生多次尝试。</p></div><Link className="text-link" to="/deliveries">全部记录 <ArrowRight size={15}/></Link></div>
        <div className="dashboard-legend" aria-hidden="true"><span className="succeeded">成功</span><span className="retried">进入重试</span><span className="failed">失败</span>{stats.data.totals.unknown > 0 && <span className="unknown">结果不明</span>}</div>
        <div className="dashboard-chart-scroll"><div className="dashboard-chart" role="img" aria-label={`此区间共 ${total} 次投递尝试：成功 ${stats.data.totals.succeeded} 次，进入重试 ${stats.data.totals.retried} 次，失败 ${stats.data.totals.failed} 次，结果不明 ${stats.data.totals.unknown} 次。每个时段的精确值见下方明细表。`}>
          {stats.data.buckets.map((item, index) => <div className="dashboard-chart-column" key={item.start}><div className="dashboard-bar-stack">{(['succeeded', 'retried', 'failed', 'unknown'] as Outcome[]).map(key => item[key] > 0 && <span key={key} className={`dashboard-bar-${key}`} style={{ height: `${item[key] / maxBucket * 100}%` }}/>)}</div><span className="dashboard-chart-label">{index % Math.max(1, Math.ceil(stats.data.buckets.length / 8)) === 0 || index === stats.data.buckets.length - 1 ? bucketLabel(item.start, stats.data.bucket) : '\u00a0'}</span></div>)}
        </div></div>
        <details className="dashboard-details"><summary>查看每个时段的准确数量</summary><div className="table-wrap"><table className="data-table dashboard-table"><caption>按 UTC 时段统计的投递尝试；数字可打开对应投递事件</caption><thead><tr><th scope="col">时段（UTC）</th><th scope="col">成功</th><th scope="col">进入重试</th><th scope="col">失败</th><th scope="col">结果不明</th></tr></thead><tbody>{stats.data.buckets.map((item, index) => <tr key={item.start}><th scope="row">{bucketLabel(item.start, stats.data.bucket, true)}</th>{(['succeeded', 'retried', 'failed', 'unknown'] as Outcome[]).map(key => <td key={key}>{item[key] ? <Link to={drilldown(key, new Date(Math.max(Date.parse(item.start), Date.parse(stats.data.from))).toISOString(), bucketEnd(stats.data, index))} aria-label={`${bucketLabel(item.start, stats.data.bucket, true)} ${key === 'succeeded' ? '成功' : key === 'retried' ? '进入重试' : key === 'failed' ? '失败' : '结果不明'} ${item[key]} 次，查看相关事件`}>{item[key]}</Link> : '0'}</td>)}</tr>)}</tbody></table></div></details>
      </Card>}
      <p className="dashboard-scope">只统计真实邮件的 webhook 请求；连接测试和未发出的任务不计入。成功指目标服务返回 2xx 并接管请求，不表示下游业务已经完成。图表按尝试计数，点击数字打开相关事件；同一事件重试多次时，事件列表条数可能小于这里的次数。旧版记录中，部分显示为“进入重试”的尝试可能当时已耗尽重试额度；历史结果无法可靠补算。</p>
    </>}
  </>
}
