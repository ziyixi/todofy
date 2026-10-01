/**
 * The owner API's D1 reads and writes (../../docs/design.md §5-§6). D1 has no interactive transactions, so each
 * write is one batch (a transaction) built from what the request read before: every UPDATE is conditional on the
 * etag it read (AIP-154), every derived row (the revision, the request log) is inserted only where the link now has
 * the new etag, and a lost race reads again and answers what it finds. Every write batch first purges what is due:
 * deleted links past their purge_time with their revisions, and request IDs older than a day (no cron).
 *
 * The redirect path reads through resolve.ts, never here: it is one primary-key read and writes nothing.
 * Times are epoch milliseconds, passed in by the caller (tests pass their own clock).
 */
import { LINK_COLUMNS, CONTENT_COLUMNS, sameContent, type LinkContent, type LinkRow, type RevisionRow } from './model.ts';
import { LINKS_MAX, PURGE_AFTER_MS, REQUEST_ID_TTL_MS, REVISIONS_KEPT } from './limits.ts';

/** Why a mutation did not apply; `current` is the link's state when the caller should see it. */
export interface Failure {
  readonly reason: 'NOT_FOUND' | 'LINK_EXISTS' | 'LINK_DELETED' | 'NOT_DELETED' | 'ETAG_MISMATCH' | 'LINKS_FULL' | 'REVISION_NOT_FOUND';
  readonly current?: LinkRow;
}

/** A mutation's result: applied, refused, or the stored first response of its request_id (AIP-155). */
export type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed'; readonly failure: Failure }
  | { readonly kind: 'replay'; readonly response: string };

/** What every mutation needs besides its input. */
export interface WriteContext {
  readonly db: D1Database;
  readonly now: number;
  /** The request's AIP-155 ID, or '' (nothing is logged or deduplicated). */
  readonly requestId: string;
}

const ok = <T>(value: T): Outcome<T> => ({ kind: 'ok', value });
const failed = <T>(reason: Failure['reason'], current?: LinkRow): Outcome<T> => ({ kind: 'failed', failure: current === undefined ? { reason } : { reason, current } });

/** A fresh opaque etag: 16 random hex digits. */
export function newEtag(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Rows whose purge time has passed are gone, whether or not a write purged them yet. */
function present(row: LinkRow | null, now: number): LinkRow | null {
  return row !== null && (row.purge_time === null || row.purge_time > now) ? row : null;
}

function selectLink(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE key = ?`).bind(key);
}

/** The statements every write batch starts with: what is due for purging (each writes nothing when nothing is). */
function purgeStatements(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM link_revisions WHERE key IN (SELECT key FROM links WHERE purge_time <= ?)').bind(now),
    db.prepare('DELETE FROM links WHERE purge_time <= ?').bind(now),
    db.prepare('DELETE FROM request_log WHERE create_time <= ?').bind(now - REQUEST_ID_TTL_MS),
  ];
}
const PURGES = 3;

function selectReplay(ctx: WriteContext): D1PreparedStatement {
  return ctx.db.prepare('SELECT response FROM request_log WHERE request_id = ? AND create_time > ?').bind(ctx.requestId, ctx.now - REQUEST_ID_TTL_MS);
}

/** The request log row of `response`, written only where `key` now carries `etag` (the mutation applied). */
function logStatement(ctx: WriteContext, response: string, key: string, etag: string): D1PreparedStatement {
  return ctx.db
    .prepare('INSERT INTO request_log (request_id, response, create_time) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM links WHERE key = ? AND etag = ?)')
    .bind(ctx.requestId, response, ctx.now, key, etag);
}

/** The revision row of the link's current state, written only where it carries `etag`. */
function revisionStatement(db: D1Database, key: string, etag: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO link_revisions (key, revision, create_time, ${CONTENT_COLUMNS})
       SELECT key, revision, revision_time, ${CONTENT_COLUMNS} FROM links WHERE key = ? AND etag = ?`,
    )
    .bind(key, etag);
}

/**
 * Runs a write batch. When it fails and the request carries an ID that another request logged meanwhile (two
 * deliveries of one request: the request_log key collides), the first response is the answer; otherwise the
 * failure propagates (D1 unavailable).
 */
async function writeBatch(ctx: WriteContext, statements: D1PreparedStatement[]): Promise<D1Result[] | { readonly replay: string }> {
  try {
    return await ctx.db.batch(statements);
  } catch (error) {
    if (ctx.requestId !== '') {
      const stored = await selectReplay(ctx).first<{ response: string }>();
      if (stored !== null) return { replay: stored.response };
    }
    throw error;
  }
}

