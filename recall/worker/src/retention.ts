/**
 * Deletion and the alarm's bounded work (../../docs/design.md §2.3, §5.4).
 *
 * DeletePage is one transaction of a few rows, however many visits the page has: the page row and its index row go,
 * its totals leave its site and the running counters, and one tombstone `pages/<page id>` is committed to the feed.
 * From then on the page's visits and documents join no live page, so they are gone from the API, the search and the
 * feed at once; right after it the page's texts leave R2 (deletes are free and write no row, and the blob route reads
 * R2 without asking the object), and the alarm removes the rows later (PURGE_BATCH rows a run).
 *
 * The alarm runs once a day (ALARM_HOUR_UTC), and a minute later again while work is left: the purges, the small
 * tables' cleanup, and the index budget, which moves the oldest pages' texts out of the index (their title and URL
 * stay; R2 and every archive keep the text) while the index holds over INDEXED_TEXT_BUDGET_BYTES of text or the
 * database passes STORAGE_HIGH_MIB. Purges and demotions write rows, so both stop for the day once today's rows written
 * reach MAINTENANCE_ROW_LIMIT, leaving the rest of the daily budget to uploads, and go on the next day.
 */
import { deleteBlobs } from './blobs.ts';
import { deleteIndexRow, writeIndexRow } from './fts.ts';
import { ALARM_HOUR_UTC, DAY, DEMOTE_BATCH, HOUR, INDEXED_TEXT_BUDGET_BYTES, MAINTENANCE_ROW_LIMIT, MIB, PURGE_BATCH, STORAGE_HIGH_MIB } from './limits.ts';
import { utcDay, type PageRow, type Store } from './store.ts';

/** Deletes a live page and answers its rowid (null when there is none); runs inside the caller's transaction. */
export function deletePage(store: Store, pageId: string, now: number): number | null {
  const page = store.one<PageRow>(`SELECT * FROM pages WHERE id = ?`, pageId);
  if (page === undefined) return null;
  deleteIndexRow(store, page.rowid);
  store.run(`DELETE FROM pages WHERE rowid = ?`, page.rowid);
  if (store.one(`SELECT 1 AS x FROM pages WHERE host_key = ? LIMIT 1`, page.host_key) === undefined) {
    store.run(`DELETE FROM sites WHERE host_key = ?`, page.host_key);
  } else {
    store.run(
      `UPDATE sites SET visit_count = max(0, visit_count - ?), focus_seconds = max(0, focus_seconds - ?) WHERE host_key = ?`,
      page.visit_count,
      page.focus_seconds,
      page.host_key,
    );
  }
  const seqs = store.seqs();
  store.run(`INSERT INTO tombstones (id, seq, seq_ms, page_id) VALUES (?, ?, ?, ?)`, crypto.randomUUID(), seqs.next(), now, page.id);
  seqs.commit();
  store.run(`INSERT INTO purges (page_rowid, page_id, started_ms) VALUES (?, ?, ?)`, page.rowid, page.id, now);
  store.addCounters({ page_count: -1, visit_count: -page.visit_count, document_count: -page.document_count, indexed_text_bytes: -page.text_indexed });
  return page.rowid;
}

/**
 * The R2 objects of a deleted page's texts, right after its deletion (at most PURGE_BATCH; the alarm's purge deletes
 * any left, and again those whose delete failed here). Reads only.
 */
export async function deletePageBlobs(store: Store, bucket: R2Bucket, pageRowid: number): Promise<void> {
  const documents = store.all<{ blob_path: string }>(`SELECT blob_path FROM documents WHERE page_rowid = ? LIMIT ?`, pageRowid, PURGE_BATCH);
  if (documents.length === 0) return;
  try {
    await deleteBlobs(bucket, documents.map((row) => row.blob_path));
  } catch {
    // The alarm's purge deletes them before their rows.
  }
}

/** Whether the alarm's row-writing work (purges, demotions) may still run today. */
export function maintenanceAllowed(store: Store, now: number): boolean {
  return store.usage(utcDay(now)).rows_written < MAINTENANCE_ROW_LIMIT;
}

