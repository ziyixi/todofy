/**
 * ops-v1 for the watch app (../../docs/design.md §7, contracts/ops-v1, proto/ops/v1/ops.proto): status() and
 * setGuard(), built only from WatchState's own SQLite, with counts and codes only: never a watch's name, URL, page text
 * or a diff (the contract's content rule; the owner decision of 2026-10-01).
 *
 * Every answer is a generated message written by the wire codec (`toWire`), which checks the contract's rules before a
 * byte leaves; setGuard's input is read strictly with the same rules. The one rule the IDL cannot hold is here: a
 * shed's `until` within 36 hours of this clock (OPS_LIMITS.guardMaxAheadSeconds).
 *
 * The guard (the dashboard's 80 % rule) stretches the background work while it lasts: a scheduled check waits until
 * the watch's last check is a day old (SHED_CHECK_SPACING_MS), and the daily sweep of every watch's bounds waits for
 * the guard to end. An owner's "check now", a pending change's confirmation fetch, previews, the owner API and the
 * notifications to Todofy are never deferred.
 *
 * Rows read by status() (SQLite rows are a budget: docs/design.md §8): the watches (at most 50), the new changes
 * through `changes_state` up to NEW_CHANGES_COUNTED, the undelivered events through `notifications_pending` (at most
 * NOTIFICATIONS_MAX), the sink's intents of the last INTENTS_KEPT_MS (at most ~300), a few meta rows.
 */
import { create } from '@ziyixi/proto/protobuf';
import {
  file_ops_v1_ops,
  GuardLevel,
  GuardStateSchema,
  Health,
  OpsService,
  OpsStatusSchema,
  Severity,
  SignalSchema,
  type GuardState,
  type Signal,
} from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fieldRules, formatMatches, fromWireArguments, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import { publicHost, type Env } from './env.ts';
import { utcDay } from './etiquette.ts';
import { ALARM_IDLE_MS, DAY, HOUR } from './limits.ts';
import type { Store } from './store.ts';

/** The jobs a shed defers (GuardState.deferred). */
export const DEFERRED_JOBS = ['scheduled_checks', 'daily_sweep'] as const;
/** While shed, a watch is checked on its schedule only once its last check is this old. */
export const SHED_CHECK_SPACING_MS = DAY;
/** status() counts new changes up to this many (the count reads one index row each). */
export const NEW_CHANGES_COUNTED = 1000;
/** No alarm pass for this long (twice the idle interval) raises `scheduler_stale`. */
export const SCHEDULER_STALE_MS = 2 * ALARM_IDLE_MS;
/** An intent still open this long after it was frozen, or given up or refused this recently, is `notify_unsettled`. */
export const INTENT_UNSETTLED_MS = DAY;
export const INTENT_FAILED_WINDOW_MS = 7 * DAY;

const MAX_SIGNALS = fieldRules(OpsStatusSchema.field.signals).maxItems;

