import { randomUUID } from 'node:crypto';
import { stdout } from 'node:process';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { ProjectSchema, SectionSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { ListTasksRequestSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { saveCatalog } from '../../src/catalog.ts';
import { getTask, listTasks } from '../../src/task-read.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

const ZONE = 'America/Los_Angeles';
const NOW = Date.parse('2030-04-15T18:00:00Z');
let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
  await harness.db.batch([
    harness.db.prepare(
      "INSERT INTO projects(id,title,created_at,updated_at) VALUES('budget-project','Synthetic budget project',1,1)",
    ),
    harness.db.prepare(
      "INSERT INTO sections(id,title,project_id,created_at,updated_at) VALUES('budget-section','Synthetic section','budget-project',1,1)",
    ),
    harness.db.prepare(
      "INSERT INTO labels(id,title,created_at,updated_at) VALUES('budget-label','Synthetic budget label',1,1)",
    ),
  ]);
  await addTasks('inbox', 11, { completed: 0 });
  await addTasks('recurring', 10, { completed: 0, due: '2030-04-15', recurrence: 'every day' });
  await addTasks('section', 100, { completed: 0, project: 'budget-project', section: 'budget-section' });
  await addHistory(1);
});
afterAll(async () => {
  await harness.dispose();
});

async function addTasks(
  prefix: string,
  count: number,
  fields: { completed: number; due?: string; recurrence?: string; project?: string; section?: string },
) {
  // Interleave open and completed rows in one sort order, as imported history is.
  const data = Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${String(index)}`, order: index * 2 + 1 }));
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,project_id,section_id,completed,due_date,recurrence,label_ids,sort_order,created_at,updated_at)
       SELECT value->>'id','Synthetic read budget task',?,?,?,?,?,'["budget-label"]',value->>'order',1,1 FROM json_each(?)`,
    )
    .bind(
      fields.project ?? '',
      fields.section ?? '',
      fields.completed,
      fields.due ?? '',
      fields.recurrence ?? '',
      JSON.stringify(data),
    )
    .run();
}
/** Completed roots in the Inbox, and imported occurrences of every recurring task. */
async function addHistory(round: number) {
  await addTasks(`history-${String(round)}`, 2000, { completed: 1 });
  await harness.db
    .prepare(
      `INSERT INTO completions(id,task_id,title,completed_at,imported)
       SELECT 'imported-${String(round)}-' || t.id || '-' || n.value,t.id,t.title,1,1
       FROM tasks t, json_each(?) n WHERE t.id LIKE 'recurring-%'`,
    )
    .bind(JSON.stringify(Array.from({ length: 250 }, (_, index) => index)))
    .run();
}
async function revision(table: string, id: string): Promise<string> {
  const row = await harness.db.prepare(`SELECT revision FROM ${table} WHERE id=?`).bind(id).first<{ revision: number }>();
  return String(row?.revision);
}
async function measure(read: (db: D1Database) => Promise<unknown>) {
  const measured = measuredReads(harness.db);
  await read(measured.db);
  return measured.metrics;
}
const list = (db: D1Database, fields: Parameters<typeof create<typeof ListTasksRequestSchema>>[1]) =>
  listTasks(db, create(ListTasksRequestSchema, fields), ZONE, NOW);

test('Inbox, Today and a recurring task read the same rows when completed history doubles', async () => {
  const reads = {
    inbox: (db: D1Database) => list(db, { view: 'inbox', pageSize: 100 }),
    today: (db: D1Database) => list(db, { view: 'today', date: '2030-04-15', pageSize: 100 }),
    recurring: (db: D1Database) => getTask(db, 'recurring-0'),
  };
  const before = {
    inbox: await measure(reads.inbox),
    today: await measure(reads.today),
    recurring: await measure(reads.recurring),
  };
  expect((await reads.inbox(harness.db)).tasks).toHaveLength(21);
  expect((await reads.recurring(harness.db)).completed_count).toBe(0);
  await addHistory(2);
  for (const name of ['inbox', 'today', 'recurring'] as const) {
    const after = await measure(reads[name]);
    stdout.write(
      JSON.stringify({ event: 'tasks_read_history_growth', read: name, before: before[name], after }) + '\n',
    );
    expect(after.rowsWritten, name).toBe(0);
    expect(Math.abs(after.rowsRead - before[name].rowsRead), name).toBeLessThanOrEqual(2);
  }
});

