import { ChevronRight } from 'lucide-react'
import type { FlowSummary, HomeResponse } from '../../../worker/src/api-v2-types.ts'
import { Launcher } from '../components/Launcher'
import { MiniQuota } from '../components/QuotaBars'
import { LevelMark, LevelShape } from '../components/status'
import { flowLine } from '../lib/flows'
import { formatNumber } from '../lib/format'
import { LEVEL, USAGE_STATUS } from '../lib/labels'
import { flowOf, type Reg } from '../lib/registry'
import { routeHash } from '../router'

function FlowRows({ reg, flows, now }: { reg: Reg; flows: readonly FlowSummary[]; now: Date }) {
  return (
    <section className="home-block" aria-labelledby="home-flows-title">
      <div className="block-head">
        <h2 id="home-flows-title">业务流程</h2>
        <a href={routeHash({ view: 'flows' })}>全部流程 →</a>
      </div>
      {flows.length === 0 ? (
        <p className="empty">还没有登记业务流程。</p>
      ) : (
        <ul className="panel rows">
          {flows.map((summary) => {
            const flow = flowOf(reg, summary.id)
            const line = flowLine(reg, summary, now)
            const level = summary.partial ? 'unmonitored' : summary.level
            const name = flow?.name ?? summary.id
            return (
              <li key={summary.id}>
                <a
                  className="flow-row"
                  href={routeHash({ view: 'flows', flow: summary.id })}
                  aria-label={`${name}：${line.word}，${line.detail}${line.aside ? `，${line.aside}` : ''}`}
                >
                  <LevelShape level={level} size={12} />
                  <span className="flow-row-main">
                    <span className="flow-row-title">
                      <span className="flow-row-name">{name}</span>
                      <span className={`level-word level-${LEVEL[level].tone}`}>{line.word}</span>
                    </span>
                    <span className="flow-row-detail">{line.detail}</span>
                  </span>
                  {line.aside ? <span className="flow-row-aside">{line.aside}</span> : null}
                  <ChevronRight className="chevron" size={16} aria-hidden="true" />
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function CloudflareToday({ home }: { home: HomeResponse }) {
  const summary = home.cloudflare
  const usage = USAGE_STATUS[summary.usage_status]
  const shed = summary.guard_level === 'shed'
  return (
    <section className="home-block" aria-labelledby="home-cf-title">
      <div className="block-head">
        <h2 id="home-cf-title">Cloudflare 今日</h2>
        <a href={routeHash({ view: 'cloudflare' })}>详细监控 →</a>
      </div>
      <div className="panel cf-today">
        {summary.usage_status !== 'ok' ? (
          <p className="small cf-today-note">
            <LevelMark level={summary.usage_status === 'stale' ? 'warning' : 'unknown'} word={`用量${usage.label}`} size={10} />
            {summary.quota.length > 0 ? <span className="muted"> · 下方为上次成功获取的数据</span> : null}
          </p>
        ) : null}
        {summary.quota.length > 0 ? (
          <ul className="mini-quotas">
            {summary.quota.map((row) => (
              <MiniQuota key={row.id} row={row} />
            ))}
          </ul>
        ) : (
          <p className="small muted cf-today-empty">还没有用量数据。</p>
        )}
        <a className="cf-today-foot" href={routeHash({ view: 'cloudflare' })}>
          <span>
            {formatNumber(summary.workers)} 个 Worker · 今日错误 {formatNumber(summary.errors_today)} ·{' '}
          </span>
          {shed ? <LevelMark level="held" word="降载中" size={10} /> : <LevelMark level="ok" word="未降载" size={10} />}
          <ChevronRight className="chevron" size={16} aria-hidden="true" />
        </a>
      </div>
    </section>
  )
}

/**
 * 首页 `#/` (docs/design-v2.md §1): launcher, one line per flow, today's Cloudflare in four bars.
 * While loading the tiles keep their size with skeleton status lines; if the view failed, every tile
 * still links to its app and says 未知.
 */
export function HomeView({ registry, home, failed = false, now }: { registry: Reg; home: HomeResponse | undefined; failed?: boolean; now: Date }) {
  return (
    <div className="view view-home">
      <h1 className="visually-hidden">首页</h1>
      <Launcher reg={registry} entries={failed ? [] : home?.entries} now={now} />
      {home ? (
        <div className="home-lower">
          <FlowRows reg={registry} flows={home.flows} now={now} />
          <CloudflareToday home={home} />
        </div>
      ) : failed ? null : (
        <div className="home-lower" aria-hidden="true">
          <div className="skeleton-block" />
          <div className="skeleton-block" />
        </div>
      )}
    </div>
  )
}
