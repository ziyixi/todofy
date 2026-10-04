/**
 * Chinese labels for every machine code the page shows (docs/design.md §8). Codes are open-ended in
 * ops-v1 (new signals, counters, reasons may appear), so every lookup falls back to the raw code.
 */
import type { ApiErrorCode } from '../api/client'
import type {
  AppErrorCode,
  CanaryKind,
  CanaryOutcome,
  CanaryPhase,
  CanaryStage,
  OpsSeverity,
  QuotaPeriod,
  QuotaResource,
  UsageState,
} from '../../../worker/src/api-types.ts'
import type { CanaryBadge, DriftCategory, DriftFinding, DriftState, Level, StatusSourceType } from '../../../worker/src/api-types.ts'
import { formatBytesBinary, formatDuration, formatNumber } from './format'

/** Visual tone of a status; always rendered together with a text label. */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

function lookup(table: Readonly<Record<string, string>>, code: string): string {
  return Object.hasOwn(table, code) ? (table[code] as string) : code
}

/** Sources that are not registry entries (digest items of the dashboard itself and of the account). */
export const PLATFORM_SOURCES: Readonly<Record<string, string>> = { dashboard: '个人控制台', cloudflare: 'Cloudflare' }

/**
 * The shared level vocabulary (docs/design-v2.md §2): always shape + word, never colour alone.
 * `link` has no mark (the tile shows its host); `unmonitored` is a hollow circle.
 */
export const LEVEL: Readonly<Record<Level, { word: string; tone: Tone }>> = {
  ok: { word: '正常', tone: 'ok' },
  held: { word: '已暂停', tone: 'info' },
  warning: { word: '需关注', tone: 'warn' },
  critical: { word: '故障', tone: 'danger' },
  unknown: { word: '未知', tone: 'neutral' },
  link: { word: '仅链接', tone: 'neutral' },
  unmonitored: { word: '未接入', tone: 'neutral' },
}

const REASONS: Readonly<Record<string, string>> = {
  unreachable: '无法连接',
  http_status: 'HTTP 状态异常',
  // The probe got the expected status with another media type: something else than the app's Worker answered.
  content_type: '响应类型不符',
  idle: '长时间没有请求',
  never_checked: '尚未检查',
  tick_stale: '定时检查已停止',
  error_rate: '错误率偏高',
  stale: '数据已过期',
  app_down: '应用报告不可用',
  app_degraded: '应用报告降级',
  never_seen: '还没有观察到请求',
  timeout: '请求超时',
  network_error: '网络错误',
  canary_failed: '金丝雀在这一阶段失败',
}

/** Why an entry is not ok (EntryState.reason): one of REASONS or a signal code. */
export function reasonLabel(code: string): string {
  return Object.hasOwn(REASONS, code) ? (REASONS[code] as string) : signalLabel(code)
}

/** How an entry's status is obtained (操作与记录 › 注册表). */
export const STATUS_SOURCE: Readonly<Record<StatusSourceType, string>> = {
  ops_v1: 'ops-v1 状态接口',
  public_http: '公开地址探测',
  analytics: 'Cloudflare 分析数据',
  self: '本面板的巡检',
  link_only: '仅链接（受 Access 保护，不探测）',
  none: '未接入监控',
}

export const CANARY_BADGE: Readonly<Record<CanaryBadge, { label: string; tone: Tone }>> = {
  verified: { label: '已验证', tone: 'ok' },
  failed: { label: '金丝雀失败', tone: 'danger' },
  held: { label: '已暂停未验证', tone: 'info' },
  unverified: { label: '未验证', tone: 'neutral' },
}

export const HEALTH: Readonly<Record<string, { label: string; tone: Tone }>> = {
  ok: { label: '正常', tone: 'ok' },
  degraded: { label: '降级', tone: 'warn' },
  down: { label: '不可用', tone: 'danger' },
}

export const SEVERITY: Readonly<Record<OpsSeverity, { label: string; tone: Tone }>> = {
  critical: { label: '严重', tone: 'danger' },
  warning: { label: '警告', tone: 'warn' },
  info: { label: '提示', tone: 'info' },
}

