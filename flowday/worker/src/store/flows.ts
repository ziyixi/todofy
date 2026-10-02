/**
 * Day flows (flow_tasks: the ordered task ids of a day) and the tasks done on a day (completed_flow_tasks).
 *
 * flow_tasks has two indexes besides its key (unique (flow_date, task_id) and task_id; migration 0003 dropped the
 * redundant flow_date one), so rewriting a whole day costs about four D1 row writes per task. setFlow writes the
 * difference instead: it deletes the tasks that left the day, inserts the new ones and moves only the rows whose
 * position changed (sort_order is not indexed: one row write each).
 */
import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { FlowTaskRow } from '../model.ts';
import { completedFlowTasks, flowTasks } from '../schema.ts';
import { PLANNING_END, PLANNING_PREFIX } from './settings.ts';
import { runStatements } from './tasks.ts';

function group(rows: readonly { flowDate: string; taskId: string }[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const row of rows) (result[row.flowDate] ??= []).push(row.taskId);
  return result;
}

export async function getAllFlows(db: Db): Promise<Record<string, string[]>> {
  const rows = await db
    .select({ flowDate: flowTasks.flowDate, taskId: flowTasks.taskId })
    .from(flowTasks)
    .orderBy(asc(flowTasks.flowDate), asc(flowTasks.sortOrder));
  return group(rows);
}

export async function getFlowTaskIds(db: Db, flowDate: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: flowTasks.taskId })
    .from(flowTasks)
    .where(eq(flowTasks.flowDate, flowDate))
    .orderBy(asc(flowTasks.sortOrder));
  return rows.map((row) => row.taskId);
}

/** The statements that make the day's flow exactly `taskIds` (duplicates dropped, first position wins). */
export function setFlowStatements(flowDate: string, taskIds: readonly string[]): SQL[] {
  const unique = [...new Set(taskIds)];
  const rows = JSON.stringify(unique.map((taskId, index) => ({ id: crypto.randomUUID(), taskId, index })));
  return [
    sql`DELETE FROM flow_tasks WHERE flow_date = ${flowDate}
      AND task_id NOT IN (SELECT value FROM json_each(${JSON.stringify(unique)}))`,
    sql`INSERT INTO flow_tasks (id, flow_date, task_id, sort_order)
      SELECT json_extract(value, '$.id'), ${flowDate}, json_extract(value, '$.taskId'), json_extract(value, '$.index')
      FROM json_each(${rows}) WHERE true
      ON CONFLICT(flow_date, task_id) DO UPDATE SET sort_order = excluded.sort_order
      WHERE flow_tasks.sort_order IS NOT excluded.sort_order`,
  ];
}

export async function setFlowTaskIds(db: Db, flowDate: string, taskIds: readonly string[]): Promise<void> {
  await runStatements(db, setFlowStatements(flowDate, taskIds));
}

export async function getAllCompletedFlowTasks(db: Db): Promise<Record<string, string[]>> {
  const rows = await db
    .select({ flowDate: completedFlowTasks.flowDate, taskId: completedFlowTasks.taskId })
    .from(completedFlowTasks)
    .orderBy(asc(completedFlowTasks.flowDate), sql`rowid`);
  return group(rows);
}

export async function getCompletedTaskIds(db: Db, flowDate: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: completedFlowTasks.taskId })
    .from(completedFlowTasks)
    .where(eq(completedFlowTasks.flowDate, flowDate));
  return rows.map((row) => row.taskId);
}

/** Marks a task done on a day; nothing is written when it already is. */
export async function addCompletedFlowTask(db: Db, flowDate: string, taskId: string): Promise<void> {
  await db.insert(completedFlowTasks).values({ id: crypto.randomUUID(), flowDate, taskId }).onConflictDoNothing();
}

export async function removeCompletedFlowTask(db: Db, flowDate: string, taskId: string): Promise<void> {
  await db
    .delete(completedFlowTasks)
    .where(and(eq(completedFlowTasks.flowDate, flowDate), eq(completedFlowTasks.taskId, taskId)));
}

/** The (day, task) rows of the days [startDate, endDate], by day and position. */
export function flowRowsBetweenQuery(db: Db, startDate: string, endDate: string) {
  return db
    .select({ flowDate: flowTasks.flowDate, taskId: flowTasks.taskId })
    .from(flowTasks)
    .where(and(gte(flowTasks.flowDate, startDate), lte(flowTasks.flowDate, endDate)))
    .orderBy(asc(flowTasks.flowDate), asc(flowTasks.sortOrder));
}

export async function getFlowTaskIdsInDateRange(db: Db, startDate: string, endDate: string): Promise<FlowTaskRow[]> {
  return flowRowsBetweenQuery(db, startDate, endDate);
}

/** The done (day, task) rows of the days [startDate, endDate], by day and the order they were marked. */
export function completedRowsBetweenQuery(db: Db, startDate: string, endDate: string) {
  return db
    .select({ flowDate: completedFlowTasks.flowDate, taskId: completedFlowTasks.taskId })
    .from(completedFlowTasks)
    .where(and(gte(completedFlowTasks.flowDate, startDate), lte(completedFlowTasks.flowDate, endDate)))
    .orderBy(asc(completedFlowTasks.flowDate), sql`rowid`);
}

export async function getCompletedTaskIdsInDateRange(db: Db, startDate: string, endDate: string): Promise<FlowTaskRow[]> {
  return completedRowsBetweenQuery(db, startDate, endDate);
}

