/** Native source over the real FlowDay D1 store; only synthetic task metadata crosses the fake binding. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { CatalogSchema, ListChangesResponseSchema, type TaskChange } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { Meter } from '../../src/db.ts';
import { runSync, AUTO_SYNC_MIN_INTERVAL_MS } from '../../src/sync.ts';
import { getAllTasks, getDeletedTasks, updateTaskEstimate } from '../../src/store/tasks.ts';
import { KEY_TASKS_CURSOR } from '../../src/native-tasks.ts';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
const at = Date.parse('2026-10-17T10:00:00Z');
const requests: string[] = [];
type Change = Pick<TaskChange, 'name'> & Partial<Pick<TaskChange, 'task' | 'deleted'>>;
let changes: Change[] = [];
let status = 200;
const catalog = create(CatalogSchema, {
  projects: [{ id: 'work', name: 'projects/work', title: 'Work', color: '#246fe0' }],
  labels: [{ id: 'deep', name: 'labels/deep', title: 'deep' }],
});
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
});
async function sync(time = at) {
  const meter = new Meter();
  const result = await runSync({ db: h.db(meter), mode: 'auto', credentialKey: undefined, tasks: source, now: new Date(time) });
  return { result, written: meter.rowsWritten };
}

it('imports native IDs without a Todoist key and an unchanged page writes no task rows', async () => {
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
  expect(h.todoist.requests).toHaveLength(0);
});
it('preserves local estimates, queues and timer history while completed/deleted tasks hide and reopened tasks return', async () => {
  changes = [task('a'), task('b')];
  await sync();
  await updateTaskEstimate(h.db(), 'a', 45);
  await h.sql("INSERT INTO flow_tasks(id,flow_date,task_id,sort_order) VALUES ('planned','2026-10-17','a',0)");
  await h.sql("INSERT INTO active_timer_session(id,task_id,status,session_saved_s) VALUES ('main','a','paused',120)");
  changes.push(task('a', { title: 'Updated', durationMinutes: 60 }), { name: 'tasks/b', deleted: true });
  await sync(at + AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([expect.objectContaining({ id: 'a', title: 'Updated', estimatedMins: 45 })]);
  changes.push(task('a', { completed: true }));
  await sync(at + 2 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([]);
  expect(await getDeletedTasks(h.db())).toEqual([]);
  expect(await h.sql('SELECT task_id FROM flow_tasks')).toEqual([{ task_id: 'a' }]);
  expect(await h.sql('SELECT task_id,session_saved_s FROM active_timer_session')).toEqual([{ task_id: 'a', session_saved_s: 120 }]);
  changes.push(task('a'));
  await sync(at + 3 * AUTO_SYNC_MIN_INTERVAL_MS);
  expect(await getAllTasks(h.db())).toEqual([expect.objectContaining({ id: 'a', estimatedMins: 45 })]);
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
it('reports the native source without claiming a stored key and starts through the real owner API', async () => {
  changes = [task('a')];
  const settings = await h.api.getSettings({ name: 'settings' });
  expect(settings.taskSource).toBe('tasks');
  expect(settings.todoistApiKeySet).toBe(false);
  const result = await h.api.syncTasks({});
  expect(result.changedTaskCount).toBe(1);
  expect(h.todoist.requests).toHaveLength(0);
});
