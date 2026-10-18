/** The weekly backup's export (src/backup.ts) over the real TasksApi binding and D1. Synthetic rows only. */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BACKUP_TABLES, MAX_PAGE_BYTES, PAGE_ROWS, exportBackup as exportDirect } from '../../src/backup.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

interface Answer {
  status: number;
  body: string;
}
interface Plan {
  schema_version: string;
  change_sequence: number;
  tables: { name: string; columns: string[]; key: string[]; max_rowid: number }[];
}
interface Page {
  rows: unknown[][];
  last: number;
  done: boolean;
  change_sequence: number;
}
async function exportBackup(request: unknown, access = 'read-write'): Promise<Answer> {
  const binding = await harness.mf.getWorker(`tasks-${access}`);
  const response = await binding.fetch('https://tasks.internal/backup', {
    method: 'POST',
    body: typeof request === 'string' ? request : JSON.stringify(request),
  });
  return (await response.json()) as Answer;
}
async function plan(): Promise<Plan> {
  const answer = await exportBackup({ table: '' });
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as Plan;
}
async function page(table: string, after: number, through: number): Promise<{ page: Page; bytes: number }> {
  const answer = await exportBackup({ table, after, through });
  expect(answer.status, answer.body).toBe(200);
  return { page: JSON.parse(answer.body) as Page, bytes: new TextEncoder().encode(answer.body).byteLength };
}
async function make(kind: string, body: Record<string, unknown>): Promise<{ id: string; name: string; etag: string }> {
  const response = await harness.mutate('POST', `/api/tasks/v1/${kind}?request_id=${randomUUID()}`, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{ id: string; name: string; etag: string }>;
}

test('the column lists are every column of every table a restore needs', async () => {
  const tables = await harness.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations','changes','task_labels') ORDER BY name",
    )
    .all<{ name: string }>();
  expect(tables.results.map((row) => row.name)).toEqual(BACKUP_TABLES.map((table) => table.name).sort());
  for (const table of BACKUP_TABLES) {
    const info = await harness.db.prepare(`PRAGMA table_info(${table.name})`).all<{ name: string; pk: number }>();
    expect(table.columns, table.name).toEqual(info.results.map((column) => column.name));
    expect(table.key, table.name).toEqual(info.results.filter((column) => column.pk).map((column) => column.name));
  }
  expect((await plan()).tables).toEqual(
    BACKUP_TABLES.map((table) => ({ ...table, max_rowid: expect.any(Number) as number })),
  );
});

test('a plan and its pages hold every row of every table', async () => {
  const project = await make('projects', { title: 'Synthetic backup project', color: '#246fe0' });
  const section = await make('sections', { title: 'Synthetic section', project_id: project.id });
  const label = await make('labels', { title: 'Synthetic backup label' });
  await make('filters', { title: 'Synthetic filter', query: 'today', color: '#db4035' });
  const parent = await make('tasks', {
    title: 'Synthetic parent “quoted” 中文',
    description: "It's a\nmulti-line synthetic description",
    project_id: project.id,
    section_id: section.id,
    label_ids: [label.id],
  });
  const child = await make('tasks', { title: 'Synthetic child', parent_id: parent.id, kind: 'step' });
  const done = await harness.mutate('POST', `/api/tasks/v1/${child.name}:complete`, {
    etag: child.etag,
    request_id: randomUUID(),
  });
  expect(done.status, await done.clone().text()).toBe(200);
  await harness.db.prepare('UPDATE tasks SET sort_order=1.25 WHERE id=?').bind(parent.id).run();

  const planned = await plan();
  const migrations = (await readdir(join(dirname(fileURLToPath(import.meta.url)), '../../../migrations'))).sort();
  expect(planned.schema_version).toBe(migrations.filter((name) => name.endsWith('.sql')).at(-1));
  const newest = await harness.db.prepare('SELECT max(sequence) AS n FROM changes').first<{ n: number }>();
  expect(planned.change_sequence).toBe(newest?.n);
  for (const table of planned.tables) {
    const exported: unknown[][] = [];
    let after = 0;
    for (let calls = 0; ; calls++) {
      expect(calls).toBeLessThan(50);
      const { page: next } = await page(table.name, after, table.max_rowid);
      exported.push(...next.rows);
      expect(next.change_sequence).toBe(planned.change_sequence);
      after = next.last;
      if (next.done) break;
    }
    const stored = await harness.db
      .prepare(`SELECT ${table.columns.join(',')} FROM ${table.name} ORDER BY rowid`)
      .raw();
    expect(exported, table.name).toEqual(stored);
    expect(exported.length, table.name).toBeGreaterThan(0);
  }
  // A row written after the plan is beyond its max rowid, so no page holds it.
  const tasks = planned.tables.find((table) => table.name === 'tasks');
  if (!tasks) throw new Error('Missing tasks plan');
  await make('tasks', { title: 'Written after the plan' });
  const { page: bounded } = await page('tasks', 0, tasks.max_rowid);
  expect(bounded.rows).toHaveLength(2);
  expect(bounded.done).toBe(true);
});

