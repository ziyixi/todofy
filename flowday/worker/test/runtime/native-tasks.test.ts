/**
 * The Tasks sync (../../src/native-tasks.ts) over the real FlowDay D1 store: what it writes and keeps, its throttle,
 * claim and failure backoff (../../src/sync-control.ts). runNativeSync is called from Node with explicit clocks; the
 * owner API tests go through the Worker. Only synthetic task metadata crosses the fake binding.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { SyncTasksRequest_Mode } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { CatalogSchema, ListChangesResponseSchema, type TaskChange } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { Meter } from '../../src/db.ts';
import { KEY_TASKS_CURSOR, runNativeSync } from '../../src/native-tasks.ts';
import { getAllTasks, getDeletedTasks, softDeleteTask, updateTaskEstimate } from '../../src/store/tasks.ts';
import { AUTO_SYNC_MIN_INTERVAL_MS, MANUAL_SYNC_MIN_INTERVAL_MS, autoInterval, type SyncMode } from '../../src/sync-control.ts';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
const at = Date.parse('2026-10-17T10:00:00Z');
const requests: string[] = [];
type Change = Pick<TaskChange, 'name'> & Partial<Pick<TaskChange, 'task' | 'deleted'>>;
let changes: Change[] = [];
let status = 200;
function syntheticCatalog(work = { title: 'Work', color: '#246fe0' }, label = 'deep') {
  return create(CatalogSchema, {
    projects: [
      { id: 'work', name: 'projects/work', ...work },
      { id: 'inbox', name: 'projects/inbox', title: 'Inbox', inbox: true },
    ],
    labels: [{ id: 'deep', name: 'labels/deep', title: label }],
  });
}
let catalog = syntheticCatalog();
function task(id: string, fields: Partial<ReturnType<typeof makeTask>> = {}) {
  return { name: `tasks/${id}`, task: makeTask(id, fields) };
}
function makeTask(id: string, fields: object = {}) {
  return create(TaskSchema, {
    id,
    name: `tasks/${id}`,
    title: `Synthetic ${id}`,
    projectId: 'work',
    labelIds: ['deep'],
    priority: 1,
    durationMinutes: 30,
    createTime: timestampFromMs(at),
    ...fields,
  });
}
function respond(request: Request): Response {
  const url = new URL(request.url);
  requests.push(url.pathname);
  expect(request.method).toBe('GET');
  if (status !== 200) return new Response(null, { status });
  if (url.pathname.endsWith('/catalog')) {
    expect(url.searchParams.get('include_task_counts')).toBe('false');
    return Response.json(toWire(CatalogSchema, catalog));
  }
  expect(url.pathname).toBe('/api/tasks/v1/changes');
  expect(url.searchParams.get('page_size')).toBe('100');
  const cursor = Number(url.searchParams.get('page_token') ?? '0');
  const page = changes.slice(cursor, cursor + 100);
  return Response.json(
    toWire(
      ListChangesResponseSchema,
      create(ListChangesResponseSchema, {
        changes: page.map((item, index) => ({ ...item, cursor: String(cursor + index + 1) })),
        nextPageToken: String(cursor + page.length),
        hasMore: cursor + page.length < changes.length,
        catalogChanged: page.some((item) => !item.name.startsWith('tasks/')),
      }),
    ),
  );
}
const source = { fetch: (input: RequestInfo | URL) => Promise.resolve(respond(input instanceof Request ? input : new Request(input))) };
beforeAll(async () => {
  h = await startHarness({ tasks: (request) => Promise.resolve(respond(request)) });
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
  requests.length = 0;
  changes = [];
  status = 200;
  catalog = syntheticCatalog();
});
async function sync(time = at, mode: SyncMode = 'auto') {
  const meter = new Meter();
  const result = await runNativeSync({ db: h.db(meter), mode, source, now: new Date(time) });
  return { result, written: meter.rowsWritten };
}
/** The pages of changes Tasks was asked for. */
const reads = () => requests.filter((path) => path.endsWith('/changes')).length;

