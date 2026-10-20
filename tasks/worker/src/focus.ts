/**
 * Focus day queues (proto/tasks/ui/v1/focus.proto): ListFocusDays reads up to a week, MoveFocusStep adds, removes,
 * reorders or moves one step in one batch. The bounds below keep every read one bounded answer: a day holds at most
 * DAY_STEPS live queue rows (open or done) and DAY_ENTRIES live records, an active timer session holding one place.
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import {
  FocusDaySchema,
  FocusEntry_Source,
  FocusEntrySchema,
  FocusTaskSchema,
  type FocusDay,
  type FocusEntry,
} from '@ziyixi/proto/tasks/ui/v1/focus_pb';
import {
  ListFocusDaysResponseSchema,
  MoveFocusStepResponseSchema,
  type ListFocusDaysRequest,
  type MoveFocusStepRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { addDays, daysBetween, localDate, validDate } from '@ziyixi/task-dates';
import { invalid, missing, precondition, storage } from './errors.ts';
import { checkedId } from './model.ts';
import { commit, fingerprint, replay } from './receipts.ts';

export const DAY_STEPS = 30;
export const DAY_ENTRIES = 40;
/** Rows a read statement may return; the caps keep a week at 210 queue rows, 280 records and 490 tasks. */
const MAX_ROWS = 500;
const MOVED = 'This step has moved. Refresh and try again.';
const FULL = `This day already has ${String(DAY_STEPS)} steps.`;
const OPEN_ONLY = 'Only an open step can be planned.';

export interface EntryRow {
  id: string;
  task_id: string;
  day: string;
  seconds: number;
  started_at: number | null;
  source: string;
  area: string;
  revision: number;
}
interface QueueRow {
  day: string;
  task_id: string;
  position: number;
  done_at: number | null;
  /** The task's own state; null when the task is deleted (it then leaves every queue). */
  completed: number | null;
}
interface FocusTaskRow {
  id: string;
  title: string;
  parent_id: string;
  parent_title: string;
  duration_minutes: number;
  completed: number;
}

export function checkedDay(value: string, field: string): string {
  if (!validDate(value)) invalid(`${field} must be a YYYY-MM-DD day`);
  return value;
}
export function checkedArea(value: string): string {
  if (value !== '' && value !== 'work' && value !== 'personal') invalid('Area must be empty, work or personal');
  return value;
}
export function entryMessage(row: EntryRow): FocusEntry {
  return create(FocusEntrySchema, {
    name: `focusEntries/${row.id}`,
    taskId: row.task_id,
    day: row.day,
    seconds: row.seconds,
    ...(row.started_at === null ? {} : { startTime: timestampFromMs(row.started_at) }),
    source: row.source === 'timer' ? FocusEntry_Source.TIMER : FocusEntry_Source.MANUAL,
    area: row.area,
    etag: String(row.revision),
  });
}
/** A day's open steps and its done ones, in queue order; steps of deleted tasks are on neither list. */
function dayMessage(day: string, rows: readonly QueueRow[]): FocusDay {
  const live = rows.filter((row) => row.completed !== null);
  return create(FocusDaySchema, {
    day,
    taskIds: live.filter((row) => row.done_at === null && row.completed === 0).map((row) => row.task_id),
    doneTaskIds: live.filter((row) => row.done_at !== null).map((row) => row.task_id),
  });
}

/** A condition the write's batch checks before its writes, and the refusal it means when it does not hold. */
export interface Check {
  sql: string;
  values: unknown[];
  message: string;
}
/**
 * commit() with conditions its revision guard cannot express. They are checked inside the same batch, so a failed
 * one writes nothing; after a failure each is read again, and the first that does not hold is the refusal.
 */
export async function commitChecked(
  db: D1Database,
  input: Parameters<typeof commit>[1],
  writes: D1PreparedStatement[],
  checks: readonly Check[],
): Promise<string> {
  if (!checks.length) return commit(db, input, writes);
  const guard = db
    .prepare(
      `UPDATE requests SET revision_guard=CASE WHEN ${checks.map((check) => `(${check.sql})`).join(' AND ')} THEN 1 ELSE 0 END WHERE id=?`,
    )
    .bind(...checks.flatMap((check) => check.values), input.requestId);
  try {
    return await commit(db, input, [guard, ...writes]);
  } catch (error) {
    for (const check of checks) {
      const row = await storage(() =>
        db
          .prepare(`SELECT (${check.sql}) AS ok`)
          .bind(...check.values)
          .first<{ ok: number }>(),
      );
      if (!row?.ok) precondition(check.message);
    }
    throw error;
  }
}

