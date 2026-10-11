// The archive's files (src/archive.ts) against contracts/recall-archive-v1's golden archive, byte for byte: rows
// holding the fixtures' synthetic records give fixtures/archive/'s day file, state.json and VERSION. And the scan that
// finds the days to write: bounded, complete only up to what it read, a day's rows read by its seq range and its date.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { anyDirty, dayPath, dirtyDays, renderDay, scannedSeq, scanStep, stateText, VERSION_TEXT, type DayRow } from '../src/archive.ts';
import { hostKey, type Store } from '../src/store.ts';
import { memoryStore } from './sqlite.ts';

const FIXTURES = new URL('../../../contracts/recall-archive-v1/fixtures/', import.meta.url);
const fixture = (path: string) => readFileSync(fileURLToPath(new URL(path, FIXTURES).href), 'utf8');
const at = (iso: string) => Date.parse(iso);
const DEVICE = { device_id: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', device_label: 'MacBook · 工作' };
const FEED = '0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f';

function page(store: Store, id: string, url: string, host: string): void {
  store.insert('pages', { id, url, host_key: hostKey(host), first_visit_ms: 0, last_visit_ms: 0 });
}

function visit(store: Store, row: { id: string; seq: number; seqMs: number; pageRowid: number; url: string; title: string; spans: [string, string][] }): void {
  const spans = row.spans.map(([start, end]) => [at(start), at(end)]);
  store.insert('visits', {
    id: row.id,
    seq: row.seq,
    seq_ms: row.seqMs,
    page_rowid: row.pageRowid,
    ...DEVICE,
    url: row.url,
    url_truncated: 0,
    title: row.title,
    start_ms: spans[0]?.[0] ?? 0,
    end_ms: spans[spans.length - 1]?.[1] ?? 0,
    focus_seconds: Math.round(spans.reduce((sum, [start = 0, end = 0]) => sum + end - start, 0) / 1000),
    spans: JSON.stringify(spans),
    revision: 1,
  });
}

/** The records of fixtures/ChangePage/first-page.json as RecallState holds them: seq 2, 3 and 5, committed on 10 October. */
function fixtureStore(): Store {
  const store = memoryStore();
  store.setMeta('feed_id', FEED);
  store.setMeta('seq', '5');
  page(store, '3cb732b26093d5571ec48a363db593b2', 'https://docs.example.com/guide/durable-objects', 'docs.example.com');
  page(store, 'f9735ed632fb5291d9bc44726777dbd8', 'https://news.example.org/2026/10/sqlite-fts5-chinese', 'news.example.org');
  visit(store, {
    id: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01',
    seq: 2,
    seqMs: at('2026-10-10T02:05:00Z'),
    pageRowid: 1,
    url: 'https://docs.example.com/guide/durable-objects',
    title: 'Durable Objects 入门 · Example Docs',
    spans: [
      ['2026-10-10T02:00:05Z', '2026-10-10T02:02:10Z'],
      ['2026-10-10T02:02:30Z', '2026-10-10T02:03:41Z'],
    ],
  });
  store.insert('documents', {
    id: '7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01',
    seq: 3,
    seq_ms: at('2026-10-10T02:05:00Z'),
    page_rowid: 1,
    visit: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01',
    ...DEVICE,
    capture_ms: at('2026-10-10T02:00:15.250Z'),
    url: 'https://docs.example.com/guide/durable-objects',
    url_truncated: 0,
    title: 'Durable Objects 入门 · Example Docs',
    description: '一篇合成的示例文档：Durable Object、SQLite 存储与 alarm。',
    blob_path: '2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz',
    sha256: '6439c89dc81886b6bd18e091105aeb31cb92aca181cefedc4d0068fba0b09bf5',
    stored_bytes: 185,
    text_bytes: 181,
    text_sha256: 'unused',
    truncated: 0,
  });
  visit(store, {
    id: 'a4b5c6d7-8e9f-4a0b-b1c2-d3e4f5a6b702',
    seq: 5,
    seqMs: at('2026-10-10T02:06:00Z'),
    pageRowid: 2,
    url: 'https://news.example.org/2026/10/sqlite-fts5-chinese',
    title: '用 FTS5 做中文搜索 | Example News',
    spans: [['2026-10-10T02:04:02Z', '2026-10-10T02:04:10Z']],
  });
  return store;
}

describe('the golden archive', () => {
  it('a scan marks the day its changes were committed on, with their seq range', () => {
    const store = fixtureStore();
    expect(scanStep(store, 100)).toBe(true);
    expect(scannedSeq(store)).toBe(5);
    expect(dirtyDays(store, 10)).toEqual([{ day: '2026-10-10', min_seq: 2, max_seq: 5, dirty: 1, content_hash: null }]);
    expect(dayPath('2026-10-10')).toBe('changes/2026/10/10.jsonl');
  });

  it("renders fixtures/archive/'s day file, state.json and VERSION byte for byte", () => {
    const store = fixtureStore();
    scanStep(store, 100);
    const [day] = dirtyDays(store, 1) as [DayRow];
    const file = renderDay(store, day);
    expect(file.text).toBe(fixture('archive/changes/2026/10/10.jsonl'));
    expect(file.count).toBe(3);
    expect(file.blobs).toEqual([{ path: '2026/10/7c2e9f41-3b6a-4d5e-8f10-2a9b4c6d8e01.txt.gz', sha256: '6439c89dc81886b6bd18e091105aeb31cb92aca181cefedc4d0068fba0b09bf5', size: 185 }]);
    expect(stateText(FEED, 'https://recall.example.com', 5, at('2026-10-10T02:15:07Z'))).toBe(fixture('archive/state.json'));
    expect(stateText(FEED, 'https://recall.example.com', 5, at('2026-10-10T02:15:07Z'))).toBe(fixture('ArchiveState/synced.json'));
    expect(VERSION_TEXT).toBe(fixture('archive/VERSION'));
  });

  it("leaves a deleted page's records and a superseded record's older line out of a day written again", () => {
    const store = fixtureStore();
    scanStep(store, 100);
    store.run(`DELETE FROM pages WHERE rowid = 1`);
    const [day] = dirtyDays(store, 1) as [DayRow];
    expect(renderDay(store, day).text.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([5]);
  });
});

describe('the scan', () => {
  it('reads a bounded number of changes a step and is complete only up to what every table gave', () => {
    const store = memoryStore();
    page(store, 'a'.repeat(32), 'https://example.com/a', 'example.com');
    // Five visits on 1, 2 and 3 October and a tombstone on 3 October.
    const days = ['2026-10-01T10:00:00Z', '2026-10-01T23:00:00Z', '2026-10-02T09:00:00Z', '2026-10-03T08:00:00Z', '2026-10-03T09:00:00Z'];
    days.forEach((iso, index) => {
      visit(store, { id: `00000000-0000-4000-8000-00000000000${String(index)}`, seq: index + 1, seqMs: at(iso), pageRowid: 1, url: 'https://example.com/a', title: 'A', spans: [[iso, iso]] });
    });
    store.insert('tombstones', { id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a05', seq: 6, seq_ms: at('2026-10-03T10:00:00Z'), page_id: 'b'.repeat(32) });
    store.setMeta('seq', '6');
    expect(scanStep(store, 2)).toBe(false);
    // The visits gave 2 (a full read), so only seq 1 and 2 are accounted for.
    expect(scannedSeq(store)).toBe(2);
    expect(dirtyDays(store, 10).map((row) => row.day)).toEqual(['2026-10-01']);
    expect(scanStep(store, 2)).toBe(false);
    expect(scanStep(store, 2)).toBe(true);
    expect(scannedSeq(store)).toBe(6);
    expect(dirtyDays(store, 10).map((row) => [row.day, row.min_seq, row.max_seq])).toEqual([
      ['2026-10-03', 4, 6],
      ['2026-10-02', 3, 3],
      ['2026-10-01', 1, 2],
    ]);
    expect(scanStep(store, 2)).toBe(true);
    store.run(`UPDATE archive_days SET dirty = 0`);
    expect(anyDirty(store)).toBe(false);
  });

  it("files a change by its own commit day, even when its seq lies inside another day's range", () => {
    const store = memoryStore();
    page(store, 'a'.repeat(32), 'https://example.com/a', 'example.com');
    // A deletion committed seq 2 just after midnight while an upload begun before midnight committed seq 3.
    visit(store, { id: '00000000-0000-4000-8000-000000000001', seq: 1, seqMs: at('2026-10-01T23:59:00Z'), pageRowid: 1, url: 'https://example.com/a', title: 'A', spans: [['2026-10-01T23:58:00Z', '2026-10-01T23:58:30Z']] });
    store.insert('tombstones', { id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a05', seq: 2, seq_ms: at('2026-10-02T00:00:01Z'), page_id: 'b'.repeat(32) });
    visit(store, { id: '00000000-0000-4000-8000-000000000003', seq: 3, seqMs: at('2026-10-01T23:59:59Z'), pageRowid: 1, url: 'https://example.com/a', title: 'A', spans: [['2026-10-01T23:59:00Z', '2026-10-01T23:59:30Z']] });
    store.setMeta('seq', '3');
    scanStep(store, 100);
    const days = dirtyDays(store, 10);
    expect(days.map((row) => [row.day, row.min_seq, row.max_seq])).toEqual([
      ['2026-10-02', 2, 2],
      ['2026-10-01', 1, 3],
    ]);
    const seqs = (row: DayRow) => renderDay(store, row).text.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(days.map(seqs)).toEqual([[2], [1, 3]]);
  });
});
