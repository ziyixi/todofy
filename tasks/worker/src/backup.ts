/**
 * What the weekly backup reads (backup-runner.ts, docs/backup.md): every table a restore needs, with its columns. A
 * plan read fixes each table's max rowid, and pages read rowid ranges below it. Rows are never hard-deleted, so the
 * ranges stay stable; tools/backup-restore.ts turns the rows back into SQL.
 */

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
    name: 'objectives',
    columns: ['id', 'title', 'description', 'year', 'source_url', 'sort_order', 'archived', 'revision', 'created_at', 'updated_at', 'deleted_at'],
    key: ['id'],
  },
  {
    name: 'key_results',
    columns: ['id', 'objective_id', 'title', 'floor_text', 'target_text', 'notes', 'kind', 'completed', 'milestones',
      'focus_start_month', 'focus_end_month', 'focus_text', 'source_url', 'sort_order', 'archived', 'revision', 'created_at', 'updated_at', 'deleted_at'],
    key: ['id'],
  },
  {
    name: 'goal_progress',
    columns: ['id', 'key_result_id', 'note', 'evidence_url', 'revision', 'created_at', 'updated_at', 'deleted_at'],
    key: ['id'],
  },
  {
    name: 'tasks',
    columns: [
      'id', 'title', 'description', 'project_id', 'section_id', 'parent_id', 'label_ids', 'priority', 'sort_order',
      'due_date', 'due_datetime', 'due_timezone', 'deadline', 'duration_minutes', 'recurrence', 'completed',
      'completed_at', 'project_archived', 'completed_base_count', 'revision', 'created_at', 'updated_at', 'deleted_at',
      'kind', 'effort', 'stage', 'committed_week', 'area', 'lead_days', 'planning_flags', 'key_result_id',
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
      'finished_task_id', 'finished_seconds', 'revision', 'created_at', 'updated_at', 'deleted_at', 'paused_at',
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
    columns: ['week_start', 'area', 'text', 'revision', 'created_at', 'updated_at', 'key_result_id'],
    key: ['week_start', 'area'],
  },
  {
    name: 'plan_board',
    columns: ['id', 'lanes', 'revision', 'created_at', 'updated_at'],
    key: ['id'],
  },
  {
    name: 'mail_settings',
    columns: ['id', 'categories', 'next_category_id', 'revision', 'created_at', 'updated_at'],
    key: ['id'],
  },
  {
    name: 'gtd_days',
    columns: [
      'day', 'scope', 'open', 'age_0_7', 'age_8_14', 'age_15_30', 'age_31_plus', 'oldest_days', 'overdue', 'undated',
      'created_7d', 'completed_7d', 'closed_1d', 'mail_open', 'complete', 'computed_at',
    ],
    key: ['day', 'scope'],
  },
  {
    name: 'weekly_reviews',
    columns: ['week', 'state', 'task_id', 'created_at', 'completed_at'],
    key: ['week'],
  },
  {
    name: 'task_inbox_routes',
    columns: ['source', 'project_id', 'updated_at'],
    key: ['source'],
  },
  {
    name: 'task_inbox_days',
    columns: ['source', 'day', 'requests'],
    key: ['source', 'day'],
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
/** D1 statements of a plan (one batch) and of a page (one batch). */
export const PLAN_STATEMENTS = 2 + BACKUP_TABLES.length;
export const PAGE_STATEMENTS = 2;

export interface BackupPlan {
  /** The newest applied migration. */
  schema_version: string;
  /** The newest change when the plan was read. */
  change_sequence: number;
  tables: (BackupTable & { max_rowid: number })[];
}
export interface BackupPage {
  /** Each row as a JSON array in the columns' order. */
  rows: string[];
  /** The last rowid read; `after` when the page is empty. */
  last: number;
  /** Whether the range is done. */
  done: boolean;
  change_sequence: number;
}

/** The plan: the applied migration, the newest change and every table with its columns and max rowid. */
export async function planBackup(db: D1Database): Promise<BackupPlan> {
  const [schema, changes, ...maxima] = await db.batch<{
    n: number | null;
    name?: string;
  }>([
    db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'),
    db.prepare(changeSequence),
    ...BACKUP_TABLES.map((table) => db.prepare(`SELECT max(rowid) AS n FROM ${table.name}`)),
  ]);
  return {
    schema_version: schema?.results[0]?.name ?? '',
    change_sequence: changes?.results[0]?.n ?? 0,
    tables: BACKUP_TABLES.map((table, index) => ({
      ...table,
      max_rowid: maxima[index]?.results[0]?.n ?? 0,
    })),
  };
}

/**
 * One page of a table's rows with `after < rowid <= through`, in the columns a plan named (a job keeps the columns of
 * the release that planned it): at most PAGE_ROWS rows and about MAX_PAGE_BYTES, with the newest change at the time.
 */
export async function backupPage(
  db: D1Database,
  table: { name: string; columns: readonly string[] },
  after: number,
  through: number,
): Promise<BackupPage> {
  const known = BACKUP_TABLES.find((candidate) => candidate.name === table.name);
  if (!known || !table.columns.length || !table.columns.every((column) => known.columns.includes(column)))
    throw new Error('Unknown backup table or column');
  const columns = table.columns.join(',');
  // The window streams in rowid order and stops at the LIMIT; the first row is kept whatever its size.
  const [page, changes] = await db.batch([
    db
      .prepare(
        `SELECT * FROM (SELECT rowid AS _rid,${columns},row_number() OVER w AS _n,
          sum(length(CAST(json_array(${columns}) AS BLOB))+1) OVER w AS _bytes
        FROM ${table.name} WHERE rowid>? AND rowid<=? WINDOW w AS (ORDER BY rowid ROWS UNBOUNDED PRECEDING)
        ORDER BY rowid LIMIT ?) WHERE _n=1 OR _bytes<=?`,
      )
      .bind(after, through, PAGE_ROWS, MAX_PAGE_BYTES),
    db.prepare(changeSequence),
  ]);
  const rows = (page?.results ?? []) as Record<string, unknown>[];
  const last = rows.length ? (rows[rows.length - 1]?._rid as number) : after;
  return {
    rows: rows.map((row) => JSON.stringify(table.columns.map((column) => row[column]))),
    last,
    // The plan's max rowid is a row (rows are never deleted), so a range ends on it; an empty page ends one too.
    done: !rows.length || last >= through,
    change_sequence: (changes?.results[0] as { n: number | null } | undefined)?.n ?? 0,
  };
}