const SIGNALS: Readonly<Record<string, string>> = {
  // both apps
  host_never_seen: '主机尚未报告',
  host_stale: '主机报告延迟',
  host_missing: '主机报告中断',
  newsletter_unavailable: 'Newsletter 进程或 Pod 不可用',
  newsletter_paused: 'Newsletter 发布已排空或冻结',
  newsletter_unknown: 'Newsletter 有操作缺少最终完成记录',
  release_held: '发布暂停待处理',
  release_failed: '发布失败',
  release_in_progress: '发布进行中',
  deployment_pending: 'VPS 发布尚未就绪',
  disk_high: '服务器磁盘使用率偏高',
  memory_high: '服务器内存使用率偏高',
  maintenance_mode: '维护模式已开启',
  guard_shed: '降载中',
  status_unavailable: '状态读取失败',
  backup_active: '备份进行中',
  backup_stale: '备份过旧',
  // Mail Hero
  capacity_70: '存储容量超过 70%',
  capacity_85: '存储容量超过 85%',
  capacity_95: '存储容量超过 95%',
  endpoint_blocked: '投递目标已阻断',
  pending_stale: '待处理任务积压',
  parse_failed: '邮件解析失败',
  endpoint_paused: '投递目标已暂停',
  delivery_failed: '投递失败',
  policy_error: '策略错误',
  force_send_paused: '强制暂停投递（部署变量）',
  send_paused: '投递已暂停（设置）',
  ingest_quota_80: '今日收件额度超过 80%',
  forwarding_off: '未转发（仅归档或无目标）',
  // Todofy
  attention: '有需要处理的事件',
  due_backlog: '到期事件积压',
  processing_paused: '处理已暂停',
  todoist_paused: 'Todoist 已暂停',
  todoist_blocked: 'Todoist 调用被阻断',
  gemini_budget_80: 'Gemini 预算超过 80%',
  gemini_budget_95: 'Gemini 预算超过 95%',
  backup_failed: '上次备份失败',
  backup_disabled: '备份未启用',
  reminder_failed: '每日提醒发送失败',
  reminder_disabled: '每日提醒已关闭',
  gtd_snapshot_stale: 'GTD 快照过旧',
  review_overdue: '每周回顾已超过 10 天',
  // Lab
  feed_stale: 'arXiv 抓取过旧',
  neuron_cap_hit: '今日 AI 额度已用完',
  send_unsettled: '交给 Todofy 未完成',
  // the watch app
  watches_broken: '有监视已失效',
  scheduler_stale: '监视调度已停止',
  notify_unsettled: '提醒交给 Todofy 未完成',
  // dashboard digest items
  usage_unavailable: '用量数据获取失败',
  usage_not_configured: '未配置用量查询令牌',
  config_drift: '线上配置与代码不一致',
  drift_unavailable: '配置漂移检查连续失败',
  guard_apply_failed: '降载设置下发失败',
  canary_start_failed: '金丝雀启动失败',
  canary_not_delivered: '金丝雀未投递',
  canary_consumer_failed: '金丝雀在 Todofy 失败',
  canary_skipped: '金丝雀已跳过（未测试链路）',
  // Page only (info): CANARY_ENABLED=false.
  canary_disabled: '金丝雀已关闭',
  // Not emitted by this dashboard (it reports warning/critical only); kept for reports such as the
  // contract's OpsReport fixture, which Todofy also renders.
  canary_ok: '金丝雀成功',
  tick_stale: '定时检查已停止',
  app_unreachable: '应用无法连接',
  app_down: '应用不可用',
}

/** Signal, digest item or banner code → Chinese; `<quota id>_high` → "<resource> 用量高". */
export function signalLabel(code: string): string {
  if (Object.hasOwn(SIGNALS, code)) return SIGNALS[code] as string
  const quota = /^(.+)_high$/.exec(code)
  if (quota && isQuotaId(quota[1] as string)) {
    const name = QUOTA[quota[1] as QuotaResource]
    // A name ending in Latin letters ("Workers AI neurons") keeps a space before the Chinese.
    return `${name}${/[A-Za-z]$/.test(name) ? ' ' : ''}用量高`
  }
  return code
}

