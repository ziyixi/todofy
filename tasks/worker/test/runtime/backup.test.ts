/** What the weekly backup reads (src/backup.ts): its plan and pages on real D1. Synthetic rows only. */
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { BACKUP_TABLES, MAX_PAGE_BYTES, PAGE_ROWS, backupPage, planBackup } from '../../src/backup.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

const plan = () => planBackup(harness.db);
/** A page of a table in all its columns, its rows parsed, and the bytes of its row JSON. */
async function page(name: string, after: number, through: number) {
  const table = BACKUP_TABLES.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`Unknown table ${name}`);
  const read = await backupPage(harness.db, table, after, through);
  const bytes = read.rows.reduce((sum, row) => sum + new TextEncoder().encode(row).byteLength + 1, 0);
  return {
    page: {
      ...read,
      rows: read.rows.map((row) => JSON.parse(row) as unknown[]),
    },
    bytes,
  };
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
    BACKUP_TABLES.map((table) => ({
      ...table,
      max_rowid: expect.any(Number) as number,
    })),
  );
});

test('a plan and its pages hold every row of every table', async () => {
  const project = await make('projects', {
    title: 'Synthetic backup project',
    color: '#246fe0',
  });
  const section = await make('sections', {
    title: 'Synthetic section',
    project_id: project.id,
  });
  const label = await make('labels', { title: 'Synthetic backup label' });
  await make('filters', {
    title: 'Synthetic filter',
    query: 'today',
    color: '#db4035',
  });
  const objective = await make('objectives', {
    title: 'Synthetic annual direction',
    year: 2030,
  });
  const result = await make('keyResults', {
    title: 'Synthetic annual result',
    objective_id: objective.id,
  });
  await make('goalProgress', {
    key_result_id: result.id,
    note: 'Synthetic backup evidence',
  });
  const parent = await make('tasks', {
    key_result_id: result.id,
    title: 'Synthetic parent “quoted” 中文',
    description: "It's a\nmulti-line synthetic description",
    project_id: project.id,
    section_id: section.id,
    label_ids: [label.id],
  });
  const child = await make('tasks', {
    title: 'Synthetic child',
    parent_id: parent.id,
    kind: 'step',
  });
  const done = await harness.mutate('POST', `/api/tasks/v1/${child.name}:complete`, {
    etag: child.etag,
    request_id: randomUUID(),
  });
  expect(done.status, await done.clone().text()).toBe(200);
  await harness.db.prepare('UPDATE tasks SET sort_order=1.25 WHERE id=?').bind(parent.id).run();
  // A Focus queue row and a time record; the migration seeds the idle timer.
  await harness.db.batch([
    harness.db
      .prepare(
        "INSERT INTO day_steps(day,task_id,position,done_at,created_at,updated_at) VALUES('2030-10-21',?,1.5,2,1,2)",
      )
      .bind(child.id),
    harness.db
      .prepare(
        "INSERT INTO focus_entries(id,task_id,day,seconds,started_at,source,area,created_at,updated_at) VALUES('synthetic-entry',?,'2030-10-21',1500,1,'timer','work',2,2)",
      )
      .bind(child.id),
    // A dependency and a Bet; the migration seeds the Review board.
    harness.db
      .prepare(
        'INSERT INTO task_dependencies(task_id,prerequisite_id,baseline_count,created_at,updated_at) VALUES(?,?,0,3,3)',
      )
      .bind(parent.id, child.id),
    harness.db.prepare(
      "INSERT INTO weekly_bets(week_start,area,text,created_at,updated_at) VALUES('2030-10-21','work','Synthetic goal',3,3)",
    ),
    // A GTD day, a review, a route and a TaskInbox day; the migration seeds the mail categories.
    harness.db.prepare("INSERT INTO gtd_week_commitments(week_start,task_id,created_at) VALUES('2030-10-21',?,4)").bind(parent.id),
    harness.db.prepare(
      "INSERT INTO gtd_days(day,scope,open,age_0_7,age_8_14,age_15_30,age_31_plus,oldest_days,overdue,undated,computed_at) VALUES('2030-10-21','all',2,2,0,0,0,1,0,2,4)",
    ),
    harness.db
      .prepare("INSERT INTO weekly_reviews(week,state,task_id,created_at) VALUES('2030-W43','created',?,4)")
      .bind(parent.id),
    harness.db
      .prepare("INSERT INTO task_inbox_routes(source,project_id,updated_at) VALUES('home',?,4)")
      .bind(project.id),
    harness.db.prepare("INSERT INTO task_inbox_days(source,day,requests) VALUES('watch','2030-10-21',1)"),
  ]);

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
  const rows = Array.from({ length: PAGE_ROWS }, (_, index) => ({
    id: `cap-${String(index).padStart(3, '0')}`,
  }));
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
  const tasks = BACKUP_TABLES.find((table) => table.name === 'tasks');
  if (!tasks) throw new Error('Missing tasks table');
  await backupPage(measured.db, tasks, 0, through + 1000);
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

test('a page reads only the tables and columns a plan names, and no binding or route exports', async () => {
  await expect(backupPage(harness.db, { name: 'changes', columns: ['sequence'] }, 0, 10)).rejects.toThrow(/Unknown/);
  await expect(backupPage(harness.db, { name: 'tasks', columns: ['id', 'secret'] }, 0, 10)).rejects.toThrow(/Unknown/);
  await expect(backupPage(harness.db, { name: 'tasks', columns: [] }, 0, 10)).rejects.toThrow(/Unknown/);
  // A job keeps the columns of the release that planned it: a subset reads that subset.
  const { rows } = await backupPage(harness.db, { name: 'labels', columns: ['id'] }, 0, 1_000_000);
  expect(rows.every((row) => (JSON.parse(row) as unknown[]).length === 1)).toBe(true);
  // The backup runs in the jobs object (backup-runner.ts): the owner API has no route and TasksApi no method for it.
  expect((await harness.fetch('/api/tasks/v1/backup')).status).toBe(404);
  const binding = await harness.mf.getWorker('tasks-read-write');
  expect(
    (
      await binding.fetch('https://tasks.internal/backup', {
        method: 'POST',
        body: '{"table":""}',
      })
    ).status,
  ).toBe(404);
});
