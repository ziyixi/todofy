/**
 * ops-v1 for Lab (docs/design.md §10, contracts/ops-v1, proto/ops/v1/ops.proto): status() and setGuard(), built only
 * from LabState's own SQLite (no D1 read), with counts and codes only. The guard defers every background job; owner
 * decisions and sends are never deferred.
 *
 * Every answer is a generated message written by the wire codec (`toWire`), which checks the contract's rules before a
 * byte leaves and writes the fields in the contract's order; setGuard's input is read strictly with the same rules. The
 * one rule the IDL cannot hold is here: a shed's `until` within 36 hours of Lab's clock.
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
import { DAY, HOUR, iso, publicHost } from './config.ts';
import type { Env } from './env.ts';
import { DEFERRED_JOBS, activeGuard } from './pipeline.ts';
import type { Store } from './store.ts';

export const FEED_STALE_MS = 72 * HOUR;
export const SEND_UNSETTLED_MS = 24 * HOUR;
/** Critical first, then warning, then info (the contract's order of signals). */
const rank = (severity: Severity): number => (severity === Severity.CRITICAL ? 0 : severity === Severity.WARNING ? 1 : 2);
const MAX_SIGNALS = fieldRules(OpsStatusSchema.field.signals).maxItems;

/** The effective guard: shed while now < until, else normal (with no reason, times or deferred jobs). */
function guardMessage(store: Store, now: number): GuardState {
  const guard = activeGuard(store, now);
  if (guard === null || guard.until === null) return create(GuardStateSchema, { level: GuardLevel.NORMAL });
  return create(GuardStateSchema, { level: GuardLevel.SHED, reason: guard.reason, until: iso(guard.until), setAt: iso(guard.set_at), deferred: [...DEFERRED_JOBS] });
}

export function guardState(store: Store, now: number): wire.GuardState {
  return toWire(GuardStateSchema, guardMessage(store, now));
}

export type GuardOutcome = { readonly ok: wire.GuardState } | { readonly error: 'invalid_input' };

/** setGuard: the contract's rules, then `until` in (now, now + 36 h]; the same input as stored returns it unchanged. */
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
    const stored = store.one<{ level: string; reason: string; until: number | null }>('SELECT level, reason, until FROM guard WHERE id = 1');
    if (!(stored?.level === 'shed' && stored.reason === value.reason && stored.until === until)) {
      store.sql.exec(
        `INSERT INTO guard (id, level, reason, until, set_at) VALUES (1, 'shed', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET level = 'shed', reason = excluded.reason, until = excluded.until, set_at = excluded.set_at`,
        value.reason,
        until,
        now,
      );
    }
  } else {
    store.sql.exec('DELETE FROM guard WHERE id = 1');
  }
  return { ok: guardState(store, now) };
}

function signal(code: string, severity: Severity, metrics: Record<string, number>, since?: number): Signal {
  return create(SignalSchema, { code, severity, metrics, ...(since === undefined ? {} : { since: iso(since) }) });
}

/** The owner UI's URL, `https://<host>/`, when it keeps the contract's `HttpsUrl` (the IDL's format); else none. */
export function uiUrl(host: string | null): string | undefined {
  if (host === null) return undefined;
  const url = `https://${host}/`;
  return formatMatches(file_ops_v1_ops, 'HttpsUrl', url) ? url : undefined;
}

export function labStatus(store: Store, env: Env, now: number): wire.OpsStatus {
  const url = uiUrl(publicHost(env));
  const base = {
    version: 'ops-v1',
    app: 'lab',
    generatedAt: iso(now),
    ...(url === undefined ? {} : { uiUrl: url }),
    capabilities: ['guard'],
  };
  try {
    const guard = guardMessage(store, now);
    const ledger = store.ledger(now);
    const cap = store.getNumber('mirror_neuron_cap') ?? 0;
    const signals: Signal[] = [];
    const lastOk = store.getNumber('fetch_last_ok_at');
    const reference = lastOk ?? store.getNumber('bootstrap_at');
    if (reference !== null && now - reference > FEED_STALE_MS) {
      signals.push(signal('feed_stale', Severity.WARNING, { hours: Math.floor((now - reference) / HOUR) }, reference));
    }
    if (ledger.capHitAt !== null || ledger.exhausted) {
      signals.push(signal('neuron_cap_hit', Severity.WARNING, { used: Math.round(ledger.used * 10) / 10, cap }, ledger.capHitAt ?? undefined));
    }
    const unsettled = store.one<{ n: number; since: number | null }>('SELECT count(*) AS n, min(since) AS since FROM send_watch WHERE since <= ?', now - SEND_UNSETTLED_MS);
    if (unsettled !== undefined && unsettled.n > 0) signals.push(signal('send_unsettled', Severity.WARNING, { count: unsettled.n }, unsettled.since ?? undefined));
    if (guard.level === GuardLevel.SHED && guard.until !== undefined) {
      signals.push(signal('guard_shed', Severity.INFO, { seconds_left: Math.max(0, Math.round((Date.parse(guard.until) - now) / 1000)) }));
    }
    signals.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const week = now - 7 * DAY;
    const counters = {
      ingested_24h: store.since('ingested', now - DAY),
      ranked_24h: store.since('ranked', now - DAY),
      liked_7d: store.one<{ n: number }>("SELECT count(*) AS n FROM labels WHERE label = 'like' AND at >= ?", week)?.n ?? 0,
      decided_7d: store.one<{ n: number }>('SELECT count(*) AS n FROM labels WHERE at >= ?', week)?.n ?? 0,
      neurons_today: Math.round(ledger.used * 10) / 10,
      neuron_cap: cap,
    };
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: signals.some((s) => s.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
        modes: { maintenance: false, ingest_paused: store.get('mirror_ingest_paused') === '1' },
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
        modes: { maintenance: false },
        guard: { level: GuardLevel.NORMAL },
        signals: [signal('status_unavailable', Severity.CRITICAL, {})],
      }),
    );
  }
}
