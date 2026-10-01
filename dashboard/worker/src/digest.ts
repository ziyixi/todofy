/**
 * The unified ops digest (docs/design.md §5.5): pure functions building the OpsReport items (codes,
 * severities, times and numbers only) and deciding when to send them to Todofy's `reportOps`.
 */
import { OPS_APPS, OPS_LIMITS, type OpsApp, type OpsReport, type OpsReportItem, type OpsSeverity, type OpsStatus } from '../../../contracts/ops-v1/ops-v1.ts';
import { GUARD_SHED_PERCENT, QUOTA_CRITICAL_PERCENT, type CanaryStage, type OverallLevel, type QuotaRow } from './api-types.ts';
import { DRIFT_CATEGORIES, DRIFT_UNAVAILABLE_AFTER_DAYS } from './api-v2-types.ts';
import { CANARY_DISABLED_CODE, type CanaryRecord } from './canary.ts';
import { totalFindings, type DriftDoc } from './drift.ts';
import { hoursLeft, reachesPercent, type DesiredGuard } from './guard.ts';
import { HOUR_MS, MINUTE_MS, iso, isTimestamp, startOfUtcDay } from './time.ts';

export const DIGEST_REFRESH_MS = 6 * HOUR_MS;
/**
 * No report replaces one from an earlier UTC day during this start of the day. Todofy keeps only the
 * latest report and lists it in a day's reminder only if it was generated before that day began
 * (contracts/ops-v1 README: report at about 23:40 for the next day's reminder); its reminder check runs
 * every 10 min. The 00:00 tick therefore must not overwrite the 23:30 report before that check has
 * claimed it (a quota item that clears at midnight would never be reported); the 00:30 tick may send.
 */
export const DIGEST_DAY_START_HOLD_MS = 20 * MINUTE_MS;
/** A usage fetch failing for this long becomes `usage_unavailable`. */
export const USAGE_UNAVAILABLE_AFTER_MS = 2 * HOUR_MS;
/** App statuses older than this do not contribute signals. */
export const STATUS_SIGNAL_MAX_AGE_MS = HOUR_MS;
/** No completed cron tick for this long (two and a half ticks) is `tick_stale`: guard, canary and digest have stopped. */
export const TICK_STALE_MS = 75 * MINUTE_MS;

const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;

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
}

/** Numbers only, named by codes, at most 12 keys. */
export function cleanMetrics(metrics: Readonly<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(metrics)) {
    if (count >= OPS_LIMITS.metricsMaxKeys) break;
    if (!CODE.test(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
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
        metrics: run.code !== null && CODE.test(run.code) ? { [run.code]: 1 } : {},
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
    if (status.health === 'down') out.push({ source: app, code: 'app_down', severity: 'critical', metrics: {} });
    for (const signal of status.signals) {
      if (signal.severity === 'info' || !CODE.test(signal.code)) continue;
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
export function finalizeItems(list: readonly Candidate[], firstSeen: ReadonlyMap<string, number>, now: number): OpsReportItem[] {
  const byKey = new Map<string, Candidate>();
  for (const candidate of list) {
    if (candidate.severity === 'info' || !SOURCE.test(candidate.source) || !CODE.test(candidate.code)) continue;
    const key = itemKey(candidate);
    const existing = byKey.get(key);
    if (existing === undefined || RANK[candidate.severity] < RANK[existing.severity]) byKey.set(key, candidate);
  }
  return [...byKey.values()]
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.source.localeCompare(b.source) || a.code.localeCompare(b.code))
    .slice(0, OPS_LIMITS.reportMaxItems)
    .map((c) => ({
      source: c.source,
      code: c.code,
      severity: c.severity,
      since: c.since ?? iso(firstSeen.get(itemKey(c)) ?? now),
      metrics: cleanMetrics(c.metrics),
    }));
}

const encoder = new TextEncoder();

export function reportBytes(report: OpsReport): number {
  return encoder.encode(JSON.stringify(report)).byteLength;
}

/** The report, trimmed from the end until its compact JSON is at most 8192 bytes. */
export function buildReport(items: readonly OpsReportItem[], now: number, dashboardUrl: string | null): OpsReport {
  const kept = items.slice(0, OPS_LIMITS.reportMaxItems);
  const make = (list: readonly OpsReportItem[]): OpsReport => ({
    generated_at: iso(now),
    items: list,
    ...(dashboardUrl !== null ? { dashboard_url: dashboardUrl } : {}),
  });
  let report = make(kept);
  while (kept.length > 0 && reportBytes(report) > OPS_LIMITS.reportMaxBytes) {
    kept.pop();
    report = make(kept);
  }
  return report;
}

/** The change key: sorted `source:code:severity`. */
export function digestKey(items: readonly OpsReportItem[]): string {
  return items
    .map((item) => `${item.source}:${item.code}:${item.severity}`)
    .sort()
    .join(',');
}

export interface DigestSendState {
  readonly last_key: string | null;
  readonly last_sent_at: number | null;
}

/**
 * Send on a change, at least every 6 h, and at the 23:30 UTC tick when the last send is ≥ 60 min old;
 * never during the first DIGEST_DAY_START_HOLD_MS of a UTC day when the last report is from an earlier
 * day (it is still waiting for today's reminder).
 */
export function shouldSend(key: string, state: DigestSendState, now: number): boolean {
  if (state.last_sent_at === null || state.last_key === null) return true;
  const dayStart = startOfUtcDay(now);
  if (now - dayStart < DIGEST_DAY_START_HOLD_MS && state.last_sent_at < dayStart) return false;
  if (key !== state.last_key) return true;
  const age = now - state.last_sent_at;
  if (age >= DIGEST_REFRESH_MS) return true;
  const date = new Date(now);
  return date.getUTCHours() === 23 && date.getUTCMinutes() >= 30 && age >= 60 * MINUTE_MS;
}

export function overallLevel(items: readonly OpsReportItem[]): OverallLevel {
  if (items.some((item) => item.severity === 'critical')) return 'critical';
  if (items.some((item) => item.severity === 'warning')) return 'warning';
  return 'ok';
}
