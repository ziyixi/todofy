/**
 * The raw rows of a date range for the reviews and exports, which the browser computes (Workers Free gives a
 * request 10 ms of CPU; the minute-by-minute heatmaps of the container era took 40-63 ms for 100 hours).
 */
import type { AnalyticsDataset } from '../api-types.ts';
import type { Db } from '../db.ts';
import { getAllTimeEntries, getEntriesInDateRange } from './entries.ts';
import { getCompletedTaskIdsInDateRange, getFlowTaskIdsInDateRange } from './flows.ts';
import { getSetting } from './settings.ts';
import { getTasksByIds } from './tasks.ts';

export const DEFAULT_DAY_CAPACITY_MINS = 360;

export function dayCapacity(raw: string | null): number {
  if (raw === null) return DEFAULT_DAY_CAPACITY_MINS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAY_CAPACITY_MINS;
}

/** Flows, completions and entries of [start, end] with their tasks; start and end null: every time entry only. */
export async function analyticsDataset(db: Db, start: string | null, end: string | null): Promise<AnalyticsDataset> {
  const capacity = getSetting(db, 'day_capacity_mins');
  if (start === null || end === null) {
    const entries = await getAllTimeEntries(db);
    const tasks = await getTasksByIds(db, entries.map((entry) => entry.taskId));
    return { start: null, end: null, flows: [], completed: [], entries, tasks, dayCapacityMins: dayCapacity(await capacity) };
  }
  const [flows, completed, entries] = await Promise.all([
    getFlowTaskIdsInDateRange(db, start, end),
    getCompletedTaskIdsInDateRange(db, start, end),
    getEntriesInDateRange(db, start, end),
  ]);
  const ids = [...flows, ...completed, ...entries].map((row) => row.taskId);
  const tasks = await getTasksByIds(db, ids);
  return { start, end, flows, completed, entries, tasks, dayCapacityMins: dayCapacity(await capacity) };
}
