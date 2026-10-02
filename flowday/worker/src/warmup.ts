/**
 * Runs the owner API's answer path at startup, in the Worker's global scope (outside any request's CPU time on Workers
 * Free, like the transcoder's route table): the records-to-messages mapping of ./api.ts and the wire JSON writer of
 * proto/ts/wire-json.ts, on synthetic records with every field set, enough times that V8 has compiled and optimized
 * them. Without it an isolate's first list answer runs that code interpreted, item by item: a page of 200 tasks then
 * cost about 3 ms more CPU than a warm one (../test/runtime/cpu.test.ts measures the isolate's first API request).
 * Synthetic data only; nothing is read or written.
 */
import { ListTasksResponseSchema, QueryAnalyticsResponseSchema } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { flowMessage, taskMessage, timeEntryMessage } from './api.ts';
import type { TaskRecord, TimeEntryRecord } from './model.ts';

/** Messages written per round; WARMUP_ROUNDS rounds reach V8's optimizing tier (measured: 200 rounds of 5 items). */
const BATCH = 5;
export const WARMUP_ROUNDS = 200;

const TASK: TaskRecord = {
  id: 'warmup-task',
  todoistId: 'warmup-task',
  title: 'Warm-up task',
  description: 'Warm-up description',
  projectName: 'Warm-up project',
  projectColor: '#808080',
  priority: 2,
  labels: ['warm', 'up'],
  estimatedMins: 30,
  isCompleted: false,
  completedAt: '2026-01-01T00:00:00.000000Z',
  dueDate: '2026-01-01',
  createdAt: '2026-01-01T00:00:00Z',
  deletedAt: '2026-01-01T00:00:00.000Z',
};

const ENTRY: TimeEntryRecord = {
  id: 'warmup-entry',
  taskId: 'warmup-task',
  flowDate: '2026-01-01',
  startTime: '2026-01-01T09:00:00.000Z',
  endTime: '2026-01-01T09:30:00.000Z',
  durationS: 1800,
  source: 'manual',
  createdAt: '2026-01-01 09:30:00',
};

/** Writes `rounds` list answers of BATCH items each (tasks, then an analytics page with entries and flows). */
export function warmUp(rounds: number = WARMUP_ROUNDS): void {
  for (let round = 0; round < rounds; round += 1) {
    const tasks = Array.from({ length: BATCH }, () => taskMessage(TASK));
    JSON.stringify(toWire(ListTasksResponseSchema, create(ListTasksResponseSchema, { tasks, nextPageToken: 'warm' })));
    const timeEntries = Array.from({ length: BATCH }, () => timeEntryMessage(ENTRY));
    const flows = Array.from({ length: BATCH }, () => flowMessage('2026-01-01', ['warmup-task'], ['warmup-task'], true));
    JSON.stringify(toWire(QueryAnalyticsResponseSchema, create(QueryAnalyticsResponseSchema, { timeEntries, flows, tasks, dayCapacityMinutes: 360 })));
  }
}
