/**
 * contracts/ops-v1: the exact bytes the links app's Ops answers for fixed synthetic facts (src/ops-status.ts). Home reads
 * them through its LINKS binding. The healthy and degraded answers are the shared contract fixtures
 * OpsStatus/links-ok.json and OpsStatus/links-degraded.json, which Home and the other contract readers consume; every
 * answer passes the generated schema. All facts are synthetic.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { linksStatus } from '../src/ops-status.ts';

const CONTRACT = decodeURIComponent(new URL('../../../contracts/ops-v1/', import.meta.url).pathname);
const SCHEMA = JSON.parse(readFileSync(`${CONTRACT}ops-v1.schema.json`, 'utf8')) as { $defs: Record<string, unknown> };
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${CONTRACT}fixtures/OpsStatus/${name}`, 'utf8'));

const NOW = Date.parse('2026-10-28T06:00:00Z');
const HOUR = 3_600_000;
const host = 's.example.org';

test('a backup half an hour old: healthy, with its age and time', () => {
  const answer = linksStatus({
    now: NOW,
    host,
    database: true,
    backup: { status: 'ok', last_backup_at: NOW - HOUR / 2, since: NOW - 40 * 24 * HOUR },
  });
  expect(JSON.stringify(answer)).toBe(JSON.stringify(fixture('links-ok.json')));
  expect(validate(SCHEMA, 'OpsStatus', answer)).toEqual([]);
});

test('no complete backup for four days and the last job failed: degraded, stale first', () => {
  const answer = linksStatus({
    now: NOW,
    host,
    database: true,
    backup: { status: 'failed', last_backup_at: NOW - 4 * 24 * HOUR, since: NOW - 40 * 24 * HOUR },
  });
  expect(JSON.stringify(answer)).toBe(JSON.stringify(fixture('links-degraded.json')));
  expect(validate(SCHEMA, 'OpsStatus', answer)).toEqual([]);
});

test('before the first backup, without the bucket, and without the database', () => {
  const never = linksStatus({ now: NOW, host, database: true, backup: { status: 'never', last_backup_at: null, since: null } });
  expect(never).toMatchObject({ health: 'ok', signals: [], counters: { database_ready: 1 }, last_backup_at: null });
  expect(linksStatus({ now: NOW, host, database: true, backup: null })).toEqual(never);
  const down = linksStatus({ now: NOW, host: null, database: false, backup: null });
  expect(down).toMatchObject({ health: 'down', signals: [{ code: 'status_unavailable', severity: 'critical' }], counters: {} });
  expect(down.ui_url).toBeNull();
  for (const answer of [never, down]) expect(validate(SCHEMA, 'OpsStatus', answer)).toEqual([]);
});
