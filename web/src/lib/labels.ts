import type { ClientErrorCode } from '../api/client'
import type {
  ApiErrorCode,
  EventErrorCode,
  EventState,
  RecommendationReport,
  ReconcileAction,
  ReminderErrorCode,
  ReminderState,
  SummaryReport,
} from '../api/types'

export type Tone = 'neutral' | 'progress' | 'ok' | 'warn' | 'danger'

export interface Label {
  label: string
  tone: Tone
}

export interface CodeLabel {
  /** A few words for lists and cards. */
  title: string
  /** What happened and what the Worker does next. The only copy of this text: keep it in step
   *  with the Worker's behaviour (worker/todofy/core/vocab.py holds the codes, not the text). */
  detail: string
}

export const EVENT_STATES: Record<EventState, Label> = {
  pending: { label: '待摘要', tone: 'progress' },
  summarizing: { label: '摘要中', tone: 'progress' },
  summarized: { label: '待建任务', tone: 'progress' },
  todo_sending: { label: '建任务中', tone: 'progress' },
  todo_unknown: { label: '结果不明', tone: 'warn' },
  todo_created: { label: '任务已建', tone: 'ok' },
  complete: { label: '已完成', tone: 'ok' },
  ignored: { label: '已忽略', tone: 'neutral' },
  failed_summary: { label: '摘要失败', tone: 'danger' },
}

export const EVENT_STATE_ORDER = Object.keys(EVENT_STATES) as EventState[]

export const EVENT_ERRORS: Record<EventErrorCode, CodeLabel> = {
  mail_needs_review: {
    title: '邮件需人工检查',
    detail: 'Mail Hero 标记该邮件需要人工检查（或 HTML 被省略且没有正文）；不会调用 Gemini，也不会建任务',
  },
  summary_failed: {
    title: 'Gemini 暂时不可用',
    detail: 'Gemini 暂时不可用（5xx、超时、网络错误或空输出），会按退避自动重试最多 7 天',
  },
  llm_quota: { title: 'Gemini 限流', detail: 'Gemini 返回限流（429），会按 Retry-After 与退避自动重试' },
  llm_budget_exhausted: {
    title: '今日 Gemini 预算用完',
    detail: '当日 Gemini token 预算已用完，推迟到预算恢复后继续，不会丢弃',
  },
  llm_request_rejected: {
    title: 'Gemini 拒绝请求',
    detail: 'Gemini 拒绝了请求（400/401/403/404 等），多半是密钥或模型配置问题；重试 12 次后停止',
  },
  processing_interrupted_limit: {
    title: '摘要多次中断',
    detail: '摘要连续 3 次在运行中被中断，已停止自动重试',
  },
  todoist_rejected: {
    title: 'Todoist 拒绝创建',
    detail: 'Todoist 拒绝创建任务（400/404 等），会按退避自动重试；若一直被拒绝，可以放弃此事件',
  },
  todoist_auth_blocked: {
    title: 'Todoist 认证失败',
    detail: 'Todoist 认证失败（401/403），建任务阶段暂停 6 小时；请检查 TODOIST_API_KEY',
  },
  todoist_rate_limited: { title: 'Todoist 限流', detail: 'Todoist 限流（429），会按 Retry-After 与退避自动重试' },
  todoist_unavailable: {
    title: 'Todoist 暂时不可用',
    detail: 'Todoist 暂时不可用（502/503/504 或连接失败），会按退避自动重试',
  },
  todo_result_unknown: {
    title: '建任务结果不明',
    detail: 'Todoist 建任务的结果不明（500、超时、断连或响应没有任务 ID），任务可能已创建；不会自动重发',
  },
  interrupted_todo_call: {
    title: '建任务时被中断',
    detail: '调用 Todoist 时运行被中断，任务可能已创建；不会自动重发',
  },
  lookup_not_found: { title: '查找未找到任务', detail: '在默认项目的未完成任务里没有找到带本事件页脚的任务' },
  lookup_failed: { title: '查找失败', detail: '只读查找 Todoist 任务失败，稍后会再查' },
  lookup_ambiguous: { title: '找到多个任务', detail: '找到多个带本事件页脚的任务，需要人工确认' },
  dismissed_by_owner: { title: '已由你放弃', detail: 'owner 已放弃此事件，账本仍保留去重记录' },
  invalid_saved_event: { title: '（旧版）事件无法解析', detail: '（旧版）已保存的事件无法解析' },
  llm_client_unavailable: { title: '（旧版）LLM 服务不可用', detail: '（旧版）无法连接旧 LLM 服务' },
  summary_render_failed: { title: '（旧版）渲染失败', detail: '（旧版）渲染任务描述失败' },
  todo_client_unavailable: { title: '（旧版）todo 服务不可用', detail: '（旧版）无法连接旧 todo 服务，任务未创建' },
  database_client_unavailable: { title: '（旧版）数据库不可用', detail: '（旧版）无法连接旧数据库服务' },
  cache_write_failed: { title: '（旧版）缓存写入失败', detail: '（旧版）写入旧摘要缓存失败' },
  checkpoint_failed: {
    title: '（旧版）账本写入失败',
    detail: '（旧版）Todoist 调用后写入账本失败，任务可能已创建',
  },
}

