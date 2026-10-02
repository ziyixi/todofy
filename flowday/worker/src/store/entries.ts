/**
 * Time entries (time_entries: one row per timer segment or manual entry). Besides the row, an insert writes the
 * entries of the primary-key index (TEXT key) and of the task_id and flow_date indexes: four D1 row writes. An
 * update of the times (unindexed) costs one.
 */
import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
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

/** Where a page of entries ordered by (start_time, id), or by (flow_date, start_time, id), ends. */
export interface EntryCursor {
  /** Set exactly for the (flow_date, start_time, id) order. */
  readonly flowDate?: string;
  readonly startTime: string;
  readonly id: string;
}

/** The cursor after `entry` in the order `byDay` names. */
export function entryCursor(entry: TimeEntryRecord, byDay: boolean): EntryCursor {
  return byDay ? { flowDate: entry.flowDate, startTime: entry.startTime, id: entry.id } : { startTime: entry.startTime, id: entry.id };
}

function after(cursor: EntryCursor | null): SQL | undefined {
  if (cursor === null) return undefined;
  return cursor.flowDate === undefined
    ? sql`(${timeEntries.startTime}, ${timeEntries.id}) > (${cursor.startTime}, ${cursor.id})`
    : sql`(${timeEntries.flowDate}, ${timeEntries.startTime}, ${timeEntries.id}) > (${cursor.flowDate}, ${cursor.startTime}, ${cursor.id})`;
}

/** A page plus whether more follow: `limit + 1` rows are read, the last one only to tell. */
export interface EntryPage {
  readonly entries: TimeEntryRecord[];
  readonly more: boolean;
}

function page(rows: TimeEntryRecord[], limit: number): EntryPage {
  return { entries: rows.slice(0, limit), more: rows.length > limit };
}

/**
 * A page of a task's entries, a day's, or a task's on a day (at least one of them), by start time and ID (the task_id
 * and flow_date indexes find the rows).
 */
export async function listTimeEntries(
  db: Db,
  options: { taskId: string | null; flowDate: string | null; after: EntryCursor | null; limit: number },
): Promise<EntryPage> {
  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        options.taskId === null ? undefined : eq(timeEntries.taskId, options.taskId),
        options.flowDate === null ? undefined : eq(timeEntries.flowDate, options.flowDate),
        after(options.after),
      ),
    )
    .orderBy(asc(timeEntries.startTime), asc(timeEntries.id))
    .limit(options.limit + 1);
  return page(rows, options.limit);
}

/**
 * A page of the reviews' entries: those of the days [start, end] by day, start time and ID, or with `range` null
 * every entry by start time and ID (the work-pattern statistics).
 */
export async function analyticsEntries(
  db: Db,
  range: { start: string; end: string } | null,
  cursor: EntryCursor | null,
  limit: number,
): Promise<EntryPage> {
  const rows =
    range === null
      ? await db.select().from(timeEntries).where(after(cursor)).orderBy(asc(timeEntries.startTime), asc(timeEntries.id)).limit(limit + 1)
      : await db
          .select()
          .from(timeEntries)
          .where(and(gte(timeEntries.flowDate, range.start), lte(timeEntries.flowDate, range.end), after(cursor)))
          .orderBy(asc(timeEntries.flowDate), asc(timeEntries.startTime), asc(timeEntries.id))
          .limit(limit + 1);
  return page(rows, limit);
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
