/**
 * The owner API through the Worker (../../src/api.ts) on real D1: the container era's route tests
 * (web/__tests__/integration/* at ziyixi/FlowDay 10a8f43), now over HTTP with the dev bypass, a CSRF token and the
 * loopback Origin. Errors are the envelope {error: {code, message, request_id}}.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsDataset, ApiError, FlowStateResponse, SettingsResponse, Task, TimeEntry } from '../../src/api-types.ts';
import { addCompletedFlowTask, getAllFlows, setFlowTaskIds } from '../../src/store/flows.ts';
import { createTimeEntry, getEntriesByTask } from '../../src/store/entries.ts';
import { getSetting, setSetting } from '../../src/store/settings.ts';
import { upsertTasks } from '../../src/store/tasks.ts';
import { startHarness, type Harness } from './harness.ts';

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

function makeTask(overrides: Partial<Task> = {}): Task {
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

async function seedTasks(...tasks: Partial<Task>[]): Promise<void> {
  await upsertTasks(h.db(), tasks.map((task) => makeTask(task)));
}

function errorOf(body: unknown): ApiError['error'] {
  return (body as ApiError).error;
}

describe('/api/tasks', () => {
  it('GET returns the tasks that are not deleted', async () => {
    await seedTasks({ id: 't1', title: 'Active Task' }, { id: 't2', title: 'Another Task' }, { id: 't3' });
    await h.mutate('DELETE', '/api/tasks', { taskId: 't3' });
    const tasks = await h.get<Task[]>('/api/tasks');
    expect(tasks.map((task) => task.id).sort()).toEqual(['t1', 't2']);
  });

  it('PATCH updates, clears and validates the estimate; trims titles; accepts numeric strings', async () => {
    await seedTasks({ id: 't1', estimatedMins: 30 });
    expect((await h.mutate('PATCH', '/api/tasks', { taskId: 't1', estimatedMins: 60 })).body).toEqual({ success: true });
    expect((await h.get<Task[]>('/api/tasks'))[0]?.estimatedMins).toBe(60);
    await h.mutate('PATCH', '/api/tasks', { taskId: 't1', estimatedMins: null });
    expect((await h.get<Task[]>('/api/tasks'))[0]?.estimatedMins).toBeNull();
    await h.mutate('PATCH', '/api/tasks', { taskId: 't1', title: '  Renamed Task  ', estimatedMins: '75' });
    expect((await h.get<Task[]>('/api/tasks'))[0]).toMatchObject({ title: 'Renamed Task', estimatedMins: 75 });
    for (const body of [{ estimatedMins: 60 }, { taskId: 't1', estimatedMins: -10 }, { taskId: 't1', title: '' }]) {
      const result = await h.mutate('PATCH', '/api/tasks', body);
      expect(result.status).toBe(400);
      expect(errorOf(result.body).code).toBe('bad_request');
    }
  });

  it('DELETE soft-deletes a task and removes it from every flow', async () => {
    await seedTasks({ id: 't1' }, { id: 't2' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await addCompletedFlowTask(h.db(), '2026-04-12', 't1');
    expect((await h.mutate('DELETE', '/api/tasks', { taskId: 't1' })).body).toEqual({ success: true });
    expect((await h.get<Task[]>('/api/tasks')).map((task) => task.id)).toEqual(['t2']);
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t2'] });
    expect((await h.get<FlowStateResponse>('/api/flows')).completedTasks).toEqual({});
    expect((await h.mutate('DELETE', '/api/tasks', { notTaskId: 't1' })).status).toBe(400);
  });

  it('POST creates a local task (201) with trimmed title and optional fields; it appears in GET', async () => {
    const created = await h.mutate<Task>('POST', '/api/tasks', {
      title: '  Planned task  ',
      priority: 3,
      dueDate: '2026-04-20',
      estimatedMins: 45,
      labels: ['docs', 'review'],
      description: 'Needs commas, quotes, and detail',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Planned task', priority: 3, dueDate: '2026-04-20', estimatedMins: 45, labels: ['docs', 'review'], description: 'Needs commas, quotes, and detail', todoistId: null });
    expect(created.body.id).toMatch(/^local-/);
    expect((await h.get<Task[]>('/api/tasks')).some((task) => task.title === 'Planned task')).toBe(true);
    expect((await h.mutate('POST', '/api/tasks', { title: '' })).status).toBe(400);
    expect((await h.mutate('POST', '/api/tasks', {})).status).toBe(400);
  });

  it('/api/tasks/deleted lists only tasks deleted in FlowDay and restores one', async () => {
    await seedTasks({ id: 't1' }, { id: 't2' }, { id: 't3' });
    await h.mutate('DELETE', '/api/tasks', { taskId: 't2' });
    await h.mutate('DELETE', '/api/tasks', { taskId: 't3' });
    expect((await h.get<Task[]>('/api/tasks/deleted')).map((task) => task.id).sort()).toEqual(['t2', 't3']);
    expect((await h.mutate('POST', '/api/tasks/deleted', { taskId: 't2' })).body).toEqual({ success: true });
    expect((await h.get<Task[]>('/api/tasks/deleted')).map((task) => task.id)).toEqual(['t3']);
    expect((await h.get<Task[]>('/api/tasks')).map((task) => task.id).sort()).toEqual(['t1', 't2']);
    expect((await h.mutate('POST', '/api/tasks/deleted', { notTaskId: 't2' })).status).toBe(400);
  });
});

describe('/api/flows', () => {
  it('GET is empty without data and returns seeded flows and completions', async () => {
    expect(await h.get<FlowStateResponse>('/api/flows')).toEqual({ flows: {}, completedTasks: {} });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    expect(await h.get<FlowStateResponse>('/api/flows')).toEqual({ flows: { '2026-04-13': ['t1', 't2'] }, completedTasks: { '2026-04-13': ['t1'] } });
  });

  it('setFlow sets, clears with an empty list and validates', async () => {
    expect((await h.mutate('PUT', '/api/flows', { action: 'setFlow', date: '2026-04-13', taskIds: ['t1', 't2'] })).body).toEqual({ success: true });
    expect((await h.get<FlowStateResponse>('/api/flows')).flows['2026-04-13']).toEqual(['t1', 't2']);
    await h.mutate('PUT', '/api/flows', { action: 'setFlow', date: '2026-04-13', taskIds: [] });
    expect((await getAllFlows(h.db()))['2026-04-13']).toBeUndefined();
    expect((await h.mutate('PUT', '/api/flows', { action: 'setFlow', date: '2026-04-13', taskIds: 'not-an-array' })).status).toBe(400);
  });

  it('addCompleted and removeCompleted', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1']);
    await h.mutate('PUT', '/api/flows', { action: 'addCompleted', date: '2026-04-13', taskId: 't1' });
    expect((await h.get<FlowStateResponse>('/api/flows')).completedTasks['2026-04-13']).toEqual(['t1']);
    expect((await h.mutate('PUT', '/api/flows', { action: 'addCompleted', date: '2026-04-13' })).status).toBe(400);
    await h.mutate('PUT', '/api/flows', { action: 'removeCompleted', date: '2026-04-13', taskId: 't1' });
    expect((await h.get<FlowStateResponse>('/api/flows')).completedTasks['2026-04-13']).toBeUndefined();
  });

  it('rollover moves the unfinished tasks to the top of the target day, without duplicates', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2', 't3']);
    await setFlowTaskIds(h.db(), '2026-04-14', ['t3', 't9']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    await h.mutate('PUT', '/api/flows', { action: 'rollover', date: '2026-04-13', fromDate: '2026-04-13', toDate: '2026-04-14' });
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t1'], '2026-04-14': ['t2', 't3', 't9'] });
  });

  it('rollover is a no-op when nothing is unfinished', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    const result = await h.mutate('PUT', '/api/flows', { action: 'rollover', date: '2026-04-13', fromDate: '2026-04-13', toDate: '2026-04-14' });
    expect(result.status).toBe(200);
    expect(result.rowsWritten).toBe(0);
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t1'] });
  });

  it('rolloverSelected moves only the selected tasks; unknown ids are a no-op', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2', 't3']);
    await h.mutate('PUT', '/api/flows', { action: 'rolloverSelected', date: '2026-04-13', fromDate: '2026-04-13', toDate: '2026-04-14', taskIds: ['t1', 't3'] });
    expect(await getAllFlows(h.db())).toEqual({ '2026-04-13': ['t2'], '2026-04-14': ['t1', 't3'] });
    await h.mutate('PUT', '/api/flows', { action: 'rolloverSelected', date: '2026-04-13', fromDate: '2026-04-13', toDate: '2026-04-15', taskIds: ['missing-task'] });
    expect((await getAllFlows(h.db()))['2026-04-15']).toBeUndefined();
  });

  it('errors: unknown action, missing date, non-object body, incomplete rolloverSelected', async () => {
    const cases: [unknown, string][] = [
      [{ action: 'invalidAction', date: '2026-04-13' }, 'Unknown action'],
      [{ action: 'setFlow', taskIds: ['t1'] }, 'date is required'],
      ['not-an-object', 'The request body must be a JSON object.'],
      [{ action: 'rolloverSelected', date: '2026-04-13', fromDate: '2026-04-13' }, 'fromDate, toDate, and taskIds required'],
    ];
    for (const [body, message] of cases) {
      const result = await h.mutate('PUT', '/api/flows', body);
      expect(result.status).toBe(400);
      expect(errorOf(result.body).message).toBe(message);
    }
  });
});

describe('/api/entries', () => {
  const seedEntries = async () => {
    await createTimeEntry(h.db(), { id: 'e1', taskId: 't1', flowDate: '2026-04-13', startTime: '2026-04-13T09:00:00Z', endTime: '2026-04-13T09:30:00Z', durationS: 1800, source: 'timer' });
    await createTimeEntry(h.db(), { id: 'e2', taskId: 't2', flowDate: '2026-04-13', startTime: '2026-04-13T10:00:00Z', endTime: '2026-04-13T10:15:00Z', durationS: 900, source: 'manual' });
  };

  it('POST creates an entry (201); missing fields are 400', async () => {
    const created = await h.mutate<TimeEntry>('POST', '/api/entries', { taskId: 't1', flowDate: '2026-04-13', startTime: '2026-04-13T09:00:00Z', endTime: '2026-04-13T09:30:00Z', durationS: 1800, source: 'manual' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ taskId: 't1', source: 'manual', durationS: 1800 });
    expect(await getEntriesByTask(h.db(), 't1')).toHaveLength(1);
    expect((await h.mutate('POST', '/api/entries', { taskId: 't1' })).status).toBe(400);
  });

  it('GET by task, by date, by both; 400 without either', async () => {
    await seedEntries();
    expect((await h.get<TimeEntry[]>('/api/entries?taskId=t1')).map((entry) => entry.id)).toEqual(['e1']);
    expect(await h.get<TimeEntry[]>('/api/entries?date=2026-04-13')).toHaveLength(2);
    expect((await h.get<TimeEntry[]>('/api/entries?taskId=t1&date=2026-04-13')).map((entry) => entry.id)).toEqual(['e1']);
    expect((await h.fetch('/api/entries')).status).toBe(400);
  });

  it('PUT recomputes the duration; 404 for a missing entry; 400 for missing fields', async () => {
    await seedEntries();
    expect((await h.mutate('PUT', '/api/entries/e1', { startTime: '2026-04-13T10:07:00Z', endTime: '2026-04-13T11:22:00Z' })).body).toMatchObject({ durationS: 4500 });
    expect((await h.mutate('PUT', '/api/entries/nonexistent', { startTime: '2026-04-13T10:00:00Z', endTime: '2026-04-13T11:00:00Z' })).status).toBe(404);
    expect((await h.mutate('PUT', '/api/entries/e1', { startTime: '2026-04-13T10:00:00Z' })).status).toBe(400);
  });

  it('DELETE removes an entry; 404 for a missing one', async () => {
    await seedEntries();
    expect((await h.mutate('DELETE', '/api/entries/e1')).status).toBe(200);
    expect(await getEntriesByTask(h.db(), 't1')).toEqual([]);
    expect((await h.mutate('DELETE', '/api/entries/nonexistent')).status).toBe(404);
  });
});

describe('/api/notes', () => {
  it('GET answers an empty note for a task and day without one; 400 without a date', async () => {
    expect(await h.get('/api/notes?taskId=t1&date=2026-04-13')).toEqual({ taskId: 't1', flowDate: '2026-04-13', content: '' });
    expect((await h.fetch('/api/notes')).status).toBe(400);
  });

  it('PUT creates and updates (upsert); GET by day returns that day only', async () => {
    expect((await h.mutate('PUT', '/api/notes', { taskId: 't1', flowDate: '2026-04-13', content: 'Original content' })).body).toMatchObject({ content: 'Original content' });
    expect((await h.mutate('PUT', '/api/notes', { taskId: 't1', flowDate: '2026-04-13', content: 'Updated content' })).body).toMatchObject({ taskId: 't1', flowDate: '2026-04-13', content: 'Updated content' });
    await h.mutate('PUT', '/api/notes', { taskId: 't2', flowDate: '2026-04-13', content: 'Note for task 2' });
    await h.mutate('PUT', '/api/notes', { taskId: 't3', flowDate: '2026-04-14', content: 'Other day' });
    const day = await h.get<{ taskId: string }[]>('/api/notes?date=2026-04-13');
    expect(day.map((note) => note.taskId).sort()).toEqual(['t1', 't2']);
    expect((await h.mutate('PUT', '/api/notes', { taskId: 't1' })).status).toBe(400);
  });
});

describe('/api/settings', () => {
  it('GET returns defaults and last_sync_at when present', async () => {
    expect(await h.get<SettingsResponse>('/api/settings')).toEqual({ todoist_api_key: null, has_api_key: false, last_sync_at: null, day_capacity_mins: 360, planning_completed_today: false });
    await setSetting(h.db(), 'last_sync_at', '2026-04-13T12:00:00.000Z');
    expect((await h.get<SettingsResponse>('/api/settings')).last_sync_at).toBe('2026-04-13T12:00:00.000Z');
  });

  it('PUT stores the key (GET masks it), rejects an empty key, and a new key restarts the sync from scratch', async () => {
    await setSetting(h.db(), 'todoist_sync_token', 'old-token');
    await setSetting(h.db(), 'sync_claimed_at', String(Date.now()));
    expect((await h.mutate('PUT', '/api/settings', { todoist_api_key: 'my-secret-key-12345' })).body).toEqual({ success: true });
    expect(await h.get<SettingsResponse>('/api/settings')).toMatchObject({ todoist_api_key: '••••••••', has_api_key: true });
    expect(await getSetting(h.db(), 'todoist_sync_token')).toBeNull();
    expect(await getSetting(h.db(), 'sync_claimed_at')).toBeNull();
    const same = await h.mutate('PUT', '/api/settings', { todoist_api_key: 'my-secret-key-12345' });
    expect(same.rowsWritten).toBe(0);
    expect((await h.mutate('PUT', '/api/settings', { todoist_api_key: '' })).status).toBe(400);
  });

  it('PUT capacity, planning day, combined updates; ignores an invalid planning date; rejects a negative capacity', async () => {
    await h.mutate('PUT', '/api/settings', { todoist_api_key: 'combo-secret', day_capacity_mins: 480, planning_completed_date: '2026-04-13' });
    expect(await h.get<SettingsResponse>('/api/settings?today=2026-04-13')).toMatchObject({ has_api_key: true, day_capacity_mins: 480, planning_completed_today: true });
    expect((await h.mutate('PUT', '/api/settings', { planning_completed_date: '2026/04/13' })).status).toBe(200);
    expect(await getSetting(h.db(), 'planning_completed:2026/04/13')).toBeNull();
    expect((await h.mutate('PUT', '/api/settings', { day_capacity_mins: -100 })).status).toBe(400);
  });
});

describe('/api/timer/session', () => {
  const payload = {
    taskId: 'task-1',
    flowDate: '2026-04-21',
    status: 'running',
    timerMode: 'pomodoro',
    pomodoroTargetS: 1800,
    segmentWallStart: '2026-04-21T09:00:00.000Z',
    sessionSavedS: 120,
    pomodoroFinishedTaskId: null,
    pomodoroFinishedFlowDate: null,
    pomodoroFinishedTargetS: null,
  };

  it('null without a session; PUT stores the full payload; invalid status and mode are normalised; DELETE clears', async () => {
    expect(await h.get('/api/timer/session')).toEqual({ session: null });
    expect((await h.mutate('PUT', '/api/timer/session', payload)).body).toEqual({ success: true });
    const stored = await h.get<{ session: Record<string, unknown> }>('/api/timer/session');
    expect(stored.session).toMatchObject(payload);
    expect(typeof stored.session['updatedAt']).toBe('string');
    await h.mutate('PUT', '/api/timer/session', { ...payload, taskId: 'task-2', status: 'broken', timerMode: 'weird', sessionSavedS: 25 });
    expect((await h.get<{ session: unknown }>('/api/timer/session')).session).toMatchObject({ taskId: 'task-2', status: 'idle', timerMode: 'countup', sessionSavedS: 25 });
    expect((await h.mutate('DELETE', '/api/timer/session')).body).toEqual({ success: true });
    expect(await h.get('/api/timer/session')).toEqual({ session: null });
  });
});

describe('/api/sync', () => {
  it('400 no_todoist_key without a key', async () => {
    const result = await h.mutate('POST', '/api/sync', { mode: 'manual' });
    expect(result.status).toBe(400);
    expect(errorOf(result.body)).toMatchObject({ code: 'no_todoist_key', message: 'No Todoist API key configured. Add one in Settings.' });
  });

  it('syncs through the Worker, then throttles the next automatic sync', async () => {
    await setSetting(h.db(), 'todoist_api_key', 'synthetic-token');
    h.todoist.setProjects([{ id: 'p1', name: 'Inbox', color: 'blue' }]);
    h.todoist.setItems([{ id: 'td-1', content: 'From Todoist', project_id: 'p1' }]);
    const first = await h.mutate('POST', '/api/sync', { mode: 'auto' });
    expect(first.body).toMatchObject({ status: 'synced', changed: 1, fullSync: true });
    expect((await h.get<Task[]>('/api/tasks')).map((task) => task.title)).toEqual(['From Todoist']);
    const second = await h.mutate('POST', '/api/sync', { mode: 'auto' });
    expect(second.body).toMatchObject({ status: 'throttled', changed: 0 });
    expect(second.rowsWritten).toBe(0);
  });

  it('502 todoist_unauthorized when Todoist rejects the key', async () => {
    await setSetting(h.db(), 'todoist_api_key', 'synthetic-token');
    h.todoist.status = 401;
    const result = await h.mutate('POST', '/api/sync', { mode: 'manual' });
    expect(result.status).toBe(502);
    expect(errorOf(result.body).code).toBe('todoist_unauthorized');
  });
});

describe('/api/analytics', () => {
  it('returns the raw rows of a date range with their tasks (deleted ones included)', async () => {
    await seedTasks({ id: 't1', title: 'Planned' }, { id: 't2', title: 'Deleted later' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await addCompletedFlowTask(h.db(), '2026-04-13', 't1');
    await createTimeEntry(h.db(), { id: 'e1', taskId: 't1', flowDate: '2026-04-13', startTime: '2026-04-13T09:00:00Z', endTime: '2026-04-13T09:30:00Z', durationS: 1800, source: 'timer' });
    await createTimeEntry(h.db(), { id: 'e2', taskId: 't1', flowDate: '2026-04-20', startTime: '2026-04-20T09:00:00Z', endTime: null, durationS: 60, source: 'timer' });
    await h.mutate('DELETE', '/api/tasks', { taskId: 't2' });
    await setFlowTaskIds(h.db(), '2026-04-13', ['t1', 't2']);
    await setSetting(h.db(), 'day_capacity_mins', '420');
    const data = await h.get<AnalyticsDataset>('/api/analytics?start=2026-04-13&end=2026-04-19');
    expect(data.flows).toEqual([{ flowDate: '2026-04-13', taskId: 't1' }, { flowDate: '2026-04-13', taskId: 't2' }]);
    expect(data.completed).toEqual([{ flowDate: '2026-04-13', taskId: 't1' }]);
    expect(data.entries.map((entry) => entry.id)).toEqual(['e1']);
    expect(data.tasks.map((task) => task.id).sort()).toEqual(['t1', 't2']);
    expect(data.dayCapacityMins).toBe(420);
  });

  it('without a range: every time entry (the work-pattern stats); a bad range is 400', async () => {
    await createTimeEntry(h.db(), { id: 'e1', taskId: 't1', flowDate: '2025-01-01', startTime: '2025-01-01T09:00:00Z', endTime: null, durationS: 60, source: 'timer' });
    const data = await h.get<AnalyticsDataset>('/api/analytics');
    expect(data.entries.map((entry) => entry.id)).toEqual(['e1']);
    expect(data.start).toBeNull();
    expect((await h.fetch('/api/analytics?start=2026-04-20&end=2026-04-13')).status).toBe(400);
    expect((await h.fetch('/api/analytics?start=2026-04-13')).status).toBe(400);
  });
});
