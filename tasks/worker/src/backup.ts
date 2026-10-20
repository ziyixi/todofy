/**
 * The weekly backup's export (docs/backup.md). Todofy's backup job reads every table through TasksApi.exportBackup
 * and stores the rows in its private bucket; tools/backup-restore.ts turns them back into SQL. A plan read fixes each
 * table's max rowid, and pages read rowid ranges below it. Rows are never hard-deleted, so the ranges stay stable.
 */
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { api } from './http.ts';
import type { Env } from './env.ts';
import { invalid, storage } from './errors.ts';

export interface BackupTable {
  name: string;
  columns: readonly string[];
  key: readonly string[];
}
/**
 * Every column of every table a restore needs, in restore order. task_labels is left out (its triggers rebuild it
 * from tasks.label_ids), and so is changes (inserts append it; a restore resets the readers' cursors).
 */
// prettier-ignore
export const BACKUP_TABLES: readonly BackupTable[] = [
  {
    name: 'projects',
    columns: [
      'id', 'title', 'parent_id', 'color', 'favorite', 'archived', 'inbox', 'sort_order', 'revision', 'created_at',
      'updated_at', 'deleted_at',
    ],
    key: ['id'],
  },
  {
    name: 'sections',
    columns: ['id', 'title', 'project_id', 'archived', 'sort_order', 'revision', 'created_at', 'updated_at', 'deleted_at'],
    key: ['id'],
  },
  {
    name: 'labels',
    columns: ['id', 'title', 'color', 'favorite', 'sort_order', 'revision', 'created_at', 'updated_at', 'deleted_at'],
    key: ['id'],
  },
  {
    name: 'filters',
    columns: [
      'id', 'title', 'query', 'favorite', 'sort_order', 'revision', 'created_at', 'updated_at', 'deleted_at', 'color',
    ],
    key: ['id'],
  },
  {
    name: 'tasks',
    columns: [
      'id', 'title', 'description', 'project_id', 'section_id', 'parent_id', 'label_ids', 'priority', 'sort_order',
      'due_date', 'due_datetime', 'due_timezone', 'deadline', 'duration_minutes', 'recurrence', 'completed',
      'completed_at', 'project_archived', 'completed_base_count', 'revision', 'created_at', 'updated_at', 'deleted_at',
      'kind', 'effort', 'stage', 'committed_week', 'area', 'lead_days', 'planning_flags',
    ],
    key: ['id'],
  },
  {
    name: 'completions',
    columns: [
      'sequence', 'id', 'task_id', 'title', 'completed_at', 'due_date', 'project_id', 'task_created_at', 'imported',
    ],
    key: ['sequence'],
  },
  {
    name: 'requests',
    columns: ['id', 'fingerprint', 'response', 'created_at', 'revision_guard'],
    key: ['id'],
  },
  {
    name: 'day_steps',
    columns: ['day', 'task_id', 'position', 'done_at', 'created_at', 'updated_at', 'deleted_at'],
    key: ['day', 'task_id'],
  },
  {
    name: 'focus_entries',
    columns: [
      'id', 'task_id', 'day', 'seconds', 'started_at', 'source', 'area', 'revision', 'created_at', 'updated_at',
      'deleted_at',
    ],
    key: ['id'],
  },
  {
    name: 'focus_timer',
    columns: [
      'id', 'state', 'task_id', 'day', 'area', 'target_seconds', 'started_at', 'segment_start', 'saved_seconds',
      'finished_task_id', 'finished_seconds', 'revision', 'created_at', 'updated_at', 'deleted_at',
    ],
    key: ['id'],
  },
  {
    name: 'task_dependencies',
    columns: ['task_id', 'prerequisite_id', 'baseline_count', 'created_at', 'updated_at', 'deleted_at'],
    key: ['task_id', 'prerequisite_id'],
  },
  {
    name: 'weekly_bets',
    columns: ['week_start', 'area', 'text', 'revision', 'created_at', 'updated_at'],
    key: ['week_start', 'area'],
  },
  {
    name: 'plan_board',
    columns: ['id', 'lanes', 'revision', 'created_at', 'updated_at'],
    key: ['id'],
  },
];
/**
 * Rows per page, and the bytes they may hold. The Worker's CPU grows with the bytes D1 hands it: about 6.5 reference ms
 * per MiB of quote-heavy receipts and 5 per MiB of CJK descriptions (test/runtime/cpu.test.ts), so the page query stops
 * at MAX_PAGE_BYTES of row JSON, half a MiB, well below Free's 10 ms. A task row holds at most about 50 KB.
 */
