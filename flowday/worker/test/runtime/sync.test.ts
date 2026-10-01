/**
 * The incremental, read-only Todoist sync on real D1 (../../src/sync.ts): what it writes, what it keeps, and the
 * write budget (../../../docs/design.md "Write budget"). runSync is called from Node with explicit clocks against
 * the FakeTodoist; the HTTP tests go through the Worker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Meter } from '../../src/db.ts';
import { AUTO_SYNC_MIN_INTERVAL_MS, MANUAL_SYNC_MIN_INTERVAL_MS, SYNC_CHUNK, autoInterval, runSync, type SyncMode } from '../../src/sync.ts';
import { getAllTasks, getDeletedTasks, softDeleteTask, updateTaskEstimate } from '../../src/store/tasks.ts';
import { SYNTHETIC_BINDINGS, startHarness, storeTodoistKey, type FakeItem, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
  await storeTodoistKey(h.db(), 'synthetic-token');
});

const CREDENTIAL_KEY = SYNTHETIC_BINDINGS['CREDENTIAL_KEY'];

const T0 = Date.parse('2026-04-13T07:00:00.000Z');

function item(index: number, overrides: Partial<FakeItem> = {}): FakeItem {
  return {
    id: `td-${String(index)}`,
    content: `Synthetic task ${String(index)}`,
    project_id: `p-${String(index % 5)}`,
    priority: 1 + (index % 4),
    labels: index % 7 === 0 ? ['quick'] : [],
    due: index % 3 === 0 ? { date: '2026-04-13' } : null,
    duration: index % 2 === 0 ? { amount: 25, unit: 'minute' } : null,
    ...overrides,
  };
}

function seedTodoist(count: number): void {
  h.todoist.setProjects([0, 1, 2, 3, 4].map((n) => ({ id: `p-${String(n)}`, name: `Project ${String(n)}`, color: 'blue' })));
  h.todoist.setItems(Array.from({ length: count }, (_, index) => item(index)));
}

function attempt(at: number, mode: SyncMode = 'auto', meter = new Meter()) {
  return runSync({ db: h.db(meter), mode, credentialKey: CREDENTIAL_KEY, now: new Date(at), fetcher: h.todoist.fetcher });
}

async function sync(at: number, mode: SyncMode = 'auto') {
  const meter = new Meter();
  const outcome = await attempt(at, mode, meter);
  if (outcome.kind !== 'ok') throw new Error(`sync failed: ${outcome.kind}`);
  return { ...outcome.response, rowsWritten: meter.rowsWritten };
}

/** Syncs like the page does: asks again right away while the answer is `partial` (a second apart here). */
async function syncFully(at: number, mode: SyncMode = 'auto') {
  const requests = [await sync(at, mode)];
  while (requests.at(-1)?.status === 'partial') {
    if (requests.length > 50) throw new Error('the sync did not finish');
    requests.push(await sync(at + requests.length * 1000, mode));
  }
  return requests;
}

