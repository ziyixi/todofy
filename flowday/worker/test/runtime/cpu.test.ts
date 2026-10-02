/**
 * CPU of the heaviest handlers inside workerd, against Workers Free's 10 ms per request (../../../docs/design.md
 * "Free limits"), measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU
 * profile of the Worker's isolate around each request, and the machine's speed from a fixed workload run in the same
 * isolate. Each request runs several times; the first includes the isolate's warm-up and is reported separately.
 *
 * The sync's first chunk, the one number measured on the isolate's first run, is measured in COLD_ISOLATES fresh
 * isolates (a new harness each, measureInIsolates); the other handlers, bounded by their warm best only, once, in the
 * third (a fourth or later isolate, measured again after a disturbed calibration, repeats only the sync: the other
 * handlers' 2,000 time entries would make a busy machine's run several minutes long). Every number is divided by its own isolate's speed (never below 1), and the bounds hold each number's
 * median across the isolates that measured it, in milliseconds of the reference machine (an Apple M1 Max). A median
 * speed above MAX_SPEED fails the test.
 *
 * The isolate's first API request is measured on its own, for every list the UI may ask for first (FIRST_REQUESTS:
 * opening a page, a review or the export after Cloudflare evicted the isolate), each in COLD_ISOLATES more fresh
 * isolates, on a heavy owner's history: the largest first page of each (the owner API's queries and answers run at
 * startup, ../../src/warmup.ts).
 */
import { SyncTasksRequest_Mode, SyncTasksResponse_State } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { Meter } from '../../src/db.ts';
import type { TaskRecord } from '../../src/model.ts';
import { createTimeEntry } from '../../src/store/entries.ts';
import { setFlowTaskIds } from '../../src/store/flows.ts';
import { upsertTasks } from '../../src/store/tasks.ts';
import { ANALYTICS_PAGE, ENTRY_PAGE, FLOW_PAGE, NOTE_PAGE, TASK_PAGE } from '../../src/limits.ts';
import { SYNC_CHUNK } from '../../src/sync.ts';
import { MAX_SYNC_BYTES, MAX_SYNC_ITEMS } from '../../src/todoist.ts';
import { startHarness, storeTodoistKey, type FakeItem, type Harness } from './harness.ts';

/**
 * The bound for an isolate's first run of the sync (the median of COLD_ISOLATES isolates), in reference milliseconds.
 * The reference machine measures about 8.6 ms for MAX_SYNC_ITEMS, of which about 6 ms is the first run of the sync's
 * code with any answer size; 2,000 items measured 10-14 ms; GitHub runners read single isolates 8.8-11.0 ms (15 runs,
 * 2026-10-01). So the bound only catches a large regression; the printed numbers are the ones to watch. On Cloudflare
 * a request stopped for CPU resumes from its pending chunk after the failure backoff (../../src/sync.ts).
 */
const COLD_BOUND_MS = 1.5 * FREE_CPU_MS;
/** Warm runs keep a margin below the limit (reference milliseconds). */
const WARM_BOUND_MS = 0.6 * FREE_CPU_MS;
/**
 * The bound for an isolate's first API request (the median of COLD_ISOLATES isolates), in reference milliseconds: the
 * Free limit itself. The reference machine measures 3.8-7.0 ms for the lists' largest first pages (the D1 query,
 * edge-auth and the transcoder running for the first time; drizzle, the messages and the writer were warmed at
 * startup), against 6.0-25.6 ms before the startup warm-up covered every list's query and answer and before an
 * analytics page bounded its flows (a year's first page). Runners read cold runs up to about 1.3 times the reference
 * machine (tools/workerd-cpu), which the largest, 7.0 ms, stays within.
 */
const FIRST_REQUEST_BOUND_MS = FREE_CPU_MS;

const FIRST_CHUNK = `SyncTasks, first chunk of a full sync of ${String(MAX_SYNC_ITEMS)} tasks`;

