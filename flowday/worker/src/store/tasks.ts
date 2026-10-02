/**
 * The tasks table: Todoist tasks (id = Todoist id) and FlowDay's own local tasks (id "local-<uuid>").
 *
 * Every write here changes only rows whose values differ, because D1 counts each written row plus one per index
 * entry the write touches (tasks keeps one secondary index, deleted_at, since migration 0003). Lists of ids travel
 * as one JSON parameter read with json_each(), never as one bound parameter per id (D1 allows 100 per statement).
 */
import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { TaskPriority, TaskRecord } from '../model.ts';
import { batchSql, type Db } from '../db.ts';
import { completedFlowTasks, flowTasks, tasks } from '../schema.ts';

type TaskRow = typeof tasks.$inferSelect;

/**
 * Rows per upsert statement: keeps each JSON parameter well below D1's limits. The sync applies at most this many
 * Todoist items per request (../sync.ts SYNC_CHUNK), so one sync request runs one upsert statement.
 */
export const UPSERT_CHUNK = 200;

export function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    todoistId: row.todoistId,
    title: row.title,
    description: row.description,
    projectName: row.projectName,
    projectColor: row.projectColor,
    priority: (row.priority >= 1 && row.priority <= 4 ? row.priority : 1) as TaskPriority,
    labels: parseLabels(row.labels),
    estimatedMins: row.estimatedMins,
    isCompleted: row.isCompleted === 1,
    completedAt: row.completedAt,
    dueDate: row.dueDate,
    createdAt: row.createdAt ?? new Date().toISOString(),
    deletedAt: row.deletedAt ?? null,
  };
}

function parseLabels(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((label): label is string => typeof label === 'string') : [];
  } catch {
    return [];
  }
}

export async function getAllTasks(db: Db): Promise<TaskRecord[]> {
  const rows = await db.select().from(tasks).where(isNull(tasks.deletedAt));
  return rows.map(mapTaskRow);
}

/**
 * Tasks deleted in FlowDay itself (or with the legacy NULL source). Sync deletions are left out: they are
 * restored in Todoist, and listing every Todoist deletion would flood the trash dialog.
 */
export async function getDeletedTasks(db: Db): Promise<TaskRecord[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(isNotNull(tasks.deletedAt), or(isNull(tasks.deletedSource), ne(tasks.deletedSource, 'sync'))));
  return rows.map(mapTaskRow);
}

/** A task row with where its deletion came from (`deleted_source`: 'local', 'sync' or null). */
export interface StoredTask {
  readonly task: TaskRecord;
  readonly deletedSource: string | null;
}

/** One task by ID, deleted or hidden ones included; null when there is none. */
export async function getTask(db: Db, taskId: string): Promise<StoredTask | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row === undefined ? null : { task: mapTaskRow(row), deletedSource: row.deletedSource };
}

/**
 * A page of the task list in rowid order (the order the tasks were first stored, which the list always had): the
 * tasks that are not deleted, and with `showDeleted` also those of the trash (getDeletedTasks' rule). `afterRowid`
 * is the last rowid of the previous page (0 for the first). Returns the page and the last rowid it read, or null
 * when nothing follows.
 */
export async function listTasks(
  db: Db,
  options: { afterRowid: number; limit: number; showDeleted: boolean },
): Promise<{ tasks: TaskRecord[]; nextRowid: number | null }> {
  const rowid = sql<number>`rowid`;
  const listed = options.showDeleted ? or(isNull(tasks.deletedAt), isNull(tasks.deletedSource), ne(tasks.deletedSource, 'sync')) : isNull(tasks.deletedAt);
  const rows = await db
    .select({ rowid, row: tasks })
    .from(tasks)
    .where(and(sql`rowid > ${options.afterRowid}`, listed))
    .orderBy(rowid)
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  return { tasks: page.map(({ row }) => mapTaskRow(row)), nextRowid: rows.length > options.limit ? (page.at(-1)?.rowid ?? null) : null };
}

/** Hides a task and takes it out of every flow, in one atomic batch. */
export async function softDeleteTask(db: Db, taskId: string, now: Date = new Date()): Promise<boolean> {
  const [updated] = await db.batch([
    db
      .update(tasks)
      .set({ deletedAt: now.toISOString(), deletedSource: 'local' })
      .where(and(eq(tasks.id, taskId), or(isNull(tasks.deletedAt), sql`${tasks.deletedSource} IS NOT 'local'`))),
    db.delete(flowTasks).where(eq(flowTasks.taskId, taskId)),
    db.delete(completedFlowTasks).where(eq(completedFlowTasks.taskId, taskId)),
  ]);
  return updated.meta.changes > 0;
}

export async function restoreTask(db: Db, taskId: string): Promise<boolean> {
  const result = await db
    .update(tasks)
    .set({ deletedAt: null, deletedSource: null })
    .where(and(eq(tasks.id, taskId), or(isNotNull(tasks.deletedAt), isNotNull(tasks.deletedSource))));
  return result.meta.changes > 0;
}

