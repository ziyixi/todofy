import type {
  DailyMetrics,
  DailyMetricsDay,
  EventDetail,
  EventSummary,
  Overview,
  RecommendationReport,
  Reminder,
  Setup,
  SummaryReport,
} from '../api/types'

// Synthetic IDs only; never real mail.
export const EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710001'
export const OTHER_EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710002'

export function overview(patch: Partial<Overview> = {}): Overview {
  return {
    build: '0123456789abcdef0123456789abcdef01234567',
    now: '2026-09-28T12:00:00Z',
    flags: { maintenance_mode: false, processing_paused: false, force_pause_todoist: false, reminder_enabled: true },
    counts: { pending: 1, summarizing: 0, summarized: 0, todo_sending: 0, todo_unknown: 1, todo_created: 0, failed_summary: 0 },
    attention_count: 2,
    received_24h: 42,
    latest_reminder: null,
    next_alarm_at: '2026-09-28T12:00:01Z',
    oldest_due_at: '2026-09-28T11:59:00Z',
    gemini: {
      day: '2026-09-28',
      token_budget: 3_000_000,
      reserved_tokens: 4096,
      used_tokens: 181_233,
      calls: 41,
      models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'],
    },
    todoist: { blocked_until: null, window_seconds: 900, window_calls: 3, window_limit: 1000 },
    ...patch,
  }
}

export function eventSummary(patch: Partial<EventSummary> = {}): EventSummary {
  return {
    event_id: EVENT_ID,
    state: 'todo_unknown',
    error_code: 'todo_result_unknown',
    attempt_count: 1,
    task_id: null,
    received_at: '2026-09-28T08:00:00Z',
    updated_at: '2026-09-28T08:02:10Z',
    next_attempt_at: null,
    attention: true,
    imported: false,
    ...patch,
  }
}

export function eventDetail(patch: Partial<EventDetail> = {}): EventDetail {
  return {
    ...eventSummary(),
    version: 5,
    crashes: 0,
    subject: 'Quarterly tax reminder',
    from: 'billing@example.com',
    summary: '季度预缴税截止日期为 10 月 15 日。',
    summary_model: 'gemini-3.8-flash',
    todo_body: `**FROM: billing@example.com**\n...\n\nMail Hero event: ${EVENT_ID}`,
    todoist_request_id: 'todofy-0123456789abcdef0123456789ab',
    allowed_actions: ['task_created', 'task_not_created', 'dismiss'],
    transitions: [
      { at: '2026-09-28T08:00:00Z', from_state: null, to_state: 'pending', error_code: null, actor: 'worker' },
      { at: '2026-09-28T08:00:20Z', from_state: 'summarized', to_state: 'todo_unknown', error_code: 'todo_result_unknown', actor: 'worker' },
    ],
    has_legacy_text: false,
    ...patch,
  }
}

export function reminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    day: '2026-09-27',
    state: 'created',
    task_id: '6X7rM8997g3RQmvh',
    attention_count: 2,
    attempts: 1,
    error_code: null,
    next_attempt_at: null,
    created_at: '2026-09-27T09:00:00Z',
    updated_at: '2026-09-27T09:00:02Z',
    imported: false,
    ...patch,
  }
}

const WINDOW = { computed_at: '2026-09-28T13:30:00Z', window_start: '2026-09-27T13:30:00Z', window_end: '2026-09-28T13:30:00Z' }

export function summaryReport(patch: Partial<SummaryReport> = {}): SummaryReport {
  return { summary: '今天有 3 封账单提醒。', task_count: 3, time_window_hours: 24, status: 'ok', model: 'gemini-3.8-flash', ...WINDOW, ...patch }
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
  }
}

export function setup(patch: Partial<Setup> = {}): Setup {
  return {
    build: '0123456789abcdef0123456789abcdef01234567',
    public_host: 'todofy.example.test',
    hooks_hosts: ['todofy-hooks.example.test'],
    webhook_path: '/hooks/mail',
    mail_source_id: 'synthetic-source',
    access_owner: 'owner@example.com',
    configured: { mail_webhook_token: true, report_basic_auth: true, gemini_api_key: true, todoist_api_key: false, todoist_project: true },
    ...patch,
  }
}

export function metricsDay(day: string, patch: Partial<DailyMetricsDay> = {}): DailyMetricsDay {
  return {
    day,
    recorded: true,
    mails_received: 64,
    mails_completed: 61,
    mails_failed: 1,
    latency_p50_seconds: 18,
    latency_p90_seconds: 95,
    gemini_calls: 66,
    gemini_tokens: { 'gemini-3.8-flash': 402_113, 'gemini-3.7-flash': 8120 },
    todoist_creates: 62,
    todoist_lookups: 1,
    ...patch,
  }
}

const NOT_RECORDED = {
  recorded: false,
  mails_received: 0,
  mails_completed: 0,
  mails_failed: 0,
  latency_p50_seconds: null,
  latency_p90_seconds: null,
  gemini_calls: 0,
  gemini_tokens: {},
  todoist_creates: 0,
  todoist_lookups: 0,
}

/** 30 days ending 2026-09-27: the first 27 not recorded, then three recorded days. */
export function dailyMetrics(): DailyMetrics {
  const days = Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 7, 29 + index)).toISOString().slice(0, 10))
  return {
    days: days.map((day, index) =>
      index < 27 ? metricsDay(day, NOT_RECORDED) : metricsDay(day, index === 29 ? { mails_received: 70, latency_p90_seconds: 240 } : {}),
    ),
  }
}