/**
 * One purge step: at most PURGE_BATCH rows of the oldest deleted page, its documents first (their R2 objects deleted
 * before their rows, so a failure leaves rows to try again), then its visits, then its purges row once nothing is
 * left. Answers whether purges remain. The caller checks maintenanceAllowed first.
 */
export async function purgeStep(store: Store, bucket: R2Bucket, transact: <T>(fn: () => T) => T): Promise<boolean> {
  const purge = store.one<{ page_rowid: number }>(`SELECT page_rowid FROM purges ORDER BY started_ms, page_rowid LIMIT 1`);
  if (purge === undefined) return false;
  const documents = store.all<{ id: string; blob_path: string; stored_bytes: number }>(
    `SELECT id, blob_path, stored_bytes FROM documents WHERE page_rowid = ? LIMIT ?`,
    purge.page_rowid,
    PURGE_BATCH,
  );
  if (documents.length > 0) await deleteBlobs(bucket, documents.map((row) => row.blob_path));
  transact(() => {
    for (const row of documents) store.run(`DELETE FROM documents WHERE id = ?`, row.id);
    store.addCounter('blob_bytes', -documents.reduce((sum, row) => sum + row.stored_bytes, 0));
    const room = PURGE_BATCH - documents.length;
    if (room > 0) store.run(`DELETE FROM visits WHERE rowid IN (SELECT rowid FROM visits WHERE page_rowid = ? LIMIT ?)`, purge.page_rowid, room);
    const left =
      store.one(`SELECT 1 AS x FROM documents WHERE page_rowid = ? LIMIT 1`, purge.page_rowid) ?? store.one(`SELECT 1 AS x FROM visits WHERE page_rowid = ? LIMIT 1`, purge.page_rowid);
    if (left === undefined) store.run(`DELETE FROM purges WHERE page_rowid = ?`, purge.page_rowid);
  });
  return store.one(`SELECT 1 AS x FROM purges LIMIT 1`) !== undefined;
}

/** Whether the index holds more than its budget: too much text, or a database past STORAGE_HIGH_MIB. */
export function indexOverBudget(store: Store): boolean {
  return store.counter('indexed_text_bytes') > INDEXED_TEXT_BUDGET_BYTES || store.databaseSize > STORAGE_HIGH_MIB * MIB;
}

/**
 * One step of the index budget: up to DEMOTE_BATCH pages with the oldest indexed texts keep only their title and URL
 * in the index, and oldest_indexed_text_ms records where the text index now starts. Answers whether the index is still
 * over its budget. The caller checks maintenanceAllowed first.
 */
export function demoteStep(store: Store, now: number): boolean {
  if (!indexOverBudget(store)) return false;
  const pages = store.all<{ rowid: number; title: string; url: string; text_indexed: number }>(
    `SELECT rowid, title, url, text_indexed FROM pages WHERE text_indexed > 0 ORDER BY latest_capture_ms LIMIT ?`,
    DEMOTE_BATCH,
  );
  let indexed = store.counter('indexed_text_bytes');
  const largeDatabase = store.databaseSize > STORAGE_HIGH_MIB * MIB;
  for (const page of pages) {
    // Too much text: stop once the budget holds. A large database: the whole batch (the tables take the room).
    if (indexed <= INDEXED_TEXT_BUDGET_BYTES && !largeDatabase) break;
    writeIndexRow(store, page.rowid, page.title, page.url, '', true);
    store.run(`UPDATE pages SET text_indexed = 0 WHERE rowid = ?`, page.rowid);
    indexed -= page.text_indexed;
  }
  store.addCounter('indexed_text_bytes', indexed - store.counter('indexed_text_bytes'));
  if (pages.length > 0) {
    const oldest = store.one<{ ms: number | null }>(`SELECT min(latest_capture_ms) AS ms FROM pages WHERE text_indexed > 0`)?.ms ?? null;
    store.setMeta('oldest_indexed_text_ms', String(oldest ?? now));
  }
  return pages.length > 0 && indexOverBudget(store);
}

/** The next daily run: ALARM_HOUR_UTC today when it is still ahead, else tomorrow. */
export function nextDailyRun(now: number): number {
  const today = Math.floor(now / DAY) * DAY + ALARM_HOUR_UTC * HOUR;
  return today > now ? today : today + DAY;
}