export async function listFocusDays(db: D1Database, input: ListFocusDaysRequest, zone: string, now: number) {
  const start = checkedDay(input.startDay, 'start_day');
  const end = checkedDay(input.endDay, 'end_day');
  const span = daysBetween(start, end);
  if (span < 0 || span > 6) invalid('Read 1 to 7 days');
  const range = [start, end];
  const [queue, entries, tasks] = await storage(() =>
    db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT s.day,s.task_id,s.position,s.done_at,t.completed FROM day_steps s JOIN tasks t ON t.id=s.task_id
          WHERE s.day>=? AND s.day<=? AND s.deleted_at IS NULL AND t.deleted_at IS NULL
          ORDER BY s.day,s.position LIMIT ${String(MAX_ROWS + 1)}`,
        )
        .bind(...range),
      db
        .prepare(
          `SELECT id,task_id,day,seconds,started_at,source,area,revision FROM focus_entries
          WHERE day>=? AND day<=? AND deleted_at IS NULL ORDER BY day,COALESCE(started_at,created_at),id
          LIMIT ${String(MAX_ROWS + 1)}`,
        )
        .bind(...range),
      // Every task a queue or a record names; a deleted task only through its records, which stay.
      db
        .prepare(
          `WITH named(id) AS (
            SELECT s.task_id FROM day_steps s JOIN tasks q ON q.id=s.task_id AND q.deleted_at IS NULL
              WHERE s.day>=? AND s.day<=? AND s.deleted_at IS NULL
            UNION SELECT task_id FROM focus_entries WHERE day>=? AND day<=? AND deleted_at IS NULL)
          SELECT t.id,t.title,t.parent_id,COALESCE(p.title,'') AS parent_title,t.duration_minutes,t.completed
          FROM named n JOIN tasks t ON t.id=n.id LEFT JOIN tasks p ON p.id=t.parent_id LIMIT ${String(MAX_ROWS + 1)}`,
        )
        .bind(...range, ...range),
    ]),
  );
  const results = [queue, entries, tasks].map((result) => result?.results ?? []);
  if (results.some((rows) => rows.length > MAX_ROWS)) precondition('Too many Focus rows in this range');
  const [queueRows, entryRows, taskRows] = results as unknown as [QueueRow[], EntryRow[], FocusTaskRow[]];
  const days = Array.from({ length: span + 1 }, (_, index) => addDays(start, index));
  return create(ListFocusDaysResponseSchema, {
    days: days.map((day) =>
      dayMessage(
        day,
        queueRows.filter((row) => row.day === day),
      ),
    ),
    entries: entryRows.map(entryMessage),
    tasks: taskRows.map((row) =>
      create(FocusTaskSchema, {
        taskId: row.id,
        title: row.title,
        parentId: row.parent_id,
        parentTitle: row.parent_title,
        durationMinutes: row.duration_minutes,
        completed: row.completed === 1,
      }),
    ),
    today: localDate(now, zone),
  });
}

function moveResult(text: string) {
  return fromWire(MoveFocusStepResponseSchema, JSON.parse(text)).message;
}
/**
 * One step's move in one batch. No source adds it, no destination removes it, the same day reorders it and two days
 * move it. The new position is the midpoint before `before_task_id`, or last; a gap too small to halve renumbers
 * the destination day 1..n in the same batch. The answer is built from the rows read, and the receipt freezes it.
 */
export async function moveFocusStep(db: D1Database, input: MoveFocusStepRequest, now: number) {
  const hash = await fingerprint('moveFocusStep', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return moveResult(previous);
  const taskId = checkedId(input.taskId);
  const source = input.sourceDay && checkedDay(input.sourceDay, 'source_day');
  const destination = input.destinationDay && checkedDay(input.destinationDay, 'destination_day');
  if (!source && !destination) invalid('Name a source or a destination day');
  const before = input.beforeTaskId && checkedId(input.beforeTaskId);
  if (before && (!destination || before === taskId)) invalid('before_task_id needs a destination day and another step');
  const [taskResult, rowsResult] = await storage(() =>
    db.batch<Record<string, unknown>>([
      db.prepare('SELECT completed FROM tasks WHERE id=? AND deleted_at IS NULL').bind(taskId),
      db
        .prepare(
          `SELECT s.day,s.task_id,s.position,s.done_at,t.completed FROM day_steps s
          LEFT JOIN tasks t ON t.id=s.task_id AND t.deleted_at IS NULL
          WHERE s.day IN (?,?) AND s.deleted_at IS NULL ORDER BY s.day,s.position`,
        )
        .bind(source || destination, destination || source),
    ]),
  );
  const task = taskResult?.results[0] as { completed: number } | undefined;
  if (!task) missing();
  if (destination && task.completed) precondition(OPEN_ONLY);
  const rows = (rowsResult?.results ?? []) as unknown as QueueRow[];
  if (source && !rows.some((row) => row.day === source && row.task_id === taskId)) precondition(MOVED);
  const writes: D1PreparedStatement[] = [];
  const checks: Check[] = [];
  const after = new Map<string, QueueRow[]>();
  if (source)
    after.set(
      source,
      rows.filter((row) => row.day === source && row.task_id !== taskId),
    );
  if (source && source !== destination)
    writes.push(
      db
        .prepare('UPDATE day_steps SET deleted_at=?,updated_at=? WHERE day=? AND task_id=? AND deleted_at IS NULL')
        .bind(now, now, source, taskId),
    );
  if (destination) {
    const queue = rows.filter((row) => row.day === destination && row.task_id !== taskId);
    if (queue.length >= DAY_STEPS) precondition(FULL);
    const index = before ? queue.findIndex((row) => row.task_id === before) : queue.length;
    if (index < 0) precondition(MOVED);
    const next = queue[index]?.position;
    const last = queue[index - 1]?.position ?? (next === undefined ? 0 : next - 1);
    const moved: QueueRow = { day: destination, task_id: taskId, position: 0, done_at: null, completed: 0 };
    const ordered = [...queue.slice(0, index), moved, ...queue.slice(index)];
    if (next === undefined) moved.position = last + 1;
    else if (next - last >= 1e-6) moved.position = (last + next) / 2;
    else {
      ordered.forEach((row, place) => {
        row.position = place + 1;
      });
      writes.push(
        db
          .prepare(
            `UPDATE day_steps SET position=j.value->>'position',updated_at=? FROM json_each(?) j
            WHERE day_steps.day=? AND day_steps.task_id=j.value->>'task_id' AND day_steps.deleted_at IS NULL`,
          )
          .bind(
            now,
            JSON.stringify(queue.map((row) => ({ task_id: row.task_id, position: row.position }))),
            destination,
          ),
      );
    }
    writes.push(
      db
        .prepare(
          `INSERT INTO day_steps(day,task_id,position,created_at,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(day,task_id) DO UPDATE SET position=excluded.position,done_at=NULL,deleted_at=NULL,
            updated_at=excluded.updated_at`,
        )
        .bind(destination, taskId, moved.position, now, now),
    );
    after.set(destination, ordered);
    // Another write may have filled the day or completed the step since the read.
    checks.push(
      {
        sql: `(SELECT count(*) FROM day_steps WHERE day=? AND task_id<>? AND deleted_at IS NULL)<${String(DAY_STEPS)}`,
        values: [destination, taskId],
        message: FULL,
      },
      { sql: 'EXISTS(SELECT 1 FROM tasks WHERE id=? AND completed=0)', values: [taskId], message: OPEN_ONLY },
    );
  }
  const days = [...after].map(([day, queue]) => dayMessage(day, queue));
  const response = JSON.stringify(toWire(MoveFocusStepResponseSchema, create(MoveFocusStepResponseSchema, { days })));
  return moveResult(
    await commitChecked(
      db,
      { requestId: input.requestId, hash, table: 'tasks', id: taskId, revision: 'live', response, now },
      writes,
      checks,
    ),
  );
}
