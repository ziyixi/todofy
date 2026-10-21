/**
 * The unified ops digest (docs/design.md §5.5): pure functions building the items (codes, severities, times and
 * numbers only) and the one task a UTC day Home creates with them in Tasks, through Tasks' create-only TaskInbox.
 */
import type { OpsReportItem } from '@ziyixi/proto/ops/v1/ops_wire';
import type { CreateInboxTaskRequest } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { DIGEST_TASK_ATTEMPTS, GUARD_SHED_PERCENT, QUOTA_CRITICAL_PERCENT, type AppErrorCode, type CanaryStage, type OpsApp, type OpsSeverity, type OpsStatus, type QuotaRow } from './api-types.ts';
import { DRIFT_UNAVAILABLE_AFTER_DAYS } from './api-types.ts';
import { DRIFT_CATEGORIES } from './idl.ts';
import { CANARY_DISABLED_CODE, type CanaryRecord } from './canary.ts';
import type { DigestDoc } from './docs.ts';
import { totalFindings, type DriftDoc } from './drift.ts';
import { hoursLeft, reachesPercent, type DesiredGuard } from './guard.ts';
import { isOpsCode, isOpsSource, METRICS_MAX_KEYS, OPS_APPS, REPORT_MAX_ITEMS } from './ops-client.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, iso, isTimestamp, utcDay } from './time.ts';

/** A usage fetch failing for this long becomes `usage_unavailable`. */
export const USAGE_UNAVAILABLE_AFTER_MS = 2 * HOUR_MS;
/** App statuses older than this do not contribute signals. */
export const STATUS_SIGNAL_MAX_AGE_MS = HOUR_MS;
/** No completed cron tick for this long (two and a half ticks) is `tick_stale`: guard, canary and digest have stopped. */
export const TICK_STALE_MS = 75 * MINUTE_MS;

/** An item before its `since` is resolved. */
export interface Candidate {
  readonly source: string;
  readonly code: string;
  readonly severity: OpsSeverity;
  readonly metrics: Readonly<Record<string, number>>;
  readonly since?: string;
}

export interface AppHealthInput {
  readonly consecutive_failures: number;
  readonly status: OpsStatus | null;
  readonly status_at: number | null;
}

export interface DigestInput {
  readonly now: number;
  readonly usage: {
    readonly configured: boolean;
    readonly fresh: boolean;
    readonly rows: readonly QuotaRow[];
    readonly fetched_at: number | null;
    readonly consecutive_failures: number;
    readonly last_http_status: number | null;
  };
  readonly desired: DesiredGuard;
  readonly guardFailures: Readonly<Record<OpsApp, number>>;
  /** The run that finished most recently, if any. */
  readonly latestFinished: CanaryRecord | null;
  /** The last completed cron tick (a tick passes its own time). */
  readonly lastTickAt: number | null;
  readonly apps: Readonly<Record<OpsApp, AppHealthInput>>;
  /** The drift check (design-v2.md §10): its last result; absent in tests that predate it. */
  readonly drift?: { readonly configured: boolean; readonly doc: DriftDoc };
  /** The digest's own record (its day's task); absent in tests that predate it. */
  readonly digest?: DigestDoc;
}

