/**
 * The links app's ops-v1 status (contracts/ops-v1), from what ops.ts read: whether the database answered and the
 * daily backup's facts (backup-runner.ts). Counters: database_ready and, once a backup is complete,
 * backup_age_seconds; signals backup_stale (critical) and backup_failed (warning), critical first. No key, target or
 * count of links: the status carries no content. No guard and no mode besides maintenance (always false).
 */
import { create } from '@ziyixi/proto/protobuf';
import { GuardLevel, Health, OpsStatusSchema, Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { toWire } from '@ziyixi/proto/wire-json';
import { backupOps, type BackupFacts } from './backup-runner.ts';

export interface StatusInput {
  now: number;
  /** The public host, or null when PUBLIC_HOST is not a plain host name. */
  host: string | null;
  /** Whether D1 answered: without it the app is down. */
  database: boolean;
  /** The backup's facts; null without the bucket (local dev). */
  backup: BackupFacts | null;
}

/** Signals come critical first, then by code (ops-v1). */
const rank = (severity: Severity) => (severity === Severity.CRITICAL ? 0 : severity === Severity.WARNING ? 1 : 2);

export function linksStatus({ now, host, database, backup }: StatusInput): wire.OpsStatus {
  const base = {
    version: 'ops-v1',
    app: 'links',
    generatedAt: new Date(now).toISOString(),
    modes: { maintenance: false },
    guard: { level: GuardLevel.NORMAL },
    capabilities: [],
    ...(host ? { uiUrl: `https://${host}/_/` } : {}),
  };
  if (!database)
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        ...base,
        health: Health.DOWN,
        counters: {},
        signals: [{ code: 'status_unavailable', severity: Severity.CRITICAL }],
      }),
    );
  const facts = backupOps(backup, now);
  const signals = facts.signals.sort(
    (a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  return toWire(
    OpsStatusSchema,
    create(OpsStatusSchema, {
      ...base,
      health: signals.some((signal) => signal.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
      signals,
      counters: { database_ready: 1, ...facts.counters },
      ...(facts.lastBackupAt ? { lastBackupAt: facts.lastBackupAt } : {}),
    }),
  );
}
