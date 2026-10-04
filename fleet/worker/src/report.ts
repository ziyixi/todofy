import { HostReportSchema } from '@ziyixi/proto/fleet/telemetry/v1/host_report_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { HostReport } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { releaseReady, validRuntime } from './runtime.ts';

export type Report = HostReport;
export const MAX_REPORT_BYTES = 16_384;
export const REPORT_PATH = '/api/internal/fleet/v1/receipt';
export const REPORT_KEY_ID = 'primary';
export const FRESH_MS = 10 * 60_000;
export const MISSING_MS = 20 * 60_000;

export class ReceiptError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.status = status;
  }
}

export function parseReport(text: string, host: string, epoch: string, now: number): Report {
  let report: Report;
  try {
    const decoded = fromWire(HostReportSchema, JSON.parse(text), { strict: true });
    report = toWire(HostReportSchema, decoded.message);
  } catch {
    throw new ReceiptError('invalid_report', 400);
  }
  if (report.host_key !== host || report.epoch !== Number(epoch)) {
    throw new ReceiptError('wrong_host', 403);
  }
  const observed = Date.parse(report.observation_time);
  if (!Number.isFinite(observed) || observed < now - FRESH_MS || observed > now + 120_000) {
    throw new ReceiptError('report_clock', 400);
  }
  if (report.runtime && !validRuntime(report.runtime, host, observed)) {
    throw new ReceiptError('invalid_report', 400);
  }
  return report;
}

export function freshness(
  received: number | null,
  now: number,
): 'never_seen' | 'fresh' | 'stale' | 'missing' {
  if (received === null) return 'never_seen';
  const age = Math.max(0, now - received);
  if (age <= FRESH_MS) return 'fresh';
  if (age <= MISSING_MS) return 'stale';
  return 'missing';
}

export function reportCodes(report: Report): string[] {
  const codes: string[] = [];
  for (const [name, daemon] of Object.entries(report.daemons)) {
    if (daemon.state !== 'active') codes.push(`daemon_${name}_${daemon.state}`);
  }
  if (report.cluster.state !== 'ready') codes.push(`cluster_${report.cluster.state}`);
  if (report.newsletter.state !== 'healthy' || report.newsletter.worker_healthy !== true) {
    codes.push('newsletter_unavailable');
  }
  if (['draining', 'frozen'].includes(report.newsletter.drain_state)) {
    codes.push('newsletter_paused');
  }
  if ((report.newsletter.unknown_count ?? 0) > 0) {
    codes.push('newsletter_unknown');
  }
  if ((report.disk_used_percent ?? 0) >= 90) {
    codes.push('disk_high');
  }
  if ((report.memory_used_percent ?? 0) >= 90) {
    codes.push('memory_high');
  }
  const workloads = report.runtime?.workloads ?? [];
  if (!workloads.length || workloads.some((item) => !releaseReady(item))) {
    codes.push('deployment_pending');
  }
  const phase = report.runtime?.current_release?.phase;
  if (phase === 'held') {
    codes.push('release_held');
  }
  if (phase === 'failed') {
    codes.push('release_failed');
  }
  if (phase && !['ready', 'held', 'failed'].includes(phase)) {
    codes.push('release_in_progress');
  }
  const plan = report.runtime?.reconcile_plan;
  if (plan?.state === 'repairable') codes.push('runtime_drift');
  if (plan?.state === 'manual_required' && plan.changes.length > 0) codes.push('runtime_repair_manual');
  if (plan?.state === 'unavailable') codes.push('runtime_comparison_unavailable');
  return codes.sort();
}
