/**
 * The tasks table: Todoist tasks (id = Todoist id) and FlowDay's own local tasks (id "local-<uuid>").
 *
 * Every write here changes only rows whose values differ, because D1 counts each written row plus one per index
 * the write touches (tasks has three: due_date, deleted_at, todoist_id). Lists of ids travel as one JSON
 * parameter read with json_each(), never as one bound parameter per id (D1 allows 100 per statement).
 */
import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Task, TaskPriority } from '../api-types.ts';
import { batchSql, type Db } from '../db.ts';
import { completedFlowTasks, flowTasks, tasks } from '../schema.ts';

type TaskRow = typeof tasks.$inferSelect;

/**
 * Rows per upsert statement: keeps each JSON parameter well below D1's limits and, with MAX_SYNC_ITEMS (5,000), a
 * full sync within D1's 50 queries per Worker invocation (25 upserts + 4 other task statements + 3 settings + 2).
 */
export const UPSERT_CHUNK = 200;

export function mapTaskRow(row: TaskRow): Task {
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

export async function getAllTasks(db: Db): Promise<Task[]> {
  const rows = await db.select().from(tasks).where(isNull(tasks.deletedAt));
  return rows.map(mapTaskRow);
}

/**
 * Tasks deleted in FlowDay itself (or with the legacy NULL source). Sync deletions are left out: they are
 * restored in Todoist, and listing every Todoist deletion would flood the trash dialog.
 */
export async function getDeletedTasks(db: Db): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(isNotNull(tasks.deletedAt), or(isNull(tasks.deletedSource), ne(tasks.deletedSource, 'sync'))));
  return rows.map(mapTaskRow);
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

export async function createLocalTask(db: Db, input: LocalTaskInput, now: Date = new Date()): Promise<Task> {
  const id = `local-${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const priority = (input.priority !== undefined && input.priority >= 1 && input.priority <= 4 ? input.priority : 1) as TaskPriority;
  await db.insert(tasks).values({
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
  });
  return {
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
  };
}

/** Persisted tasks with these ids, deleted ones included (any number of ids: one JSON parameter). */
export async function getTasksByIds(db: Db, ids: readonly string[]): Promise<Task[]> {
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

export function taskToUpsertRow(task: Task, todoistProjectId: string | null = null): TaskUpsertRow {
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

/** Columns without an index: changing one costs one D1 row write. */
const PLAIN_COLUMNS = [
  'title',
  'description',
  'project_name',
  'project_color',
  'priority',
  'labels',
  'is_completed',
  'completed_at',
  'todoist_project_id',
] as const;

/**
 * The upsert of `rows` as statements for one batch. Only rows (and, for indexed columns, only columns) whose values
 * differ are written: SQLite rewrites an index entry whenever its column appears in an UPDATE's SET list, even with
 * the same value, and D1 counts each index entry written as one more row. So:
 * 1. INSERT … SELECT FROM json_each(rows) ON CONFLICT DO UPDATE SET <unindexed columns> WHERE <one of them differs>
 *    (chunks of UPSERT_CHUNK rows). New rows are inserted whole.
 * 2. One UPDATE per indexed column (due_date, todoist_id) for exactly the rows where it differs.
 * 3. Restores the rows a sync had hidden (deleted_source 'sync'); a task deleted in FlowDay ('local') stays deleted.
 * A row with no difference is not written at all (0 rows). A Todoist task without a duration (estimated_mins null)
 * keeps the estimate set in FlowDay. synced_at records when statement 1 last changed the row.
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
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, description = excluded.description, project_name = excluded.project_name,
        project_color = excluded.project_color, priority = excluded.priority, labels = excluded.labels,
        estimated_mins = COALESCE(excluded.estimated_mins, tasks.estimated_mins), is_completed = excluded.is_completed,
        completed_at = excluded.completed_at, todoist_project_id = excluded.todoist_project_id,
        synced_at = excluded.synced_at
      WHERE ${differs}`);
  }
  const pairs = (column: 'due_date' | 'todoist_id') => JSON.stringify(rows.map((row) => [row.id, row[column]]));
  for (const column of ['due_date', 'todoist_id'] as const) {
    out.push(sql`UPDATE tasks SET ${sql.raw(column)} = j.v
      FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS v FROM json_each(${pairs(column)})) AS j
      WHERE tasks.id = j.id AND tasks.${sql.raw(column)} IS NOT j.v`);
  }
  out.push(sql`UPDATE tasks SET deleted_at = NULL, deleted_source = NULL
    WHERE deleted_source = 'sync' AND id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((row) => row.id))}))`);
  return out;
}

/** Hides (deleted_source 'sync') the visible Todoist tasks with these ids: completed or deleted in Todoist. */
export function hideStatement(ids: readonly string[], now: string): SQL {
  return sql`UPDATE tasks SET deleted_at = ${now}, deleted_source = 'sync'
    WHERE deleted_at IS NULL AND todoist_id IS NOT NULL
      AND todoist_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

/**
 * After a full sync: hides every visible Todoist task that is not in the full list (`activeIds`). These come back
 * by themselves through the upsert when Todoist lists them again.
 */
export function orphanStatement(activeIds: readonly string[], now: string): SQL {
  return sql`UPDATE tasks SET deleted_at = ${now}, deleted_source = 'sync'
    WHERE todoist_id IS NOT NULL AND deleted_at IS NULL
      AND todoist_id NOT IN (SELECT value FROM json_each(${JSON.stringify(activeIds)}))`;
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
export async function upsertTasks(db: Db, list: readonly Task[], now: Date = new Date()): Promise<number> {
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
