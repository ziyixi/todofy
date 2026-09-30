import type { CanaryRun, CanaryStage, CanaryView } from '../../../worker/src/api-types.ts'
import { between, formatClock, formatDuration, formatFullTime, formatTime } from '../lib/format'
import { CANARY_KIND, CANARY_OUTCOME, CANARY_PHASE, CANARY_STAGE, canaryCodeLabel, type Tone } from '../lib/labels'
import { Card, Fact, Facts, Pill, Time } from './ui'

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

export function CanarySection({ canary, now }: { canary: CanaryView; now: Date }) {
  const current = canary.active ?? canary.today
  return (
    <Card id="canary" title="端到端金丝雀">
      <p className="small muted">
        每天 {String(canary.hour_utc).padStart(2, '0')}:00 UTC 之后的第一次定时检查会让 Mail Hero 生成一封合成测试邮件，经正常投递链路交给
        Todofy 校验；不涉及真实邮件，也不会创建 Todoist 任务。
      </p>
      <Facts>
        <Fact label="下次定时运行">
          <Time iso={canary.next_scheduled_at} now={now} />
        </Fact>
        <Fact label="今天手动运行">
          {canary.manual_today} / {canary.manual_limit} 次
        </Fact>
      </Facts>

      <div className="subsection">
        <h3>{canary.active ? '正在运行' : '今天'}</h3>
        {current ? <RunTimeline run={current} now={now} /> : <p className="small muted">今天还没有运行。</p>}
      </div>

      <div className="subsection">
        <h3>最近 {canary.recent.length} 次</h3>
        {canary.recent.length === 0 ? (
          <p className="small muted">还没有运行记录。</p>
        ) : (
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
        )}
      </div>
    </Card>
  )
}

function RunTimeline({ run, now }: { run: CanaryRun; now: Date }) {
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
                {step.key === 'completed' && run.consumer.waiting_code && state !== 'done' ? (
                  <span className="small muted">等待：{canaryCodeLabel(run.consumer.waiting_code)}</span>
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