it('imports Tasks IDs and an unchanged page writes no task rows', async () => {
  changes = [task('old-todoist-id')];
  expect((await sync()).result).toMatchObject({ kind: 'ok', response: { changed: 1, status: 'synced' } });
  expect(await getAllTasks(h.db())).toEqual([
    expect.objectContaining({
      id: 'old-todoist-id',
      todoistId: 'old-todoist-id',
      title: 'Synthetic old-todoist-id',
      labels: ['deep'],
      priority: 4,
      estimatedMins: 30,
      projectName: 'Work',
    }),
  ]);
  expect(await sync(at + AUTO_SYNC_MIN_INTERVAL_MS)).toMatchObject({ result: { kind: 'ok', response: { changed: 0 } }, written: 2 });
  expect(requests.filter((path) => path.endsWith('/catalog'))).toHaveLength(1);
});
it('takes estimates from Tasks only and keeps queues and timer history while completed/deleted tasks hide and reopened tasks return', async () => {
  changes = [task('a'), task('b')];
  await sync();
  // A mirrored task's estimate is not FlowDay's to set, and an override left by an older release is ignored.
  await updateTaskEstimate(h.db(), 'a', 45);
  expect((await getAllTasks(h.db())).find((row) => row.id === 'a')?.estimatedMins).toBe(30);
  await h.sql("UPDATE tasks SET estimated_mins=45, estimate_override=1 WHERE id='a'");
  await h.sql("INSERT INTO flow_tasks(id,flow_date,task_id,sort_order) VALUES ('planned','2026-10-17','a',0)");
  await h.sql("INSERT INTO active_timer_session(id,task_id,status,session_saved_s) VALUES ('main','a','paused',120)");
  changes.push(task('a', { title: 'Updated', durationMinutes: 60 }), { name: 'tasks/b', deleted: true });
  await sync(at + AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([expect.objectContaining({ id: 'a', title: 'Updated', estimatedMins: 60 })]);
  changes.push(task('a', { title: 'Updated', durationMinutes: 0 }));
  await sync(at + 2 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([expect.objectContaining({ id: 'a', estimatedMins: null })]);
  changes.push(task('a', { completed: true }));
  await sync(at + 3 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([]);
  expect(await getDeletedTasks(h.db())).toEqual([]);
  expect(await h.sql('SELECT task_id FROM flow_tasks')).toEqual([{ task_id: 'a' }]);
  expect(await h.sql('SELECT task_id,session_saved_s FROM active_timer_session')).toEqual([{ task_id: 'a', session_saved_s: 120 }]);
  changes.push(task('a'));
  await sync(at + 4 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([expect.objectContaining({ id: 'a', estimatedMins: 30 })]);
});
it('applies at most 100 changes and resumes the next page immediately with a separate cursor', async () => {
  changes = Array.from({ length: 101 }, (_, i) => task(`t${String(i)}`));
  expect((await sync()).result).toMatchObject({ kind: 'ok', response: { status: 'partial', changed: 100 } });
  expect((await sync(at + 1000)).result).toMatchObject({ kind: 'ok', response: { status: 'synced', changed: 1 } });
  expect(await getAllTasks(h.db())).toHaveLength(101);
  expect(await h.sql('SELECT value FROM settings WHERE key=?', KEY_TASKS_CURSOR)).toEqual([{ value: '101' }]);
  expect(await h.sql("SELECT key FROM settings WHERE key='todoist_sync_token'")).toEqual([]);
});
it('does not advance the cursor after an upstream failure, and project archive hides/restores without deleting history', async () => {
  changes = [task('a')];
  await sync();
  status = 503;
  expect((await sync(at + AUTO_SYNC_MIN_INTERVAL_MS)).result).toEqual({ kind: 'tasks' });
  expect(await h.sql('SELECT value FROM settings WHERE key=?', KEY_TASKS_CURSOR)).toEqual([{ value: '1' }]);
  status = 200;
  changes.push(task('a', { archived: true }));
  await sync(at + 3 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([]);
  changes.push(task('a'));
  await sync(at + 4 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect((await getAllTasks(h.db())).map((row) => row.id)).toEqual(['a']);
});
it('reports Tasks as the source without a stored key and syncs through the real owner API', async () => {
  changes = [task('a')];
  const settings = await h.api.getSettings({ name: 'settings' });
  expect(settings.taskSource).toBe('tasks');
  expect(settings.todoistApiKeySet).toBe(false);
  const result = await h.api.syncTasks({});
  expect(result.changedTaskCount).toBe(1);
  status = 503;
  await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
  const failed = await h.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }));
  expect(failed.status).toMatchObject({ httpStatus: 503, reason: 'TASKS_UNAVAILABLE' });
});
it('a task deleted in FlowDay stays deleted even when Tasks changes it', async () => {
  changes = [task('a'), task('b')];
  await sync();
  await softDeleteTask(h.db(), 'b');
  changes.push(task('b', { title: 'Edited in Tasks' }));
  await sync(at + AUTO_SYNC_MIN_INTERVAL_MS);
  expect((await getAllTasks(h.db())).map((row) => row.id)).toEqual(['a']);
  expect((await getDeletedTasks(h.db())).map((row) => row.id)).toEqual(['b']);
});
it('throttles: an automatic sync within 5 minutes and a manual one within 30 seconds read and write nothing', async () => {
  changes = [task('a')];
  await sync();
  const auto = await sync(at + AUTO_SYNC_MIN_INTERVAL_MS - 1);
  expect(auto).toEqual({
    result: { kind: 'ok', response: { status: 'throttled', changed: 0, fullSync: false, lastSyncAt: new Date(at).toISOString(), nextAutoSyncAt: at + AUTO_SYNC_MIN_INTERVAL_MS } },
    written: 0,
  });
  expect((await sync(at + MANUAL_SYNC_MIN_INTERVAL_MS - 1, 'manual')).result).toMatchObject({ response: { status: 'throttled' } });
  expect(reads()).toBe(1);
  expect((await sync(at + MANUAL_SYNC_MIN_INTERVAL_MS, 'manual')).result).toMatchObject({ response: { status: 'synced' } });
});
it('two concurrent syncs: exactly one reads Tasks', async () => {
  changes = [task('a')];
  const [a, b] = await Promise.all([sync(), sync()]);
  const states = [a.result, b.result].map((result) => (result.kind === 'ok' ? result.response.status : result.kind));
  expect(states.sort()).toEqual(['synced', 'throttled']);
  expect(reads()).toBe(1);
});
it('a failed read writes only the claim and keeps the last successful sync time', async () => {
  changes = [task('a')];
  await sync();
  status = 503;
  expect(await sync(at + AUTO_SYNC_MIN_INTERVAL_MS, 'manual')).toEqual({ result: { kind: 'tasks' }, written: 1 });
  expect(await h.sql('SELECT value FROM settings WHERE key = ?', 'last_sync_at')).toEqual([{ value: new Date(at).toISOString() }]);
});
it('failed syncs back off: the automatic interval doubles per failure (up to 32x) and resets after a success', async () => {
  changes = [task('a')];
  await sync();
  status = 503;
  let time = at;
  const intervals: number[] = [];
  for (let failures = 1; failures <= 7; failures += 1) {
    const wait = autoInterval(failures - 1);
    // One millisecond early: throttled, nothing read, nothing written.
    expect(await sync(time + wait - 1)).toMatchObject({ result: { response: { status: 'throttled', nextAutoSyncAt: time + wait } }, written: 0 });
    expect((await sync(time + wait)).result).toEqual({ kind: 'tasks' });
    time += wait;
    intervals.push(wait / AUTO_SYNC_MIN_INTERVAL_MS);
  }
  expect(intervals).toEqual([1, 2, 4, 8, 16, 32, 32]);
  // "Sync now" is not backed off; its success resets the interval.
  status = 200;
  expect((await sync(time + MANUAL_SYNC_MIN_INTERVAL_MS, 'manual')).result).toMatchObject({ response: { status: 'synced' } });
  expect((await sync(time + MANUAL_SYNC_MIN_INTERVAL_MS + AUTO_SYNC_MIN_INTERVAL_MS)).result).toMatchObject({ response: { status: 'synced' } });
});
it('a request stopped after its claim (e.g. out of CPU) counts as a failure, so it is not retried every 5 minutes', async () => {
  changes = [task('a')];
  await sync();
  // The claim of a request that never finished: newer than last_sync_at, nothing else written.
  await h.sql("UPDATE settings SET value = ? WHERE key = 'sync_claimed_at'", String(at + AUTO_SYNC_MIN_INTERVAL_MS));
  expect((await sync(at + 2 * AUTO_SYNC_MIN_INTERVAL_MS)).result).toMatchObject({ response: { status: 'throttled' } });
  expect((await sync(at + 3 * AUTO_SYNC_MIN_INTERVAL_MS)).result).toMatchObject({ response: { status: 'synced' } });
});
it('an interrupted run of pages resumes where it stopped, after the failure backoff', async () => {
  changes = Array.from({ length: 101 }, (_, i) => task(`t${String(i)}`));
  expect((await sync()).result).toMatchObject({ response: { status: 'partial', changed: 100 } });
  status = 503;
  expect((await sync(at + 1000)).result).toEqual({ kind: 'tasks' });
  status = 200;
  expect((await sync(at + 2000)).result).toMatchObject({ response: { status: 'throttled' } });
  expect((await sync(at + 1000 + autoInterval(1))).result).toMatchObject({ response: { status: 'synced', changed: 1 } });
  expect(await getAllTasks(h.db())).toHaveLength(101);
});
it('a Worker deployed without its TASKS binding answers TASKS_UNAVAILABLE and writes only the claim', async () => {
  const unbound = await startHarness({ tasks: null });
  try {
    const result = await unbound.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }));
    expect(result.status).toMatchObject({ httpStatus: 503, reason: 'TASKS_UNAVAILABLE' });
    expect(await unbound.sql('SELECT key FROM settings')).toEqual([{ key: 'sync_claimed_at' }]);
  } finally {
    await unbound.dispose();
  }
});