test('a later page and an ID lookup seek their index', async () => {
  const first = await list(harness.db, { view: 'all', pageSize: 50 });
  expect(first.nextPageToken).not.toBe('');
  const opening = await measure((db) => list(db, { view: 'all', pageSize: 50 }));
  const page = await measure((db) => list(db, { view: 'all', pageSize: 50, pageToken: first.nextPageToken }));
  const lookup = await measure((db) => list(db, { view: 'all', taskIds: ['section-99'] }));
  stdout.write(JSON.stringify({ event: 'tasks_read_page_and_lookup', opening, page, lookup }) + '\n');
  // A later page reads what the first does, not every row before its cursor.
  expect(page.rowsRead).toBeLessThanOrEqual(opening.rowsRead + 2);
  expect(lookup.rowsRead).toBeLessThan(2 * (1 + 1));
  const descending = await list(harness.db, { view: 'all', pageSize: 50, orderBy: 'sort_order desc' });
  const next = await list(harness.db, {
    view: 'all',
    pageSize: 50,
    orderBy: 'sort_order desc',
    pageToken: descending.nextPageToken,
  });
  expect(Number(next.tasks[0]?.sortOrder)).toBeLessThan(Number(descending.tasks.at(-1)?.sortOrder));
});

async function renameSection(db: D1Database, id: string) {
  return saveCatalog(
    db,
    'sections',
    SectionSchema,
    {
      requestId: randomUUID(),
      id: '',
      etag: await revision('sections', id),
      resource: create(SectionSchema, { name: `sections/${id}`, title: `Synthetic renamed ${id}` }),
      updateMask: { paths: ['title'] },
    },
    false,
    NOW,
  );
}

test('renaming a section or recolouring a project leaves its tasks alone', async () => {
  await harness.db
    .prepare(
      "INSERT INTO sections(id,title,project_id,created_at,updated_at) VALUES('empty-section','Synthetic empty section','budget-project',1,1)",
    )
    .run();
  const revisions = () =>
    harness.db
      .prepare("SELECT sum(revision) AS total FROM tasks WHERE project_id='budget-project'")
      .first<{ total: number }>();
  const before = await revisions();
  const empty = await measure((db) => renameSection(db, 'empty-section'));
  const rename = await measure((db) => renameSection(db, 'budget-section'));
  const etag = await revision('projects', 'budget-project');
  const recolour = await measure((db) =>
    saveCatalog(
      db,
      'projects',
      ProjectSchema,
      {
        requestId: randomUUID(),
        id: '',
        etag,
        resource: create(ProjectSchema, { name: 'projects/budget-project', color: '#b8255f', favorite: true }),
        updateMask: { paths: ['color', 'favorite'] },
      },
      false,
      NOW,
    ),
  );
  stdout.write(JSON.stringify({ event: 'tasks_catalog_edit_cost', empty, rename, recolour }) + '\n');
  // A section with 100 tasks costs what an empty one does: the section row, one change row and the receipt.
  expect(rename).toEqual(empty);
  expect(recolour.rowsRead).toBeLessThan(20);
  expect(await revisions()).toEqual(before);
});

test('a label rename announces the label before its tasks', async () => {
  const start = await harness.db.prepare('SELECT max(sequence) AS last FROM changes').first<{ last: number }>();
  const renamed = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/labels/budget-label?request_id=${randomUUID()}&update_mask=title&etag=${await revision('labels', 'budget-label')}`,
    { title: 'Synthetic renamed label' },
  );
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  const changes = await harness.db
    .prepare('SELECT resource FROM changes WHERE sequence>? ORDER BY sequence')
    .bind(start?.last ?? 0)
    .all<{ resource: string }>();
  expect(changes.results[0]?.resource).toBe('labels');
  expect(changes.results.filter((change) => change.resource === 'tasks').length).toBeGreaterThan(100);
});
