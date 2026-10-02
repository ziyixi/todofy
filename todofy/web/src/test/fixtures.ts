/**
 * Synthetic answers of the owner API (todofy.ui.v1) as the gateway writes them: wire JSON, typed by the IDL's
 * generated wire types (proto/tools/gen_wire_ts.py), so a fixture the IDL would not answer fails the typecheck.
 * Synthetic IDs only; never real mail.
 */
import type { DescMessage, MessageShape } from '@ziyixi/proto/protobuf'
import type { RecommendationReport, SummaryReport } from '@ziyixi/proto/todofy/report/v1/report_wire'
import type { GtdDay, GtdReview, GtdScope, MetricDay } from '@ziyixi/proto/todofy/ui/v1/history_wire'
import type { MailEvent } from '@ziyixi/proto/todofy/ui/v1/mail_event_wire'
import type { BackupStatus, DailyReminder, Integration, ServiceStatus } from '@ziyixi/proto/todofy/ui/v1/status_wire'
import type { ListMetricDaysResponse } from '@ziyixi/proto/todofy/ui/v1/todofy_ui_service_wire'
import { fromWire } from '@ziyixi/proto/wire-json'

export const EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001'
export const OTHER_EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710002'

/** A fixture as the generated message the client hands the pages (read leniently, as the client reads it). */
export function message<Desc extends DescMessage>(schema: Desc, wire: object): MessageShape<Desc> {
  return fromWire(schema, wire).message
}

export function overview(patch: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: 'serviceStatus',
    build: '0123456789abcdef0123456789abcdef01234567',
    read_time: '2026-09-28T12:00:00Z',
    switches: { reminder_enabled: true },
    active_counts: { pending_count: 1, todo_unknown_count: 1 },
    attention_count: 2,
    received_last_day_count: 42,
    next_alarm_time: '2026-09-28T12:00:01Z',
    oldest_due_time: '2026-09-28T11:59:00Z',
    gemini: {
      day: '2026-09-28',
      token_budget: 3_000_000,
      reserved_tokens: 4096,
      used_tokens: 181_233,
      call_count: 41,
      models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'],
    },
    todoist: { window_seconds: 900, window_call_count: 3, window_call_limit: 1000 },
    ...patch,
  }
}

export function backup(patch: Partial<BackupStatus> = {}): BackupStatus {
  return {
    state: 'ok',
    last_backup_time: '2026-09-27T10:00:41Z',
    last_backup_key: 'backups/2026-09-27T100002Z/',
    last_backup_size_bytes: 1_843_200,
    last_backup_row_count: 52_311,
    next_backup_time: '2026-10-04T10:00:00Z',
    ...patch,
  }
}

/** A list row of ListMailEvents (only the list fields). */
export function eventSummary(patch: Partial<MailEvent> = {}): MailEvent {
  return {
    name: `mailEvents/${EVENT_ID}`,
    state: 'todo_unknown',
    error_code: 'todo_result_unknown',
    attempt_count: 1,
    receive_time: '2026-09-28T08:00:00Z',
    update_time: '2026-09-28T08:02:10Z',
    attention: true,
    ...patch,
  }
}

/** GetMailEvent's answer. */
export function eventDetail(patch: Partial<MailEvent> = {}): MailEvent {
  return {
    ...eventSummary(),
    version: 5,
    etag: '5',
    subject: 'Quarterly tax reminder',
    sender: 'billing@example.com',
    summary: '季度预缴税截止日期为 10 月 15 日。',
    summary_model: 'gemini-3.8-flash',
    todo_body: `**FROM: billing@example.com**\n...\n\nMail Hero event: ${EVENT_ID}`,
    todoist_request_id: 'todofy-0123456789abcdef0123456789ab',
    allowed_actions: ['task_created', 'task_not_created', 'dismiss'],
    transitions: [
      { transition_time: '2026-09-28T08:00:00Z', state: 'pending', actor: 'worker' },
      {
        transition_time: '2026-09-28T08:00:20Z',
        prior_state: 'summarized',
        state: 'todo_unknown',
        error_code: 'todo_result_unknown',
        actor: 'worker',
      },
    ],
    ...patch,
  }
}

