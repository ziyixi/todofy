// The retention window (src/retention.ts, ../../docs/design.md §2.3) on synthetic rows in Node's SQLite: a text
// captured before the window leaves Cloudflare only when the Dropbox archive confirmed it (connected and not failing,
// its blob written to this target with Dropbox's content hash, its day file written since, state.json past its seq)
// and its page is live; the boundary; at most RETENTION_BATCH a step, in one R2 call; the index row reduced to title
// and URL and the page's digest forgotten for its latest text; the totals; no tombstone and no seq; a deleted page's
// archived texts leaving the totals; schema 3 migrated again after a rollback wrote version 2 back.
import { describe, expect, it } from 'vitest';
import { writeIndexRow } from '../src/fts.ts';
import { DAY, RETENTION_BATCH, TEXT_RETENTION_DEFAULT_DAYS } from '../src/limits.ts';
import { deletePage, purgeStep, retentionStep } from '../src/retention.ts';
import { readRetention, writeSettings } from '../src/settings.ts';
import { hostKey, utcDay, type Store } from '../src/store.ts';
import { memoryStore } from './sqlite.ts';

const NOW = Date.parse('2027-12-01T04:00:00Z');
const TARGET = 'dbid:AASynthetic syntheticappkey1';
const DEVICE = { device_id: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', device_label: 'MacBook · 工作' };
const transact = <T>(fn: () => T): T => fn();

/** A bucket that records its delete calls. */
function bucket(): { readonly bucket: R2Bucket; readonly calls: string[][] } {
  const calls: string[][] = [];
  const fake = {
    delete: (keys: string | string[]) => {
      calls.push(Array.isArray(keys) ? keys : [keys]);
      return Promise.resolve();
    },
  };
  return { bucket: fake as unknown as R2Bucket, calls };
}

/** A store connected to Dropbox whose last pass succeeded up to `synced`. */
function connectedStore(synced = 1_000_000): Store {
  const store = memoryStore();
  store.setMeta('dropbox_refresh_token', 'synthetic-refresh');
  store.setMeta('dropbox_app_key', 'syntheticappkey1');
  store.setMeta('archive_target', TARGET);
  store.setMeta('archive_seq', String(synced));
  store.setMeta('seq', String(synced));
  return store;
}

let pages = 0;

/** A live page with one index row; answers its rowid. */
function page(store: Store, title = 'Guide'): number {
  pages += 1;
  const url = `https://docs.example.com/p/${String(pages)}`;
  store.insert('pages', { id: pages.toString(16).padStart(32, '0'), url, title, host_key: hostKey('docs.example.com'), first_visit_ms: 0, last_visit_ms: 0 });
  const rowid = Number(store.one<{ rowid: number }>(`SELECT rowid FROM pages WHERE url = ?`, url)?.rowid);
  writeIndexRow(store, rowid, title, url, '', false);
  return rowid;
}

interface DocOptions {
  readonly captureMs: number;
  readonly seq: number;
  /** Written to Dropbox: this target with a content hash (default), another target, a conflict, or not at all. */
  readonly blob?: 'confirmed' | 'other_target' | 'conflict' | 'none';
  /** The day file: written (default), dirty again, or never written. */
  readonly day?: 'written' | 'dirty' | 'unwritten';
  /** The page's latest text, indexed with these words. */
  readonly latest?: string;
}

let docs = 0;

/** A document of `pageRowid` with its R2 blob's ledger rows; answers its ID. */
function doc(store: Store, pageRowid: number, options: DocOptions): string {
  docs += 1;
  const id = `00000000-0000-4000-8000-${docs.toString(16).padStart(12, '0')}`;
  const path = `2026/10/${id}.txt.gz`;
  const seqMs = options.captureMs + 60_000;
  store.insert('documents', {
    id,
    seq: options.seq,
    seq_ms: seqMs,
    page_rowid: pageRowid,
    visit: id,
    ...DEVICE,
    capture_ms: options.captureMs,
    url: 'https://docs.example.com/',
    url_truncated: 0,
    title: 'Guide',
    description: '',
    blob_path: path,
    sha256: 'a'.repeat(64),
    stored_bytes: 1000,
    text_bytes: 3000,
    text_sha256: `digest-${id}`,
    truncated: 0,
  });
  store.addCounters({ document_count: 1, blob_bytes: 1000 });
  const blob = options.blob ?? 'confirmed';
  if (blob !== 'none') store.insert('archive_blobs', { path, target: blob === 'other_target' ? 'dbid:other otherappkey2' : TARGET, content_hash: blob === 'conflict' ? '' : 'b'.repeat(64) });
  const day = utcDay(seqMs);
  const state = options.day ?? 'written';
  store.run(
    `INSERT INTO archive_days (day, min_seq, max_seq, dirty, content_hash) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (day) DO UPDATE SET dirty = excluded.dirty, content_hash = excluded.content_hash`,
    day,
    options.seq,
    options.seq,
    state === 'written' ? 0 : 1,
    state === 'unwritten' ? null : 'c'.repeat(64),
  );
  if (options.latest !== undefined) {
    const row = store.one<{ title: string; url: string }>(`SELECT title, url FROM pages WHERE rowid = ?`, pageRowid);
    writeIndexRow(store, pageRowid, row?.title ?? '', row?.url ?? '', options.latest, true);
    store.run(`UPDATE pages SET latest_document = ?, latest_capture_ms = ?, latest_text_sha256 = ?, text_indexed = ?, document_count = document_count + 1 WHERE rowid = ?`, id, options.captureMs, `digest-${id}`, 500, pageRowid);
    store.addCounter('indexed_text_bytes', 500);
  }
  return id;
}

const old = NOW - (TEXT_RETENTION_DEFAULT_DAYS + 10) * DAY;
const archived = (store: Store, id: string) => store.one<{ archived_ms: number | null }>(`SELECT archived_ms FROM documents WHERE id = ?`, id)?.archived_ms ?? null;
const matches = (store: Store, word: string) => store.all<{ rowid: number }>(`SELECT rowid FROM fts WHERE fts MATCH ?`, `"${word}"`).map((row) => row.rowid);

describe('schema 3', () => {
  it('migrates again after a rollback wrote version 2 back, keeping what retention recorded', () => {
    const store = connectedStore();
    const id = doc(store, page(store), { captureMs: old, seq: 1 });
    store.run(`UPDATE documents SET archived_ms = ? WHERE id = ?`, NOW, id);
    store.setMeta('schema_version', '2');
    expect(() => {
      store.migrate();
    }).not.toThrow();
    expect([store.getMeta('schema_version'), archived(store, id)]).toEqual(['5', NOW]);
  });
});

describe('the retention window setting', () => {
  it('is seven days until the owner changes it, can be off, and reads a value it did not write as the default', () => {
    const store = memoryStore();
    expect(readRetention(store)).toBe(7);
    writeSettings(store, { retentionDays: 30 }, NOW);
    expect(readRetention(store)).toBe(30);
    writeSettings(store, { retentionDays: null }, NOW);
    expect(readRetention(store)).toBeNull();
    store.setMeta('text_retention_days', '6');
    expect(readRetention(store)).toBe(7);
  });

  it('changes the settings etag, so another tab cannot overwrite it unseen', () => {
    const store = memoryStore();
    const before = store.getMeta('denylist_etag');
    writeSettings(store, { retentionDays: 90 }, NOW);
    expect(store.getMeta('denylist_etag')).not.toBe(before);
  });
});

describe('a retention step', () => {
  it('removes nothing while Dropbox is not connected, or while its last attempt failed', async () => {
    const store = connectedStore();
    const id = doc(store, page(store), { captureMs: old, seq: 1 });
    store.deleteMeta('dropbox_refresh_token');
    const r2 = bucket();
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(false);
    store.setMeta('dropbox_refresh_token', 'synthetic-refresh');
    store.setMeta('archive_failures', '1');
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(false);
    // A new target before its first state.json confirms nothing either.
    store.deleteMeta('archive_failures', 'archive_seq');
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(false);
    expect([r2.calls, archived(store, id)]).toEqual([[], null]);
  });

  it('removes nothing while the window is off', async () => {
    const store = connectedStore();
    const id = doc(store, page(store), { captureMs: old, seq: 1 });
    writeSettings(store, { retentionDays: null }, NOW);
    expect(await retentionStep(store, bucket().bucket, transact, NOW)).toBe(false);
    expect(archived(store, id)).toBeNull();
  });

  it('takes only texts the archive confirmed, of live pages', async () => {
    const store = connectedStore(100);
    const kept = [
      doc(store, page(store), { captureMs: old, seq: 1, blob: 'none' }),
      doc(store, page(store), { captureMs: old, seq: 2, blob: 'other_target' }),
      doc(store, page(store), { captureMs: old, seq: 3, blob: 'conflict' }),
      doc(store, page(store), { captureMs: old - DAY, seq: 4, day: 'dirty' }),
      doc(store, page(store), { captureMs: old - 2 * DAY, seq: 5, day: 'unwritten' }),
      // Committed after the last state.json: not vouched for yet.
      doc(store, page(store), { captureMs: old - 3 * DAY, seq: 101 }),
    ];
    // A deleted page's text (its page row gone, its rows waiting for the purge).
    const gonePage = page(store);
    const gone = doc(store, gonePage, { captureMs: old - 4 * DAY, seq: 6 });
    store.run(`DELETE FROM pages WHERE rowid = ?`, gonePage);
    const taken = doc(store, page(store), { captureMs: old - 5 * DAY, seq: 7 });
    const r2 = bucket();
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(false);
    expect(r2.calls).toEqual([[`blobs/2026/10/${taken}.txt.gz`]]);
    expect(archived(store, taken)).toBe(NOW);
    for (const id of [...kept, gone]) expect(archived(store, id)).toBeNull();
  });

  it('keeps a text captured exactly at the window, and takes one a millisecond older', async () => {
    const store = connectedStore();
    writeSettings(store, { retentionDays: 30 }, NOW);
    const edge = doc(store, page(store), { captureMs: NOW - 30 * DAY, seq: 1 });
    const older = doc(store, page(store), { captureMs: NOW - 30 * DAY - 1, seq: 2 });
    await retentionStep(store, bucket().bucket, transact, NOW);
    expect([archived(store, edge), archived(store, older)]).toEqual([null, NOW]);
  });

  it("keeps the search index and text digest while removing archived files; no tombstone, no seq", async () => {
    const store = connectedStore(50);
    const rowid = page(store, 'Durable guide');
    const earlier = doc(store, rowid, { captureMs: old - DAY, seq: 1 });
    const latest = doc(store, rowid, { captureMs: old, seq: 2, latest: 'alarm storage notes' });
    const other = page(store, 'Other');
    doc(store, other, { captureMs: NOW - DAY, seq: 3, latest: 'alarm recent notes' });
    expect(matches(store, 'storage')).toEqual([rowid]);
    const head = store.headSeq();
    expect(await retentionStep(store, bucket().bucket, transact, NOW)).toBe(false);
    expect([archived(store, earlier), archived(store, latest)]).toEqual([NOW, NOW]);
    // File rotation preserves indexed words on both old and recent pages.
    expect(matches(store, 'storage')).toEqual([rowid]);
    expect(matches(store, 'alarm')).toEqual([rowid, other]);
    expect(matches(store, 'durable')).toEqual([rowid]);
    expect(store.one(`SELECT text_indexed, latest_text_sha256, latest_document FROM pages WHERE rowid = ?`, rowid)).toEqual({ text_indexed: 500, latest_text_sha256: `digest-${latest}`, latest_document: latest });
    expect([store.counter('archived_count'), store.counter('document_count'), store.counter('blob_bytes'), store.counter('indexed_text_bytes')]).toEqual([2, 3, 1000, 1000]);
    expect(store.count(`SELECT count(*) AS n FROM tombstones`)).toBe(0);
    expect(store.headSeq()).toBe(head);
    expect(store.all(`SELECT seq FROM documents ORDER BY seq`)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    // Nothing is taken twice.
    const r2 = bucket();
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(false);
    expect(r2.calls).toEqual([]);
  });

  it('takes at most RETENTION_BATCH texts a step, oldest first, in one R2 call', async () => {
    const store = connectedStore();
    const rowid = page(store);
    const total = 2 * RETENTION_BATCH + 50;
    for (let i = 0; i < total; i++) doc(store, rowid, { captureMs: old - i * 60_000, seq: i + 1 });
    const r2 = bucket();
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(true);
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(true);
    expect(await retentionStep(store, r2.bucket, transact, NOW)).toBe(false);
    expect(r2.calls.map((keys) => keys.length)).toEqual([RETENTION_BATCH, RETENTION_BATCH, 50]);
    // The oldest capture went first.
    expect(r2.calls[0]?.[0]).toBe(`blobs/2026/10/${store.one<{ id: string }>(`SELECT id FROM documents ORDER BY capture_ms LIMIT 1`)?.id ?? ''}.txt.gz`);
    expect(store.counter('archived_count')).toBe(total);
  });
});

describe('deleting a page with archived texts', () => {
  it('takes them off the totals, and the purge deletes only what R2 still holds', async () => {
    const store = connectedStore();
    const rowid = page(store);
    doc(store, rowid, { captureMs: old - DAY, seq: 1 });
    const recent = doc(store, rowid, { captureMs: NOW - DAY, seq: 2, latest: 'recent words' });
    await retentionStep(store, bucket().bucket, transact, NOW);
    expect([store.counter('archived_count'), store.counter('blob_bytes')]).toEqual([1, 1000]);
    store.run(`UPDATE pages SET document_count = 2 WHERE rowid = ?`, rowid);
    deletePage(store, store.one<{ id: string }>(`SELECT id FROM pages WHERE rowid = ?`, rowid)?.id ?? '', NOW);
    expect([store.counter('archived_count'), store.counter('document_count')]).toEqual([0, 0]);
    const r2 = bucket();
    expect(await purgeStep(store, r2.bucket, transact)).toBe(false);
    expect(r2.calls).toEqual([[`blobs/2026/10/${recent}.txt.gz`]]);
    expect(store.counter('blob_bytes')).toBe(0);
    // A tombstone for the deletion itself, none for retention.
    expect(store.count(`SELECT count(*) AS n FROM tombstones`)).toBe(1);
  });
});
