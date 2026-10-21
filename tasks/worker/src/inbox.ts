/**
 * TaskInbox, Tasks' create-only machine entry (proto/tasks/inbox/v1/task_inbox.proto): a Workers entrypoint with one
 * RPC method, bound by Home (props.source "home", its daily digest) and Watch ("watch", its notifications). It creates
 * one task with its subtasks and nothing else: no read, update or delete, and no HTTP route.
 *
 * One D1 batch holds the receipt (the request_id's answer), the source's count for the UTC day, whose named CHECK
 * stops the 21st, the task and its subtasks. The task goes to the project task_inbox_routes names for the source
 * while that project is live, else to the Inbox. A refusal throws an Error whose message is an ErrorCode's wire name.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { CreateInboxTaskRequestSchema, type CreateInboxTaskRequest } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import type * as wire from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { fromWire } from '@ziyixi/proto/wire-json';
import type { Env } from './env.ts';
import { invalid, storage } from './errors.ts';
import { commit, fingerprint, replay } from './receipts.ts';

/** Tasks each source creates per UTC day at most: task_inbox_days' CHECK. */
export const DAILY_LIMIT = 20;
/** In UTF-16 code units, as Tasks validates a task. */
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 16000;
const SOURCES = ['home', 'watch'] as const;
type Source = (typeof SOURCES)[number];

/**
 * The project a source's tasks go to: its route's project while it is live and neither it nor a parent is archived,
 * else '' (the Inbox). The weekly review routes as 'review'.
 */
export async function routedProject(db: D1Database, source: Source | 'review'): Promise<string> {
  const row = await storage(() =>
    db
      .prepare(
        `WITH RECURSIVE chain(id,parent_id,archived) AS (
          SELECT p.id,p.parent_id,p.archived FROM task_inbox_routes r JOIN projects p ON p.id=r.project_id
          WHERE r.source=? AND p.deleted_at IS NULL
          UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN chain c ON p.id=c.parent_id
          WHERE p.deleted_at IS NULL)
        SELECT project_id FROM task_inbox_routes WHERE source=? AND EXISTS(SELECT 1 FROM chain)
        AND NOT EXISTS(SELECT 1 FROM chain WHERE archived=1)`,
      )
      .bind(source, source)
      .first<{ project_id: string | null }>(),
  );
  return row?.project_id ?? '';
}

function text(title: string, description: string): { title: string; description: string } {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_TITLE || description.length > MAX_DESCRIPTION) invalid();
  return { title: trimmed, description };
}

/** One task with its subtasks, in one batch; a replay answers the first answer. */
export async function createInboxTask(
  db: D1Database,
  source: Source,
  request: CreateInboxTaskRequest,
  now: number,
): Promise<wire.CreateInboxTaskResponse> {
  const task = text(request.title, request.description);
  const subtasks = request.subtasks.map((subtask) => ({
    id: crypto.randomUUID(),
    ...text(subtask.title, subtask.description),
  }));
  const hash = await fingerprint(`createInboxTask:${source}`, request);
  const previous = await replay(db, request.requestId, hash);
  if (previous !== null) return { ...(JSON.parse(previous) as wire.CreateInboxTaskResponse), replayed: true };
  const project = await routedProject(db, source);
  const answer: wire.CreateInboxTaskResponse = {
    task_id: crypto.randomUUID(),
    subtask_ids: subtasks.map((subtask) => subtask.id),
    replayed: false,
  };
  const writes = [
    db
      .prepare(
        'INSERT INTO task_inbox_days(source,day,requests) VALUES(?,?,1) ON CONFLICT(source,day) DO UPDATE SET requests=requests+1',
      )
      .bind(source, new Date(now).toISOString().slice(0, 10)),
    // Last in its project's top level, as a create without a position is.
    db
      .prepare(
        `INSERT INTO tasks(id,title,description,project_id,sort_order,created_at,updated_at) VALUES(?,?,?,?,
        (SELECT COALESCE(MAX(sort_order),0)+1 FROM tasks WHERE project_id=? AND parent_id='' AND section_id='' AND deleted_at IS NULL),?,?)`,
      )
      .bind(answer.task_id, task.title, task.description, project, project, now, now),
  ];
  if (subtasks.length)
    writes.push(
      db
        .prepare(
          `INSERT INTO tasks(id,title,description,project_id,parent_id,sort_order,created_at,updated_at)
          SELECT value->>'id',value->>'title',value->>'description',?,?,key+1,?,? FROM json_each(?) ORDER BY key`,
        )
        .bind(project, answer.task_id, now, now, JSON.stringify(subtasks)),
    );
  const stored = JSON.parse(
    await commit(
      db,
      {
        requestId: request.requestId,
        hash,
        table: 'tasks',
        id: answer.task_id,
        revision: null,
        response: JSON.stringify(answer),
        now,
      },
      writes,
    ),
  ) as wire.CreateInboxTaskResponse;
  // A concurrent call with the same request won: its answer, replayed.
  return stored.task_id === answer.task_id ? stored : { ...stored, replayed: true };
}

interface InboxProps {
  source?: unknown;
}
export class TaskInbox extends WorkerEntrypoint<Env, InboxProps> implements wire.TaskInboxService {
  async createInboxTask(input: wire.CreateInboxTaskRequest): Promise<wire.CreateInboxTaskResponse> {
    const source = this.ctx.props.source;
    if (!SOURCES.includes(source as Source)) throw new Error('invalid_input' satisfies wire.ErrorCode);
    let request: CreateInboxTaskRequest;
    try {
      request = fromWire(CreateInboxTaskRequestSchema, input, { strict: true }).message;
    } catch {
      throw new Error('invalid_input' satisfies wire.ErrorCode);
    }
    try {
      return await createInboxTask(this.env.DB, source as Source, request, Date.now());
    } catch (error) {
      throw refusal(error);
    }
  }
}
/** What the caller learns of a failure: its ErrorCode only, never a storage error's text. */
function refusal(error: unknown): Error {
  const code: wire.ErrorCode =
    error instanceof RpcError && error.code === Code.INVALID_ARGUMENT
      ? 'invalid_input'
      : error instanceof RpcError && error.reason === 'DAILY_LIMIT'
        ? 'daily_limit'
        : 'unavailable';
  return new Error(code);
}