export function reminder(patch: Partial<DailyReminder> = {}): DailyReminder {
  return {
    name: 'dailyReminders/2026-09-27',
    state: 'created',
    task_id: '6X7rM8997g3RQmvh',
    attention_count: 2,
    attempt_count: 1,
    create_time: '2026-09-27T09:00:00Z',
    update_time: '2026-09-27T09:00:02Z',
    ...patch,
  }
}

const WINDOW = { computed_at: '2026-09-28T13:30:00Z', window_start: '2026-09-27T13:30:00Z', window_end: '2026-09-28T13:30:00Z' }

// A report is a union by status (each status bounds what it holds): a patch may switch the branch, so the result is
// asserted rather than inferred.
export function summaryReport(patch: Partial<SummaryReport> = {}): SummaryReport {
  return { summary: '今天有 3 封账单提醒。', task_count: 3, time_window_hours: 24, status: 'ok', model: 'gemini-3.8-flash', ...WINDOW, ...patch } as SummaryReport
}

export function recommendationReport(patch: Partial<RecommendationReport> = {}): RecommendationReport {
  return {
    tasks: [
      { rank: 1, title: '缴纳季度税', reason: '10 月 15 日截止' },
      { rank: 2, title: '续订域名', reason: '下周到期' },
    ],
    model: 'gemini-3.8-flash',
    task_count: 3,
    status: 'ok',
    top_n: 10,
    ...WINDOW,
    ...patch,
  } as RecommendationReport
}

export function setup(patch: Partial<Integration> = {}): Integration {
  return {
    name: 'integration',
    build: '0123456789abcdef0123456789abcdef01234567',
    public_host: 'todofy.example.test',
    hooks_hosts: ['todofy-hooks.example.test'],
    webhook_path: '/hooks/mail',
    mail_source_id: 'synthetic-source',
    access_owner: 'owner@example.com',
    configured: { mail_webhook_token: true, report_basic_auth: true, gemini_api_key: true, todoist_project: true },
    ...patch,
  }
}

export function metricsDay(day: string, patch: Partial<MetricDay> = {}): MetricDay {
  return {
    name: `metricDays/${day}`,
    recorded: true,
    received_count: 64,
    completed_count: 61,
    failed_count: 1,
    latency_p50_seconds: 18,
    latency_p90_seconds: 95,
    gemini_call_count: 66,
    gemini_tokens: { 'gemini-3.7-flash': 8120, 'gemini-3.8-flash': 402_113 },
    todoist_create_count: 62,
    todoist_lookup_count: 1,
    ...patch,
  }
}

/** A day TodofyCore did not count: every counter is 0, which the wire omits. */
function notRecorded(day: string): MetricDay {
  return { name: `metricDays/${day}` }
}

/** ListMetricDays: 30 days ending 2026-09-27, newest first: three recorded days, then 27 not recorded. */
export function dailyMetrics(): ListMetricDaysResponse {
  const days = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 7, 29 + index)).toISOString().slice(0, 10))
  const oldestFirst = days.map((day, index) =>
    index < 27 ? notRecorded(day) : metricsDay(day, index === 29 ? { received_count: 70, latency_p90_seconds: 240 } : {}),
  )
  return { metric_days: oldestFirst.toReversed(), next_page_token: 'older' }
}

export function gtdScope(patch: Partial<GtdScope> = {}): GtdScope {
  return {
    open_count: 9,
    fresh_count: 2,
    recent_count: 3,
    stale_count: 1,
    old_count: 3,
    oldest_age_days: 40,
    overdue_count: 1,
    undated_count: 5,
    created_last_week_count: 6,
    completed_last_week_count: 4,
    completed_source: 'api',
    closed_last_day_count: 2,
    open_mail_count: 3,
    complete: true,
    ...patch,
  }
}

export function gtdDay(day: string, patch: Partial<GtdDay> = {}): GtdDay {
  return { name: `gtdDays/${day}`, recorded: true, all_projects: gtdScope(), inbox: gtdScope({ open_count: 4 }), ...patch }
}

export function gtdReview(patch: Partial<GtdReview> = {}): GtdReview {
  return { name: 'gtdReviews/2026-W39', state: 'created', create_time: '2026-09-27T17:00:00Z', ...patch }
}
