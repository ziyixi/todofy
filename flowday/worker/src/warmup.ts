/**
 * Runs the owner API's answer path at startup, in the Worker's global scope (outside any request's CPU time on Workers
 * Free, like the transcoder's route table), on synthetic rows, enough times that V8 has compiled and optimized it:
 *
 * - each list's D1 query as the store builds it (drizzle's query builder), and drizzle's mapping of D1's raw rows to
 *   records, through a stub binding that is never called (`prepare()` only; mapAllResult maps rows given here);
 * - the records-to-messages mapping of ./api.ts and the wire JSON writer (proto/ts/wire-json.ts) of every list's
 *   answer.
 *
 * Without it an isolate's first list answer runs that code interpreted, row by row: a page of 200 tasks cost about
 * 3 ms more CPU than a warm one in drizzle's mapping alone, and as much again in the messages and the writer
 * (../test/runtime/cpu.test.ts measures every list as an isolate's first API request). Synthetic data only; nothing is
 * read or written, and no I/O happens (the global scope allows none).
 */
import { getTableColumns, type Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  ListFlowsResponseSchema,
  ListNotesResponseSchema,
  ListTasksResponseSchema,
  ListTimeEntriesResponseSchema,
  QueryAnalyticsResponseSchema,
} from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { flowMessage, noteMessage, taskMessage, timeEntryMessage } from './api.ts';
import type { Db } from './db.ts';
import type { FlowTaskRow, NoteRecord, TaskRecord, TimeEntryRecord } from './model.ts';
import { tasks as tasksTable, timeEntries } from './schema.ts';
import { analyticsEntriesQuery, entryPage, listTimeEntriesQuery } from './store/entries.ts';
import { completedRowsBetweenQuery, completedRowsQuery, flowRowsBetweenQuery, plannedRowsQuery } from './store/flows.ts';
import { listNotesQuery } from './store/notes.ts';
import { planningDaysBetweenQuery } from './store/settings.ts';
import { listTasksQuery, mapTaskRow, taskPage, tasksByIdsQuery } from './store/tasks.ts';

/**
 * Rows per round, and the rounds: enough for V8's optimizing tier. Measured in workerd (../test/runtime/cpu.test.ts):
 * 50, 100 and 200 rounds of 5 rows give the same first requests; 100 add about 80 ms to the isolate's startup (wall
 * time in Miniflare, 200 about 135 ms), within Workers' 1 s startup limit.
 */
const BATCH = 5;
export const WARMUP_ROUNDS = 100;

const DAY = '2026-01-01';

/** A task row as D1 stores it (every column set), keyed by drizzle's column names. */
const TASK_ROW: typeof tasksTable.$inferSelect = {
  id: 'warmup-task',
  todoistId: 'warmup-task',
  title: 'Warm-up task',
  projectName: 'Warm-up project',
  projectColor: '#808080',
  priority: 2,
  labels: '["warm","up"]',
  estimatedMins: 30,
  isCompleted: 0,
  completedAt: '2026-01-01T00:00:00.000000Z',
  dueDate: DAY,
  createdAt: '2026-01-01T00:00:00Z',
  syncedAt: '2026-01-01T00:00:00Z',
  description: 'Warm-up description',
  deletedAt: '2026-01-01T00:00:00.000Z',
  deletedSource: 'local',
  todoistProjectId: 'warmup-project',
};

const ENTRY_ROW: TimeEntryRecord = {
  id: 'warmup-entry',
  taskId: 'warmup-task',
  flowDate: DAY,
  startTime: '2026-01-01T09:00:00.000Z',
  endTime: '2026-01-01T09:30:00.000Z',
  durationS: 1800,
  source: 'manual',
  createdAt: '2026-01-01 09:30:00',
};

const NOTE_ROW = { id: 'warmup-note', taskId: 'warmup-task', flowDate: DAY, content: 'Warm-up note', updatedAt: '2026-01-01T09:30:00.000Z' };

/** A row of `table` as D1's raw() answers it: the values in the table's column order (the order drizzle selects in). */
function rawRow(table: Table, record: object): unknown[] {
  const values = record as Readonly<Record<string, unknown>>;
  return Object.keys(getTableColumns(table)).map((key) => values[key] ?? null);
}

/** A D1 binding whose statements are prepared and bound but never run (the queries are only built and mapped). */
function stubDb(): Db {
  const statement = { bind: () => statement };
  return drizzle({ prepare: () => statement } as unknown as D1Database);
}

/** What one round of the queries mapped (the last round's, for ../test/warmup.test.ts). */
export interface WarmedRows {
  readonly tasks: TaskRecord[];
  readonly tasksById: TaskRecord[];
  readonly entries: TimeEntryRecord[];
  readonly analyticsEntries: TimeEntryRecord[];
  readonly notes: NoteRecord[];
  readonly planned: FlowTaskRow[];
  readonly completed: FlowTaskRow[];
  readonly flowRows: FlowTaskRow[];
  readonly completedRows: FlowTaskRow[];
  readonly planningKeys: string[];
}