/** A fresh isolate: a new harness, its meter connected. */
interface FlowDayIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<FlowDayIsolate> {
  // Port 0: the OS picks a free port, which the meter reads back from Miniflare.
  const h = await startHarness({ inspectorPort: 0 });
  try {
    const meter = await connectCpuMeter(h.mf, 'flowday');
    return {
      h,
      meter,
      async dispose() {
        meter.close();
        await h.dispose();
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

function items(count: number): FakeItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `td-${String(index)}`,
    content: `Synthetic task ${String(index)} with a realistic, somewhat longer title`,
    description: index % 3 === 0 ? 'A synthetic description of moderate length, two sentences. Nothing real.' : '',
    project_id: `p-${String(index % 8)}`,
    priority: 1 + (index % 4),
    labels: index % 5 === 0 ? ['quick', 'home'] : [],
    due: index % 2 === 0 ? { date: '2026-04-13T09:30:00' } : null,
    duration: index % 4 === 0 ? { amount: 30, unit: 'minute' } : null,
  }));
}

/**
 * One isolate's session: the sync's first chunk, whose first run is the isolate's first sync of all (cold); in the
 * third isolate only, the other heavy handlers (bounded by their warm best, which one isolate measures well).
 */
async function session({ h, meter }: FlowDayIsolate, index: number): Promise<Measurement[]> {
  await h.reset();
  await storeTodoistKey(h.db(), 'synthetic-token');
  h.todoist.setProjects(Array.from({ length: 8 }, (_, n) => ({ id: `p-${String(n)}`, name: `Project ${String(n)}`, color: 'blue' })));
  // The largest answer FlowDay accepts, with every field of a Todoist API v1 item (./harness.ts FakeTodoist).
  h.todoist.setItems(items(MAX_SYNC_ITEMS));
  const answerBytes = (await h.todoist.answer(new Request('https://x/', { method: 'POST' }), 'sync_token=*').arrayBuffer()).byteLength;
  console.log(`cpu: the full answer of ${String(MAX_SYNC_ITEMS)} items is ${(answerBytes / 1024).toFixed(0)} KiB (cap ${String(MAX_SYNC_BYTES / 1024)} KiB)`);
  expect(answerBytes).toBeLessThan(MAX_SYNC_BYTES);
  // Fetches the CSRF token outside the measurements (a mutation that writes nothing: there is no session).
  await h.api.clearTimerSession({ name: 'timerSession' });
  const sync = async (expected: SyncTasksResponse_State) => {
    const result = await h.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }));
    if (result.value?.state !== expected) throw new Error(`sync ${String(result.status?.httpStatus)} ${String(result.value?.state)}`);
  };
  // Each run is the first chunk of a new full pass: parse every item, apply SYNC_CHUNK of them. The first run is
  // the isolate's first sync of all (cold).
  const firstChunk = await meter.measure(FIRST_CHUNK, async () => {
    await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at', 'todoist_sync_token', 'todoist_sync_pending')");
    await sync(SyncTasksResponse_State.PARTIAL);
  });
  if (index !== COLD_ISOLATES - 1) return [firstChunk];
  // The last chunk also hides every task the full list does not name (one JSON list of every id).
  const sortedIds = items(MAX_SYNC_ITEMS).map((item) => item.id).sort();
  const lastAfter = sortedIds[sortedIds.length - SYNC_CHUNK / 2 - 1] ?? '';
  const lastChunk = await meter.measure(`SyncTasks, last chunk of a full sync of ${String(MAX_SYNC_ITEMS)} tasks`, async () => {
    await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at', 'todoist_sync_token')");
    await h.sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('todoist_sync_pending', ?)", JSON.stringify({ base: '*', token: 'first', after: lastAfter }));
    await sync(SyncTasksResponse_State.SYNCED);
  });

  let change = 0;
  const incremental = await meter.measure('SyncTasks, incremental with 20 changes', async () => {
    change += 1;
    for (let n = 0; n < 20; n += 1) h.todoist.update(`td-${String(n * 13)}`, { content: `Changed ${String(change)}` });
    await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
    await sync(SyncTasksResponse_State.SYNCED);
  });

  // The task list of the largest account: its largest page.
  const tasks = await meter.measure(`ListTasks (a page of ${String(TASK_PAGE)} of ${String(MAX_SYNC_ITEMS)} tasks, after the sync)`, () => h.fetch('/api/v1/tasks').then((response) => response.text()));

  // 1,000 hours of time entries over a year (2,000 half-hour entries) and their flows.
  const db = h.db(new Meter());
  for (let n = 0; n < 2000; n += 1) {
    const day = new Date(Date.UTC(2025, 3, 13) + Math.floor(n / 6) * 86_400_000).toISOString().slice(0, 10);
    await createTimeEntry(db, { id: `e-${String(n)}`, taskId: `td-${String(n % 300)}`, flowDate: day, startTime: `${day}T${String(8 + (n % 6)).padStart(2, '0')}:00:00Z`, endTime: `${day}T${String(8 + (n % 6)).padStart(2, '0')}:30:00Z`, durationS: 1800, source: 'timer' });
  }
  for (let n = 0; n < 30; n += 1) await setFlowTaskIds(db, `2026-04-${String(1 + n).padStart(2, '0')}`, Array.from({ length: 8 }, (_, k) => `td-${String(n * 8 + k)}`));
  // A year of planned days before them (8 tasks each) and one task logged on 300 times: the largest pages of ListFlows
  // and ListTimeEntries.
  for (let n = 0; n < 365; n += 1) {
    const flowDate = new Date(Date.UTC(2025, 2, 1) + n * 86_400_000).toISOString().slice(0, 10);
    await setFlowTaskIds(db, flowDate, Array.from({ length: 8 }, (_, k) => `td-${String((n * 8 + k) % 1000)}`));
  }
  for (let n = 0; n < ENTRY_PAGE; n += 1) {
    const start = new Date(Date.UTC(2025, 0, 1) + n * 3_600_000).toISOString();
    await createTimeEntry(db, { id: `busy-${String(n)}`, taskId: 'td-busy', flowDate: start.slice(0, 10), startTime: start, endTime: null, durationS: 600, source: 'timer' });
  }
  const flows = await meter.measure(`ListFlows (a page of ${String(FLOW_PAGE)} of 395 days)`, () => h.fetch('/api/v1/flows').then((response) => response.text()));
  const entries = await meter.measure(`ListTimeEntries (a page of ${String(ENTRY_PAGE)} of a task's entries)`, () => h.fetch('/api/v1/timeEntries?task_id=td-busy').then((response) => response.text()));
  const stats = await meter.measure(`QueryAnalytics (every entry: a page of ${String(ANALYTICS_PAGE)} of 2,000, 1,000 hours)`, () => h.fetch('/api/v1/analytics:query').then((response) => response.text()));
  const week = await meter.measure('QueryAnalytics (one week)', () => h.fetch('/api/v1/analytics:query?start_date=2026-04-06&end_date=2026-04-12').then((response) => response.text()));
  const page = await meter.measure('GET / (page CSP hashing)', () => h.fetch('/').then((response) => response.text()));
  return [firstChunk, lastChunk, incremental, tasks, flows, entries, stats, week, page];
}

