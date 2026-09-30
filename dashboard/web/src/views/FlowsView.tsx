import { ChevronDown, ExternalLink } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { FlowDef, FlowState, FlowsResponse, StageDef, StageState } from '../../../worker/src/api-v2-types.ts'
import { CanaryDays, CanaryFacts, CanaryHistory, CanaryToday } from '../components/Canary'
import { LevelMark, LevelShape } from '../components/status'
import { Metrics, Pill, Time } from '../components/ui'
import { freshnessText } from '../lib/flows'
import { formatDayHour, formatDayTime, formatNumber, formatPercent, utcHourWithLocal } from '../lib/format'
import { CANARY_BADGE, LEVEL, SEVERITY, counterShort, reasonLabel, signalLabel } from '../lib/labels'
import { entryOf, nameOf, sortedByOrder, stageScripts, type Reg } from '../lib/registry'
import { httpsUrl } from '../lib/url'
import { routeHash } from '../router'

const ATTENTION = new Set(['warning', 'critical', 'unknown'])

/** The one number a stage node shows. */
function stageCount(stage: StageDef, state: StageState | undefined): string {
  if (!state || state.level === 'unmonitored' || state.level === 'link') return '—'
  const counter = state.counters[0]
  if (counter) return counterShort(counter.name, counter.value)
  if (state.probe) {
    if (state.probe.ok === null) return '尚未检查'
    return state.probe.http_status !== null
      ? `HTTP ${state.probe.http_status}${state.probe.latency_ms !== null ? ` · ${formatNumber(Math.round(state.probe.latency_ms))} ms` : ''}`
      : '无法访问'
  }
  if (state.analytics) return `今日 ${formatNumber(state.analytics.requests)} 次请求`
  return stage.entry === null ? '—' : LEVEL[state.level].word
}

/** The stage a card opens on: the first stage with a problem, else the first monitored one. */
function defaultStage(flow: FlowDef, state: FlowState | undefined): string | undefined {
  const issue = state?.stages.find((stage) => ATTENTION.has(stage.level) || stage.level === 'held')
  const monitored = state?.stages.find((stage) => stage.level !== 'unmonitored' && stage.level !== 'link')
  return issue?.id ?? state?.first_issue?.stage ?? monitored?.id ?? flow.stages[0]?.id
}

function freshLine(state: FlowState, now: Date): string {
  const fresh = state.freshness
  if (fresh.kind === 'canary') {
    const at = fresh.at ? `${formatDayTime(fresh.at, now)}（金丝雀）` : '还没有成功记录'
    return `最后一次端到端成功：${at} · 近 ${fresh.runs} 次运行 ${fresh.ok_runs} 次成功`
  }
  if (fresh.kind === 'none') return state.partial ? '无法判断新鲜度：部分阶段尚未接入' : '没有新鲜度数据'
  return freshnessText(fresh, now) ?? ''
}

