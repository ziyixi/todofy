import type { CanaryRun, CanaryStage, CanaryView } from '../../../worker/src/api-types.ts'
import {
  between,
  formatClock,
  formatDuration,
  formatFullTime,
  formatTime,
  formatUtcDay,
  utcDay,
  utcDayBefore,
} from '../lib/format'
import { CANARY_DISABLED_TEXT, CANARY_KIND, CANARY_OUTCOME, CANARY_PHASE, CANARY_STAGE, appErrorLabel, canaryCodeLabel, type Tone } from '../lib/labels'
import { Fact, Facts, Notice, Pill, Time } from './ui'

type StepState = 'done' | 'current' | 'failed' | 'skipped' | 'waiting'

interface Step {
  key: string
  label: string
  at: string | null
  /** The stage whose failure or skip stops at this step. */
  stage: CanaryStage | null
}

const STEP_TEXT: Readonly<Record<StepState, string>> = {
  done: '完成',
  current: '进行中',
  failed: '失败',
  skipped: '已跳过',
  waiting: '未开始',
}

const STEP_TONE: Readonly<Record<StepState, Tone>> = {
  done: 'ok',
  current: 'info',
  failed: 'danger',
  skipped: 'warn',
  waiting: 'neutral',
}

function steps(run: CanaryRun): Step[] {
  return [
    { key: 'created', label: '创建', at: run.created_at, stage: null },
    { key: 'queued', label: '已排队', at: run.queued_at, stage: 'start' },
    { key: 'delivered', label: '已投递', at: run.delivered_at, stage: 'delivery' },
    { key: 'completed', label: 'Todofy 完成', at: run.completed_at, stage: 'consumer' },
    { key: 'finished', label: '结束', at: run.finished_at, stage: null },
  ]
}

function stepStates(run: CanaryRun): StepState[] {
  const list = steps(run)
  const stopped = run.phase === 'done' && run.outcome !== 'ok' ? run.stage : null
  let blocked = false
  let currentAssigned = false
  return list.map((step, index) => {
    if (blocked) return index === list.length - 1 && run.finished_at ? 'done' : 'waiting'
    if (stopped && step.stage === stopped) {
      blocked = true
      return run.outcome === 'skipped' ? 'skipped' : 'failed'
    }
    if (step.at) return 'done'
    if (run.phase !== 'done' && !currentAssigned) {
      currentAssigned = true
      return 'current'
    }
    return 'waiting'
  })
}

function runStatus(run: CanaryRun): { label: string; tone: Tone } {
  if (run.phase !== 'done' || !run.outcome) return { label: CANARY_PHASE[run.phase], tone: 'info' }
  return CANARY_OUTCOME[run.outcome]
}

function runDetail(run: CanaryRun): string | null {
  if (run.phase === 'done' && run.outcome !== 'ok' && run.stage) {
    return `${CANARY_STAGE[run.stage]}阶段：${run.code ? canaryCodeLabel(run.code) : '无代码'}`
  }
  return null
}

/** What the switch does; the flow card shows it while CANARY_ENABLED=false. */
export const CANARY_DISABLED_NOTE = `${CANARY_DISABLED_TEXT}：不会开始新的定时或手动运行；正在进行的运行仍会每 30 分钟检查一次，直到结束。在 GitHub production 环境把 DASHBOARD_CANARY_ENABLED 改为 true 并重新部署后恢复。`

/** The latest run of each of the last `days` UTC days ending today (runs are newest first). */
export function canaryDays(recent: readonly CanaryRun[], today: string, days = 14): { day: string; run: CanaryRun | null }[] {
  return Array.from({ length: days }, (_, index) => {
    const day = utcDayBefore(today, days - 1 - index)
    return { day, run: recent.find((run) => run.day === day) ?? null }
  })
}

