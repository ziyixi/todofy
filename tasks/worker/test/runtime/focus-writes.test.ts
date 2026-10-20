/**
 * What a busy Focus day costs in D1 rows written (Workers Free allows 100,000 a day): 10 steps queued, 5 moved,
 * 6 timer sessions with a pause each that end when their step completes, and 3 records edited. Synthetic rows.
 */
import { randomUUID } from 'node:crypto';
import { stdout } from 'node:process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { FocusEntrySchema } from '@ziyixi/proto/tasks/ui/v1/focus_pb';
import {
  CommandFocusTimerRequest_Action as Action,
  CommandFocusTimerRequestSchema,
  CompleteTaskRequestSchema,
  ListFocusDaysRequestSchema,
  MoveFocusStepRequestSchema,
  UpdateFocusEntryRequestSchema,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { addDays, localDate } from '@ziyixi/task-dates';
import { listFocusDays, moveFocusStep } from '../../src/focus.ts';
import { updateFocusEntry } from '../../src/focus-entries.ts';
import { commandFocusTimer } from '../../src/focus-timer.ts';
import { completeTask } from '../../src/task-write.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

const ZONE = 'America/Los_Angeles';
const MINUTE = 60_000;
let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

test('a busy Focus day writes fewer than 300 D1 rows', async () => {
  // A fixed morning, so the simulated day never crosses midnight.
  const start = Date.parse('2030-04-15T16:00:00Z');
  const today = localDate(start, ZONE);
  const steps = Array.from({ length: 10 }, (_, index) => `day-step-${String(index)}`);
  await harness.db
    .prepare(
      "INSERT INTO tasks(id,title,sort_order,created_at,updated_at) VALUES('day-outcome','Synthetic outcome',1,1,1)",
    )
    .run();
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,parent_id,kind,duration_minutes,sort_order,created_at,updated_at)
      SELECT value,'Synthetic step '||value,'day-outcome','step',30,1,1,1 FROM json_each(?)`,
    )
    .bind(JSON.stringify(steps))
    .run();
  const { db, metrics } = measuredReads(harness.db);
  const move = (taskId: string, fields: { sourceDay?: string; destinationDay?: string; beforeTaskId?: string }) =>
    moveFocusStep(db, create(MoveFocusStepRequestSchema, { requestId: randomUUID(), taskId, ...fields }), start);
  for (const step of steps) await move(step, { destinationDay: today });
  const added = { ...metrics };
  const tomorrow = addDays(today, 1);
  await move('day-step-9', { sourceDay: today, destinationDay: today, beforeTaskId: 'day-step-0' });
  await move('day-step-8', { sourceDay: today, destinationDay: today, beforeTaskId: 'day-step-1' });
  await move('day-step-7', { sourceDay: today, destinationDay: today, beforeTaskId: 'day-step-2' });
  await move('day-step-6', { sourceDay: today, destinationDay: tomorrow });
  await move('day-step-5', { sourceDay: today, destinationDay: tomorrow });
  const moved = { ...metrics };
  let etag = '1';
  let now = start;
  const command = async (action: Action, taskId = '') => {
    const answer = await commandFocusTimer(
      db,
      create(CommandFocusTimerRequestSchema, { name: 'focusTimer', requestId: randomUUID(), etag, action, taskId }),
      now,
      ZONE,
    );
    etag = answer.timer?.etag ?? '';
  };
  // Six of the steps still queued today.
  for (const step of ['day-step-0', 'day-step-1', 'day-step-2', 'day-step-3', 'day-step-4', 'day-step-7']) {
    await command(Action.START, step);
    now += 20 * MINUTE;
    await command(Action.PAUSE);
    now += 5 * MINUTE;
    await command(Action.RESUME);
    now += 10 * MINUTE;
    await completeTask(
      db,
      create(CompleteTaskRequestSchema, { name: `tasks/${step}`, etag: '1', requestId: randomUUID() }),
      now,
      ZONE,
    );
    // The completion settled the session, so the timer's etag moved on.
    etag = String(Number(etag) + 1);
  }
  const timed = { ...metrics };
  const read = await listFocusDays(
    harness.db,
    create(ListFocusDaysRequestSchema, { startDay: today, endDay: today }),
    ZONE,
    now,
  );
  expect(read.entries).toHaveLength(6);
  expect(read.days[0]?.doneTaskIds).toHaveLength(6);
  for (const entry of read.entries.slice(0, 3))
    await updateFocusEntry(
      db,
      create(UpdateFocusEntryRequestSchema, {
        requestId: randomUUID(),
        etag: entry.etag,
        focusEntry: create(FocusEntrySchema, { name: entry.name, seconds: 40 * 60 }),
        updateMask: { paths: ['seconds'] },
      }),
      now,
    );
  stdout.write(JSON.stringify({ event: 'tasks_focus_day_writes', added, moved, timed, total: metrics }) + '\n');
  expect(metrics.rowsWritten).toBeLessThan(300);
});
