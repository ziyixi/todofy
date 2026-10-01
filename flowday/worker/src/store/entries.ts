/**
 * Time entries (time_entries: one row per timer segment or manual entry). Besides the row, an insert writes the
 * entries of the primary-key index (TEXT key) and of the task_id and flow_date indexes: four D1 row writes. An
 * update of the times (unindexed) costs one.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { TimeEntry } from '../api-types.ts';
import { sqliteNow, type Db } from '../db.ts';
import { timeEntries } from '../schema.ts';

export interface NewTimeEntry {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: 'timer' | 'manual';
}

export async function createTimeEntry(db: Db, entry: NewTimeEntry, now: Date = new Date()): Promise<void> {
  await db.insert(timeEntries).values({ ...entry, createdAt: sqliteNow(now) });
}

export async function updateTimeEntry(
  db: Db,
  id: string,
  updates: { startTime: string; endTime: string; durationS: number },
): Promise<boolean> {
  const result = await db.update(timeEntries).set(updates).where(eq(timeEntries.id, id));
  return result.meta.changes > 0;
}

export async function deleteTimeEntry(db: Db, id: string): Promise<boolean> {
  const result = await db.delete(timeEntries).where(eq(timeEntries.id, id));
  return result.meta.changes > 0;
}

export async function getEntriesByTaskAndDate(db: Db, taskId: string, flowDate: string): Promise<TimeEntry[]> {
  return db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.taskId, taskId), eq(timeEntries.flowDate, flowDate)))
    .orderBy(asc(timeEntries.startTime));
}

export async function getEntriesByTask(db: Db, taskId: string): Promise<TimeEntry[]> {
  return db.select().from(timeEntries).where(eq(timeEntries.taskId, taskId)).orderBy(asc(timeEntries.startTime));
}

export async function getEntriesByDate(db: Db, flowDate: string): Promise<TimeEntry[]> {
  return db.select().from(timeEntries).where(eq(timeEntries.flowDate, flowDate)).orderBy(asc(timeEntries.startTime));
}

export async function getEntriesInDateRange(db: Db, startDate: string, endDate: string): Promise<TimeEntry[]> {
  return db
    .select()
    .from(timeEntries)
    .where(and(gte(timeEntries.flowDate, startDate), lte(timeEntries.flowDate, endDate)))
    .orderBy(asc(timeEntries.flowDate), asc(timeEntries.startTime));
}

export async function getAllTimeEntries(db: Db): Promise<TimeEntry[]> {
  return db.select().from(timeEntries).orderBy(asc(timeEntries.startTime));
}
