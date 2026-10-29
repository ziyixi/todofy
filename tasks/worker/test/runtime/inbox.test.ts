/** TaskInbox (src/inbox.ts), the create-only machine entry, over real service bindings and D1. Synthetic tasks only. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

interface Created {
  task_id: string;
  subtask_ids: string[];
  replayed: boolean;
  error?: string;
}
async function create(source: string, body: unknown): Promise<Created> {
  const caller = await harness.mf.getWorker(`tasks-inbox-${source}`);
  const response = await caller.fetch('https://inbox.internal/', { method: 'POST', body: JSON.stringify(body) });
  return (await response.json()) as Created;
}
const rows = (ids: string[]) =>
  harness.db
    .prepare(
      'SELECT id,title,description,project_id,parent_id,sort_order FROM tasks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY sort_order',
    )
    .bind(JSON.stringify(ids))
    .all()
    .then((result) => result.results);

test('creates one task with its subtasks in the Inbox, and a replay answers the same IDs', async () => {
  const request = {
    request_id: randomUUID(),
    title: '  Synthetic digest  ',
    description: 'Three synthetic items',
    subtasks: [{ title: 'First item', description: 'detail' }, { title: 'Second item' }],
  };
  const created = await create('home', request);
  expect(created).toMatchObject({ replayed: false, subtask_ids: [expect.any(String), expect.any(String)] });
  expect(await rows([created.task_id])).toEqual([
    {
      id: created.task_id,
      title: 'Synthetic digest',
      description: 'Three synthetic items',
      project_id: '',
      parent_id: '',
      sort_order: expect.any(Number) as number,
    },
  ]);
  expect(await rows(created.subtask_ids)).toEqual([
    { id: created.subtask_ids[0], title: 'First item', description: 'detail', project_id: '', parent_id: created.task_id, sort_order: 1 },
    { id: created.subtask_ids[1], title: 'Second item', description: '', project_id: '', parent_id: created.task_id, sort_order: 2 },
  ]);
  const changes = await harness.db
    .prepare("SELECT count(*) AS n FROM changes WHERE resource='tasks' AND resource_id=?")
    .bind(created.task_id)
    .first();
  expect(changes).toEqual({ n: 1 });
  // The owner's API reads it as any task.
  const read = await harness.fetch(`/api/tasks/v1/tasks/${created.task_id}`);
  expect(await read.json()).toMatchObject({ title: 'Synthetic digest', child_count: 2 });

  expect(await create('home', request)).toEqual({ ...created, replayed: true });
  expect(await create('home', { ...request, title: 'Other input' })).toEqual({ error: 'invalid_input' });
  // The same request_id from the other source is other input too.
  expect(await create('watch', request)).toEqual({ error: 'invalid_input' });
});

test("stores each subtask's text exactly as given, in order", async () => {
  const texts = [
    'Quote " backslash \\ slash / tab\t newline\n return\r',
    'NUL\u0000 bell\u0007 escape\u001b delete\u007f',
    '汉字 🙂 \u2028 \u2029 \ufeff e\u0301',
    '\\u0041 is no escape, {"json":true} [1,2]',
  ];
  const created = await create('home', {
    request_id: randomUUID(),
    title: 'Synthetic characters',
    subtasks: texts.map((text, index) => ({ title: `Item ${String(index)} ${text}`, description: text })),
  });
  expect((await rows(created.subtask_ids)).map((row) => [row.title, row.description, row.sort_order])).toEqual(
    texts.map((text, index) => [`Item ${String(index)} ${text}`.trim(), text, index + 1]),
  );
});

test('refuses an unknown source and input the wire rules or Tasks reject, writing nothing', async () => {
  const before = await harness.db.prepare('SELECT count(*) AS n FROM tasks').first();
  const valid = { request_id: randomUUID(), title: 'Synthetic' };
  expect(await create('unknown', valid)).toEqual({ error: 'invalid_input' });
  for (const body of [
    { ...valid, title: '   ' },
    { ...valid, title: 'x'.repeat(501) },
    { ...valid, description: 'x'.repeat(16001) },
    { ...valid, subtasks: Array.from({ length: 31 }, () => ({ title: 'Synthetic' })) },
    { ...valid, subtasks: [{ title: '' }] },
    { ...valid, request_id: valid.request_id.toUpperCase() },
    { ...valid, request_id: 'not-a-uuid' },
    { ...valid, unknown: true },
    { title: 'No request ID' },
  ])
    expect(await create('watch', body), JSON.stringify(body).slice(0, 80)).toEqual({ error: 'invalid_input' });
  expect(await harness.db.prepare('SELECT count(*) AS n FROM tasks').first()).toEqual(before);
});

test("home's tasks go to its routed project while the project is live; watch's to the Inbox", async () => {
  const project = async (title: string) => {
    const response = await harness.mutate('POST', `/api/tasks/v1/projects?request_id=${randomUUID()}`, { title });
    return ((await response.json()) as { id: string }).id;
  };
  const route = (id: string) =>
    harness.db
      .prepare(
        "INSERT INTO task_inbox_routes(source,project_id,updated_at) VALUES('home',?,1) ON CONFLICT(source) DO UPDATE SET project_id=excluded.project_id",
      )
      .bind(id)
      .run();
  const id = await project('Synthetic routed project');
  await route(id);
  const routed = await create('home', { request_id: randomUUID(), title: 'Routed', subtasks: [{ title: 'Routed child' }] });
  expect((await rows([routed.task_id, ...routed.subtask_ids])).map((row) => row.project_id)).toEqual([id, id]);
  const watched = await create('watch', { request_id: randomUUID(), title: 'Watched' });
  expect((await rows([watched.task_id]))[0]).toMatchObject({ project_id: '' });

  await harness.db.prepare('UPDATE projects SET archived=1 WHERE id=?').bind(id).run();
  const archived = await create('home', { request_id: randomUUID(), title: 'Archived route' });
  expect((await rows([archived.task_id]))[0]).toMatchObject({ project_id: '' });
  const gone = await project('Synthetic deleted project');
  await route(gone);
  await harness.db.prepare('UPDATE projects SET deleted_at=1 WHERE id=?').bind(gone).run();
  const deleted = await create('home', { request_id: randomUUID(), title: 'Deleted route' });
  expect((await rows([deleted.task_id]))[0]).toMatchObject({ project_id: '' });
});

test('each source creates at most 20 tasks per UTC day; a refused request writes nothing', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await harness.db
    .prepare(
      "INSERT INTO task_inbox_days(source,day,requests) VALUES('watch',?,19) ON CONFLICT(source,day) DO UPDATE SET requests=19",
    )
    .bind(day)
    .run();
  const twentieth = await create('watch', { request_id: randomUUID(), title: 'Twentieth' });
  expect(twentieth.replayed).toBe(false);
  const request = { request_id: randomUUID(), title: 'Twenty-first' };
  expect(await create('watch', request)).toEqual({ error: 'daily_limit' });
  expect(await harness.db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Twenty-first'").first()).toEqual({
    n: 0,
  });
  expect(await harness.db.prepare('SELECT count(*) AS n FROM requests WHERE id=?').bind(request.request_id).first()).toEqual(
    { n: 0 },
  );
  // Home has its own count, and the twentieth's replay still answers.
  expect((await create('home', { request_id: randomUUID(), title: 'Home is fine' })).replayed).toBe(false);
  expect((await create('watch', { request_id: randomUUID(), title: 'Twentieth' })).error).toBe('daily_limit');
  expect(
    await harness.db
      .prepare("SELECT requests FROM task_inbox_days WHERE source='watch' AND day=?")
      .bind(day)
      .first(),
  ).toEqual({ requests: 20 });
});
