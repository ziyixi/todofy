import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { ObjectMetadataSchema } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { MAX_LIST_CACHE_BYTES, MAX_LIST_PAGES, type ListPageData } from '../src/store.ts';
import { sqliteStore } from './sqlite.ts';

let cache: ReturnType<typeof sqliteStore>;
const now = 1000;
const page: ListPageData = { namespace: 'quant', prefix: '', expires: now + 60000, generation: 'synthetic', provider: 'synthetic', objects: [] };
beforeEach(() => { cache = sqliteStore(); });
afterEach(() => { cache.database.close(); });

describe('bounded SQLite list pages', () => {
  it('retains replayable pages and atomically chooses one successor', () => {
    const parent = cache.store.saveListPage(page, now);
    const first = cache.store.saveListPage({ ...page, provider: 'first' }, now, parent.id);
    const replay = cache.store.saveListPage({ ...page, provider: 'second' }, now, parent.id);
    expect(replay).toEqual(first);
    expect(cache.store.listPage(parent.id, now)?.nextPage).toBe(first.id);
    expect(cache.database.prepare('SELECT COUNT(*) AS count FROM list_pages').get()).toEqual({ count: 2 });
  });

  it('refuses page-count overflow without evicting valid pages and lazily reclaims expired ones', () => {
    let first = '';
    for (let index = 0; index < MAX_LIST_PAGES; index++) {
      const saved = cache.store.saveListPage(page, now);
      if (index === 0) first = saved.id;
    }
    expect(() => cache.store.saveListPage(page, now)).toThrow(expect.objectContaining({ code: 8, reason: 'RESOURCE_EXHAUSTED' }));
    expect(cache.store.listPage(first, now)).not.toBeNull();
    expect(cache.store.listPage(first, page.expires)).toBeNull();
    expect(cache.store.saveListPage({ ...page, expires: page.expires + 60000 }, page.expires).id).not.toBe('');
  });

  it('enforces total-byte and single-page bounds before insertion', () => {
    const saved = cache.store.saveListPage(page, now);
    cache.database.prepare('UPDATE list_pages SET size_bytes = ? WHERE id = ?').run(MAX_LIST_CACHE_BYTES, saved.id);
    expect(() => cache.store.saveListPage(page, now)).toThrow(expect.objectContaining({ code: 8, reason: 'RESOURCE_EXHAUSTED' }));
    cache.database.prepare('UPDATE list_pages SET size_bytes = 0 WHERE id = ?').run(saved.id);
    const object = create(ObjectMetadataSchema, { key: 'x'.repeat(1024), revision: 'abc123', sizeBytes: 1, contentHash: 'b'.repeat(64) });
    expect(() => cache.store.saveListPage({ ...page, objects: Array.from({ length: 600 }, () => object) }, now)).toThrow(expect.objectContaining({ code: 8, reason: 'RESOURCE_EXHAUSTED' }));
    expect(cache.database.prepare('SELECT COUNT(*) AS count FROM list_pages').get()).toEqual({ count: 1 });
  });

  it('refuses an expired or missing parent without caching an orphan', () => {
    const parent = cache.store.saveListPage(page, now);
    expect(() => cache.store.saveListPage({ ...page, expires: page.expires + 60000 }, page.expires, parent.id)).toThrow(expect.objectContaining({ reason: 'CURSOR_INVALID' }));
    expect(() => cache.store.saveListPage(page, now, 'missing')).toThrow(expect.objectContaining({ reason: 'CURSOR_INVALID' }));
    expect(cache.store.listPage(parent.id, now)).not.toBeNull();
  });

  it('invalidates cached metadata when the provider connection is replaced or disconnected', () => {
    const first = cache.store.saveListPage(page, now);
    cache.store.set('connection', { appKey: 'synthetic', refreshToken: 'synthetic', generation: 'next' });
    expect(cache.store.listPage(first.id, now)).toBeNull();
    const second = cache.store.saveListPage({ ...page, generation: 'next' }, now);
    cache.store.set('connection', { appKey: 'synthetic', refreshToken: 'rotated', generation: 'next' });
    expect(cache.store.listPage(second.id, now)).not.toBeNull();
    cache.store.delete('connection');
    expect(cache.store.listPage(second.id, now)).toBeNull();
  });
});
