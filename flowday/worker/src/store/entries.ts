/**
 * Time entries (time_entries: one row per timer segment or manual entry). Besides the row, an insert writes the
 * entries of the primary-key index (TEXT key) and of the task_id and flow_date indexes: four D1 row writes. An
 * update of the times (unindexed) costs one.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { TimeEntryRecord } from '../model.ts';
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

/** Stores an entry; one with the same ID already there (a repeated request) is left as it is (false). */
export async function createTimeEntry(db: Db, entry: NewTimeEntry, now: Date = new Date()): Promise<boolean> {
  const result = await db.insert(timeEntries).values({ ...entry, createdAt: sqliteNow(now) }).onConflictDoNothing();
  return result.meta.changes > 0;
}

export async function getTimeEntry(db: Db, id: string): Promise<TimeEntryRecord | null> {
  const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  return row ?? null;
}

/** Where a page of entries ordered by (start_time, id) ends (ListTimeEntries). */
export interface EntryCursor {
  readonly startTime: string;
  readonly id: string;
}

/** Where a page of entries ordered by (flow_date, start_time, id) ends (QueryAnalytics). */
export interface DayEntryCursor extends EntryCursor {
  readonly flowDate: string;
}

/** A page plus whether more follow: `limit + 1` rows are read, the last one only to tell. */
export interface EntryPage {
  readonly entries: TimeEntryRecord[];
  readonly more: boolean;
}

export function entryPage(rows: TimeEntryRecord[], limit: number): EntryPage {
  return { entries: rows.slice(0, limit), more: rows.length > limit };
}

/** The query of a ListTimeEntries page (built apart so ../warmup.ts can run its row mapping at startup). */
export function listTimeEntriesQuery(db: Db, options: { taskId: string | null; flowDate: string | null; after: EntryCursor | null; limit: number }) {
  const after = options.after;
  return db
    .select()
    .from(timeEntries)
    .where(
      and(
        options.taskId === null ? undefined : eq(timeEntries.taskId, options.taskId),
        options.flowDate === null ? undefined : eq(timeEntries.flowDate, options.flowDate),
        after === null ? undefined : sql`(${timeEntries.startTime}, ${timeEntries.id}) > (${after.startTime}, ${after.id})`,
      ),
    )
    .orderBy(asc(timeEntries.startTime), asc(timeEntries.id))
    .limit(options.limit + 1);
}

/**
 * A page of a task's entries, a day's, or a task's on a day (at least one of them), by start time and ID (the task_id
 * and flow_date indexes find the rows).
 */
export async function listTimeEntries(
  db: Db,
  options: { taskId: string | null; flowDate: string | null; after: EntryCursor | null; limit: number },
): Promise<EntryPage> {
  return entryPage(await listTimeEntriesQuery(db, options), options.limit);
}

/**
 * The query of a page of the reviews' entries, by (flow_date, start_time, id): those of the days [start, end] (each
 * bound optional), after `after`. The flow_date index seeks to the page's first day (`flow_date >=` the cursor's
 * day), and SQLite sorts each day's rows on the way, so a page reads about its own rows and the rest of its last day,
 * never the whole table (time_entries has no start_time index, and one would cost a row write per entry).
 */
export function analyticsEntriesQuery(db: Db, days: { start: string | null; end: string | null }, after: DayEntryCursor | null, limit: number) {
  const from = after === null || (days.start !== null && days.start > after.flowDate) ? days.start : after.flowDate;
  return db
    .select()
    .from(timeEntries)
    .where(
      and(
        // One lower bound, the later of the two, so the index seeks to it (SQLite seeks to one of several).
        from === null ? undefined : gte(timeEntries.flowDate, from),
        days.end === null ? undefined : lte(timeEntries.flowDate, days.end),
        after === null ? undefined : sql`(${timeEntries.flowDate}, ${timeEntries.startTime}, ${timeEntries.id}) > (${after.flowDate}, ${after.startTime}, ${after.id})`,
      ),
    )
    .orderBy(asc(timeEntries.flowDate), asc(timeEntries.startTime), asc(timeEntries.id))
    .limit(limit + 1);
}

export async function analyticsEntries(db: Db, days: { start: string | null; end: string | null }, after: DayEntryCursor | null, limit: number): Promise<EntryPage> {
  return entryPage(await analyticsEntriesQuery(db, days, after, limit), limit);
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

export async function getEntriesByTaskAndDate(db: Db, taskId: string, flowDate: string): Promise<TimeEntryRecord[]> {
  return db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.taskId, taskId), eq(timeEntries.flowDate, flowDate)))
    .orderBy(asc(timeEntries.startTime));
}

export async function getEntriesByTask(db: Db, taskId: string): Promise<TimeEntryRecord[]> {
  return db.select().from(timeEntries).where(eq(timeEntries.taskId, taskId)).orderBy(asc(timeEntries.startTime));
}

export async function getEntriesByDate(db: Db, flowDate: string): Promise<TimeEntryRecord[]> {
  return db.select().from(timeEntries).where(eq(timeEntries.flowDate, flowDate)).orderBy(asc(timeEntries.startTime));
}

export async function getEntriesInDateRange(db: Db, startDate: string, endDate: string): Promise<TimeEntryRecord[]> {
  return db
    .select()
    .from(timeEntries)
    .where(and(gte(timeEntries.flowDate, startDate), lte(timeEntries.flowDate, endDate)))
    .orderBy(asc(timeEntries.flowDate), asc(timeEntries.startTime));
}

export async function getAllTimeEntries(db: Db): Promise<TimeEntryRecord[]> {
  return db.select().from(timeEntries).orderBy(asc(timeEntries.startTime));
}
