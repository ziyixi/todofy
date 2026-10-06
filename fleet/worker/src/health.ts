/** Pure projection into Home ops-v1. Process health never claims provider success. */
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import type { Report } from './report.ts';
import { freshness, reportCodes } from './report.ts';
import { releaseReady, runtimeHealthReady, workload } from './runtime.ts';

const HOUR_MS = 3_600_000;
/**
 * The daily send starts at 07:00 America/Los_Angeles and may run up to 2 h 05 min (k3s activeDeadlineSeconds).
 * Two accepted deliveries are thus at most 24 h + 1 h (DST) + ~2 h apart; beyond 28 h a day was missed.
 */
export const DELIVERY_OVERDUE_MS = 28 * HOUR_MS;
/** A provider outcome still unknown after one run budget plus a margin will not settle by itself. */
export const DELIVERY_UNSETTLED_MS = 2.5 * HOUR_MS;
/** Kinds whose unknown outcome may hide a real email, packet or Notion write; the rest are bookkeeping. */
const SIDE_EFFECT_KINDS = ['delivery', 'packets', 'notion_entities', 'notion_versions'] as const;

/**
 * Business outcomes: only what the owner must act on warns. Every unknown record stays visible as info
 * with its counters; interrupted activities and workflow attempts alone never warn.
 */
function newsletterOutcomes(newsletter: Report['newsletter'], now: number): ops.Signal[] {
  const signals: ops.Signal[] = [];
  const state = newsletter.latest_delivery_state;
  const since = newsletter.latest_delivery_time == null ? {} : { since: newsletter.latest_delivery_time };
  if (state === 'provider_accepted') signals.push({ code: 'newsletter_delivery_accepted', severity: 'info', ...since, metrics: {} });
  if (state === 'rejected') signals.push({ code: 'newsletter_delivery_rejected', severity: 'warning', ...since, metrics: {} });
  if (deliveryOverdue(newsletter, now)) signals.push({ code: 'newsletter_delivery_overdue', severity: 'warning', ...since, metrics: {} });

  const unknownCount = newsletter.unknown_count ?? 0;
  if (unknownCount > 0) {
    signals.push({ code: 'newsletter_unknown', severity: 'info', metrics: {
      unknown_count: unknownCount,
      ...(newsletter.unknown_revision == null ? {} : { unknown_revision: newsletter.unknown_revision }),
    } });
  }
  const byKind = newsletter.unknown_by_kind;
  // A legacy observer does not classify, so every unknown record may be a side effect.
  const sideEffects = byKind ? SIDE_EFFECT_KINDS.reduce((sum, kind) => sum + (byKind[kind] ?? 0), 0) : unknownCount;
  if (sideEffects > 0) signals.push({ code: 'newsletter_side_effect_unknown', severity: 'warning', metrics: { count: sideEffects } });
  return signals;
}

/** Missing, old or stuck delivery evidence; a rejection already warns on its own. */
function deliveryOverdue(newsletter: Report['newsletter'], now: number): boolean {
  const state = newsletter.latest_delivery_state;
  if (state == null || newsletter.latest_delivery_time == null) return true;
  const age = now - Date.parse(newsletter.latest_delivery_time);
  if (state === 'provider_accepted') return age > DELIVERY_OVERDUE_MS;
  if (state === 'unknown') return age > DELIVERY_UNSETTLED_MS;
  return false;
}

export function statusSnapshot(
  app: 'fleet' | 'newsletter', report: Report | null, receivedAt: number | null,
  now: number, publicHost: string,
): ops.OpsStatus {
  const age = freshness(receivedAt, now);
  const signals: ops.Signal[] = [];
  const add = (code: string, severity: ops.Severity = 'warning', metrics: Record<string, number> = {}): void => {
    signals.push({ code, severity, metrics });
  };
  if (age !== 'fresh') {
    const code = age === 'never_seen' ? 'host_never_seen' : age === 'stale' ? 'host_stale' : 'host_missing';
    add(code, age === 'missing' ? 'critical' : 'warning');
  }
  if (age === 'fresh' && report) {
    if (app === 'newsletter') {
      const runtime = workload(report, 'newsletter');
      const healthy = runtime?.process_state === 'running'
        && runtime.health_state !== 'unsupported'
        && runtimeHealthReady(runtime)
        && report.cluster.state === 'ready'
        && report.cluster.ready_count === 1
        && report.newsletter.state === 'healthy'
        && report.newsletter.worker_healthy === true;
      if (!healthy) add('newsletter_unavailable', 'critical');
      if (!runtime || !releaseReady(runtime)) add('deployment_pending');
      if (['draining', 'frozen'].includes(report.newsletter.drain_state)) add('newsletter_paused', 'info');
      signals.push(...newsletterOutcomes(report.newsletter, now));
    } else {
      for (const code of reportCodes(report)) {
        if (code.startsWith('newsletter_')) continue;
        const critical = code.startsWith('daemon_')
          || ['cluster_unavailable', 'release_failed', 'release_held'].includes(code);
        add(code, critical ? 'critical' : code === 'release_in_progress' ? 'info' : 'warning');
      }
    }
  }
  const counters: Record<string, number> = {};
  if (receivedAt !== null) counters.heartbeat_age_seconds = Math.floor(Math.max(0, now - receivedAt) / 1000);
  if (age === 'fresh' && report) {
    if (app === 'newsletter') {
      for (const [key, count] of Object.entries(report.newsletter.unknown_by_kind ?? {})) counters[`unknown_${key}`] = count;
      for (const key of ['queued_count', 'inflight_count', 'unknown_count', 'unknown_revision'] as const) {
        const value = report.newsletter[key];
        if (typeof value === 'number') counters[key] = value;
      }
    } else {
      if (typeof report.disk_used_percent === 'number') counters.disk_used_percent = report.disk_used_percent;
      if (typeof report.memory_used_percent === 'number') counters.memory_used_percent = report.memory_used_percent;
    }
  }
  const rank = (severity: ops.Severity): number => severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
  signals.sort((a, b) => rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code));
  const modes: { maintenance: boolean } & Record<string, boolean> = { maintenance: false };
  if (app === 'newsletter') modes.deployment_paused = age === 'fresh' && report !== null && ['draining', 'frozen'].includes(report.newsletter.drain_state);
  return {
    version: 'ops-v1',
    app,
    generated_at: new Date(now).toISOString(),
    // Unknown historical outcomes need reconciliation, but they are not a process failure.
    health: signals.some((item) => item.severity !== 'info' && item.code !== 'newsletter_side_effect_unknown') ? 'degraded' : 'ok',
    modes,
    guard: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] },
    signals,
    counters,
    last_backup_at: null,
    ui_url: `https://${publicHost}/`,
    capabilities: [],
  };
}