function StageDetail({ reg, stage, state, now }: { reg: Reg; stage: StageDef; state: StageState | undefined; now: Date }) {
  const headingId = useId()
  const entry = entryOf(reg, stage.entry)
  const scripts = stageScripts(reg, stage)
  const url = httpsUrl(entry?.url)
  const level = state?.level ?? 'unknown'
  const unseen = level === 'unmonitored' || level === 'link'
  return (
    <section className="stage-detail" aria-labelledby={headingId}>
      <h4 id={headingId} className="stage-detail-title">
        {stage.name}
        <span aria-hidden="true" className="muted">
          {' '}
          ·{' '}
        </span>
        <LevelMark level={level} />
      </h4>
      {!state ? <p className="small">无法获取这一阶段的数据，其他内容不受影响。</p> : null}
      {unseen ? (
        <p className="small">{stage.note ?? (entry ? `${entry.name} 未接入监控` : '这一阶段在面板之外')}</p>
      ) : null}
      {state && state.reason && state.level !== 'ok' && !unseen && !state.signals.some((signal) => signal.code === state.reason) ? (
        <p className="small">
          原因：{reasonLabel(state.reason)}
          {reasonLabel(state.reason) !== state.reason ? <code className="muted"> {state.reason}</code> : null}
        </p>
      ) : null}
      {state && state.signals.length > 0 ? (
        <ul className="signal-list" aria-label="信号">
          {state.signals.map((signal) => {
            const label = signalLabel(signal.code)
            return (
              <li key={signal.code} className="signal">
                <div className="signal-head">
                  <Pill tone={SEVERITY[signal.severity].tone}>{SEVERITY[signal.severity].label}</Pill>
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
      ) : null}
      {state && state.counters.length > 0 ? (
        <p className="small detail-line">
          <span className="muted">计数 </span>
          {state.counters.map((counter) => counterShort(counter.name, counter.value)).join(' · ')}
        </p>
      ) : null}
      {state?.analytics ? (
        <p className="small detail-line">
          <span className="muted">今日请求 </span>
          {formatNumber(state.analytics.requests)} · 错误 {formatNumber(state.analytics.errors)}
          {state.analytics.error_percent === null
            ? state.analytics.requests > 0
              ? '（样本太少，不判定）'
              : ''
            : `（${formatPercent(state.analytics.error_percent)}）`}
          {state.analytics.last_active_hour ? ` · 最近有请求 ${formatDayHour(state.analytics.last_active_hour, now)}` : ''}
        </p>
      ) : null}
      {state?.probe ? (
        <p className="small detail-line">
          <span className="muted">探测 </span>
          {state.probe.checked_at === null
            ? '尚未检查'
            : `${state.probe.http_status !== null ? `HTTP ${state.probe.http_status}` : '无法访问'}${
                state.probe.latency_ms !== null ? ` · ${formatNumber(Math.round(state.probe.latency_ms))} ms` : ''
              } · ${formatDayTime(state.probe.checked_at, now)} 检查`}
        </p>
      ) : null}
      {state?.canary ? (
        <p className="small detail-line">
          <span className="muted">金丝雀 </span>
          {CANARY_BADGE[state.canary].label}
        </p>
      ) : null}
      {scripts.length > 0 || url ? (
        <p className="detail-links">
          {scripts.length > 0 ? (
            <a href={routeHash({ view: 'cloudflare', script: scripts[0] as string })}>在 Cloudflare 中查看 {scripts.join('、')} →</a>
          ) : null}
          {url && entry ? (
            <a href={url} target="_blank" rel="noreferrer noopener" aria-label={`打开 ${entry.name}（新标签页）`}>
              打开 {entry.name}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}

function CanaryBlock({ flow, state, now }: { flow: FlowDef; state: FlowState; now: Date }) {
  const canary = state.canary
  const headingId = useId()
  if (!canary || !flow.canary) return null
  return (
    <section className="canary-block" aria-labelledby={headingId}>
      <h4 id={headingId}>金丝雀 · 每天 {utcHourWithLocal(canary.hour_utc, now)} 定时</h4>
      <CanaryDays canary={canary} now={now} />
      <CanaryToday canary={canary} now={now} />
      <p className="small muted">覆盖范围：{flow.canary.scope_note}</p>
      <CanaryFacts canary={canary} now={now} />
      <p className="small">
        手动运行在<a href={routeHash({ view: 'ops' })}>“操作与记录”</a>
      </p>
      <CanaryHistory canary={canary} now={now} />
    </section>
  )
}

function FlowCard({ reg, flow, state, focused, now }: { reg: Reg; flow: FlowDef; state: FlowState | undefined; focused: boolean; now: Date }) {
  const level = state ? (state.partial ? 'unmonitored' : state.level) : 'unknown'
  const [open, setOpen] = useState(() => focused || ATTENTION.has(level))
  const [selected, setSelected] = useState(() => defaultStage(flow, state))
  const card = useRef<HTMLElement>(null)
  const bodyId = useId()
  const titleId = useId()

  useEffect(() => {
    if (!focused) return
    setOpen(true)
    card.current?.scrollIntoView?.({ block: 'start' })
  }, [focused])

  const stageState = (id: string) => state?.stages.find((stage) => stage.id === id)
  const word = state?.partial ? '部分接入' : LEVEL[level].word
  const coverage = state && state.coverage.monitored < state.coverage.total ? `已监测 ${state.coverage.monitored}/${state.coverage.total}` : null
  const current = flow.stages.find((stage) => stage.id === selected)

  return (
    <article ref={card} id={`flow-${flow.id}`} className={`flow-card${open ? ' flow-card-open' : ''}`} aria-labelledby={titleId}>
      <div className="flow-head">
        <h3 id={titleId}>{flow.name}</h3>
        <LevelMark level={level} word={word} className="level-badge" />
        {coverage ? <span className="flow-coverage small muted">{coverage}</span> : null}
        <button
          type="button"
          className="btn btn-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? '收起' : '展开'} ${flow.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开'}
          <ChevronDown size={15} aria-hidden="true" className={open ? 'flip' : undefined} />
        </button>
      </div>
      {!state ? <p className="small">无法获取这一项的数据，其他内容不受影响。</p> : null}

      {open ? (
        <div id={bodyId} className="flow-body">
          <p className="small muted">{flow.description}</p>
          {state ? <p className="small flow-fresh">{freshLine(state, now)}</p> : null}
          <ol className="stage-chain" aria-label="阶段">
            {flow.stages.map((stage, index) => {
              const item = stageState(stage.id)
              const stageLevel = item?.level ?? 'unknown'
              const count = stageCount(stage, item)
              const badge = item?.canary ? CANARY_BADGE[item.canary] : null
              return (
                <li key={stage.id} className="stage">
                  {index > 0 ? (
                    <span className="stage-arrow" aria-hidden="true">
                      →
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={`stage-node stage-${stageLevel}`}
                    aria-pressed={selected === stage.id}
                    aria-label={`阶段 ${index + 1} ${stage.name}：${LEVEL[stageLevel].word}，${count}${badge ? `，金丝雀${badge.label}` : ''}`}
                    onClick={() => setSelected(stage.id)}
                  >
                    <span className="stage-name">
                      <LevelShape level={stageLevel} />
                      {stage.name}
                    </span>
                    <span className={`level-word level-${LEVEL[stageLevel].tone}`}>{LEVEL[stageLevel].word}</span>
                    <span className="stage-count">{count}</span>
                    {badge ? <span className={`canary-badge canary-${item?.canary}`}>{badge.label}</span> : null}
                  </button>
                </li>
              )
            })}
          </ol>
          <div className={`flow-detail${state?.canary ? ' flow-detail-2' : ''}`}>
            {current ? <StageDetail reg={reg} stage={current} state={stageState(current.id)} now={now} /> : null}
            {state ? <CanaryBlock flow={flow} state={state} now={now} /> : null}
          </div>
          {state && state.unclassified.length > 0 ? (
            <section className="unclassified" aria-label="未归类的信号">
              <h4>未归类的信号</h4>
              <ul className="small">
                {state.unclassified.map((item) => (
                  <li key={`${item.entry}:${item.code}`}>
                    <Pill tone={SEVERITY[item.severity].tone}>{SEVERITY[item.severity].label}</Pill> {nameOf(reg, item.entry)}：{signalLabel(item.code)}{' '}
                    {signalLabel(item.code) !== item.code ? <code className="muted">{item.code}</code> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : (
        <div id={bodyId} className="flow-body flow-body-compact">
          <ol className="pill-chain" aria-label="阶段">
            {flow.stages.map((stage, index) => {
              const stageLevel = stageState(stage.id)?.level ?? 'unknown'
              return (
                <li key={stage.id}>
                  {index > 0 ? (
                    <span className="stage-arrow" aria-hidden="true">
                      →
                    </span>
                  ) : null}
                  <span className={`stage-pill stage-${stageLevel}`}>
                    <LevelShape level={stageLevel} size={10} />
                    {stage.name}
                    <span className="visually-hidden">：{LEVEL[stageLevel].word}</span>
                  </span>
                </li>
              )
            })}
          </ol>
          {state ? <p className="small flow-fresh">{freshLine(state, now)}</p> : null}
        </div>
      )}
    </article>
  )
}

/** 业务流程 `#/flows[/<flow>]`: cards by business group; each flow a chain of stages. */
export function FlowsView({ registry, flows, focus, now }: { registry: Reg; flows: FlowsResponse; focus?: string; now: Date }) {
  const groups = sortedByOrder(registry.flow_groups)
    .map((group) => ({ group, items: sortedByOrder(registry.flows.filter((flow) => flow.group === group.id)) }))
    .filter(({ items }) => items.length > 0)
  return (
    <div className="view view-flows">
      <div className="view-head">
        <h1>业务流程</h1>
        <p className="small muted">按业务分组。每个流程由有序阶段组成，一个流程可以跨多个 Worker；流程状态取已接入阶段中最差的一个。</p>
      </div>
      {groups.length === 0 ? <p className="empty">还没有登记业务流程。</p> : null}
      {groups.map(({ group, items }) => (
        <section key={group.id} className="flow-group" aria-labelledby={`flow-group-${group.id}`}>
          <h2 id={`flow-group-${group.id}`} className="group-title">
            {group.name}
          </h2>
          <div className="flow-cards">
            {items.map((flow) => (
              <FlowCard
                key={flow.id}
                reg={registry}
                flow={flow}
                state={flows.flows.find((item) => item.id === flow.id)}
                focused={focus === flow.id}
                now={now}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
