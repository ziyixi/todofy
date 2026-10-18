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
import { nextOccurrence } from '@ziyixi/task-dates';
import { checkedId, resourceId, taskColumns, taskMessage, type TaskRow } from './model.ts';
import { conflict, invalid, precondition, storage } from './errors.ts';
import { commit, fingerprint, replay } from './receipts.ts';
import { getTask } from './task-read.ts';
import { taskValues, validateTask } from './task-validation.ts';
import { moveTaskDescendants } from './task-moves.ts';

function result(text: string) {
  return fromWire(TaskSchema, JSON.parse(text)).message;
}
function serialize(row: TaskRow): string {
  return JSON.stringify(toWire(TaskSchema, taskMessage(row)));
}
function checkEtag(row: TaskRow, etag: string): void {
  if (!etag) invalid('An etag is required');
  if (String(row.revision) !== etag) conflict();
}
function taskFingerprint(method: string, input: CreateTaskRequest | UpdateTaskRequest): Promise<string> {
  // Keep receipts created before kind and effort existed replayable with their original input shape.
  const task = input.task;
  const hashInput = task
    ? {
        ...input,
        task: Object.fromEntries(
          Object.entries(task).filter(([key, value]) => !((key === 'kind' || key === 'effort') && value === '')),
        ),
      }
    : input;
  return fingerprint(method, hashInput);
}
const subtree = `WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE id=? AND deleted_at IS NULL UNION ALL SELECT t.id FROM tasks t JOIN descendants d ON t.parent_id=d.id WHERE t.deleted_at IS NULL)`;

export async function createTask(db: D1Database, input: CreateTaskRequest, now: number) {
  const hash = await taskFingerprint('createTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
  if (!input.task) invalid();
  const id = input.taskId ? checkedId(input.taskId) : crypto.randomUUID();
  const row: TaskRow = {
    ...taskValues(input.task),
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
  await validateTask(db, row);
  const columns = ['id', ...taskColumns, 'created_at', 'updated_at'];
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
        response: serialize(row),
        now,
      },
      writes,
    );
  if (!append) return result(response);
  const stored = await replay(db, input.requestId, hash);
  if (stored === null) throw new Error('Committed task receipt is missing');
  return result(stored);
}
export async function updateTask(db: D1Database, input: UpdateTaskRequest, now: number) {
  const hash = await taskFingerprint('updateTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
  if (!input.task) invalid();
  const id = resourceId(input.task.name, 'tasks');
  const old = await getTask(db, id);
  checkEtag(old, input.etag);
  if (!input.updateMask?.paths.length) invalid('An explicit update_mask is required');
  const requested = updatePaths(input.updateMask);
  const paths = requested === '*' ? taskColumns : requested;
  const values = taskValues(input.task);
  const updated = { ...old };
  for (const field of paths) {
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
  const row = { ...updated, revision: old.revision + 1, updated_at: now };
  await validateTask(db, row);
  row.project_archived = 0;
  const writes = [
    db
      .prepare(
        `UPDATE tasks SET ${taskColumns.map((c) => `${c}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=?`,
      )
      .bind(...taskColumns.map((c) => row[c]), now, id),
  ];
  if (row.project_id !== old.project_id) {
    writes.push(...await moveTaskDescendants(db, id, row.project_id, now));
  }
  return result(
    await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id,
        revision: old.revision,
        response: serialize(row),
        now,
      },
      writes,
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
  const old = await getTask(db, id);
  checkEtag(old, input.etag);
  if (old.completed) precondition('Task is already complete');
  const recurringChild = await storage(() =>
    db
      .prepare(
        `${subtree} SELECT id FROM tasks WHERE id IN (SELECT id FROM descendants) AND id<>? AND recurrence<>'' AND completed=0 LIMIT 1`,
      )
      .bind(id, id)
      .first(),
  );
  if (recurringChild) precondition('Complete recurring subtasks separately before completing their parent');
  let dates = {
    dueDate: old.due_date,
    dueDatetime: old.due_datetime,
    dueTimezone: old.due_timezone,
    recurrence: old.recurrence,
  };
  if (old.recurrence) {
    try {
      dates = nextOccurrence(dates, now, zone);
    } catch {
      precondition('Recurring date needs an explicit supported rule or a valid next time');
    }
  }
  const row: TaskRow = {
    ...old,
    due_date: dates.dueDate,
    due_datetime: dates.dueDatetime,
    completed: old.recurrence ? 0 : 1,
    completed_at: now,
    completed_count: (old.completed_count ?? 0) + 1,
    completed_child_count: old.child_count ?? 0,
    revision: old.revision + 1,
    updated_at: now,
  };
  const writes = [
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
    db
      .prepare(
        'UPDATE tasks SET completed=?,completed_at=?,due_date=?,due_datetime=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .bind(row.completed, now, row.due_date, row.due_datetime, now, id),
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
        response: serialize(row),
        now,
      },
      writes,
    ),
  );
}
export async function reopenTask(db: D1Database, input: ReopenTaskRequest, now: number) {
  const hash = await fingerprint('reopenTask', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return result(previous);
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
  const write = db
    .prepare('UPDATE tasks SET completed=0,completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?')
    .bind(now, id);
  return result(
    await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id,
        revision: old.revision,
        response: serialize(row),
        now,
      },
      [write],
    ),
  );
}