/** A Todoist task with every field the list answers, stored as the sync stores it. */
function storedTask(n: number): TaskRecord {
  return {
    id: taskId(n),
    todoistId: taskId(n),
    title: `Synthetic task ${String(n)} with a realistic, somewhat longer title`,
    description: n % 3 === 0 ? 'A synthetic description of moderate length, two sentences. Nothing real.' : null,
    projectName: `Project ${String(n % 8)}`,
    projectColor: '#4073ff',
    priority: (1 + (n % 4)) as TaskRecord['priority'],
    labels: n % 5 === 0 ? ['quick', 'home'] : [],
    estimatedMins: n % 4 === 0 ? 30 : null,
    isCompleted: false,
    completedAt: null,
    dueDate: n % 2 === 0 ? '2026-04-13' : null,
    createdAt: '2026-04-01T00:00:00.000000Z',
    deletedAt: null,
  };
}

function taskId(n: number): string {
  return `td-${String(n).padStart(4, '0')}`;
}

const DAY_MS = 86_400_000;
/** The history of the first-request isolates: HISTORY_DAYS days from HISTORY_START, a year and a month. */
const HISTORY_START = Date.UTC(2025, 2, 1);
const HISTORY_DAYS = 396;
const historyDay = (n: number): string => new Date(HISTORY_START + n * DAY_MS).toISOString().slice(0, 10);
const HISTORY_FIRST = historyDay(0);
const HISTORY_LAST = historyDay(HISTORY_DAYS - 1);
/** The day with a note on each of NOTE_PAGE tasks. */
const NOTE_DAY = historyDay(300);