/** Builds each list's query and maps BATCH synthetic raw rows through it, as a request does with D1's answer. */
export function warmQueries(db: Db = stubDb()): WarmedRows {
  const repeat = <T>(row: T): T[] => Array.from({ length: BATCH }, () => row);
  const taskRows = listTasksQuery(db, { afterRowid: 1, limit: BATCH, showDeleted: true }).prepare().mapAllResult(repeat([1, ...rawRow(tasksTable, TASK_ROW)]));
  const range = { start: DAY, end: DAY };
  return {
    tasks: taskPage(taskRows as Parameters<typeof taskPage>[0], BATCH).tasks,
    tasksById: (tasksByIdsQuery(db, [TASK_ROW.id]).prepare().mapAllResult(repeat(rawRow(tasksTable, TASK_ROW))) as (typeof TASK_ROW)[]).map(mapTaskRow),
    entries: entryPage(
      listTimeEntriesQuery(db, { taskId: ENTRY_ROW.taskId, flowDate: DAY, after: { startTime: ENTRY_ROW.startTime, id: ENTRY_ROW.id }, limit: BATCH })
        .prepare()
        .mapAllResult(repeat(rawRow(timeEntries, ENTRY_ROW))) as TimeEntryRecord[],
      BATCH,
    ).entries,
    analyticsEntries: entryPage(
      analyticsEntriesQuery(db, range, { flowDate: DAY, startTime: ENTRY_ROW.startTime, id: ENTRY_ROW.id }, BATCH).prepare().mapAllResult(repeat(rawRow(timeEntries, ENTRY_ROW))) as TimeEntryRecord[],
      BATCH,
    ).entries,
    notes: listNotesQuery(db, DAY, '', BATCH).prepare().mapAllResult(repeat([NOTE_ROW.taskId, NOTE_ROW.flowDate, NOTE_ROW.content, NOTE_ROW.updatedAt])) as NoteRecord[],
    planned: plannedRowsQuery(db, range, { flowDate: DAY, sortOrder: 0, taskId: TASK_ROW.id }, BATCH).prepare().mapAllResult(repeat([DAY, TASK_ROW.id, 1])) as FlowTaskRow[],
    completed: completedRowsQuery(db, range, { flowDate: DAY, rowid: 1 }, BATCH).prepare().mapAllResult(repeat([DAY, TASK_ROW.id, 2])) as FlowTaskRow[],
    flowRows: flowRowsBetweenQuery(db, DAY, DAY).prepare().mapAllResult(repeat([DAY, TASK_ROW.id])) as FlowTaskRow[],
    completedRows: completedRowsBetweenQuery(db, DAY, DAY).prepare().mapAllResult(repeat([DAY, TASK_ROW.id])) as FlowTaskRow[],
    planningKeys: (planningDaysBetweenQuery(db, DAY, DAY).prepare().mapAllResult(repeat([`planning_completed:${DAY}`])) as { key: string }[]).map((row) => row.key),
  };
}

/** Writes each list's answer from one round's rows, as the handlers do. */
function writeAnswers(rows: WarmedRows): void {
  const tasks = rows.tasks.map(taskMessage);
  JSON.stringify(toWire(ListTasksResponseSchema, create(ListTasksResponseSchema, { tasks, nextPageToken: 'warm' })));
  const flows = rows.flowRows.map((row) => flowMessage(row.flowDate, [row.taskId, row.taskId], rows.completedRows.map((done) => done.taskId), true));
  JSON.stringify(toWire(ListFlowsResponseSchema, create(ListFlowsResponseSchema, { flows, nextPageToken: 'warm' })));
  const timeEntries = rows.entries.map(timeEntryMessage);
  JSON.stringify(toWire(ListTimeEntriesResponseSchema, create(ListTimeEntriesResponseSchema, { timeEntries, nextPageToken: 'warm' })));
  JSON.stringify(toWire(ListNotesResponseSchema, create(ListNotesResponseSchema, { notes: rows.notes.map(noteMessage), nextPageToken: 'warm' })));
  JSON.stringify(
    toWire(
      QueryAnalyticsResponseSchema,
      create(QueryAnalyticsResponseSchema, {
        plannedTasks: rows.planned.map(({ flowDate, taskId }) => ({ flowDate, taskId })),
        completedTasks: rows.completed.map(({ flowDate, taskId }) => ({ flowDate, taskId })),
        timeEntries: rows.analyticsEntries.map(timeEntryMessage),
        tasks: rows.tasksById.map(taskMessage),
        nextPageToken: 'warm',
        dayCapacityMinutes: 360,
      }),
    ),
  );
}

/** Runs `rounds` rounds of every list's queries and answers. */
export function warmUp(rounds: number = WARMUP_ROUNDS): void {
  const db = stubDb();
  for (let round = 0; round < rounds; round += 1) writeAnswers(warmQueries(db));
}