/** An ops-v1 timestamp: RFC 3339 UTC without milliseconds, e.g. 2026-10-01T14:00:00Z (as Lab writes them). */
export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Critical first, then warning, then info (the contract's order of signals). */
function rank(severity: Severity): number {
  return severity === Severity.CRITICAL ? 0 : severity === Severity.WARNING ? 1 : 2;
}

// ---- the guard ------------------------------------------------------------------------------------------------------

/** A shed in force: its reason, end and start (epoch ms). */
export interface Shed {
  readonly reason: string;
  readonly until: number;
  readonly setAt: number;
}

/** The shed in force at `now`, or null (a stored shed whose `until` passed reads as normal). */
export function activeShed(store: Store, now: number): Shed | null {
  const until = Number(store.getMeta('guard_until') ?? '');
  const setAt = Number(store.getMeta('guard_set_at') ?? '');
  const reason = store.getMeta('guard_reason');
  if (reason === null || !Number.isFinite(until) || !Number.isFinite(setAt) || until <= now) return null;
  return { reason, until, setAt };
}

function guardMessage(store: Store, now: number): GuardState {
  const shed = activeShed(store, now);
  if (shed === null) return create(GuardStateSchema, { level: GuardLevel.NORMAL });
  return create(GuardStateSchema, { level: GuardLevel.SHED, reason: shed.reason, until: iso(shed.until), setAt: iso(shed.setAt), deferred: [...DEFERRED_JOBS] });
}

export function guardState(store: Store, now: number): wire.GuardState {
  return toWire(GuardStateSchema, guardMessage(store, now));
}

export type GuardOutcome = { readonly ok: wire.GuardState } | { readonly error: 'invalid_input' };

/** setGuard: the contract's rules, then `until` in (now, now + 36 h]; the same shed as stored keeps its set_at. */
export function setGuard(store: Store, input: unknown, now: number): GuardOutcome {
  let value;
  try {
    value = fromWireArguments(OpsService.method.setGuard, [input]);
  } catch (error) {
    if (error instanceof WireJsonError) return { error: 'invalid_input' };
    throw error;
  }
  if (value.level === GuardLevel.SHED) {
    const until = Date.parse(value.until ?? '');
    if (!Number.isFinite(until) || until <= now || until - now > OPS_LIMITS.guardMaxAheadSeconds * 1000) return { error: 'invalid_input' };
    const stored = activeShed(store, now);
    if (!(stored !== null && stored.reason === value.reason && stored.until === until)) {
      store.setMeta('guard_reason', value.reason);
      store.setMeta('guard_until', String(until));
      store.setMeta('guard_set_at', String(now));
    }
  } else {
    store.run(`DELETE FROM meta WHERE key IN ('guard_reason', 'guard_until', 'guard_set_at')`);
  }
  return { ok: guardState(store, now) };
}

// ---- status ---------------------------------------------------------------------------------------------------------

function signal(code: string, severity: Severity, metrics: Record<string, number>, since?: number): Signal {
  return create(SignalSchema, { code, severity, metrics, ...(since === undefined ? {} : { since: iso(since) }) });
}

/** The owner UI's URL, `https://<host>/`, when it keeps the contract's `HttpsUrl` format; else none. */
export function uiUrl(host: string | null): string | undefined {
  if (host === null) return undefined;
  const url = `https://${host}/`;
  return formatMatches(file_ops_v1_ops, 'HttpsUrl', url) ? url : undefined;
}

interface WatchCounts {
  active: number;
  paused: number;
  broken: number;
  failing: number;
  brokenSince: number | null;
}

function watchCounts(store: Store): WatchCounts {
  const out: WatchCounts = { active: 0, paused: 0, broken: 0, failing: 0, brokenSince: null };
  for (const row of store.all<{ state: string; failures: number; failure_start: number | null }>(`SELECT state, failures, failure_start FROM watches`)) {
    if (row.state === 'active') out.active++;
    else if (row.state === 'paused') out.paused++;
    else if (row.state === 'broken') {
      out.broken++;
      if (row.failure_start !== null) out.brokenSince = Math.min(out.brokenSince ?? row.failure_start, row.failure_start);
    }
    // A watch whose last check failed and that is still checked (BROKEN included; an owner's pause is not failing).
    if (row.failures > 0 && row.state !== 'paused') out.failing++;
  }
  return out;
}

export function watchStatus(store: Store, env: Pick<Env, 'PUBLIC_HOST'> & { readonly TODOFY?: unknown }, now: number): wire.OpsStatus {
  const url = uiUrl(publicHost(env));
  const base = {
    version: 'ops-v1',
    app: 'watch',
    generatedAt: iso(now),
    ...(url === undefined ? {} : { uiUrl: url }),
    capabilities: ['guard'],
  };
  try {
    const guard = guardMessage(store, now);
    const watches = watchCounts(store);
    const newChanges =
      store.one<{ n: number }>(`SELECT count(*) AS n FROM (SELECT 1 FROM changes WHERE state = 'confirmed' LIMIT ?)`, NEW_CHANGES_COUNTED)?.n ?? 0;
    const pending = store.one<{ n: number }>(`SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL`)?.n ?? 0;
    const intents = store.one<{ open: number | null; stuck: number | null; stuck_since: number | null; failed: number | null; sent: number | null }>(
      `SELECT
         sum(state = 'open') AS open,
         sum(state = 'open' AND created_at <= ?) AS stuck,
         min(CASE WHEN state = 'open' AND created_at <= ? THEN created_at END) AS stuck_since,
         sum(state IN ('refused', 'expired') AND updated_at >= ?) AS failed,
         sum(state = 'recorded' AND day = ?) AS sent
       FROM intents`,
      now - INTENT_UNSETTLED_MS,
      now - INTENT_UNSETTLED_MS,
      now - INTENT_FAILED_WINDOW_MS,
      utcDay(now),
    );
    const ledger = store.ledger(utcDay(now));
    const lastAlarm = Number(store.getMeta('last_alarm_at') ?? '');

    const signals: Signal[] = [];
    if (watches.broken > 0) signals.push(signal('watches_broken', Severity.WARNING, { count: watches.broken }, watches.brokenSince ?? undefined));
    // The scheduler: no pass for twice the idle interval while there is something to check. status() arms a missing
    // alarm itself (state.ts), so this stays up only while passes fail or never run.
    const ranAt = Number.isFinite(lastAlarm) && lastAlarm > 0 ? lastAlarm : null;
    if (watches.active + watches.broken > 0 && (ranAt === null || now - ranAt > SCHEDULER_STALE_MS)) {
      // `hours` since the last pass; none when no pass ever ran.
      signals.push(signal('scheduler_stale', Severity.WARNING, ranAt === null ? {} : { hours: Math.floor((now - ranAt) / HOUR) }, ranAt ?? undefined));
    }
    const stuck = intents?.stuck ?? 0;
    const failed = intents?.failed ?? 0;
    if (stuck + failed > 0) signals.push(signal('notify_unsettled', Severity.WARNING, { open: stuck, failed }, intents?.stuck_since ?? undefined));
    if (guard.level === GuardLevel.SHED && guard.until !== undefined) {
      signals.push(signal('guard_shed', Severity.INFO, { seconds_left: Math.max(0, Math.round((Date.parse(guard.until) - now) / 1000)) }));
    }
    signals.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const counters = {
      watches_active: watches.active,
      watches_paused: watches.paused,
      watches_broken: watches.broken,
      watches_failing: watches.failing,
      changes_new: newChanges,
      fetches_today: ledger.fetches,
      notifications_pending: pending,
      intents_open: intents?.open ?? 0,
      intents_sent_today: intents?.sent ?? 0,
    };
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: signals.some((s) => s.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
        modes: { maintenance: false, notifications: env.TODOFY !== undefined },
        guard,
        signals: signals.slice(0, MAX_SIGNALS),
        counters,
      }),
    );
  } catch {
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: Health.DOWN,
        modes: { maintenance: false, notifications: env.TODOFY !== undefined },
        guard: { level: GuardLevel.NORMAL },
        signals: [signal('status_unavailable', Severity.CRITICAL, {})],
      }),
    );
  }
}