describe('incremental sync', () => {
  it('a full sync stores every active task with its project, priority, labels, due day and duration', async () => {
    h.todoist.setProjects([{ id: 'p-1', name: 'Inbox', color: 'orange' }, { id: 'p-2', name: 'Research', color: 'sky_blue' }]);
    h.todoist.setItems([
      { id: 'todoist-1', content: 'Write spec', description: 'Needs markdown review', project_id: 'p-1', priority: 4, labels: ['writing'], due: { date: '2026-04-15T09:30:00' }, duration: { amount: 90, unit: 'minute' } },
      { id: 'todoist-2', content: 'Deep work', project_id: 'p-2', priority: 2, due: { date: '2026-04-16' }, duration: { amount: 2, unit: 'day' } },
      { id: 'todoist-3', content: 'No duration', project_id: 'missing-project' },
    ]);
    const result = await sync(T0);
    expect(result).toMatchObject({ status: 'synced', fullSync: true, changed: 3, lastSyncAt: '2026-04-13T07:00:00.000Z' });
    const tasks = (await getAllTasks(h.db())).sort((a, b) => a.id.localeCompare(b.id));
    expect(tasks).toEqual([
      expect.objectContaining({ id: 'todoist-1', todoistId: 'todoist-1', title: 'Write spec', description: 'Needs markdown review', projectName: 'Inbox', projectColor: '#ff9933', priority: 4, labels: ['writing'], estimatedMins: 90, dueDate: '2026-04-15' }),
      expect.objectContaining({ id: 'todoist-2', title: 'Deep work', description: null, projectName: 'Research', projectColor: '#14aaf5', estimatedMins: 960, dueDate: '2026-04-16' }),
      expect.objectContaining({ id: 'todoist-3', projectName: null, projectColor: null, estimatedMins: null, dueDate: null }),
    ]);
    const [stamp] = await h.sql<{ value: string }>("SELECT value FROM settings WHERE key = 'last_sync_at'");
    expect(stamp?.value).toBe('2026-04-13T07:00:00.000Z');
  });

  it('a sync with no Todoist change writes only the claim and last_sync_at', async () => {
    seedTodoist(50);
    await sync(T0);
    const again = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(again).toMatchObject({ status: 'synced', fullSync: false, changed: 0 });
    expect(again.rowsWritten).toBe(2);
  });

  it('the same data upserted twice writes 0 task rows the second time (meta.rows_written)', async () => {
    seedTodoist(120);
    h.todoist.forceFull = true;
    await sync(T0);
    const again = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(again).toMatchObject({ fullSync: true, changed: 0 });
    expect(again.rowsWritten).toBe(2);
  });

  it('an edited task is the only task row written', async () => {
    seedTodoist(30);
    await sync(T0);
    h.todoist.update('td-4', { content: 'Renamed in Todoist' });
    const result = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(result).toMatchObject({ changed: 1, fullSync: false });
    // task row (title: no index) + claim + last_sync_at + the new sync token
    expect(result.rowsWritten).toBe(4);
    expect((await getAllTasks(h.db())).find((task) => task.id === 'td-4')?.title).toBe('Renamed in Todoist');
  });

  it('a rescheduled task gets its new due day', async () => {
    seedTodoist(5);
    await sync(T0);
    h.todoist.update('td-0', { due: { date: '2026-04-23' } });
    await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect((await getAllTasks(h.db())).find((task) => task.id === 'td-0')?.dueDate).toBe('2026-04-23');
  });

  it('completed or deleted in Todoist: hidden from FlowDay and not listed in the trash', async () => {
    seedTodoist(6);
    await sync(T0);
    h.todoist.complete('td-1');
    h.todoist.remove('td-2');
    const result = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(result.changed).toBe(2);
    expect((await getAllTasks(h.db())).map((task) => task.id).sort()).toEqual(['td-0', 'td-3', 'td-4', 'td-5']);
    expect(await getDeletedTasks(h.db())).toEqual([]);
  });

  it('a task hidden by a sync comes back when Todoist lists it again', async () => {
    seedTodoist(3);
    await sync(T0);
    h.todoist.complete('td-1');
    await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    h.todoist.update('td-1', { checked: false, completed_at: null });
    const result = await sync(T0 + 2 * AUTO_SYNC_MIN_INTERVAL_MS);
    expect(result.changed).toBe(1);
    expect((await getAllTasks(h.db())).map((task) => task.id).sort()).toEqual(['td-0', 'td-1', 'td-2']);
  });

  it('a task deleted in FlowDay stays deleted even when Todoist changes it', async () => {
    seedTodoist(2);
    await sync(T0);
    await softDeleteTask(h.db(), 'td-1');
    h.todoist.update('td-1', { content: 'Edited in Todoist' });
    await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect((await getAllTasks(h.db())).map((task) => task.id)).toEqual(['td-0']);
    expect((await getDeletedTasks(h.db())).map((task) => task.id)).toEqual(['td-1']);
  });

  it('keeps the estimate set in FlowDay when Todoist has no duration; a Todoist duration replaces it', async () => {
    seedTodoist(2);
    await sync(T0);
    await updateTaskEstimate(h.db(), 'td-1', 45);
    h.todoist.update('td-1', { content: 'Still no duration' });
    await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect((await getAllTasks(h.db())).find((task) => task.id === 'td-1')?.estimatedMins).toBe(45);
    h.todoist.update('td-1', { duration: { amount: 30, unit: 'minute' } });
    await sync(T0 + 2 * AUTO_SYNC_MIN_INTERVAL_MS);
    expect((await getAllTasks(h.db())).find((task) => task.id === 'td-1')?.estimatedMins).toBe(30);
  });

  it('a renamed project renames exactly its tasks, even those that did not change', async () => {
    seedTodoist(20);
    await sync(T0);
    h.todoist.setProjects([{ id: 'p-2', name: 'Renamed project', color: 'red' }]);
    const result = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(result.changed).toBe(4);
    const tasks = await getAllTasks(h.db());
    expect(tasks.filter((task) => task.projectName === 'Renamed project').map((task) => task.id).sort()).toEqual(['td-12', 'td-17', 'td-2', 'td-7']);
    expect(tasks.filter((task) => task.projectName === 'Renamed project').every((task) => task.projectColor === '#db4035')).toBe(true);
  });

  it('a full sync hides every Todoist task it does not list (more than 100 ids) and leaves local tasks alone', async () => {
    seedTodoist(150);
    await sync(T0);
    await h.sql("INSERT INTO tasks (id, title) VALUES ('local-1', 'Local only')");
    for (let index = 0; index < 150; index += 2) h.todoist.complete(`td-${String(index)}`);
    h.todoist.forceFull = true;
    const result = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(result).toMatchObject({ fullSync: true, changed: 75 });
    const visible = (await getAllTasks(h.db())).map((task) => task.id);
    expect(visible).toHaveLength(76);
    expect(visible).toContain('local-1');
    expect(visible).not.toContain('td-0');
  });

  it('throttles: an automatic sync within 5 minutes and a manual one within 30 seconds read and write nothing', async () => {
    seedTodoist(3);
    await sync(T0);
    const requests = h.todoist.requests.length;
    const auto = await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS - 1);
    expect(auto).toMatchObject({ status: 'throttled', changed: 0, nextAutoSyncAt: T0 + AUTO_SYNC_MIN_INTERVAL_MS, lastSyncAt: '2026-04-13T07:00:00.000Z' });
    expect(auto.rowsWritten).toBe(0);
    const manual = await sync(T0 + MANUAL_SYNC_MIN_INTERVAL_MS - 1, 'manual');
    expect(manual.status).toBe('throttled');
    expect(h.todoist.requests.length).toBe(requests);
    expect((await sync(T0 + MANUAL_SYNC_MIN_INTERVAL_MS, 'manual')).status).toBe('synced');
  });

  it('two concurrent syncs: exactly one reads Todoist', async () => {
    seedTodoist(10);
    const [a, b] = await Promise.all([sync(T0), sync(T0)]);
    expect([a.status, b.status].sort()).toEqual(['synced', 'throttled']);
    expect(h.todoist.requests).toHaveLength(1);
  });

  it('only reads Todoist: one POST to the Sync API with the token and resource types, never commands', async () => {
    seedTodoist(3);
    await sync(T0);
    h.todoist.update('td-1', { content: 'x' });
    await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(h.todoist.requests.map((request) => request.url)).toEqual(['https://api.todoist.com/api/v1/sync', 'https://api.todoist.com/api/v1/sync']);
    for (const request of h.todoist.requests) {
      expect(request.method).toBe('POST');
      expect(Object.keys(request.form).sort()).toEqual(['resource_types', 'sync_token']);
      expect(JSON.parse(request.form['resource_types'] ?? '')).toEqual(['items', 'projects']);
      expect(request.authorization).toBe('Bearer synthetic-token');
    }
    expect(h.todoist.requests[0]?.form['sync_token']).toBe('*');
    expect(h.todoist.requests[1]?.form['sync_token']).not.toBe('*');
  });

  it('a Todoist failure writes only the claim and keeps the last successful sync time', async () => {
    seedTodoist(3);
    await sync(T0);
    h.todoist.status = 503;
    const meter = new Meter();
    const outcome = await attempt(T0 + AUTO_SYNC_MIN_INTERVAL_MS, 'manual', meter);
    expect(outcome).toEqual({ kind: 'todoist', failure: 'unavailable' });
    expect(meter.rowsWritten).toBe(1);
    h.todoist.status = 401;
    const denied = await attempt(T0 + 2 * AUTO_SYNC_MIN_INTERVAL_MS, 'manual');
    expect(denied).toEqual({ kind: 'todoist', failure: 'unauthorized' });
    const [stamp] = await h.sql<{ value: string }>("SELECT value FROM settings WHERE key = 'last_sync_at'");
    expect(stamp?.value).toBe('2026-04-13T07:00:00.000Z');
  });

  it('failed syncs back off: the automatic interval doubles per failure (up to 32x) and resets after a success', async () => {
    seedTodoist(3);
    await sync(T0);
    h.todoist.status = 503;
    let at = T0;
    const intervals: number[] = [];
    for (let failures = 1; failures <= 7; failures += 1) {
      const wait = autoInterval(failures - 1);
      // One millisecond early: throttled, nothing read, nothing written.
      const early = await sync(at + wait - 1);
      expect(early).toMatchObject({ status: 'throttled', rowsWritten: 0, nextAutoSyncAt: at + wait });
      expect(await attempt(at + wait)).toMatchObject({ kind: 'todoist', failure: 'unavailable' });
      at += wait;
      intervals.push(wait / AUTO_SYNC_MIN_INTERVAL_MS);
    }
    expect(intervals).toEqual([1, 2, 4, 8, 16, 32, 32]);
    // "Sync now" is not backed off; its success resets the interval.
    h.todoist.status = 200;
    expect((await sync(at + MANUAL_SYNC_MIN_INTERVAL_MS, 'manual')).status).toBe('synced');
    expect((await sync(at + MANUAL_SYNC_MIN_INTERVAL_MS + AUTO_SYNC_MIN_INTERVAL_MS)).status).toBe('synced');
  });

  it('a request stopped after its claim (e.g. out of CPU) counts as a failure, so it is not retried every 5 minutes', async () => {
    seedTodoist(3);
    await sync(T0);
    // The claim of a request that never finished: newer than last_sync_at, nothing else written.
    await h.sql("UPDATE settings SET value = ? WHERE key = 'sync_claimed_at'", String(T0 + AUTO_SYNC_MIN_INTERVAL_MS));
    expect((await sync(T0 + 2 * AUTO_SYNC_MIN_INTERVAL_MS)).status).toBe('throttled');
    expect((await sync(T0 + 3 * AUTO_SYNC_MIN_INTERVAL_MS)).status).toBe('synced');
  });

  it('a stored key that cannot be opened (another CREDENTIAL_KEY, or plaintext) syncs nothing and writes nothing', async () => {
    seedTodoist(3);
    const meter = new Meter();
    expect(await runSync({ db: h.db(meter), mode: 'manual', credentialKey: '01'.repeat(32), now: new Date(T0), fetcher: h.todoist.fetcher })).toEqual({ kind: 'key_unreadable' });
    expect(await runSync({ db: h.db(meter), mode: 'manual', credentialKey: undefined, now: new Date(T0), fetcher: h.todoist.fetcher })).toEqual({ kind: 'not_configured' });
    await h.sql("UPDATE settings SET value = 'plain-token' WHERE key = 'todoist_api_key'");
    expect(await attempt(T0, 'manual', meter)).toEqual({ kind: 'key_unreadable' });
    expect(meter.rowsWritten).toBe(0);
    expect(h.todoist.requests).toHaveLength(0);
  });
});

