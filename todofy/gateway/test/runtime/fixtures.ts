/**
 * The largest answers TodofyCore can give the owner API, as wire JSON (todofy.ui.v1), for the CPU test. Every size is
 * the bound of the code that writes it: a full page of events (100), an event's 100 transitions with a summary of
 * MAX_SUMMARY_BYTES (64 KiB) and a 16,000-character Todoist description, an imported legacy text of 1.9 MB (ASCII
 * mail with quotes, backslashes and line breaks: three times the JS characters of Chinese text in the same bytes,
 * and the most escapes to read and write, so the gateway's costliest answer), 90
 * metric days with three models, 120 GTD days, and the reports at their schemas' limits (a 12,000-character summary,
 * the recommendation of every top_n from 1 to 10 with 200-character titles and 4,000-character reasons). Text is
 * Chinese (three UTF-8 bytes a character) where the real text usually is. All of it is synthetic.
 */
const UUID = (n: number): string => `0b8f5a4e-3c1d-4c52-9f0e-${n.toString(16).padStart(12, '0')}`;
const AT = '2026-09-28T08:00:00Z';
/** `count` characters of Chinese text with some ASCII and line breaks, like a summary. */
function text(count: number, seed = 0): string {
  const words = ['季度预缴税截止日期', '请在本周内', '确认会议安排', 'Mail Hero', '已同步', '提醒：', '\n'];
  let out = '';
  for (let i = seed; out.length < count; i++) out += words[i % words.length] ?? '';
  return out.slice(0, count);
}

export function eventSummary(n: number): Record<string, unknown> {
  return {
    name: `mailEvents/${UUID(n)}`,
    state: n % 3 === 0 ? 'todo_unknown' : 'complete',
    error_code: n % 3 === 0 ? 'lookup_not_found' : undefined,
    // At least one: the wire profile omits a 0, as TodofyCore writes it.
    attempt_count: (n % 4) + 1,
    task_id: n % 3 === 0 ? undefined : `6X7rM8997g3RQ${String(n).padStart(3, '0')}`,
    receive_time: AT,
    update_time: AT,
    attention: n % 3 === 0,
  };
}

export function eventPage(size: number): Record<string, unknown> {
  return { mail_events: Array.from({ length: size }, (_, n) => eventSummary(n)) };
}

export function eventDetail(): Record<string, unknown> {
  return {
    ...eventSummary(0),
    version: 101,
    etag: '101',
    crash_count: 2,
    subject: text(200),
    sender: 'billing@example.com',
    summary: text(Math.floor((64 * 1024) / 3)),
    summary_model: 'gemini-3.8-flash',
    todo_body: text(16_000, 3),
    todoist_request_id: 'todofy-0123456789abcdef0123456789ab',
    allowed_actions: ['task_created', 'task_not_created', 'dismiss'],
    transitions: Array.from({ length: 100 }, (_, n) => ({
      transition_time: AT,
      prior_state: n === 0 ? undefined : 'summarized',
      state: 'todo_unknown',
      error_code: 'todo_result_unknown',
      actor: n % 2 === 0 ? 'worker' : 'owner',
    })),
    legacy_text: `legacyTexts/${UUID(0)}`,
  };
}

/** About 1.9 MB of ASCII mail text in HTML, heavy in what JSON escapes: quotes, backslashes, \r\n and tabs. */
const ASCII_MAIL = 'Dear customer, your "invoice" C:\\path is due.\r\n\t> quoted line <a href=\'x\'>link</a>\n';

/** The largest legacy text D1 holds (a row is at most 2,000,000 bytes), in the form costliest for the gateway. */
export function legacyText(): Record<string, unknown> {
  return { name: `legacyTexts/${UUID(0)}`, create_time: AT, text: ASCII_MAIL.repeat(Math.ceil(1_900_000 / ASCII_MAIL.length)).slice(0, 1_900_000) };
}

