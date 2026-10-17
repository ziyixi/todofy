/** Shared atomic throttling for the two read-only task sources. */
import { sql } from 'drizzle-orm';
import type { Db } from './db.ts';

export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
export const MANUAL_SYNC_MIN_INTERVAL_MS = 30_000;
/** The automatic interval doubles after each failed sync, up to 2^5 = 32 times (160 minutes). */
export const MAX_BACKOFF_STEPS = 5;
export const KEY_CLAIMED_AT = 'sync_claimed_at';
export const KEY_LAST_SYNC_AT = 'last_sync_at';
export type SyncMode = 'auto' | 'manual';

/** `sync_claimed_at`: "<epoch ms>" or "<epoch ms>:<failed syncs before it>". */
export interface Claim {
  at: number;
  failures: number;
}

export function parseClaim(raw: string | null | undefined): Claim | null {
  const match = /^(\d{1,16})(?::(\d{1,2}))?$/.exec(raw ?? '');
  if (match === null) return null;
  return { at: Number(match[1]), failures: Number(match[2] ?? '0') };
}

export function claimValue(claim: Claim): string {
  return claim.failures === 0 ? String(claim.at) : `${String(claim.at)}:${String(claim.failures)}`;
}

/** The automatic interval after `failures` failed syncs in a row. */
export function autoInterval(failures: number): number {
  return AUTO_SYNC_MIN_INTERVAL_MS * 2 ** Math.min(failures, MAX_BACKOFF_STEPS);
}

/**
 * Claims the right to sync now: a compare-and-set against the claim read before (`previous`, null when there was
 * none) that also requires it to be at least `minIntervalMs` old. Atomic, one row; false when another request
 * claimed first or the interval has not passed.
 */
export async function claimSync(db: Db, previous: string | null, next: Claim, minIntervalMs: number): Promise<boolean> {
  const result = await db.run(sql`INSERT INTO settings (key, value) VALUES (${KEY_CLAIMED_AT}, ${claimValue(next)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE settings.value IS ${previous} AND CAST(settings.value AS INTEGER) <= ${next.at - minIntervalMs}`);
  return result.meta.changes === 1;
}
