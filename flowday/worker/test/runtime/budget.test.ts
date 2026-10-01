/**
 * The D1 rows a typical day of using FlowDay writes through the API (../../../docs/design.md "Write budget"), as
 * D1 reports them (x-flowday-rows-written). The sync's share is in ./sync.test.ts ("write budget"); together they
 * stay far below the 1,000 rows a day the owner set as FlowDay's ceiling (the account's Free allowance is 100,000
 * rows a day, shared by every app).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Task } from '../../src/api-types.ts';
import { upsertTasks } from '../../src/store/tasks.ts';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});

const DAY = '2026-04-13';

function task(n: number): Task {
  return {
    id: `td-${String(n)}`,
    todoistId: `td-${String(n)}`,
    title: `Synthetic task ${String(n)}`,
    description: null,
    projectName: 'Work',
    projectColor: '#4073ff',
    priority: 1,
    labels: [],
    estimatedMins: 30,
    isCompleted: false,
    completedAt: null,
    dueDate: DAY,
    createdAt: '2026-04-01T00:00:00.000Z',
    deletedAt: null,
  };
}

describe('write budget of a day of use', () => {
  it('planning, a dozen timer segments, notes, estimates and the review stay below 300 rows', async () => {
    await h.reset();
    await upsertTasks(h.db(), Array.from({ length: 200 }, (_, n) => task(n)));
    const rows: Record<string, number> = {};
    const add = (label: string, result: { status: number; rowsWritten: number }) => {
      expect(result.status, label).toBeLessThan(300);
      rows[label] = (rows[label] ?? 0) + result.rowsWritten;
    };

    // Morning planning: 8 tasks into today's flow, then reordered twice, one estimate set per task.
    const plan = Array.from({ length: 8 }, (_, n) => `td-${String(n)}`);
    add('plan the day', await h.mutate('PUT', '/api/flows', { action: 'setFlow', date: DAY, taskIds: plan }));
    add('reorder', await h.mutate('PUT', '/api/flows', { action: 'setFlow', date: DAY, taskIds: [plan[1], plan[0], ...plan.slice(2)] }));
    add('reorder', await h.mutate('PUT', '/api/flows', { action: 'setFlow', date: DAY, taskIds: [...plan.slice(2), plan[1], plan[0]] }));
    for (const id of plan) add('estimates', await h.mutate('PATCH', '/api/tasks', { taskId: id, estimatedMins: 45 }));
    add('planning done', await h.mutate('PUT', '/api/settings', { planning_completed_date: DAY }));

    // 12 timer segments: start (session), pause (session + entry), with a resume or a switch in between.
    for (let n = 0; n < 12; n += 1) {
      const taskId = plan[n % plan.length] ?? 'td-0';
      const start = `${DAY}T${String(8 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 === 0 ? '00' : '30'}:00.000Z`;
      add('timer', await h.mutate('PUT', '/api/timer/session', { taskId, flowDate: DAY, status: 'running', timerMode: 'pomodoro', pomodoroTargetS: 1500, segmentWallStart: start, sessionSavedS: 0 }));
      add('timer', await h.mutate('POST', '/api/entries', { taskId, flowDate: DAY, startTime: start, endTime: start.replace(':00.000Z', ':25.000Z'), durationS: 1500, source: 'timer' }));
      add('timer', await h.mutate('PUT', '/api/timer/session', { taskId, flowDate: DAY, status: 'paused', timerMode: 'pomodoro', pomodoroTargetS: 1500, segmentWallStart: null, sessionSavedS: 1500 }));
    }
    add('timer', await h.mutate('DELETE', '/api/timer/session'));

    // Notes: 6 tasks, each saved 5 times while typing (the client saves after a pause in typing).
    for (const id of plan.slice(0, 6)) {
      for (let n = 1; n <= 5; n += 1) add('notes', await h.mutate('PUT', '/api/notes', { taskId: id, flowDate: DAY, content: `Note ${'line\n'.repeat(n)}` }));
    }

    // Two manual corrections, 6 tasks done, the rest rolled over to tomorrow, a local quick task.
    add('corrections', await h.mutate('POST', '/api/entries', { taskId: 'td-7', flowDate: DAY, startTime: `${DAY}T17:00:00Z`, endTime: `${DAY}T17:20:00Z`, durationS: 1200, source: 'manual' }));
    add('corrections', await h.mutate('POST', '/api/entries', { taskId: 'td-6', flowDate: DAY, startTime: `${DAY}T17:30:00Z`, endTime: `${DAY}T17:40:00Z`, durationS: 600, source: 'manual' }));
    for (const id of plan.slice(0, 6)) add('done', await h.mutate('PUT', '/api/flows', { action: 'addCompleted', date: DAY, taskId: id }));
    add('rollover', await h.mutate('PUT', '/api/flows', { action: 'rollover', date: DAY, fromDate: DAY, toDate: '2026-04-14' }));
    add('quick task', await h.mutate('POST', '/api/tasks', { title: 'Call the plumber', dueDate: DAY }));

    const total = Object.values(rows).reduce((sum, value) => sum + value, 0);
    console.log(`write budget of a day of use: ${String(total)} rows ${JSON.stringify(rows)}`);
    expect(total).toBeLessThan(300);
  });
});
