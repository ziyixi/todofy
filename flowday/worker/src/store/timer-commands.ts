/** Server-owned timer transitions. Session, segment and receipt change in one D1 batch. */
import { sql } from 'drizzle-orm';
import { CommandTimerRequest_Action as Action, type CommandTimerRequest } from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { TimerSession_Mode } from '@ziyixi/proto/flowday/ui/v1/time_entry_pb';
import { timestampDate } from '@ziyixi/proto/protobuf/wkt';
import { batchSql, type Db } from '../db.ts';
import { flowdayError } from '../errors.ts';
import type { TimerSessionRecord } from '../model.ts';
import { getActiveTimerSession } from './timer-session.ts';

export const emptyTimer = (): TimerSessionRecord => ({
  taskId: null, flowDate: null, status: 'idle', timerMode: 'countup', pomodoroTargetS: null,
  segmentWallStart: null, sessionSavedS: 0, pomodoroFinishedTaskId: null,
  pomodoroFinishedFlowDate: null, pomodoroFinishedTargetS: null, updatedAt: null, etag: '0',
});

interface Receipt { fingerprint: string; result: string }
async function receipt(db: Db, requestId: string): Promise<Receipt | undefined> {
  return (await db.all<Receipt>(sql`SELECT fingerprint, result FROM timer_commands WHERE request_id = ${requestId}`))[0];
}
function replay(row: Receipt, fingerprint: string): TimerSessionRecord {
  if (row.fingerprint !== fingerprint) throw flowdayError('BAD_REQUEST');
  return JSON.parse(row.result) as TimerSessionRecord;
}

function validate(request: CommandTimerRequest): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (request.name !== 'timerSession' || !uuid.test(request.requestId) || !request.etag || request.etag.length > 64) throw flowdayError('BAD_REQUEST');
  if (request.action < Action.START || request.action > Action.DISMISS_POMODORO) throw flowdayError('BAD_REQUEST');
  if (request.action === Action.START || request.action === Action.SETTLE) {
    const parsedDay = new Date(`${request.flowDate}T00:00:00Z`);
    if (!/^[\x21-\x7e]{1,200}$/.test(request.taskId) || !/^\d{4}-\d{2}-\d{2}$/.test(request.flowDate)
      || !Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== request.flowDate) throw flowdayError('BAD_REQUEST');
  }
  if (request.mode === TimerSession_Mode.POMODORO && (!request.targetSeconds || request.targetSeconds < 1 || request.targetSeconds > 36000)) throw flowdayError('BAD_REQUEST');
}

function transition(before: TimerSessionRecord, request: CommandTimerRequest, now: Date): { session: TimerSessionRecord; seconds: number; end: string } {
  const action = request.action;
  let endMs = now.getTime();
  const startMs = before.segmentWallStart === null ? endMs : Date.parse(before.segmentWallStart);
  if (action === Action.PAUSE && request.effectiveStopTime !== undefined) endMs = Math.min(endMs, Math.max(startMs, timestampDate(request.effectiveStopTime).getTime()));
  let seconds = before.status === 'running' ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;
  if (before.timerMode === 'pomodoro') seconds = Math.min(seconds, Math.max(0, (before.pomodoroTargetS ?? 0) - before.sessionSavedS));
  if (action === Action.RESUME || action === Action.DISMISS_POMODORO || action === Action.DISCARD) seconds = 0;
  const settledTimer = before.taskId === request.taskId && before.flowDate === request.flowDate;
  if (action === Action.SETTLE && !settledTimer) seconds = 0;
  const end = new Date(startMs + seconds * 1000).toISOString();
  let session: TimerSessionRecord = { ...before };
  switch (action) {
    case Action.START:
      session = { ...emptyTimer(), taskId: request.taskId, flowDate: request.flowDate, status: 'running', timerMode: request.mode === TimerSession_Mode.POMODORO ? 'pomodoro' : 'countup', pomodoroTargetS: request.mode === TimerSession_Mode.POMODORO ? (request.targetSeconds ?? null) : null, segmentWallStart: now.toISOString() };
      break;
    case Action.PAUSE:
      if (before.status !== 'running') throw flowdayError('TIMER_CONFLICT');
      session = { ...before, status: 'paused', segmentWallStart: null, sessionSavedS: before.sessionSavedS + seconds };
      break;
    case Action.RESUME:
      if (before.status !== 'paused' || (before.timerMode === 'pomodoro' && before.sessionSavedS >= (before.pomodoroTargetS ?? 0))) throw flowdayError('TIMER_CONFLICT');
      session = { ...before, status: 'running', segmentWallStart: now.toISOString() };
      break;
    case Action.STOP:
    case Action.DISCARD:
      session = emptyTimer();
      break;
    case Action.SETTLE:
      if (settledTimer) session = emptyTimer();
      break;
    case Action.FINISH_POMODORO:
      if (before.status !== 'running' || before.timerMode !== 'pomodoro' || before.sessionSavedS + seconds < (before.pomodoroTargetS ?? 0)) throw flowdayError('TIMER_CONFLICT');
      session = { ...emptyTimer(), pomodoroFinishedTaskId: before.taskId, pomodoroFinishedFlowDate: before.flowDate, pomodoroFinishedTargetS: before.pomodoroTargetS };
      break;
    case Action.DISMISS_POMODORO:
      session = { ...before, pomodoroFinishedTaskId: null, pomodoroFinishedFlowDate: null, pomodoroFinishedTargetS: null };
      break;
  }
  return { session: { ...session, updatedAt: now.toISOString(), etag: crypto.randomUUID() }, seconds, end };
}

