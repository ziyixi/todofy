import { Info } from 'lucide-react'
import { useState } from 'react'
import { ATTENTION_SHOWN, attentionLevel, type AttentionItem, type ShellFields } from '../../../worker/src/api-v2-types.ts'
import { formatClock, formatDayTime, formatDuration, formatFullTime } from '../lib/format'
import { reasonLabel, signalLabel } from '../lib/labels'
import { flowOf, nameOf, stageOf, targetHash, targetLabel, type Reg } from '../lib/registry'
import { LevelMark, LevelShape } from './status'

/**
 * "Gemini 预算超过 80%（82%）": the label, plus a rounded percent metric when the item has one. An
 * observed item's code is a tile/stage reason ("无法连接", "HTTP 状态异常").
 */
export function itemText(item: Pick<AttentionItem, 'code' | 'metrics' | 'observed'>): string {
  if (item.observed !== undefined) return reasonLabel(item.code)
  const percent = item.metrics.percent
  return `${signalLabel(item.code)}${typeof percent === 'number' ? `（${Math.round(percent)}%）` : ''}`
}

type StripLevel = 'critical' | 'unknown' | 'warning'

const STRIP_WORDS: readonly (readonly [StripLevel, string])[] = [
  ['critical', '项故障'],
  ['unknown', '项未知'],
  ['warning', '项需关注'],
]

/** "1 项故障 · 2 项未知 · 1 项需关注", with the worst level (critical > unknown > warning) for the mark. */
function title(items: readonly AttentionItem[]): { level: StripLevel; text: string } {
  const count = (level: StripLevel) => items.filter((item) => stripLevel(item) === level).length
  const parts = STRIP_WORDS.flatMap(([level, word]) => (count(level) > 0 ? [{ level, text: `${count(level)} ${word}` }] : []))
  return { level: parts[0]?.level ?? 'warning', text: parts.map((part) => part.text).join(' · ') }
}

function stripLevel(item: AttentionItem): StripLevel {
  const level = attentionLevel(item)
  return level === 'info' ? 'warning' : level
}

/**
 * The strip under the top bar, the same on every view (docs/design-v2.md §1): one quiet line when all
 * is fine, else the worst items first (at most 3, then "还有 N 项") each linking to where it is
 * explained. Held switches are small ‖ 已暂停 tags and page-only info items are plain notes; neither
 * counts as an alarm.
 */
export function AttentionStrip({ reg, shell, now }: { reg: Reg; shell: ShellFields; now: Date }) {
  const [expanded, setExpanded] = useState(false)
  const { items, info, held } = shell.attention
  const nextTick = formatClock(shell.refresh.next_tick_at)
  const ticksStopped = items.some((item) => item.code === 'tick_stale')
  const lastTick = shell.refresh.last_tick_at
  const shown = expanded ? items : items.slice(0, ATTENTION_SHOWN)
  const rest = items.length - shown.length

  const extras =
    held.length > 0 || info.length > 0 ? (
      <ul className="strip-tags" aria-label="已暂停与提示">
        {held.map((item) => {
          const flow = flowOf(reg, item.target.flow)
          const stage = stageOf(flow, item.target.stage)
          const what = `${nameOf(reg, item.entry)}${stage ? ` ${stage.name}` : ''}`
          return (
            <li key={`held:${item.entry}:${item.code}`}>
              <a className="tag tag-held" href={targetHash(item.target)}>
                <LevelShape level="held" size={10} />
                已暂停：{what}（{signalLabel(item.code)}）
              </a>
            </li>
          )
        })}
        {info.map((item) => (
          <li key={`info:${item.source}:${item.code}`}>
            <a className="tag" href={targetHash(item.target)}>
              <Info size={13} aria-hidden="true" />
              {signalLabel(item.code)}
            </a>
          </li>
        ))}
      </ul>
    ) : null

  if (items.length === 0) {
    const neverRan = shell.attention.level === 'unknown' || lastTick === null
    return (
      <section className="strip strip-quiet" aria-labelledby="strip-title">
        <h2 id="strip-title" className="strip-title">
          {neverRan ? <LevelMark level="unknown" word="尚未完成巡检" /> : <LevelMark level="ok" word="全部正常" />}
          <span className="strip-meta"> · 下次巡检 {nextTick}</span>
        </h2>
        {extras}
      </section>
    )
  }

  const head = title(items)
  return (
    <section className={`strip strip-${head.level}`} aria-labelledby="strip-title">
      <div className="strip-head">
        <h2 id="strip-title" className="strip-title">
          <LevelMark level={head.level} word={head.text} size={13} />
        </h2>
        <span className="strip-meta">下次巡检 {nextTick}</span>
      </div>
      {ticksStopped ? (
        <p className="strip-note">
          {lastTick ? `定时检查已 ${formatDuration(now.getTime() - new Date(lastTick).getTime())} 未运行` : '定时检查还没有运行过'}
          ：自动降载、金丝雀和运维摘要都已停止，页面数据可能过时。
        </p>
      ) : null}
      <ul className="strip-items" aria-label="需关注的项目">
        {shown.map((item) => {
          const where = targetLabel(reg, item.target, item.source)
          const text = `${where}：${itemText(item)}`
          return (
            <li key={`${item.source}:${item.code}:${item.target.view}:${item.target.flow ?? ''}:${item.target.stage ?? ''}:${item.target.script ?? ''}`} className="strip-item">
              <LevelShape level={stripLevel(item)} size={10} />
              <span className="strip-text">
                {text}
                {item.since ? (
                  <span className="strip-since">
                    {' · 开始于 '}
                    <time dateTime={item.since} title={formatFullTime(item.since)}>
                      {formatDayTime(item.since, now)}
                    </time>
                  </span>
                ) : null}
              </span>
              <a className="strip-link" href={targetHash(item.target)}>
                查看<span className="visually-hidden">：{text}</span>
                <span aria-hidden="true"> →</span>
              </a>
            </li>
          )
        })}
      </ul>
      {items.length > ATTENTION_SHOWN ? (
        <button type="button" className="strip-more" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          {expanded ? '收起' : `还有 ${rest} 项`}
        </button>
      ) : null}
      {extras}
    </section>
  )
}