function changes(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

/** Reads the request's replay (when it has an ID) and the link `key` in one round trip. */
async function readForWrite(ctx: WriteContext, key: string, extra: D1PreparedStatement[] = []): Promise<{ replay: string | null; row: LinkRow | null; extra: D1Result[] }> {
  const statements = [...(ctx.requestId === '' ? [] : [selectReplay(ctx)]), selectLink(ctx.db, key), ...extra];
  const results = await ctx.db.batch(statements);
  const offset = ctx.requestId === '' ? 0 : 1;
  const replay = ctx.requestId === '' ? null : ((results[0]?.results[0] as { response: string } | undefined)?.response ?? null);
  const row = (results[offset]?.results[0] as LinkRow | undefined) ?? null;
  return { replay, row: present(row, ctx.now), extra: results.slice(offset + 1) };
}

/** After a conditional write changed nothing: why, from the link's state now. */
async function lostRace<T>(ctx: WriteContext, key: string, deleted: 'LINK_DELETED' | 'NOT_DELETED'): Promise<Outcome<T>> {
  const row = present(await selectLink(ctx.db, key).first<LinkRow>(), ctx.now);
  if (row === null) return failed('NOT_FOUND');
  if ((row.delete_time !== null) === (deleted === 'LINK_DELETED')) return failed(deleted, row);
  return failed('ETAG_MISMATCH', row);
}

// ---- reads ------------------------------------------------------------------------------------------------------

/** The link `key` (deleted or not), or null when it does not exist or is due for purging. */
export async function getLink(db: D1Database, key: string, now: number): Promise<LinkRow | null> {
  return present(await selectLink(db, key).first<LinkRow>(), now);
}

export interface ListQuery {
  /** Keys after this one (the page token's cursor), or null for the first page. */
  readonly after: string | null;
  /** ASCII-lower-cased literals that must each occur in the key, description, target or tags. */
  readonly literals: readonly string[];
  readonly showDeleted: boolean;
  readonly size: number;
}

/** One page of links in key order, and whether more follow. Purges what is due first (a write only when due). */
export async function listLinks(db: D1Database, query: ListQuery, now: number): Promise<{ rows: LinkRow[]; more: boolean }> {
  const conditions = ['key > ?', '(purge_time IS NULL OR purge_time > ?)'];
  const values: unknown[] = [query.after ?? '', now];
  if (!query.showDeleted) conditions.push('delete_time IS NULL');
  for (const literal of query.literals) {
    conditions.push('(instr(lower(key), ?) > 0 OR instr(lower(description), ?) > 0 OR instr(lower(target), ?) > 0 OR instr(lower(tags), ?) > 0)');
    values.push(literal, literal, literal, literal);
  }
  const select = db.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE ${conditions.join(' AND ')} ORDER BY key LIMIT ?`).bind(...values, query.size + 1);
  const results = await db.batch([...purgeStatements(db, now), select]);
  const rows = (results[PURGES]?.results ?? []) as LinkRow[];
  return { rows: rows.slice(0, query.size), more: rows.length > query.size };
}

/** One page of the live (not deleted) links in key order, after the key `after`, and whether more follow. */
export async function exportLinks(db: D1Database, after: string | null, size: number): Promise<{ rows: LinkRow[]; more: boolean }> {
  const { results } = await db.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE delete_time IS NULL AND key > ? ORDER BY key LIMIT ?`).bind(after ?? '', size + 1).all<LinkRow>();
  return { rows: results.slice(0, size), more: results.length > size };
}

/** The link and one page of its kept revisions, newest first, below revision `before` (null: from the newest). */
export async function listRevisions(db: D1Database, key: string, before: number | null, size: number, now: number): Promise<{ row: LinkRow | null; revisions: RevisionRow[]; more: boolean }> {
  const [link, revisions] = await db.batch([
    selectLink(db, key),
    db
      .prepare(`SELECT key, revision, create_time, ${CONTENT_COLUMNS} FROM link_revisions WHERE key = ? AND revision < ? ORDER BY revision DESC LIMIT ?`)
      .bind(key, before ?? Number.MAX_SAFE_INTEGER, size + 1),
  ]);
  const row = present((link?.results[0] as LinkRow | undefined) ?? null, now);
  const rows = (revisions?.results ?? []) as RevisionRow[];
  return { row, revisions: row === null ? [] : rows.slice(0, size), more: row !== null && rows.length > size };
}