export async function commandTimer(db: Db, request: CommandTimerRequest, now: Date): Promise<TimerSessionRecord> {
  validate(request);
  const fingerprint = JSON.stringify([request.etag, request.action, request.taskId, request.flowDate, request.mode, request.targetSeconds ?? null, request.effectiveStopTime === undefined ? null : timestampDate(request.effectiveStopTime).toISOString()]);
  const previous = await receipt(db, request.requestId);
  if (previous !== undefined) return replay(previous, fingerprint);
  const before = (await getActiveTimerSession(db)) ?? emptyTimer();
  if (before.etag !== request.etag) throw flowdayError('TIMER_CONFLICT');
  const { session: next, seconds, end } = transition(before, request, now);
  const version = next.etag ?? '';
  const statements = [
    sql`INSERT INTO active_timer_session (id) VALUES ('main') ON CONFLICT(id) DO NOTHING`,
    sql`UPDATE active_timer_session SET task_id = ${next.taskId}, flow_date = ${next.flowDate}, status = ${next.status},
      timer_mode = ${next.timerMode}, pomodoro_target_s = ${next.pomodoroTargetS}, segment_wall_start = ${next.segmentWallStart},
      session_saved_s = ${next.sessionSavedS}, pomodoro_finished_task_id = ${next.pomodoroFinishedTaskId},
      pomodoro_finished_flow_date = ${next.pomodoroFinishedFlowDate}, pomodoro_finished_target_s = ${next.pomodoroFinishedTargetS},
      updated_at = ${next.updatedAt}, etag = ${version}
      WHERE id = 'main' AND etag = ${request.etag} AND NOT EXISTS (SELECT 1 FROM timer_commands WHERE request_id = ${request.requestId})`,
  ];
  if (seconds > 0 && before.taskId !== null && before.flowDate !== null && before.segmentWallStart !== null) {
    statements.push(sql`INSERT INTO time_entries (id, task_id, flow_date, start_time, end_time, duration_s, source, created_at)
      SELECT ${request.requestId}, ${before.taskId}, ${before.flowDate}, ${before.segmentWallStart}, ${end}, ${seconds}, 'timer', ${now.toISOString()}
      WHERE EXISTS (SELECT 1 FROM active_timer_session WHERE id = 'main' AND etag = ${version})`);
  }
  if (request.action === Action.SETTLE) {
    statements.push(sql`INSERT INTO completed_flow_tasks (id, flow_date, task_id)
      SELECT ${request.requestId}, ${request.flowDate}, ${request.taskId}
      WHERE EXISTS (SELECT 1 FROM active_timer_session WHERE id = 'main' AND etag = ${version}) ON CONFLICT DO NOTHING`);
  }
  statements.push(sql`INSERT INTO timer_commands (request_id, fingerprint, result, created_at)
    SELECT ${request.requestId}, ${fingerprint}, ${JSON.stringify(next)}, ${now.toISOString()}
    WHERE EXISTS (SELECT 1 FROM active_timer_session WHERE id = 'main' AND etag = ${version}) ON CONFLICT DO NOTHING`);
  await batchSql(db, statements);
  const committed = await receipt(db, request.requestId);
  if (committed === undefined) throw flowdayError('TIMER_CONFLICT');
  return replay(committed, fingerprint);
}