it('a project rename or recolour reaches every mirrored task once, and other catalog changes write none', async () => {
  changes = [task('a'), task('b'), task('elsewhere', { projectId: 'inbox' })];
  await sync();
  catalog = syntheticCatalog({ title: 'Office', color: '#db4035' });
  changes.push({ name: 'projects/work' });
  expect((await sync(at + AUTO_SYNC_MIN_INTERVAL_MS)).result).toMatchObject({ kind: 'ok', response: { changed: 2 } });
  const rows = await h.sql('SELECT id,project_name,project_color FROM tasks ORDER BY id');
  expect(rows).toEqual([
    { id: 'a', project_name: 'Office', project_color: '#db4035' },
    { id: 'b', project_name: 'Office', project_color: '#db4035' },
    { id: 'elsewhere', project_name: 'Inbox', project_color: null },
  ]);
  catalog = syntheticCatalog({ title: 'Office', color: '#db4035' }, 'focus');
  changes.push({ name: 'labels/deep' });
  expect((await sync(at + 2 * AUTO_SYNC_MIN_INTERVAL_MS)).result).toMatchObject({ kind: 'ok', response: { changed: 0 } });
  expect(await h.sql('SELECT id,project_name,project_color FROM tasks ORDER BY id')).toEqual(rows);
});
it('a task without a project is in the Inbox, and rows mirrored before are healed by the first catalog read', async () => {
  await h.sql(
    "INSERT INTO tasks(id,todoist_id,title,labels,priority,is_completed) VALUES ('mirrored-before','mirrored-before','Synthetic earlier mirror','[]',1,0)",
  );
  changes = [task('quick-add', { projectId: '' })];
  await sync();
  expect(await h.sql('SELECT id,project_name,todoist_project_id FROM tasks ORDER BY id')).toEqual([
    { id: 'mirrored-before', project_name: 'Inbox', todoist_project_id: 'inbox' },
    { id: 'quick-add', project_name: 'Inbox', todoist_project_id: 'inbox' },
  ]);
});
it('after a Tasks restore the reset replays the new feed: tasks it holds return, the rest stay hidden', async () => {
  changes = [task('kept'), task('dropped'), task('deleted-here')];
  await sync();
  await h.sql("UPDATE tasks SET deleted_at='2026-10-17T11:00:00.000Z', deleted_source='local' WHERE id='deleted-here'");
  await h.sql("INSERT INTO flow_tasks(id,flow_date,task_id,sort_order) VALUES ('planned','2026-10-17','kept',0)");
  await h.sql("INSERT INTO tasks(id,title,labels,priority,is_completed) VALUES ('local','Synthetic local task','[]',1,0)");
  const reset = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../../../deploy/reset-tasks-mirror.sql'), 'utf8');
  for (const statement of reset.replace(/--[^\n]*/g, '').split(';')) if (statement.trim()) await h.sql(statement);
  expect(await h.sql("SELECT key FROM settings WHERE key LIKE 'tasks_sync_%'")).toEqual([]);
  expect((await getAllTasks(h.db())).map((row) => row.id)).toEqual(['local']);
  // The restored database's feed starts again at 1 and no longer holds 'dropped'.
  changes = [task('kept', { title: 'Restored' }), task('deleted-here')];
  expect((await sync(at + AUTO_SYNC_MIN_INTERVAL_MS)).result).toMatchObject({
    kind: 'ok',
    response: { status: 'synced', fullSync: true },
  });
  expect((await getAllTasks(h.db())).map((row) => [row.id, row.title])).toEqual([
    ['kept', 'Restored'],
    ['local', 'Synthetic local task'],
  ]);
  expect((await getDeletedTasks(h.db())).map((row) => row.id)).toEqual(['deleted-here']);
  expect(await h.sql("SELECT deleted_source FROM tasks WHERE id='dropped'")).toEqual([{ deleted_source: 'sync' }]);
  expect(await h.sql('SELECT task_id FROM flow_tasks')).toEqual([{ task_id: 'kept' }]);
});
it('a simulated day (200 tasks, 20 Tasks changes, two open tabs polling every 10 minutes for 16 hours) stays far below 1,000 rows', async () => {
  // 40 of the tasks are in Work, whose rename rewrites each of them.
  const mirror = (n: number, fields: object = {}) => task(`t${String(n)}`, { projectId: n % 5 === 0 ? 'work' : 'inbox', ...fields });
  changes = Array.from({ length: 200 }, (_, n) => mirror(n));
  const day = at - 24 * 3_600_000;
  const first = [await sync(day), await sync(day + 1000)] as const;
  expect(first.map(({ result }) => result)).toMatchObject([{ response: { status: 'partial', changed: 100 } }, { response: { status: 'synced', changed: 100 } }]);
  // 10 edits, 3 reschedules, 3 completions, 1 deletion, 2 new tasks and 1 project rename, spread over the day.
  const edits: (() => void)[] = [
    ...Array.from({ length: 10 }, (_, n) => () => changes.push(mirror(n * 7, { title: `Edited ${String(n)}` }))),
    ...Array.from({ length: 3 }, (_, n) => () => changes.push(mirror(100 + n, { dueDate: '2026-10-20' }))),
    ...Array.from({ length: 3 }, (_, n) => () => changes.push(mirror(150 + n, { completed: true }))),
    () => changes.push({ name: 'tasks/t199', deleted: true }),
    () => changes.push(mirror(500)),
    () => changes.push(mirror(501)),
    () => {
      catalog = syntheticCatalog({ title: 'Renamed', color: '#299438' });
      changes.push({ name: 'projects/work' });
    },
  ];
  expect(edits).toHaveLength(20);
  const totals = { rowsWritten: 0, synced: 0, throttled: 0, reads: 0 };
  const readsBefore = reads();
  const POLL = 10 * 60_000;
  for (let time = at; time < at + 16 * 3_600_000; time += POLL) {
    if (Math.floor((time - at) / POLL) % 4 === 1) edits.shift()?.();
    // Two tabs (or a desktop window and a phone) poll three minutes apart: the throttle lets one through.
    for (const { result, written } of [await sync(time), await sync(time + 3 * 60_000)]) {
      totals.rowsWritten += written;
      if (result.kind === 'ok' && result.response.status === 'throttled') totals.throttled += 1;
      else if (result.kind === 'ok') totals.synced += 1;
    }
  }
  totals.reads = reads() - readsBefore;
  console.log(`write budget: the first sync of 200 tasks wrote ${String(first[0].written + first[1].written)} rows; the simulated day ${JSON.stringify(totals)}`);
  expect(edits).toHaveLength(0);
  expect(totals).toMatchObject({ synced: 96, throttled: 96, reads: 96 });
  // 96 syncs x 2 rows (claim, last_sync_at), the cursor after each change, the changed rows and the renamed project's.
  expect(totals.rowsWritten).toBeLessThan(320);
  // 3 rows per new task (row, key, deleted_at index) + the settings rows.
  expect(first[0].written + first[1].written).toBeLessThan(620);
});
