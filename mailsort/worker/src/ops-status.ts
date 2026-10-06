/**
 * ops-v1 for mailsort (../../docs/design.md §10, contracts/ops-v1, proto/ops/v1/ops.proto): status() and setGuard(),
 * built only from MailsortState's own SQLite, with counts and codes only: never a subject, sender, address or label
 * name.
 *
 * Signals: `gmail_auth_failed` (critical: Google refused the grant and the Worker stopped calling it; it reaches Home's
 * attention and so the daily digest), `gmail_not_configured`, `breaker_tripped` and `sync_stale` (warnings), and
 * `ai_quota_exhausted`, `label_live_revoked` and `guard_shed` (information).
 *
 * The guard (Home's 80 % rule) defers what can wait while it lasts: the large decision model (Clef-flash only), the
 * daily audit sample and embedding rebuilds. New mail is still read, decided and sorted.
 */
import { create } from '@ziyixi/proto/protobuf';
import { file_ops_v1_ops, GuardLevel, GuardStateSchema, Health, OpsService, OpsStatusSchema, Severity, SignalSchema, type GuardState, type Signal } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fieldRules, formatMatches, fromWireArguments, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import { modeCeiling, publicHost, type Env } from './env.ts';
import { ALARM_IDLE_MS, DAY, MINUTE } from './limits.ts';
import { authState } from './session.ts';
import { effectiveMode, readSettings } from './settings.ts';
import { utcDay, type Store } from './store.ts';

/** The jobs a shed defers (GuardState.deferred). */
export const DEFERRED_JOBS = ['full_model', 'audit', 'embedding_rebuild'] as const;
/** No complete sync for this long, while the mode reads Gmail and the grant works, raises `sync_stale`. */
export const SYNC_STALE_MS = 6 * ALARM_IDLE_MS;

const MAX_SIGNALS = fieldRules(OpsStatusSchema.field.signals).maxItems;

/** An ops-v1 timestamp: RFC 3339 UTC without milliseconds. */
export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function rank(severity: Severity): number {
  return severity === Severity.CRITICAL ? 0 : severity === Severity.WARNING ? 1 : 2;
}

// ---- the guard ------------------------------------------------------------------------------------------------------

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
    store.deleteMeta('guard_reason', 'guard_until', 'guard_set_at');
  }
  return { ok: guardState(store, now) };
}

// ---- status ---------------------------------------------------------------------------------------------------------

function signal(code: string, severity: Severity, metrics: Record<string, number>, since?: number): Signal {
  return create(SignalSchema, { code, severity, metrics, ...(since === undefined ? {} : { since: iso(since) }) });
}

export function uiUrl(host: string | null): string | undefined {
  if (host === null) return undefined;
  const url = `https://${host}/`;
  return formatMatches(file_ops_v1_ops, 'HttpsUrl', url) ? url : undefined;
}

type StatusEnv = Pick<Env, 'PUBLIC_HOST' | 'MODE' | 'GMAIL_CLIENT_ID' | 'GMAIL_CLIENT_SECRET' | 'GMAIL_REFRESH_TOKEN'>;

/** status(): a few indexed counts and meta rows. */
export function sortStatus(store: Store, env: StatusEnv, now: number): wire.OpsStatus {
  const url = uiUrl(publicHost(env));
  const ceiling = modeCeiling(env);
  const base = { version: 'ops-v1', app: 'mailsort', generatedAt: iso(now), ...(url === undefined ? {} : { uiUrl: url }), capabilities: ['guard'] };
  try {
    const settings = readSettings(store);
    const mode = effectiveMode(settings, ceiling);
    const guard = guardMessage(store, now);
    const usage = store.usage(utcDay(now));
    const auth = authState(store, env);
    const lastSync = Number(store.getMeta('last_sync_at') ?? '');
    const synced = Number.isFinite(lastSync) && lastSync > 0 ? lastSync : null;
    const revoked = Number(store.getMeta('revoked_at') ?? '');
    const pending = store.count(`SELECT count(*) AS n FROM pending`);
    const review = store.count(`SELECT count(*) AS n FROM review WHERE state = 'pending'`);

    const signals: Signal[] = [];
    if (mode !== 'off') {
      if (auth === 'failed') signals.push(signal('gmail_auth_failed', Severity.CRITICAL, { failures: Number(store.getMeta('auth_failures') ?? '0') }));
      if (auth === 'not_configured') signals.push(signal('gmail_not_configured', Severity.WARNING, {}));
      if (auth === 'ok' && (synced === null || now - synced > SYNC_STALE_MS)) {
        signals.push(signal('sync_stale', Severity.WARNING, synced === null ? {} : { minutes: Math.floor((now - synced) / MINUTE) }, synced ?? undefined));
      }
    }
    if (settings.breaker !== '' && settings.mode === 'live') signals.push(signal('breaker_tripped', Severity.WARNING, { applied_today: usage.applied }));
    if (usage.quota_exhausted === 1) signals.push(signal('ai_quota_exhausted', Severity.INFO, { deferred: store.count(`SELECT count(*) AS n FROM pending WHERE not_before > ?`, now) }));
    if (Number.isFinite(revoked) && revoked > now - DAY) signals.push(signal('label_live_revoked', Severity.INFO, {}, revoked));
    if (guard.level === GuardLevel.SHED && guard.until !== undefined) {
      signals.push(signal('guard_shed', Severity.INFO, { seconds_left: Math.max(0, Math.round((Date.parse(guard.until) - now) / 1000)) }));
    }
    signals.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const counters: Record<string, number> = {
      decided_today: usage.decided,
      applied_today: usage.applied,
      unsure_today: usage.unsure,
      review_pending: review,
      pending,
      gmail_calls_today: usage.gmail_calls,
      neurons_today: Math.round(usage.neurons),
      neuron_budget: settings.dailyNeuronBudget,
    };
    if (synced !== null) counters['last_sync_minutes'] = Math.floor((now - synced) / MINUTE);
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: signals.some((s) => s.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
        modes: { maintenance: false, live: mode === 'live', sorting_off: mode === 'off', mode_limited: ceiling !== 'live', breaker: settings.breaker !== '' },
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
        // The deployment variable (MODE) is known without storage; the switches read from storage are left out.
        modes: { maintenance: false, mode_limited: ceiling !== 'live' },
        guard: { level: GuardLevel.NORMAL },
        signals: [signal('status_unavailable', Severity.CRITICAL, {})],
      }),
    );
  }
}