/**
 * The first `limit` days after `after` ('' for the first page) that have a planned or done task or a completed
 * planning, oldest first: ListFlows's page. Each of the three sources gives at most `limit` days in order, through the
 * unique (flow_date, task_id) indexes and the settings key, so a page reads about the rows of its own days.
 */
export async function flowDaysAfter(db: Db, after: string, limit: number): Promise<string[]> {
  const rows = await db.all<{ flow_date: string }>(sql`SELECT flow_date FROM (
      SELECT flow_date FROM (SELECT DISTINCT flow_date FROM flow_tasks WHERE flow_date > ${after} ORDER BY flow_date LIMIT ${limit})
      UNION SELECT flow_date FROM (SELECT DISTINCT flow_date FROM completed_flow_tasks WHERE flow_date > ${after} ORDER BY flow_date LIMIT ${limit})
      UNION SELECT substr(key, ${PLANNING_PREFIX.length + 1}) FROM (SELECT key FROM settings
        WHERE key > ${PLANNING_PREFIX + after} AND key < ${PLANNING_END} AND value = 'true' ORDER BY key LIMIT ${limit})
    ) ORDER BY flow_date LIMIT ${limit}`);
  return rows.map((row) => row.flow_date);
}

/** A task's place in a day's flow: where a page of the planned rows ends (QueryAnalytics). */
export interface PlannedCursor {
  readonly flowDate: string;
  readonly sortOrder: number;
  readonly taskId: string;
}

/**
 * A page of the planned rows of [start, end] by (flow_date, sort_order, task_id) after `after`: the unique
 * (flow_date, task_id) index seeks to the first day, and the rows of each day are sorted on the way.
 */
export function plannedRowsQuery(db: Db, range: { start: string; end: string }, after: PlannedCursor | null, limit: number) {
  return db
    .select({ flowDate: flowTasks.flowDate, taskId: flowTasks.taskId, sortOrder: flowTasks.sortOrder })
    .from(flowTasks)
    .where(
      and(
        // One lower bound, the later of the two, so the index seeks to it (SQLite seeks to one of several).
        gte(flowTasks.flowDate, after !== null && after.flowDate > range.start ? after.flowDate : range.start),
        lte(flowTasks.flowDate, range.end),
        after === null ? undefined : sql`(${flowTasks.flowDate}, ${flowTasks.sortOrder}, ${flowTasks.taskId}) > (${after.flowDate}, ${after.sortOrder}, ${after.taskId})`,
      ),
    )
    .orderBy(asc(flowTasks.flowDate), asc(flowTasks.sortOrder), asc(flowTasks.taskId))
    .limit(limit + 1);
}

/** A done row's place: its day and rowid (the order it was marked). */
export interface CompletedCursor {
  readonly flowDate: string;
  readonly rowid: number;
}

/** A page of the done rows of [start, end] by (flow_date, rowid) after `after`, as plannedRowsQuery. */
export function completedRowsQuery(db: Db, range: { start: string; end: string }, after: CompletedCursor | null, limit: number) {
  const rowid = sql<number>`rowid`;
  return db
    .select({ flowDate: completedFlowTasks.flowDate, taskId: completedFlowTasks.taskId, rowid })
    .from(completedFlowTasks)
    .where(
      and(
        gte(completedFlowTasks.flowDate, after !== null && after.flowDate > range.start ? after.flowDate : range.start),
        lte(completedFlowTasks.flowDate, range.end),
        after === null ? undefined : sql`(${completedFlowTasks.flowDate}, rowid) > (${after.flowDate}, ${after.rowid})`,
      ),
    )
    .orderBy(asc(completedFlowTasks.flowDate), rowid)
    .limit(limit + 1);
}

/** Moves the unfinished tasks of `fromDate` to the top of `toDate`, in one atomic batch. */
export async function rolloverAllTasks(db: Db, fromDate: string, toDate: string): Promise<void> {
  const [source, completed, existing] = await Promise.all([
    getFlowTaskIds(db, fromDate),
    getCompletedTaskIds(db, fromDate),
    getFlowTaskIds(db, toDate),
  ]);
  const done = new Set(completed);
  const incomplete = source.filter((id) => !done.has(id));
  if (incomplete.length === 0) return;
  await moveTasks(db, fromDate, toDate, source, incomplete, existing);
}

/** Moves the selected tasks of `fromDate` to the top of `toDate`, in one atomic batch. */
export async function rolloverSelectedTasks(db: Db, fromDate: string, toDate: string, taskIds: readonly string[]): Promise<void> {
  const selected = new Set(taskIds);
  const [source, existing] = await Promise.all([getFlowTaskIds(db, fromDate), getFlowTaskIds(db, toDate)]);
  const toMove = source.filter((id) => selected.has(id));
  if (toMove.length === 0) return;
  await moveTasks(db, fromDate, toDate, source, toMove, existing);
}

async function moveTasks(
  db: Db,
  fromDate: string,
  toDate: string,
  source: readonly string[],
  toMove: readonly string[],
  existing: readonly string[],
): Promise<void> {
  const present = new Set(existing);
  const toAdd = toMove.filter((id) => !present.has(id));
  const moving = new Set(toMove);
  const statements = toAdd.length > 0 ? setFlowStatements(toDate, [...toAdd, ...existing]) : [];
  statements.push(...setFlowStatements(fromDate, source.filter((id) => !moving.has(id))));
  await runStatements(db, statements);
}
