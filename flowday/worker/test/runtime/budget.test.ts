/**
 * The D1 rows a typical day of using FlowDay writes through the owner API (../../../docs/design.md "Write budget"), as
 * D1 reports them (x-flowday-rows-written), each call made as the UI makes it (the shared typed client, update masks,
 * a request_id per create). The sync's share is in ./sync.test.ts ("write budget"); together they
 * stay far below the 1,000 rows a day the owner set as FlowDay's ceiling (the account's Free allowance is 100,000
 * rows a day, shared by every app).
 */
import { TimeEntry_Source, TimerSession_Mode, TimerSession_State } from '@ziyixi/proto/flowday/ui/v1/time_entry_pb';
import { timestampFromDate } from '@ziyixi/proto/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../../src/model.ts';
import { upsertTasks } from '../../src/store/tasks.ts';
import { startHarness, type Call, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});

const DAY = '2026-04-13';

/** The rows each step of the day wrote through the routes before flowday.ui.v1 (221 in all). */
const ROWS_BEFORE_UI_V1: Readonly<Record<string, number>> = {
  'plan the day': 32,
  reorder: 10,
  estimates: 8,
  'planning done': 2,
  timer: 74,
  notes: 48,
  corrections: 8,
  done: 24,
  rollover: 12,
  'quick task': 3,
};

function task(n: number): TaskRecord {
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
  it('planning, a dozen timer segments, notes, estimates and the review stay below 250 rows', async () => {
    await h.reset();
    await upsertTasks(h.db(), Array.from({ length: 200 }, (_, n) => task(n)));
    const rows: Record<string, number> = {};
    const add = <T>(label: string, result: Call<T>) => {
      expect(result.status, label).toBeUndefined();
      rows[label] = (rows[label] ?? 0) + result.rowsWritten;
    };
    const at = (iso: string) => timestampFromDate(new Date(iso));
    const flow = (taskIds: string[]) => h.call((api) => api.updateFlow({ flow: { name: `flows/${DAY}`, taskIds }, updateMask: { paths: ['task_ids'] } }));

    // Morning planning: 8 tasks into today's flow, then reordered twice, one estimate set per task.
    const plan = Array.from({ length: 8 }, (_, n) => `td-${String(n)}`);
    add('plan the day', await flow(plan));
    add('reorder', await flow([plan[1] ?? '', plan[0] ?? '', ...plan.slice(2)]));
    add('reorder', await flow([...plan.slice(2), plan[1] ?? '', plan[0] ?? '']));
    for (const id of plan) add('estimates', await h.call((api) => api.updateTask({ task: { name: `tasks/${id}`, estimatedMinutes: 45 }, updateMask: { paths: ['estimated_minutes'] } })));
    add('planning done', await h.call((api) => api.updateFlow({ flow: { name: `flows/${DAY}`, planningCompleted: true }, updateMask: { paths: ['planning_completed'] } })));

    // 12 timer segments: start (session), pause (session + entry), with a resume or a switch in between.
    for (let n = 0; n < 12; n += 1) {
      const taskId = plan[n % plan.length] ?? 'td-0';
      const start = `${DAY}T${String(8 + Math.floor(n / 2)).padStart(2, '0')}:${n % 2 === 0 ? '00' : '30'}:00.000Z`;
      const session = { name: 'timerSession', taskId, flowDate: DAY, mode: TimerSession_Mode.POMODORO, pomodoroTargetSeconds: 1500 };
      add('timer', await h.call((api) => api.updateTimerSession({ timerSession: { ...session, state: TimerSession_State.RUNNING, segmentStartTime: at(start), savedSeconds: 0 } })));
      add('timer', await h.call((api) => api.createTimeEntry({ timeEntry: { taskId, flowDate: DAY, startTime: at(start), endTime: at(start.replace(':00.000Z', ':25.000Z')), durationSeconds: 1500, source: TimeEntry_Source.TIMER }, requestId: crypto.randomUUID() })));
      add('timer', await h.call((api) => api.updateTimerSession({ timerSession: { ...session, state: TimerSession_State.PAUSED, savedSeconds: 1500 } })));
    }
    add('timer', await h.call((api) => api.clearTimerSession({ name: 'timerSession' })));

    // Notes: 6 tasks, each saved 5 times while typing (the client saves after a pause in typing).
    for (const id of plan.slice(0, 6)) {
      for (let n = 1; n <= 5; n += 1) add('notes', await h.call((api) => api.updateNote({ note: { name: `flows/${DAY}/notes/${id}`, content: `Note ${'line\n'.repeat(n)}` } })));
    }

    // Two manual corrections, 6 tasks done, the rest rolled over to tomorrow, a local quick task.
    for (const [taskId, start, end, seconds] of [['td-7', '17:00', '17:20', 1200], ['td-6', '17:30', '17:40', 600]] as const) {
      add('corrections', await h.call((api) => api.createTimeEntry({ timeEntry: { taskId, flowDate: DAY, startTime: at(`${DAY}T${start}:00Z`), endTime: at(`${DAY}T${end}:00Z`), durationSeconds: seconds, source: TimeEntry_Source.MANUAL }, requestId: crypto.randomUUID() })));
    }
    for (const id of plan.slice(0, 6)) add('done', await h.call((api) => api.completeFlowTask({ name: `flows/${DAY}`, taskId: id })));
    add('rollover', await h.call((api) => api.rolloverFlow({ name: `flows/${DAY}`, destination: 'flows/2026-04-14', allUnfinished: true })));
    add('quick task', await h.call((api) => api.createTask({ task: { title: 'Call the plumber', dueDate: DAY }, requestId: crypto.randomUUID() })));

    const total = Object.values(rows).reduce((sum, value) => sum + value, 0);
    console.log(`write budget of a day of use: ${String(total)} rows ${JSON.stringify(rows)}`);
    expect(total).toBeLessThan(250);
    // A ratchet: no step writes more than it did through the hand-written routes before flowday.ui.v1 (2026-10-02),
    // and every step still writes (a step that wrote nothing would no longer measure what it is named after).
    for (const [label, before] of Object.entries(ROWS_BEFORE_UI_V1)) {
      expect(rows[label], label).toBeLessThanOrEqual(before);
      expect(rows[label], label).toBeGreaterThan(0);
    }
  });
});