/** Numbers only, named by codes, at most 12 keys. */
export function cleanMetrics(metrics: Readonly<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(metrics)) {
    if (count >= METRICS_MAX_KEYS) break;
    if (!isOpsCode(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = value;
    count++;
  }
  return out;
}

const CANARY_CODES: Readonly<Record<CanaryStage, string>> = {
  start: 'canary_start_failed',
  delivery: 'canary_not_delivered',
  consumer: 'canary_consumer_failed',
};

/** The `tick_stale` item when no tick completed within TICK_STALE_MS (or none ever did), else null. */
export function tickStale(lastTickAt: number | null, now: number): Candidate | null {
  if (lastTickAt !== null && now - lastTickAt <= TICK_STALE_MS) return null;
  return {
    source: 'dashboard',
    code: 'tick_stale',
    severity: 'warning',
    metrics: lastTickAt === null ? {} : { minutes_since: Math.floor((now - lastTickAt) / MINUTE_MS) },
    ...(lastTickAt === null ? {} : { since: iso(lastTickAt) }),
  };
}

/**
 * Stored items as of `now`: `tick_stale` is added when the ticks stopped since the items were built,
 * and dropped when a tick ran since (the overview is served from the stored snapshot).
 */
export function withTickState(items: readonly OpsReportItem[], lastTickAt: number | null, now: number): OpsReportItem[] {
  const rest = items.filter((item) => !(item.source === 'dashboard' && item.code === 'tick_stale'));
  const stale = tickStale(lastTickAt, now);
  if (stale === null) return rest;
  const item: OpsReportItem = { source: stale.source, code: stale.code, severity: stale.severity, since: stale.since ?? iso(now), metrics: cleanMetrics(stale.metrics) };
  return [...rest.filter((i) => i.severity === 'critical'), item, ...rest.filter((i) => i.severity !== 'critical')];
}

/** Every warning or critical condition of this tick (§5.5 table). */
export function candidates(input: DigestInput): Candidate[] {
  const { now, usage } = input;
  const out: Candidate[] = [];

  if (!usage.configured) {
    out.push({ source: 'dashboard', code: 'usage_not_configured', severity: 'warning', metrics: {} });
  } else if (usage.consecutive_failures > 0 && (usage.fetched_at === null || now - usage.fetched_at >= USAGE_UNAVAILABLE_AFTER_MS)) {
    out.push({
      source: 'dashboard',
      code: 'usage_unavailable',
      severity: 'warning',
      metrics: { consecutive_failures: usage.consecutive_failures, http_status: usage.last_http_status ?? 0 },
    });
  }
  if (usage.fresh) {
    for (const row of usage.rows) {
      if (row.percent === null || row.used === null || !reachesPercent(row, GUARD_SHED_PERCENT)) continue;
      const metrics: Record<string, number> = { percent: row.percent, used: row.used, limit: row.limit };
      if (row.projected_percent !== null) metrics.projected_percent = row.projected_percent;
      out.push({
        source: 'cloudflare',
        code: `${row.id}_high`,
        severity: reachesPercent(row, QUOTA_CRITICAL_PERCENT) ? 'critical' : 'warning',
        metrics,
      });
    }
  }

  const stale = tickStale(input.lastTickAt, now);
  if (stale !== null) out.push(stale);
  const failed = input.digest === undefined ? null : digestTaskFailed(input.digest, now);
  if (failed !== null) out.push(failed);

  // Configuration drift: counts per category only (the names stay on the Cloudflare view). A known
  // difference is reported like any other until the live account or the committed state changes.
  if (input.drift?.configured === true) {
    const doc = input.drift.doc;
    const total = totalFindings(doc.counts);
    if (doc.checked_at !== null && total > 0) {
      const metrics: Record<string, number> = { total };
      for (const category of DRIFT_CATEGORIES) if (doc.counts[category] > 0) metrics[category] = doc.counts[category];
      out.push({ source: 'dashboard', code: 'config_drift', severity: 'warning', metrics });
    }
    if (doc.consecutive_failed_days >= DRIFT_UNAVAILABLE_AFTER_DAYS) {
      out.push({ source: 'dashboard', code: 'drift_unavailable', severity: 'warning', metrics: { consecutive_failed_days: doc.consecutive_failed_days } });
    }
  }

  if (input.desired.level === 'shed') {
    out.push({
      source: 'dashboard',
      code: 'guard_shed',
      severity: 'warning',
      metrics: { hours_left: hoursLeft(input.desired.until, now), manual: input.desired.source === 'owner' ? 1 : 0 },
    });
  }

  const run = input.latestFinished;
  if (run !== null && run.finished_at !== null) {
    const since = iso(run.finished_at);
    if (run.outcome === 'failed' && run.stage !== null) {
      const metrics: Record<string, number> = { attempts: run.delivery.attempts, timed_out: run.code === 'timeout' ? 1 : 0 };
      if (run.delivery.last_http_status !== null) metrics.last_http_status = run.delivery.last_http_status;
      out.push({ source: 'dashboard', code: CANARY_CODES[run.stage], severity: 'critical', since, metrics });
    } else if (run.outcome === 'skipped' && run.code !== CANARY_DISABLED_CODE) {
      // (A run ended by switching the canary off is the owner's doing, not a condition to report: the
      // page shows the switch as an info item instead.)
      // contracts/ops-v1 README "Daily canary": a skip (paused, unavailable, a missing capability, a held
      // run) is reported with its reason, never as a pipeline failure. The reason is a metric key
      // (numbers only), e.g. {"no_endpoint": 1}.
      out.push({
        source: 'dashboard',
        code: 'canary_skipped',
        severity: 'warning',
        since,
        metrics: run.code !== null && isOpsCode(run.code) ? { [run.code]: 1 } : {},
      });
    }
  }

  for (const app of OPS_APPS) {
    const health = input.apps[app];
    if (input.guardFailures[app] >= 2) {
      out.push({
        source: app,
        code: 'guard_apply_failed',
        severity: 'warning',
        metrics: { consecutive_failures: input.guardFailures[app] },
      });
    }
    if (health.consecutive_failures >= 2) {
      out.push({ source: app, code: 'app_unreachable', severity: 'critical', metrics: { consecutive_failures: health.consecutive_failures } });
    }
    const status = health.status;
    if (status === null || health.status_at === null || now - health.status_at > STATUS_SIGNAL_MAX_AGE_MS) continue;
    if (status.health === 'down' && !(app === 'notion-publish' && status.website_sync?.error_code)) out.push({ source: app, code: 'app_down', severity: 'critical', metrics: {} });
    for (const signal of status.signals) {
      if (signal.severity === 'info' || !isOpsCode(signal.code)) continue;
      out.push({
        source: app,
        code: signal.code,
        severity: signal.severity,
        metrics: signal.metrics,
        ...(isTimestamp(signal.since) ? { since: signal.since } : {}),
      });
    }
  }
  return out;
}

const RANK: Readonly<Record<OpsSeverity, number>> = { critical: 0, warning: 1, info: 2 };

export function itemKey(item: { readonly source: string; readonly code: string }): string {
  return `${item.source}:${item.code}`;
}

/**
 * Warning/critical only, deduplicated by source:code (highest severity wins), critical first then
 * source then code, at most 20. `since` is the app's own when it has one, else `firstSeen` of the key.
 */
export function finalizeItems(list: readonly Candidate[], firstSeen: ReadonlyMap<string, number>, now: number, limit = REPORT_MAX_ITEMS): OpsReportItem[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of list) {
    if (candidate.severity === 'info' || !isOpsSource(candidate.source) || !isOpsCode(candidate.code)) continue;
    const key = itemKey(candidate);
    const existing = byKey.get(key);
    if (existing === undefined || RANK[candidate.severity] < RANK[existing.severity]) byKey.set(key, candidate);
  }
  return [...byKey.values()]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.source.localeCompare(b.source) || a.code.localeCompare(b.code))
    .slice(0, limit)
    .map((c) => ({
      source: c.source,
      code: c.code,
      severity: c.severity,
      since: c.since ?? iso(firstSeen.get(itemKey(c)) ?? now),
      metrics: cleanMetrics(c.metrics),
    }));
}

