/**
 * The D1 rows the paged lists read (../../../docs/design.md "Read budget"). The UI reads every page of a list, so a
 * page that re-read a whole table (and sliced it) made one list read grow with the square of the data: every page
 * must read about its own rows. Each list is read to its last page through its handler (../../src/api.ts) on a heavy
 * owner's two years of synthetic history, and D1's own rows_read (meta.rows_read of each statement, as D1 bills it)
 * is added up through a binding that also counts the selects drizzle runs with raw(), which carry no meta (the
 * Worker's own meter, ../../src/db.ts, sees only run(), all() and batch()).
 */
import { create } from '@ziyixi/proto/protobuf';
import { ListFlowsRequestSchema, QueryAnalyticsRequestSchema } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers, type ApiContext } from '../../src/api.ts';
import { openDb, Meter } from '../../src/db.ts';
import type { Env } from '../../src/env.ts';
import { ANALYTICS_PAGE, FLOW_PAGE } from '../../src/limits.ts';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  await seed();
});
afterAll(async () => {
  await h.dispose();
});

const DAY_MS = 86_400_000;
const START = Date.UTC(2024, 9, 1);
const DAYS = 730;
const TASKS = 1000;
const ENTRIES = 4000;
const day = (n: number): string => new Date(START + n * DAY_MS).toISOString().slice(0, 10);
const taskId = (n: number): string => `td-${String(n % TASKS).padStart(4, '0')}`;

