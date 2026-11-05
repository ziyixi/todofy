/** SQLite-backed bounded control storage and HomeState migrations/edge cases, independent of workerd. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ATTENTION_ROW_LIMIT, ATTENTION_SCHEMA, AttentionState, migrateAttentionSequence } from '../src/attention-state.ts';
import type { Attention, AttentionItem, CloudflareView } from '../src/api-types.ts';
import type { Env } from '../src/env.ts';
import { GUARD_APPS, HomeState, dropRemovedApps, migrateGuardApplied } from '../src/state.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(ATTENTION_SCHEMA);
  database.exec('CREATE TABLE state (key TEXT PRIMARY KEY,doc TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  const rows = <T extends Record<string, SqlStorageValue>>(query: string, ...values: SqlStorageValue[]): T[] =>
    database.prepare(query).all(...values as SQLInputValue[]) as T[];
  const storage = {
    transactionSync: <T>(fn: () => T): T => fn(),
    sql: {
      exec: (query: string, ...values: SqlStorageValue[]) => {
        const result = rows(query, ...values);
        return { toArray: () => result, rowsRead: result.length };
      },
    },
  } as unknown as DurableObjectStorage;
  const ctx = {
    storage,
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  } as unknown as DurableObjectState;
  return { database, storage, ctx, rows, ledger: new AttentionState(storage, rows), restart: () => new AttentionState(storage, rows) };
}
const item = (code: string): AttentionItem => ({ source: 'newsletter', code, severity: 'warning', since: null, metrics: {}, target: { view: 'ops', entry: 'newsletter' } });
const attention = (items: AttentionItem[]): Attention => ({ level: 'warning', items, info: [], held: [] });
function controlled(entry: AttentionItem | undefined): AttentionItem & { name: string; etag: string } {
  if (!entry?.name || !entry.etag) throw new Error('missing synthetic revision');
  return entry as AttentionItem & { name: string; etag: string };
}

describe('bounded reminder dispositions', () => {
  it('keeps dismissed configuration warnings closed while source clocks and ages advance', () => {
    const { database, ledger, restart } = fixture();
    try {
      const warning = { ...item('newsletter_config_failed'), metrics: { newsletter_config_attempt_age_seconds: 300 } };
      const first = controlled(ledger.project(attention([warning]), NOW, () => false).attention.items[0]);
      const closed = ledger.change(first.name, first.etag, true, NOW);
      const next = restart().project(attention([{ ...warning, metrics: { newsletter_config_attempt_age_seconds: 900 } }]), NOW + 600_000, () => false);
      expect(next.attention.items).toEqual([]);
      expect(next.attention.dismissed_items?.[0]?.etag).toBe(closed?.etag);
    } finally { database.close(); }
  });
  it('keeps the immutable sequence through owner changes and restart, and advances only for a new episode', () => {
    const { database, ledger, restart } = fixture();
    try {
      const first = controlled(ledger.project(attention([item('delivery_failed')]), NOW, () => false).attention.items[0]);
      const baseline = ledger.poll(0);
      expect(baseline.attention).toHaveLength(1);
      const initialSeq = baseline.head_seq;
      const dismissed = ledger.change(first.name, first.etag, true, NOW);
      expect(ledger.poll(0)).toEqual({ attention: [], head_seq: initialSeq });
      const restored = ledger.change(first.name, dismissed?.etag ?? '', false, NOW + 1);
      expect(restored?.etag).not.toBe(first.etag);
      expect(ledger.poll(initialSeq).attention).toEqual([]);
      const resumed = restart();
      resumed.project(attention([item('delivery_failed')]), NOW + 2, () => false);
      expect(resumed.poll(0).attention[0]?.occurrence_seq).toBe(initialSeq);
      resumed.project(attention([{ ...item('delivery_failed'), metrics: { count: 2 } }]), NOW + 3, () => false);
      const changedSeq = resumed.poll(initialSeq).head_seq;
      expect(changedSeq).toBeGreaterThan(initialSeq);
      resumed.project(attention([]), NOW + 4, () => true);
      expect(resumed.poll(0)).toEqual({ attention: [], head_seq: changedSeq });
      resumed.project(attention([{ ...item('delivery_failed'), metrics: { count: 2 } }]), NOW + 5, () => false);
      expect(resumed.poll(changedSeq).attention[0]?.occurrence_seq).toBeGreaterThan(changedSeq);
      expect(() => resumed.poll(resumed.poll(0).head_seq + 1)).toThrow('invalid_input');
    } finally { database.close(); }
  });

  it('migrates existing controls without changing their owner decision or etag', () => {
    const { database, storage, ledger } = fixture();
    try {
      const first = controlled(ledger.project(attention([item('delivery_failed')]), NOW, () => false).attention.items[0]);
      const dismissed = ledger.change(first.name, first.etag, true, NOW);
      database.exec('ALTER TABLE attention_occurrences DROP COLUMN occurrence_seq');
      database.exec("DELETE FROM state WHERE key='attention_sequence'");
      migrateAttentionSequence(storage);
      const current = ledger.project(attention([item('delivery_failed')]), NOW + 1, () => false);
      expect(current.attention.dismissed_items?.[0]).toMatchObject({ etag: dismissed?.etag });
      expect(ledger.poll(0)).toEqual({ attention: [], head_seq: 1 });
      expect(database.prepare('SELECT occurrence_seq FROM attention_occurrences').get()?.occurrence_seq).toBe(1);
    } finally { database.close(); }
  });

  it('does not confuse unknown codes with Object prototype properties', () => {
    const { database, ledger } = fixture();
    try {
      const result = ledger.project(attention([item('constructor'), item('toString')]), NOW, () => false);
      expect(result.attention.items).toHaveLength(2);
      expect(result.attention.items.every((entry) => entry.name && entry.etag)).toBe(true);
    } finally { database.close(); }
  });

  it('retires only absent undismissed rows and keeps an absent owner decision under pressure', () => {
    const { database, ledger } = fixture();
    try {
      const initial = Array.from({ length: ATTENTION_ROW_LIMIT }, (_unused, index) => item(`old_${String(index)}`));
      const result = ledger.project(attention(initial), NOW, () => false);
      const old = controlled(result.attention.items[0]);
      const closed = ledger.change(old.name, old.etag, true, NOW);
      ledger.project(attention([item('new_condition')]), NOW, () => false);
      const returned = ledger.project(attention([old, item('new_condition')]), NOW, () => false);
      expect(returned.attention.dismissed_items?.[0]?.etag).toBe(closed?.etag);
      expect(returned.attention.items.find((entry) => entry.code === 'new_condition')?.etag).toBeDefined();
      expect(database.prepare('SELECT count(*) n FROM attention_occurrences').get()?.n).toBe(ATTENTION_ROW_LIMIT);
    } finally { database.close(); }
  });

  it('the 257th current condition stays visible with explicit control degradation', () => {
    const { database, ledger } = fixture();
    try {
      const initial = Array.from({ length: ATTENTION_ROW_LIMIT }, (_unused, index) => item(`current_${String(index)}`));
      const result = ledger.project(attention(initial), NOW, () => false);
      for (const entry of result.attention.items) { const current = controlled(entry); ledger.change(current.name, current.etag, true, NOW); }
      const overflow = ledger.project(attention([...initial, item('one_more')]), NOW, () => false);
      expect(overflow.attention.items).toMatchObject([{ code: 'one_more' }]);
      expect(overflow.attention.dismissed_items).toHaveLength(ATTENTION_ROW_LIMIT);
      expect(overflow.attention.control_unavailable_count).toBe(1);
      expect(ledger.poll(0)).toEqual({ attention: [], head_seq: ATTENTION_ROW_LIMIT });
      expect(database.prepare('SELECT count(*) n FROM attention_occurrences').get()?.n).toBe(ATTENTION_ROW_LIMIT);
    } finally { database.close(); }
  });
});

describe('HomeState SQLite migrations and unit edge cases', () => {
  it('rebuilds a guard_applied table with an app CHECK and drops removed ops-v1 app rows', () => {
    const { database, storage } = fixture();
    try {
      database.exec(`CREATE TABLE guard_applied (
        app TEXT PRIMARY KEY CHECK (app IN ('mail-hero', 'todofy', 'former-app')),
        input TEXT, state TEXT, last_call_at INTEGER, last_error TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO guard_applied (app, input, consecutive_failures) VALUES
        ('mail-hero', '{"level":"shed"}', 0),
        ('todofy', '{"level":"shed"}', 1),
        ('former-app', '{"level":"normal"}', 0);
      INSERT INTO state (key, doc, updated_at) VALUES
        ('status:mail-hero', '{}', 1),
        ('status:former-app', '{}', 1),
        ('guard_override:former-app', '{}', 1);`);

      migrateGuardApplied(storage);
      // Second call is a no-op once CHECK is gone.
      migrateGuardApplied(storage);
      dropRemovedApps(storage);

      const ddl = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guard_applied'").get() as { sql: string }).sql;
      expect(ddl).not.toContain('CHECK');
      const apps = database.prepare('SELECT app FROM guard_applied ORDER BY app').all() as { app: string }[];
      expect(apps.map((r) => r.app)).toEqual(['mail-hero', 'todofy']);
      const formerState = database.prepare("SELECT count(*) AS n FROM state WHERE key GLOB '*former-app'").get() as { n: number };
      expect(formerState.n).toBe(0);
      const keptState = database.prepare("SELECT count(*) AS n FROM state WHERE key = 'status:mail-hero'").get() as { n: number };
      expect(keptState.n).toBe(1);
    } finally { database.close(); }
  });

  it('migrates legacy global guard_override once, validates readHome cursors, and cleans up orphan probes', async () => {
    const { database, ctx } = fixture();
    const env = {
      ACCOUNT_ID: '0'.repeat(32),
      CF_ANALYTICS_TOKEN: '',
      BUILD_SHA: 'unittest123',
      CANARY_UTC_HOUR: '23',
    } as unknown as Env;
    try {
      const legacy = { level: 'shed', until: NOW + 23 * 3_600_000, set_at: NOW - 3_600_000 };
      database.prepare('INSERT INTO state (key, doc, updated_at) VALUES (?, ?, ?)').run('guard_override', JSON.stringify(legacy), legacy.set_at);
      database.prepare('INSERT INTO state (key, doc, updated_at) VALUES (?, ?, ?)').run('probe:orphan-app', '{"checked_at":1,"ok":true}', 1);

      const home = new HomeState(ctx, env);
      expect(database.prepare("SELECT doc FROM state WHERE key = 'guard_override'").get()).toBeUndefined();
      for (const app of GUARD_APPS) {
        const row = database.prepare('SELECT doc FROM state WHERE key = ?').get(`guard_override:${app}`) as { doc: string } | undefined;
        expect(JSON.parse(row?.doc ?? 'null')).toEqual(legacy);
      }

      for (const invalid of [-1, 0.5, 2_147_483_648]) {
        await expect(home.readHome(invalid, NOW)).rejects.toThrow('invalid_input');
      }
      const snapshot = await home.readHome(0, NOW);
      expect(snapshot.build).toBe('unittest123');
      expect(snapshot.head_seq).toBe(0);

      // Stub fetch so probes and any outbound calls resolve immediately, then run a tick to trigger dropOrphanProbes().
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('User-agent: *\n', { status: 200, headers: { 'content-type': 'text/plain' } })));
      await home.tick(NOW);
      expect(database.prepare("SELECT doc FROM state WHERE key = 'probe:orphan-app'").get()).toBeUndefined();
      expect(database.prepare("SELECT doc FROM state WHERE key = 'probe:website'").get()).toBeDefined();
    } finally { database.close(); }
  });

  it('records too_large when a drift_run exceeds DRIFT_RUN_MAX_BYTES and catches unexpected runDrift exceptions in tick()', async () => {
    const { database, ctx } = fixture();
    const env = {
      ACCOUNT_ID: '0'.repeat(32),
      CF_ANALYTICS_TOKEN: 'synthetic-token',
      BUILD_SHA: 'unit-test',
      CANARY_UTC_HOUR: '23',
    } as unknown as Env;
    try {
      const home = new HomeState(ctx, env);
      const desiredHash = (home as unknown as { desiredHash: string }).desiredHash;
      // Build a drift_run between 60,001 and 65,536 bytes so SQLite accepts it and runTooLarge(result.run) is true.
      const hugeScripts = Array.from({ length: 1100 }, (_, i) => `synthetic-script-padding-${String(i).padStart(4, '0')}-${'x'.repeat(24)}`);
      const oversizedRun = {
        desired_hash: desiredHash,
        day: '2026-10-03',
        started_at: NOW,
        audit_since: NOW - 86_400_000,
        account: { scripts: hugeScripts, domains: [], routes: [], changes: [], zones_unchecked: 0, truncated: false },
        pending: ['home'],
        scripts: {},
        attempts: 0,
      };
      const serializedRun = JSON.stringify(oversizedRun);
      expect(serializedRun.length).toBeGreaterThan(60_000);
      expect(serializedRun.length).toBeLessThanOrEqual(65_536);
      database.prepare('INSERT INTO state (key, doc, updated_at) VALUES (?, ?, ?)').run(
        'drift',
        JSON.stringify({ desired_hash: desiredHash, checked_at: null, desired_workers: 18, counts: {}, findings: [], zones_unchecked: 0, truncated: false, audit_until: null, audit_unchecked: false, last_run_day: null, running_day: '2026-10-03', last_error: null, last_error_step: null, last_error_at: null, consecutive_failed_days: 0 }),
        NOW,
      );
      database.prepare('INSERT INTO state (key, doc, updated_at) VALUES (?, ?, ?)').run('drift_run', serializedRun, NOW);

      vi.stubGlobal('fetch', () => Promise.resolve(new Response('error', { status: 500 })));
      const viewBody = await home.view('cloudflare', true, null, NOW);
      const cf = JSON.parse(viewBody.body ?? '{}') as CloudflareView;
      expect(cf.drift.last_error).toBe('too_large');
      expect(cf.drift.last_error_step).toBe('script');
      expect(database.prepare("SELECT doc FROM state WHERE key = 'drift_run'").get()).toBeUndefined();

      // Now verify tick() catches and logs an unexpected runDrift exception without aborting the tick.
      const logSpy = vi.spyOn(console, 'log');
      vi.spyOn(home as unknown as { runDrift: () => Promise<never> }, 'runDrift').mockRejectedValueOnce(new Error('boom'));
      const tickResult = await home.tick(NOW + 30 * 60_000);
      expect(tickResult).toEqual({ ran: true });
      expect(logSpy.mock.calls.map((args) => String(args[0]))).toContain('{"event":"drift","outcome":"exception"}');
    } finally { database.close(); }
  });
});