// ---- the day's task -------------------------------------------------------------------------------------------------

/** The day's task: its items as codes, severities, times and numbers (never an app's text), and a link to Home. */
export function digestTask(items: readonly OpsReportItem[], day: string, dashboardUrl: string | null): { title: string; description: string } {
  const listed = items.slice(0, REPORT_MAX_ITEMS);
  const lines = listed.map((item) => {
    const metrics = Object.entries(item.metrics).map(([name, value]) => `${name}=${String(value)}`);
    return `- ${[item.severity, item.source, item.code, `自 ${item.since}`, ...(metrics.length > 0 ? [metrics.join(', ')] : [])].join(' · ')}`;
  });
  if (items.length > listed.length) lines.push(`- … 另有 ${String(items.length - listed.length)} 项`);
  return {
    title: `运维摘要 ${day}：${String(items.length)} 项需要关注`,
    description: [
      `Home 在 UTC ${day} 第一次有警告或严重项目时创建此任务，每个 UTC 日最多一次：`,
      '',
      ...lines,
      ...(dashboardUrl === null ? [] : ['', `查看 Home：${dashboardUrl}`]),
    ].join('\n'),
  };
}

/**
 * The digest document before this tick's call. A document from before the day's task (no `day`) records today as
 * handled, so the day of the release gets no task next to the one Todofy's reminder made. A later day is claimed at its
 * first tick with items: the request, with a new request ID, is frozen, so every retry sends the same one.
 */
export function claimDay(doc: DigestDoc, items: readonly OpsReportItem[], now: number, dashboardUrl: string | null, requestId: string): DigestDoc {
  const day = utcDay(now);
  if (doc.day === undefined) return { ...doc, day, state: 'skipped', request: null, attempts: 0, task_id: null };
  if (doc.day === day || items.length === 0) return doc;
  const request: CreateInboxTaskRequest = { request_id: requestId, ...digestTask(items, day, dashboardUrl) };
  return { ...doc, day, state: 'pending', request, item_count: items.length, claimed_at: now, attempts: 0, task_id: null };
}

/** The result of one call for the day's task. */
export type TaskCall = { readonly ok: true; readonly taskId: string } | { readonly ok: false; readonly code: AppErrorCode };

/** The document after one call: created; or failed for good after an invalid input or the last attempt; else pending. */
export function afterCall(doc: DigestDoc, call: TaskCall, now: number): DigestDoc {
  const attempts = (doc.attempts ?? 0) + 1;
  if (call.ok) {
    const claimedAt = doc.claimed_at ?? now;
    return {
      ...doc,
      state: 'created',
      request: null,
      attempts,
      task_id: call.taskId,
      last_sent_at: now,
      last_generated_at: claimedAt,
      last_receipt: { stored: true, generated_at: iso(claimedAt), item_count: doc.item_count ?? 0 },
      last_error: null,
      last_attempt_at: now,
    };
  }
  const final = call.code === 'invalid_input' || attempts >= DIGEST_TASK_ATTEMPTS;
  return { ...doc, state: final ? 'failed' : 'pending', ...(final ? { request: null } : {}), attempts, last_error: call.code, last_attempt_at: now };
}

/** `digest_task_failed` while today's task could not be created; the next day's claim ends it. */
export function digestTaskFailed(doc: DigestDoc, now: number): Candidate | null {
  if (doc.day !== utcDay(now) || doc.state !== 'failed') return null;
  return {
    source: 'dashboard',
    code: 'digest_task_failed',
    severity: 'warning',
    metrics: { attempts: doc.attempts ?? 0 },
    ...(doc.last_attempt_at == null ? {} : { since: iso(doc.last_attempt_at) }),
  };
}

/** The start of the UTC day after the last one handled, when one was. */
export function nextDigestDay(doc: DigestDoc): number | null {
  return doc.day === undefined ? null : Date.parse(`${doc.day}T00:00:00Z`) + DAY_MS;
}
