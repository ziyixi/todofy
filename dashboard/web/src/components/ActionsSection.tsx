import { Play, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { CanaryRun, GuardLevel } from '../../../worker/src/api-types.ts'
import type { GuardViewV2, OpsResponse } from '../../../worker/src/api-v2-types.ts'
import { ApiError } from '../api/client'
import { useSetGuard, useStartCanary } from '../api/queries'
import { formatClock, formatFullTime, formatTime } from '../lib/format'
import {
  CANARY_DISABLED_TEXT,
  CANARY_OUTCOME,
  CANARY_PHASE,
  CANARY_STAGE,
  appErrorLabel,
  canaryCodeLabel,
  guardReasonLabel,
} from '../lib/labels'
import { guardedEntries, nameOf, type Reg } from '../lib/registry'
import { Modal } from './Modal'
import { Button, Card, Fact, Facts, Pill, Time } from './ui'

type Dialog = 'canary' | 'shed' | 'clear' | null
interface Result {
  kind: 'ok' | 'error'
  text: string
}

/** The exact confirmation texts (docs/design.md §8); tests compare them verbatim. */
export function canaryConfirmText(remaining: number): string {
  return `调用 Mail Hero 直接创建一封固定内容的合成测试邮件（不经过来源转发、Email Routing 收件、原件保存与解析），经正常投递链路发给 Todofy；Todofy 按正常流程调用 Gemini 摘要并校验（暂时性失败最多尝试 3 次，计入 Gemini 预算），不创建 Todoist 任务、不进入列表或提醒。本 UTC 日还可手动运行 ${remaining} 次。`
}
/** What shed defers (contracts/ops-v1/IMPLEMENTATION.md §2.5 and §3.7). */
export const SHED_CONFIRM_TEXT =
  '立即让两个应用降载 24 小时：Mail Hero 推迟原件对账、保留期清理、金丝雀清理和告警历史清理（每项最多推迟 48 小时）；Todofy 推迟开始新一轮每周备份（上次完整备份超过 7.5 天仍会执行）、过期数据清理和趋势统计汇总（最多推迟 72 小时，之后补上）。收件、解析、投递、重试、已在进行的备份和真实邮件处理不受影响。可随时解除。'
/** `resetLocal`: the next 00:00 UTC in the browser's time zone. */
export function clearConfirmText(resetLocal: string): string {
  return `立即结束两个应用的降载，并在本 UTC 日剩余时间内暂停自动降载；次日 00:00 UTC（本地 ${resetLocal}）起恢复自动判断。`
}

/** The next 00:00 UTC after `now`, as ISO. */
function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message}（请求 ${error.requestId}）` : error.message
  return '操作失败，请稍后重试'
}

function canaryResultText(run: CanaryRun): string {
  if (run.phase === 'starting' && run.start_code) {
    return `未能立即启动金丝雀 ${run.run_id}：${canaryCodeLabel(run.start_code)}；截止前每 30 分钟重试一次。`
  }
  if (run.phase === 'done' && run.outcome) {
    const where = run.stage ? `，${CANARY_STAGE[run.stage]}阶段：${run.code ? canaryCodeLabel(run.code) : '无代码'}` : ''
    return `金丝雀 ${run.run_id} 已结束：${CANARY_OUTCOME[run.outcome].label}${where}。`
  }
  return `已启动金丝雀 ${run.run_id}（${CANARY_PHASE[run.phase]}），之后每 30 分钟检查一次进度。`
}

function guardResultText(reg: Reg, level: GuardLevel, guard: GuardViewV2): string {
  const failed = guardedEntries(reg, guard)
    .filter((app) => guard.apps[app]?.last_error)
    .map((app) => `${nameOf(reg, app)} 调用失败（${appErrorLabel(guard.apps[app]?.last_error ?? 'unavailable')}），下次定时检查会重试`)
  const head =
    level === 'shed'
      ? `已要求两个应用降载${guard.desired.until ? `，直到 ${formatTime(guard.desired.until)}` : ''}。`
      : '已解除降载，本 UTC 日剩余时间内不会自动降载。'
  return failed.length ? `${head}${failed.join('；')}。` : head
}

const SOURCE_LABEL: Readonly<Record<GuardViewV2['desired']['source'], string>> = {
  auto: '自动（按配额）',
  owner: '手动',
  none: '—',
}

/**
 * 操作与记录's actions (docs/design.md §8, unchanged texts): the guard (force shed, clear) and the
 * manual run of the canary bound to the mail flow. Every mutation is confirmed first and sent with the
 * CSRF token.
 */
export function ActionsSection({ reg, ops, now }: { reg: Reg; ops: OpsResponse; now: Date }) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [result, setResult] = useState<Result | null>(null)
  const canary = useStartCanary()
  const guard = useSetGuard()
  const busy = canary.isPending || guard.isPending

  const { desired, override, thresholds } = ops.guard
  // The canary is one the registry binds to a flow (the runner cannot be invented by the page).
  const canaryDef = reg.flows.find((flow) => flow.canary?.id === ops.canary.id)?.canary ?? null
  const remaining = Math.max(0, ops.canary.manual_limit - ops.canary.manual_today)
  const canaryDisabled = !ops.canary.enabled || canaryDef === null
  const canaryBlocked = canaryDef === null
    ? '注册表没有登记这个金丝雀，不能手动运行。'
    : canaryDisabled
    ? `${CANARY_DISABLED_TEXT}，不能手动运行。`
    : ops.canary.active
      ? `已有运行 ${ops.canary.active.run_id} 正在进行，结束后才能再次运行。`
      : remaining === 0
        ? `本 UTC 日的 ${ops.canary.manual_limit} 次手动运行已用完。`
        : null

  function close() {
    if (!busy) setDialog(null)
  }

  function runCanary() {
    setResult(null)
    if (canaryDef === null) return
    canary.mutate(canaryDef.id, {
      onSuccess: ({ run }) => setResult({ kind: 'ok', text: canaryResultText(run) }),
      onError: (error) => setResult({ kind: 'error', text: `未能启动金丝雀：${errorText(error)}` }),
      onSettled: () => setDialog(null),
    })
  }

  function applyGuard(level: GuardLevel) {
    setResult(null)
    guard.mutate(level, {
      onSuccess: (response) => setResult({ kind: 'ok', text: guardResultText(reg, level, response.guard) }),
      onError: (error) => setResult({ kind: 'error', text: `${level === 'shed' ? '未能强制降载' : '未能解除降载'}：${errorText(error)}` }),
      onSettled: () => setDialog(null),
    })
  }

  return (
    <Card id="actions" title="降载与操作" level={2}>
      <div className="guard-summary">
        <div className="row-wrap">
          {desired.level === 'shed' ? (
            <Pill tone="warn" strong>
              降载中
            </Pill>
          ) : (
            <Pill tone="ok" strong>
              未降载
            </Pill>
          )}
          {desired.reason ? <span className="small">原因：{guardReasonLabel(desired.reason)}</span> : null}
        </div>
        <Facts>
          <Fact label="来源">{SOURCE_LABEL[desired.source]}</Fact>
          {desired.until ? (
            <Fact label="直到">
              <Time iso={desired.until} now={now} />
            </Fact>
          ) : null}
          {override ? (
            <Fact label="手动设置">
              {override.level === 'shed' ? '强制降载' : '暂停自动降载'}，至{' '}
              <time dateTime={override.until} title={formatFullTime(override.until)}>
                {formatTime(override.until, now)}
              </time>
            </Fact>
          ) : null}
          {guardedEntries(reg, ops.guard).map((app) => {
            const view = ops.guard.apps[app]
            return (
              <Fact key={app} label={nameOf(reg, app)}>
                {view?.state ? (view.state.level === 'shed' ? '降载中' : '正常') : '未知'}
                {view?.last_error ? `（上次下发失败：${appErrorLabel(view.last_error)}）` : ''}
              </Fact>
            )
          })}
        </Facts>
        <p className="small muted">
          自动规则：任一每日项目或每月 R2 操作达到 {thresholds.shed_percent}% 时两个应用降载；同一 UTC 日内降到{' '}
          {thresholds.clear_percent}% 以下或新的一天开始时恢复。
        </p>
      </div>

      <ul className="action-list">
        <ActionItem
          id="action-canary"
          title="立即运行金丝雀"
          description={`本 UTC 日已手动运行 ${ops.canary.manual_today} / ${ops.canary.manual_limit} 次。`}
          blocked={canaryBlocked}
          button={
            // aria-disabled rather than disabled while a run is active or the limit is reached: the button
            // keeps focus (and its reason) after a run starts. Switched off by configuration: disabled.
            <Button
              variant="primary"
              onClick={() => canaryBlocked === null && setDialog('canary')}
              disabled={busy || canaryDisabled}
              aria-disabled={canaryBlocked !== null && !canaryDisabled ? true : undefined}
              aria-describedby="action-canary-desc"
            >
              <Play size={16} aria-hidden="true" />
              立即运行金丝雀
            </Button>
          }
        />
        <ActionItem
          id="action-shed"
          title="强制降载"
          description="手动让两个应用降载 24 小时。"
          button={
            <Button onClick={() => setDialog('shed')} disabled={busy} aria-describedby="action-shed-desc">
              <ShieldAlert size={16} aria-hidden="true" />
              强制降载
            </Button>
          }
        />
        <ActionItem
          id="action-clear"
          title="解除降载"
          description="结束降载，并暂停自动降载到下一个 00:00 UTC。"
          button={
            <Button onClick={() => setDialog('clear')} disabled={busy} aria-describedby="action-clear-desc">
              <ShieldCheck size={16} aria-hidden="true" />
              解除降载
            </Button>
          }
        />
      </ul>

      <div className="action-result" role="status" aria-live="polite">
        {result?.kind === 'ok' ? <p className="result result-ok">{result.text}</p> : null}
      </div>
      <div className="action-result" role="alert">
        {result?.kind === 'error' ? <p className="result result-error">{result.text}</p> : null}
      </div>

      {dialog === 'canary' ? (
        <Modal
          title="立即运行金丝雀？"
          onClose={close}
          busy={busy}
          footer={
            <>
              <Button onClick={close} disabled={busy} data-autofocus>
                取消
              </Button>
              <Button variant="primary" onClick={runCanary} disabled={busy}>
                {canary.isPending ? '正在启动…' : '确认运行'}
              </Button>
            </>
          }
        >
          <p>{canaryConfirmText(remaining)}</p>
        </Modal>
      ) : null}
      {dialog === 'shed' ? (
        <Modal
          title="强制降载？"
          onClose={close}
          busy={busy}
          footer={
            <>
              <Button onClick={close} disabled={busy} data-autofocus>
                取消
              </Button>
              <Button variant="danger" onClick={() => applyGuard('shed')} disabled={busy}>
                {guard.isPending ? '正在降载…' : '确认降载'}
              </Button>
            </>
          }
        >
          <p>{SHED_CONFIRM_TEXT}</p>
        </Modal>
      ) : null}
      {dialog === 'clear' ? (
        <Modal
          title="解除降载？"
          onClose={close}
          busy={busy}
          footer={
            <>
              <Button onClick={close} disabled={busy} data-autofocus>
                取消
              </Button>
              <Button variant="primary" onClick={() => applyGuard('normal')} disabled={busy}>
                {guard.isPending ? '正在解除…' : '确认解除'}
              </Button>
            </>
          }
        >
          <p>{clearConfirmText(formatClock(nextUtcMidnight(now)))}</p>
        </Modal>
      ) : null}
    </Card>
  )
}

function ActionItem({
  id,
  title,
  description,
  blocked = null,
  button,
}: {
  id: string
  title: string
  description: string
  blocked?: string | null
  button: ReactNode
}) {
  return (
    <li className="action">
      <div className="action-text">
        <span className="action-title">{title}</span>
        <span className="small muted" id={`${id}-desc`}>
          {blocked ?? description}
        </span>
      </div>
      {button}
    </li>
  )
}
