import { WorkerEntrypoint } from 'cloudflare:workers';
import { create } from '@ziyixi/proto/protobuf';
import { GuardLevel, Health, OpsStatusSchema, Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { toWire } from '@ziyixi/proto/wire-json';
import type { Env } from './env.ts';
import type { SubscriptionStore } from './store.ts';

type ConnectionStatus = Awaited<ReturnType<SubscriptionStore['status']>>;

export function buildOpsStatus(status?: ConnectionStatus): wire.OpsStatus {
  const failed = status?.deliveries.failed ?? 0;
  const counters: Record<string, number> = status ? {
    active_subscriptions: status.subscriptions,
    pending_deliveries: status.deliveries.pending ?? 0,
    accepted_deliveries: status.deliveries.accepted ?? 0,
    failed_deliveries: failed,
    open_work: status.work.open, waiting_work: status.work.waiting, unhandled_work_reports: status.work.pending_reports,
  } : {};
  if (status?.last_tool_at) counters.last_tool_at_ms = status.last_tool_at;
  if (status?.last_subscription_at) counters.last_subscription_at_ms = status.last_subscription_at;
  const checked = status?.sources.flatMap(source => source.checked_at === null ? [] : [source.checked_at]) ?? [];
  if (checked.length) counters.last_source_check_at_ms = Math.max(...checked);
  if (status?.last_delivery) {
    counters.last_event_at_ms = Date.parse(status.last_delivery.event_at);
    if (status.last_delivery.accepted_at) counters.last_delivery_at_ms = status.last_delivery.accepted_at;
  }
  const signals: { code: string; severity: Severity; metrics?: Record<string, number> }[] = !status ? [{ code: 'status_unavailable', severity: Severity.CRITICAL }]
    : failed > 0 ? [{ code: 'delivery_failed', severity: Severity.WARNING, metrics: { count: failed } }] : [];
  if (status?.last_subscription_request?.phase === 'rejected') signals.push({
    code: 'subscription_rejected', severity: Severity.WARNING,
    metrics: { rpc_code: status.last_subscription_request.rpc_code ?? 0 },
  });
  const sourceErrors = status?.sources.filter(source => source.error_code !== null).length ?? 0;
  if (sourceErrors) signals.push({ code: 'source_unavailable', severity: Severity.WARNING, metrics: { count: sourceErrors } });
  return toWire(OpsStatusSchema, create(OpsStatusSchema, {
    version: 'ops-v1', app: 'personal-mcp', generatedAt: new Date().toISOString(),
    health: !status ? Health.DOWN : signals.length ? Health.DEGRADED : Health.OK,
    modes: { maintenance: false }, guard: { level: GuardLevel.NORMAL }, capabilities: [], counters,
    signals,
  }));
}

/** Home reads this private binding; it does not trigger tool calls or source refreshes. */
export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService {
  async status(): Promise<wire.OpsStatus> {
    try {
      return await this.env.SUBSCRIPTIONS.get(this.env.SUBSCRIPTIONS.idFromName('owner')).getOpsStatus();
    } catch { return buildOpsStatus(); }
  }

  setGuard(): Promise<wire.GuardState> { return Promise.reject(new Error('invalid_input')); }
}
