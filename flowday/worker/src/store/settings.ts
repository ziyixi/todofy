/**
 * Key-value settings. A write that would store the same value writes nothing. Keys:
 * todoist_api_key, day_capacity_mins, planning_completed:<date>, last_sync_at (container era), and the sync's own
 * todoist_sync_token, todoist_projects and sync_claimed_at (../sync.ts).
 */
import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { settings } from '../schema.ts';

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? null;
}

/** Several keys in one query (a short, fixed list: one bound parameter each). */
export async function getSettings(db: Db, keys: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [...keys]));
  return new Map(rows.map((row) => [row.key, row.value]));
}

export function setSettingQuery(db: Db, key: string, value: string) {
  return db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value }, setWhere: sql`${settings.value} IS NOT excluded.value` });
}

/** The same conditional upsert as raw SQL, for batches of raw statements. */
export function setSettingSql(key: string, value: string): SQL {
  return sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value IS NOT excluded.value`;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await setSettingQuery(db, key, value);
}

export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}

/** The settings key that marks a day's planning as completed (value 'true'); kept since the container era. */
export const PLANNING_PREFIX = 'planning_completed:';

export function planningKey(flowDate: string): string {
  return `${PLANNING_PREFIX}${flowDate}`;
}

/**
 * The days whose planning is completed, by a range of the primary key (`planning_completed:` up to the next
 * character after the colon, `;`), so no LIKE pattern and no full scan.
 */
export async function getPlanningDays(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ key: settings.key })
    .from(settings)
    .where(and(gte(settings.key, PLANNING_PREFIX), lt(settings.key, 'planning_completed;'), eq(settings.value, 'true')));
  return new Set(rows.map((row) => row.key.slice(PLANNING_PREFIX.length)));
}
