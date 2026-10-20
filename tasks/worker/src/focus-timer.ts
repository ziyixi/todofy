/**
 * The one Focus timer (proto/tasks/ui/v1/focus.proto). Every command is guarded by the timer's revision. A session
 * counts on Tasks' today when it starts and is saved as one record of whole minutes when it stops, finishes or its
 * task completes (task-write.ts), and only when it reaches a minute. Count up stops counting at 4 hours, a pomodoro
 * at its target.
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { FocusTimer_State, FocusTimerSchema, type FocusTimer } from '@ziyixi/proto/tasks/ui/v1/focus_pb';
import {
  CommandFocusTimerRequest_Action as Action,
  CommandFocusTimerResponseSchema,
  type CommandFocusTimerRequest,
  type GetFocusTimerRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { localDate } from '@ziyixi/task-dates';
import { conflict, invalid, precondition, storage } from './errors.ts';
import { DAY_ENTRIES, checkedArea, commitChecked, entryMessage, type Check, type EntryRow } from './focus.ts';
import { checkedId } from './model.ts';
import { fingerprint, replay } from './receipts.ts';

/** Count up's limit, also a pomodoro's longest target. */
export const COUNT_UP_SECONDS = 14_400;
const NAME = 'focusTimer';
const STATES = { idle: FocusTimer_State.IDLE, running: FocusTimer_State.RUNNING, paused: FocusTimer_State.PAUSED };

interface TimerRow {
  state: keyof typeof STATES;
  task_id: string;
  day: string;
  area: string;
  target_seconds: number | null;
  started_at: number | null;
  segment_start: number | null;
  saved_seconds: number;
  finished_task_id: string;
  finished_seconds: number;
  revision: number;
}
const IDLE = {
  state: 'idle',
  task_id: '',
  day: '',
  area: '',
  target_seconds: null,
  started_at: null,
  segment_start: null,
  saved_seconds: 0,
} as const;

function timerMessage(row: TimerRow): FocusTimer {
  return create(FocusTimerSchema, {
    name: NAME,
    state: STATES[row.state],
    taskId: row.task_id,
    day: row.day,
    area: row.area,
    ...(row.target_seconds === null ? {} : { targetSeconds: row.target_seconds }),
    savedSeconds: row.saved_seconds,
    ...(row.segment_start === null ? {} : { segmentStartTime: timestampFromMs(row.segment_start) }),
    ...(row.started_at === null ? {} : { startTime: timestampFromMs(row.started_at) }),
    finishedTaskId: row.finished_task_id,
    finishedSeconds: row.finished_seconds,
    etag: String(row.revision),
  });
}
/** The session's seconds at `now`: closed time plus the running segment, at most its limit. */
function elapsed(row: TimerRow, now: number): number {
  const running =
    row.state === 'running' && row.segment_start !== null ? Math.floor((now - row.segment_start) / 1000) : 0;
  return Math.min(row.saved_seconds + Math.max(0, running), row.target_seconds ?? COUNT_UP_SECONDS);
}
async function readTimer(db: D1Database): Promise<TimerRow> {
  const row = await storage(() => db.prepare("SELECT * FROM focus_timer WHERE id='timer'").first<TimerRow>());
  if (!row) throw new Error('The Focus timer row is missing');
  return row;
}
export async function getFocusTimer(db: D1Database, input: GetFocusTimerRequest) {
  if (input.name !== NAME) invalid('The timer is focusTimer');
  return timerMessage(await readTimer(db));
}

