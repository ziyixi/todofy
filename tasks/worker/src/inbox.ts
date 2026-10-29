/**
 * TaskInbox, Tasks' create-only machine entry (proto/tasks/inbox/v1/task_inbox.proto): a Workers entrypoint with one
 * RPC method, bound by Home (props.source "home", its daily digest) and Watch ("watch", its notifications). It creates
 * one task with its subtasks and nothing else: no read, update or delete, and no HTTP route.
 *
 * One D1 batch holds the receipt (the request_id's answer), the source's count for the UTC day, whose named CHECK
 * stops the 21st, the task and its subtasks. The task goes to the project task_inbox_routes names for the source
 * while that project is live, else to the Inbox (inbox-routes.ts). A refusal throws an Error whose message is an
 * ErrorCode's wire name.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { CreateInboxTaskRequestSchema, type CreateInboxTaskRequest } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import type * as wire from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { fromWire, prepareWire } from '@ziyixi/proto/wire-json';
import type { Env } from './env.ts';
import { invalid } from './errors.ts';
import { routedProject } from './inbox-routes.ts';
import { commit, fingerprint, replay } from './receipts.ts';

/** In UTF-16 code units, as Tasks validates a task. */
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 16000;
const SOURCES = ['home', 'watch'] as const;
type Source = (typeof SOURCES)[number];
// Reads the request's descriptors at global scope, outside every call's CPU time, as TasksApi's transcoder does.
prepareWire(CreateInboxTaskRequestSchema);

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
  // One statement per subtask, binding its text as given: a json_each statement over the subtasks would first encode
  // up to 30 descriptions into one JSON string, which D1's request then escapes again (about 0.6 ms of the largest
  // create's CPU). The batch still counts as one D1 query per invocation; a statement binds 8 of D1's 100 parameters.
  const insertSubtask = db.prepare(
    'INSERT INTO tasks(id,title,description,project_id,parent_id,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
  );
  writes.push(
    ...subtasks.map((item, index) =>
      insertSubtask.bind(item.id, item.title, item.description, project, answer.task_id, index + 1, now, now),
    ),
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
