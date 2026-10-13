import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommandTimerRequest_Action as Action, CommandTimerRequestSchema, type CommandTimerRequest } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { TimerSession_Mode } from '@ziyixi/proto/flowday/ui/v1/time_entry_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromDate } from '@ziyixi/proto/protobuf/wkt';
import { commandTimer } from '../../src/store/timer-commands.ts';
import { getActiveTimerSession } from '../../src/store/timer-session.ts';
import { getEntriesByTask } from '../../src/store/entries.ts';
import { getCompletedTaskIds } from '../../src/store/flows.ts';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.dispose(); });
beforeEach(async () => { await h.reset(); });
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 13, 9, 0, seconds));
const request = (action: Action, etag: string, extras: Partial<Omit<CommandTimerRequest, "$typeName">> = {}) => create(CommandTimerRequestSchema, {
  name: 'timerSession', requestId: crypto.randomUUID(), etag, action, taskId: 'task-1', flowDate: '2026-10-13', ...extras,
});

describe('server timer commands on real D1', () => {
  it('records a segment once across a lost response, pause/resume and two windows', async () => {
    const started = await commandTimer(h.db(), request(Action.START, '0'), at(0));
    const pause = request(Action.PAUSE, started.etag ?? '');
    const paused = await commandTimer(h.db(), pause, at(30));
    expect(await commandTimer(h.db(), pause, at(90))).toEqual(paused);
    expect((await getEntriesByTask(h.db(), 'task-1')).map((e) => e.durationS)).toEqual([30]);
    await expect(commandTimer(h.db(), request(Action.STOP, started.etag ?? ''), at(90))).rejects.toMatchObject({ reason: 'TIMER_CONFLICT' });
    const resumed = await commandTimer(h.db(), request(Action.RESUME, paused.etag ?? ''), at(120));
    const [a, b] = await Promise.allSettled([
      commandTimer(h.db(), request(Action.STOP, resumed.etag ?? ''), at(140)),
      commandTimer(h.db(), request(Action.PAUSE, resumed.etag ?? ''), at(140)),
    ]);
    expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getEntriesByTask(h.db(), 'task-1')).map((e) => e.durationS)).toEqual([30, 20]);
  });

  it('settles only the completed task and preserves an unrelated active task', async () => {
    const started = await commandTimer(h.db(), request(Action.START, '0', { taskId: 'task-2' }), at(0));
    const settle = request(Action.SETTLE, started.etag ?? '');
    const next = await commandTimer(h.db(), settle, at(30));
    expect(next).toMatchObject({ taskId: 'task-2', status: 'running' });
    expect(await getCompletedTaskIds(h.db(), '2026-10-13')).toEqual(['task-1']);
    expect(await getEntriesByTask(h.db(), 'task-2')).toEqual([]);
    await commandTimer(h.db(), request(Action.SETTLE, next.etag ?? '', { taskId: 'task-2' }), at(60));
    expect((await getActiveTimerSession(h.db()))?.status).toBe('idle');
    expect((await getEntriesByTask(h.db(), 'task-2'))[0]?.durationS).toBe(60);
  });

  it('does not stop today when a delayed completion settles yesterday for the same recurring ID', async () => {
    const started = await commandTimer(h.db(), request(Action.START, '0'), at(0));
    const settled = await commandTimer(h.db(), request(Action.SETTLE, started.etag ?? '', { flowDate: '2026-10-12' }), at(30));
    expect(settled).toMatchObject({ status: 'running', taskId: 'task-1', flowDate: '2026-10-13', segmentWallStart: at(0).toISOString() });
    expect(await getEntriesByTask(h.db(), 'task-1')).toEqual([]);
    expect(await getCompletedTaskIds(h.db(), '2026-10-12')).toEqual(['task-1']);
    await expect(commandTimer(h.db(), request(Action.START, settled.etag ?? '', { flowDate: '2026-99-99' }), at(40))).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
  });

  it('caps pomodoro time, preserves an idle cutoff, and rejects premature finish', async () => {
    const started = await commandTimer(h.db(), request(Action.START, '0', { mode: TimerSession_Mode.POMODORO, targetSeconds: 60 }), at(0));
    await expect(commandTimer(h.db(), request(Action.FINISH_POMODORO, started.etag ?? ''), at(10))).rejects.toMatchObject({ reason: 'TIMER_CONFLICT' });
    const paused = await commandTimer(h.db(), request(Action.PAUSE, started.etag ?? '', { effectiveStopTime: timestampFromDate(at(20)) }), at(30));
    expect(paused.sessionSavedS).toBe(20);
    const resumed = await commandTimer(h.db(), request(Action.RESUME, paused.etag ?? ''), at(40));
    const finished = await commandTimer(h.db(), request(Action.FINISH_POMODORO, resumed.etag ?? ''), at(100));
    expect(finished).toMatchObject({ status: 'idle', pomodoroFinishedTaskId: 'task-1', pomodoroFinishedTargetS: 60 });
    expect((await getEntriesByTask(h.db(), 'task-1')).map((e) => e.durationS)).toEqual([20, 40]);
  });
});