export const REMINDER_STATES: Record<ReminderState, Label> = {
  sending: { label: '创建中', tone: 'progress' },
  created: { label: '已创建', tone: 'ok' },
  unknown: { label: '结果不明', tone: 'warn' },
  failed: { label: '失败', tone: 'danger' },
}

export const REMINDER_ERRORS: Record<ReminderErrorCode, CodeLabel> = {
  reminder_create_failed: {
    title: '提醒未能创建',
    detail: '提醒任务未能创建（请求没有发出或被 Todoist 拒绝），每小时重试，最多 5 次',
  },
  reminder_result_unknown: { title: '提醒结果不明', detail: '提醒任务的结果不明，可能已创建；当天不再重发' },
  interrupted_reminder_call: {
    title: '创建提醒时被中断',
    detail: '创建提醒时运行被中断，可能已创建；当天不再重发',
  },
  empty_task_id: { title: '（旧版）空任务 ID', detail: '（旧版）旧 todo 服务返回了空任务 ID' },
  todo_client_unavailable: { title: '（旧版）todo 服务不可用', detail: '（旧版）无法连接旧 todo 服务，提醒未创建' },
}

/** What the owner can do about an API error; the server's own message is shown next to it. */
export const API_ERROR_HINTS: Record<ApiErrorCode | ClientErrorCode, string> = {
  invalid_request: '请求参数无效；刷新页面后重试',
  invalid_payload: '事件内容不符合 mail.received.v1 合同',
  unauthorized: 'Cloudflare Access 登录已失效；刷新页面重新登录',
  csrf_failed: '页面安全令牌已失效；再试一次会自动取得新令牌',
  not_found: '找不到该资源；它可能已被清理，或链接有误',
  event_conflict: '同一事件 ID 已收到不同内容',
  version_conflict: '事件在你查看后已被更新；刷新后确认新状态再操作',
  action_not_allowed: '事件当前状态不允许此操作；刷新后查看可用操作',
  action_request_conflict: '同一操作 ID 已用于不同的请求；关闭对话框后重新操作',
  payload_too_large: '请求体超过 1 MiB',
  unsupported_media_type: '只接受 application/json',
  rate_limited: '已达到频率上限；稍后再试',
  internal_error: 'Worker 内部错误；稍后重试，仍失败请按请求 ID 查日志',
  maintenance: '服务处于维护模式，写操作暂不可用',
  not_configured: 'Worker 缺少必需的密钥或配置；按设置页检查',
  access_not_configured: 'Cloudflare Access 变量不完整；按设置页检查',
  unavailable: 'D1 或后台协调器暂时不可用；稍后重试',
  network_error: '网络中断，或 Access 登录已过期；刷新页面后重试',
  bad_response: '收到的不是 Todofy 的响应，可能是登录页或代理错误；刷新页面后重试',
}

export interface ActionCopy {
  title: string
  /** The button that opens the dialog. */
  trigger: string
  /** The dialog's confirm button. */
  confirm: string
  /** Exactly what happens after confirming. */
  consequence: string
  destructive: boolean
}

export const RECONCILE_ACTIONS: Record<ReconcileAction, ActionCopy> = {
  task_created: {
    title: '标记为已建任务',
    trigger: '我找到了任务',
    confirm: '确认已建任务',
    consequence:
      '事件会记为已建任务并使用你填写的 Todoist 任务 ID，之后不再为它调用 Todoist 建任务。请确认该任务的描述里带有本事件的页脚。',
    destructive: false,
  },
  task_not_created: {
    title: '确认没有建任务',
    trigger: '任务没有建成',
    confirm: '重新建任务',
    consequence:
      '会先在 Todoist 默认项目里只读查找带本事件页脚的任务；没有找到时，用冻结的任务内容再次调用 Todoist。会再次调用 Todoist，可能重复建任务。',
    destructive: true,
  },
  retry_summary: {
    title: '重新生成摘要',
    trigger: '重试摘要',
    confirm: '重新生成摘要',
    consequence: '会重新调用 Gemini 生成摘要并计入当日 token 预算；成功后按正常流程创建 Todoist 任务。',
    destructive: false,
  },
  dismiss: {
    title: '放弃此事件',
    trigger: '放弃',
    confirm: '放弃事件',
    consequence:
      '事件会变为已忽略，不再自动处理。不会检查 Todoist：如果任务其实已经创建，它会留在 Todoist 里。账本保留去重记录，同一事件再次投递也不会重新处理。',
    destructive: true,
  },
}

export const SUMMARY_STATUS: Record<SummaryReport['status'], Label> = {
  ok: { label: '正常', tone: 'ok' },
  empty_window: { label: '窗口内没有邮件', tone: 'warn' },
  stale: { label: '过期结果', tone: 'warn' },
}

export const RECOMMENDATION_STATUS: Record<RecommendationReport['status'], Label> = {
  ok: { label: '正常', tone: 'ok' },
  empty_window: { label: '窗口内没有邮件', tone: 'warn' },
  model_output_invalid: { label: '模型输出无效', tone: 'danger' },
  stale: { label: '过期结果', tone: 'warn' },
}
