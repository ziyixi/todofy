/**
 * The raw rows of a date range for the reviews and exports, which the browser computes (Workers Free gives a
 * request 10 ms of CPU; the minute-by-minute heatmaps of the container era took 40-63 ms for 100 hours).
 *
 * A page (flowday.ui.v1 QueryAnalytics) holds at most `limit` rows, taken in one order across the pages: the range's
 * planned rows (flow_tasks), then its done rows (completed_flow_tasks), then its time entries; without a range only the
 * time entries, of every day. Each kind is read from where the cursor stands with LIMIT, through an index that seeks
 * to the cursor's day, so a page reads about its own rows however long the range (never a whole table), and the tasks
 * the page names are at most one per row. That bounds both the D1 rows read per page and the CPU of writing it.
 */
import type { FlowTaskRow, TaskRecord, TimeEntryRecord } from '../model.ts';
import type { Db } from '../db.ts';
import { analyticsEntries, type DayEntryCursor } from './entries.ts';
import { completedRowsQuery, plannedRowsQuery, type CompletedCursor, type PlannedCursor } from './flows.ts';
import { getSetting } from './settings.ts';
import { getTasksByIds } from './tasks.ts';

export const DEFAULT_DAY_CAPACITY_MINS = 360;

export function dayCapacity(raw: string | null): number {
  if (raw === null) return DEFAULT_DAY_CAPACITY_MINS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAY_CAPACITY_MINS;
}

/** The kinds of rows, in the order the pages take them. */
export type AnalyticsKind = 'planned' | 'completed' | 'entries';

/** Where the next page starts: a kind, and the last row of that kind already answered (null: none yet). */
export type AnalyticsCursor =
  | { readonly kind: 'planned'; readonly after: PlannedCursor | null }
  | { readonly kind: 'completed'; readonly after: CompletedCursor | null }
  | { readonly kind: 'entries'; readonly after: DayEntryCursor | null };

/** One page of the reviews' rows. */
export interface AnalyticsPage {
  readonly planned: FlowTaskRow[];
  readonly completed: FlowTaskRow[];
  readonly entries: TimeEntryRecord[];
  /** Where the next page starts; null on the last page. */
  readonly next: AnalyticsCursor | null;
  /** Every stored task the page's rows name, deleted ones included. */
  readonly tasks: TaskRecord[];
  readonly dayCapacityMins: number;
}

/** The kinds a query takes, in order: all three for a range, the time entries only without one. */
export function analyticsKinds(range: { start: string; end: string } | null): readonly AnalyticsKind[] {
  return range === null ? ['entries'] : ['planned', 'completed', 'entries'];
}

/**
 * A page of at most `limit` rows of [start, end] (`range` null: every time entry), from `cursor` (null: the first
 * page), with the tasks they name. Each kind is read with LIMIT `remaining + 1`, the extra row only telling whether
 * that kind has more; a page that fills up exactly at the end of a kind starts the next page at the next kind.
 */