export function metricDays(count: number): Record<string, unknown> {
  return {
    metric_days: Array.from({ length: count }, (_, n) => ({
      name: `metricDays/2026-${String(9 - Math.floor(n / 28)).padStart(2, '0')}-${String(28 - (n % 28)).padStart(2, '0')}`,
      recorded: true,
      received_count: 64,
      completed_count: 61,
      failed_count: 1,
      latency_p50_seconds: 18,
      latency_p90_seconds: 95,
      gemini_call_count: 66,
      gemini_tokens: { 'gemini-3.5-flash-lite': 1200, 'gemini-3.7-flash': 8120, 'gemini-3.8-flash': 402113 },
      todoist_create_count: 62,
      todoist_lookup_count: 1,
    })),
  };
}

function scope(full: boolean): Record<string, unknown> {
  return {
    open_count: 412,
    fresh_count: 40,
    recent_count: 31,
    stale_count: 60,
    old_count: 281,
    oldest_age_days: 900,
    overdue_count: 12,
    undated_count: 300,
    created_last_week_count: 44,
    completed_last_week_count: 51,
    completed_source: 'api',
    ...(full ? { closed_last_day_count: 7, open_mail_count: 30 } : {}),
    complete: true,
  };
}

export function gtdDays(count: number): Record<string, unknown> {
  return {
    gtd_days: Array.from({ length: count }, (_, n) => ({
      name: `gtdDays/2026-${String(9 - Math.floor(n / 28)).padStart(2, '0')}-${String(28 - (n % 28)).padStart(2, '0')}`,
      recorded: true,
      all_projects: scope(true),
      inbox: scope(false),
    })),
  };
}

const WINDOW = { computed_at: AT, window_start: '2026-09-27T08:00:00Z', window_end: AT };

export function latestReports(): Record<string, unknown> {
  return {
    name: 'latestReports',
    summary: { summary: text(12_000), task_count: 64, time_window_hours: 24, status: 'ok', model: 'gemini-3.8-flash', ...WINDOW },
    recommendations: Array.from({ length: 10 }, (_, i) => ({
      tasks: Array.from({ length: i + 1 }, (_, rank) => ({ rank: rank + 1, title: text(200, rank), reason: text(4000, rank + 1) })),
      model: 'gemini-3.8-flash',
      task_count: 64,
      status: 'ok',
      top_n: i + 1,
      ...WINDOW,
      new_count: 50,
      carryover_count: 14,
    })),
  };
}

export function serviceStatus(): Record<string, unknown> {
  return {
    name: 'serviceStatus',
    build: 'test',
    read_time: AT,
    switches: { reminder_enabled: true },
    active_counts: { pending_count: 1, todo_unknown_count: 1 },
    attention_count: 1,
    received_last_day_count: 42,
    latest_reminder: { name: 'dailyReminders/2026-09-28', state: 'created', task_id: '123', attention_count: 2, attempt_count: 1, create_time: AT, update_time: AT },
    next_alarm_time: AT,
    oldest_due_time: AT,
    gemini: { day: '2026-09-28', token_budget: 3_000_000, reserved_tokens: 4096, used_tokens: 181_233, call_count: 41, models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'] },
    todoist: { window_seconds: 900, window_call_count: 3, window_call_limit: 1000 },
    backup: { state: 'ok', last_backup_time: AT, last_backup_key: 'backups/2026-09-27T100002Z/', last_backup_size_bytes: 1_843_200, last_backup_row_count: 52_311, next_backup_time: AT },
  };
}

export function reminderPage(size: number): Record<string, unknown> {
  return {
    daily_reminders: Array.from({ length: size }, (_, n) => ({
      name: `dailyReminders/2026-${String(9 - Math.floor(n / 28)).padStart(2, '0')}-${String(28 - (n % 28)).padStart(2, '0')}`,
      state: 'created',
      task_id: `98765${String(n)}`,
      attention_count: n % 5,
      attempt_count: 1,
      create_time: AT,
      update_time: AT,
    })),
  };
}

/** TodofyCore's answer of a message: `{ok, next_cursor}`, the message as wire JSON text. */
export function ok(message: unknown, nextCursor: unknown = null): Record<string, unknown> {
  return { ok: JSON.stringify(message), next_cursor: nextCursor === null ? null : JSON.stringify(nextCursor) };
}

export { UUID };
