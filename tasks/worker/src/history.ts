import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { decodePageToken, encodePageToken } from '@ziyixi/proto/page-token';
import {
  ListChangesResponseSchema,
  ListCompletionsResponseSchema,
  TaskChangeSchema,
  CompletionSchema,
  type ListChangesRequest,
  type ListCompletionsRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { checkedId, taskMessage, taskProjection, childCounts, type TaskRow } from './model.ts';
import { invalid, precondition, storage } from './errors.ts';
import { pageSize } from './task-read.ts';

export async function listChanges(db: D1Database, input: ListChangesRequest, today: string) {
  if (input.baseline) {
    if (input.pageToken) invalid('Baseline requires an empty change cursor');
    const newest = await storage(() =>
      db.prepare('SELECT max(sequence) AS sequence FROM changes').first<{ sequence: number | null }>(),
    );
    return create(ListChangesResponseSchema, { nextPageToken: String(newest?.sequence ?? 0) });
  }
  const cursor = input.pageToken || '0';
  if (!/^\d{1,15}$/.test(cursor)) invalid('Invalid change cursor');
  const size = pageSize(input.pageSize, 100);
  const rows = await storage(() =>
    db
      .prepare('SELECT * FROM changes WHERE sequence>? ORDER BY sequence LIMIT ?')
      .bind(Number(cursor), size + 1)
      .all<{
        sequence: number;
        resource: string;
        resource_id: string;
        deleted: number;
      }>(),
  );
  const page = rows.results.slice(0, size);
  if (!page.length && Number(cursor) > 0) {
    // A cursor past the newest change means this database was restored or rebuilt behind its reader.
    const newest = await storage(() =>
      db.prepare('SELECT max(sequence) AS sequence FROM changes').first<{ sequence: number | null }>(),
    );
    if ((newest?.sequence ?? 0) < Number(cursor))
      precondition('Change cursor is ahead of this database; reset the reader');
  }
  const ids = [...new Set(page.filter((r) => r.resource === 'tasks').map((r) => r.resource_id))];
  const tasks = ids.length
    ? await storage(() =>
        db
          .prepare(
            `SELECT ${taskProjection(false)},${childCounts} FROM tasks t WHERE t.deleted_at IS NULL AND t.id IN (SELECT value FROM json_each(?))`,
          )
          .bind(JSON.stringify(ids))
          .all<TaskRow>(),
      )
    : { results: [] as TaskRow[] };
  const byId = new Map(tasks.results.map((r) => [r.id, r]));
  return create(ListChangesResponseSchema, {
    changes: page.map((r) => {
      const task = byId.get(r.resource_id);
      return create(TaskChangeSchema, {
        cursor: String(r.sequence),
        name: `${r.resource}/${r.resource_id}`,
        deleted: r.resource === 'tasks' ? !task : r.deleted === 1,
        ...(task && r.resource === 'tasks' ? { task: { ...taskMessage(task, today), description: '' } } : {}),
      });
    }),
    nextPageToken: String(page.at(-1)?.sequence ?? cursor),
    hasMore: rows.results.length > size,
    catalogChanged: page.some((r) => r.resource !== 'tasks'),
  });
}
export async function listCompletions(db: D1Database, input: ListCompletionsRequest) {
  const parameters = { task: input.taskId };
  let cursor = Number.MAX_SAFE_INTEGER;
  if (input.pageToken) {
    try {
      const value = decodePageToken(input.pageToken, parameters);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
      cursor = value;
    } catch {
      invalid('Invalid history cursor');
    }
  }
  const values: (string | number)[] = [cursor];
  let where = 'sequence<?';
  if (input.taskId) {
    where += ' AND task_id=?';
    values.push(checkedId(input.taskId));
  }
  const size = pageSize(input.pageSize);
  const rows = await storage(() =>
    db
      .prepare(`SELECT * FROM completions WHERE ${where} ORDER BY sequence DESC LIMIT ?`)
      .bind(...values, size + 1)
      .all<{
        sequence: number;
        id: string;
        task_id: string;
        title: string;
        completed_at: number;
        project_id: string;
        task_created_at: number;
        due_date: string;
      }>(),
  );
  const page = rows.results.slice(0, size);
  const last = page.at(-1);
  return create(ListCompletionsResponseSchema, {
    completions: page.map((r) =>
      create(CompletionSchema, {
        id: r.id,
        taskId: r.task_id,
        title: r.title,
        completeTime: timestampFromMs(r.completed_at),
        dueDate: r.due_date,
        projectId: r.project_id,
        ...(r.task_created_at > 0 ? { taskCreateTime: timestampFromMs(r.task_created_at) } : {}),
      }),
    ),
    nextPageToken: rows.results.length > size && last ? encodePageToken(last.sequence, parameters) : '',
  });
}
