import { updatePaths } from '@ziyixi/proto/field-mask';
import { create } from '@ziyixi/proto/protobuf';
import { EmptySchema } from '@ziyixi/proto/protobuf/wkt';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  DeleteTaskRequest,
  CompleteTaskRequest,
  ReopenTaskRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { addDays, clampMonthEnd, daysBetween, localDate, nextOccurrence } from '@ziyixi/task-dates';
import { checkedId, resourceId, taskColumns, taskMessage, type TaskRow } from './model.ts';
import { conflict, invalid, precondition } from './errors.ts';
import { commit, fingerprint, replay } from './receipts.ts';
import { getTask } from './task-read.ts';
import { taskValues, validateTask } from './task-validation.ts';
import { moveTaskDescendants } from './task-moves.ts';
import { checkedDay, commitChecked, type Check } from './focus.ts';
import { COUNT_UP_SECONDS } from './focus-timer.ts';
import { plannedRow } from './planning.ts';
import { dependencyUpdate } from './task-dependencies.ts';

/** Every column a task write stores: the client's fields and the week a commitment is for. */
const storedColumns = [...taskColumns, 'committed_week'] as const;
/** The planning columns of a new task, before its own values. */
const unplanned = {
  stage: 'none',
  committed_week: '',
  area: 'unassigned',
  lead_days: 0,
  planning_flags: '[]',
  deadline: '',
  due_date: '',
};

function result(text: string) {
  return fromWire(TaskSchema, JSON.parse(text)).message;
}
function serialize(row: TaskRow, today: string): string {
  return JSON.stringify(toWire(TaskSchema, taskMessage(row, today)));
}
function checkEtag(row: TaskRow, etag: string): void {
  if (!etag) invalid('An etag is required');
  if (String(row.revision) !== etag) conflict();
}
const subtree = `WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL UNION ALL SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id=d.id WHERE t.deleted_at IS NULL)`;
/** The timer's session when it times the completed task or one of its descendants. */
const relatedTimer = `focus_timer WHERE id='timer' AND state<>'idle' AND task_id IN (SELECT id FROM descendants)`;

/**
 * A completion settles Focus in its own batch, with no extra read: a related session is saved as a record (when it
 * reaches a minute) and stops, and the subtree's steps queued on that session's day, else on `day`, are done.
 */
function settleFocus(db: D1Database, id: string, day: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `${subtree} INSERT INTO focus_entries(id,task_id,day,seconds,started_at,source,area,created_at,updated_at)
        SELECT ?,task_id,day,seconds,started_at,'timer',area,?,? FROM (SELECT task_id,day,started_at,area,
          CAST(MIN(saved_seconds+CASE WHEN state='running' THEN MAX(0,CAST((?-segment_start)/1000 AS INTEGER)) ELSE 0 END,
            COALESCE(target_seconds,${String(COUNT_UP_SECONDS)}))/60 AS INTEGER)*60 AS seconds
          FROM ${relatedTimer}) WHERE seconds>=60`,
      )
      .bind(id, crypto.randomUUID(), now, now, now),
    db
      .prepare(
        `${subtree} UPDATE day_steps SET done_at=?,updated_at=? WHERE task_id IN (SELECT id FROM descendants)
        AND done_at IS NULL AND deleted_at IS NULL AND day=COALESCE((SELECT day FROM ${relatedTimer}),?)`,
      )
      .bind(id, now, now, day),
    db
      .prepare(
        `${subtree} UPDATE focus_timer SET state='idle',task_id='',day='',area='',target_seconds=NULL,started_at=NULL,
        segment_start=NULL,saved_seconds=0,revision=revision+1,updated_at=? WHERE id='timer' AND state<>'idle'
        AND task_id IN (SELECT id FROM descendants)`,
      )
      .bind(id, now),
  ];
}

