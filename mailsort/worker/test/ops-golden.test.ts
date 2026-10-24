/**
 * contracts/ops-v1: the exact bytes mailsort's Ops code answers for fixed synthetic state (MailsortState's own SQLite,
 * here node:sqlite behind the SqlStorage surface Store uses). The dashboard reads these answers: every case is compared
 * as compact JSON with test/golden/ops-v1.json. The frozen contract fixtures remain independently valid historical
 * examples. UPDATE_GOLDEN=1 rewrites only the local golden file, for an intended current-output change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { guardState, iso, setGuard, sortStatus, uiUrl } from '../src/ops-status.ts';
import { writeSettings, DEFAULTS } from '../src/settings.ts';
import { Store } from '../src/store.ts';

const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const GOLDEN = path('golden/ops-v1.json');
const CONTRACT = path('../../../contracts/ops-v1/');
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${CONTRACT}fixtures/${name}`, 'utf8'));

const NOW = Date.parse('2026-10-06T14:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GRANT = { GMAIL_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'synthetic', GMAIL_REFRESH_TOKEN: 'synthetic' };
const env = { CLASSIFICATION_TOKEN_SHA256: 'a'.repeat(64), PUBLIC_HOST: 'sort.example.com', MODE: 'live', ...GRANT };

function sqlStorage(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...params: SQLInputValue[]) {
      const statement = db.prepare(query);
      if (statement.columns().length > 0) {
        const rows = statement.all(...params).map((row) => ({ ...row }));
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const { changes } = statement.run(...params);
      return { toArray: () => [], rowsRead: 0, rowsWritten: Number(changes) };
    },
  } as unknown as SqlStorage;
}

function store(): Store {
  const value = new Store(sqlStorage());
  value.migrate();
  return value;
}

function usage(target: Store, decided: number, applied: number, unsure: number, neurons: number): void {
  target.run(`INSERT INTO usage (day, gmail_calls, ai_calls, neurons, decided, applied, unsure) VALUES ('2026-10-06', 120, ?, ?, ?, ?, ?)`, decided, neurons, decided, applied, unsure);
}

function cases(): Record<string, unknown> {
  const ok = store();
  writeSettings(ok, { ...DEFAULTS, mode: 'live' }, NOW - HOUR);
  usage(ok, 34, 21, 6, 1520.4);
  ok.setMeta('auth_state', 'ok');
  ok.setMeta('last_sync_at', String(NOW - 4 * MINUTE));
  ok.run(`INSERT INTO pending (message_id, added_at) VALUES ('a1', ?)`, NOW);
  ok.run(`INSERT INTO review (id, message_id, kind, state, decider, subject, sender, receive_time, create_time) VALUES ('r1', 'a2', 'unsure', 'pending', 'clef', '合成主题', 'Sender <example.org>', ?, ?)`, NOW, NOW);

  const degraded = store();
  writeSettings(degraded, { ...DEFAULTS, mode: 'live', breaker: 'daily_limit' }, NOW - HOUR);
  usage(degraded, 160, 150, 3, 8100);
  degraded.run(`UPDATE usage SET quota_exhausted = 1`);
  degraded.setMeta('auth_state', 'failed');
  degraded.setMeta('auth_failures', '3');
  degraded.setMeta('last_sync_at', String(NOW - 3 * HOUR));
  const shed = { level: 'shed', reason: 'usage_80', until: '2026-10-07T01:00:00Z' };
  const guarded = setGuard(degraded, shed);

  const unconfigured = store();
  const stale = store();
  stale.setMeta('auth_state', 'ok');
  stale.setMeta('last_sync_at', String(NOW - 2 * HOUR));
  const broken = store();
  broken.run('DROP TABLE usage');
  return {
    'status/ok': sortStatus(ok, env, NOW),
    'status/forced-shadow': sortStatus(ok, { ...env, MODE: 'shadow' }, NOW),
    'status/degraded': sortStatus(degraded, env, NOW),
    'status/not-configured': sortStatus(unconfigured, { PUBLIC_HOST: 'sort.example.com', MODE: 'shadow', CLASSIFICATION_TOKEN_SHA256: 'a'.repeat(64) }, NOW),
    'status/off': sortStatus(unconfigured, { PUBLIC_HOST: 'sort.example.com', MODE: 'off' }, NOW),
    'status/sync-stale': sortStatus(stale, env, NOW),
    'status/unavailable': sortStatus(broken, env, NOW),
    'guard/normal': guardState(),
    'guard/rejected-shed': guarded,
    'guard/cleared': setGuard(degraded, { level: 'normal', reason: 'quota_recovered', until: null }),
  };
}

test('every Ops answer for the synthetic states is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});

test('the frozen historical mailsort contract fixtures still pass the schema', () => {
  for (const name of ['OpsStatus/mailsort-ok.json', 'OpsStatus/mailsort-degraded.json']) {
    expect(validate(SCHEMA, 'OpsStatus', fixture(name)), name).toEqual([]);
  }
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

test('the auth failure is critical (it reaches Home attention and the digest); the rest are warnings or information', () => {
  const degraded = cases()['status/degraded'] as { health: string; signals: { code: string; severity: string }[]; modes: Record<string, boolean> };
  expect(degraded.health).toBe('degraded');
  expect(degraded.signals.map((s) => [s.code, s.severity])).toEqual([
    ['gmail_auth_failed', 'critical'],
    ['breaker_tripped', 'warning'],
  ]);
  expect(degraded.modes).toMatchObject({ live: false, breaker: true });
});

test('a status holds counts and codes only: never a subject, a sender or a label', () => {
  const text = JSON.stringify(cases());
  for (const leak of ['合成主题', 'example.org', 'Sender', 'synthetic.apps']) expect(text).not.toContain(leak);
});

test('the owner UI URL keeps the contract format, else it is left out', () => {
  expect(uiUrl('sort.example.com')).toBe('https://sort.example.com/');
  expect(uiUrl(null)).toBeUndefined();
});

test('does not advertise retired model budgets or shedding, and rejects a new shed', () => {
  const target = store();
  target.setMeta('guard_until', String(NOW + HOUR));
  target.setMeta('guard_set_at', String(NOW - HOUR));
  target.setMeta('guard_reason', 'historical_ai_budget');
  target.run(`INSERT INTO usage (day, neurons, quota_exhausted) VALUES ('2026-10-06', 9999, 1)`);
  const status = sortStatus(target, env, NOW);
  expect(status.capabilities).toEqual([]);
  expect(status.guard).toMatchObject({ level: 'normal', deferred: [] });
  expect(status.signals.map(item => item.code)).not.toContain('ai_quota_exhausted');
  expect(status.signals.map(item => item.code)).not.toContain('guard_shed');
  expect(status.counters).not.toHaveProperty('neuron_budget');
  expect(status.counters).not.toHaveProperty('neurons_today');
  expect(setGuard(target, { level: 'shed', reason: 'usage_80', until: iso(NOW + HOUR) })).toEqual({ error: 'invalid_input' });
  expect(setGuard(target, { level: 'bogus' })).toEqual({ error: 'invalid_input' });
  expect(setGuard(target, { level: 'normal', reason: 'quota_recovered', until: null })).toMatchObject({ ok: { level: 'normal', deferred: [] } });
  expect(target.getMeta('guard_reason')).toBeNull();
});
