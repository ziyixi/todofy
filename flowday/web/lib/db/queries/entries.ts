import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../index";
import { timeEntries } from "../schema";

export interface TimeEntryRow {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: string;
  createdAt: string | null;
}

export function createTimeEntry(entry: {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: "timer" | "manual";
}): void {
  const db = getDb();
  db.insert(timeEntries).values(entry).run();
}

export function updateTimeEntry(
  id: string,
  updates: { startTime: string; endTime: string; durationS: number }
): boolean {
  const db = getDb();
  const result = db
    .update(timeEntries)
    .set(updates)
    .where(eq(timeEntries.id, id))
    .run();
  return result.changes > 0;
}

export function getEntriesByTaskAndDate(
  taskId: string,
  flowDate: string
): TimeEntryRow[] {
  const db = getDb();
  return db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.taskId, taskId), eq(timeEntries.flowDate, flowDate)))
    .all() as TimeEntryRow[];
}

export function getEntriesByTask(taskId: string): TimeEntryRow[] {
  const db = getDb();
  return db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.taskId, taskId))
    .all() as TimeEntryRow[];
}

export function getEntriesByDate(flowDate: string): TimeEntryRow[] {
  const db = getDb();
  return db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.flowDate, flowDate))
    .all() as TimeEntryRow[];
}

export function deleteTimeEntry(id: string): boolean {
  const db = getDb();
  const result = db.delete(timeEntries).where(eq(timeEntries.id, id)).run();
  return result.changes > 0;
}

export function getEntriesInDateRange(
  startDate: string,
  endDate: string
): TimeEntryRow[] {
  const db = getDb();
  return db
    .select()
    .from(timeEntries)
    .where(and(gte(timeEntries.flowDate, startDate), lte(timeEntries.flowDate, endDate)))
    .all() as TimeEntryRow[];
}

export function getAllTimeEntries(): TimeEntryRow[] {
  const db = getDb();
  return db.select().from(timeEntries).all() as TimeEntryRow[];
}