export const QUOTA: Readonly<Record<QuotaResource, string>> = {
  workers_requests: 'Workers 请求',
  d1_rows_read: 'D1 读取行数',
  d1_rows_written: 'D1 写入行数',
  do_requests: 'Durable Objects 请求',
  do_duration: 'Durable Objects 时长',
  do_rows_read: 'Durable Objects SQLite 读取行数',
  do_rows_written: 'Durable Objects SQLite 写入行数',
  ai_neurons: 'Workers AI neurons',
  r2_class_a: 'R2 A 类操作',
  r2_class_b: 'R2 B 类操作',
  d1_storage: 'D1 存储（全部数据库）',
  d1_database_max: 'D1 最大单库',
  do_storage: 'Durable Objects SQLite 存储',
  r2_storage: 'R2 存储',
}

export function isQuotaId(value: string): value is QuotaResource {
  return Object.hasOwn(QUOTA, value)
}

export const PERIODS: Readonly<Record<QuotaPeriod, { title: string; note: string }>> = {
  daily: { title: '每日', note: '每天 00:00 UTC 重置' },
  monthly: { title: '每月', note: 'UTC 自然月累计' },
  storage: { title: '存储', note: '当前占用，不随日期重置' },
}

export const USAGE_STATUS: Readonly<Record<UsageState, { label: string; tone: Tone }>> = {
  ok: { label: '最新', tone: 'ok' },
  stale: { label: '数据过期', tone: 'warn' },
  unavailable: { label: '无法获取', tone: 'danger' },
  not_configured: { label: '未配置', tone: 'warn' },
}

/** Usage fetch errors (`http_<n>` included). */
export function usageErrorLabel(code: string): string {
  const http = /^http_(\d{3})$/.exec(code)
  if (http) {
    const status = http[1] as string
    if (status === '401' || status === '403') return `HTTP ${status}：令牌无效或权限不足`
    return `HTTP ${status}`
  }
  return lookup(
    {
      graphql_error: 'GraphQL 返回错误',
      network_error: '网络错误',
      timeout: '请求超时',
      invalid_response: '响应格式无效',
      not_configured: '未配置令牌',
    },
    code,
  )
}

/** The drift panel's status line (配置漂移). */
export const DRIFT_STATUS: Readonly<Record<DriftState, { label: string; level: Level }>> = {
  ok: { label: '与代码一致', level: 'ok' },
  drift: { label: '与代码不一致', level: 'warning' },
  never_checked: { label: '尚未检查', level: 'unknown' },
  not_configured: { label: '未配置令牌', level: 'warning' },
  failing: { label: '检查失败', level: 'critical' },
}

export const DRIFT_CATEGORY: Readonly<Record<DriftCategory, string>> = {
  scripts: 'Worker',
  custom_domains: '自定义域名',
  routes: '区域路由',
  crons: '定时触发',
  bindings: '绑定与密钥',
  workers_dev: 'workers.dev / 预览',
  personal: '个人值未设为密钥',
}

/** What differs, in words: names and types only, never a value. */
export function driftFindingText(finding: Pick<DriftFinding, 'category' | 'kind' | 'expected' | 'actual'>): string {
  if (finding.category === 'personal') return `应为密钥（secret_text），线上为 ${finding.actual ?? '?'}`
  if (finding.kind === 'missing') return finding.expected ? `代码中有（${finding.expected}），线上没有` : '代码中有，线上没有'
  if (finding.kind === 'extra') return finding.actual ? `线上有（${finding.actual}），代码中没有` : '线上有，代码中没有'
  return `代码为 ${finding.expected ?? '?'}，线上为 ${finding.actual ?? '?'}`
}

/** Drift check failures: the usage codes plus the drift-only ones. */
const DRIFT_ERRORS: Readonly<Record<string, string>> = {
  api_error: 'API 返回失败',
  incomplete: '当天未完成',
  bad_account: '账户 ID 无效',
  too_large: '线上名称超过存储上限',
}

