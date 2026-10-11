/**
 * ops-v1 for recall (../../docs/design.md §9, contracts/ops-v1, proto/ops/v1/ops.proto): status(), built only from
 * RecallState's own SQLite with bounded reads (status.ts), codes and counts only: never a URL, host, title or text.
 * recall has no guard (its daily write budget already caps its share, and an upload it refuses waits in the
 * extension's outbox), so it lists no capability and refuses setGuard.
 *
 * Signals: `device_stale` (warning: a device seen in the last 30 days without an upload for 24 hours),
 * `archive_not_connected` (warning: the Dropbox backup is not connected, or Dropbox refused its token), `archive_behind`
 * (warning: a change has waited more than 24 hours for Dropbox, counted from the connection at the earliest; the feed's
 * own consumers are shown in 设置 and raise nothing), `no_captures` (warning: yesterday had visits of ten seconds or
 * more on pages that keep their text, and no capture of them arrived, not even one recall skipped as a text it had),
 * `items_rejected` (warning: uploads lost
 * items in the last 24 hours; an `unsupported_item` is not lost), `storage_high` (warning past STORAGE_HIGH_MIB,
 * critical at the budget), `upload_over_budget` (warning: today's write budget ran out), `reads_over_budget` (warning:
 * today's reads stopped the change feed, or the searches too) and `no_device` (information, before the first upload);
 * `status_unavailable` (critical) when the snapshot cannot be read. A paused retention window raises nothing of its
 * own: it pauses only while the backup is not connected or failing, which `archive_not_connected` and `archive_behind`
 * already report.
 */
import { create } from '@ziyixi/proto/protobuf';
import { file_ops_v1_ops, GuardLevel, Health, OpsStatusSchema, Severity, SignalSchema, type Signal } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fieldRules, formatMatches, toWire } from '@ziyixi/proto/wire-json';
import { LOST_REASONS } from './ingest.ts';
import { connected, waitingSince } from './backup.ts';
import { ACTIVE_MS, ARCHIVE_BEHIND_MS, DAILY_READ_BUDGET, DAY, FEED_READ_LIMIT, HOUR, MIB, STALE_MS, STORAGE_BUDGET_MIB, STORAGE_HIGH_MIB } from './limits.ts';
import { devices, rejectedItems } from './status.ts';
import { utcDay, type Store } from './store.ts';

const MAX_SIGNALS = fieldRules(OpsStatusSchema.field.signals).maxItems;

/** An ops-v1 timestamp: RFC 3339 UTC without milliseconds. */
export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function rank(severity: Severity): number {
  return severity === Severity.CRITICAL ? 0 : severity === Severity.WARNING ? 1 : 2;
}

function signal(code: string, severity: Severity, metrics: Record<string, number>, since?: number): Signal {
  return create(SignalSchema, { code, severity, metrics, ...(since === undefined ? {} : { since: iso(since) }) });
}

export function uiUrl(host: string | null): string | undefined {
  if (host === null) return undefined;
  const url = `https://${host}/`;
  return formatMatches(file_ops_v1_ops, 'HttpsUrl', url) ? url : undefined;
}

/** The signals of the snapshot, most severe first, then by code. */
export function signals(store: Store, now: number): Signal[] {
  const out: Signal[] = [];
  const known = devices(store);
  if (known.length === 0) out.push(signal('no_device', Severity.INFO, {}));
  const staleDevices = known.filter((row) => now - row.last_seen_ms <= ACTIVE_MS && now - row.last_seen_ms > STALE_MS);
  if (staleDevices.length > 0) {
    const since = Math.min(...staleDevices.map((row) => row.last_seen_ms));
    out.push(signal('device_stale', Severity.WARNING, { count: staleDevices.length, hours: Math.floor((now - since) / (DAY / 24)) }, since));
  }
  if (!connected(store)) out.push(signal('archive_not_connected', Severity.WARNING, {}));
  const waiting = waitingSince(store);
  if (waiting !== null && now - waiting > ARCHIVE_BEHIND_MS) out.push(signal('archive_behind', Severity.WARNING, { hours: Math.floor((now - waiting) / HOUR) }, waiting));
  const yesterday = store.usage(utcDay(now - DAY));
  if (yesterday.long_visits > 0 && yesterday.captures === 0) out.push(signal('no_captures', Severity.WARNING, { visits: yesterday.long_visits }));
  const lost = rejectedItems(store, now).filter((item) => LOST_REASONS.includes(item.reason) && now - item.lastMs <= DAY);
  if (lost.length > 0) out.push(signal('items_rejected', Severity.WARNING, { count: lost.reduce((sum, item) => sum + item.count, 0) }));
  const usedMib = store.databaseSize / MIB;
  if (usedMib >= STORAGE_BUDGET_MIB) out.push(signal('storage_high', Severity.CRITICAL, { used_mib: Math.ceil(usedMib), budget_mib: STORAGE_BUDGET_MIB }));
  else if (usedMib > STORAGE_HIGH_MIB) out.push(signal('storage_high', Severity.WARNING, { used_mib: Math.ceil(usedMib), budget_mib: STORAGE_BUDGET_MIB }));
  const today = store.usage(utcDay(now));
  if (today.over_budget === 1) out.push(signal('upload_over_budget', Severity.WARNING, {}));
  if (today.rows_read >= FEED_READ_LIMIT) out.push(signal('reads_over_budget', Severity.WARNING, { rows_read: today.rows_read, budget: DAILY_READ_BUDGET }));
  return out.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).slice(0, MAX_SIGNALS);
}

/** status(): a few indexed reads and meta rows. */
export function recallStatus(store: Store, host: string | null, now: number): wire.OpsStatus {
  const url = uiUrl(host);
  const base = { version: 'ops-v1', app: 'recall', generatedAt: iso(now), ...(url === undefined ? {} : { uiUrl: url }), capabilities: [] };
  try {
    const found = signals(store, now);
    const today = store.usage(utcDay(now));
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: found.some((s) => s.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
        modes: { maintenance: false },
        guard: { level: GuardLevel.NORMAL },
        signals: found,
        counters: { visits_today: today.visits, texts_today: today.texts, rows_written_today: today.rows_written, rows_read_today: today.rows_read },
      }),
    );
  } catch {
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, { ...base, health: Health.DOWN, modes: { maintenance: false }, guard: { level: GuardLevel.NORMAL }, signals: [signal('status_unavailable', Severity.CRITICAL, {})] }),
    );
  }
}
