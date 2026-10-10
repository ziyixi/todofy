// The change feed's rendering (src/feed.ts) against contracts/recall-archive-v1's golden fixtures, byte for byte: rows
// holding the fixtures' synthetic records render exactly the fixtures' changes and page. And the feed's parameters.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChangePageSchema, ChangeSchema } from '@ziyixi/proto/recall/archive/v1/archive_pb';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { contentDigest, textBlobPath } from '../src/blobs.ts';
import { ARCHIVE_VERSION, documentChange, OLDEST_SEQ, parseFeedQuery, tombstoneChange, visitChange, type Joined } from '../src/feed.ts';
import { hostKey, type DocumentRow, type VisitRow } from '../src/store.ts';

const FIXTURES = new URL('../../../contracts/recall-archive-v1/fixtures/', import.meta.url);
const fixture = (path: string) => readFileSync(fileURLToPath(new URL(path, FIXTURES).href), 'utf8');
/** The contract's form: 2-space JSON, as the codec writes it, then a newline. */
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const DEVICE = { device_id: '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', device_label: 'MacBook · 工作' };
const at = (iso: string) => Date.parse(iso);

const firstVisit: Joined<VisitRow> = {
  id: '1f3e8a27-6c4b-4f0d-a1e2-9b8c7d6e5f01',
  seq: 2,
  seq_ms: at('2026-10-10T02:05:00Z'),
  page_rowid: 1,
  ...DEVICE,
  url: 'https://docs.example.com/guide/durable-objects',
  url_truncated: 0,
  title: 'Durable Objects 入门 · Example Docs',
  start_ms: at('2026-10-10T02:00:05Z'),
  end_ms: at('2026-10-10T02:03:41Z'),
  focus_seconds: 196,
  spans: JSON.stringify([
    [at('2026-10-10T02:00:05Z'), at('2026-10-10T02:02:10Z')],
    [at('2026-10-10T02:02:30Z'), at('2026-10-10T02:03:41Z')],
  ]),
  revision: 3,
  page_id: '3cb732b26093d5571ec48a363db593b2',
  host_key: hostKey('docs.example.com'),
};

const document: Joined<DocumentRow> = {
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
  page_id: '3cb732b26093d5571ec48a363db593b2',
  host_key: hostKey('docs.example.com'),
};

const secondVisit: Joined<VisitRow> = {
  ...firstVisit,
  id: 'a4b5c6d7-8e9f-4a0b-b1c2-d3e4f5a6b702',
  seq: 5,
  page_rowid: 2,
  url: 'https://news.example.org/2026/10/sqlite-fts5-chinese',
  title: '用 FTS5 做中文搜索 | Example News',
  start_ms: at('2026-10-10T02:04:02Z'),
  end_ms: at('2026-10-10T02:04:10Z'),
  focus_seconds: 8,
  spans: JSON.stringify([[at('2026-10-10T02:04:02Z'), at('2026-10-10T02:04:10Z')]]),
  page_id: 'f9735ed632fb5291d9bc44726777dbd8',
  host_key: hostKey('news.example.org'),
};

describe('changes rendered from rows', () => {
  it('a visit, a document and a tombstone render the contract fixtures byte for byte', () => {
    expect(pretty(toWire(ChangeSchema, visitChange(firstVisit)))).toBe(fixture('Change/visit.json'));
    expect(pretty(toWire(ChangeSchema, documentChange(document)))).toBe(fixture('Change/document.json'));
    const tombstone = { id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a05', seq: 9, seq_ms: at('2026-10-11T09:30:00Z'), page_id: '3cb732b26093d5571ec48a363db593b2' };
    expect(pretty(toWire(ChangeSchema, tombstoneChange(tombstone)))).toBe(fixture('Change/tombstone.json'));
  });

  it('a page of them renders ChangePage/first-page.json, an empty one caught-up.json', () => {
    const page = (changes: ReturnType<typeof visitChange>[]) =>
      pretty(toWire(ChangePageSchema, create(ChangePageSchema, { version: ARCHIVE_VERSION, feedId: '0b6f3c1e-7d2a-4e5b-9c8d-1a2b3c4d5e6f', changes, lastSeq: 5, headSeq: 5, oldestSeq: OLDEST_SEQ })));
    expect(page([visitChange(firstVisit), documentChange(document), visitChange(secondVisit)])).toBe(fixture('ChangePage/first-page.json'));
    expect(page([])).toBe(fixture('ChangePage/caught-up.json'));
  });

  it('writes a cut URL and a cut text as such', () => {
    const wire = toWire(ChangeSchema, documentChange({ ...document, url_truncated: 1, truncated: 1 })) as { document: Record<string, unknown> };
    expect(wire.document['url_truncated']).toBe(true);
    expect(wire.document['text_truncated']).toBe(true);
  });
});

describe('blob paths and digests', () => {
  it("names a text by its capture's UTC month and its UUID", () => {
    expect(textBlobPath(at('2026-10-10T02:00:15.250Z'), document.id)).toBe(document.blob_path);
    expect(textBlobPath(at('2026-01-31T23:59:59Z'), document.id)).toBe(`2026/01/${document.id}.txt.gz`);
  });

  it('writes the RFC 9530 Content-Digest of a hex SHA-256', () => {
    // The fixture blob's digest, as base64 of its 32 bytes.
    expect(contentDigest('6439c89dc81886b6bd18e091105aeb31cb92aca181cefedc4d0068fba0b09bf5')).toBe('sha-256=:ZDnIncgYhra9GOCREFrrMcuSrKGBzv7cTQBo+6Cwm/U=:');
  });
});

describe('the feed parameters', () => {
  it('reads after, limit and consumer with their defaults', () => {
    expect(parseFeedQuery('')).toEqual({ after: 0, limit: 200, consumer: null });
    expect(parseFeedQuery('?after=42&limit=500&consumer=nas')).toEqual({ after: 42, limit: 500, consumer: 'nas' });
  });

  it('refuses a parameter that breaks its rule, an unknown or a repeated one', () => {
    for (const search of ['?after=-1', '?after=01', '?after=x', '?after=2147483648', '?limit=0', '?limit=501', '?limit=1.5', '?consumer=NAS', '?consumer=9nas', `?consumer=${'a'.repeat(33)}`, '?cursor=1', '?after=1&after=2']) {
      expect(parseFeedQuery(search), search).toBeNull();
    }
  });
});
