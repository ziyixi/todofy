/**
 * What the daily backup reads (backup-runner.ts, ../../docs/backup.md): every table of the D1 database with every
 * column. The tables are WITHOUT ROWID, so a page reads the rows after the last key it stored, in key order; a plan
 * fixes the applied migration and the store's change mark (counts and the newest update), which the job reads again
 * when it ends. ../../tools/backup-restore.ts turns the rows back into SQL.
 */

export interface BackupTable {
  name: string;
  columns: readonly string[];
  key: readonly string[];
}
/**
 * Every table and column of migrations/, in restore order (test/runtime/backup.test.ts compares it with the migrated
 * schema): the links, their kept revisions and the request IDs of the last day. wrangler's d1_migrations is not a
 * table of the app: the manifest names the newest migration, which a restore applies.
 */
// prettier-ignore
export const BACKUP_TABLES: readonly BackupTable[] = [
  {
    name: 'links',
    columns: [
      'key', 'target', 'path_mode', 'visibility', 'description', 'tags', 'expire_time', 'create_time', 'update_time',
      'delete_time', 'purge_time', 'revision', 'revision_time', 'etag',
    ],
    key: ['key'],
  },
  {
    name: 'link_revisions',
    columns: ['key', 'revision', 'create_time', 'target', 'path_mode', 'visibility', 'description', 'tags', 'expire_time'],
    key: ['key', 'revision'],
  },
  {
    name: 'request_log',
    columns: ['request_id', 'method', 'name', 'response', 'create_time'],
    key: ['request_id'],
  },
];

/** Rows per page, and the bytes of row JSON they may hold (a link's row holds a few KB at most). */
export const PAGE_ROWS = 100;
export const PAGE_BYTES = 512 << 10;
/** D1 statements of a plan or of the change mark (one batch each); a page is one statement. */
export const PLAN_STATEMENTS = 2 + BACKUP_TABLES.length;
export const MARK_STATEMENTS = 1 + BACKUP_TABLES.length;

/** The store at one moment: every table's row count and the newest write of a link. */
export interface ChangeMark {
  update_time: number;
  rows: Record<string, number>;
}
export interface BackupPlan {
  /** The newest applied migration. */
  schema_version: string;
  mark: ChangeMark;
}
export interface BackupPage {
  /** Each row as a JSON array in the columns' order. */
  rows: string[];
  /** The key of the last row read; `after` when the page is empty. */
  last: unknown[] | null;
  /** Bytes of the rows' JSON, a newline each. */
  bytes: number;
  /** Whether the table is done. */
  done: boolean;
}

function markStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare('SELECT max(update_time) AS n FROM links'),
    ...BACKUP_TABLES.map((table) => db.prepare(`SELECT count(*) AS n FROM ${table.name}`)),
  ];
}

function readMark(results: D1Result[]): ChangeMark {
  const n = (result: D1Result | undefined) => (result?.results[0] as { n: number | null } | undefined)?.n ?? 0;
  return {
    update_time: n(results[0]),
    rows: Object.fromEntries(BACKUP_TABLES.map((table, index) => [table.name, n(results[index + 1])])),
  };
}

/** The plan: the applied migration and the change mark, in one batch. */
export async function planBackup(db: D1Database): Promise<BackupPlan> {
  const [schema, ...mark] = await db.batch([
    db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'),
    ...markStatements(db),
  ]);
  return {
    schema_version: (schema?.results[0] as { name: string } | undefined)?.name ?? '',
    mark: readMark(mark),
  };
}

/** The change mark alone, when the job ends. */
export async function changeMark(db: D1Database): Promise<ChangeMark> {
  return readMark(await db.batch(markStatements(db)));
}

/**
 * One page of a table's rows after the key `after` (null: from the first), in the columns a plan named (a job keeps
 * the columns of the release that planned it): at most PAGE_ROWS rows and `maxBytes` (at most PAGE_BYTES) of row JSON,
 * the first row kept whatever its size. SQLite writes each row's JSON array, so the Worker only joins the lines.
 */
export async function backupPage(
  db: D1Database,
  table: { name: string; columns: readonly string[] },
  after: readonly unknown[] | null,
  maxBytes = PAGE_BYTES,
): Promise<BackupPage> {
  const known = BACKUP_TABLES.find((candidate) => candidate.name === table.name);
  if (!known || !table.columns.length || !table.columns.every((column) => known.columns.includes(column)))
    throw new Error('Unknown backup table or column');
  const key = known.key.join(',');
  const row = `json_array(${table.columns.join(',')})`;
  const where = after === null ? '' : `WHERE (${key})>(${known.key.map(() => '?').join(',')})`;
  // The window runs in key order (the primary key's own B-tree) and stops at the LIMIT. D1 counts each row it reads
  // about three times: the table, the window and the subquery.
  const page = await db
    .prepare(
      `SELECT * FROM (SELECT ${key},${row} AS _row,row_number() OVER w AS _n,
        sum(length(CAST(${row} AS BLOB))+1) OVER w AS _bytes
      FROM ${table.name} ${where} WINDOW w AS (ORDER BY ${key} ROWS UNBOUNDED PRECEDING)
      ORDER BY ${key} LIMIT ?) WHERE _n=1 OR _bytes<=?`,
    )
    .bind(...(after ?? []), PAGE_ROWS, Math.min(maxBytes, PAGE_BYTES))
    .all();
  const rows = page.results;
  const last = rows.at(-1);
  return {
    rows: rows.map((result) => result._row as string),
    last: last ? known.key.map((column) => last[column]) : after === null ? null : [...after],
    bytes: (last?._bytes as number | undefined) ?? 0,
    // A page cut short by its row or byte limit may have rows after it: only an empty page ends the table.
    done: rows.length === 0,
  };
}
