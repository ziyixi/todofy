/**
 * ops-v1 for Lab (docs/design.md §10, contracts/ops-v1): status() and setGuard(), built only from
 * LabState's own SQLite (no D1 read), with counts and codes only. The guard defers every background job;
 * owner decisions and sends are never deferred.
 */
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import opsSchema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { OPS_LIMITS, OPS_VERSION, type GuardState, type LabStatus, type OpsSignal, type SetGuardInput } from '../../../contracts/ops-v1/ops-v1.ts';
import { DAY, HOUR, iso, publicHost } from './config.ts';
import type { Env } from './env.ts';
import { DEFERRED_JOBS, activeGuard } from './pipeline.ts';
import type { Store } from './store.ts';

const SCHEMA = opsSchema as { $defs: Record<string, unknown> };
export const FEED_STALE_MS = 72 * HOUR;
export const SEND_UNSETTLED_MS = 24 * HOUR;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function guardState(store: Store, now: number): GuardState {
  const guard = activeGuard(store, now);
  if (guard === null || guard.until === null) return { level: 'normal', reason: null, until: null, set_at: null, deferred: [] };
  return { level: 'shed', reason: guard.reason, until: iso(guard.until), set_at: iso(guard.set_at), deferred: [...DEFERRED_JOBS] };
}

export type GuardOutcome = { readonly ok: GuardState } | { readonly error: 'invalid_input' };

/** setGuard: the schema, then `until` in (now, now + 36 h]; the same input as stored returns it unchanged. */
export function setGuard(store: Store, input: unknown, now: number): GuardOutcome {
  if (validate(SCHEMA, 'SetGuardInput', input).length > 0) return { error: 'invalid_input' };
  const value = input as SetGuardInput;
  if (value.level === 'shed') {
    const until = Date.parse(value.until);
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

function signal(code: string, severity: OpsSignal['severity'], metrics: Record<string, number>, since?: number): OpsSignal {
  return since === undefined ? { code, severity, metrics } : { code, severity, metrics, since: iso(since) };
}

export function labStatus(store: Store, env: Env, now: number): LabStatus {
  const host = publicHost(env);
  const base = {
    version: OPS_VERSION as typeof OPS_VERSION,
    app: 'lab' as const,
    generated_at: iso(now),
    last_backup_at: null,
    ui_url: host === null ? null : `https://${host}/`,
    capabilities: ['guard'],
  };
  try {
    const guard = guardState(store, now);
    const ledger = store.ledger(now);
    const cap = store.getNumber('mirror_neuron_cap') ?? 0;
    const signals: OpsSignal[] = [];
    const lastOk = store.getNumber('fetch_last_ok_at');
    const reference = lastOk ?? store.getNumber('bootstrap_at');
    if (reference !== null && now - reference > FEED_STALE_MS) {
      signals.push(signal('feed_stale', 'warning', { hours: Math.floor((now - reference) / HOUR) }, reference));
    }
    if (ledger.capHitAt !== null || ledger.exhausted) {
      signals.push(signal('neuron_cap_hit', 'warning', { used: Math.round(ledger.used * 10) / 10, cap }, ledger.capHitAt ?? undefined));
    }
    const unsettled = store.one<{ n: number; since: number | null }>('SELECT count(*) AS n, min(since) AS since FROM send_watch WHERE since <= ?', now - SEND_UNSETTLED_MS);
    if (unsettled !== undefined && unsettled.n > 0) signals.push(signal('send_unsettled', 'warning', { count: unsettled.n }, unsettled.since ?? undefined));
    if (guard.level === 'shed' && guard.until !== null) {
      signals.push(signal('guard_shed', 'info', { seconds_left: Math.max(0, Math.round((Date.parse(guard.until) - now) / 1000)) }));
    }
    signals.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const week = now - 7 * DAY;
    const counters = {
      ingested_24h: store.since('ingested', now - DAY),
      ranked_24h: store.since('ranked', now - DAY),
      liked_7d: store.one<{ n: number }>("SELECT count(*) AS n FROM labels WHERE label = 'like' AND at >= ?", week)?.n ?? 0,
      decided_7d: store.one<{ n: number }>('SELECT count(*) AS n FROM labels WHERE at >= ?', week)?.n ?? 0,
      neurons_today: Math.round(ledger.used * 10) / 10,
      neuron_cap: cap,
    };
    return {
      ...base,
      health: signals.some((s) => s.severity !== 'info') ? 'degraded' : 'ok',
      modes: { maintenance: false, ingest_paused: store.get('mirror_ingest_paused') === '1' },
      guard,
      signals: signals.slice(0, OPS_LIMITS.statusMaxSignals),
      counters,
    };
  } catch {
    return {
      ...base,
      health: 'down',
      modes: { maintenance: false },
      guard: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] },
      signals: [signal('status_unavailable', 'critical', {})],
      counters: {},
    };
  }
}