export function driftErrorLabel(code: string): string {
  return Object.hasOwn(DRIFT_ERRORS, code) ? lookup(DRIFT_ERRORS, code) : usageErrorLabel(code)
}

export const APP_ERRORS: Readonly<Record<AppErrorCode, string>> = {
  unavailable: '不可用',
  busy: '繁忙',
  invalid_input: '输入被拒绝',
  timeout: '超时',
  invalid_output: '返回格式无效',
  not_configured: '未配置',
}

export function appErrorLabel(code: string): string {
  return lookup(APP_ERRORS, code)
}

const MODES: Readonly<Record<string, { label: string; normal: boolean }>> = {
  maintenance: { label: '维护模式', normal: false },
  force_send_paused: { label: '强制暂停投递', normal: false },
  send_paused: { label: '暂停投递', normal: false },
  forwarding: { label: '转发', normal: true },
  backup_active: { label: '备份进行中', normal: false },
  processing_paused: { label: '暂停处理', normal: false },
  deployment_paused: { label: 'Newsletter 发布已排空或冻结', normal: false },
  force_pause_todoist: { label: '强制暂停 Todoist', normal: false },
  reminder_enabled: { label: '每日提醒', normal: true },
  ingest_paused: { label: '暂停抓取', normal: false },
  // the watch app: its reminders go to Todofy (the TODOFY binding)
  notifications: { label: '通知 Todofy', normal: true },
}

/** A mode's label and whether its current value is the usual one. */
export function modeInfo(name: string, value: boolean): { label: string; usual: boolean } {
  const known = Object.hasOwn(MODES, name) ? MODES[name] : undefined
  return { label: known ? known.label : name, usual: known ? known.normal === value : !value }
}

