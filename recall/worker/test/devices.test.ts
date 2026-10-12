import { describe, expect, it } from 'vitest';
import { memoryStore } from './sqlite.ts';

// Upgrade the actual preceding layout, preserving its legacy credentials, device and feed identity.
describe('schema 5 device upgrade', () => {
  it('adds mobile status and its timeline index without changing existing state', () => {
    const store = memoryStore();
    store.run(`ALTER TABLE devices DROP COLUMN mobile`);
    store.run(`DROP INDEX visits_device`);
    store.setMeta('schema_version', '4');
    store.setMeta('token_ingest', 'synthetic-existing-digest');
    store.run(`INSERT INTO devices (id, label, extension_version, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)`,
      '5d0c3b52-8a5e-4f8e-9b8e-2d7c1a6f4e10', 'Desktop', '2026.1011.900', 10, 20);
    const feedId = store.getMeta('feed_id');
    store.migrate();
    store.migrate();
    expect(store.getMeta('schema_version')).toBe('5');
    expect(store.getMeta('feed_id')).toBe(feedId);
    expect(store.getMeta('token_ingest')).toBe('synthetic-existing-digest');
    expect(store.one(`SELECT label, mobile, first_seen_ms, last_seen_ms FROM devices`)).toEqual({ label: 'Desktop', mobile: 0, first_seen_ms: 10, last_seen_ms: 20 });
    expect(store.one(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'visits_device'`)).toEqual({ name: 'visits_device' });
  });
});
