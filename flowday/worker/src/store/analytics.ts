/**
 * The raw rows of a date range for the reviews and exports, which the browser computes (Workers Free gives a
 * request 10 ms of CPU; the minute-by-minute heatmaps of the container era took 40-63 ms for 100 hours). The time
 * entries come a page at a time (flowday.ui.v1 QueryAnalytics), so writing an answer stays within the limit however
 * many hours were logged; the range's flows come with the first page.
 */
import type { FlowTaskRow, TaskRecord, TimeEntryRecord } from '../model.ts';
import type { Db } from '../db.ts';
import { analyticsEntries, entryCursor, type EntryCursor } from './entries.ts';
import { getCompletedTaskIdsInDateRange, getFlowTaskIdsInDateRange } from './flows.ts';
import { getSetting } from './settings.ts';
import { getTasksByIds } from './tasks.ts';

export const DEFAULT_DAY_CAPACITY_MINS = 360;

export function dayCapacity(raw: string | null): number {
  if (raw === null) return DEFAULT_DAY_CAPACITY_MINS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAY_CAPACITY_MINS;
}

/** One page of the reviews' rows. */
export interface AnalyticsPage {
  readonly entries: TimeEntryRecord[];
  /** Where the next page starts; null on the last page. */
  readonly next: EntryCursor | null;
  /** The range's flows and done tasks (first page only; empty without a range). */
  readonly flows: FlowTaskRow[];
  readonly completed: FlowTaskRow[];
  /** Every stored task the page's rows name, deleted ones included. */
  readonly tasks: TaskRecord[];
  readonly dayCapacityMins: number;
}

/**
 * A page of the entries of [start, end] (`range` null: every time entry), after `cursor` (null: the first page, which
 * also carries the range's flows and completions), with the tasks they name.
 */
export async function analyticsPage(db: Db, range: { start: string; end: string } | null, cursor: EntryCursor | null, limit: number): Promise<AnalyticsPage> {
  const first = cursor === null && range !== null;
  const [capacity, page, flows, completed] = await Promise.all([
    getSetting(db, 'day_capacity_mins'),
    analyticsEntries(db, range, cursor, limit),
    first ? getFlowTaskIdsInDateRange(db, range.start, range.end) : Promise.resolve([]),
    first ? getCompletedTaskIdsInDateRange(db, range.start, range.end) : Promise.resolve([]),
  ]);
  const ids = [...flows, ...completed, ...page.entries].map((row) => row.taskId);
  const tasks = await getTasksByIds(db, ids);
  const last = page.entries.at(-1);
  return {
    entries: page.entries,
    next: page.more && last !== undefined ? entryCursor(last, range !== null) : null,
    flows,
    completed,
    tasks,
    dayCapacityMins: dayCapacity(capacity),
  };
}
