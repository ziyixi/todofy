/**
 * The D1 schema (../../../migrations) as SQLite runs it: the tables are WITHOUT ROWID with the keys the code relies on,
 * the only secondary index is the partial purge index, and the queries the hot paths run use their keys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});

describe('the schema', () => {
  it('has the three tables, WITHOUT ROWID, and one partial index', async () => {
    const tables = await h.sql<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' AND name NOT LIKE 'd1_%' ORDER BY name");
    expect(tables.map((table) => table.name)).toEqual(['link_revisions', 'links', 'request_log']);
    for (const table of tables) expect(table.sql, table.name).toMatch(/WITHOUT ROWID$/);
    const indexes = await h.sql<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name");
    expect(indexes.map((index) => index.name)).toEqual(['links_purge']);
    expect(indexes[0]?.sql).toMatch(/WHERE purge_time IS NOT NULL/);
  });

  it('keeps the columns in the order LINK_COLUMNS lists them', async () => {
    const columns = await h.sql<{ name: string }>('PRAGMA table_info(links)');
    expect(columns.map((column) => column.name).join(', ')).toBe(
      'key, target, path_mode, visibility, description, tags, expire_time, create_time, update_time, delete_time, purge_time, revision, revision_time, etag',
    );
  });

  it('refuses a mode or visibility the code does not know', async () => {
    const insert = (mode: string, visibility: string) =>
      h.sql(
        `INSERT INTO links (key, target, path_mode, visibility, create_time, update_time, revision, revision_time, etag) VALUES ('x', 'https://x.example/', ?, ?, 0, 0, 1, 0, 'e')`,
        mode,
        visibility,
      );
    await expect(insert('redirect', 'private')).rejects.toThrow();
    await expect(insert('exact', 'friends')).rejects.toThrow();
  });

  it('finds what is due for purging through the partial index', async () => {
    const plan = await h.sql<{ detail: string }>('EXPLAIN QUERY PLAN DELETE FROM links WHERE purge_time <= ?', 0);
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX links_purge/);
  });
});