/** Inserts the rows of `rows` (JSON objects keyed by column) into `table` in one statement. */
async function insertRows(h: Harness, table: string, rows: readonly Record<string, string | number | null>[]): Promise<void> {
  const [first] = rows;
  if (first === undefined) return;
  const columns = Object.keys(first);
  const values = columns.map((column) => `json_extract(value, '$.${column}')`).join(', ');
  await h.sql(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${values} FROM json_each(?)`, JSON.stringify(rows));
}

/**
 * A heavy owner's history: 1,000 Todoist tasks; HISTORY_DAYS days of 8 planned tasks each, the first 4 done and the
 * planning completed; 2,000 half-hour time entries (6 a day) and a task logged on ENTRY_PAGE times; and NOTE_PAGE
 * notes of 2,000 characters on one day. Seeded by SQL from Node, outside the measured isolate's CPU.
 */
async function seedHistory(h: Harness): Promise<void> {
  await upsertTasks(h.db(), Array.from({ length: MAX_SYNC_ITEMS }, (_, n) => storedTask(n)));
  const days = Array.from({ length: HISTORY_DAYS }, (_, n) => historyDay(n));
  await insertRows(h, 'flow_tasks', days.flatMap((day, n) => Array.from({ length: 8 }, (_, k) => ({ id: `f-${String(n)}-${String(k)}`, flow_date: day, task_id: taskId((n * 8 + k) % MAX_SYNC_ITEMS), sort_order: k }))));
  await insertRows(h, 'completed_flow_tasks', days.flatMap((day, n) => Array.from({ length: 4 }, (_, k) => ({ id: `c-${String(n)}-${String(k)}`, flow_date: day, task_id: taskId((n * 8 + k) % MAX_SYNC_ITEMS) }))));
  await insertRows(h, 'settings', days.map((day) => ({ key: `planning_completed:${day}`, value: 'true' })));
  await insertRows(
    h,
    'time_entries',
    Array.from({ length: 2000 }, (_, n) => {
      const day = historyDay(Math.floor(n / 6));
      const hour = String(8 + (n % 6)).padStart(2, '0');
      return { id: `e-${String(n)}`, task_id: taskId((Math.floor(n / 6) * 8 + (n % 6)) % MAX_SYNC_ITEMS), flow_date: day, start_time: `${day}T${hour}:00:00.000Z`, end_time: `${day}T${hour}:30:00.000Z`, duration_s: 1800, source: 'timer', created_at: '2026-04-01 00:00:00' };
    }),
  );
  await insertRows(
    h,
    'time_entries',
    Array.from({ length: ENTRY_PAGE }, (_, n) => {
      const start = new Date(HISTORY_START + n * 3_600_000).toISOString();
      return { id: `busy-${String(n)}`, task_id: 'td-busy', flow_date: start.slice(0, 10), start_time: start, end_time: null, duration_s: 600, source: 'timer', created_at: '2026-04-01 00:00:00' };
    }),
  );
  await insertRows(h, 'flow_task_notes', Array.from({ length: NOTE_PAGE }, (_, n) => ({ id: `n-${String(n)}`, task_id: taskId(n), flow_date: NOTE_DAY, content: `Synthetic note ${String(n)}. `.padEnd(2000, 'x'), updated_at: '2026-04-01T00:00:00.000Z' })));
}

/**
 * The lists the UI may ask for first in a fresh isolate (opening a page or a review after Cloudflare evicted the
 * isolate), each measured as an isolate's first API request: the largest first page of each, on seedHistory's data.
 */
const FIRST_REQUESTS = [
  { label: `ListTasks (a page of ${String(TASK_PAGE)} of ${String(MAX_SYNC_ITEMS)} tasks)`, path: '/api/v1/tasks' },
  { label: `ListFlows (a page of ${String(FLOW_PAGE)} of ${String(HISTORY_DAYS)} days)`, path: '/api/v1/flows' },
  { label: `ListTimeEntries (a page of ${String(ENTRY_PAGE)} of a task's entries)`, path: '/api/v1/timeEntries?task_id=td-busy' },
  { label: `ListNotes (a page of ${String(NOTE_PAGE)} notes of 2,000 characters)`, path: `/api/v1/flows/${NOTE_DAY}/notes` },
  { label: 'QueryAnalytics, every entry (the first page)', path: '/api/v1/analytics:query' },
  { label: `QueryAnalytics, ${String(HISTORY_DAYS)} days (the first page)`, path: `/api/v1/analytics:query?start_date=${HISTORY_FIRST}&end_date=${HISTORY_LAST}` },
] as const;

/** A fresh isolate whose first API request is `first` (cold), then a small read. */
async function firstRequest({ h, meter }: FlowDayIsolate, first: (typeof FIRST_REQUESTS)[number]): Promise<Measurement[]> {
  await seedHistory(h);
  const list = await meter.measure(`${first.label}, the isolate's first API request`, async () => {
    const response = await h.fetch(first.path);
    const body = await response.text();
    if (response.status !== 200) throw new Error(`${first.path}: ${String(response.status)} ${body}`);
  });
  const settings = await meter.measure('GetSettings, after it', () => h.fetch('/api/v1/settings').then((response) => response.text()));
  return [list, settings];
}

describe('CPU per request (Workers Free: 10 ms)', () => {
  for (const first of FIRST_REQUESTS) {
    it(`an isolate's first API request: ${first.label}`, { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
      const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, (isolate) => firstRequest(isolate, first));
      const label = `${first.label}, the isolate's first API request`;
      console.log(`cpu bounds (reference ms, medians of the isolates): first API request < ${FIRST_REQUEST_BOUND_MS.toFixed(2)}, warm best < ${WARM_BOUND_MS.toFixed(2)}`);
      expect(reference.get(label)?.first, `${label}: first run`).toBeLessThan(FIRST_REQUEST_BOUND_MS);
      expect(reference.size).toBe(2);
      for (const { label: each, best } of reference.values()) expect(best, `${each}: warm best`).toBeLessThan(WARM_BOUND_MS);
    });
  }

  it('the heaviest handlers stay below the limit, the sync even on its cold first request', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(`cpu bounds (reference ms, medians of the isolates): first < ${COLD_BOUND_MS.toFixed(2)}, warm best < ${WARM_BOUND_MS.toFixed(2)}`);
    // The sync runs rarely, so it often lands on code the isolate has not run yet: its first run is bounded too.
    expect(reference.get(FIRST_CHUNK)?.first, `${FIRST_CHUNK}: first run`).toBeLessThan(COLD_BOUND_MS);
    expect(reference.size).toBe(9);
    for (const { label, best } of reference.values()) expect(best, `${label}: warm best`).toBeLessThan(WARM_BOUND_MS);
  });
});
