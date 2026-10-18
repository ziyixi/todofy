import { recurrenceRule, validDate, validTimezone, localDate } from '@ziyixi/task-dates';
import type { Task } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import type { TaskRow } from './model.ts';
import { checkedId } from './model.ts';
import { invalid, precondition, storage } from './errors.ts';

export function taskValues(
  task: Task,
): Omit<TaskRow, 'id' | 'revision' | 'created_at' | 'updated_at' | 'deleted_at' | 'completed' | 'completed_at'> {
  return {
    title: task.title.trim(),
    description: task.description,
    project_id: task.projectId,
    section_id: task.sectionId,
    parent_id: task.parentId,
    label_ids: JSON.stringify([...new Set(task.labelIds)]),
    priority: task.priority || 4,
    sort_order: task.sortOrder ?? 0,
    due_date: task.dueDate,
    due_datetime: task.dueDatetime,
    due_timezone: task.dueTimezone,
    deadline: task.deadline,
    duration_minutes: task.durationMinutes,
    recurrence: task.recurrence.trim(),
    kind: task.kind || 'task',
    effort: task.effort || '',
  };
}
export function validateTaskFields(row: TaskRow): string[] {
  if (!['task', 'step'].includes(row.kind || 'task') || !['', 'deep', 'shallow'].includes(row.effort || ''))
    invalid('Choose a task or step and a valid effort preference');
  if (row.kind === 'step' && !row.parent_id) invalid('A step needs a parent task');
  if (!row.title || row.title.length > 500 || row.description.length > 16000 || !Number.isFinite(row.sort_order))
    invalid();
  if (
    !Number.isInteger(row.priority) ||
    row.priority < 1 ||
    row.priority > 4 ||
    !Number.isInteger(row.duration_minutes) ||
    row.duration_minutes < 0 ||
    row.duration_minutes > 10080
  )
    invalid();
  for (const date of [row.due_date, row.deadline]) if (date && !validDate(date)) invalid('Invalid calendar date');
  if (row.due_datetime) {
    const timestamp = Date.parse(row.due_datetime);
    if (
      !row.due_date ||
      !/^\d{4}-\d\d-\d\dT/.test(row.due_datetime) ||
      !Number.isFinite(timestamp) ||
      !validTimezone(row.due_timezone) ||
      localDate(timestamp, row.due_timezone) !== row.due_date
    )
      invalid('Timed date and timezone must agree');
  } else if (row.due_timezone) invalid('Timezone needs a timed date');
  if (row.recurrence) {
    try {
      recurrenceRule(row.recurrence, row.due_date);
    } catch {
      invalid('Unsupported recurrence; choose an explicit supported rule');
    }
  }
  const labels = JSON.parse(row.label_ids) as string[];
  if (labels.length > 30) invalid('Too many labels');
  for (const id of [row.project_id, row.section_id, row.parent_id, ...labels]) if (id) checkedId(id);
  return labels;
}

/** `old` is the stored row of an update: a child keeps its place under a parent that was completed since. */
export async function validateTask(db: D1Database, row: TaskRow, old?: TaskRow): Promise<void> {
  const labels = validateTaskFields(row);
  const checks: D1PreparedStatement[] = [];
  if (row.project_id)
    checks.push(
      db
        .prepare(
          `WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=? AND deleted_at IS NULL UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id WHERE p.deleted_at IS NULL) SELECT id FROM ancestors WHERE id=? AND NOT EXISTS(SELECT 1 FROM ancestors WHERE archived=1)`,
        )
        .bind(row.project_id, row.project_id),
    );
  if (row.section_id)
    checks.push(
      db
        .prepare('SELECT id FROM sections WHERE id=? AND project_id=? AND deleted_at IS NULL AND archived=0')
        .bind(row.section_id, row.project_id),
    );
  if (row.parent_id) {
    const open = old?.parent_id === row.parent_id ? '' : ' AND completed=0';
    checks.push(
      db
        .prepare(`SELECT id FROM tasks WHERE id=? AND project_id=? AND deleted_at IS NULL AND kind='task'${open}`)
        .bind(row.parent_id, row.project_id),
    );
  }
  if (labels.length)
    checks.push(
      db
        .prepare('SELECT id FROM labels WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))')
        .bind(row.label_ids),
    );
  if (checks.length) {
    const results = await storage(() => db.batch(checks));
    for (const [index, result] of results.entries()) {
      const expected = labels.length && index === results.length - 1 ? labels.length : 1;
      if (result.results.length !== expected) precondition('A task reference is missing or archived');
    }
  }
  if (row.parent_id) {
    const ancestors = await storage(() =>
      db
        .prepare(
          `WITH RECURSIVE ancestors(id,parent_id,depth) AS (
      SELECT id,parent_id,1 FROM tasks WHERE id=? UNION ALL SELECT t.id,t.parent_id,a.depth+1 FROM tasks t JOIN ancestors a ON t.id=a.parent_id WHERE a.depth<32
    ) SELECT id,depth FROM ancestors`,
        )
        .bind(row.parent_id)
        .all<{ id: string; depth: number }>(),
    );
    if (ancestors.results.some((a) => a.id === row.id || a.depth >= 32))
      invalid('Task hierarchy would contain a cycle or exceed 32 levels');
  }
  if (row.kind === 'step') {
    const child = await storage(() =>
      db.prepare('SELECT id FROM tasks WHERE parent_id=? AND deleted_at IS NULL LIMIT 1').bind(row.id).first(),
    );
    if (child) precondition('A task with children cannot become a step');
  }
}