function commandResult(text: string) {
  return fromWire(CommandFocusTimerResponseSchema, JSON.parse(text)).message;
}
export async function commandFocusTimer(db: D1Database, input: CommandFocusTimerRequest, now: number, zone: string) {
  const hash = await fingerprint('commandFocusTimer', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return commandResult(previous);
  if (input.name !== NAME) invalid('The timer is focusTimer');
  if (!input.etag) invalid('An etag is required');
  const old = await readTimer(db);
  if (String(old.revision) !== input.etag) conflict();
  if (input.action !== Action.START && input.taskId && input.taskId !== old.task_id)
    precondition('The timer is timing another step.');
  let next: TimerRow = { ...old, revision: old.revision + 1 };
  let entry: EntryRow | undefined;
  const checks: Check[] = [];
  switch (input.action) {
    case Action.START: {
      if (old.state !== 'idle') precondition('The timer is already running.');
      const target = input.targetSeconds;
      if (target !== undefined && (!Number.isInteger(target) || target < 60 || target > COUNT_UP_SECONDS))
        invalid('A pomodoro lasts 60 to 14400 seconds');
      const taskId = checkedId(input.taskId);
      const day = localDate(now, zone);
      next = {
        ...next,
        state: 'running',
        task_id: taskId,
        day,
        area: checkedArea(input.area),
        target_seconds: target ?? null,
        started_at: now,
        segment_start: now,
        saved_seconds: 0,
        finished_task_id: '',
        finished_seconds: 0,
      };
      // The session holds a place on its day, so its record always fits when it ends.
      checks.push(
        {
          sql: `(SELECT count(*) FROM focus_entries WHERE day=? AND deleted_at IS NULL)<${String(DAY_ENTRIES)}`,
          values: [day],
          message: `Today already has ${String(DAY_ENTRIES)} time records.`,
        },
        {
          sql: 'EXISTS(SELECT 1 FROM tasks WHERE id=? AND completed=0 AND deleted_at IS NULL)',
          values: [taskId],
          message: 'Only an open step can be timed.',
        },
      );
      break;
    }
    case Action.PAUSE:
      if (old.state !== 'running') precondition('The timer is not running.');
      next = { ...next, state: 'paused', saved_seconds: elapsed(old, now), segment_start: null };
      break;
    case Action.RESUME:
      if (old.state !== 'paused') precondition('The timer is not paused.');
      next = { ...next, state: 'running', segment_start: now };
      break;
    case Action.STOP:
    case Action.FINISH: {
      if (old.state === 'idle') precondition('The timer is not running.');
      if (input.action === Action.FINISH && old.target_seconds === null) precondition('Only a pomodoro finishes.');
      const seconds = Math.floor(elapsed(old, now) / 60) * 60;
      next = { ...next, ...IDLE };
      if (input.action === Action.FINISH) next = { ...next, finished_task_id: old.task_id, finished_seconds: seconds };
      if (seconds >= 60)
        entry = {
          id: crypto.randomUUID(),
          task_id: old.task_id,
          day: old.day,
          seconds,
          started_at: old.started_at,
          source: 'timer',
          area: old.area,
          revision: 1,
        };
      break;
    }
    default:
      invalid('Unknown timer action');
  }
  const writes = [
    db
      .prepare(
        `UPDATE focus_timer SET state=?,task_id=?,day=?,area=?,target_seconds=?,started_at=?,segment_start=?,
          saved_seconds=?,finished_task_id=?,finished_seconds=?,revision=revision+1,updated_at=? WHERE id='timer'`,
      )
      .bind(
        next.state,
        next.task_id,
        next.day,
        next.area,
        next.target_seconds,
        next.started_at,
        next.segment_start,
        next.saved_seconds,
        next.finished_task_id,
        next.finished_seconds,
        now,
      ),
  ];
  if (entry)
    writes.push(
      db
        .prepare(
          `INSERT INTO focus_entries(id,task_id,day,seconds,started_at,source,area,created_at,updated_at)
          VALUES(?,?,?,?,?,'timer',?,?,?)`,
        )
        .bind(entry.id, entry.task_id, entry.day, entry.seconds, entry.started_at, entry.area, now, now),
    );
  const response = create(CommandFocusTimerResponseSchema, {
    timer: timerMessage(next),
    ...(entry ? { entry: entryMessage(entry) } : {}),
  });
  return commandResult(
    await commitChecked(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'focus_timer',
        id: 'timer',
        revision: old.revision,
        response: JSON.stringify(toWire(CommandFocusTimerResponseSchema, response)),
        now,
      },
      writes,
      checks,
    ),
  );
}
