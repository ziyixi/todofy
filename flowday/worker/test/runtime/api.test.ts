/**
 * The owner API, FlowDayUiService (proto/flowday/ui/v1), through the Worker (../../src/router.ts, api.ts) on real D1:
 * every rpc through the shared typed client the UI uses (proto/ts/http-client.ts), with the dev bypass, a CSRF token
 * and the loopback Origin; errors are google.rpc.Status bodies read by their ErrorInfo reason. The container era's
 * route tests (web/__tests__/integration/* at ziyixi/FlowDay 10a8f43) carried over, with the AIP behaviour on top.
 */
import { TaskSchema } from '@ziyixi/proto/flowday/ui/v1/task_pb';
import { SyncTasksRequest_Mode, SyncTasksResponse_State } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { TimeEntry_Source, TimerSession_Mode, TimerSession_State } from '@ziyixi/proto/flowday/ui/v1/time_entry_pb';
import { timestampDate, timestampFromDate } from '@ziyixi/proto/protobuf/wkt';
import { HttpEncodeError } from '@ziyixi/proto/http-client';
import { readDetail } from '@ziyixi/proto/rpc-status';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../src/model.ts';
import { addCompletedFlowTask, getAllFlows, setFlowTaskIds } from '../../src/store/flows.ts';
import { createTimeEntry, getEntriesByTask } from '../../src/store/entries.ts';
import { getSetting, setSetting } from '../../src/store/settings.ts';
import { upsertTasks } from '../../src/store/tasks.ts';
import { startHarness, storeTodoistKey, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    todoistId: null,
    title: 'Test Task',
    description: null,
    projectName: 'Work',
    projectColor: '#ff0000',
    priority: 1,
    labels: [],
    estimatedMins: 30,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: '2026-04-10T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

async function seedTasks(...tasks: Partial<TaskRecord>[]): Promise<void> {
  await upsertTasks(h.db(), tasks.map((task) => makeTask(task)));
}

const at = (iso: string) => timestampFromDate(new Date(iso));
const iso = (timestamp: Parameters<typeof timestampDate>[0] | undefined) => (timestamp === undefined ? undefined : timestampDate(timestamp).toISOString());
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UUID_2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

async function taskIds(showDeleted = false): Promise<string[]> {
  const { tasks } = await h.api.listTasks({ showDeleted });
  return tasks.map((task) => task.name.slice('tasks/'.length));
}

describe('tasks', () => {
  it('ListTasks answers the tasks that are not deleted, in the order they were stored', async () => {
    await seedTasks({ id: 't2', title: 'Second' }, { id: 't1', title: 'First' }, { id: 't3' });
    await h.api.deleteTask({ name: 'tasks/t3' });
    expect(await taskIds()).toEqual(['t2', 't1']);
    const [task] = (await h.api.listTasks({})).tasks;
    expect(task).toMatchObject({ name: 'tasks/t2', title: 'Second', projectDisplayName: 'Work', projectColor: '#ff0000', priority: 1, estimatedMinutes: 30 });
    expect(iso(task?.createTime)).toBe('2026-04-10T00:00:00.000Z');
    expect(task?.deleteTime).toBeUndefined();
  });

  it('ListTasks pages with tokens bound to show_deleted (AIP-158)', async () => {
    await seedTasks({ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' });
    const first = await h.api.listTasks({ pageSize: 2 });
    expect(first.tasks.map((task) => task.name)).toEqual(['tasks/a', 'tasks/b']);
    const second = await h.api.listTasks({ pageSize: 2, pageToken: first.nextPageToken });
    const third = await h.api.listTasks({ pageSize: 2, pageToken: second.nextPageToken });
    expect([...second.tasks, ...third.tasks].map((task) => task.name)).toEqual(['tasks/c', 'tasks/d', 'tasks/e']);
    expect(third.nextPageToken).toBe('');
    const mismatched = await h.call((api) => api.listTasks({ pageSize: 2, pageToken: first.nextPageToken, showDeleted: true }));
    expect(mismatched.status?.reason).toBe('BAD_REQUEST');
    expect((await h.call((api) => api.listTasks({ pageToken: 'not-a-token' }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('every list refuses a negative page_size (AIP-158) and reads 0 as the default', async () => {
    await seedTasks({ id: 'a' });
    const lists = [
      (pageSize: number) => h.call((api) => api.listTasks({ pageSize })),
      (pageSize: number) => h.call((api) => api.listFlows({ pageSize })),
      (pageSize: number) => h.call((api) => api.listNotes({ parent: 'flows/2026-04-13', pageSize })),
      (pageSize: number) => h.call((api) => api.listTimeEntries({ taskId: 'a', pageSize })),
      (pageSize: number) => h.call((api) => api.queryAnalytics({ pageSize })),
    ];
    for (const [index, list] of lists.entries()) {
      expect((await list(-1)).status?.reason, `list ${String(index)}`).toBe('BAD_REQUEST');
      expect((await list(0)).status, `list ${String(index)}`).toBeUndefined();
    }
  });

  it('GetTask answers a task, deleted or not; NOT_FOUND for none; BAD_REQUEST for a malformed name', async () => {
    await seedTasks({ id: 't1' });
    await h.api.deleteTask({ name: 'tasks/t1' });
    expect((await h.api.getTask({ name: 'tasks/t1' })).deleteTime).toBeDefined();
    expect((await h.call((api) => api.getTask({ name: 'tasks/none' }))).status).toMatchObject({ httpStatus: 404, reason: 'NOT_FOUND' });
    // A resource ID has no `/` (AIP-122): no route takes a raw one, and an encoded one is refused.
    expect((await h.fetch('/api/v1/tasks/a/b')).status).toBe(404);
    expect((await h.fetch('/api/v1/tasks/a%2Fb')).status).toBe(400);
    // The client refuses a name its binding cannot carry before sending anything.
    await expect(h.api.getTask({ name: 'projects/t1' })).rejects.toThrow(HttpEncodeError);
  });

  it('CreateTask creates a local task with trimmed title and optional fields; its request_id names it, so a repeat writes nothing', async () => {
    const task = { title: '  Planned task  ', priority: 3, dueDate: '2026-04-20', estimatedMinutes: 45, labels: ['docs', 'review'], description: 'Needs commas, quotes, and detail' };
    const created = await h.call((api) => api.createTask({ task, requestId: UUID }));
    expect(created.value).toMatchObject({ name: `tasks/local-${UUID}`, title: 'Planned task', priority: 3, dueDate: '2026-04-20', estimatedMinutes: 45, labels: ['docs', 'review'], todoistId: '' });
    expect(created.rowsWritten).toBe(3);
    const repeated = await h.call((api) => api.createTask({ task: { title: 'Another title' }, requestId: UUID }));
    expect(repeated.value).toMatchObject({ name: `tasks/local-${UUID}`, title: 'Planned task' });
    expect(repeated.rowsWritten).toBe(0);
    expect((await h.api.createTask({ task: { title: 'No request ID' } })).name).toMatch(/^tasks\/local-[0-9a-f-]{36}$/);
    expect(await taskIds()).toHaveLength(2);
    // An over-long description is refused like an over-long title, never cut short.
    for (const bad of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(2001) }, { title: 'Bad day', dueDate: '2026-02-30' }, { title: 'Negative', estimatedMinutes: -1 }, { title: 'Long', description: 'x'.repeat(2001) }]) {
      expect((await h.call((api) => api.createTask({ task: bad }))).status?.reason, JSON.stringify(bad).slice(0, 40)).toBe('BAD_REQUEST');
    }
    // A request_id is a UUID4 (the transcoder checks it).
    expect((await h.call((api) => api.createTask({ task: { title: 'x' }, requestId: 'not-a-uuid' }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('UpdateTask replaces the masked title or estimate, clears an unset estimate, writes nothing for the same values', async () => {
    await seedTasks({ id: 't1', estimatedMins: 30 });
    const estimate = await h.call((api) => api.updateTask({ task: { name: 'tasks/t1', estimatedMinutes: 60 }, updateMask: { paths: ['estimated_minutes'] } }));
    expect(estimate.value?.estimatedMinutes).toBe(60);
    expect(estimate.rowsWritten).toBe(1);
    const again = await h.call((api) => api.updateTask({ task: { name: 'tasks/t1', estimatedMinutes: 60 }, updateMask: { paths: ['estimated_minutes'] } }));
    expect(again.rowsWritten).toBe(0);
    await h.api.updateTask({ task: { name: 'tasks/t1' }, updateMask: { paths: ['estimated_minutes'] } });
    expect((await h.api.getTask({ name: 'tasks/t1' })).estimatedMinutes).toBeUndefined();
    const both = await h.api.updateTask({ task: { name: 'tasks/t1', title: '  Renamed Task  ', estimatedMinutes: 75 } });
    expect(both).toMatchObject({ title: 'Renamed Task', estimatedMinutes: 75 });
    expect(await h.api.getTask({ name: 'tasks/t1' })).toMatchObject({ title: 'Renamed Task', estimatedMinutes: 75 });
    for (const [task, paths] of [
      [{ name: 'tasks/t1', estimatedMinutes: -10 }, ['estimated_minutes']],
      [{ name: 'tasks/t1', title: '' }, ['title']],
      [{ name: 'tasks/t1', priority: 4 }, ['priority']],
      [{ name: 'tasks/t1', title: 'x' }, ['no_such_field']],
    ] as const) {
      expect((await h.call((api) => api.updateTask({ task, updateMask: { paths: [...paths] } }))).status?.reason, paths.join()).toBe('BAD_REQUEST');
    }
    expect((await h.call((api) => api.updateTask({ task: { name: 'tasks/none', title: 'x' }, updateMask: { paths: ['title'] } }))).status?.reason).toBe('NOT_FOUND');
  });

  it('UpdateTask keeps the IMMUTABLE fields (AIP-203): the same value passes, a different one is INVALID_ARGUMENT', async () => {
    await seedTasks({ id: 't1', priority: 2, labels: ['a'], dueDate: '2026-04-20', description: 'About it' });
    // The whole task (no mask), as GetTask answered it: the immutable values are the stored ones.
    const stored = await h.api.getTask({ name: 'tasks/t1' });
    const whole = await h.call((api) => api.updateTask({ task: { ...stored, title: 'Renamed' } }));
    expect(whole.value).toMatchObject({ title: 'Renamed', priority: 2, labels: ['a'], dueDate: '2026-04-20', description: 'About it' });
    // Without a mask an immutable field left empty was not given.
    expect((await h.call((api) => api.updateTask({ task: { name: 'tasks/t1', title: 'Again' } }))).value?.title).toBe('Again');
    // A mask that names an immutable field with its stored value changes nothing.
    expect((await h.call((api) => api.updateTask({ task: { name: 'tasks/t1', priority: 2 }, updateMask: { paths: ['priority'] } }))).rowsWritten).toBe(0);
    for (const [task, paths] of [
      [{ name: 'tasks/t1', title: 'x', priority: 4 }, undefined],
      [{ name: 'tasks/t1', title: 'x', labels: ['b'] }, undefined],
      [{ name: 'tasks/t1', title: 'x', dueDate: '2026-04-21' }, undefined],
      [{ name: 'tasks/t1', title: 'x', description: 'Other' }, undefined],
      [{ name: 'tasks/t1' }, ['due_date']],
      [{ name: 'tasks/t1', labels: [] }, ['labels']],
    ] as const) {
      const call = await h.call((api) => api.updateTask({ task: { ...task, labels: [...(task.labels ?? [])] }, ...(paths === undefined ? {} : { updateMask: { paths: [...paths] } }) }));
      expect(call.status?.reason, JSON.stringify(task)).toBe('BAD_REQUEST');
      expect(call.rowsWritten).toBe(0);
    }
    expect(await h.api.getTask({ name: 'tasks/t1' })).toMatchObject({ title: 'Again', priority: 2, labels: ['a'], dueDate: '2026-04-20' });
  });

  it('DeleteTask soft-deletes a task and removes it from every flow; a second delete is NOT_FOUND with the deleted task', async () => {
    await seedTasks({ id: 't1' }, { id: 't2' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await addCompletedFlowTask(h.db(), '2026-04-12', 't1');
    const deleted = await h.api.deleteTask({ name: 'tasks/t1' });
    expect(deleted.deleteTime).toBeDefined();
    expect(await taskIds()).toEqual(['t2']);
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t2'] });
    expect((await h.api.getFlow({ name: 'flows/2026-04-12' })).completedTaskIds).toEqual([]);
    const second = await h.call((api) => api.deleteTask({ name: 'tasks/t1' }));
    expect(second.status?.reason).toBe('NOT_FOUND');
    expect(readDetail(second.status ?? (undefined as never), TaskSchema)?.name).toBe('tasks/t1');
    expect((await h.call((api) => api.deleteTask({ name: 'tasks/none' }))).status?.reason).toBe('NOT_FOUND');
  });

  it('ListTasks with show_deleted adds the trash (FlowDay deletions only); UndeleteTask restores one, TASK_NOT_DELETED twice', async () => {
    await seedTasks({ id: 't1' }, { id: 't2' }, { id: 't3' });
    await h.api.deleteTask({ name: 'tasks/t2' });
    await h.api.deleteTask({ name: 'tasks/t3' });
    // A task the sync hid is not in the trash.
    await h.sql("UPDATE tasks SET deleted_at = '2026-04-13T00:00:00Z', deleted_source = 'sync' WHERE id = 't1'");
    const listed = (await h.api.listTasks({ showDeleted: true })).tasks;
    expect(listed.filter((task) => task.deleteTime !== undefined).map((task) => task.name)).toEqual(['tasks/t2', 'tasks/t3']);
    expect(listed).toHaveLength(2);
    expect((await h.api.undeleteTask({ name: 'tasks/t2' })).deleteTime).toBeUndefined();
    expect(await taskIds()).toEqual(['t2']);
    const twice = await h.call((api) => api.undeleteTask({ name: 'tasks/t2' }));
    expect(twice.status).toMatchObject({ httpStatus: 409, reason: 'TASK_NOT_DELETED' });
    expect((await h.call((api) => api.undeleteTask({ name: 'tasks/none' }))).status?.reason).toBe('NOT_FOUND');
  });
});

describe('flows', () => {
  it('ListFlows is empty without data and answers each day with its planned and done tasks and planning flag', async () => {
    expect((await h.api.listFlows({})).flows).toEqual([]);
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    await addCompletedFlowTask(h.db(), '2026-04-11', 't9');
    await setSetting(h.db(), 'planning_completed:2026-04-14', 'true');
    const flows = (await h.api.listFlows({})).flows;
    expect(flows.map((flow) => [flow.name, flow.taskIds, flow.completedTaskIds, flow.planningCompleted])).toEqual([
      ['flows/2026-04-11', [], ['t9'], false],
      ['flows/2026-04-13', ['t1', 't2'], ['t1'], false],
      ['flows/2026-04-14', [], [], true],
    ]);
    const first = await h.api.listFlows({ pageSize: 2 });
    expect(first.flows).toHaveLength(2);
    expect((await h.api.listFlows({ pageSize: 2, pageToken: first.nextPageToken })).flows.map((flow) => flow.name)).toEqual(['flows/2026-04-14']);
  });

  it('UpdateFlow sets the planned tasks (writing only the difference), clears them, and sets the planning flag', async () => {
    const set = await h.call((api) => api.updateFlow({ flow: { name: 'flows/2026-04-13', taskIds: ['t1', 't2'] }, updateMask: { paths: ['task_ids'] } }));
    expect(set.value?.taskIds).toEqual(['t1', 't2']);
    const same = await h.call((api) => api.updateFlow({ flow: { name: 'flows/2026-04-13', taskIds: ['t1', 't2'] }, updateMask: { paths: ['task_ids'] } }));
    expect(same.rowsWritten).toBe(0);
    await h.api.updateFlow({ flow: { name: 'flows/2026-04-13', taskIds: [] }, updateMask: { paths: ['task_ids'] } });
    expect((await getAllFlows(h.db()))['2026-04-13']).toBeUndefined();
    const planned = await h.call((api) => api.updateFlow({ flow: { name: 'flows/2026-04-13', planningCompleted: true }, updateMask: { paths: ['planning_completed'] } }));
    expect(planned.value?.planningCompleted).toBe(true);
    expect(await getSetting(h.db(), 'planning_completed:2026-04-13')).toBe('true');
    expect((await h.call((api) => api.updateFlow({ flow: { name: 'flows/2026-04-13', planningCompleted: true }, updateMask: { paths: ['planning_completed'] } }))).rowsWritten).toBe(0);
    await expect(h.api.updateFlow({ flow: { name: 'days/2026-04-13' } })).rejects.toThrow(HttpEncodeError);
    for (const name of ['flows/2026-13-01', 'flows/today', 'flows/2026-4-13']) {
      expect((await h.call((api) => api.updateFlow({ flow: { name, taskIds: [] }, updateMask: { paths: ['task_ids'] } }))).status?.reason, name).toBe('BAD_REQUEST');
    }
    expect((await h.call((api) => api.updateFlow({ flow: { name: 'flows/2026-04-13', taskIds: ['bad id'] }, updateMask: { paths: ['task_ids'] } }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('CompleteFlowTask and ReopenFlowTask', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1']);
    expect((await h.api.completeFlowTask({ name: 'flows/2026-04-13', taskId: 't1' })).completedTaskIds).toEqual(['t1']);
    expect((await h.call((api) => api.completeFlowTask({ name: 'flows/2026-04-13', taskId: 't1' }))).rowsWritten).toBe(0);
    expect((await h.api.reopenFlowTask({ name: 'flows/2026-04-13', taskId: 't1' })).completedTaskIds).toEqual([]);
    const missing = await h.mutate('POST', '/api/v1/flows/2026-04-13:completeTask', {});
    expect(missing.status).toBe(400);
  });

  it('RolloverFlow moves the unfinished tasks to the top of the destination, without duplicates', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2', 't3']);
    await setFlowTaskIds(h.db(), '2026-04-14', ['t3', 't9']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    const moved = await h.api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'flows/2026-04-14', allUnfinished: true });
    expect([moved.flow?.taskIds, moved.destinationFlow?.taskIds]).toEqual([['t1'], ['t2', 't3', 't9']]);
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t1'], '2026-04-14': ['t2', 't3', 't9'] });
  });

  it('RolloverFlow writes nothing when nothing is unfinished', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    const result = await h.call((api) => api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'flows/2026-04-14', allUnfinished: true }));
    expect(result.rowsWritten).toBe(0);
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t1'] });
  });

  it('RolloverFlow with an empty task_ids and no all_unfinished moves nothing; both together are INVALID_ARGUMENT', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    const empty = await h.call((api) => api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'flows/2026-04-14', taskIds: [] }));
    expect([empty.value?.flow?.taskIds, empty.value?.destinationFlow?.taskIds, empty.rowsWritten]).toEqual([['t1', 't2'], [], 0]);
    const both = await h.call((api) => api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'flows/2026-04-14', taskIds: ['t1'], allUnfinished: true }));
    expect([both.status?.reason, both.rowsWritten]).toEqual(['BAD_REQUEST', 0]);
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t1', 't2'] });
  });

  it('RolloverFlow with task_ids moves only those; unknown IDs move nothing', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2', 't3']);
    await h.api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'flows/2026-04-14', taskIds: ['t1', 't3'] });
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t2'], '2026-04-14': ['t1', 't3'] });
    await h.api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'flows/2026-04-15', taskIds: ['missing-task'] });
    expect((await getAllFlows(h.db()))['2026-04-15']).toBeUndefined();
    expect((await h.call((api) => api.rolloverFlow({ name: 'flows/2026-04-13', destination: 'tomorrow' }))).status?.reason).toBe('BAD_REQUEST');
  });
});

describe('notes', () => {
  it('GetNote answers an empty note for a task and day without one', async () => {
    const note = await h.api.getNote({ name: 'flows/2026-04-13/notes/t1' });
    expect(note).toMatchObject({ name: 'flows/2026-04-13/notes/t1', content: '' });
    expect(note.updateTime).toBeUndefined();
    expect((await h.fetch('/api/v1/flows/2026-04-13/notes/a%2Fb')).status).toBe(400);
    expect((await h.call((api) => api.getNote({ name: 'flows/2026-02-30/notes/t1' }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('UpdateNote creates and replaces a note; the same text writes nothing; ListNotes answers that day only', async () => {
    expect((await h.api.updateNote({ note: { name: 'flows/2026-04-13/notes/t1', content: 'Original content' } })).content).toBe('Original content');
    const updated = await h.call((api) => api.updateNote({ note: { name: 'flows/2026-04-13/notes/t1', content: 'Updated content' }, updateMask: { paths: ['content'] } }));
    expect(updated.value).toMatchObject({ name: 'flows/2026-04-13/notes/t1', content: 'Updated content' });
    expect(updated.value?.updateTime).toBeDefined();
    expect((await h.call((api) => api.updateNote({ note: { name: 'flows/2026-04-13/notes/t1', content: 'Updated content' } }))).rowsWritten).toBe(0);
    await h.api.updateNote({ note: { name: 'flows/2026-04-13/notes/t2', content: 'Note for task 2' } });
    await h.api.updateNote({ note: { name: 'flows/2026-04-14/notes/t3', content: 'Other day' } });
    expect((await h.api.listNotes({ parent: 'flows/2026-04-13' })).notes.map((note) => note.name)).toEqual(['flows/2026-04-13/notes/t1', 'flows/2026-04-13/notes/t2']);
    const first = await h.api.listNotes({ parent: 'flows/2026-04-13', pageSize: 1 });
    expect((await h.api.listNotes({ parent: 'flows/2026-04-13', pageSize: 1, pageToken: first.nextPageToken })).notes.map((note) => note.name)).toEqual(['flows/2026-04-13/notes/t2']);
    expect((await h.call((api) => api.listNotes({ parent: 'flows/2026-04-14', pageToken: first.nextPageToken }))).status?.reason).toBe('BAD_REQUEST');
    expect((await h.call((api) => api.updateNote({ note: { name: 'flows/2026-04-13/notes/t1', content: 'x'.repeat(100_001) } }))).status?.reason).toBe('BAD_REQUEST');
  });
});

describe('time entries', () => {
  const seedEntries = async () => {
    await createTimeEntry(h.db(), { id: 'e1', taskId: 't1', flowDate: '2026-04-13', startTime: '2026-04-13T09:00:00Z', endTime: '2026-04-13T09:30:00Z', durationS: 1800, source: 'timer' });
    await createTimeEntry(h.db(), { id: 'e2', taskId: 't2', flowDate: '2026-04-13', startTime: '2026-04-13T10:00:00Z', endTime: '2026-04-13T10:15:00Z', durationS: 900, source: 'manual' });
  };

  it('CreateTimeEntry stores an entry (four rows: row, key, two indexes); its request_id names it, so a repeat writes nothing', async () => {
    const entry = { taskId: 't1', flowDate: '2026-04-13', startTime: at('2026-04-13T09:00:00Z'), endTime: at('2026-04-13T09:30:00Z'), durationSeconds: 1800, source: TimeEntry_Source.MANUAL };
    const created = await h.call((api) => api.createTimeEntry({ timeEntry: entry, requestId: UUID }));
    expect(created.value).toMatchObject({ name: `timeEntries/${UUID}`, taskId: 't1', durationSeconds: 1800, source: TimeEntry_Source.MANUAL });
    expect(created.rowsWritten).toBe(4);
    const repeated = await h.call((api) => api.createTimeEntry({ timeEntry: { ...entry, durationSeconds: 5 }, requestId: UUID }));
    expect(repeated.value?.durationSeconds).toBe(1800);
    expect(repeated.rowsWritten).toBe(0);
    expect(await getEntriesByTask(h.db(), 't1')).toMatchObject([{ id: UUID, startTime: '2026-04-13T09:00:00.000Z', endTime: '2026-04-13T09:30:00.000Z', source: 'manual' }]);
    const missingStart = await h.mutate('POST', '/api/v1/timeEntries', { task_id: 't1', flow_date: '2026-04-13' });
    expect(missingStart.status).toBe(400);
    expect((await h.call((api) => api.createTimeEntry({ timeEntry: { ...entry, flowDate: 'today' } }))).status?.reason).toBe('BAD_REQUEST');
    expect((await h.call((api) => api.createTimeEntry({ timeEntry: { ...entry, durationSeconds: -1 } }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('ListTimeEntries by task, by day, by both, by start time; BAD_REQUEST without either; pages', async () => {
    await seedEntries();
    const names = async (request: { taskId?: string; flowDate?: string; pageSize?: number; pageToken?: string }) => (await h.api.listTimeEntries(request)).timeEntries.map((entry) => entry.name);
    expect(await names({ taskId: 't1' })).toEqual(['timeEntries/e1']);
    expect(await names({ flowDate: '2026-04-13' })).toEqual(['timeEntries/e1', 'timeEntries/e2']);
    expect(await names({ taskId: 't1', flowDate: '2026-04-13' })).toEqual(['timeEntries/e1']);
    expect((await h.call((api) => api.listTimeEntries({}))).status?.reason).toBe('BAD_REQUEST');
    const first = await h.api.listTimeEntries({ flowDate: '2026-04-13', pageSize: 1 });
    expect(await names({ flowDate: '2026-04-13', pageSize: 1, pageToken: first.nextPageToken })).toEqual(['timeEntries/e2']);
    const [entry] = (await h.api.listTimeEntries({ taskId: 't1' })).timeEntries;
    expect([iso(entry?.startTime), iso(entry?.endTime), entry?.source]).toEqual(['2026-04-13T09:00:00.000Z', '2026-04-13T09:30:00.000Z', TimeEntry_Source.TIMER]);
  });

  it('UpdateTimeEntry recomputes the duration; NOT_FOUND for a missing entry; BAD_REQUEST for an end before the start', async () => {
    await seedEntries();
    const updated = await h.api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', startTime: at('2026-04-13T10:07:00Z'), endTime: at('2026-04-13T11:22:00Z') }, updateMask: { paths: ['start_time', 'end_time'] } });
    expect(updated.durationSeconds).toBe(4500);
    const endOnly = await h.api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', endTime: at('2026-04-13T10:37:00Z') }, updateMask: { paths: ['end_time'] } });
    expect([iso(endOnly.startTime), endOnly.durationSeconds]).toEqual(['2026-04-13T10:07:00.000Z', 1800]);
    const times = { paths: ['start_time', 'end_time'] };
    expect((await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/none', startTime: at('2026-04-13T10:00:00Z'), endTime: at('2026-04-13T11:00:00Z') }, updateMask: times }))).status?.reason).toBe('NOT_FOUND');
    expect((await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', startTime: at('2026-04-13T12:00:00Z'), endTime: at('2026-04-13T11:00:00Z') }, updateMask: times }))).status?.reason).toBe('BAD_REQUEST');
    expect((await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', taskId: 't9' }, updateMask: { paths: ['task_id'] } }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('UpdateTimeEntry without a mask takes the whole entry (REQUIRED fields bind) and keeps its IMMUTABLE fields (AIP-203)', async () => {
    await seedEntries();
    const times = { startTime: at('2026-04-13T09:10:00Z'), endTime: at('2026-04-13T09:40:00Z') };
    // Without a mask the body is the whole entry: without its REQUIRED task_id and flow_date the transcoder refuses it.
    const partial = await h.mutate('PATCH', '/api/v1/timeEntries/e1', { start_time: '2026-04-13T09:10:00Z', end_time: '2026-04-13T09:40:00Z' });
    expect(partial.status).toBe(400);
    const whole = await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', taskId: 't1', flowDate: '2026-04-13', source: TimeEntry_Source.TIMER, durationSeconds: 5, ...times } }));
    expect(whole.value).toMatchObject({ taskId: 't1', flowDate: '2026-04-13', durationSeconds: 1800, source: TimeEntry_Source.TIMER });
    for (const change of [{ taskId: 't9' }, { flowDate: '2026-04-14' }, { source: TimeEntry_Source.MANUAL }]) {
      const call = await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', taskId: 't1', flowDate: '2026-04-13', ...times, ...change } }));
      expect([call.status?.reason, call.rowsWritten], JSON.stringify(change)).toEqual(['BAD_REQUEST', 0]);
    }
    // A mask that names an immutable field: its stored value passes, another is INVALID_ARGUMENT.
    const same = await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', flowDate: '2026-04-13', ...times }, updateMask: { paths: ['flow_date', 'end_time'] } }));
    expect(same.status).toBeUndefined();
    const moved = await h.call((api) => api.updateTimeEntry({ timeEntry: { name: 'timeEntries/e1', flowDate: '2026-04-14', ...times }, updateMask: { paths: ['flow_date'] } }));
    expect(moved.status?.reason).toBe('BAD_REQUEST');
    expect(await getEntriesByTask(h.db(), 't1')).toMatchObject([{ id: 'e1', taskId: 't1', flowDate: '2026-04-13', startTime: '2026-04-13T09:10:00.000Z', durationS: 1800 }]);
  });

  it('DeleteTimeEntry removes an entry; NOT_FOUND for a missing one', async () => {
    await seedEntries();
    expect(await h.api.deleteTimeEntry({ name: 'timeEntries/e1' })).toBeDefined();
    expect(await getEntriesByTask(h.db(), 't1')).toEqual([]);
    expect((await h.call((api) => api.deleteTimeEntry({ name: 'timeEntries/e1' }))).status?.reason).toBe('NOT_FOUND');
  });
});

describe('settings', () => {
  it('GetSettings answers the defaults and the last sync time when there is one', async () => {
    expect(await h.api.getSettings({ name: 'settings' })).toMatchObject({ name: 'settings', todoistApiKeySet: false, dayCapacityMinutes: 360, todoistApiKey: '' });
    await setSetting(h.db(), 'last_sync_at', '2026-04-13T12:00:00.000Z');
    expect(iso((await h.api.getSettings({ name: 'settings' })).lastSyncTime)).toBe('2026-04-13T12:00:00.000Z');
  });

  it('UpdateSettings stores the key sealed (never answered), refuses an empty key, and a new key restarts the sync', async () => {
    await setSetting(h.db(), 'todoist_sync_token', 'old-token');
    await setSetting(h.db(), 'sync_claimed_at', String(Date.now()));
    await setSetting(h.db(), 'todoist_sync_pending', '{"base":"*","token":"t","after":"x"}');
    const saved = await h.api.updateSettings({ settings: { name: 'settings', todoistApiKey: 'my-secret-key-12345' }, updateMask: { paths: ['todoist_api_key'] } });
    expect(saved).toMatchObject({ todoistApiKeySet: true, todoistApiKey: '' });
    const raw = await (await h.fetch('/api/v1/settings')).text();
    expect(raw).not.toContain('my-secret-key');
    // Only ciphertext is stored: D1, its Time Travel history and any export never hold the key.
    const stored = await getSetting(h.db(), 'todoist_api_key');
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('my-secret-key');
    for (const key of ['todoist_sync_token', 'sync_claimed_at', 'todoist_sync_pending']) expect(await getSetting(h.db(), key)).toBeNull();
    const same = await h.call((api) => api.updateSettings({ settings: { name: 'settings', todoistApiKey: 'my-secret-key-12345' }, updateMask: { paths: ['todoist_api_key'] } }));
    expect(same.rowsWritten).toBe(0);
    expect(await getSetting(h.db(), 'todoist_api_key')).toBe(stored);
    expect((await h.call((api) => api.updateSettings({ settings: { name: 'settings', todoistApiKey: '' }, updateMask: { paths: ['todoist_api_key'] } }))).status?.reason).toBe('BAD_REQUEST');
    // Without a mask both fields are replaced, so the key must be given.
    expect((await h.call((api) => api.updateSettings({ settings: { name: 'settings', dayCapacityMinutes: 300 } }))).status?.reason).toBe('BAD_REQUEST');
  });

  it('a plaintext key from an older copy counts as no key', async () => {
    await setSetting(h.db(), 'todoist_api_key', 'plain-token');
    expect((await h.api.getSettings({ name: 'settings' })).todoistApiKeySet).toBe(false);
    const result = await h.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }));
    expect(result.status).toMatchObject({ httpStatus: 400, reason: 'TODOIST_KEY_UNREADABLE' });
    expect(h.todoist.requests).toHaveLength(0);
  });

  it('UpdateSettings sets the capacity (0 to 1,440) and the key together', async () => {
    const both = await h.api.updateSettings({ settings: { name: 'settings', todoistApiKey: 'combo-secret', dayCapacityMinutes: 480 } });
    expect(both).toMatchObject({ todoistApiKeySet: true, dayCapacityMinutes: 480 });
    for (const mins of [-100, 1441]) {
      expect((await h.call((api) => api.updateSettings({ settings: { name: 'settings', dayCapacityMinutes: mins }, updateMask: { paths: ['day_capacity_minutes'] } }))).status?.reason).toBe('BAD_REQUEST');
    }
    expect((await h.call((api) => api.updateSettings({ settings: { name: 'settings', dayCapacityMinutes: 0 }, updateMask: { paths: ['day_capacity_minutes'] } }))).value?.dayCapacityMinutes).toBe(0);
  });
});

describe('the timer session', () => {
  const session = {
    name: 'timerSession',
    taskId: 'task-1',
    flowDate: '2026-04-21',
    state: TimerSession_State.RUNNING,
    mode: TimerSession_Mode.POMODORO,
    pomodoroTargetSeconds: 1800,
    segmentStartTime: at('2026-04-21T09:00:00.000Z'),
    savedSeconds: 120,
  };

  it('empty without one; UpdateTimerSession stores it (one row); a partial mask keeps the rest; ClearTimerSession empties it', async () => {
    expect(await h.api.getTimerSession({ name: 'timerSession' })).toMatchObject({ taskId: '', state: TimerSession_State.IDLE, mode: TimerSession_Mode.COUNT_UP, savedSeconds: 0 });
    const stored = await h.call((api) => api.updateTimerSession({ timerSession: session }));
    expect(stored.rowsWritten).toBe(2);
    const read = await h.api.getTimerSession({ name: 'timerSession' });
    expect(read).toMatchObject({ taskId: 'task-1', flowDate: '2026-04-21', state: TimerSession_State.RUNNING, mode: TimerSession_Mode.POMODORO, pomodoroTargetSeconds: 1800, savedSeconds: 120 });
    expect([iso(read.segmentStartTime), read.updateTime !== undefined]).toEqual(['2026-04-21T09:00:00.000Z', true]);
    const paused = await h.call((api) => api.updateTimerSession({ timerSession: { name: 'timerSession', state: TimerSession_State.PAUSED, savedSeconds: 300 }, updateMask: { paths: ['state', 'saved_seconds', 'segment_start_time'] } }));
    expect(paused.rowsWritten).toBe(1);
    const pausedRead = await h.api.getTimerSession({ name: 'timerSession' });
    expect(pausedRead).toMatchObject({ taskId: 'task-1', state: TimerSession_State.PAUSED, mode: TimerSession_Mode.POMODORO, savedSeconds: 300 });
    expect(pausedRead.segmentStartTime).toBeUndefined();
    expect((await h.call((api) => api.updateTimerSession({ timerSession: { name: 'timerSession', flowDate: '21.04.2026' }, updateMask: { paths: ['flow_date'] } }))).status?.reason).toBe('BAD_REQUEST');
    expect((await h.api.clearTimerSession({ name: 'timerSession' })).taskId).toBe('');
    expect((await h.api.getTimerSession({ name: 'timerSession' })).state).toBe(TimerSession_State.IDLE);
  });
});

describe('SyncTasks', () => {
  it('TODOIST_KEY_MISSING without a key', async () => {
    const result = await h.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }));
    expect(result.status).toMatchObject({ httpStatus: 400, reason: 'TODOIST_KEY_MISSING', localizedMessage: { locale: 'en', message: 'No Todoist API key configured. Add one in Settings.' } });
  });

  it('syncs through the Worker, then throttles the next automatic sync', async () => {
    await storeTodoistKey(h.db(), 'synthetic-token');
    h.todoist.setProjects([{ id: 'p1', name: 'Inbox', color: 'blue' }]);
    h.todoist.setItems([{ id: 'td-1', content: 'From Todoist', project_id: 'p1' }]);
    const first = await h.api.syncTasks({ mode: SyncTasksRequest_Mode.AUTO });
    expect(first).toMatchObject({ state: SyncTasksResponse_State.SYNCED, changedTaskCount: 1, fullSync: true });
    expect(first.lastSyncTime).toBeDefined();
    expect((await h.api.listTasks({})).tasks.map((task) => task.title)).toEqual(['From Todoist']);
    const second = await h.call((api) => api.syncTasks({}));
    expect(second.value).toMatchObject({ state: SyncTasksResponse_State.THROTTLED, changedTaskCount: 0 });
    expect(second.rowsWritten).toBe(0);
  });

  it('sends the opened key to Todoist only', async () => {
    await h.api.updateSettings({ settings: { name: 'settings', todoistApiKey: 'saved-through-settings' }, updateMask: { paths: ['todoist_api_key'] } });
    await h.api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL });
    expect(h.todoist.requests.map((request) => request.authorization)).toEqual(['Bearer saved-through-settings']);
  });

  it('TODOIST_UNAUTHORIZED when Todoist refuses the key; TODOIST_UNAVAILABLE when it fails', async () => {
    await storeTodoistKey(h.db(), 'synthetic-token');
    h.todoist.status = 401;
    expect((await h.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }))).status).toMatchObject({ httpStatus: 400, reason: 'TODOIST_UNAUTHORIZED' });
    h.todoist.status = 500;
    await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
    expect((await h.call((api) => api.syncTasks({ mode: SyncTasksRequest_Mode.MANUAL }))).status).toMatchObject({ httpStatus: 503, reason: 'TODOIST_UNAVAILABLE' });
  });
});

describe('QueryAnalytics', () => {
  it('answers the raw rows of a range with their tasks (deleted ones included)', async () => {
    await seedTasks({ id: 't1', title: 'Planned' }, { id: 't2', title: 'Deleted later' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    await createTimeEntry(h.db(), { id: 'e1', taskId: 't1', flowDate: '2026-04-13', startTime: '2026-04-13T09:00:00Z', endTime: '2026-04-13T09:30:00Z', durationS: 1800, source: 'timer' });
    await createTimeEntry(h.db(), { id: 'e2', taskId: 't1', flowDate: '2026-04-20', startTime: '2026-04-20T09:00:00Z', endTime: null, durationS: 60, source: 'timer' });
    await h.api.deleteTask({ name: 'tasks/t2' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await setSetting(h.db(), 'day_capacity_mins', '420');
    const data = await h.api.queryAnalytics({ startDate: '2026-04-13', endDate: '2026-04-19' });
    expect(data.plannedTasks.map((row) => [row.flowDate, row.taskId])).toEqual([['2026-04-13', 't1'], ['2026-04-13', 't2']]);
    expect(data.completedTasks.map((row) => [row.flowDate, row.taskId])).toEqual([['2026-04-13', 't1']]);
    expect(data.timeEntries.map((entry) => entry.name)).toEqual(['timeEntries/e1']);
    expect(data.tasks.map((task) => task.name).sort()).toEqual(['tasks/t1', 'tasks/t2']);
    expect(data.dayCapacityMinutes).toBe(420);
    expect(data.nextPageToken).toBe('');
  });

  it('without a range: every time entry, a page at a time; a bad range is BAD_REQUEST', async () => {
    for (let n = 0; n < 5; n += 1) {
      await createTimeEntry(h.db(), { id: `e${String(n)}`, taskId: 't1', flowDate: `2025-01-0${String(n + 1)}`, startTime: `2025-01-0${String(n + 1)}T09:00:00Z`, endTime: null, durationS: 60, source: 'timer' });
    }
    const pages: string[][] = [];
    let pageToken = '';
    do {
      const page = await h.api.queryAnalytics({ pageSize: 2, pageToken });
      expect([page.plannedTasks, page.completedTasks]).toEqual([[], []]);
      pages.push(page.timeEntries.map((entry) => entry.name.slice('timeEntries/'.length)));
      pageToken = page.nextPageToken;
    } while (pageToken !== '');
    expect(pages).toEqual([['e0', 'e1'], ['e2', 'e3'], ['e4']]);
    for (const request of [{ startDate: '2026-04-20', endDate: '2026-04-13' }, { startDate: '2026-04-13' }, { startDate: '2026-04-31', endDate: '2026-05-01' }]) {
      expect((await h.call((api) => api.queryAnalytics(request))).status?.reason, JSON.stringify(request)).toBe('BAD_REQUEST');
    }
  });

  it('a range pages planned rows, then done rows, then entries, at most page_size rows a page, with the tasks each names', async () => {
    await seedTasks({ id: 't1' }, { id: 't2' }, { id: 't3' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await setFlowTaskIds(h.db(), '2026-04-14', ['t3']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't2');
    await createTimeEntry(h.db(), { id: 'e1', taskId: 't3', flowDate: '2026-04-14', startTime: '2026-04-14T09:00:00Z', endTime: null, durationS: 60, source: 'timer' });
    const pages: string[][] = [];
    let pageToken = '';
    do {
      const page = await h.api.queryAnalytics({ startDate: '2026-04-13', endDate: '2026-04-14', pageSize: 2, pageToken });
      pages.push([
        ...page.plannedTasks.map((row) => `p ${row.flowDate} ${row.taskId}`),
        ...page.completedTasks.map((row) => `c ${row.flowDate} ${row.taskId}`),
        ...page.timeEntries.map((entry) => `e ${entry.name}`),
        ...page.tasks.map((task) => task.name).sort(),
      ]);
      pageToken = page.nextPageToken;
    } while (pageToken !== '');
    expect(pages).toEqual([
      ['p 2026-04-13 t1', 'p 2026-04-13 t2', 'tasks/t1', 'tasks/t2'],
      ['p 2026-04-14 t3', 'c 2026-04-13 t2', 'tasks/t2', 'tasks/t3'],
      ['e timeEntries/e1', 'tasks/t3'],
    ]);
    // A token is bound to its range, and only a token this API made is read.
    const first = await h.api.queryAnalytics({ startDate: '2026-04-13', endDate: '2026-04-14', pageSize: 1 });
    expect((await h.call((api) => api.queryAnalytics({ startDate: '2026-04-13', endDate: '2026-04-15', pageToken: first.nextPageToken }))).status?.reason).toBe('BAD_REQUEST');
    const stats = await h.api.queryAnalytics({ pageSize: 1 });
    expect(stats.nextPageToken).toBe('');
  });
});

describe('the wire', () => {
  it('answers snake_case wire JSON, refuses unknown fields and query parameters, and is no-store and nosniff', async () => {
    await seedTasks({ id: 't1', estimatedMins: null });
    const response = await h.fetch('/api/v1/tasks');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({
      tasks: [{ name: 'tasks/t1', title: 'Test Task', project_display_name: 'Work', project_color: '#ff0000', priority: 1, create_time: '2026-04-10T00:00:00Z' }],
    });
    expect((await h.fetch('/api/v1/tasks?unknown=1')).status).toBe(400);
    const unknownField = await h.mutate('PATCH', '/api/v1/flows/2026-04-13', { task_ids: [], taskIds: [] });
    expect(unknownField.status).toBe(400);
    expect((unknownField.body as { error: { status: string } }).error.status).toBe('INVALID_ARGUMENT');
  });

  it("the old UI's routes answer 410 reload_required in the old envelope and change nothing", async () => {
    await seedTasks({ id: 't1' });
    for (const [method, path] of [
      ['GET', '/api/tasks'],
      ['GET', '/api/tasks/deleted'],
      ['GET', '/api/flows'],
      ['GET', '/api/entries?date=2026-04-13'],
      ['GET', '/api/notes?date=2026-04-13'],
      ['GET', '/api/settings'],
      ['GET', '/api/timer/session'],
      ['GET', '/api/analytics'],
    ] as const) {
      const response = await h.fetch(path, { method });
      expect(response.status, path).toBe(410);
      expect((await response.json<{ error: { code: string; message: string; request_id: string } }>()).error).toMatchObject({ code: 'reload_required', message: 'FlowDay has been updated. Reload the page to continue.' });
    }
    for (const [method, path, body] of [
      ['DELETE', '/api/tasks', { taskId: 't1' }],
      ['PUT', '/api/flows', { action: 'setFlow', date: '2026-04-13', taskIds: ['t1'] }],
      ['PUT', '/api/entries/e1', { startTime: '2026-04-13T10:00:00Z', endTime: '2026-04-13T11:00:00Z' }],
      ['POST', '/api/sync', { mode: 'manual' }],
    ] as const) {
      const result = await h.mutate(method, path, body);
      expect([result.status, result.rowsWritten], path).toEqual([410, 0]);
    }
    expect(await taskIds()).toEqual(['t1']);
    expect(await getAllFlows(h.db())).toEqual({});
  });

  it('unknown /api paths are NOT_FOUND Status bodies', async () => {
    const response = await h.fetch('/api/nothing-here');
    expect(response.status).toBe(404);
    expect((await response.json<{ error: { details: { reason?: string }[] } }>()).error.details[0]?.reason).toBe('NOT_FOUND');
    expect((await h.fetch('/api/v1/nothing-here')).status).toBe(404);
    expect((await h.fetch('/api/v1/tasks', { method: 'PUT' })).status).toBe(405);
  });

  it('create requests carry a fresh UUID each (distinct IDs, distinct entries)', async () => {
    const entry = { taskId: 't1', flowDate: '2026-04-13', startTime: at('2026-04-13T09:00:00Z') };
    await h.api.createTimeEntry({ timeEntry: entry, requestId: UUID });
    await h.api.createTimeEntry({ timeEntry: entry, requestId: UUID_2 });
    expect(await getEntriesByTask(h.db(), 't1')).toHaveLength(2);
  });
});
