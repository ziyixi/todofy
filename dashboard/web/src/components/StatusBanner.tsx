import type { OverviewResponse } from '../../../worker/src/api-types.ts'
import { OVERALL, signalLabel } from '../lib/labels'
import { Pill, Time } from './ui'

const SUMMARY: Readonly<Record<OverviewResponse['overall']['level'], string>> = {
  ok: 'Mail Hero、Todofy 与 Cloudflare 用量都没有需要处理的问题。',
  warning: '有需要关注的项目，详情见下方各部分。',
  critical: '有严重问题，请优先处理下列项目。',
  unknown: '定时检查尚未运行过（每 30 分钟一次），暂时没有汇总数据。',
}

/** The page's overall status: level with text, and every item code as a plain-text label. */
export function StatusBanner({ overview, now }: { overview: OverviewResponse; now: Date }) {
  const { level, codes } = overview.overall
  const info = OVERALL[level]
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
      </div>
      {codes.length > 0 ? (
        <ul className="chips" aria-label="当前问题">
          {codes.map((code) => (
            <li key={code} className="chip">
              {signalLabel(code)}
              {signalLabel(code) !== code ? <code className="chip-code">{code}</code> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="small muted">
        {overview.refresh.last_tick_at ? (
          <>
            上次定时检查 <Time iso={overview.refresh.last_tick_at} now={now} />
          </>
        ) : (
          '尚未完成定时检查'
        )}
      </p>
    </section>
  )
}