// ---- writes -----------------------------------------------------------------------------------------------------------

/**
 * Creates `key` with `content` as revision 1. LINK_EXISTS when a link that is not due for purging holds the key
 * (deleted or not, AIP-164), LINKS_FULL at LINKS_MAX. `respond` writes the response that a repeat of the request ID
 * gets.
 */
export async function createLink(ctx: WriteContext, key: string, content: LinkContent, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow>> {
  const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM links WHERE purge_time IS NULL OR purge_time > ?').bind(ctx.now);
  const read = await readForWrite(ctx, key, [count]);
  if (read.replay !== null) return { kind: 'replay', response: read.replay };
  if (read.row !== null) return failed('LINK_EXISTS', read.row);
  if (((read.extra[0]?.results[0] as { n: number } | undefined)?.n ?? 0) >= LINKS_MAX) return failed('LINKS_FULL');
  const { now } = ctx;
  const row: LinkRow = { key, ...content, create_time: now, update_time: now, delete_time: null, purge_time: null, revision: 1, revision_time: now, etag: newEtag() };
  const statements = [
    ...purgeStatements(ctx.db, now),
    ctx.db
      .prepare(`INSERT INTO links (${LINK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`)
      .bind(row.key, row.target, row.path_mode, row.visibility, row.description, row.tags, row.expire_time, row.create_time, row.update_time, null, null, 1, now, row.etag),
    revisionStatement(ctx.db, key, row.etag),
    ...(ctx.requestId === '' ? [] : [logStatement(ctx, respond(row), key, row.etag)]),
  ];
  const results = await writeBatch(ctx, statements);
  if ('replay' in results) return { kind: 'replay', response: results.replay };
  if (changes(results[PURGES]) === 1) return ok(row);
  const current = present(await selectLink(ctx.db, key).first<LinkRow>(), now);
  if (current === null) throw new Error('the link was neither created nor found');
  return failed('LINK_EXISTS', current);
}

/** Writes `content` as the link's next revision, if the link still carries the etag of `row`. */
async function writeRevision(ctx: WriteContext, row: LinkRow, content: LinkContent, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow> | null> {
  const { now, db } = ctx;
  const next: LinkRow = { ...row, ...content, update_time: now, revision: row.revision + 1, revision_time: now, etag: newEtag() };
  const statements = [
    ...purgeStatements(db, now),
    db
      .prepare(
        `UPDATE links SET target = ?, path_mode = ?, visibility = ?, description = ?, tags = ?, expire_time = ?, update_time = ?, revision = ?,
         revision_time = ?, etag = ? WHERE key = ? AND etag = ? AND delete_time IS NULL`,
      )
      .bind(next.target, next.path_mode, next.visibility, next.description, next.tags, next.expire_time, now, next.revision, now, next.etag, row.key, row.etag),
    revisionStatement(db, row.key, next.etag),
    db.prepare('DELETE FROM link_revisions WHERE key = ? AND revision <= ?').bind(row.key, next.revision - REVISIONS_KEPT),
    ...(ctx.requestId === '' ? [] : [logStatement(ctx, respond(next), row.key, next.etag)]),
  ];
  const results = await writeBatch(ctx, statements);
  if ('replay' in results) return { kind: 'replay', response: results.replay };
  return changes(results[PURGES]) === 1 ? ok(next) : null;
}

/**
 * Replaces the link's content with `merge(current)` as a new revision (UpdateLink). With an `etag`, only if the link
 * still has it (ETAG_MISMATCH otherwise); without one, a concurrent change is merged into once more. Unchanged
 * content writes nothing and answers the link as it is.
 */
export async function updateLink(ctx: WriteContext, key: string, etag: string, merge: (row: LinkRow) => LinkContent, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow>> {
  for (let attempt = 0; ; attempt += 1) {
    const read = await readForWrite(ctx, key);
    if (read.replay !== null) return { kind: 'replay', response: read.replay };
    const row = read.row;
    if (row === null) return failed('NOT_FOUND');
    if (row.delete_time !== null) return failed('LINK_DELETED', row);
    if (etag !== '' && etag !== row.etag) return failed('ETAG_MISMATCH', row);
    const content = merge(row);
    if (sameContent(content, row)) return ok(row);
    const written = await writeRevision(ctx, row, content, respond);
    if (written !== null) return written;
    if (etag !== '' || attempt > 0) return lostRace(ctx, key, 'LINK_DELETED');
  }
}

/** Makes kept revision `revision` the link's content again, as a new revision (RollbackLink). */
export async function rollbackLink(ctx: WriteContext, key: string, revision: number, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow>> {
  const read = await readForWrite(ctx, key, [
    ctx.db.prepare(`SELECT key, revision, create_time, ${CONTENT_COLUMNS} FROM link_revisions WHERE key = ? AND revision = ?`).bind(key, revision),
  ]);
  if (read.replay !== null) return { kind: 'replay', response: read.replay };
  const row = read.row;
  if (row === null) return failed('NOT_FOUND');
  if (row.delete_time !== null) return failed('LINK_DELETED', row);
  const kept = read.extra[0]?.results[0] as RevisionRow | undefined;
  if (kept === undefined) return failed('REVISION_NOT_FOUND');
  const content: LinkContent = { target: kept.target, path_mode: kept.path_mode, visibility: kept.visibility, description: kept.description, tags: kept.tags, expire_time: kept.expire_time };
  if (sameContent(content, row)) return ok(row);
  return (await writeRevision(ctx, row, content, respond)) ?? lostRace(ctx, key, 'LINK_DELETED');
}

/** Soft-deletes the link (AIP-164): it stops resolving now and is purged PURGE_AFTER_MS later. */
export async function deleteLink(ctx: WriteContext, key: string, etag: string, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow>> {
  return setDeleted(ctx, key, etag, true, respond);
}

/** Restores a deleted link that is not purged yet (AIP-164). */
export async function undeleteLink(ctx: WriteContext, key: string, etag: string, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow>> {
  return setDeleted(ctx, key, etag, false, respond);
}

async function setDeleted(ctx: WriteContext, key: string, etag: string, deleted: boolean, respond: (row: LinkRow) => string): Promise<Outcome<LinkRow>> {
  const read = await readForWrite(ctx, key);
  if (read.replay !== null) return { kind: 'replay', response: read.replay };
  const row = read.row;
  if (row === null) return failed('NOT_FOUND');
  if ((row.delete_time !== null) === deleted) return failed(deleted ? 'LINK_DELETED' : 'NOT_DELETED', row);
  if (etag !== '' && etag !== row.etag) return failed('ETAG_MISMATCH', row);
  const { now, db } = ctx;
  const next: LinkRow = { ...row, update_time: now, delete_time: deleted ? now : null, purge_time: deleted ? now + PURGE_AFTER_MS : null, etag: newEtag() };
  const statements = [
    ...purgeStatements(db, now),
    db
      .prepare('UPDATE links SET delete_time = ?, purge_time = ?, update_time = ?, etag = ? WHERE key = ? AND etag = ?')
      .bind(next.delete_time, next.purge_time, now, next.etag, key, row.etag),
    ...(ctx.requestId === '' ? [] : [logStatement(ctx, respond(next), key, next.etag)]),
  ];
  const results = await writeBatch(ctx, statements);
  if ('replay' in results) return { kind: 'replay', response: results.replay };
  return changes(results[PURGES]) === 1 ? ok(next) : lostRace(ctx, key, deleted ? 'LINK_DELETED' : 'NOT_DELETED');
}

// ---- import -----------------------------------------------------------------------------------------------------------

/** One valid import line. */
export interface ImportItem {
  readonly line: number;
  readonly key: string;
  readonly content: LinkContent;
}

export type ImportReason = 'LINK_EXISTS' | 'LINK_DELETED' | 'LINKS_FULL';

export interface ImportResult {
  readonly created: number;
  readonly replaced: number;
  readonly problems: readonly { readonly line: number; readonly reason: ImportReason }[];
}

/**
 * Creates the items' links, or replaces live ones with `overwrite`, in one batch: new links as revision 1,
 * replacements as their next revision. A key a deleted link holds is never replaced; creations stop at LINKS_MAX.
 * `respond` writes the response a repeat of the request ID gets.
 */
export async function importLinks(ctx: WriteContext, items: readonly ImportItem[], overwrite: boolean, respond: (result: ImportResult) => string): Promise<Outcome<ImportResult>> {
  const { db, now } = ctx;
  const keys = JSON.stringify(items.map((item) => item.key));
  const reads = [
    ...(ctx.requestId === '' ? [] : [selectReplay(ctx)]),
    db.prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE key IN (SELECT value FROM json_each(?))`).bind(keys),
    db.prepare('SELECT COUNT(*) AS n FROM links WHERE purge_time IS NULL OR purge_time > ?').bind(now),
  ];
  const results = await db.batch(reads);
  const offset = ctx.requestId === '' ? 0 : 1;
  const replay = ctx.requestId === '' ? undefined : (results[0]?.results[0] as { response: string } | undefined)?.response;
  if (replay !== undefined) return { kind: 'replay', response: replay };
  const existing = new Map(((results[offset]?.results ?? []) as LinkRow[]).flatMap((row) => (present(row, now) === null ? [] : [[row.key, row] as const])));
  let room = LINKS_MAX - ((results[offset + 1]?.results[0] as { n: number } | undefined)?.n ?? 0);
  const creates: Record<string, unknown>[] = [];
  const replaces: Record<string, unknown>[] = [];
  const written: { k: string; e: string }[] = [];
  const problems: { line: number; reason: ImportReason }[] = [];
  for (const { line, key, content } of items) {
    const row = existing.get(key);
    const etag = newEtag();
    const values = { k: key, t: content.target, m: content.path_mode, v: content.visibility, d: content.description, g: content.tags, x: content.expire_time, e: etag };
    if (row === undefined) {
      if (room <= 0) {
        problems.push({ line, reason: 'LINKS_FULL' });
        continue;
      }
      room -= 1;
      creates.push(values);
    } else if (row.delete_time !== null) {
      problems.push({ line, reason: 'LINK_DELETED' });
      continue;
    } else if (!overwrite) {
      problems.push({ line, reason: 'LINK_EXISTS' });
      continue;
    } else if (sameContent(content, row)) {
      // Nothing to replace: counted as replaced, written as nothing.
      replaces.push({ ...values, same: true });
      continue;
    } else {
      replaces.push({ ...values, o: row.etag, r: row.revision + 1 });
    }
    written.push({ k: key, e: etag });
  }
  const changed = replaces.filter((item) => item['same'] !== true);
  const result: ImportResult = { created: creates.length, replaced: replaces.length, problems };
  if (written.length === 0) return ok(result);
  const statements = [
    ...purgeStatements(db, now),
    db
      .prepare(
        `INSERT INTO links (${LINK_COLUMNS})
         SELECT j.value->>'k', j.value->>'t', j.value->>'m', j.value->>'v', j.value->>'d', j.value->>'g', j.value->>'x', ?, ?, NULL, NULL, 1, ?, j.value->>'e'
         FROM json_each(?) AS j WHERE true ON CONFLICT (key) DO NOTHING`,
      )
      .bind(now, now, now, JSON.stringify(creates)),
    db
      .prepare(
        `UPDATE links SET target = j.value->>'t', path_mode = j.value->>'m', visibility = j.value->>'v', description = j.value->>'d', tags = j.value->>'g',
         expire_time = j.value->>'x', update_time = ?, revision = j.value->>'r', revision_time = ?, etag = j.value->>'e'
         FROM json_each(?) AS j WHERE links.key = j.value->>'k' AND links.etag = j.value->>'o' AND links.delete_time IS NULL`,
      )
      .bind(now, now, JSON.stringify(changed)),
    db
      .prepare(
        `INSERT INTO link_revisions (key, revision, create_time, ${CONTENT_COLUMNS})
         SELECT l.key, l.revision, l.revision_time, l.target, l.path_mode, l.visibility, l.description, l.tags, l.expire_time
         FROM links AS l JOIN json_each(?) AS j ON l.key = j.value->>'k' AND l.etag = j.value->>'e'`,
      )
      .bind(JSON.stringify(written)),
    db
      .prepare(
        `DELETE FROM link_revisions WHERE EXISTS (SELECT 1 FROM json_each(?) AS j
         WHERE j.value->>'k' = link_revisions.key AND link_revisions.revision <= (j.value->>'r') - ?)`,
      )
      .bind(JSON.stringify(changed), REVISIONS_KEPT),
    ...(ctx.requestId === '' ? [] : [ctx.db.prepare('INSERT INTO request_log (request_id, response, create_time) VALUES (?, ?, ?)').bind(ctx.requestId, respond(result), now)]),
  ];
  const outcome = await writeBatch(ctx, statements);
  if ('replay' in outcome) return { kind: 'replay', response: outcome.replay };
  return ok(result);
}
