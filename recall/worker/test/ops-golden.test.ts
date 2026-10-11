/**
 * contracts/ops-v1: the exact bytes recall's Ops code answers for fixed synthetic state (RecallState's own SQLite, here
 * node:sqlite behind the SqlStorage surface Store uses). Home reads these answers through its RECALL binding: every case
 * is compared as compact JSON with test/golden/ops-v1.json, and two of them are the contract's fixtures
 * (OpsStatus/recall-ok.json, OpsStatus/recall-degraded.json), which proto/'s codecs, Mail Hero's and Todofy's contract
 * tests and the dashboard's reader test as well. `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts` rewrites the
 * golden file (never the fixtures); only for an intended change. A dashboard deployed before ops-v1 moved onto proto/
 * never binds recall, so the answers are checked against the generated schema, not the legacy one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { DAY, HOUR, MIB, MINUTE } from '../src/limits.ts';
import { recallStatus, uiUrl } from '../src/ops-status.ts';
import { Store, utcDay } from '../src/store.ts';

const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const GOLDEN = path('golden/ops-v1.json');
const CONTRACT = path('../../../contracts/ops-v1/');
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${CONTRACT}fixtures/${name}`, 'utf8'));

const NOW = Date.parse('2026-10-10T14:00:00.000Z');
const HOST = 'recall.example.com';
const TODAY = utcDay(NOW);
const YESTERDAY = utcDay(NOW - DAY);

function sqlStorage(databaseSize: number): SqlStorage {
  const db = new DatabaseSync(':memory:');
  return {
    databaseSize,
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

function store(databaseSize = 48 * MIB): Store {
  const value = new Store(sqlStorage(databaseSize));
  value.migrate();
  return value;
}

function device(target: Store, id: string, lastSeenMs: number): void {
  target.insert('devices', { id, label: '合成设备', extension_version: '1.0.0', first_seen_ms: lastSeenMs - 3 * DAY, last_seen_ms: lastSeenMs });
}

function usage(target: Store, day: string, row: Readonly<Record<string, number | string>>): void {
  target.insert('usage', { day, ...row });
}

function cases(): Record<string, unknown> {
  const ok = store();
  device(ok, 'device-a', NOW - 10 * MINUTE);
  ok.insert('consumers', { name: 'nas-archive', synced_seq: 0, last_pull_ms: NOW - 20 * MINUTE });
  usage(ok, TODAY, { rows_written: 4210, rows_read: 18_200, batches: 41, items: 260, visits: 120, long_visits: 38, captures: 36, texts: 34 });
  usage(ok, YESTERDAY, { rows_written: 9100, rows_read: 52_000, visits: 290, long_visits: 90, captures: 88, texts: 85 });

  const degraded = store(870 * MIB);
  device(degraded, 'device-a', NOW - 30 * HOUR);
  // Seen more than 30 days ago: given up, it raises nothing.
  device(degraded, 'device-b', NOW - 40 * DAY);
  degraded.insert('consumers', { name: 'nas-archive', synced_seq: 0, last_pull_ms: NOW - 26 * HOUR });
  const refused = { invalid_item: { count: 3, last_ms: NOW - 2 * HOUR }, unsupported_item: { count: 5, last_ms: NOW - HOUR } };
  usage(degraded, TODAY, { rows_written: 20_001, rows_read: 1_000_000, batches: 12, items: 80, visits: 64, long_visits: 20, captures: 0, texts: 0, refused: JSON.stringify(refused), over_budget: 1 });
  usage(degraded, YESTERDAY, { rows_written: 3000, visits: 70, long_visits: 12, captures: 0 });

  // An archive that pulled an hour ago but has not taken a change committed two days ago.
  const behind = store();
  device(behind, 'device-a', NOW - 5 * MINUTE);
  behind.insert('pages', { id: 'synthetic-page', url: 'https://example.com/', host_key: 'com.example.' });
  behind.insert('visits', {
    id: 'synthetic-visit', seq: 1, seq_ms: NOW - 2 * DAY, page_rowid: 1, device_id: 'device-a', device_label: '合成设备', url: 'https://example.com/',
    title: '合成页面', start_ms: NOW - 2 * DAY, end_ms: NOW - 2 * DAY + MINUTE, focus_seconds: 60, spans: '[]', revision: 1,
  });
  behind.setMeta('seq', '1');
  behind.insert('consumers', { name: 'nas-archive', synced_seq: 0, last_pull_ms: NOW - HOUR });

  const full = store(900 * MIB);
  device(full, 'device-a', NOW - 5 * MINUTE);

  const broken = store();
  broken.run('DROP TABLE usage');
  return {
    'status/ok': recallStatus(ok, HOST, NOW),
    'status/degraded': recallStatus(degraded, HOST, NOW),
    'status/first-day': recallStatus(store(), HOST, NOW),
    'status/archive-behind': recallStatus(behind, HOST, NOW),
    'status/storage-full': recallStatus(full, HOST, NOW),
    'status/no-host': recallStatus(ok, null, NOW),
    'status/unavailable': recallStatus(broken, HOST, NOW),
  };
}

test('every Ops answer for the synthetic states is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});

test("two answers are the contract's recall fixtures, byte for byte", () => {
  const actual = cases();
  expect(JSON.stringify(actual['status/ok'])).toBe(JSON.stringify(fixture('OpsStatus/recall-ok.json')));
  expect(JSON.stringify(actual['status/degraded'])).toBe(JSON.stringify(fixture('OpsStatus/recall-degraded.json')));
});

test('every answer passes the generated schema', () => {
  for (const [name, value] of Object.entries(cases())) expect(validate(SCHEMA, 'OpsStatus', value), name).toEqual([]);
});

test('the signals: warnings make the status degraded, a first day is only information, a full store is critical', () => {
  type Status = { health: string; signals: { code: string; severity: string; metrics: Record<string, number> }[] };
  const all = cases() as Record<string, Status>;
  const degraded = all['status/degraded'] as Status;
  expect(degraded.health).toBe('degraded');
  expect(degraded.signals.map((s) => [s.code, s.severity])).toEqual([
    ['archive_behind', 'warning'],
    ['device_stale', 'warning'],
    ['items_rejected', 'warning'],
    ['no_captures', 'warning'],
    ['reads_over_budget', 'warning'],
    ['storage_high', 'warning'],
    ['upload_over_budget', 'warning'],
  ]);
  // One device is stale (the other was given up); only the lost items count, not the newer extension's.
  expect(degraded.signals.find((s) => s.code === 'device_stale')?.metrics).toEqual({ count: 1, hours: 30 });
  expect(degraded.signals.find((s) => s.code === 'items_rejected')?.metrics).toEqual({ count: 3 });
  expect(all['status/ok']).toMatchObject({ health: 'ok', signals: [] });
  expect(all['status/first-day']).toMatchObject({ health: 'ok', signals: [{ code: 'no_device', severity: 'info' }] });
  expect(all['status/archive-behind']).toMatchObject({ health: 'degraded', signals: [{ code: 'archive_behind', metrics: { count: 1 } }] });
  expect(all['status/storage-full']).toMatchObject({ health: 'degraded', signals: [{ code: 'storage_high', severity: 'critical' }] });
  expect(all['status/unavailable']).toMatchObject({ health: 'down', signals: [{ code: 'status_unavailable', severity: 'critical' }] });
});

test('a status holds counts and codes only: never a URL, a title, a device label or a consumer name', () => {
  const text = JSON.stringify(cases());
  for (const leak of ['https://example.com', '合成', 'device-a', 'nas-archive', 'synthetic-']) expect(text).not.toContain(leak);
  expect(text).toContain(`"ui_url":"https://${HOST}/"`);
});

test('the owner UI URL keeps the contract format, else it is left out', () => {
  expect(uiUrl(HOST)).toBe(`https://${HOST}/`);
  expect(uiUrl(null)).toBeUndefined();
});