function dayCell(run: CanaryRun | null): { state: 'ok' | 'failed' | 'skipped' | 'running' | 'none'; text: string } {
  if (!run) return { state: 'none', text: '无运行' }
  if (run.phase !== 'done' || !run.outcome) return { state: 'running', text: `进行中（${CANARY_PHASE[run.phase]}）` }
  const why = run.code ? `（${canaryCodeLabel(run.code)}${run.outcome === 'skipped' ? '，未测试链路' : ''}）` : ''
  if (run.outcome === 'ok') {
    const took = between(run.created_at, run.finished_at)
    return { state: 'ok', text: `成功${took === null ? '' : `，用时 ${formatDuration(took)}`}` }
  }
  return { state: run.outcome, text: `${CANARY_OUTCOME[run.outcome].label}${why}` }
}

const CELL_MARK = { ok: '', failed: '■', skipped: '‖', running: '…', none: '' } as const

/** 14 day cells (UTC days, oldest first), each named for screen readers; and the run counts. */
export function CanaryDays({ canary, now }: { canary: CanaryView; now: Date }) {
  const today = utcDay(now)
  const days = canaryDays(canary.recent, today)
  const cells = days.map(({ day, run }) => ({ day, ...dayCell(run) }))
  const count = (state: string) => cells.filter((cell) => cell.state === state).length
  const first = days[0]?.day ?? today
  return (
    <div className="canary-days">
      <p className="small canary-days-sum">
        14 天：{count('ok')} 次成功 · {count('skipped')} 次跳过 · {count('failed')} 次失败
      </p>
      <ol className="day-cells" aria-label="近 14 天金丝雀结果（按 UTC 日）">
        {cells.map((cell) => {
          const label = `${formatUtcDay(cell.day)}${cell.day === today ? '（今天，UTC）' : ''}：${cell.text}`
          return (
            // The li stays a listitem (the list keeps its "14 项"); the cell inside is the named image.
            <li key={cell.day} className="day-slot">
              <span className={`day-cell day-${cell.state}`} role="img" aria-label={label} title={label}>
                <span aria-hidden="true">{CELL_MARK[cell.state]}</span>
              </span>
            </li>
          )
        })}
      </ol>
      <div className="day-scale small muted" aria-hidden="true">
        <span>{formatUtcDay(first)}</span>
        <span>{formatUtcDay(today)}（UTC）</span>
      </div>
      <ul className="day-legend small muted" aria-hidden="true">
        <li>
          <span className="day-cell day-ok" />
          成功
        </li>
        <li>
          <span className="day-cell day-skipped">‖</span>
          已跳过
        </li>
        <li>
          <span className="day-cell day-failed">■</span>
          失败
        </li>
        <li>
          <span className="day-cell day-none" />
          无运行
        </li>
      </ul>
    </div>
  )
}

/** The latest run in words ("定时 · 成功 · 用时 6 分钟") and its step timeline. */
export function CanaryToday({ canary, now }: { canary: CanaryView; now: Date }) {
  const current = canary.active ?? canary.today
  const day = utcDay(now)
  return (
    <div className="subsection">
      <h5>{canary.active ? '正在运行' : `本 UTC 日（${day}）`}</h5>
      {current ? <RunTimeline run={current} now={now} /> : <p className="small muted">本 UTC 日还没有运行。</p>}
    </div>
  )
}