test('a page stops before its byte cap and always holds at least one row', async () => {
  const description = '汉字'.repeat(8000); // 16,000 characters, 48 KB of UTF-8
  const rows = Array.from({ length: PAGE_ROWS }, (_, index) => ({ id: `cap-${String(index).padStart(3, '0')}` }));
  await harness.db.prepare('DELETE FROM tasks').run();
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,description,created_at,updated_at) SELECT value->>'id','Synthetic capped task',?,1,1 FROM json_each(?)`,
    )
    .bind(description, JSON.stringify(rows))
    .run();
  const through = (await plan()).tables.find((table) => table.name === 'tasks')?.max_rowid ?? 0;
  const ids: unknown[] = [];
  let after = 0;
  for (;;) {
    const { page: next, bytes } = await page('tasks', after, through);
    expect(bytes).toBeLessThan(MAX_PAGE_BYTES + 200);
    expect(next.rows.length).toBeGreaterThan(0);
    ids.push(...next.rows.map((row) => row[0]));
    after = next.last;
    if (next.done) break;
  }
  expect(ids).toEqual(rows.map((row) => row.id));
  // The page query stops at its LIMIT: a range over 1,100 rows reads one page (each row three times: the range,
  // the window and the filter), not the table.
  await harness.db
    .prepare(
      "INSERT INTO tasks(id,title,created_at,updated_at) SELECT 'small-'||value,'Synthetic small task',1,1 FROM json_each(?)",
    )
    .bind(JSON.stringify(Array.from({ length: 1000 }, (_, index) => index)))
    .run();
  const measured = measuredReads(harness.db);
  await exportDirect(measured.db, { table: 'tasks', after: 0, through: through + 1000 });
  expect(measured.metrics.rowsRead).toBeLessThanOrEqual(3 * (PAGE_ROWS + 1));
  await harness.db.prepare("DELETE FROM tasks WHERE id LIKE 'small-%'").run();

  // A row above the cap on its own (only a direct write can store one) still makes progress.
  await harness.db
    .prepare("INSERT INTO tasks(id,title,description,created_at,updated_at) VALUES('cap-huge','Synthetic huge',?,1,1)")
    .bind('x'.repeat(MAX_PAGE_BYTES + 1))
    .run();
  const { page: huge } = await page('tasks', through, through + 1);
  expect(huge.rows.map((row) => row[0])).toEqual(['cap-huge']);
  expect(huge.done).toBe(true);
});

test('only a read-write binding may export, and only known tables', async () => {
  for (const access of ['read', 'unknown']) {
    const refused = await exportBackup({ table: '' }, access);
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain('projects');
  }
  expect((await exportBackup({ table: 'changes', after: 0, through: 10 })).status).toBe(400);
  expect((await exportBackup({ table: 'tasks', after: -1, through: 10 })).status).toBe(400);
  expect((await exportBackup({ table: 'tasks', after: 0 })).status).toBe(400);
  expect((await exportBackup('not json')).status).toBe(400);
  // The export is a binding method only: the owner API has no such route.
  expect((await harness.fetch('/api/tasks/v1/backup')).status).toBe(404);
});
