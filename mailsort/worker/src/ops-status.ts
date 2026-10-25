/**
 * ops-v1 for mailsort (../../docs/design.md §10, contracts/ops-v1, proto/ops/v1/ops.proto): status() and setGuard(),
 * built only from MailsortState's own SQLite, with counts and codes only: never a subject, sender, address or label
 * name.
 *
 * Signals cover Gmail auth/freshness, retained breaker state and native Claude configuration/spend failures.
 * Claude has no Cloudflare guard capability; old shed requests are refused and legacy normal requests clear state.
 */
import { create } from '@ziyixi/proto/protobuf';
import { file_ops_v1_ops, GuardLevel, GuardStateSchema, Health, OpsService, OpsStatusSchema, Severity, SignalSchema, type GuardState, type Signal } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fieldRules, formatMatches, fromWireArguments, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { modeCeiling, publicHost, type Env } from './env.ts';
import { ALARM_IDLE_MS, MINUTE } from './limits.ts';
import { authState } from './session.ts';
import { effectiveMode, readSettings } from './settings.ts';
import { CLAUDE_MONTHLY_LIMIT_MICROS, utcDay, type Store } from './store.ts';

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

function guardMessage(): GuardState {
  return create(GuardStateSchema, { level: GuardLevel.NORMAL });
}

export function guardState(): wire.GuardState {
  return toWire(GuardStateSchema, guardMessage());
}

export type GuardOutcome = { readonly ok: wire.GuardState } | { readonly error: 'invalid_input' };

/** Claude has no shed action. Normal clears a guard stored by an older release. */
export function setGuard(store: Store, input: unknown): GuardOutcome {
  let value;
  try {
    value = fromWireArguments(OpsService.method.setGuard, [input]);
  } catch (error) {
    if (error instanceof WireJsonError) return { error: 'invalid_input' };
    throw error;
  }
  if (value.level === GuardLevel.SHED) return { error: 'invalid_input' };
  store.deleteMeta('guard_reason', 'guard_until', 'guard_set_at');
  return { ok: guardState() };
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

type StatusEnv = Pick<Env, 'PUBLIC_HOST' | 'MODE' | 'GMAIL_CLIENT_ID' | 'GMAIL_CLIENT_SECRET' | 'GMAIL_REFRESH_TOKEN' | 'ANTHROPIC_API_KEY'>;

/** status(): a few indexed counts and meta rows. */
export function sortStatus(store: Store, env: StatusEnv, now: number): wire.OpsStatus {
  const url = uiUrl(publicHost(env));
  const ceiling = modeCeiling(env);
  const base = { version: 'ops-v1', app: 'mailsort', generatedAt: iso(now), ...(url === undefined ? {} : { uiUrl: url }), capabilities: [] };
  try {
    const settings = readSettings(store);
    const mode = effectiveMode(settings, ceiling);
    const guard = guardMessage();
    const usage = store.usage(utcDay(now));
    const auth = authState(store, env);
    const month = utcDay(now).slice(0, 7);
    const claude = store.claudeUsage(month);
    const lastSync = Number(store.getMeta('last_sync_at') ?? '');
    const synced = Number.isFinite(lastSync) && lastSync > 0 ? lastSync : null;
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
    if (mode !== 'off') {
      const modelError = store.getMeta('claude_error') ?? (env.ANTHROPIC_API_KEY === undefined ? 'claude_not_configured' : '');
      if (store.getMeta('claude_limited_month') === month || claude.cost_micros >= CLAUDE_MONTHLY_LIMIT_MICROS) signals.push(signal('claude_spend_limit', Severity.WARNING, {}));
      else if (modelError !== '' && modelError !== 'claude_spend_limit') signals.push(signal(modelError === 'claude_not_configured' ? modelError : modelError === 'claude_auth' || modelError === 'claude_401' || modelError === 'claude_403' ? 'claude_auth' : 'claude_unavailable', Severity.WARNING, {}));
    }
    signals.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const counters: Record<string, number> = {
      decided_today: usage.decided,
      applied_today: usage.applied,
      unsure_today: usage.unsure,
      review_pending: review,
      pending,
      gmail_calls_today: usage.gmail_calls,
      claude_spent_usd: claude.cost_micros / 1_000_000,
      claude_monthly_limit_usd: CLAUDE_MONTHLY_LIMIT_MICROS / 1_000_000,
      claude_input_tokens: claude.input_tokens,
      claude_cache_write_tokens: claude.cache_write_tokens,
      claude_cache_read_tokens: claude.cache_read_tokens,
      claude_output_tokens: claude.output_tokens,
      ...(claude.thinking_tokens === null ? {} : { claude_thinking_tokens: claude.thinking_tokens }),
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