type CounterKind = 'count' | 'seconds' | 'bytes' | 'tokens' | 'days' | 'percent'
const COUNTERS: Readonly<Record<string, { label: string; kind: CounterKind }>> = {
  // Fleet and Newsletter
  heartbeat_age_seconds: { label: '距主机报告', kind: 'seconds' },
  disk_used_percent: { label: '磁盘使用率', kind: 'percent' },
  memory_used_percent: { label: '内存使用率', kind: 'percent' },
  queued_count: { label: '排队', kind: 'count' },
  inflight_count: { label: '进行中', kind: 'count' },
  unknown_count: { label: '未确认完成记录', kind: 'count' },
  // Mail Hero
  jobs_pending: { label: '待处理任务', kind: 'count' },
  jobs_failed: { label: '失败任务', kind: 'count' },
  parse_failed: { label: '解析失败', kind: 'count' },
  delivery_failed: { label: '投递失败', kind: 'count' },
  policy_error: { label: '策略错误', kind: 'count' },
  blocked_waiting: { label: '阻断等待', kind: 'count' },
  paused_waiting: { label: '暂停等待', kind: 'count' },
  oldest_pending_age_seconds: { label: '最久待处理', kind: 'seconds' },
  capacity_used_bytes: { label: '已用容量', kind: 'bytes' },
  capacity_limit_bytes: { label: '容量上限', kind: 'bytes' },
  logical_bytes: { label: '逻辑数据量', kind: 'bytes' },
  ingest_today_messages: { label: '今日收件', kind: 'count' },
  ingest_today_bytes: { label: '今日收件大小', kind: 'bytes' },
  ingest_limit_messages: { label: '每日收件上限', kind: 'count' },
  ingest_limit_bytes: { label: '每日收件大小上限', kind: 'bytes' },
  // Todofy
  active_events: { label: '处理中事件', kind: 'count' },
  attention_events: { label: '需处理事件', kind: 'count' },
  received_24h: { label: '24 小时收到', kind: 'count' },
  oldest_due_age_seconds: { label: '最久到期', kind: 'seconds' },
  gemini_used_tokens: { label: 'Gemini 已用 token', kind: 'tokens' },
  gemini_reserved_tokens: { label: 'Gemini 预留 token', kind: 'tokens' },
  gemini_token_budget: { label: 'Gemini token 预算', kind: 'tokens' },
  gemini_calls: { label: 'Gemini 调用', kind: 'count' },
  todoist_window_calls: { label: 'Todoist 窗口内调用', kind: 'count' },
  todoist_window_limit: { label: 'Todoist 窗口上限', kind: 'count' },
  backup_age_seconds: { label: '距上次备份', kind: 'seconds' },
  // Todofy's GTD ledger (daily Todoist snapshot, counts only)
  inbox_open: { label: '收件箱开放', kind: 'count' },
  inbox_oldest_days: { label: '收件箱最老', kind: 'days' },
  overdue: { label: '逾期', kind: 'count' },
  carryover_open: { label: '多日未完成邮件任务', kind: 'count' },
  completed_7d: { label: '近 7 天完成', kind: 'count' },
  review_age_days: { label: '距上次回顾', kind: 'days' },
  // Todofy's task-intent-v1 intake (proposals from Lab)
  intents_pending: { label: '待创建的任务提议', kind: 'count' },
  intents_failed_7d: { label: '近 7 天失败的任务提议', kind: 'count' },
  // Lab
  ingested_24h: { label: '24 小时抓取', kind: 'count' },
  ranked_24h: { label: '24 小时排序', kind: 'count' },
  liked_7d: { label: '近 7 天喜欢', kind: 'count' },
  decided_7d: { label: '近 7 天已划', kind: 'count' },
  neurons_today: { label: '今日 AI neurons', kind: 'count' },
  neuron_cap: { label: '每日 AI neurons 上限', kind: 'count' },
  // the watch app
  watches_active: { label: '正常监视', kind: 'count' },
  watches_paused: { label: '已暂停监视', kind: 'count' },
  watches_broken: { label: '失效监视', kind: 'count' },
  watches_failing: { label: '检查失败的监视', kind: 'count' },
  changes_new: { label: '新变化', kind: 'count' },
  fetches_today: { label: '今日抓取', kind: 'count' },
  notifications_pending: { label: '待发提醒', kind: 'count' },
  intents_open: { label: '未完成的任务提议', kind: 'count' },
  intents_sent_today: { label: '今日交给 Todofy', kind: 'count' },
}

export function counterInfo(name: string): { label: string; kind: CounterKind } {
  return Object.hasOwn(COUNTERS, name) ? (COUNTERS[name] as { label: string; kind: CounterKind }) : { label: name, kind: 'count' }
}

/** A counter value in its kind: bytes binary, seconds as a duration, the rest as numbers. */
export function counterValue(name: string, value: number): string {
  const { kind } = counterInfo(name)
  if (kind === 'bytes') return formatBytesBinary(value)
  if (kind === 'seconds') return value === 0 ? '无' : formatDuration(value * 1000)
  if (kind === 'days') return `${formatNumber(value)} 天`
  if (kind === 'percent') return `${formatNumber(value)}%`
  return formatNumber(value)
}

/** The short form a tile or stage shows for one counter ("今日收件 37", "24 小时 41 封"). */
export function counterShort(name: string, value: number): string {
  if (name === 'ingest_today_messages') return `今日 ${formatNumber(value)} 封`
  if (name === 'received_24h') return `24 小时 ${formatNumber(value)} 封`
  return `${counterInfo(name).label} ${counterValue(name, value)}`
}

const GUARD_REASONS: Readonly<Record<string, string>> = {
  owner_shed: '手动降载',
  owner_clear: '手动解除',
  quota_normal: '配额正常',
  usage_unknown: '无最新用量，不会自动降载',
}

/** `quota_<resource id>` → "配额：<resource>"; unknown reasons stay raw. */
export function guardReasonLabel(reason: string): string {
  if (Object.hasOwn(GUARD_REASONS, reason)) return GUARD_REASONS[reason] as string
  const quota = /^quota_(.+)$/.exec(reason)
  if (quota && isQuotaId(quota[1] as string)) return `配额：${QUOTA[quota[1] as QuotaResource]}`
  return reason
}

