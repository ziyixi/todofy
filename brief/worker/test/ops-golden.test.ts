/**
 * contracts/ops-v1: the exact bytes the brief's Ops code answers for fixed synthetic state (BriefState's own SQLite,
 * here node:sqlite behind the SqlStorage surface Store uses; ../../docs/design.md §15, §17). Home reads these answers
 * through its BRIEF binding: every case is compared as compact JSON with test/golden/ops-v1.json and checked against
 * the generated schema. The archive-ready and degraded answers also match the shared contract fixtures consumed by
 * Home and the other contract readers. `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts` rewrites the golden
 * file (never the contract fixtures); only for an intended change. All state is synthetic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import type { Env } from '../src/env.ts';
import { briefStatus, iso, setGuard } from '../src/ops-status.ts';
import { loadRegistry } from '../src/registry.ts';
import { addDays } from '../src/schedule.ts';
import { writeSettings } from '../src/settings.ts';
import { Store } from '../src/store.ts';
import { SYNTHETIC_REGISTRY } from './fakes/upstream.ts';
import { memorySql } from './fakes/sql.ts';

const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const GOLDEN = path('golden/ops-v1.json');
const CONTRACT = path('../../../contracts/ops-v1/');
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };

// Tuesday 2026-10-13, 09:00 in Los Angeles (PDT): past the send, before the 12:00 cutoff.
const NOW = Date.parse('2026-10-13T16:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const registry = loadRegistry(SYNTHETIC_REGISTRY);
const env: Env = {
  PUBLIC_HOST: 'brief.example.org',
  MODE: 'live',
  BUILD_SHA: 'b'.repeat(40),
  ANTHROPIC_API_KEY: 'sk-ant-synthetic',
  RESEND_API_KEY: 're_synthetic',
  MAIL_FROM: 'Brief <brief@example.org>',
  MAIL_TO: 'reader@example.org',
} as unknown as Env;

function store(): Store {
  const value = new Store(memorySql());
  value.migrate();
  return value;
}

function call(target: Store, issue: string, step: string, cost: number, day: string): void {
  target.insert('calls', { issue, step, attempt: 1, build: 'b'.repeat(40), model: 'claude-opus-5-5', served: 'claude-opus-5-5', state: 'answered', reserved: 0, cost, day, month: day.slice(0, 7), started_ms: NOW - 3 * HOUR, finished_ms: NOW - 3 * HOUR + MINUTE });
}

function cases(): Record<string, unknown> {
  // A normal Tuesday: today's issue sent, a week of issues, today's items screened, a quarter of the month spent.
  const ok = store();
  ok.setMeta('last_alarm_ms', String(NOW - 10 * MINUTE));
  for (const day of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12', '2026-10-13']) {
    ok.insert('issues', { issue: day, kind: day === '2026-10-10' ? 'saturday' : 'weekday', state: 'sent', title: '简报', item_count: 8, dropped_count: 1, created_ms: Date.parse(`${day}T12:00:00Z`), send_ms: Date.parse(`${day}T13:30:00Z`) });
  }
  ok.run(`INSERT INTO usage (day, items, world_items, geo_items, screened, refused, neurons) VALUES ('2026-10-13', 212, 80, 21, 118, 2, 61.3)`);
  call(ok, '2026-10-13', 'write', 0.62, '2026-10-13');
  call(ok, '2026-10-13', 'pick', 0.14, '2026-10-13');
  call(ok, '2026-10-12', 'write', 9.1, '2026-10-12');

  // Archive mode after the send cutoff: a ready issue, no mail credentials, and the owner's saved $80 budget.
  const archive = store();
  archive.setMeta('last_alarm_ms', String(NOW + 4 * HOUR - 10 * MINUTE));
  archive.insert('issues', { issue: '2026-10-13', kind: 'weekday', state: 'archived', title: '简报', item_count: 8, created_ms: NOW - 4 * HOUR });
  writeSettings(archive, { monthlyBudgetUsd: 80 }, NOW - HOUR);
  call(archive, '2026-10-13', 'write', 0.62, '2026-10-13');
  call(archive, '2026-10-13', 'pick', 0.14, '2026-10-13');

  // A bad morning: the key refused (402), today's send unknown, the pick fell back, a source family stale, Home's
  // guard shedding.
  const degraded = store();
  degraded.setMeta('last_alarm_ms', String(NOW - 5 * MINUTE));
  degraded.setJson('anthropic_rejected', { status: 402, type: 'billing_error', key: 'abcdef012345', build: 'b'.repeat(40), ms: NOW - 2 * HOUR });
  degraded.insert('issues', { issue: '2026-10-13', kind: 'weekday', state: 'send_unknown', title: '简报', item_count: 3, dropped_count: 3, pick_fallback: 1, created_ms: NOW - 4 * HOUR });
  degraded.run(`INSERT INTO usage (day, items, screened, refused) VALUES ('2026-10-13', 90, 60, 9)`);
  degraded.pushError('packet_refused');
  const guarded = setGuard(degraded, { level: 'shed', reason: 'ai_neurons_high', until: '2026-10-14T01:00:00Z' }, NOW - 30 * MINUTE);

  // Archive mode before the keys are put; off; a store whose schema broke.
  const fresh = store();
  const broken = store();
  broken.run('DROP TABLE usage');
  // Paused by the owner, with the month's budget spent.
  const paused = store();
  writeSettings(paused, { paused: true, monthlyBudgetUsd: 5 }, NOW - HOUR);
  call(paused, '2026-10-12', 'write', 5.2, '2026-10-12');
  const guards = store();
  return {
    'status/ok': briefStatus(ok, registry, env, NOW),
    'status/archive-ready': briefStatus(archive, registry, { ...env, MODE: 'archive', RESEND_API_KEY: '', MAIL_TO: '' }, NOW + 4 * HOUR),
    'status/shadow-without-mail': briefStatus(ok, registry, { ...env, MODE: 'shadow', MAIL_TO: '' }, NOW),
    'status/degraded': briefStatus(degraded, registry, env, NOW),
    'status/archive-without-keys': briefStatus(fresh, registry, { PUBLIC_HOST: 'brief.example.org', MODE: 'archive' } as unknown as Env, NOW),
    'status/off': briefStatus(fresh, registry, { PUBLIC_HOST: 'brief.example.org' } as unknown as Env, NOW),
    'status/paused-budget-spent': briefStatus(paused, registry, env, NOW),
    'status/unavailable': briefStatus(broken, registry, env, NOW),
    'guard/normal': setGuard(guards, { level: 'normal', reason: 'idle', until: null }, NOW),
    'guard/set-shed': guarded,
    'guard/cleared': setGuard(degraded, { level: 'normal', reason: 'quota_recovered', until: null }, NOW),
    'guard/refused-too-far': setGuard(guards, { level: 'shed', reason: 'x', until: iso(NOW + 40 * HOUR) }, NOW),
    'guard/refused-shape': setGuard(guards, { level: 'off' }, NOW),
  };
}

test('every Ops answer for the synthetic states is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});

test('every answer passes the generated schema; a refusal is invalid_input', () => {
  for (const [name, value] of Object.entries(cases())) {
    const answer = typeof value === 'object' && value !== null && 'ok' in value ? value.ok : value;
    if (typeof answer === 'object' && answer !== null && 'error' in answer) {
      expect(answer, name).toEqual({ error: 'invalid_input' });
      continue;
    }
    expect(validate(SCHEMA, name.startsWith('status/') ? 'OpsStatus' : 'GuardState', answer), name).toEqual([]);
  }
});

test('the shared contract fixtures are the exact archive-ready and degraded answers', () => {
  const actual = cases();
  for (const [name, file] of [['status/archive-ready', 'brief-ok.json'], ['status/degraded', 'brief-degraded.json']] as const) {
    const fixture: unknown = JSON.parse(readFileSync(`${CONTRACT}fixtures/OpsStatus/${file}`, 'utf8'));
    expect(JSON.stringify(actual[name])).toBe(JSON.stringify(fixture));
  }
});

test('archive mode does not require email or a send, but still reports a missing issue and real failures', () => {
  const archive = cases()['status/archive-ready'];
  expect(archive).toMatchObject({ health: 'ok', signals: [], modes: { mode_limited: true }, counters: { issues_sent_7d: 0, budget_month_cents: 8000 } });
  const waiting = briefStatus(store(), registry, { ...env, MODE: 'archive', RESEND_API_KEY: '' }, NOW + 4 * HOUR);
  expect(waiting.signals.map((entry) => entry.code)).toEqual(['issue_late']);
  const failed = store();
  failed.insert('issues', { issue: '2026-10-13', kind: 'weekday', state: 'failed', created_ms: NOW });
  expect(briefStatus(failed, registry, { ...env, MODE: 'archive' }, NOW).signals).toEqual([expect.objectContaining({ code: 'issue_failed', severity: 'critical' })]);
});

test('the refused key and the unknown send are critical; a fallback pick and a refused packet are information', () => {
  const degraded = cases()['status/degraded'] as { health: string; signals: { code: string; severity: string; metrics?: Record<string, number> }[] };
  expect(degraded.health).toBe('degraded');
  expect(degraded.signals.map((s) => [s.code, s.severity])).toEqual([
    ['anthropic_rejected', 'critical'],
    ['send_unknown', 'critical'],
    ['gate_refused_high', 'warning'],
    ['ground_drop_high', 'warning'],
    ['guard_shed', 'info'],
    ['packet_refused', 'info'],
    ['pick_fallback', 'info'],
  ]);
  expect(degraded.signals[0]?.metrics).toEqual({ billing_error: 1, status: 402 });
  const ok = cases()['status/ok'] as { health: string; signals: unknown[]; counters: Record<string, number>; modes: Record<string, boolean> };
  expect(ok).toMatchObject({ health: 'ok', signals: [], modes: { maintenance: false, paused: false, mode_limited: false } });
  expect(ok.counters).toMatchObject({ issues_sent_7d: 5, items_today: 212, candidates_today: 118, cost_today_cents: 76, budget_month_cents: 4000 });
});

test('switched off, the brief says so as information and warns of nothing an issue would hold; a refused key stays critical', () => {
  // A stale source, and yesterday's geo and world candidates far below the two weeks before.
  const quiet = store();
  quiet.insert('sources', { id: 'seis-journal', state: 'ok', last_attempt_ms: NOW, last_success_ms: NOW, first_ms: NOW - 60 * 24 * HOUR, last_item_ms: NOW - 40 * 24 * HOUR });
  for (let back = 14; back >= 2; back--) quiet.insert('usage', { day: addDays('2026-10-13', -back), items: 100, world_items: 80, geo_items: 20 });
  quiet.insert('usage', { day: '2026-10-12', items: 10, world_items: 5, geo_items: 1 });
  const codes = (status: { readonly signals: readonly { code: string; severity: string }[] }): string[][] => status.signals.map((s) => [s.code, s.severity]);
  expect(codes(briefStatus(quiet, registry, env, NOW))).toEqual([['issue_late', 'warning'], ['section_thin', 'warning'], ['sources_stale', 'warning']]);
  const off = briefStatus(quiet, registry, { ...env, MODE: 'off' }, NOW);
  expect(off).toMatchObject({ health: 'ok', modes: { mode_limited: true }, counters: { sources_stale: 1 } });
  expect(codes(off)).toEqual([['brief_off', 'info']]);
  quiet.setJson('anthropic_rejected', { status: 401, type: 'authentication_error', key: 'abcdef012345', build: 'b'.repeat(40), ms: NOW - HOUR });
  const rejected = briefStatus(quiet, registry, { ...env, MODE: 'off' }, NOW);
  expect(rejected.health).toBe('degraded');
  expect(codes(rejected)).toEqual([['anthropic_rejected', 'critical'], ['brief_off', 'info']]);
});

test('a status holds counts and codes only: never a title, a key, an address or a source name', () => {
  const text = JSON.stringify(cases());
  for (const leak of ['简报', 'sk-ant', 're_synthetic', 'reader@', 'abcdef012345', 'Seismica']) expect(text).not.toContain(leak);
});
