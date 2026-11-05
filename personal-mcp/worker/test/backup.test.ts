/** The backup's clock, values, restore validation, and Ops view (src/backup.ts, src/restore.ts, src/ops.ts) without a runtime. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx?: unknown, env?: unknown) {
      this.env = env;
    }
  },
}));

import {
  BACKUP_FORMAT,
  BACKUP_STALE_MS,
  MANIFEST,
  RESTORE_KEY,
  SCHEMA_VERSION,
  backupOps,
  encodeValue,
  nextRun,
  rowLine,
  sha256Hex,
  timestamp,
  type BackupStorage,
} from '../src/backup.ts';
import type { Env } from '../src/env.ts';
import { buildOpsStatus, Ops } from '../src/ops.ts';
import { RESTORE_MAX_ERRORS, RESTORE_RETRY_MS, restoreState, restoreStep, startRestore } from '../src/restore.ts';

const DAY = 86_400_000;
const SLOT = Date.parse('2026-10-28T05:23:00Z');
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createBackupStorage(): BackupStorage {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('CREATE TABLE test_events (id TEXT PRIMARY KEY)');
  const kvMap = new Map<string, unknown>();
  const sql = {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      const trimmed = query.trimStart();
      if (trimmed.startsWith('CREATE')) {
        database.exec(query);
        return { toArray: () => [], one: () => ({}), raw: () => [][Symbol.iterator]() };
      }
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) satisfies SQLInputValue[];
      const statement = database.prepare(query);
      if (/^(SELECT|PRAGMA)/i.test(trimmed)) {
        const rows = statement.all(...values) as Record<string, unknown>[];
        return {
          toArray: () => rows,
          one: () => rows[0] ?? {},
          raw: () => rows.map(row => Object.values(row))[Symbol.iterator](),
        };
      }
      statement.run(...values);
      return { toArray: () => [], one: () => ({}), raw: () => [][Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  const kv = {
    get: (key: string) => kvMap.get(key),
    put: (key: string, value: unknown) => { kvMap.set(key, structuredClone(value)); },
    delete: (key: string) => kvMap.delete(key),
    list: () => new Map(kvMap),
  } as unknown as DurableObjectStorage['kv'];
  let transaction = 0;
  return {
    sql,
    kv,
    transactionSync<T>(action: () => T): T {
      const savepoint = `restore_test_${String(++transaction)}`;
      const kvSnapshot = new Map(kvMap);
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = action();
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        kvMap.clear();
        for (const [k, v] of kvSnapshot) kvMap.set(k, v);
        throw error;
      }
    },
  };
}

function createR2Bucket(objects: Record<string, Uint8Array | string>): R2Bucket {
  return {
    get(key: string) {
      const value = objects[key];
      if (value === undefined) return Promise.resolve(null);
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      return Promise.resolve({
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
        json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      } as unknown as R2ObjectBody);
    },
  } as unknown as R2Bucket;
}

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

it('builds Ops status for status_unavailable, subscription_rejected, source_unavailable, and rejects setGuard', async () => {
  expect(buildOpsStatus(undefined, SLOT)).toMatchObject({
    health: 'down',
    signals: [{ code: 'status_unavailable', severity: 'critical' }],
  });

  const degraded = buildOpsStatus({
    stage: 'work_memory',
    build_sha: 'synthetic',
    subscriptions: 2,
    deliveries: { pending: 1, accepted: 4, failed: 0 },
    last_delivery: {
      event_id: 'evt-1',
      state: 'accepted',
      attempts: 1,
      accepted_at: SLOT + 500,
      error_code: null,
      event_at: new Date(SLOT).toISOString(),
    },
    sources: [
      { name: 'task.changed', checked_at: SLOT - 1000, error_code: 'source_unavailable' },
      { name: 'mail.ready', checked_at: SLOT, error_code: 'cursor_reset_required' },
    ],
    work: { open: 1, waiting: 0, pending_reports: 0 },
    last_tool_at: SLOT - 2000,
    last_subscription_at: SLOT - 3000,
    last_subscription_request: {
      method: 'events/subscribe',
      phase: 'rejected',
      rpc_code: -32015,
      reason: 'challenge_failed',
    },
    backup: null,
    restore: null,
    meaning: 'synthetic',
  }, SLOT);

  expect(degraded).toMatchObject({
    health: 'degraded',
    counters: {
      active_subscriptions: 2,
      pending_deliveries: 1,
      accepted_deliveries: 4,
      failed_deliveries: 0,
      last_tool_at_ms: SLOT - 2000,
      last_subscription_at_ms: SLOT - 3000,
      last_source_check_at_ms: SLOT,
      last_event_at_ms: SLOT,
      last_delivery_at_ms: SLOT + 500,
    },
    signals: [
      { code: 'source_unavailable', severity: 'warning', metrics: { count: 2 } },
      { code: 'subscription_rejected', severity: 'warning', metrics: { rpc_code: -32015 } },
    ],
  });

  const ops = new Ops({} as ExecutionContext, {
    SUBSCRIPTIONS: {
      idFromName: () => ({}),
      get: () => ({ getOpsStatus: () => Promise.reject(new Error('Synthetic DO failure')) }),
    },
  } as unknown as Env);
  expect(await ops.status()).toMatchObject({
    health: 'down',
    signals: [{ code: 'status_unavailable', severity: 'critical' }],
  });
  await expect(ops.setGuard()).rejects.toThrow('invalid_input');
});

it('surfaces backups_not_bound, part_hash_mismatch, part_rows_mismatch, and verification_failed during restore', async () => {
  const prefix = 'backups/2026-10-28T052300Z/';
  const partKey = `${prefix}tables/test_events/00000.ndjson.gz`;
  const compressed = new Uint8Array(gzipSync('[1,"evt-1"]\n'));
  const validSha = await sha256Hex(compressed);

  const storage = createBackupStorage();
  expect(await startRestore(storage, undefined, prefix, SLOT)).toMatchObject({
    status: 503,
    error: 'backups_not_bound',
  });

  const makeBucket = (sha256: string, partRows: number, manifestRows = partRows) => createR2Bucket({
    [`${prefix}${MANIFEST}`]: JSON.stringify({
      format: BACKUP_FORMAT,
      schema_version: SCHEMA_VERSION,
      created_at: '2026-10-28T05:23:00Z',
      tables: [{
        name: 'test_events',
        columns: ['rowid', 'id'],
        rows: manifestRows,
        parts: [{ key: partKey, rows: partRows, sha256 }],
      }],
      kv: { rows: 0, parts: [] },
    }),
    [partKey]: compressed,
  });

  const started = await startRestore(storage, makeBucket('0'.repeat(64), 1), prefix, SLOT);
  expect(started.status).toBe(202);
  expect(await restoreStep(storage, undefined, SLOT)).toBe(SLOT + RESTORE_RETRY_MS);
  expect(restoreState(storage)).toMatchObject({ phase: 'running', errors: 1, error_code: 'backups_not_bound' });

  expect(await restoreStep(storage, makeBucket('0'.repeat(64), 1), SLOT)).toBe(SLOT + RESTORE_RETRY_MS);
  expect(restoreState(storage)).toMatchObject({ phase: 'running', errors: 2, error_code: 'part_hash_mismatch' });

  // Third consecutive step failure transitions phase to failed with part_rows_mismatch.
  expect(await restoreStep(storage, makeBucket(validSha, 2), SLOT)).toBeNull();
  expect(restoreState(storage)).toMatchObject({
    phase: 'failed',
    errors: RESTORE_MAX_ERRORS,
    error_code: 'part_rows_mismatch',
  });

  // Verification failure when part loads cleanly (1 row) but manifest table total declares 2 rows.
  const verifyStorage = createBackupStorage();
  const verifyBucket = makeBucket(validSha, 1, 2);
  expect((await startRestore(verifyStorage, verifyBucket, prefix, SLOT)).status).toBe(202);
  expect(await restoreStep(verifyStorage, verifyBucket, SLOT)).toBeNull();
  expect(restoreState(verifyStorage)).toMatchObject({
    phase: 'failed',
    error_code: 'verification_failed',
    verification: [
      { name: 'test_events', expected: 2, restored: 1, ok: false },
      { name: 'kv', expected: 0, restored: 0, ok: true },
    ],
  });
  expect(verifyStorage.kv.get(RESTORE_KEY)).toBeDefined();
});

