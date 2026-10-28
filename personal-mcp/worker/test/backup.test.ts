/** The backup's clock, values and Ops view (src/backup.ts) without a runtime; test/runtime/backup.test.ts runs the job. */
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { expect, it } from 'vitest';
import { BACKUP_STALE_MS, backupOps, encodeValue, nextRun, rowLine, timestamp } from '../src/backup.ts';

const DAY = 86_400_000;
const SLOT = Date.parse('2026-10-28T05:23:00Z');

it('runs daily at 05:23 UTC, and not again on the day of an early backup', () => {
  expect(nextRun(SLOT - 1)).toBe(SLOT);
  expect(nextRun(SLOT)).toBe(SLOT + DAY);
  expect(nextRun(Date.parse('2026-10-28T00:10:00Z'))).toBe(SLOT);
  expect(nextRun(Date.parse('2026-10-28T00:10:00Z'), true)).toBe(SLOT + DAY);
  expect(nextRun(Date.parse('2026-10-28T23:59:00Z'), true)).toBe(SLOT + DAY);
  expect(timestamp(SLOT + 456)).toBe('2026-10-28T05:23:00Z');
});

it('writes rows as JSON arrays with a blob as base64', () => {
  expect(encodeValue('it’s “text”\n汉字')).toBe('it’s “text”\n汉字');
  expect(encodeValue(null)).toBeNull();
  expect(encodeValue(new Uint8Array([0, 1, 255]).buffer)).toEqual({ blob: 'AAH/' });
  expect(rowLine([3, 'a', null, 1.5, new Uint8Array([104, 105]).buffer])).toBe('[3,"a",null,1.5,{"blob":"aGk="}]');
});

it('reports the backup age, a stale backup and a failed job, and nothing without the bucket', () => {
  const now = SLOT + DAY;
  expect(backupOps(null, now)).toEqual({ counters: {}, signals: [], lastBackupAt: null });
  expect(backupOps({ status: 'never', last_backup_at: null, last_key: '', since: null }, now).signals).toEqual([]);
  expect(backupOps({ status: 'ok', last_backup_at: SLOT, last_key: 'backups/x/', since: SLOT - 30 * DAY }, now)).toEqual({
    counters: { backup_age_seconds: 86_400 }, signals: [], lastBackupAt: '2026-10-28T05:23:00.000Z' });
  expect(backupOps({ status: 'failed', last_backup_at: now - BACKUP_STALE_MS - 1000, last_key: '', since: 0 }, now).signals).toEqual([
    { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { age_seconds: 3 * 86_400 + 1, has_backup: 1 } },
    { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
  ]);
  // Before the first complete backup, counted from the first job.
  expect(backupOps({ status: 'running', last_backup_at: null, last_key: '', since: now - DAY }, now).signals).toEqual([]);
  expect(backupOps({ status: 'failed', last_backup_at: null, last_key: '', since: now - 4 * DAY }, now).signals).toEqual([
    { code: 'backup_stale', severity: Severity.CRITICAL, metrics: { has_backup: 0 } },
    { code: 'backup_failed', severity: Severity.WARNING, metrics: {} },
  ]);
});
