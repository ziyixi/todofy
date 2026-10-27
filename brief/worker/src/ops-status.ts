/**
 * ops-v1 for the brief (../../docs/design.md §15, contracts/ops-v1, proto/ops/v1/ops.proto): status() and setGuard(),
 * built only from BriefState's own SQLite, with counts and codes only: never a title, a text or an address.
 *
 * Counters: items_today, candidates_today, gate_refused_today, sources_failing, sources_stale, issues_sent_7d,
 * last_issue_age_hours, cost_today_cents, cost_month_cents, budget_month_cents, neurons_today. Modes: maintenance
 * (always false), paused, mode_limited (BRIEF_MODE below live).
 *
 * Signals (design §15): anthropic_rejected (critical, the status and the error type as metrics), budget_spent (critical
 * when it blocked an issue, else info), issue_failed, send_unknown, send_rejected (critical); anthropic_not_configured,
 * mail_not_configured, issue_late, issue_missed, gate_refused_high, ground_drop_high, sources_stale, section_thin,
 * scheduler_stale (warning); pick_fallback, packet_refused, issue_empty, entail_skipped, sources_degraded, guard_shed,
 * brief_off (info: BRIEF_MODE=off, no issue is made; sources_stale and section_thin, about what one would hold, are
 * then not raised).
 *
 * The guard (Home's 80 % rule) defers embedding, the weekly learning and the daily probe of paused sources, never an
 * issue.
 */
import { create } from '@ziyixi/proto/protobuf';
import { file_ops_v1_ops, GuardLevel, GuardStateSchema, Health, OpsService, OpsStatusSchema, Severity, SignalSchema, type GuardState, type Signal } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fieldRules, formatMatches, fromWireArguments, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import { mode, publicHost, type Env } from './env.ts';
import { DROP_WARN, GATE_REFUSED_WARN, HOUR, SCHEDULER_STALE_MS } from './limits.ts';
import type { Registry } from './registry.ts';
import { addDays, issueKind, lateTimeOf, localDate, sendCutoffOf } from './schedule.ts';
import { statusNumbers } from './status.ts';
import type { IssueRow, Store } from './store.ts';

/** The jobs a shed defers (GuardState.deferred). */
export const DEFERRED_JOBS = ['embedding', 'learning', 'source_probe'] as const;

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
  return { ok: toWire(GuardStateSchema, guardMessage(store, now)) };
}

// ---- status ---------------------------------------------------------------------------------------------------------

function signal(code: string, severity: Severity, metrics: Record<string, number> = {}, since?: number): Signal {
  return create(SignalSchema, { code, severity, metrics, ...(since === undefined ? {} : { since: iso(since) }) });
}

function uiUrl(host: string | null): string | undefined {
  if (host === null) return undefined;
  const url = `https://${host}/`;
  return formatMatches(file_ops_v1_ops, 'HttpsUrl', url) ? url : undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
}

