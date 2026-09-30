/**
 * The send step's status line and actions (docs/ux.md §5 table), one pure mapping so every state's copy is
 * tested. `retry` resends the frozen payload (Todofy never duplicates it); `resend` rebuilds an unrecorded
 * send; `back` returns to the editable confirm step; `done` leaves for the done screen.
 */
import type { SendStatus } from '../../../worker/src/api-types.ts'

export type SendTone = 'busy' | 'ok' | 'warn' | 'danger' | 'info'
export type SendAction = 'done' | 'retry' | 'resend' | 'back'

export interface SendCopy {
  readonly tone: SendTone
  readonly text: string
  readonly actions: readonly SendAction[]
  /** The status may still change by itself (the UI polls). */
  readonly settling: boolean
}

export const ERROR_REASONS: Readonly<Record<NonNullable<SendStatus['error_code']>, string>> = {
  maintenance: 'Todofy 维护中',
  processing_paused: 'Todofy 处理已暂停',
  todoist_paused: 'Todoist 已暂停',
  todoist_blocked: 'Todoist 授权需要更新',
  backup_active: 'Todofy 正在备份',
  rate_limited: 'Todoist 请求过多',
  retry_wait: '等待重试',
  todoist_rejected: 'Todoist 拒绝了请求',
  todoist_result_unknown: 'Todoist 的结果未知',
  intent_conflict: '同一编号的内容不一致',
  daily_limit: '今天发送次数已达上限',
  url_not_allowed: '链接不被允许',
  source_not_allowed: '来源未被允许',
  invalid_input: '内容格式有误',
  unavailable: 'Todofy 暂时无法连接',
  busy: 'Todofy 正忙',
}

export function errorReason(code: SendStatus['error_code']): string | null {
  return code && Object.hasOwn(ERROR_REASONS, code) ? ERROR_REASONS[code] : null
}

export function sendCopy(status: SendStatus): SendCopy {
  const reason = errorReason(status.error_code)
  switch (status.state) {
    case 'sending':
      return { tone: 'busy', text: '正在发送…', actions: [], settling: true }
    case 'pending':
      return {
        tone: 'busy',
        text: status.tasks_total > 0 ? `Todofy 正在创建：${status.tasks_created} / ${status.tasks_total}` : 'Todofy 正在创建…',
        actions: [],
        settling: true,
      }
    case 'created':
      return { tone: 'ok', text: `已发送：Todoist 里新增了 ${status.tasks_created || status.tasks_total} 个任务`, actions: ['done'], settling: false }
    case 'duplicate':
      return { tone: 'ok', text: '这组已经发送过，不会重复创建', actions: ['done'], settling: false }
    case 'paused':
      return status.recorded
        ? { tone: 'info', text: `已交给 Todofy，等它恢复后会自动创建${reason ? `（${reason}）` : ''}`, actions: ['done'], settling: true }
        : { tone: 'warn', text: `Todofy 暂停中（${reason ?? '已暂停'}），这次没有发送`, actions: ['resend'], settling: false }
    case 'failed':
      return {
        tone: 'danger',
        text: `部分失败：已创建 ${status.tasks_created} / ${status.tasks_total}${reason ? `（${reason}）` : ''}`,
        actions: ['retry'],
        settling: false,
      }
    case 'rejected':
      return { tone: 'danger', text: `没有发送：${reason ?? '请求被拒绝'}`, actions: ['back'], settling: false }
    case 'unknown':
      return { tone: 'warn', text: '结果未知：重试不会重复创建', actions: ['retry'], settling: true }
  }
}

/** The send is settled with Todoist tasks in place, so the confirm step is over for these papers. */
export function isDelivered(status: SendStatus | null): boolean {
  return status !== null && (status.state === 'created' || status.state === 'duplicate')
}

/** The content of the open send cannot change any more (retries resend it unchanged). */
export function isLocked(status: SendStatus | null): boolean {
  return status !== null && status.frozen && !isDelivered(status)
}
