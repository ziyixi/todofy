/**
 * CPU of the heaviest handlers inside workerd, against Workers Free's 10 ms per request (../../../docs/design.md
 * "Free limits"), measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU
 * profile of the Worker's isolate around each request, and the machine's speed from a fixed workload run in the same
 * isolate. Each request runs several times; the first includes the isolate's warm-up and is reported separately.
 * Every number is divided by its isolate's speed (never below 1), in milliseconds of the reference machine (an Apple
 * M1 Max). A median speed above MAX_SPEED fails the test.
 *
 * The heavy handlers are bounded by their warm best, which one isolate measures well (its 2,000 time entries would
 * make a busy machine's run of several isolates minutes long). The isolate's first API request is measured on its
 * own, for every list the UI may ask for first (FIRST_REQUESTS: opening a page, a review or the export after
 * Cloudflare evicted the isolate), each in COLD_ISOLATES fresh isolates, on a heavy owner's history: the largest
 * first page of each (the owner API's queries and answers run at startup, ../../src/warmup.ts), and the bounds hold
 * each number's median across the isolates. The Tasks sync's page is measured cold in ./native-tasks-cpu.test.ts.
 */
import { CommandTimerRequest_Action as Action } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { Meter } from '../../src/db.ts';
import type { TaskRecord } from '../../src/model.ts';
import { createTimeEntry } from '../../src/store/entries.ts';
import { setFlowTaskIds } from '../../src/store/flows.ts';
import { upsertTasks } from '../../src/store/tasks.ts';
import { ANALYTICS_PAGE, ENTRY_PAGE, FLOW_PAGE, NOTE_PAGE, TASK_PAGE } from '../../src/limits.ts';
import { startHarness, type Harness } from './harness.ts';

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

/** A heavy owner's mirrored tasks. */
const TASKS = 1000;

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

/** The heavy handlers, warm, in one isolate, on TASKS mirrored tasks and a year of history. */
async function session({ h, meter }: FlowDayIsolate): Promise<Measurement[]> {
  await h.reset();
  await upsertTasks(h.db(), Array.from({ length: TASKS }, (_, n) => storedTask(n)));
  // Fetches the CSRF token outside the measurements (a mutation that writes nothing: there is no session).
  await h.api.updateFlow({ flow: { name: 'flows/2026-10-13', taskIds: [] }, updateMask: { paths: ['task_ids'] } });

  // The task list of the largest account: its largest page.
  const tasks = await meter.measure(`ListTasks (a page of ${String(TASK_PAGE)} of ${String(TASKS)} tasks)`, () => h.fetch('/api/v1/tasks').then((response) => response.text()));

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
  const timer = await meter.measure('CommandTimer START (version check and receipt)', async () => {
    const current = await h.api.getTimerSession({ name: 'timerSession' });
    await h.api.commandTimer({ name: 'timerSession', requestId: crypto.randomUUID(), etag: current.etag, action: Action.START, taskId: 'td-0', flowDate: '2026-10-13' });
  });
  const page = await meter.measure('GET / (page CSP hashing)', () => h.fetch('/').then((response) => response.text()));
  return [tasks, flows, entries, stats, week, timer, page];
}

/** A mirrored task with every field the list answers, stored as the sync stores it. */
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
 * A heavy owner's history: TASKS mirrored tasks; HISTORY_DAYS days of 8 planned tasks each, the first 4 done and the
 * planning completed; 2,000 half-hour time entries (6 a day) and a task logged on ENTRY_PAGE times; and NOTE_PAGE
 * notes of 2,000 characters on one day. Seeded by SQL from Node, outside the measured isolate's CPU.
 */
async function seedHistory(h: Harness): Promise<void> {
  await upsertTasks(h.db(), Array.from({ length: TASKS }, (_, n) => storedTask(n)));
  const days = Array.from({ length: HISTORY_DAYS }, (_, n) => historyDay(n));
  await insertRows(h, 'flow_tasks', days.flatMap((day, n) => Array.from({ length: 8 }, (_, k) => ({ id: `f-${String(n)}-${String(k)}`, flow_date: day, task_id: taskId((n * 8 + k) % TASKS), sort_order: k }))));
  await insertRows(h, 'completed_flow_tasks', days.flatMap((day, n) => Array.from({ length: 4 }, (_, k) => ({ id: `c-${String(n)}-${String(k)}`, flow_date: day, task_id: taskId((n * 8 + k) % TASKS) }))));
  await insertRows(h, 'settings', days.map((day) => ({ key: `planning_completed:${day}`, value: 'true' })));
  await insertRows(
    h,
    'time_entries',
    Array.from({ length: 2000 }, (_, n) => {
      const day = historyDay(Math.floor(n / 6));
      const hour = String(8 + (n % 6)).padStart(2, '0');
      return { id: `e-${String(n)}`, task_id: taskId((Math.floor(n / 6) * 8 + (n % 6)) % TASKS), flow_date: day, start_time: `${day}T${hour}:00:00.000Z`, end_time: `${day}T${hour}:30:00.000Z`, duration_s: 1800, source: 'timer', created_at: '2026-04-01 00:00:00' };
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
  { label: `ListTasks (a page of ${String(TASK_PAGE)} of ${String(TASKS)} tasks)`, path: '/api/v1/tasks' },
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

  it('the heaviest handlers stay below the limit', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(1, startIsolate, session);
    console.log(`cpu bounds (reference ms): warm best < ${WARM_BOUND_MS.toFixed(2)}`);
    expect(reference.size).toBe(7);
    for (const { label, best } of reference.values()) expect(best, `${label}: warm best`).toBeLessThan(WARM_BOUND_MS);
  });
});
