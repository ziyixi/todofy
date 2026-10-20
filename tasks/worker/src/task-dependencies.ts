/**
 * UpdateTask's `dependencies` path: one read of every stored dependency (at most MAX_ALL_DEPENDENCIES) and of the new
 * prerequisites, the rules in planning.ts, then writes and checks for the update's own batch. The checks run inside
 * that batch (focus.ts commitChecked), so two tabs cannot build a cycle, or pass the limit, between them.
 */
import { invalid, precondition, storage } from './errors.ts';
import type { Check } from './focus.ts';
import { checkedId, prerequisiteDone, type DependencyRow, type TaskRow } from './model.ts';
import { dependencyChange, MAX_ALL_DEPENDENCIES, type StoredEdge } from './planning.ts';

/** Dependencies that still hold back their task, for a check's recursive query. */
const holding = `holding(task_id,prerequisite_id) AS (SELECT d.task_id,d.prerequisite_id FROM task_dependencies d
  JOIN tasks p ON p.id=d.prerequisite_id WHERE d.deleted_at IS NULL AND p.deleted_at IS NULL AND NOT ${prerequisiteDone})`;
const openTask = 'p.deleted_at IS NULL AND p.completed=0 AND p.project_archived=0';

export async function dependencyUpdate(
  db: D1Database,
  task: TaskRow,
  prerequisites: readonly string[],
  now: number,
): Promise<{ writes: D1PreparedStatement[]; checks: Check[]; dependencies: string }> {
  const wanted = [...new Set(prerequisites.map(checkedId))];
  if (wanted.length > MAX_ALL_DEPENDENCIES) invalid('Too many dependencies');
  const [stored, found] = await storage(() =>
    db.batch<Record<string, unknown>>([
      db.prepare(
        `SELECT d.task_id,d.prerequisite_id,NOT ${prerequisiteDone} AS holding FROM task_dependencies d
        JOIN tasks p ON p.id=d.prerequisite_id WHERE d.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY d.created_at,d.rowid LIMIT ${String(MAX_ALL_DEPENDENCIES + 1)}`,
      ),
      db
        .prepare(`SELECT p.id,p.title FROM json_each(?) j JOIN tasks p ON p.id=j.value WHERE ${openTask}`)
        .bind(JSON.stringify(wanted)),
    ]),
  );
  const edges: StoredEdge[] = (stored?.results ?? []).map((row) => ({
    task: String(row.task_id),
    prerequisite: String(row.prerequisite_id),
    holding: Boolean(row.holding),
  }));
  const { removed, added } = dependencyChange(edges, task.id, wanted);
  const titles = new Map((found?.results ?? []).map((row) => [String(row.id), String(row.title)]));
  if (added.some((id) => !titles.has(id))) precondition('A task can wait only for an open task');
  if (added.length && task.completed) precondition('A completed task waits for nothing');
  const kept = (JSON.parse(task.dependencies ?? '[]') as DependencyRow[]).filter(
    (row) => !removed.includes(row.prerequisite_id),
  );
  const writes = [
    db
      .prepare(
        `UPDATE task_dependencies SET deleted_at=?,updated_at=? WHERE task_id=? AND deleted_at IS NULL
        AND prerequisite_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(now, now, task.id, JSON.stringify(removed)),
    // A recurring prerequisite is done after its next completion, so its count now is the baseline.
    db
      .prepare(
        `INSERT INTO task_dependencies(task_id,prerequisite_id,baseline_count,created_at,updated_at)
        SELECT ?,p.id,p.completed_base_count+(SELECT count(*) FROM completions h WHERE h.task_id=p.id AND h.imported=0),?,?
        FROM json_each(?) j JOIN tasks p ON p.id=j.value WHERE true ORDER BY j.key
        ON CONFLICT(task_id,prerequisite_id) DO UPDATE SET baseline_count=excluded.baseline_count,
          created_at=excluded.created_at,updated_at=excluded.updated_at,deleted_at=NULL`,
      )
      .bind(task.id, now, now, JSON.stringify(added)),
  ];
  // Only a new prerequisite can close a cycle or pass a limit.
  const checks: Check[] = !added.length
    ? []
    : [
        {
          sql: `(SELECT count(*) FROM json_each(?) j JOIN tasks p ON p.id=j.value WHERE ${openTask})=?`,
          values: [JSON.stringify(added), added.length],
          message: 'A task can wait only for an open task',
        },
        {
          sql: `NOT EXISTS(WITH RECURSIVE ${holding}, up(id) AS (SELECT value FROM json_each(?)
        UNION SELECT h.prerequisite_id FROM holding h JOIN up ON h.task_id=up.id) SELECT 1 FROM up WHERE id=?)`,
          values: [JSON.stringify(added), task.id],
          message: 'A task cannot wait for a task that waits for it',
        },
        {
          sql: '(SELECT count(*) FROM task_dependencies WHERE deleted_at IS NULL)<=?',
          values: [MAX_ALL_DEPENDENCIES - added.length + removed.length],
          message: `There are at most ${String(MAX_ALL_DEPENDENCIES)} dependencies`,
        },
      ];
  const dependencies = [
    ...kept,
    ...added.map((id) => ({ prerequisite_id: id, title: titles.get(id) ?? '', done: false })),
  ];
  return { writes, checks, dependencies: JSON.stringify(dependencies) };
}
