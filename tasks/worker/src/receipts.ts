import { RpcError, Code } from '@ziyixi/proto/rpc-status';
import { conflict, invalid, storage } from './errors.ts';
import type { Table } from './model.ts';

interface Receipt {
  fingerprint: string;
  response: string;
}
export async function fingerprint(method: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([method, input]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function replay(db: D1Database, id: string, hash: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    invalid('A UUID request_id is required');
  const receipt = await storage(() =>
    db.prepare('SELECT fingerprint,response FROM requests WHERE id=?').bind(id).first<Receipt>(),
  );
  if (!receipt) return null;
  if (receipt.fingerprint !== hash) invalid('Request ID was already used for different input');
  return receipt.response;
}

/** D1 batches are transactional. The CHECK guard aborts the entire batch on a stale revision. */
export async function commit(
  db: D1Database,
  input: {
    requestId: string;
    hash: string;
    table: Table;
    id: string;
    revision: number | null;
    response: string;
    now: number;
  },
  writes: D1PreparedStatement[],
): Promise<string> {
  const condition =
    input.revision === null
      ? `NOT EXISTS(SELECT 1 FROM ${input.table} WHERE id=?)`
      : `EXISTS(SELECT 1 FROM ${input.table} WHERE id=? AND revision=? AND deleted_at IS NULL)`;
  const guard = db
    .prepare(
      `INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES(?,?,?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,
    )
    .bind(
      input.requestId,
      input.hash,
      input.response,
      input.now,
      input.id,
      ...(input.revision === null ? [] : [input.revision]),
    );
  try {
    await db.batch([guard, ...writes]);
    return input.response;
  } catch (error) {
    // Concurrent duplicate requests return the winner, including when its response was lost.
    const previous = await replay(db, input.requestId, input.hash);
    if (previous !== null) return previous;
    const current = await storage(() =>
      db.prepare(`SELECT revision FROM ${input.table} WHERE id=?`).bind(input.id).first<{ revision: number }>(),
    );
    if (input.revision === null && current)
      throw new RpcError(Code.ALREADY_EXISTS, 'ALREADY_EXISTS', 'Resource ID already exists');
    if (input.revision !== null && current?.revision !== input.revision) conflict();
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
    throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Task storage is temporarily unavailable');
  }
}