/** The recent runs as a table (behind a disclosure on the flow card). */
export function CanaryHistory({ canary, now }: { canary: CanaryView; now: Date }) {
  if (canary.recent.length === 0) return <p className="small muted">还没有运行记录。</p>
  return (
    <details className="more">
      <summary>最近 {canary.recent.length} 次运行</summary>
      <div className="table-scroll" role="region" aria-label="最近的金丝雀运行" tabIndex={0}>
        <table className="runs">
          <thead>
            <tr>
              <th scope="col">开始</th>
              <th scope="col">类型</th>
              <th scope="col">结果</th>
              <th scope="col">原因</th>
              <th scope="col">用时</th>
            </tr>
          </thead>
          <tbody>
            {canary.recent.map((run) => {
              const status = runStatus(run)
              const took = between(run.created_at, run.finished_at)
              return (
                <tr key={run.run_id}>
                  <td>
                    <time dateTime={run.created_at} title={`${formatFullTime(run.created_at)} · ${run.run_id}`}>
                      {formatTime(run.created_at, now)}
                    </time>
                  </td>
                  <td>{CANARY_KIND[run.kind]}</td>
                  <td>
                    <Pill tone={status.tone}>{status.label}</Pill>
                  </td>
                  <td className="small">{runDetail(run) ?? <span className="muted">—</span>}</td>
                  <td className="small">{took === null ? <span className="muted">—</span> : formatDuration(took)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/** Schedule, the switch and the manual-run count. */
export function CanaryFacts({ canary, now }: { canary: CanaryView; now: Date }) {
  return (
    <>
      {canary.enabled ? null : <Notice tone="info">{CANARY_DISABLED_NOTE}</Notice>}
      <Facts>
        <Fact label="下次定时运行">
          {canary.next_scheduled_at === null ? '已关闭' : <Time iso={canary.next_scheduled_at} now={now} />}
        </Fact>
        <Fact label={`本 UTC 日（${utcDay(now)}）手动运行`}>
          {canary.manual_today} / {canary.manual_limit} 次
        </Fact>
      </Facts>
    </>
  )
}

export function RunTimeline({ run, now }: { run: CanaryRun; now: Date }) {
  const status = runStatus(run)
  const detail = runDetail(run)
  const states = stepStates(run)
  const list = steps(run)

  return (
    <div className="run">
      <div className="row-wrap">
        <Pill tone={status.tone} strong>
          {status.label}
        </Pill>
        <span className="small">{CANARY_KIND[run.kind]}运行</span>
        <code className="small muted wrap">{run.run_id}</code>
      </div>
      {detail ? <p className="run-detail">{detail}</p> : null}
      <ol className="timeline" aria-label="运行阶段">
        {list.map((step, index) => {
          const state = states[index] as StepState
          const offset = index > 0 ? between(run.created_at, step.at) : null
          return (
            <li key={step.key} className={`step step-${STEP_TONE[state]}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="step-dot" aria-hidden="true" />
              <div className="step-body">
                <span className="step-label">{step.label}</span>
                <span className="small">
                  {STEP_TEXT[state]}
                  {step.at ? (
                    <>
                      {' · '}
                      <time dateTime={step.at} title={formatFullTime(step.at)}>
                        {formatClock(step.at)}
                      </time>
                      {offset !== null ? <span className="muted">（+{formatDuration(offset)}）</span> : null}
                    </>
                  ) : null}
                </span>
                {step.key === 'delivered' && (run.delivery.attempts > 0 || run.delivery.error_code) ? (
                  <span className="small muted">
                    尝试 {run.delivery.attempts} 次
                    {run.delivery.last_http_status !== null ? `，最后 HTTP ${run.delivery.last_http_status}` : ''}
                    {run.delivery.error_code && state !== 'done' && run.delivery.error_code !== `http_${run.delivery.last_http_status}`
                      ? `，${canaryCodeLabel(run.delivery.error_code)}`
                      : ''}
                  </span>
                ) : null}
                {step.key === 'queued' && run.start_code && state === 'current' ? (
                  <span className="small muted">等待：{canaryCodeLabel(run.start_code)}（每 30 分钟重试，直到截止）</span>
                ) : null}
                {step.key === 'completed' && run.consumer.waiting_code && state !== 'done' ? (
                  <span className="small muted">等待：{canaryCodeLabel(run.consumer.waiting_code)}</span>
                ) : null}
                {run.last_call_error && state === 'current' && (step.key === 'delivered' || step.key === 'completed') ? (
                  <span className="small muted">上次查询失败：{appErrorLabel(run.last_call_error)}，下次定时检查重试</span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      {run.phase !== 'done' ? (
        <p className="small muted">
          每 30 分钟检查一次进度；截止 <Time iso={run.deadline_at} now={now} />
        </p>
      ) : null}
    </div>
  )
}
