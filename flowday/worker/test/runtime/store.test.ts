/**
 * The D1 store modules (../../src/store/) on real D1: the container era's query tests (web/__tests__/unit/queries-*,
 * timer-session-queries, sync-logic, db-migrations at ziyixi/FlowDay 10a8f43), now async, plus D1's own limits
 * (more than 100 ids in one statement) and the row counts of each write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/api-types.ts';
import { Meter } from '../../src/db.ts';
import { createTimeEntry, deleteTimeEntry, getAllTimeEntries, getEntriesByDate, getEntriesByTask, getEntriesByTaskAndDate, getEntriesInDateRange, updateTimeEntry } from '../../src/store/entries.ts';
import { addCompletedFlowTask, getAllCompletedFlowTasks, getAllFlows, removeCompletedFlowTask, setFlowTaskIds } from '../../src/store/flows.ts';
import { getNote, upsertNote } from '../../src/store/notes.ts';
import { getSetting, setSetting } from '../../src/store/settings.ts';
import {
  getAllTasks,
  getDeletedTasks,
  getTasksByIds,
  markOrphanedTodoistTasksDeleted,
  restoreTask,
  softDeleteTask,
  updateTaskEstimate,
  upsertTasks,
} from '../../src/store/tasks.ts';
import { clearActiveTimerSession, getActiveTimerSession, saveActiveTimerSession } from '../../src/store/timer-session.ts';
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
    projectName: null,
    projectColor: null,
    priority: 1,
    labels: [],
    estimatedMins: null,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: '2026-04-10T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

const ids = (tasks: Task[]) => tasks.map((task) => task.id).sort();

describe('settings', () => {
  it('returns null for a missing setting, sets, overwrites', async () => {
    const db = h.db();
    expect(await getSetting(db, 'key')).toBeNull();
    await setSetting(db, 'key', 'v1');
    expect(await getSetting(db, 'key')).toBe('v1');
    await setSetting(db, 'key', 'v2');
    expect(await getSetting(db, 'key')).toBe('v2');
  });

  it('writing the same value again writes no row', async () => {
    await setSetting(h.db(), 'key', 'same');
    const meter = new Meter();
    await setSetting(h.db(meter), 'key', 'same');
    expect(meter.rowsWritten).toBe(0);
  });
});

describe('tasks', () => {
  it('upserts and retrieves tasks; an upsert updates the existing row', async () => {
    const db = h.db();
    await upsertTasks(db, [makeTask({ id: 't1', title: 'Task 1' }), makeTask({ id: 't2', title: 'Task 2' })]);
    expect((await getAllTasks(db)).map((task) => task.title).sort()).toEqual(['Task 1', 'Task 2']);
    await upsertTasks(db, [makeTask({ id: 't1', title: 'Updated' })]);
    expect((await getAllTasks(db)).find((task) => task.id === 't1')?.title).toBe('Updated');
  });

  it('soft deletes and restores a task', async () => {
    const db = h.db();
    await upsertTasks(db, [makeTask({ id: 't1' })]);
    expect(await softDeleteTask(db, 't1')).toBe(true);
    expect(ids(await getDeletedTasks(db))).toEqual(['t1']);
    expect(await getAllTasks(db)).toEqual([]);
    expect(await restoreTask(db, 't1')).toBe(true);
    expect(await getDeletedTasks(db)).toEqual([]);
    expect(ids(await getAllTasks(db))).toEqual(['t1']);
  });

  it('marks Todoist-orphaned tasks deleted (source sync, hidden from the trash)', async () => {
    const db = h.db();
    await upsertTasks(db, [
      makeTask({ id: 'td-1', todoistId: 'td-1' }),
      makeTask({ id: 'td-2', todoistId: 'td-2' }),
      makeTask({ id: 'local-1', todoistId: null }),
    ]);
    expect(await markOrphanedTodoistTasksDeleted(db, ['td-1'])).toBe(1);
    expect(ids(await getAllTasks(db))).toEqual(['local-1', 'td-1']);
    expect(await getDeletedTasks(db)).toEqual([]);
  });

  it('restores a sync-deleted task when Todoist returns it; keeps a task deleted in FlowDay deleted', async () => {
    const db = h.db();
    await upsertTasks(db, [makeTask({ id: 'td-1', todoistId: 'td-1', title: 'Original' }), makeTask({ id: 'td-2', todoistId: 'td-2' })]);
    await markOrphanedTodoistTasksDeleted(db, ['td-2']);
    await softDeleteTask(db, 'td-2');
    expect(await getAllTasks(db)).toEqual([]);
    await upsertTasks(db, [makeTask({ id: 'td-1', todoistId: 'td-1', title: 'Resurrected' }), makeTask({ id: 'td-2', todoistId: 'td-2' })]);
    expect((await getAllTasks(db)).map((task) => [task.id, task.title])).toEqual([['td-1', 'Resurrected']]);
    expect(ids(await getDeletedTasks(db))).toEqual(['td-2']);
  });

  it('a legacy soft delete (deleted_source NULL) counts as trash and is never restored by a sync', async () => {
    await h.sql("INSERT INTO tasks (id, todoist_id, title, created_at, deleted_at) VALUES ('legacy-trash', 'td-legacy', 'Trashed before upgrade', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')");
    const db = h.db();
    expect(ids(await getDeletedTasks(db))).toEqual(['legacy-trash']);
    await upsertTasks(db, [makeTask({ id: 'legacy-trash', todoistId: 'td-legacy', title: 'Resurrected by sync' })]);
    expect(await getAllTasks(db)).toEqual([]);
    expect(await getDeletedTasks(db)).toHaveLength(1);
  });

  it('orphan marking: a no-op without Todoist tasks, idempotent, and survives orphan → restore → orphan', async () => {
    const db = h.db();
    await upsertTasks(db, [makeTask({ id: 'local-only' })]);
    expect(await markOrphanedTodoistTasksDeleted(db, [])).toBe(0);
    await upsertTasks(db, [makeTask({ id: 'td-1', todoistId: 'td-1' })]);
    expect(await markOrphanedTodoistTasksDeleted(db, [])).toBe(1);
    const [first] = await h.sql<{ deleted_at: string }>("SELECT deleted_at FROM tasks WHERE id = 'td-1'");
    expect(await markOrphanedTodoistTasksDeleted(db, [])).toBe(0);
    const [second] = await h.sql<{ deleted_at: string; deleted_source: string }>("SELECT deleted_at, deleted_source FROM tasks WHERE id = 'td-1'");
    expect(second).toEqual({ deleted_at: first?.deleted_at, deleted_source: 'sync' });
    await upsertTasks(db, [makeTask({ id: 'td-1', todoistId: 'td-1' })]);
    expect(ids(await getAllTasks(db))).toEqual(['local-only', 'td-1']);
    expect(await markOrphanedTodoistTasksDeleted(db, [])).toBe(1);
    expect(await getDeletedTasks(db)).toEqual([]);
  });

  it('orphan marking with more than 100 active ids (one JSON parameter, not 100+ bound parameters)', async () => {
    const db = h.db();
    const all = Array.from({ length: 250 }, (_, n) => makeTask({ id: `td-${String(n)}`, todoistId: `td-${String(n)}` }));
    await upsertTasks(db, all);
    const active = all.slice(0, 180).map((task) => task.id);
    expect(await markOrphanedTodoistTasksDeleted(db, active)).toBe(70);
    expect(await getAllTasks(db)).toHaveLength(180);
  });

  it('getTasksByIds with more than 100 ids, deleted tasks included, duplicates ignored', async () => {
    const db = h.db();
    const all = Array.from({ length: 150 }, (_, n) => makeTask({ id: `t-${String(n)}` }));
    await upsertTasks(db, all);
    await softDeleteTask(db, 't-3');
    const wanted = [...all.map((task) => task.id), 't-1', 'missing'];
    const found = await getTasksByIds(db, wanted);
    expect(found).toHaveLength(150);
    expect(found.find((task) => task.id === 't-3')?.deletedAt).not.toBeNull();
  });

  it('updates and clears the estimate; the same estimate again writes nothing', async () => {
    const db = h.db();
    await upsertTasks(db, [makeTask({ id: 't1', estimatedMins: 45 })]);
    await updateTaskEstimate(db, 't1', 30);
    expect((await getAllTasks(db))[0]?.estimatedMins).toBe(30);
    const meter = new Meter();
    await updateTaskEstimate(h.db(meter), 't1', 30);
    expect(meter.rowsWritten).toBe(0);
    await updateTaskEstimate(db, 't1', null);
    expect((await getAllTasks(db))[0]?.estimatedMins).toBeNull();
  });

  it('upsert rules: rescheduled, cleared due day, Todoist duration over the local estimate, completion', async () => {
    const db = h.db();
    await upsertTasks(db, [makeTask({ id: 't1', todoistId: 'todoist-1', dueDate: '2026-04-16' })]);
    await upsertTasks(db, [makeTask({ id: 't1', todoistId: 'todoist-1', dueDate: '2026-04-23' })]);
    expect((await getAllTasks(db))[0]?.dueDate).toBe('2026-04-23');
    await upsertTasks(db, [makeTask({ id: 't1', todoistId: 'todoist-1', dueDate: null })]);
    expect((await getAllTasks(db))[0]?.dueDate).toBeNull();
    await updateTaskEstimate(db, 't1', 45);
    await upsertTasks(db, [makeTask({ id: 't1', todoistId: 'todoist-1', estimatedMins: null })]);
    expect((await getAllTasks(db))[0]?.estimatedMins).toBe(45);
    await upsertTasks(db, [makeTask({ id: 't1', todoistId: 'todoist-1', estimatedMins: 20 })]);
    expect((await getAllTasks(db))[0]?.estimatedMins).toBe(20);
    await upsertTasks(db, [makeTask({ id: 't1', todoistId: 'todoist-1', isCompleted: true, completedAt: '2026-04-13T10:00:00Z' })]);
    expect((await getAllTasks(db))[0]).toMatchObject({ isCompleted: true, completedAt: '2026-04-13T10:00:00Z' });
  });

  it('row counts: a new task costs 5 rows (row, key, 3 indexes); an unchanged upsert 0; a title change 1', async () => {
    let meter = new Meter();
    await upsertTasks(h.db(meter), [makeTask({ id: 't1', todoistId: 'td-1', dueDate: '2026-04-13' })]);
    expect(meter.rowsWritten).toBe(5);
    meter = new Meter();
    await upsertTasks(h.db(meter), [makeTask({ id: 't1', todoistId: 'td-1', dueDate: '2026-04-13' })]);
    expect(meter.rowsWritten).toBe(0);
    meter = new Meter();
    await upsertTasks(h.db(meter), [makeTask({ id: 't1', todoistId: 'td-1', dueDate: '2026-04-13', title: 'New title' })]);
    expect(meter.rowsWritten).toBe(1);
  });
});

describe('flows', () => {
  it('sets, replaces and keeps several dates', async () => {
    const db = h.db();
    await setFlowTaskIds(db, '2026-04-13', ['t1', 't2', 't3']);
    expect((await getAllFlows(db))['2026-04-13']).toEqual(['t1', 't2', 't3']);
    await setFlowTaskIds(db, '2026-04-13', ['t3']);
    await setFlowTaskIds(db, '2026-04-14', ['t2']);
    expect(await getAllFlows(db)).toEqual({ '2026-04-13': ['t3'], '2026-04-14': ['t2'] });
  });

  it('writes only the difference: an unchanged flow 0 rows, a reorder only the moved rows', async () => {
    await setFlowTaskIds(h.db(), '2026-04-13', ['a', 'b', 'c', 'd']);
    let meter = new Meter();
    await setFlowTaskIds(h.db(meter), '2026-04-13', ['a', 'b', 'c', 'd']);
    expect(meter.rowsWritten).toBe(0);
    meter = new Meter();
    await setFlowTaskIds(h.db(meter), '2026-04-13', ['a', 'b', 'd', 'c']);
    expect(meter.rowsWritten).toBe(2);
    expect((await getAllFlows(h.db()))['2026-04-13']).toEqual(['a', 'b', 'd', 'c']);
  });

  it('a flow of more than 100 tasks, with a duplicate id', async () => {
    const list = Array.from({ length: 140 }, (_, n) => `t-${String(n)}`);
    await setFlowTaskIds(h.db(), '2026-04-13', [...list, 't-0']);
    expect((await getAllFlows(h.db()))['2026-04-13']).toEqual(list);
  });

  it('completed tasks: add, remove, duplicate add is ignored and writes nothing', async () => {
    const db = h.db();
    await addCompletedFlowTask(db, '2026-04-13', 't1');
    await addCompletedFlowTask(db, '2026-04-13', 't2');
    expect((await getAllCompletedFlowTasks(db))['2026-04-13']?.sort()).toEqual(['t1', 't2']);
    const meter = new Meter();
    await addCompletedFlowTask(h.db(meter), '2026-04-13', 't1');
    expect(meter.rowsWritten).toBe(0);
    await removeCompletedFlowTask(db, '2026-04-13', 't1');
    expect((await getAllCompletedFlowTasks(db))['2026-04-13']).toEqual(['t2']);
  });
});

describe('time entries', () => {
  const entry = (id: string, taskId: string, flowDate: string, durationS = 600) => ({
    id,
    taskId,
    flowDate,
    startTime: `${flowDate}T09:00:00Z`,
    endTime: null,
    durationS,
    source: 'timer' as const,
  });

  it('creates and reads by task, by date, by both, and by range', async () => {
    const db = h.db();
    await createTimeEntry(db, entry('e1', 't1', '2026-04-10'));
    await createTimeEntry(db, entry('e2', 't1', '2026-04-13', 1800));
    await createTimeEntry(db, entry('e3', 't2', '2026-04-14', 900));
    expect((await getEntriesByTask(db, 't1')).map((row) => row.id)).toEqual(['e1', 'e2']);
    expect((await getEntriesByDate(db, '2026-04-14')).map((row) => row.id)).toEqual(['e3']);
    expect(await getEntriesByDate(db, '2026-04-15')).toEqual([]);
    expect((await getEntriesByTaskAndDate(db, 't1', '2026-04-13')).map((row) => row.id)).toEqual(['e2']);
    expect((await getEntriesInDateRange(db, '2026-04-11', '2026-04-14')).map((row) => row.id)).toEqual(['e2', 'e3']);
    expect(await getAllTimeEntries(db)).toHaveLength(3);
    const [first] = await getEntriesByTask(db, 't1');
    expect(first).toMatchObject({ source: 'timer', durationS: 600, endTime: null });
    expect(first?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('updates and deletes; false for a missing entry', async () => {
    const db = h.db();
    await createTimeEntry(db, entry('e1', 't1', '2026-04-13', 1800));
    expect(await updateTimeEntry(db, 'e1', { startTime: '2026-04-13T10:00:00Z', endTime: '2026-04-13T11:00:00Z', durationS: 3600 })).toBe(true);
    expect((await getEntriesByTask(db, 't1'))[0]).toMatchObject({ durationS: 3600, startTime: '2026-04-13T10:00:00Z' });
    expect(await updateTimeEntry(db, 'missing', { startTime: 'a', endTime: 'b', durationS: 1 })).toBe(false);
    expect(await deleteTimeEntry(db, 'e1')).toBe(true);
    expect(await deleteTimeEntry(db, 'e1')).toBe(false);
  });
});

describe('notes', () => {
  it('upserts one note per task and day; the same text again writes nothing', async () => {
    const db = h.db();
    await upsertNote(db, 't1', '2026-04-13', 'First\nline two with\ttab');
    expect((await getNote(db, 't1', '2026-04-13'))?.content).toBe('First\nline two with\ttab');
    await upsertNote(db, 't1', '2026-04-13', 'Second');
    expect((await getNote(db, 't1', '2026-04-13'))?.content).toBe('Second');
    const meter = new Meter();
    await upsertNote(h.db(meter), 't1', '2026-04-13', 'Second');
    expect(meter.rowsWritten).toBe(0);
  });
});

describe('active timer session', () => {
  const base = {
    taskId: 'task-1',
    flowDate: '2026-04-21',
    status: 'running' as const,
    timerMode: 'pomodoro' as const,
    pomodoroTargetS: 1800,
    segmentWallStart: '2026-04-21T09:00:00.000Z',
    sessionSavedS: 120,
    pomodoroFinishedTaskId: null,
    pomodoroFinishedFlowDate: null,
    pomodoroFinishedTargetS: null,
  };

  it('round-trips a session and refreshes updatedAt on overwrite (one row each)', async () => {
    const db = h.db();
    await saveActiveTimerSession(db, base, new Date('2026-04-21T09:00:00.000Z'));
    expect(await getActiveTimerSession(db)).toEqual({ ...base, updatedAt: '2026-04-21T09:00:00.000Z' });
    const meter = new Meter();
    await saveActiveTimerSession(h.db(meter), { ...base, status: 'paused', segmentWallStart: null, sessionSavedS: 300 }, new Date('2026-04-21T09:05:00.000Z'));
    expect(meter.rowsWritten).toBe(1);
    expect(await getActiveTimerSession(db)).toMatchObject({ status: 'paused', sessionSavedS: 300, segmentWallStart: null, updatedAt: '2026-04-21T09:05:00.000Z' });
  });

  it('hides the empty idle shape and clears the row', async () => {
    const db = h.db();
    await saveActiveTimerSession(db, { ...base, taskId: null, flowDate: null, status: 'idle', timerMode: 'countup', pomodoroTargetS: null, segmentWallStart: null, sessionSavedS: 0 });
    expect(await getActiveTimerSession(db)).toBeNull();
    await saveActiveTimerSession(db, base);
    await clearActiveTimerSession(db);
    expect(await getActiveTimerSession(db)).toBeNull();
  });
});
