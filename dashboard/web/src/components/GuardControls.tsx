import { useState } from 'react'
import type { GuardLevel, GuardView } from '../../../worker/src/api-types.ts'
import { useSetGuard } from '../api/queries'
import { ApiError } from '../api/client'
import { guardedEntries, nameOf, type Reg } from '../lib/registry'
import { appErrorLabel, guardReasonLabel } from '../lib/labels'
import { formatClock } from '../lib/format'
import { Button, Notice, Time } from './ui'
import { Modal } from './Modal'

function effectiveLevel(state: { level: GuardLevel } | null): string {
  if (!state) return '尚未取得回执'
  return state.level === 'shed' ? '非关键工作已延后' : '正常执行'
}

const EFFECTS: Readonly<Record<string, string>> = {
  'mail-hero': '延后原件对账、保留期清理、金丝雀清理和告警历史清理；每项最多推迟 48 小时。收件、解析、投递与重试继续运行。',
  todofy: '延后新一轮每周备份、过期数据清理和趋势统计；清理与统计最多推迟 72 小时，备份过旧时仍会执行。真实邮件处理与进行中的备份继续运行。',
  lab: '延后定时抓取、嵌入、排序、简报生成、来源解析和清理。手动阅读、决定与发送不受影响。',
  watch: '将定时网页检查间隔延长到至少一天，并延后每日维护扫描。手动检查、变化确认与通知不受影响。',
}

export function GuardControls({ reg, guard, now }: { reg: Reg; guard: GuardView; now: Date }) {
  const mutation = useSetGuard()
  const [action, setAction] = useState<{ app: string; level: GuardLevel } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
  function apply() {
    if (!action) return
    const { app, level } = action
    mutation.mutate({ app, level }, {
      onSuccess: ({ guard: updated }) => {
        const view = updated.apps[app]
        const error = view?.last_error
        setResult({ ok: !error, text: error
          ? `${nameOf(reg, app)}下发失败：${appErrorLabel(error)}。下次巡检会重试；实际状态见下方。`
          : `${nameOf(reg, app)}：${level === 'shed' ? '已要求延后非关键工作 24 小时' : '已要求恢复，本 UTC 日内不再自动延后'}。` })
      },
      onError: (error) => setResult({ ok: false, text: error instanceof ApiError ? error.message : '操作失败，请稍后重试' }),
      onSettled: () => setAction(null),
    })
  }
  return (
    <section aria-label="延后非关键后台工作">
      <h3>延后非关键后台工作</h3>
      <p className="small muted">达到账户配额的 {guard.thresholds.shed_percent}% 时自动延后；降至 {guard.thresholds.clear_percent}% 以下时解除。下方只列出支持此操作的服务。</p>
      <ul className="action-list">
        {guardedEntries(reg, guard).map((app) => {
          const view = guard.apps[app]
          if (!view) return null
          // A view from before 2026-10-04 has no per-app target (guard.proto): show the automatic one.
          const desired = view.desired ?? guard.desired
          return (
            <li key={app} className="action">
              <div className="action-text">
                <span className="action-title">{nameOf(reg, app)}</span>
                <span className="small">实际：{effectiveLevel(view.state)} · 目标：{desired.level === 'shed' ? '延后' : '正常'}（{guardReasonLabel(desired.reason ?? 'quota_normal')}）</span>
                {view.override ? <span className="small muted">手动设置有效至 <Time iso={view.override.until} now={now} /></span> : null}
                {view.last_error ? <span className="small">下发失败：{appErrorLabel(view.last_error)}</span> : null}
                <span className="small muted">{EFFECTS[app]}</span>
              </div>
              <div className="row-wrap">
                <Button disabled={mutation.isPending} onClick={() => setAction({ app, level: 'shed' })} aria-label={`${nameOf(reg, app)}：延后 24 小时`}>延后 24 小时</Button>
                <Button disabled={mutation.isPending} onClick={() => setAction({ app, level: 'normal' })} aria-label={`${nameOf(reg, app)}：恢复`}>恢复</Button>
              </div>
            </li>
          )
        })}
      </ul>
      {result ? <div role={result.ok ? 'status' : 'alert'}><Notice tone={result.ok ? 'ok' : 'warn'}>{result.text}</Notice></div> : null}
      {action ? (
        <Modal title={`${nameOf(reg, action.app)}：${action.level === 'shed' ? '延后非关键工作？' : '恢复正常执行？'}`}
          busy={mutation.isPending} onClose={() => !mutation.isPending && setAction(null)}
          footer={<><Button disabled={mutation.isPending} onClick={() => setAction(null)} data-autofocus>取消</Button><Button disabled={mutation.isPending} onClick={apply}>确认</Button></>}>
          <p>{action.level === 'shed' ? `只对${nameOf(reg, action.app)}生效，24 小时后自动结束。${EFFECTS[action.app] ?? ''}` : `只恢复${nameOf(reg, action.app)}，并暂停它的自动延后至下一个 00:00 UTC（本地 ${formatClock(midnight)}）。其他服务保持原状态。`}</p>
        </Modal>
      ) : null}
    </section>
  )
}