describe('large answers and archived projects', () => {
  it(`applies a full sync in chunks of ${String(SYNC_CHUNK)} items, one request each, and stores the token at the end`, async () => {
    seedTodoist(2 * SYNC_CHUNK + 50);
    const requests = await syncFully(T0);
    expect(requests.map((request) => request.status)).toEqual(['partial', 'partial', 'synced']);
    expect(requests.map((request) => request.changed)).toEqual([SYNC_CHUNK, SYNC_CHUNK, 50]);
    expect(h.todoist.requests.map((request) => request.form['sync_token'])).toEqual(['*', '*', '*']);
    expect(await getAllTasks(h.db())).toHaveLength(2 * SYNC_CHUNK + 50);
    const [pending] = await h.sql<{ n: number }>("SELECT count(*) AS n FROM settings WHERE key = 'todoist_sync_pending'");
    expect(pending?.n).toBe(0);
    // The next sync, 5 minutes after the last chunk, is incremental and reads nothing new.
    const quiet = await sync(T0 + 2000 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(quiet).toMatchObject({ status: 'synced', fullSync: false, changed: 0, rowsWritten: 2 });
  });

  it('a change made during a chunked pass, before the cursor, arrives with the next incremental sync', async () => {
    seedTodoist(2 * SYNC_CHUNK + 10);
    const first = await sync(T0);
    expect(first.status).toBe('partial');
    // td-0 sorts before the cursor: the rest of this pass will not apply it.
    h.todoist.update('td-0', { content: 'Changed mid-pass' });
    h.todoist.setItems([item(0, { id: 'td-00', content: 'Added mid-pass' })]);
    let at = T0 + 1000;
    while ((await sync(at)).status === 'partial') at += 1000;
    await sync(at + AUTO_SYNC_MIN_INTERVAL_MS);
    const tasks = await getAllTasks(h.db());
    expect(tasks.find((task) => task.id === 'td-0')?.title).toBe('Changed mid-pass');
    expect(tasks.find((task) => task.id === 'td-00')?.title).toBe('Added mid-pass');
  });

  it('an interrupted pass resumes where it stopped, after the failure backoff', async () => {
    seedTodoist(2 * SYNC_CHUNK + 10);
    expect((await sync(T0)).status).toBe('partial');
    h.todoist.status = 503;
    expect(await attempt(T0 + 1000)).toMatchObject({ kind: 'todoist' });
    h.todoist.status = 200;
    expect((await sync(T0 + 2000)).status).toBe('throttled');
    const resumed = await syncFully(T0 + 1000 + autoInterval(1));
    expect(resumed.map((request) => request.changed)).toEqual([SYNC_CHUNK, 10]);
    expect(await getAllTasks(h.db())).toHaveLength(2 * SYNC_CHUNK + 10);
  });

  it('archiving a project hides its tasks; unarchiving brings them back through a full pass', async () => {
    seedTodoist(20);
    await sync(T0);
    h.todoist.archiveProject('p-2');
    const archived = await syncFully(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect(archived.map((request) => request.status)).toEqual(['synced']);
    const visible = (await getAllTasks(h.db())).map((task) => task.id);
    expect(visible).toHaveLength(16);
    expect(visible).not.toContain('td-2');
    expect(await getDeletedTasks(h.db())).toEqual([]);

    h.todoist.archiveProject('p-2', false);
    const unarchived = await syncFully(T0 + 2 * AUTO_SYNC_MIN_INTERVAL_MS);
    expect(unarchived.map((request) => [request.status, request.fullSync])).toEqual([['partial', false], ['synced', true]]);
    expect(await getAllTasks(h.db())).toHaveLength(20);
    // The full pass wrote only the 4 restored tasks.
    expect(unarchived[1]?.changed).toBe(4);
  });

  it('a deleted project hides its tasks', async () => {
    seedTodoist(10);
    await sync(T0);
    h.todoist.setProjects([{ id: 'p-1', name: 'Project 1', color: 'blue', is_deleted: true }]);
    await sync(T0 + AUTO_SYNC_MIN_INTERVAL_MS);
    expect((await getAllTasks(h.db())).map((task) => task.id).sort()).toEqual(['td-0', 'td-2', 'td-3', 'td-4', 'td-5', 'td-7', 'td-8', 'td-9']);
  });
});

describe('write budget', () => {
  it('a simulated day (200 tasks, 20 Todoist changes, two open tabs polling every 10 minutes for 16 hours) stays far below 1,000 rows', async () => {
    seedTodoist(200);
    const first = await sync(T0 - 24 * 3_600_000);
    // The one-off first sync of a new account: each new task row plus its key and index entries.
    expect(first.changed).toBe(200);

    // 20 Todoist changes spread over the day: 10 edits, 3 reschedules, 3 completions, 1 deletion, 2 new tasks
    // and 1 project rename (40 tasks in that project).
    const changes: (() => void)[] = [
      ...Array.from({ length: 10 }, (_, n) => () => { h.todoist.update(`td-${String(n * 7)}`, { content: `Edited ${String(n)}` }); }),
      ...Array.from({ length: 3 }, (_, n) => () => { h.todoist.update(`td-${String(100 + n)}`, { due: { date: '2026-04-20' } }); }),
      ...Array.from({ length: 3 }, (_, n) => () => { h.todoist.complete(`td-${String(150 + n)}`); }),
      () => { h.todoist.remove('td-199'); },
      () => { h.todoist.setItems([item(500)]); },
      () => { h.todoist.setItems([item(501)]); },
      () => { h.todoist.setProjects([{ id: 'p-3', name: 'Renamed', color: 'green' }]); },
    ];
    expect(changes).toHaveLength(20);

    const day = { rowsWritten: 0, synced: 0, throttled: 0, todoistReads: 0 };
    const readsBefore = h.todoist.requests.length;
    const POLL = 10 * 60_000;
    for (let at = T0; at < T0 + 16 * 3_600_000; at += POLL) {
      const slot = Math.floor((at - T0) / POLL);
      if (slot % 4 === 1 && changes.length > 0) changes.shift()?.();
      // Two tabs (or a desktop window and a phone) poll three minutes apart: the throttle lets one through.
      for (const result of [await sync(at), await sync(at + 3 * 60_000)]) {
        day.rowsWritten += result.rowsWritten;
        if (result.status === 'synced') day.synced += 1;
        else day.throttled += 1;
      }
    }
    day.todoistReads = h.todoist.requests.length - readsBefore;
    expect(changes).toHaveLength(0);
    console.log(`write budget: first sync of 200 tasks wrote ${String(first.rowsWritten)} rows; the simulated day ${JSON.stringify(day)}`);
    expect(day.synced).toBe(96);
    expect(day.throttled).toBe(96);
    expect(day.todoistReads).toBe(96);
    // 96 syncs x 2 rows (claim, last_sync_at) + the new sync tokens + the changed task rows and their indexes.
    expect(day.rowsWritten).toBeLessThan(320);
    // 3 rows per new task (row, key, deleted_at index) + the settings rows.
    expect(first.rowsWritten).toBeLessThan(620);
  });
});