/** status(): a few indexed counts and meta rows. */
export function briefStatus(store: Store, registry: Registry, env: Env, now: number): wire.OpsStatus {
  const url = uiUrl(publicHost(env));
  const deployment = mode(env);
  const base = { version: 'ops-v1', app: 'brief', generatedAt: iso(now), ...(url === undefined ? {} : { uiUrl: url }), capabilities: ['guard'] };
  try {
    const numbers = statusNumbers(store, registry, env, now);
    const guard = guardMessage(store, now);
    const today = localDate(now);
    const signals: Signal[] = [];
    const making = deployment !== 'off';
    // Switched off: no issue is made. Said as information; a refused key or a send's outcome still counts.
    if (!making) signals.push(signal('brief_off', Severity.INFO));
    if (numbers.keyState === 'rejected') {
      const metrics: Record<string, number> = { status: numbers.rejectedStatus };
      const reason = numbers.rejectedType.toLowerCase();
      if (/^[a-z][a-z0-9_]{0,47}$/.test(reason)) metrics[reason] = 1;
      signals.push(signal('anthropic_rejected', Severity.CRITICAL, metrics));
    }
    if (making && numbers.keyState === 'not_configured') signals.push(signal('anthropic_not_configured', Severity.WARNING));
    if ((deployment === 'shadow' || deployment === 'live') && !numbers.mailConfigured) signals.push(signal('mail_not_configured', Severity.WARNING));
    // The latest issue of the last two days: its outcome.
    const latest = store.one<IssueRow>(`SELECT * FROM issues WHERE issue >= ? ORDER BY issue DESC LIMIT 1`, addDays(today, -1));
    if (latest !== undefined) {
      if (latest.state === 'send_unknown') signals.push(signal('send_unknown', Severity.CRITICAL));
      if (latest.state === 'send_rejected') signals.push(signal('send_rejected', Severity.CRITICAL));
      if (latest.state === 'failed' || latest.quiet_reason === 'write_failed') signals.push(signal('issue_failed', Severity.CRITICAL));
      if (latest.quiet_reason === 'budget_spent') signals.push(signal('budget_spent', Severity.CRITICAL, { budget_cents: Math.round(numbers.budget * 100) }));
      if (['no_candidates', 'not_scored', 'none_grounded', 'no_readable_thread'].includes(latest.quiet_reason)) signals.push(signal('issue_empty', Severity.INFO));
      if (latest.pick_fallback === 1) signals.push(signal('pick_fallback', Severity.INFO));
      if (latest.item_count + latest.dropped_count > 0 && latest.dropped_count / (latest.item_count + latest.dropped_count) > DROP_WARN) signals.push(signal('ground_drop_high', Severity.WARNING, { dropped: latest.dropped_count }));
    }
    if (numbers.monthCost + numbers.reserved >= numbers.budget && latest?.quiet_reason !== 'budget_spent') signals.push(signal('budget_spent', Severity.INFO, { budget_cents: Math.round(numbers.budget * 100) }));
    // Issue days: late past 07:30 with nothing ready; missed past 12:00 with nothing sent.
    if (making && issueKind(today) !== null && numbers.keyState === 'ok' && !numbers.paused) {
      const todays = latest?.issue === today ? latest : undefined;
      const sent = todays !== undefined && ['sent', 'send_unknown', 'send_rejected'].includes(todays.state);
      if (now >= sendCutoffOf(today) && !sent && deployment !== 'archive') signals.push(signal('issue_missed', Severity.WARNING));
      else if (now >= lateTimeOf(today) && (todays === undefined || todays.state === 'building')) signals.push(signal('issue_late', Severity.WARNING));
    }
    const errors = store.recentErrors();
    if (errors.includes('packet_refused')) signals.push(signal('packet_refused', Severity.INFO));
    if (errors.includes('entail_skipped')) signals.push(signal('entail_skipped', Severity.INFO));
    if (numbers.todayScreened >= 20 && numbers.todayRefused / numbers.todayScreened > GATE_REFUSED_WARN) signals.push(signal('gate_refused_high', Severity.WARNING, { refused: numbers.todayRefused, screened: numbers.todayScreened }));
    if (making && numbers.health.stale > 0) signals.push(signal('sources_stale', Severity.WARNING, { count: numbers.health.stale }));
    if (numbers.health.paused >= 5) signals.push(signal('sources_degraded', Severity.INFO, { count: numbers.health.paused }));
    // Geo research or world candidates below 30% of their 14-day median: a blocked publisher or a broken query.
    const days = making ? store.all<{ day: string; geo_items: number; world_items: number }>(`SELECT day, geo_items, world_items FROM usage WHERE day >= ? AND day < ?`, addDays(today, -14), today) : [];
    if (days.length >= 7) {
      const yesterday = store.usage(addDays(today, -1));
      const geo = median(days.map((day) => day.geo_items));
      const world = median(days.map((day) => day.world_items));
      if ((geo > 0 && yesterday.geo_items < 0.3 * geo) || (world > 0 && yesterday.world_items < 0.3 * world)) signals.push(signal('section_thin', Severity.WARNING, { geo: yesterday.geo_items, world: yesterday.world_items }));
    }
    const progress = Number(store.getMeta('last_alarm_ms') ?? '');
    if (Number.isFinite(progress) && progress > 0 && now - progress > SCHEDULER_STALE_MS) signals.push(signal('scheduler_stale', Severity.WARNING, { hours: Math.floor((now - progress) / HOUR) }, progress));
    if (guard.level === GuardLevel.SHED && guard.until !== undefined) signals.push(signal('guard_shed', Severity.INFO, { seconds_left: Math.max(0, Math.round((Date.parse(guard.until) - now) / 1000)) }));
    const seen = new Set<string>();
    const unique = signals.filter((entry) => (seen.has(entry.code) ? false : (seen.add(entry.code), true)));
    unique.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    const sent7 = store.count(`SELECT count(*) AS n FROM issues WHERE issue >= ? AND state = 'sent'`, addDays(today, -7));
    const lastIssue = store.one<{ created_ms: number }>(`SELECT created_ms FROM issues ORDER BY issue DESC LIMIT 1`);
    const counters: Record<string, number> = {
      items_today: numbers.todayItems,
      candidates_today: numbers.todayScreened,
      gate_refused_today: numbers.todayRefused,
      sources_failing: numbers.health.failing + numbers.health.paused,
      sources_stale: numbers.health.stale,
      issues_sent_7d: sent7,
      cost_today_cents: Math.round(numbers.todayCost * 100),
      cost_month_cents: Math.round(numbers.monthCost * 100),
      budget_month_cents: Math.round(numbers.budget * 100),
      neurons_today: Math.round(numbers.todayNeurons),
    };
    if (lastIssue !== undefined) counters['last_issue_age_hours'] = Math.floor((now - lastIssue.created_ms) / HOUR);
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: unique.some((entry) => entry.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
        modes: { maintenance: false, paused: numbers.paused, mode_limited: deployment !== 'live' },
        guard,
        signals: unique.slice(0, MAX_SIGNALS),
        counters,
      }),
    );
  } catch {
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: Health.DOWN,
        modes: { maintenance: false, mode_limited: deployment !== 'live' },
        guard: { level: GuardLevel.NORMAL },
        signals: [signal('status_unavailable', Severity.CRITICAL)],
      }),
    );
  }
}
