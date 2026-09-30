import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  CPU_HINT_US,
  CPU_LIMIT_US,
  ERROR_RATE_CRITICAL_PERCENT,
  ERROR_RATE_MIN_REQUESTS,
  ERROR_RATE_WARN_PERCENT,
  WORKERS_QUERY_LIMIT,
  type CloudflareResponse,
  type ResourceRow,
  type WorkerRow,
} from '../../../worker/src/api-v2-types.ts'
import { ApiError } from '../api/client'
import { useRefreshCloudflare } from '../api/queries'
import { QuotaGroups } from '../components/QuotaBars'
import { LevelMark } from '../components/status'
import { Button, Notice, Time } from '../components/ui'
import {
  formatBytesDecimal,
  formatClock,
  refreshDeclinedText,
  refreshWaitText,
  formatCpu,
  formatDayHour,
  formatNumber,
  formatPercent,
  formatUtcDay,
} from '../lib/format'
import { QUOTA, USAGE_STATUS, guardReasonLabel, usageErrorLabel } from '../lib/labels'
import { flowOf, guardedEntries, nameOf, workerOf, type Reg } from '../lib/registry'
import { routeHash } from '../router'

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message}（请求 ${error.requestId}）` : error.message
  return '刷新失败，请稍后重试'
}

/** "刷新用量": GraphQL again, at most once a minute (the Worker enforces it too). */
function RefreshUsage({ data, now }: { data: CloudflareResponse; now: Date }) {
  const refresh = useRefreshCloudflare()
  const [message, setMessage] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const nextAt = new Date(data.refresh.next_refresh_at).getTime()
  const waiting = nextAt > Math.max(clock, now.getTime())

  useEffect(() => {
    const delay = nextAt - Date.now()
    if (delay <= 0) return
    const timer = window.setTimeout(() => setClock(Date.now()), delay + 50)
    return () => window.clearTimeout(timer)
  }, [nextAt])

  function run() {
    setMessage(null)
    refresh.mutate(undefined, {
      onSuccess: (fresh) => setMessage(fresh.refresh.refreshed ? '用量已刷新。' : refreshDeclinedText(fresh.refresh.next_refresh_at, new Date())),
      onError: (error) => setMessage(`刷新失败：${errorText(error)}`),
    })
  }

  return (
    <div className="cf-refresh">
      <Button onClick={run} disabled={refresh.isPending || waiting} aria-describedby="cf-refresh-note" className="btn-outline-accent">
        <RefreshCw size={15} aria-hidden="true" className={refresh.isPending ? 'spin' : undefined} />
        {refresh.isPending ? '正在刷新…' : '刷新用量'}
      </Button>
      <span id="cf-refresh-note" className="small muted">
        {waiting ? refreshWaitText(data.refresh.next_refresh_at, new Date(Math.max(clock, now.getTime()))) : '至少间隔 60 秒'}
      </span>
      <p className="small refresh-message" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  )
}

function UsageNotices({ data, now }: { data: CloudflareResponse; now: Date }) {
  const usage = data.usage
  return (
    <>
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
    </>
  )
}

function errorCell(row: WorkerRow): { text: string; note: string | null } {
  const text = `${formatNumber(row.errors)}${row.error_percent === null ? '' : ` · ${formatPercent(row.error_percent)}`}`
  if (row.error_percent === null && row.requests > 0) return { text, note: `样本太少（< ${ERROR_RATE_MIN_REQUESTS} 次），不判定` }
  return { text, note: null }
}

function CpuCell({ row }: { row: WorkerRow }) {
  if (row.cpu_p99_us === null) return <span className="muted">—</span>
  const width = Math.min(100, (row.cpu_p99_us / CPU_LIMIT_US) * 100)
  const near = row.cpu_p99_us > CPU_HINT_US
  return (
    <span className="cpu">
      <span className="cpu-text">
        p50 {row.cpu_p50_us === null ? '—' : formatCpu(row.cpu_p50_us)} / p99 {formatCpu(row.cpu_p99_us)}
      </span>
      <span
        className={`cpu-bar${near ? ' cpu-bar-near' : ''}`}
        role="img"
        aria-label={`CPU p99 ${formatCpu(row.cpu_p99_us)}，Free 上限 10 ms${near ? '，接近上限' : ''}`}
      >
        <span className="cpu-fill" style={{ width: `${width}%` }} />
        <span className="cpu-mark" style={{ left: `${(CPU_HINT_US / CPU_LIMIT_US) * 100}%` }} title="8 ms" />
      </span>
      {near ? <span className="small cpu-hint">接近 Free 10 ms</span> : null}
    </span>
  )
}

function lastActive(row: WorkerRow, now: Date): string {
  if (row.last_active_hour) return formatDayHour(row.last_active_hour, now)
  return row.requests > 0 ? '今天' : `今天无请求 · 上次 ${formatUtcDay(row.last_seen_day)}`
}

function WorkersTable({ reg, data, focus, now }: { reg: Reg; data: CloudflareResponse; focus?: string; now: Date }) {
  const rows = data.workers
  const unavailable = data.usage.status === 'unavailable' || data.usage.status === 'not_configured'
  const total = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      errors: sum.errors + row.errors,
      subrequests: sum.subrequests + row.subrequests,
      doRequests: sum.doRequests + (row.do_requests ?? 0),
    }),
    { requests: 0, errors: 0, subrequests: 0, doRequests: 0 },
  )

  useEffect(() => {
    if (!focus) return
    document.getElementById(`worker-${focus}`)?.scrollIntoView?.({ block: 'center' })
  }, [focus])

  return (
    <section className="cf-section" aria-labelledby="workers-title">
      <h2 id="workers-title">
        Worker · {rows.length} 个（自动发现）
      </h2>
      {data.workers_truncated ? (
        <Notice tone="info">查询结果达到 {WORKERS_QUERY_LIMIT} 行上限，列表可能不完整。</Notice>
      ) : null}
      {focus && !rows.some((row) => row.script === focus) ? (
        <Notice tone="neutral">
          没有 Worker <code>{focus}</code> 的数据：它最近 30 天没有请求，或还没有被发现。
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <p className="empty">
          {unavailable
            ? '用量数据无法获取，暂时没有 Worker 的指标。'
            : '今天还没有 Worker 的请求数据。新 Worker 第一次有请求就会出现在这里。'}
        </p>
      ) : (
        <div className="panel table-wrap">
          <table className="workers" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Worker</th>
                <th role="columnheader" scope="col">所属应用 / 流程</th>
                <th role="columnheader" scope="col" className="num">今日请求</th>
                <th role="columnheader" scope="col">错误</th>
                <th role="columnheader" scope="col">CPU p50 / p99（上限 10 ms）</th>
                <th role="columnheader" scope="col" className="num">子请求</th>
                <th role="columnheader" scope="col" className="num">DO 请求</th>
                <th role="columnheader" scope="col">最近有请求</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map((row) => {
                const worker = workerOf(reg, row.script)
                const flows = (worker?.flows ?? []).map((id) => flowOf(reg, id)?.name ?? id)
                const errors = errorCell(row)
                const alarm = row.level === 'warning' || row.level === 'critical'
                return (
                  <tr
                    key={row.script}
                    id={`worker-${row.script}`}
                    role="row"
                    className={focus === row.script ? 'row-focus' : undefined}
                    aria-current={focus === row.script ? 'true' : undefined}
                  >
                    <th role="rowheader" scope="row" data-label="Worker">
                      <code>{row.script}</code>
                    </th>
                    <td role="cell" data-label="所属应用">
                      {row.entry ? (
                        <span className="worker-app">{nameOf(reg, row.entry)}</span>
                      ) : (
                        <span className="tag tag-unregistered" title="在注册表中登记后可归入应用">
                          未登记
                        </span>
                      )}
                      {flows.length > 0 ? (
                        <span className="flow-tags">
                          {flows.map((name) => (
                            <span key={name} className="flow-tag">
                              {name}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    <td role="cell" data-label="今日请求" className="num strong">
                      {formatNumber(row.requests)}
                    </td>
                    <td role="cell" data-label="错误">
                      <span className={row.errors > 0 ? 'strong' : undefined}>{errors.text}</span>
                      {alarm ? <LevelMark level={row.level} size={10} className="worker-level" /> : null}
                      {errors.note ? <span className="small muted cell-note">{errors.note}</span> : null}
                    </td>
                    <td role="cell" data-label="CPU">
                      <CpuCell row={row} />
                    </td>
                    <td role="cell" data-label="子请求" className="num">
                      {formatNumber(row.subrequests)}
                    </td>
                    <td role="cell" data-label="DO 请求" className="num">
                      {row.do_requests === null ? '—' : formatNumber(row.do_requests)}
                      {row.do_errors ? <span className="small muted cell-note">错误 {formatNumber(row.do_errors)}</span> : null}
                    </td>
                    <td role="cell" data-label="最近有请求">
                      {lastActive(row, now)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot role="rowgroup">
              <tr role="row">
                <th role="rowheader" scope="row">合计</th>
                <td role="cell" className="cell-empty" />
                <td role="cell" data-label="今日请求" className="num">
                  {formatNumber(total.requests)}
                </td>
                <td role="cell" data-label="错误">
                  {formatNumber(total.errors)}
                </td>
                <td role="cell" className="cell-empty" />
                <td role="cell" data-label="子请求" className="num">
                  {formatNumber(total.subrequests)}
                </td>
                <td role="cell" data-label="DO 请求" className="num">
                  {formatNumber(total.doRequests)}
                </td>
                <td role="cell" className="cell-empty" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="small muted">
        错误率在今日请求 ≥ {ERROR_RATE_MIN_REQUESTS} 时判定：≥ {ERROR_RATE_WARN_PERCENT}% 需关注，≥ {ERROR_RATE_CRITICAL_PERCENT}%
        故障。CPU 条满格为 Free 的 10 ms，刻度线为 8 ms。新 Worker 第一次有请求就会出现在这里，未写进注册表的标为“未登记”。
      </p>
    </section>
  )
}

function resourceName(reg: Reg, row: ResourceRow): { name: string; registered: boolean; script?: string } {
  const def = reg.resources.find((resource) => resource.id === row.resource)
  if (def) return { name: def.name, registered: true, script: def.script }
  if (row.kind === 'r2' && row.id === 'unclassified') return { name: '未归类操作', registered: true }
  return { name: `未登记 ${row.id.slice(0, 8)}`, registered: false }
}

function ResourceTable({ reg, kind, rows, doStorage }: { reg: Reg; kind: ResourceRow['kind']; rows: readonly ResourceRow[]; doStorage: number | null }) {
  const title = { d1: 'D1 数据库', do: 'Durable Objects', r2: 'R2 存储桶' }[kind]
  const headingId = `res-${kind}`
  const items = rows.filter((row) => row.kind === kind)
  return (
    <section className="panel res" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {items.length === 0 ? (
        <p className="small muted res-empty">暂无数据。</p>
      ) : (
        <div className="table-wrap">
          <table className="res-table">
            <thead>
              <tr>
                <th scope="col">{kind === 'd1' ? '数据库' : kind === 'do' ? '类（所在 Worker）' : '存储桶'}</th>
                <th scope="col">所属应用</th>
                {kind === 'd1' ? (
                  <>
                    <th scope="col" className="num">大小</th>
                    <th scope="col" className="num">今日读</th>
                    <th scope="col" className="num">今日写</th>
                  </>
                ) : kind === 'do' ? (
                  <>
                    <th scope="col" className="num">今日请求</th>
                    <th scope="col" className="num">今日写入行</th>
                  </>
                ) : (
                  <>
                    <th scope="col" className="num">大小</th>
                    <th scope="col" className="num">本月 A</th>
                    <th scope="col" className="num">本月 B</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const named = resourceName(reg, row)
                return (
                  <tr key={`${row.kind}:${row.id}`} className={named.registered ? undefined : 'row-muted'}>
                    <th scope="row">
                      <span className={named.registered ? 'res-name' : 'res-name muted'} title={named.registered ? undefined : row.id}>
                        {named.name}
                      </span>
                      {named.script ? <code className="res-script">{named.script}</code> : null}
                    </th>
                    <td>{row.entry ? nameOf(reg, row.entry) : '—'}</td>
                    {row.kind === 'd1' ? (
                      <>
                        <td className="num">{row.size_bytes === null ? '—' : formatBytesDecimal(row.size_bytes)}</td>
                        <td className="num">{formatNumber(row.rows_read)}</td>
                        <td className="num">{formatNumber(row.rows_written)}</td>
                      </>
                    ) : row.kind === 'do' ? (
                      <>
                        <td className="num">{row.requests === null ? '—' : formatNumber(row.requests)}</td>
                        <td className="num">{formatNumber(row.rows_written)}</td>
                      </>
                    ) : (
                      <>
                        <td className="num">{row.size_bytes === null ? '—' : formatBytesDecimal(row.size_bytes)}</td>
                        <td className="num">{formatNumber(row.class_a)}</td>
                        <td className="num">{formatNumber(row.class_b)}</td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {kind === 'do' ? (
        <p className="small muted res-note">
          存储只有账户总量{doStorage === null ? '' : `（${formatBytesDecimal(doStorage)}）`}，见上方“存储”额度。
        </p>
      ) : null}
    </section>
  )
}

function GuardLine({ reg, data }: { reg: Reg; data: CloudflareResponse }) {
  const { desired, thresholds } = data.guard
  const top = data.usage.rows
    .filter((row) => row.guard_trigger && row.percent !== null)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0]
  return (
    <section className="panel guard-line" aria-labelledby="guard-title">
      <h2 id="guard-title">降载</h2>
      {desired.level === 'shed' ? <LevelMark level="held" word="降载中" /> : <LevelMark level="ok" word="未降载" />}
      {desired.reason ? <span>· {guardReasonLabel(desired.reason)}</span> : null}
      {top ? (
        <span>
          · 最高：{QUOTA[top.id]} {formatPercent(top.percent ?? 0)}
        </span>
      ) : null}
      <span>
        · {thresholds.shed_percent}% 自动降载 / {thresholds.clear_percent}% 解除
      </span>
      {guardedEntries(reg, data.guard).map((id) => {
        const app = data.guard.apps[id]
        const applied = app?.state ? (app.state.level === desired.level ? '已生效' : '未生效') : '状态未知'
        return (
          <span key={id}>
            · {nameOf(reg, id)} {applied}
            {app?.last_error ? '（上次下发失败）' : ''}
          </span>
        )
      })}
      <a className="guard-link" href={routeHash({ view: 'ops' })}>
        降载操作 →
      </a>
    </section>
  )
}

/** Cloudflare 监控 `#/cloudflare[/worker/<script>]`: allowances, Workers, resources, the guard. */
export function CloudflareView({ registry, cloudflare, focus, now }: { registry: Reg; cloudflare: CloudflareResponse; focus?: string; now: Date }) {
  const usage = cloudflare.usage
  const status = USAGE_STATUS[usage.status]
  const statusLevel = usage.status === 'ok' ? 'ok' : usage.status === 'stale' || usage.status === 'not_configured' ? 'warning' : 'critical'
  return (
    <div className="view view-cloudflare">
      <h1 className="visually-hidden">Cloudflare 监控</h1>
      <div className="cf-status">
        <div>
          <p className="cf-source">
            数据来自 Cloudflare GraphQL ·{' '}
            {usage.fetched_at ? (
              <>
                获取于{' '}
                <time dateTime={usage.fetched_at}>{formatClock(usage.fetched_at)}</time>
                {usage.day ? <span className="muted">（统计日 {usage.day} UTC）</span> : null}
              </>
            ) : (
              '还没有成功获取过用量数据'
            )}{' '}
            · <LevelMark level={statusLevel} word={status.label} size={10} />
          </p>
          <p className="small muted">用量按整个账户统计，其他项目也算在内。</p>
        </div>
        <RefreshUsage data={cloudflare} now={now} />
      </div>
      <UsageNotices data={cloudflare} now={now} />

      <section className="cf-section" aria-labelledby="quota-title">
        <h2 id="quota-title">账户额度</h2>
        <p className="small muted">
          达到 80% 的每日项目或每月 R2 操作会让应用自动降载。“按当前速度线性估算”只是把已用量按已过时间等比放大，不是预测：本 UTC
          日开头的一次集中任务会让估算偏高，每日项目在 00:00 UTC 后 3 小时内不估算。
        </p>
        {usage.rows.length > 0 ? <QuotaGroups rows={usage.rows} reg={registry} /> : <p className="empty">还没有用量数据。</p>}
      </section>

      <WorkersTable reg={registry} data={cloudflare} focus={focus} now={now} />

      <section className="cf-section" aria-labelledby="res-title">
        <h2 id="res-title">存储与资源</h2>
        <div className="res-grid">
          {(['d1', 'do', 'r2'] as const).map((kind) => (
            <ResourceTable key={kind} reg={registry} kind={kind} rows={cloudflare.resources} doStorage={cloudflare.do_storage_bytes} />
          ))}
        </div>
        <p className="small muted">名称来自注册表；找不到对应登记的资源显示“未登记”和 ID 前 8 位。</p>
      </section>

      <GuardLine reg={registry} data={cloudflare} />
    </div>
  )
}
