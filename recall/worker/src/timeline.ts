/**
 * The timeline (ListVisits on `pages/-`) and a page's visits (ListVisits on `pages/{page}`), ../../docs/design.md §6.3
 * and §8.4: the visits whose focus overlaps [start, end), oldest or newest first, in keyset pages. A visit overlaps the
 * range when it starts before `end` and ends after `start`; since a visit lasts at most 6 hours, the scan is
 * `start_ms >= start - 6 h AND start_ms < end` on visits(start_ms, id) (or visits(page_rowid, start_ms, id) for one
 * page), so a day of the timeline reads about its own rows. Visits of deleted pages never join a live page.
 */
import { VISIT_MAX_MS } from './limits.ts';
import type { Store, VisitRow } from './store.ts';

export type Joined = VisitRow & { readonly page_id: string; readonly host_key: string };

export interface VisitQuery {
  /** A page's rowid, or null for every page. */
  readonly pageRowid: number | null;
  readonly start: number | null;
  readonly end: number | null;
  readonly descending: boolean;
  /** The last visit of the previous page: [start_ms, id]. */
  readonly after: readonly [number, string] | null;
  readonly size: number;
}

/** A page of visits, and one more when another page follows. */
export function listVisits(store: Store, query: VisitQuery): Joined[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.pageRowid !== null) {
    conditions.push('v.page_rowid = ?');
    params.push(query.pageRowid);
  }
  if (query.start !== null) {
    conditions.push('v.start_ms >= ? AND v.end_ms > ?');
    params.push(query.start - VISIT_MAX_MS, query.start);
  }
  if (query.end !== null) {
    conditions.push('v.start_ms < ?');
    params.push(query.end);
  }
  if (query.after !== null) {
    const [startMs, id] = query.after;
    conditions.push(query.descending ? '(v.start_ms < ? OR (v.start_ms = ? AND v.id < ?))' : '(v.start_ms > ? OR (v.start_ms = ? AND v.id > ?))');
    params.push(startMs, startMs, id);
  }
  const direction = query.descending ? 'DESC' : 'ASC';
  return store.all<Joined>(
    `SELECT v.*, p.id AS page_id, p.host_key AS host_key FROM visits v JOIN pages p ON p.rowid = v.page_rowid
     ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
     ORDER BY v.start_ms ${direction}, v.id ${direction} LIMIT ?`,
    ...params,
    query.size + 1,
  );
}

/** One visit of a live page, or undefined. */
export function getVisit(store: Store, pageId: string, visitId: string): Joined | undefined {
  return store.one<Joined>(
    `SELECT v.*, p.id AS page_id, p.host_key AS host_key FROM visits v JOIN pages p ON p.rowid = v.page_rowid WHERE v.id = ? AND p.id = ?`,
    visitId,
    pageId,
  );
}