export async function analyticsPage(db: Db, range: { start: string; end: string } | null, cursor: AnalyticsCursor | null, limit: number): Promise<AnalyticsPage> {
  const kinds = analyticsKinds(range);
  const at: AnalyticsCursor = cursor ?? { kind: kinds[0] ?? 'entries', after: null };
  const planned: FlowTaskRow[] = [];
  const completed: FlowTaskRow[] = [];
  const entries: TimeEntryRecord[] = [];
  /** Reads up to `count` rows of `kind` after `after`: how many it took, and the cursor when that kind has more. */
  const read = async (kind: AnalyticsKind, from: AnalyticsCursor | null, count: number): Promise<{ taken: number; more: AnalyticsCursor | null }> => {
    if (kind === 'entries') {
      const page = await analyticsEntries(db, { start: range?.start ?? null, end: range?.end ?? null }, from?.kind === 'entries' ? from.after : null, count);
      entries.push(...page.entries);
      const last = page.entries.at(-1);
      return { taken: page.entries.length, more: page.more && last !== undefined ? { kind, after: { flowDate: last.flowDate, startTime: last.startTime, id: last.id } } : null };
    }
    if (range === null) return { taken: 0, more: null };
    if (kind === 'planned') {
      const rows = await plannedRowsQuery(db, range, from?.kind === 'planned' ? from.after : null, count);
      const taken = rows.slice(0, count);
      planned.push(...taken.map(({ flowDate, taskId }) => ({ flowDate, taskId })));
      const last = taken.at(-1);
      return { taken: taken.length, more: rows.length > count && last !== undefined ? { kind, after: last } : null };
    }
    const rows = await completedRowsQuery(db, range, from?.kind === 'completed' ? from.after : null, count);
    const taken = rows.slice(0, count);
    completed.push(...taken.map(({ flowDate, taskId }) => ({ flowDate, taskId })));
    const last = taken.at(-1);
    return { taken: taken.length, more: rows.length > count && last !== undefined ? { kind, after: last } : null };
  };
  let remaining = limit;
  let next: AnalyticsCursor | null = null;
  for (let index = Math.max(kinds.indexOf(at.kind), 0); index < kinds.length; index += 1) {
    const kind = kinds[index] ?? 'entries';
    if (remaining === 0) {
      next = { kind, after: null };
      break;
    }
    const step = await read(kind, at.kind === kind ? at : null, remaining);
    if (step.more !== null) {
      next = step.more;
      break;
    }
    remaining -= step.taken;
  }
  const ids = [...planned, ...completed, ...entries].map((row) => row.taskId);
  const [tasks, capacityValue] = await Promise.all([getTasksByIds(db, ids), getSetting(db, 'day_capacity_mins')]);
  return { planned, completed, entries, next, tasks, dayCapacityMins: dayCapacity(capacityValue) };
}

// ---- page tokens -------------------------------------------------------------------------------------------------

/** A cursor as the page token's JSON value: the kind's letter and the last row's key (short: tokens travel in URLs). */
export function cursorValue(cursor: AnalyticsCursor): Record<string, string | number> {
  switch (cursor.kind) {
    case 'planned':
      return cursor.after === null ? { k: 'p' } : { k: 'p', d: cursor.after.flowDate, o: cursor.after.sortOrder, t: cursor.after.taskId };
    case 'completed':
      return cursor.after === null ? { k: 'c' } : { k: 'c', d: cursor.after.flowDate, r: cursor.after.rowid };
    case 'entries':
      return cursor.after === null ? { k: 'e' } : { k: 'e', d: cursor.after.flowDate, s: cursor.after.startTime, i: cursor.after.id };
  }
}

const KINDS = { p: 'planned', c: 'completed', e: 'entries' } as const;

/** The cursor of a page token's JSON value, or null when it is not one this query can have made. */
export function cursorFromValue(value: unknown, range: { start: string; end: string } | null): AnalyticsCursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { k, d, o, t, r, s, i, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof k !== 'string' || !Object.hasOwn(KINDS, k)) return null;
  const kind = KINDS[k as keyof typeof KINDS];
  if (!analyticsKinds(range).includes(kind)) return null;
  const keys = [d, o, t, r, s, i].filter((key) => key !== undefined).length;
  if (keys === 0) return { kind, after: null };
  if (typeof d !== 'string') return null;
  if (kind === 'planned' && keys === 3 && Number.isSafeInteger(o) && typeof t === 'string') return { kind, after: { flowDate: d, sortOrder: o as number, taskId: t } };
  if (kind === 'completed' && keys === 2 && Number.isSafeInteger(r)) return { kind, after: { flowDate: d, rowid: r as number } };
  if (kind === 'entries' && keys === 3 && typeof s === 'string' && typeof i === 'string') return { kind, after: { flowDate: d, startTime: s, id: i } };
  return null;
}