export async function createTask(db: D1Database, input: CreateTaskRequest, now: number, zone: string) {
  const hash = await fingerprint('createTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
  if (!input.task) invalid();
  if (input.task.dependencies.length) invalid('Dependencies are added by UpdateTask');
  const today = localDate(now, zone);
  const id = input.taskId ? checkedId(input.taskId) : crypto.randomUUID();
  const given = taskValues(input.task);
  const row: TaskRow = {
    ...plannedRow(unplanned, given, today, given.stage !== 'none'),
    id,
    revision: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    completed: 0,
    completed_at: null,
  };
  if (row.parent_id && !input.task.projectId) {
    const parent = await getTask(db, row.parent_id);
    row.project_id = parent.project_id;
    if (!row.section_id) row.section_id = parent.section_id;
  }
  row.recurrence = clampMonthEnd(row.recurrence, row.due_date);
  await validateTask(db, row);
  const columns = ['id', ...storedColumns, 'created_at', 'updated_at'];
  const append = input.task.sortOrder === undefined;
  const values = columns.flatMap((column) =>
    column === 'sort_order' && append
      ? [row.project_id, row.parent_id, row.section_id]
      : [row[column as keyof TaskRow]],
  );
  const placeholders = columns.map((column) =>
    column === 'sort_order' && append
      ? `(SELECT COALESCE(MAX(sort_order),0)+1 FROM tasks WHERE project_id=? AND parent_id=? AND section_id=? AND deleted_at IS NULL)`
      : '?',
  );
  const write = db
    .prepare(`INSERT INTO tasks(${columns.join(',')}) VALUES(${placeholders.join(',')})`)
    .bind(...values);
  const writes = [write];
  if (append) {
    // Append and freeze its actual position in the same transaction, including concurrent creates.
    writes.push(db.prepare(`UPDATE requests SET response=json_set(response,'$.sort_order',(SELECT sort_order FROM tasks WHERE id=?)) WHERE id=?`).bind(id, input.requestId));
  }
  const response = await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id,
        revision: null,
        response: serialize(row, today),
        now,
      },
      writes,
    );
  if (!append) return result(response);
  const stored = await replay(db, input.requestId, hash);
  if (stored === null) throw new Error('Committed task receipt is missing');
  return result(stored);
}
export async function updateTask(db: D1Database, input: UpdateTaskRequest, now: number, zone: string) {
  const hash = await fingerprint('updateTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
  if (!input.task) invalid();
  const today = localDate(now, zone);
  const id = resourceId(input.task.name, 'tasks');
  const old = await getTask(db, id);
  checkEtag(old, input.etag);
  if (!input.updateMask?.paths.length) invalid('An explicit update_mask is required');
  const requested = updatePaths(input.updateMask);
  const paths: readonly string[] = requested === '*' ? taskColumns : requested;
  const values = taskValues(input.task);
  const updated = { ...old };
  for (const field of paths) {
    if (field === 'dependencies') continue;
    if (!(taskColumns as readonly string[]).includes(field)) invalid('Unsupported update field');
    const column = field as (typeof taskColumns)[number];
    Object.assign(updated, { [column]: values[column] });
  }
  if (updated.parent_id !== old.parent_id && updated.parent_id && !paths.includes('project_id')) {
    const parent = await getTask(db, updated.parent_id);
    updated.project_id = parent.project_id;
    if (!paths.includes('section_id')) updated.section_id = parent.section_id;
  }
  if (updated.project_id !== old.project_id) {
    if (!paths.includes('section_id') && !updated.parent_id) updated.section_id = '';
    if (!paths.includes('parent_id')) updated.parent_id = '';
  }
  const row = { ...plannedRow(old, updated, today, paths.includes('stage')), revision: old.revision + 1, updated_at: now };
  row.recurrence = clampMonthEnd(row.recurrence, row.due_date);
  await validateTask(db, row, old);
  row.project_archived = 0;
  const writes = [
    db
      .prepare(
        `UPDATE tasks SET ${storedColumns.map((c) => `${c}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
      )
      .bind(...storedColumns.map((c) => row[c]), now, id),
  ];
  if (row.project_id !== old.project_id) {
    writes.push(...await moveTaskDescendants(db, id, row.project_id, now));
  }
  let checks: Check[] = [];
  if (paths.includes('dependencies')) {
    const change = await dependencyUpdate(
      db,
      old,
      input.task.dependencies.map((dependency) => dependency.prerequisiteId),
      now,
    );
    writes.push(...change.writes);
    checks = change.checks;
    row.dependencies = change.dependencies;
  }
  return result(
    await commitChecked(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id,
        revision: old.revision,
        response: serialize(row, today),
        now,
      },
      writes,
      checks,
    ),
  );
}
export async function deleteTask(db: D1Database, input: DeleteTaskRequest, now: number) {
  const hash = await fingerprint('deleteTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return create(EmptySchema);
  const id = resourceId(input.name, 'tasks');
  const old = await getTask(db, id);
  checkEtag(old, input.etag);
  await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'tasks',
      id,
      revision: old.revision,
      response: '{}',
      now,
    },
    [
      // First, while the subtree is still live: its queue rows leave every day, so they never fill a day's cap.
      db
        .prepare(
          `${subtree} UPDATE day_steps SET deleted_at=?,updated_at=? WHERE task_id IN (SELECT id FROM descendants) AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
      // So are the dependencies the subtree's tasks have or are waited for by.
      db
        .prepare(
          `${subtree} UPDATE task_dependencies SET deleted_at=?,updated_at=? WHERE task_id IN (SELECT id FROM descendants)
          AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
      db
        .prepare(
          `${subtree} UPDATE task_dependencies SET deleted_at=?,updated_at=? WHERE prerequisite_id IN
          (SELECT id FROM descendants) AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
      db
        .prepare(
          `${subtree} UPDATE tasks SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id IN (SELECT id FROM descendants)`,
        )
        .bind(id, now, now),
    ],
  );
  return create(EmptySchema);
}
export async function completeTask(db: D1Database, input: CompleteTaskRequest, now: number, zone: string) {
  const hash = await fingerprint('completeTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
  const id = resourceId(input.name, 'tasks');
  const today = localDate(now, zone);
  const focusDay = input.focusDay ? checkedDay(input.focusDay, 'focus_day') : today;
  const old = await getTask(db, id);
  checkEtag(old, input.etag);
  if (old.completed) precondition('Task is already complete');
  let row: TaskRow = {
    ...old,
    completed: 1,
    completed_at: now,
    completed_count: (old.completed_count ?? 0) + 1,
    completed_child_count: old.child_count ?? 0,
    revision: old.revision + 1,
    updated_at: now,
  };
  let writes: D1PreparedStatement[];
  if (old.recurrence) {
    // An imported month-end rule heals here, so this and every later occurrence keep the month's last day.
    const recurrence = clampMonthEnd(old.recurrence, old.due_date);
    let dates = { dueDate: old.due_date, dueDatetime: old.due_datetime, dueTimezone: old.due_timezone, recurrence };
    try {
      dates = nextOccurrence(dates, now, zone);
    } catch {
      precondition('Recurring date needs an explicit supported rule or a valid next time');
    }
    row = {
      ...row,
      completed: 0,
      recurrence,
      due_date: dates.dueDate,
      due_datetime: dates.dueDatetime,
      deadline: old.deadline && addDays(old.deadline, daysBetween(old.due_date, dates.dueDate)),
      completed_child_count: 0,
    };
    // One occurrence is recorded for the task alone; its subtasks and Steps reopen for the next cycle.
    writes = [
      db
        .prepare(
          `INSERT INTO completions(id,task_id,title,completed_at,due_date,project_id,task_created_at) SELECT ? || ':' || id,id,title,?,due_date,project_id,created_at FROM tasks WHERE id=?`,
        )
        .bind(input.requestId, now, id),
      db
        .prepare(
          `${subtree} UPDATE tasks SET completed=0,completed_at=NULL,revision=revision+1,updated_at=? WHERE id IN (SELECT id FROM descendants) AND id<>? AND completed=1`,
        )
        .bind(id, now, id),
    ];
  } else {
    // Every open descendant completes too. A recurring one ends its repetition with its parent.
    writes = [
      db
        .prepare(
          `${subtree} INSERT INTO completions(id,task_id,title,completed_at,due_date,project_id,task_created_at) SELECT ? || ':' || id,id,title,?,due_date,project_id,created_at FROM tasks WHERE id IN (SELECT id FROM descendants) AND completed=0`,
        )
        .bind(id, input.requestId, now),
      db
        .prepare(
          `${subtree} UPDATE tasks SET completed=1,completed_at=?,revision=revision+1,updated_at=? WHERE id IN (SELECT id FROM descendants) AND id<>? AND completed=0`,
        )
        .bind(id, now, now, id),
      // The completed tasks wait for nothing any more; a recurring one keeps its dependencies.
      db
        .prepare(
          `${subtree} UPDATE task_dependencies SET deleted_at=?,updated_at=? WHERE task_id IN (SELECT id FROM descendants)
          AND deleted_at IS NULL`,
        )
        .bind(id, now, now),
    ];
    row.dependencies = '[]';
  }
  writes.push(
    db
      .prepare(
        'UPDATE tasks SET completed=?,completed_at=?,due_date=?,due_datetime=?,deadline=?,recurrence=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .bind(row.completed, now, row.due_date, row.due_datetime, row.deadline, row.recurrence, now, id),
    ...settleFocus(db, id, focusDay, now),
  );
  return result(
    await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id,
        revision: old.revision,
        response: serialize(row, today),
        now,
      },
      writes,
    ),
  );
}
export async function reopenTask(db: D1Database, input: ReopenTaskRequest, now: number, zone: string) {
  const hash = await fingerprint('reopenTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
  const today = localDate(now, zone);
  const id = resourceId(input.name, 'tasks');
  const old = await getTask(db, id);
  checkEtag(old, input.etag);
  if (!old.completed) precondition('Task is already active');
  const row = {
    ...old,
    completed: 0,
    completed_at: null,
    revision: old.revision + 1,
    updated_at: now,
  };
  const ancestors = `WITH RECURSIVE ancestors(id,depth) AS (SELECT parent_id,1 FROM tasks WHERE id=? AND parent_id<>'' UNION ALL SELECT t.parent_id,a.depth+1 FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id<>'' AND a.depth<32)`;
  const writes = [
    // Queue rows this task's or an ancestor's completion marked done are open again; it reads completed_at first.
    db
      .prepare(
        `${ancestors} UPDATE day_steps SET done_at=NULL,updated_at=? WHERE deleted_at IS NULL
        AND done_at=(SELECT completed_at FROM tasks WHERE id=day_steps.task_id AND completed=1)
        AND (task_id=? OR task_id IN (SELECT id FROM ancestors))`,
      )
      .bind(id, now, id),
    db
      .prepare('UPDATE tasks SET completed=0,completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?')
      .bind(now, id),
    // A reopened child is active again, so its completed ancestors reopen with it.
    db
      .prepare(
        `${ancestors} UPDATE tasks SET completed=0,completed_at=NULL,revision=revision+1,updated_at=? WHERE id IN (SELECT id FROM ancestors) AND completed=1 AND deleted_at IS NULL`,
      )
      .bind(id, now),
  ];
  return result(
    await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id,
        revision: old.revision,
        response: serialize(row, today),
        now,
      },
      writes,
    ),
  );
}
