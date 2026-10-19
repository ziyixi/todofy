import { decodePageToken, encodePageToken } from '@ziyixi/proto/page-token';
import { create } from '@ziyixi/proto/protobuf';
import { ListTasksResponseSchema, type ListTasksRequest } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { addDays, localDate, validDate } from '@ziyixi/task-dates';
import { invalid, missing, storage } from './errors.ts';
import { taskFilter } from './filters.ts';
import { childCounts, taskProjection, checkedId, taskMessage, type TaskRow } from './model.ts';

export function pageSize(value: number, fallback = 50): number {
  if (!Number.isInteger(value) || value < 0) invalid('Invalid page size');
  return Math.min(value || fallback, 100);
}
export async function getTask(db: D1Database, id: string): Promise<TaskRow> {
  const row = await storage(() =>
    db
      .prepare(`SELECT t.*,${childCounts} FROM tasks t WHERE t.id=? AND t.deleted_at IS NULL`)
      .bind(checkedId(id))
      .first<TaskRow>(),
  );
  return row ?? missing();
}
export async function listTasks(db: D1Database, request: ListTasksRequest, zone: string, now: number) {
  const today = request.date || localDate(now, zone);
  if (!validDate(today)) invalid('Invalid reference date');
  const view = request.view || 'inbox';
  const conditions = ['t.deleted_at IS NULL'];
  if (request.taskIds.length > 100) invalid('At most 100 task IDs may be requested');
  const values: (string | number)[] = [];
  let source = 'tasks t';
  if (request.taskIds.length) {
    // Each requested ID is one primary-key lookup, whatever the view's order would otherwise prefer.
    source = 'json_each(?) j CROSS JOIN tasks t ON t.id=j.value';
    values.push(JSON.stringify([...new Set(request.taskIds.map(checkedId))]));
  }
  if (request.parentId) {
    conditions.push('t.parent_id=?');
    values.push(checkedId(request.parentId));
  } else {
    // Ordinary views are outcomes. Explicit IDs, parent reads and all preserve executable Steps.
    if (view !== 'all' && !request.taskIds.length) conditions.push("t.kind='task'");
    if (view === 'completed' || !request.includeCompleted)
      conditions.push(`t.completed=${view === 'completed' ? '1' : '0'}`);
    if (view !== 'completed' && view !== 'project') conditions.push('t.project_archived=0');
    switch (view) {
      case 'inbox':
        conditions.push(
          "(t.project_id='' OR t.project_id IN (SELECT id FROM projects WHERE inbox=1 AND deleted_at IS NULL)) AND t.parent_id=''",
        );
        break;
      case 'project':
        conditions.push("t.project_id=? AND t.parent_id=''");
        values.push(checkedId(request.projectId));
        break;
      case 'today':
        conditions.push("t.due_date<>'' AND t.due_date<=?");
        values.push(today);
        break;
      case 'upcoming':
        conditions.push('t.due_date>=? AND t.due_date<?');
        values.push(today, addDays(today, 7));
        break;
      case 'label':
        conditions.push('EXISTS(SELECT 1 FROM task_labels tl WHERE tl.task_id=t.id AND tl.label_id=?)');
        values.push(checkedId(request.labelId));
        break;
      case 'search': {
        if (request.projectId) {
          conditions.push('t.project_id=?');
          values.push(checkedId(request.projectId));
        }
        if (!request.query.trim() || request.query.length > 200) invalid('Search needs 1–200 characters');
        conditions.push('(instr(lower(t.title),lower(?))>0 OR instr(lower(t.description),lower(?))>0)');
        values.push(request.query, request.query);
        break;
      }
      case 'filter': {
        let query = request.query;
        if (request.filterId) {
          const row = await storage(() =>
            db
              .prepare('SELECT query FROM filters WHERE id=? AND deleted_at IS NULL')
              .bind(checkedId(request.filterId))
              .first<{ query: string }>(),
          );
          query = row?.query ?? missing();
        }
        const filter = taskFilter(query, today);
        conditions.push(filter.sql);
        values.push(...filter.values);
        break;
      }
      case 'all':
      case 'completed':
        if (view === 'all' && request.query.trim()) {
          if (request.query.length > 200) invalid('Search needs 1–200 characters');
          conditions.push('(instr(lower(t.title),lower(?))>0 OR instr(lower(t.description),lower(?))>0)');
          values.push(request.query, request.query);
        }
        if (request.projectId) {
          conditions.push('t.project_id=?');
          values.push(checkedId(request.projectId));
        }
        break;
      default:
        invalid('Unsupported task view');
    }
  }
  const sort = /^(sort_order|title|priority|due_date)(?: (asc|desc))?$/.exec(request.orderBy || 'sort_order');
  if (!sort) invalid('Unsupported task order');
  const column = sort[1] ?? 'sort_order';
  const direction = sort[2] === 'desc' ? 'DESC' : 'ASC';
  const parameters = {
    view,
    project: request.projectId,
    parent: request.parentId,
    query: request.query,
    label: request.labelId,
    filter: request.filterId,
    date: today,
    order: `${column} ${direction}`,
    includeCompleted: request.includeCompleted,
    includeDescription: request.includeDescription,
    taskIds: JSON.stringify(request.taskIds),
  };
  if (request.pageToken) {
    let cursor;
    try {
      cursor = decodePageToken(request.pageToken, parameters);
    } catch {
      invalid('Page token does not match this view');
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      !['string', 'number'].includes(typeof cursor[0]) ||
      typeof cursor[1] !== 'string'
    )
      invalid('Invalid page token');
    // A row value seeks the order index; every sortable column is NOT NULL.
    const operator = direction === 'DESC' ? '<' : '>';
    conditions.push(`(t.${column},t.id)${operator}(?,?)`);
    values.push(cursor[0] as string | number, checkedId(cursor[1]));
  }
  const size = Math.min(pageSize(request.pageSize), request.includeDescription ? 20 : 100);
  const rows = await storage(() =>
    db
      .prepare(
        `SELECT ${taskProjection(request.includeDescription)},${childCounts} FROM ${source} WHERE ${conditions.join(' AND ')} ORDER BY t.${column} ${direction},t.id ${direction} LIMIT ?`,
      )
      .bind(...values, size + 1)
      .all<TaskRow>(),
  );
  const page = rows.results.slice(0, size);
  const last = page.at(-1);
  const key = last ? ((last as unknown as Record<string, string | number>)[column] ?? '') : '';
  return create(ListTasksResponseSchema, {
    tasks: page.map((row) => {
      const task = taskMessage(row);
      if (!request.includeDescription) task.description = '';
      return task;
    }),
    nextPageToken: rows.results.length > size && last ? encodePageToken([key, last.id], parameters) : '',
  });
}
