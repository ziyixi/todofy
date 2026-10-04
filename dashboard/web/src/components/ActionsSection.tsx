import { Play } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { CanaryRun } from '../../../worker/src/api-types.ts'
import type { OpsView } from '../../../worker/src/api-types.ts'
import { ApiError } from '../api/client'
import { useStartCanary } from '../api/queries'
import {
  CANARY_DISABLED_TEXT,
  CANARY_OUTCOME,
  CANARY_PHASE,
  CANARY_STAGE,
  canaryCodeLabel,
} from '../lib/labels'
import { type Reg } from '../lib/registry'
import { Modal } from './Modal'
import { GuardControls } from './GuardControls'
import { Button, Card } from './ui'

type Dialog = 'canary' | null
interface Result {
  kind: 'ok' | 'error'
  text: string
}

/** The exact confirmation texts (docs/design.md §8); tests compare them verbatim. */
export function canaryConfirmText(remaining: number): string {
  return `调用 Mail Hero 直接创建一封固定内容的合成测试邮件（不经过来源转发、Email Routing 收件、原件保存与解析），经正常投递链路发给 Todofy；Todofy 按正常流程调用 Gemini 摘要并校验（暂时性失败最多尝试 3 次，计入 Gemini 预算），不创建 Todoist 任务、不进入列表或提醒。本 UTC 日还可手动运行 ${remaining} 次。`
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

/**
 * 操作与记录's actions (docs/design.md §8, unchanged texts): the guard (force shed, clear) and the
 * manual run of the canary bound to the mail flow. Every mutation is confirmed first and sent with the
 * CSRF token.
 */
export function ActionsSection({ reg, ops, now }: { reg: Reg; ops: OpsView; now: Date }) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const [result, setResult] = useState<Result | null>(null)
  const canary = useStartCanary()
  const busy = canary.isPending

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

  return (
    <Card id="actions" title="降载与操作" level={2}>
      <GuardControls reg={reg} guard={ops.guard} now={now} />

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
