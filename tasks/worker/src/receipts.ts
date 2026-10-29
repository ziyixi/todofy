import type { Message } from '@ziyixi/proto/protobuf';
import { RpcError, Code } from '@ziyixi/proto/rpc-status';
import { TaskInboxService } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import { TasksUiService } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { conflict, invalid, missing, storage } from './errors.ts';
import type { Table } from './model.ts';

interface Receipt {
  fingerprint: string;
  response: string;
}
/**
 * A request's identity: `wire` is stored with new receipts; `legacy` matches receipts stored before it. `legacy` is
 * computed only for a stored receipt that `wire` does not match: a new request has none, and one hash of TaskInbox's
 * largest request (about half a million characters) costs about 1.5 ms of the request's CPU.
 */
export interface RequestHash {
  wire: string;
  legacy: () => Promise<string>;
}
const requestSchemas = new Map(
  [...TasksUiService.methods, ...TaskInboxService.methods].map((method) => [method.input.typeName, method.input]),
);

async function sha256(value: unknown): Promise<string> {
  // A decoded Timestamp (CommandFocusTimer's effective_time) holds a bigint, which JSON cannot; no request older than
  // the wire form had one, so its text form only has to be stable.
  const bytes = new TextEncoder().encode(
    JSON.stringify(value, (_, field: unknown) => (typeof field === 'bigint' ? String(field) : field)),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function withoutEmpty(value: object, keys: readonly string[]): object {
  return Object.fromEntries(Object.entries(value).filter(([key, field]) => !(keys.includes(key) && field === '')));
}
/** The decoded object older receipts hashed, without the fields added since then while they are still empty. */
function legacyForm(method: string, input: object): object {
  const { task, resource } = input as { task?: object; resource?: object };
  if (task && (method === 'createTask' || method === 'updateTask'))
    return {
      ...input,
      task: withoutEmpty(task, ['kind', 'effort', 'keyResultId', 'effectiveKeyResultId', 'keyResultTitle']),
    };
  if (resource && method.endsWith(':filters')) return { ...input, resource: withoutEmpty(resource, ['color']) };
  if (method === 'completeTask') return withoutEmpty(input, ['focusDay']);
  return input;
}
/**
 * A receipt hashes its request's wire JSON. The wire form leaves unset fields out, so adding a field never
 * changes the hash of an older request. `legacyInput` is what receipts written before the wire form hashed. `legacy`
 * reads `request` and `legacyInput` when it is called: a caller must not change either before its last replay() or
 * commit().
 */
export async function fingerprint(
  method: string,
  request: Message,
  legacyInput: object = request,
): Promise<RequestHash> {
  const schema = requestSchemas.get(request.$typeName);
  if (!schema) throw new TypeError(`Not a Tasks request message: ${request.$typeName}`);
  return {
    wire: await sha256([method, toWire(schema, request)]),
    legacy: () => sha256([method, legacyForm(method, legacyInput)]),
  };
}
export async function replay(db: D1Database, id: string, hash: RequestHash): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    invalid('A UUID request_id is required');
  const receipt = await storage(() =>
    db.prepare('SELECT fingerprint,response FROM requests WHERE id=?').bind(id).first<Receipt>(),
  );
  if (!receipt) return null;
  if (receipt.fingerprint !== hash.wire && receipt.fingerprint !== (await hash.legacy()))
    invalid('Request ID was already used for different input');
  return receipt.response;
}

/**
 * D1 batches are transactional. The CHECK guard aborts the entire batch on a stale revision. `revision` is the
 * resource's current one, null for a new resource, or 'live' when the write only needs the resource to exist.
 */
export async function commit(
  db: D1Database,
  input: {
    requestId: string;
    hash: RequestHash;
    table: Table;
    id: string;
    revision: number | null | 'live';
    response: string;
    now: number;
  },
  writes: D1PreparedStatement[],
): Promise<string> {
  // plan_board is one row that is never deleted.
  const deletedAt = input.table === 'plan_board' ? 'NULL' : 'deleted_at';
  const condition =
    input.revision === null
      ? `NOT EXISTS(SELECT 1 FROM ${input.table} WHERE id=?)`
      : input.revision === 'live'
        ? `EXISTS(SELECT 1 FROM ${input.table} WHERE id=? AND ${deletedAt} IS NULL)`
        : `EXISTS(SELECT 1 FROM ${input.table} WHERE id=? AND revision=? AND ${deletedAt} IS NULL)`;
  const guard = db
    .prepare(
      `INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES(?,?,?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    )
    .bind(
      input.requestId,
      input.hash.wire,
      input.response,
      input.now,
      input.id,
      ...(typeof input.revision === 'number' ? [input.revision] : []),
    );
  try {
    await db.batch([guard, ...writes]);
    return input.response;
  } catch (error) {
    // Concurrent duplicate requests return the winner, including when its response was lost.
    const previous = await replay(db, input.requestId, input.hash);
    if (previous !== null) return previous;
    const current = await storage(() =>
      db
        .prepare(`SELECT revision,${deletedAt} AS deleted_at FROM ${input.table} WHERE id=?`)
        .bind(input.id)
        .first<{ revision: number; deleted_at: number | null }>(),
    );
    if (input.revision === null && current)
      throw new RpcError(Code.ALREADY_EXISTS, 'ALREADY_EXISTS', 'Resource ID already exists');
    if (input.revision === 'live' && (!current || current.deleted_at !== null)) missing();
    if (typeof input.revision === 'number' && current?.revision !== input.revision) conflict();
    if (
      String(error).includes('task_reference_invalid') ||
      String(error).includes('resource_in_use') ||
      String(error).includes('task_hierarchy_invalid')
    )
      throw new RpcError(
        Code.FAILED_PRECONDITION,
        'PRECONDITION_FAILED',
        'Referenced resources changed; refresh before editing',
      );
    if (String(error).includes('UNIQUE constraint'))
      throw new RpcError(Code.ALREADY_EXISTS, 'ALREADY_EXISTS', 'Resource name already exists');
    // TaskInbox's per-source count for the UTC day (task_inbox_days).
    if (String(error).includes('task_inbox_daily_limit'))
      throw new RpcError(Code.RESOURCE_EXHAUSTED, 'DAILY_LIMIT', 'The source created its tasks for today');
    throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Task storage is temporarily unavailable');
  }
}
