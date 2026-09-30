import type { OverallItem, OverviewResponse } from '../../../worker/src/api-types.ts'
import { formatDuration } from '../lib/format'
import { OVERALL, signalLabel, sourceLabel } from '../lib/labels'
import { Pill, Time } from './ui'

const SUMMARY: Readonly<Record<OverviewResponse['overall']['level'], string>> = {
  ok: 'Mail Hero、Todofy 与 Cloudflare 用量都没有需要处理的问题。',
  warning: '有需要关注的项目，详情见下方各部分。',
  critical: '有严重问题，请优先处理下列项目。',
  unknown: '定时检查尚未运行过（每 30 分钟一次），暂时没有汇总数据。',
}

/** Where on the page an item is explained. */
export function itemAnchor(item: OverallItem): string {
  if (item.source === 'mail-hero' || item.source === 'todofy') return `#app-${item.source}`
  if (item.source === 'cloudflare' || item.code.startsWith('usage_')) return '#quota'
  if (item.code.startsWith('canary_')) return '#canary'
  if (item.code.startsWith('guard_')) return '#actions'
  return '#digest'
}

/** The page's overall status: level with text, and every item as "<source>：<label>", linked to its section. */
export function StatusBanner({ overview, now }: { overview: OverviewResponse; now: Date }) {
  const { level, items } = overview.overall
  const info = OVERALL[level]
  const lastTick = overview.refresh.last_tick_at
  const ticksStopped = items.some((item) => item.source === 'dashboard' && item.code === 'tick_stale')
  return (
    <section className={`banner banner-${info.tone}`} aria-labelledby="banner-title">
      <div className="banner-main">
        <h2 id="banner-title" className="banner-title">
          <span className="visually-hidden">总体状态：</span>
          <Pill tone={info.tone} strong>
            {info.label}
          </Pill>
        </h2>
        <p>{SUMMARY[level]}</p>
        {ticksStopped ? (
          <p className="banner-stale">
            {lastTick
              ? `定时检查已 ${formatDuration(now.getTime() - new Date(lastTick).getTime())} 未运行`
              : '定时检查还没有运行过'}
            ：自动降载、金丝雀和运维摘要都已停止，下方数据可能过时。
          </p>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul className="chips" aria-label="当前问题">
          {items.map((item) => {
            const label = signalLabel(item.code)
            return (
              <li key={`${item.source}:${item.code}`} className="chip">
                <a href={itemAnchor(item)} className="chip-link">
                  {sourceLabel(item.source)}：{label}
                </a>
                {label !== item.code ? <code className="chip-code">{item.code}</code> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      <p className="small muted">
        {lastTick ? (
          <>
            上次定时检查 <Time iso={lastTick} now={now} />
          </>
        ) : (
          '尚未完成定时检查'
        )}
      </p>
    </section>
  )
}