async function insertRows(table: string, rows: readonly Record<string, string | number | null>[]): Promise<void> {
  const columns = Object.keys(rows[0] ?? {});
  const values = columns.map((column) => `json_extract(value, '$.${column}')`).join(', ');
  await h.sql(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${values} FROM json_each(?)`, JSON.stringify(rows));
}

/** Two years: 1,000 tasks; 8 planned and 4 done tasks a day and every planning completed; 4,000 time entries. */
async function seed(): Promise<void> {
  await insertRows('tasks', Array.from({ length: TASKS }, (_, n) => ({ id: taskId(n), title: `Synthetic task ${String(n)}`, priority: 1, created_at: '2024-10-01T00:00:00Z' })));
  const days = Array.from({ length: DAYS }, (_, n) => day(n));
  await insertRows('flow_tasks', days.flatMap((flowDate, n) => Array.from({ length: 8 }, (_, k) => ({ id: `f-${String(n)}-${String(k)}`, flow_date: flowDate, task_id: taskId(n * 8 + k), sort_order: k }))));
  await insertRows('completed_flow_tasks', days.flatMap((flowDate, n) => Array.from({ length: 4 }, (_, k) => ({ id: `c-${String(n)}-${String(k)}`, flow_date: flowDate, task_id: taskId(n * 8 + k) }))));
  await insertRows('settings', days.map((flowDate) => ({ key: `planning_completed:${flowDate}`, value: 'true' })));
  await insertRows(
    'time_entries',
    Array.from({ length: ENTRIES }, (_, n) => {
      const flowDate = day(Math.floor((n * DAYS) / ENTRIES));
      // Inserted out of start-time order, as entries edited later are.
      const hour = String(8 + ((n * 7) % 10)).padStart(2, '0');
      return { id: `e-${String(n)}`, task_id: taskId(n), flow_date: flowDate, start_time: `${flowDate}T${hour}:00:00.000Z`, end_time: null, duration_s: 1800, source: 'timer' };
    }),
  );
}

/** A Db whose every statement adds D1's rows_read to `counter`, raw() too (it runs the statement once more for that). */
function countingContext(counter: { rowsRead: number }): ApiContext {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async () => {
        const result = await statement.all();
        counter.rowsRead += result.meta.rows_read;
        return result;
      },
      run: async () => {
        const result = await statement.run();
        counter.rowsRead += result.meta.rows_read;
        return result;
      },
      raw: async (options?: { columnNames?: boolean }) => {
        counter.rowsRead += (await statement.all()).meta.rows_read;
        return options?.columnNames === true ? statement.raw({ columnNames: true }) : statement.raw();
      },
      first: () => statement.first(),
    }) as unknown as D1PreparedStatement;
  const binding = { prepare: (query: string) => wrap(h.binding.prepare(query)) } as unknown as D1Database;
  return { env: {} as Env, db: openDb(binding, new Meter()), fetcher: fetch, now: () => new Date('2026-10-02T00:00:00Z') };
}

interface Reading {
  readonly pages: number;
  readonly rows: number;
  readonly rowsRead: number;
}

/** Reads a list to its last page; `page` answers the rows of one page and its next token. */
async function readAll(page: (pageToken: string, ctx: ApiContext) => Promise<{ rows: number; next: string }>): Promise<Reading> {
  const counter = { rowsRead: 0 };
  const ctx = countingContext(counter);
  let pages = 0;
  let rows = 0;
  let token = '';
  do {
    const answer = await page(token, ctx);
    pages += 1;
    rows += answer.rows;
    token = answer.next;
  } while (token !== '' && pages < 1000);
  return { pages, rows, rowsRead: counter.rowsRead };
}

function analytics(startDate: string, endDate: string) {
  return async (pageToken: string, ctx: ApiContext) => {
    const answer = await handlers.queryAnalytics(create(QueryAnalyticsRequestSchema, { startDate, endDate, pageToken }), ctx);
    // Each page also reads the tasks it names: count them as rows answered too.
    return { rows: answer.plannedTasks.length + answer.completedTasks.length + answer.timeEntries.length + answer.tasks.length, next: answer.nextPageToken };
  };
}

/**
 * The bound: rows read per row answered (a task a page names counts as a row answered). A page reads its rows through
 * an index that seeks to the cursor's day (the index entry and, unless the index covers the query, the row), the
 * tasks it names by primary key, the one extra row that tells whether more follow, and its last day's rows to sort
 * them; the measured ratios are 1.03 (every entry), 1.05 (a year) and 1.31 (ListFlows, whose days come from three
 * sources). Before each page sought to its cursor, a review's probe on similar data read 15 times (every entry), 3
 * times (a year) and 4 times (ListFlows) the rows of a single unpaged read, growing with the square of the data.
 */
const MAX_READ_PER_ROW = 2;

describe('rows read by the paged lists (D1 Free: 5,000,000 a day, shared by the account)', () => {
  it('QueryAnalytics without a range (every entry) reads about one page of rows per page', async () => {
    const reading = await readAll(analytics('', ''));
    console.log(`reads: QueryAnalytics, every entry: ${String(reading.pages)} pages, ${String(reading.rows)} rows answered, ${String(reading.rowsRead)} rows read`);
    expect(reading.pages).toBe(Math.ceil(ENTRIES / ANALYTICS_PAGE));
    expect(reading.rowsRead).toBeLessThan(MAX_READ_PER_ROW * reading.rows);
  });

  it('QueryAnalytics of a year reads about one page of rows per page', async () => {
    const reading = await readAll(analytics(day(100), day(464)));
    console.log(`reads: QueryAnalytics, 365 days: ${String(reading.pages)} pages, ${String(reading.rows)} rows answered, ${String(reading.rowsRead)} rows read`);
    expect(reading.rowsRead).toBeLessThan(MAX_READ_PER_ROW * reading.rows);
  });

  it('ListFlows reads about one page of rows per page', async () => {
    const reading = await readAll(async (pageToken, ctx) => {
      const answer = await handlers.listFlows(create(ListFlowsRequestSchema, { pageToken }), ctx);
      return { rows: answer.flows.reduce((sum, flow) => sum + 1 + flow.taskIds.length + flow.completedTaskIds.length, 0), next: answer.nextPageToken };
    });
    console.log(`reads: ListFlows: ${String(reading.pages)} pages, ${String(reading.rows)} rows answered, ${String(reading.rowsRead)} rows read`);
    expect(reading.pages).toBe(Math.ceil(DAYS / FLOW_PAGE));
    expect(reading.rowsRead).toBeLessThan(MAX_READ_PER_ROW * reading.rows);
  });

  it('QueryAnalytics pages hold every row of the range once, in order, at most page_size rows each', async () => {
    const ctx = countingContext({ rowsRead: 0 });
    const range = { startDate: day(10), endDate: day(40) };
    const planned: string[] = [];
    const completed: string[] = [];
    const entries: string[] = [];
    let pageToken = '';
    do {
      const page = await handlers.queryAnalytics(create(QueryAnalyticsRequestSchema, { ...range, pageSize: 37, pageToken }), ctx);
      const rows = page.plannedTasks.length + page.completedTasks.length + page.timeEntries.length;
      expect(rows).toBeLessThanOrEqual(37);
      expect(page.tasks.length).toBeLessThanOrEqual(rows);
      planned.push(...page.plannedTasks.map((row) => `${row.flowDate} ${row.taskId}`));
      completed.push(...page.completedTasks.map((row) => `${row.flowDate} ${row.taskId}`));
      entries.push(...page.timeEntries.map((entry) => entry.name));
      pageToken = page.nextPageToken;
    } while (pageToken !== '');
    const plannedRows = await h.sql<{ r: string }>('SELECT flow_date || \' \' || task_id AS r FROM flow_tasks WHERE flow_date BETWEEN ? AND ? ORDER BY flow_date, sort_order', range.startDate, range.endDate);
    const completedRows = await h.sql<{ r: string }>('SELECT flow_date || \' \' || task_id AS r FROM completed_flow_tasks WHERE flow_date BETWEEN ? AND ? ORDER BY flow_date, rowid', range.startDate, range.endDate);
    const entryRows = await h.sql<{ r: string }>("SELECT 'timeEntries/' || id AS r FROM time_entries WHERE flow_date BETWEEN ? AND ? ORDER BY flow_date, start_time, id", range.startDate, range.endDate);
    expect(planned).toEqual(plannedRows.map((row) => row.r));
    expect(completed).toEqual(completedRows.map((row) => row.r));
    expect(entries).toEqual(entryRows.map((row) => row.r));
  });
});
