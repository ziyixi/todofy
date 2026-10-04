/** Pure projection into Home ops-v1. Process health never claims provider success. */
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import type { Report } from './report.ts';
import { freshness, reportCodes } from './report.ts';
import { releaseReady, runtimeHealthReady, workload } from './runtime.ts';

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
      const unknownCount = report.newsletter.unknown_count ?? 0;
      const delivery = report.newsletter;
      if (delivery.latest_delivery_state === 'provider_accepted') signals.push({ code: 'newsletter_delivery_accepted', severity: 'info', ...(delivery.latest_delivery_time === undefined ? {} : { since: delivery.latest_delivery_time }), metrics: {} });
      if (delivery.latest_delivery_state === 'rejected') signals.push({ code: 'newsletter_delivery_rejected', severity: 'warning', ...(delivery.latest_delivery_time === undefined ? {} : { since: delivery.latest_delivery_time }), metrics: {} });
      if (unknownCount > 0) add('newsletter_unknown', 'warning', { unknown_count: unknownCount, ...(report.newsletter.unknown_revision === undefined ? {} : { unknown_revision: report.newsletter.unknown_revision }) });
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
    health: signals.some((item) => item.severity !== 'info' && item.code !== 'newsletter_unknown') ? 'degraded' : 'ok',
    modes,
    guard: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] },
    signals,
    counters,
    last_backup_at: null,
    ui_url: `https://${publicHost}/`,
    capabilities: [],
  };
}