export async function updateTaskEstimate(db: Db, taskId: string, estimatedMins: number | null): Promise<void> {
  await db
    .update(tasks)
    .set({ estimatedMins })
    .where(and(eq(tasks.id, taskId), sql`${tasks.estimatedMins} IS NOT ${estimatedMins}`));
}

export async function updateTaskTitle(db: Db, taskId: string, title: string): Promise<void> {
  await db.update(tasks).set({ title }).where(and(eq(tasks.id, taskId), ne(tasks.title, title)));
}

export interface LocalTaskInput {
  title: string;
  priority?: number | undefined;
  dueDate?: string | undefined;
  estimatedMins?: number | undefined;
  labels?: string[] | undefined;
  description?: string | undefined;
}

/**
 * Creates a local task with the ID `id` (`local-<UUID>`); a task with that ID already there (a repeated request) is
 * left as it is and answered instead (false). Three D1 row writes for a new task (the row, its primary key and the
 * deleted_at index entry), none for a repeat.
 */
export async function createLocalTask(db: Db, id: string, input: LocalTaskInput, now: Date = new Date()): Promise<{ task: TaskRecord; created: boolean }> {
  const createdAt = now.toISOString();
  const priority = (input.priority !== undefined && input.priority >= 1 && input.priority <= 4 ? input.priority : 1) as TaskPriority;
  const result = await db
    .insert(tasks)
    .values({
      id,
      todoistId: null,
      title: input.title,
      description: input.description ?? null,
      projectName: null,
      projectColor: null,
      priority,
      labels: JSON.stringify(input.labels ?? []),
      estimatedMins: input.estimatedMins ?? null,
      isCompleted: 0,
      completedAt: null,
      dueDate: input.dueDate ?? null,
      createdAt,
      syncedAt: null,
      deletedAt: null,
      deletedSource: null,
      todoistProjectId: null,
    })
    .onConflictDoNothing();
  if (result.meta.changes === 0) {
    const stored = await getTask(db, id);
    if (stored !== null) return { task: stored.task, created: false };
  }
  return {
    task: {
      id,
      todoistId: null,
      title: input.title,
      description: input.description ?? null,
      projectName: null,
      projectColor: null,
      priority,
      labels: input.labels ?? [],
      estimatedMins: input.estimatedMins ?? null,
      isCompleted: false,
      completedAt: null,
      dueDate: input.dueDate ?? null,
      createdAt,
      deletedAt: null,
    },
    created: true,
  };
}

/** Persisted tasks with these ids, deleted ones included (any number of ids: one JSON parameter). */
export async function getTasksByIds(db: Db, ids: readonly string[]): Promise<TaskRecord[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(tasks)
    .where(sql`${tasks.id} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`);
  return rows.map(mapTaskRow);
}

// ---- the diff upsert shared by the Todoist sync, the E2E seed and the tests ----------------------------------

/** One task as the upsert reads it from the JSON parameter (snake_case keys, SQLite values). */
export interface TaskUpsertRow {
  id: string;
  todoist_id: string | null;
  title: string;
  description: string | null;
  project_name: string | null;
  project_color: string | null;
  priority: number;
  /** JSON text of the label list, exactly as stored. */
  labels: string;
  /** null keeps the local estimate (Todoist has no duration); a number replaces it. */
  estimated_mins: number | null;
  is_completed: 0 | 1;
  completed_at: string | null;
  due_date: string | null;
  created_at: string | null;
  todoist_project_id: string | null;
}

export function taskToUpsertRow(task: TaskRecord, todoistProjectId: string | null = null): TaskUpsertRow {
  return {
    id: task.id,
    todoist_id: task.todoistId,
    title: task.title,
    description: task.description,
    project_name: task.projectName,
    project_color: task.projectColor,
    priority: task.priority,
    labels: JSON.stringify(task.labels),
    estimated_mins: task.estimatedMins,
    is_completed: task.isCompleted ? 1 : 0,
    completed_at: task.completedAt,
    due_date: task.dueDate,
    created_at: task.createdAt,
    todoist_project_id: todoistProjectId,
  };
}

/** Columns the upsert compares and sets. None is indexed, so changing any of them costs one D1 row write. */
const PLAIN_COLUMNS = [
  'todoist_id',
  'title',
  'description',
  'project_name',
  'project_color',
  'priority',
  'labels',
  'is_completed',
  'completed_at',
  'due_date',
  'todoist_project_id',
] as const;

/**
 * The upsert of `rows` as statements for one batch. Only rows whose values differ are written, and the only
 * indexed column, deleted_at, is never in the upsert's SET list: SQLite rewrites an index entry whenever its column
 * is assigned, even to the same value, and D1 counts each index entry written as one more row. So:
 * 1. INSERT … SELECT FROM json_each(rows) ON CONFLICT DO UPDATE SET <the plain columns> WHERE <one of them differs>
 *    (chunks of UPSERT_CHUNK rows). New rows are inserted whole.
 * 2. Restores the rows a sync had hidden (deleted_source 'sync'); a task deleted in FlowDay ('local') stays deleted.
 * A row with no difference is not written at all (0 rows); a changed row costs 1. A Todoist task without a duration
 * (estimated_mins null) keeps the estimate set in FlowDay. synced_at records when statement 1 last changed the row.
 */