export function deferredJobLabel(job: string): string {
  return lookup(
    {
      raw_reconcile: '原件对账',
      lifecycle_retention: '保留期清理',
      canary_cleanup: '金丝雀清理',
      alert_history_purge: '告警历史清理',
      weekly_backup: '每周备份',
      retention: '过期数据清理',
      metrics_rollup: '指标汇总',
      gtd_snapshot: 'GTD 每日快照',
      feed_fetch: 'arXiv 抓取',
      embed: '向量化',
      rank: '排序',
      brief: '中文简介',
      seed_resolve: '种子论文解析',
      scheduled_checks: '定时检查',
      daily_sweep: '每日整理',
    },
    job,
  )
}

export const CANARY_OUTCOME: Readonly<Record<CanaryOutcome, { label: string; tone: Tone }>> = {
  ok: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '已跳过', tone: 'warn' },
}

export const CANARY_PHASE: Readonly<Record<CanaryPhase, string>> = {
  starting: '启动中',
  delivering: '投递中',
  consuming: '等待 Todofy',
  done: '已结束',
}

export const CANARY_STAGE: Readonly<Record<CanaryStage, string>> = {
  start: '启动',
  delivery: '投递',
  consumer: 'Todofy 处理',
}

export const CANARY_KIND: Readonly<Record<CanaryKind, string>> = { scheduled: '定时', manual: '手动' }

/** Canary failure, skip and waiting codes from both apps and the dashboard. */
export function canaryCodeLabel(code: string): string {
  const http = /^http_(\d{3})$/.exec(code)
  if (http) return `HTTP ${http[1] as string}`
  return lookup(
    {
      timeout: '超过 2 小时未完成',
      not_seen: 'Todofy 未收到',
      unknown_event: 'Mail Hero 找不到该事件',
      unreachable: '应用无法连接',
      unavailable: '应用不可用',
      busy: '应用繁忙',
      invalid_input: '请求被拒绝',
      invalid_output: '返回格式无效',
      status_unavailable: '没有可用的应用状态',
      canary_producer_missing: 'Mail Hero 未提供金丝雀功能',
      canary_consumer_missing: 'Todofy 未提供金丝雀功能',
      canary_disabled: '金丝雀已关闭，未再尝试启动',
      send_paused: '投递已强制暂停',
      settings_paused: '投递已在设置中暂停',
      endpoint_paused: '投递目标已暂停',
      endpoint_blocked: '投递目标已阻断',
      paused: '投递已暂停',
      maintenance: '维护模式',
      backup_active: '备份进行中',
      no_endpoint: '没有投递目标',
      capacity: '容量不足',
      processing_paused: 'Todofy 处理已暂停',
      retry_wait: '等待重试',
      network_error: '网络错误',
      retry_window_expired: '重试窗口已过',
      canary_cancelled: '投递已取消',
      canary_side_effect_blocked: 'Todofy 阻止了副作用',
      llm_quota: 'Gemini 配额不足',
      llm_budget_exhausted: 'Gemini 预算已用完',
    },
    code,
  )
}

/** Shown on the canary button, in the canary section and as the 409 answer's fallback message. */
export const CANARY_DISABLED_TEXT = '金丝雀已关闭（DASHBOARD_CANARY_ENABLED=false）'

export const API_ERRORS: Readonly<Record<ApiErrorCode, string>> = {
  unauthorized: '登录已过期，请刷新页面',
  access_not_configured: '访问控制未配置',
  not_configured: '页面安全密钥未配置',
  csrf_failed: '页面安全校验失败，请刷新页面后重试',
  bad_request: '请求格式无效',
  not_found: '接口不存在',
  method_not_allowed: '请求方法不允许',
  canary_active: '已有金丝雀正在运行',
  canary_disabled: CANARY_DISABLED_TEXT,
  canary_limit: '今天的手动运行次数已用完',
  attention_changed: '这项提醒已发生变化，请刷新后重新查看',
  unavailable: '服务暂时不可用',
  internal: '服务出错了，请稍后刷新页面',
}