export const PAGE_ROWS = 100;
export const MAX_PAGE_BYTES = 512 << 10;

const changeSequence = 'SELECT max(sequence) AS n FROM changes';

function rowid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('Invalid backup rowid');
  return value as number;
}

/**
 * `{table: ''}` is the plan: the applied migration, the newest change and every table with its columns and max rowid.
 * `{table, after, through}` is one page of that table's rows with `after < rowid <= through`, each an array in the
 * column order, with the last rowid it holds, whether the range is done and the newest change at the time.
 */
export async function exportBackup(db: D1Database, input: unknown): Promise<string> {
  const request = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (request.table === '') {
    const [schema, changes, ...maxima] = await storage(() =>
      db.batch<{ n: number | null; name?: string }>([
        db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'),
        db.prepare(changeSequence),
        ...BACKUP_TABLES.map((table) => db.prepare(`SELECT max(rowid) AS n FROM ${table.name}`)),
      ]),
    );
    return JSON.stringify({
      schema_version: schema?.results[0]?.name ?? '',
      change_sequence: changes?.results[0]?.n ?? 0,
      tables: BACKUP_TABLES.map((table, index) => ({ ...table, max_rowid: maxima[index]?.results[0]?.n ?? 0 })),
    });
  }
  const table = BACKUP_TABLES.find((candidate) => candidate.name === request.table);
  if (!table) invalid('Unknown backup table');
  const after = rowid(request.after);
  const through = rowid(request.through);
  const columns = table.columns.join(',');
  // The window streams in rowid order and stops at the LIMIT; the first row is kept whatever its size.
  const [page, changes] = await storage(() =>
    db.batch([
      db
        .prepare(
          `SELECT * FROM (SELECT rowid AS _rid,${columns},row_number() OVER w AS _n,
            sum(length(CAST(json_array(${columns}) AS BLOB))+1) OVER w AS _bytes
          FROM ${table.name} WHERE rowid>? AND rowid<=? WINDOW w AS (ORDER BY rowid ROWS UNBOUNDED PRECEDING)
          ORDER BY rowid LIMIT ?) WHERE _n=1 OR _bytes<=?`,
        )
        .bind(after, through, PAGE_ROWS, MAX_PAGE_BYTES),
      db.prepare(changeSequence),
    ]),
  );
  const rows = (page?.results ?? []) as Record<string, unknown>[];
  const last = rows.length ? (rows[rows.length - 1]?._rid as number) : after;
  const values = rows.map((row) => JSON.stringify(table.columns.map((column) => row[column])));
  const newest = (changes?.results[0] as { n: number | null } | undefined)?.n ?? 0;
  // The plan's max rowid is a row (rows are never deleted), so a range ends on it; an empty page ends one too.
  const done = !rows.length || last >= through;
  return `{"rows":[${values.join(',')}],"last":${String(last)},"done":${String(done)},"change_sequence":${String(newest)}}`;
}

/** TasksApi.exportBackup: the same `{status, body}` answer, and the same error body, as a service call. */
export async function backupCall(body: string, env: Env): Promise<{ status: number; body: string }> {
  try {
    if (typeof body !== 'string' || body.length > 1024) invalid('Invalid backup request');
    return { status: 200, body: await exportBackup(env.DB, JSON.parse(body)) };
  } catch (error) {
    const failure =
      error instanceof RpcError
        ? error
        : error instanceof SyntaxError
          ? new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'Invalid backup request')
          : new RpcError(Code.INTERNAL, 'INTERNAL', 'Unexpected Tasks backup error');
    const response = api.errorResponse(failure, crypto.randomUUID());
    return { status: response.status, body: await response.text() };
  }
}