export function upsertStatements(rows: readonly TaskUpsertRow[], syncedAt: string): SQL[] {
  if (rows.length === 0) return [];
  const pick = (column: string) => sql.raw(`json_extract(value, '$.${column}')`);
  const differs = sql.raw(
    [
      ...PLAIN_COLUMNS.map((column) => `tasks.${column} IS NOT excluded.${column}`),
      '(excluded.estimated_mins IS NOT NULL AND tasks.estimated_mins IS NOT excluded.estimated_mins)',
    ].join(' OR '),
  );
  const assign = sql.raw(PLAIN_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', '));
  const out: SQL[] = [];
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
    const json = JSON.stringify(rows.slice(start, start + UPSERT_CHUNK));
    out.push(sql`INSERT INTO tasks (id, todoist_id, title, description, project_name, project_color, priority, labels,
        estimated_mins, is_completed, completed_at, due_date, created_at, synced_at, todoist_project_id)
      SELECT ${pick('id')}, ${pick('todoist_id')}, ${pick('title')}, ${pick('description')}, ${pick('project_name')},
        ${pick('project_color')}, ${pick('priority')}, ${pick('labels')}, ${pick('estimated_mins')},
        ${pick('is_completed')}, ${pick('completed_at')}, ${pick('due_date')}, ${pick('created_at')}, ${syncedAt},
        ${pick('todoist_project_id')}
      FROM json_each(${json}) WHERE true
      ON CONFLICT(id) DO UPDATE SET ${assign},
        estimated_mins = COALESCE(excluded.estimated_mins, tasks.estimated_mins), synced_at = excluded.synced_at
      WHERE ${differs}`);
  }
  out.push(sql`UPDATE tasks SET deleted_at = NULL, deleted_source = NULL
    WHERE deleted_source = 'sync' AND id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))}))`);
  return out;
}

/**
 * Hides (deleted_source 'sync') the visible Todoist tasks with these ids: completed or deleted in Todoist. A
 * Todoist task's id is its Todoist id, so the primary key finds it.
 */
export function hideStatement(ids: readonly string[], now: string): SQL {
  return sql`UPDATE tasks SET deleted_at = ${now}, deleted_source = 'sync'
    WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      AND deleted_at IS NULL AND todoist_id IS NOT NULL`;
}

/**
 * After a full sync: hides every visible Todoist task that is not in the full list (`activeIds`). These come back
 * by themselves through the upsert when Todoist lists them again.
 */
export function orphanStatement(activeIds: readonly string[], now: string): SQL {
  return sql`UPDATE tasks SET deleted_at = ${now}, deleted_source = 'sync'
    WHERE deleted_at IS NULL AND todoist_id IS NOT NULL
      AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(activeIds)}))`;
}

/** Hides the visible tasks of Todoist projects that were archived or deleted. */
export function hideProjectsStatement(projectIds: readonly string[], now: string): SQL {
  return sql`UPDATE tasks SET deleted_at = ${now}, deleted_source = 'sync'
    WHERE deleted_at IS NULL AND todoist_id IS NOT NULL
      AND todoist_project_id IN (SELECT value FROM json_each(${JSON.stringify(projectIds)}))`;
}

/** Renames or recolours the tasks of changed projects (only the rows whose name or colour differ). */
export function projectStatement(projects: readonly { id: string; name: string; color: string }[]): SQL {
  return sql`UPDATE tasks SET project_name = p.name, project_color = p.color
    FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.name') AS name,
            json_extract(value, '$.color') AS color
          FROM json_each(${JSON.stringify(projects)})) AS p
    WHERE tasks.todoist_project_id = p.id
      AND (tasks.project_name IS NOT p.name OR tasks.project_color IS NOT p.color)`;
}

/** Upserts these tasks (the diff upsert above) in one batch; returns the number of rows inserted or changed. */
export async function upsertTasks(db: Db, list: readonly TaskRecord[], now: Date = new Date()): Promise<number> {
  const statements = upsertStatements(list.map((task) => taskToUpsertRow(task)), now.toISOString());
  return runStatements(db, statements);
}

/** Hides every visible Todoist task not listed in `activeIds`; returns the number of rows hidden. */
export async function markOrphanedTodoistTasksDeleted(db: Db, activeIds: readonly string[], now: Date = new Date()): Promise<number> {
  return runStatements(db, [orphanStatement(activeIds, now.toISOString())]);
}

/** Runs the statements as one atomic batch; returns the sum of their changes. */
export async function runStatements(db: Db, statements: readonly SQL[]): Promise<number> {
  const results = await batchSql(db, statements);
  return results.reduce((sum, result) => sum + result.meta.changes, 0);
}
