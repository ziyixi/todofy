/**
 * The send step's status line and actions (docs/ux.md §5 table), one pure mapping so every state's copy is
 * tested. `retry` resends the frozen payload (Todofy never duplicates it); `resend` rebuilds an unrecorded
 * send; `back` returns to the editable confirm step; `done` leaves for the done screen, and so does `later`
 * (稍后再说: a neutral way out of a failed or unknown send, which stays retryable from the done screen).
 */
import { Send_State, SendErrorCode, type Send } from '@ziyixi/proto/lab/ui/v1/deck_pb'

export type SendTone = 'busy' | 'ok' | 'warn' | 'danger' | 'info'
export type SendAction = 'done' | 'retry' | 'resend' | 'back' | 'later'

export interface SendCopy {
  readonly tone: SendTone
  readonly text: string
  readonly actions: readonly SendAction[]
  /** The status may still change by itself (the UI polls). */
  readonly settling: boolean
}

type Reason = Exclude<SendErrorCode, typeof SendErrorCode.UNSPECIFIED>

/** Each send error code's copy (lab.ui.v1 SendErrorCode): exhaustive, so a new code needs its copy here. */
export const ERROR_REASONS: Readonly<Record<Reason, string>> = {
  [SendErrorCode.MAINTENANCE]: 'Todofy 维护中',
  [SendErrorCode.PROCESSING_PAUSED]: 'Todofy 处理已暂停',
  [SendErrorCode.TODOIST_PAUSED]: 'Todoist 已暂停',
  [SendErrorCode.TODOIST_BLOCKED]: 'Todoist 授权需要更新',
  [SendErrorCode.BACKUP_ACTIVE]: 'Todofy 正在备份',
  [SendErrorCode.RATE_LIMITED]: 'Todoist 请求过多',
  [SendErrorCode.RETRY_WAIT]: '等待重试',
  [SendErrorCode.TODOIST_REJECTED]: 'Todoist 拒绝了请求',
  [SendErrorCode.TODOIST_RESULT_UNKNOWN]: 'Todoist 的结果未知',
  [SendErrorCode.INTENT_CONFLICT]: '同一编号的内容不一致',
  [SendErrorCode.DAILY_LIMIT]: '今天发送次数已达上限',
  [SendErrorCode.URL_NOT_ALLOWED]: '链接不被允许',
  [SendErrorCode.SOURCE_NOT_ALLOWED]: '来源未被允许',
  [SendErrorCode.INVALID_INPUT]: '内容格式有误',
  [SendErrorCode.UNAVAILABLE]: 'Todofy 暂时无法连接',
  [SendErrorCode.BUSY]: 'Todofy 正忙',
}

export function errorReason(code: SendErrorCode): string | null {
  return ERROR_REASONS[code as Reason] ?? null
}

export function sendCopy(status: Send): SendCopy {
  const reason = errorReason(status.errorCode)
  switch (status.state) {
    case Send_State.SENDING:
      return { tone: 'busy', text: '正在发送…', actions: [], settling: true }
    case Send_State.PENDING:
      return {
        tone: 'busy',
        text: status.tasksTotal > 0 ? `Todofy 正在创建：${status.tasksCreated} / ${status.tasksTotal}` : 'Todofy 正在创建…',
        actions: [],
        settling: true,
      }
    case Send_State.CREATED:
      return { tone: 'ok', text: `已发送：Todoist 里新增了 ${status.tasksCreated || status.tasksTotal} 个任务`, actions: ['done'], settling: false }
    case Send_State.DUPLICATE:
      return { tone: 'ok', text: '这组已经发送过，不会重复创建', actions: ['done'], settling: false }
    case Send_State.PAUSED:
      return status.recorded
        ? { tone: 'info', text: `已交给 Todofy，等它恢复后会自动创建${reason ? `（${reason}）` : ''}`, actions: ['done'], settling: true }
        : { tone: 'warn', text: `Todofy 暂停中（${reason ?? '已暂停'}），这次没有发送`, actions: ['resend'], settling: false }
    case Send_State.FAILED:
      if (isPauseCode(status.errorCode)) {
        // A retry while Todofy is paused: nothing was re-queued (docs/design.md §9).
        return {
          tone: 'warn',
          text: `Todofy 暂停中（${reason ?? '已暂停'}），这次重试没有进行：已创建 ${status.tasksCreated} / ${status.tasksTotal}，恢复后再重试`,
          actions: ['retry', 'later'],
          settling: false,
        }
      }
      return {
        tone: 'danger',
        text:
          status.tasksCreated === 0
            ? `发送失败：没有创建任务${reason ? `（${reason}）` : ''}`
            : `部分失败：已创建 ${status.tasksCreated} / ${status.tasksTotal}${reason ? `（${reason}）` : ''}`,
        actions: ['retry', 'later'],
        settling: false,
      }
    case Send_State.REJECTED:
      return { tone: 'danger', text: `没有发送：${reason ?? '请求被拒绝'}`, actions: ['back'], settling: false }
    case Send_State.UNKNOWN:
      return { tone: 'warn', text: '结果未知：重试不会重复创建', actions: ['retry', 'later'], settling: true }
    default:
      // A state this build does not know (read leniently as UNSPECIFIED): say so, and keep asking.
      return { tone: 'info', text: '状态未知，稍后刷新', actions: ['later'], settling: true }
  }
}

const PAUSE_CODES: ReadonlySet<SendErrorCode> = new Set([
  SendErrorCode.MAINTENANCE,
  SendErrorCode.PROCESSING_PAUSED,
  SendErrorCode.TODOIST_PAUSED,
  SendErrorCode.TODOIST_BLOCKED,
  SendErrorCode.BACKUP_ACTIVE,
])

export function isPauseCode(code: SendErrorCode): boolean {
  return PAUSE_CODES.has(code)
}

/** The send is settled with Todoist tasks in place, so the confirm step is over for these papers. */
export function isDelivered(status: Send | null): boolean {
  return status !== null && (status.state === Send_State.CREATED || status.state === Send_State.DUPLICATE)
}

/** The content of the open send cannot change any more (retries resend it unchanged). */
export function isLocked(status: Send | null): boolean {
  return status !== null && status.frozen && !isDelivered(status)
}
