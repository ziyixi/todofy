/** Daily request-log copies. The engine owns the cursor and Alarm; this module owns no runtime state. */
export interface BackupEnv {
  DB: D1Database;
  REQUEST_BODIES: R2Bucket;
  BACKUPS: R2Bucket;
}

export const METADATA_PAGE_SIZE = 100;
export const BODIES_PER_STEP = 10;

export interface RequestRow {
  id: string;
  state: string;
  body_key: string;
  content_expire_ms: number;
  generation_json: string;
  [column: string]: string | number | null;
}
export interface BackupCounts {
  requests: number;
  bodies: number;
  body_bytes: number;
}
export interface BackupCursor {
  prefix: string;
  started_ms: number;
  phase: 'start' | 'metadata' | 'bodies';
  max_rowid: number;
  after_rowid: number;
  page: number;
  body_offset: number;
  counts: BackupCounts;
}
export interface BackupComplete extends BackupCounts {
  started_ms: number;
  completed_ms: number;
  page_count: number;
}
export interface BackupStep {
  next: BackupCursor | null;
  finished: boolean;
  counts: BackupCounts;
}

export function newBackup(now: number): BackupCursor {
  return {
    prefix: `daily/${new Date(now).toISOString().slice(0, 10)}/`,
    started_ms: now,
    phase: 'start',
    max_rowid: 0,
    after_rowid: 0,
    page: 0,
    body_offset: 0,
    counts: { requests: 0, bodies: 0, body_bytes: 0 },
  };
}

export function pageKey(prefix: string, page: number): string {
  return `${prefix}requests/${String(page).padStart(5, '0')}.ndjson.gz`;
}

export function bodyKey(prefix: string, originalKey: string): string {
  if (!/^requests\/[a-z][a-z0-9-]*\/[a-zA-Z0-9_-]+\.json$/.test(originalKey))
    throw new Error('backup_invalid_body_key');
  return `${prefix}bodies/${originalKey}`;
}

/** Expired or already unavailable content is not part of a retained-body copy. */
export function hasRetainedBody(row: RequestRow, at: number): boolean {
  const record = JSON.parse(row.generation_json) as {
    generation?: object;
    content_available?: boolean;
    content_unavailable?: boolean;
  };
  const available = record.generation ? record.content_available === true : record.content_unavailable !== true;
  return row.content_expire_ms > at && available;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(compressed).arrayBuffer();
}

async function readPage(env: BackupEnv, cursor: BackupCursor): Promise<RequestRow[]> {
  const object = await env.BACKUPS.get(pageKey(cursor.prefix, cursor.page));
  if (!object) throw new Error('backup_metadata_page_missing');
  const text = await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RequestRow);
}

/** A failed step leaves its input cursor unchanged; retrying it writes the same bounded keys. */
export async function backupStep(env: BackupEnv, cursor: BackupCursor, now = Date.now()): Promise<BackupStep> {
  const next = { ...cursor, counts: { ...cursor.counts } };
  if (next.phase === 'start') {
    const complete = await env.BACKUPS.get(`${next.prefix}complete.json`);
    if (complete) {
      const saved = await complete.json<BackupComplete>();
      return {
        next: null,
        finished: true,
        counts: { requests: saved.requests, bodies: saved.bodies, body_bytes: saved.body_bytes },
      };
    }
    const last = await env.DB.prepare('SELECT max(rowid) AS n FROM requests').first<{ n: number | null }>();
    next.max_rowid = last?.n ?? 0;
    next.phase = 'metadata';
    return { next, finished: false, counts: next.counts };
  }
  if (next.phase === 'metadata') {
    const page = await env.DB.prepare(
      "SELECT rowid AS _backup_rowid, * FROM requests WHERE rowid > ? AND rowid <= ? AND state != 'running' ORDER BY rowid LIMIT ?",
    ).bind(next.after_rowid, next.max_rowid, METADATA_PAGE_SIZE).all<RequestRow & { _backup_rowid: number }>();
    if (page.results.length === 0) {
      const complete: BackupComplete = {
        ...next.counts,
        started_ms: next.started_ms,
        completed_ms: now,
        page_count: next.page,
      };
      await env.BACKUPS.put(`${next.prefix}complete.json`, JSON.stringify(complete), {
        httpMetadata: { contentType: 'application/json' },
      });
      return { next: null, finished: true, counts: next.counts };
    }
    const rows: RequestRow[] = [];
    for (const { _backup_rowid, ...row } of page.results) {
      next.after_rowid = _backup_rowid;
      rows.push(row);
    }
    const pageText = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    await env.BACKUPS.put(pageKey(next.prefix, next.page), await gzip(pageText), {
      httpMetadata: { contentType: 'application/gzip' },
    });
    next.counts.requests += rows.length;
    next.phase = 'bodies';
    next.body_offset = 0;
    return { next, finished: false, counts: next.counts };
  }
  const rows = await readPage(env, next);
  let copied = 0;
  while (next.body_offset < rows.length && copied < BODIES_PER_STEP) {
    const row = rows[next.body_offset]!;
    if (hasRetainedBody(row, next.started_ms)) {
      const key = bodyKey(next.prefix, row.body_key);
      const object = await env.REQUEST_BODIES.get(row.body_key);
      if (!object) throw new Error('backup_retained_body_missing');
      await env.BACKUPS.put(key, object.body, {
        httpMetadata: object.httpMetadata ?? {},
        customMetadata: object.customMetadata ?? {},
      });
      next.counts.bodies += 1;
      next.counts.body_bytes += object.size;
      copied += 1;
    }
    next.body_offset += 1;
  }
  if (next.body_offset === rows.length) {
    next.page += 1;
    next.phase = 'metadata';
    next.body_offset = 0;
  }
  return { next, finished: false, counts: next.counts };
}
