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
interface WireTask {
  id: string;
  name: string;
  etag: string;
  title: string;
  completed?: boolean;
  completed_count?: number;
}
async function createTask(title: string, extra: Record<string, unknown> = {}): Promise<WireTask> {
  const response = await harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, { title, ...extra });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<WireTask>;
}

test('persists CRUD, refuses stale etags, and replays a lost-response mutation exactly', async () => {
  const task = await createTask('Synthetic task');
  const requestId = randomUUID();
  const path = `/api/tasks/v1/${task.name}?request_id=${requestId}&update_mask=title&etag=${task.etag}`;
  const body = { title: 'Changed task', etag: task.etag };
  const first = await harness.mutate('PATCH', path, body);
  expect(first.status, await first.clone().text()).toBe(200);
  const saved = await first.json();
  const repeat = await harness.mutate('PATCH', path, body);
  expect(await repeat.json()).toEqual(saved);
  const stale = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/${task.name}?request_id=${randomUUID()}&update_mask=title&etag=${task.etag}`,
    { title: 'Stale', etag: task.etag },
  );
  expect(stale.status).toBe(409);
  const reused = await harness.mutate('PATCH', path, {
    title: 'Other input',
    etag: task.etag,
  });
  expect(reused.status).toBe(400);
  const read = await harness.fetch(`/api/tasks/v1/${task.name}`);
  expect(((await read.json()) as WireTask).title).toBe('Changed task');
});

test('completion preserves history and advances a recurring task only once', async () => {
  const task = await createTask('Recurring task', {
    due_date: '2026-10-20',
    recurrence: 'every Tue',
  });
  const input = { etag: task.etag, request_id: randomUUID() };
  const path = `/api/tasks/v1/${task.name}:complete`;
  const done = await harness.mutate('POST', path, input);
  expect(done.status, await done.clone().text()).toBe(200);
  const next = (await done.json()) as WireTask;
  expect(next.completed).not.toBe(true);
  expect(next.completed_count).toBe(1);
  expect(await (await harness.mutate('POST', path, input)).json()).toEqual(next);
  const history = await harness.fetch(`/api/tasks/v1/completions?task_id=${task.id}`);
  expect(((await history.json()) as { completions: unknown[] }).completions).toHaveLength(1);
  expect(((await (await harness.fetch(`/api/tasks/v1/${task.name}`)).json()) as WireTask).completed_count).toBe(1);
});

test('parent completion and deletion include descendants', async () => {
  const parent = await createTask('Parent synthetic');
  const child = await createTask('Child synthetic', { parent_id: parent.id });
  const children = await harness.fetch(`/api/tasks/v1/tasks?parent_id=${parent.id}`);
  expect(((await children.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  const done = await harness.mutate('POST', `/api/tasks/v1/${parent.name}:complete`, {
    etag: parent.etag,
    request_id: randomUUID(),
  });
  expect(done.status).toBe(200);
  expect(((await (await harness.fetch(`/api/tasks/v1/${child.name}`)).json()) as WireTask).completed).toBe(true);
  const saved = (await done.json()) as WireTask;
  expect(
    (await harness.mutate('DELETE', `/api/tasks/v1/${parent.name}?etag=${saved.etag}&request_id=${randomUUID()}`))
      .status,
  ).toBe(200);
  expect((await harness.fetch(`/api/tasks/v1/${child.name}`)).status).toBe(404);
});

test('project archive reaches the change feed without losing task identity', async () => {
  const response = await harness.mutate(
    'POST',
    `/api/tasks/v1/projects?request_id=${randomUUID()}&project_id=imported-project`,
    { title: 'Synthetic project' },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const project = (await response.json()) as WireTask;
  const task = await createTask('Project synthetic', {
    project_id: project.id,
  });
  const before = await harness.fetch('/api/tasks/v1/changes?page_size=100');
  const start = ((await before.json()) as { next_page_token: string }).next_page_token;
  const archived = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/${project.name}?request_id=${randomUUID()}&update_mask=archived&etag=${project.etag}`,
    { archived: true, etag: project.etag },
  );
  expect(archived.status, await archived.clone().text()).toBe(200);
  const changes = await harness.fetch(`/api/tasks/v1/changes?page_token=${start}`);
  const data = (await changes.json()) as {
    catalog_changed: boolean;
    changes: { name: string; task?: { archived: boolean } }[];
  };
  expect(data.catalog_changed).toBe(true);
  expect(data.changes.find((change) => change.name === task.name)?.task?.archived).toBe(true);
});

test('keyset pages preserve server sorting and reject a cursor for another view', async () => {
  await createTask('Zeta synthetic');
  await createTask('Alpha synthetic');
  const first = await harness.fetch('/api/tasks/v1/tasks?view=all&order_by=title&page_size=1');
  const page = (await first.json()) as {
    tasks: WireTask[];
    next_page_token: string;
  };
  expect(page.tasks[0]?.title).toBe('Alpha synthetic');
  expect(
    (await harness.fetch(`/api/tasks/v1/tasks?view=all&order_by=title&page_size=1&page_token=${page.next_page_token}`))
      .status,
  ).toBe(200);
  expect(
    (await harness.fetch(`/api/tasks/v1/tasks?view=inbox&order_by=title&page_token=${page.next_page_token}`)).status,
  ).toBe(400);
});

test('rejects an unauthorized Origin before parsing malformed JSON', async () => {
  const response = await harness.fetch('/api/tasks/v1/tasks?request_id=' + randomUUID(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
    },
    body: '{not json',
  });
  expect(response.status).toBe(403);
  expect(await response.text()).toContain('CSRF_FAILED');
});

test('a frozen child create inherits its parent project and replays even after the parent moves', async () => {
  const projectResponse = await harness.mutate('POST', `/api/tasks/v1/projects?request_id=${randomUUID()}`, {
    title: 'Child context project',
  });
  const project = await projectResponse.json<WireTask>();
  const parent = await createTask('Context parent', { project_id: project.id });
  const id = randomUUID();
  const url = `/api/tasks/v1/tasks?request_id=${id}`;
  const input = { title: 'Frozen child', parent_id: parent.id };
  const response = await harness.mutate('POST', url, input);
  expect(response.status, await response.clone().text()).toBe(200);
  const original = await response.json<WireTask & { project_id: string }>();
  expect(original.project_id).toBe(project.id);
  const moved = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/${parent.name}?request_id=${randomUUID()}&etag=${parent.etag}&update_mask=project_id`,
    { project_id: '' },
  );
  expect(moved.status, await moved.clone().text()).toBe(200);
  expect(await (await harness.mutate('POST', url, input)).json()).toEqual(original);
});

test('simultaneous replay creates one task and uuid5 command identities remain accepted', async () => {
  const id = '54a9c65b-f819-59ef-a275-005caab56855';
  const path = `/api/tasks/v1/tasks?request_id=${id}`;
  const [first, second] = await Promise.all([
    harness.mutate('POST', path, { title: 'Concurrent synthetic' }),
    harness.mutate('POST', path, { title: 'Concurrent synthetic' }),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(await first.json()).toEqual(await second.json());
  const rows = await harness.db
    .prepare("SELECT count(*) AS total FROM tasks WHERE title='Concurrent synthetic'")
    .first<{ total: number }>();
  expect(rows?.total).toBe(1);
});

test('named bindings enforce generic read-only access and validate RPC bodies', async () => {
  const reader = await harness.mf.getWorker('tasks-read');
  const writer = await harness.mf.getWorker('tasks-read-write');
  const unknown = await harness.mf.getWorker('tasks-unknown');
  expect((await reader.fetch('https://tasks.internal/api/tasks/v1/catalog')).status).toBe(200);
  expect((await reader.fetch('https://tasks.internal/api/tasks/v1/tasks', { method: 'POST', body: '{}' })).status).toBe(
    403,
  );
  expect((await unknown.fetch('https://tasks.internal/api/tasks/v1/catalog')).status).toBe(403);
  const id = randomUUID();
  const request = { method: 'CreateTask', body: JSON.stringify({ request_id: id, task: { title: 'RPC synthetic' } }) };
  const first = await writer.fetch('https://tasks.internal/rpc', { method: 'POST', body: JSON.stringify(request) });
  const answer = (await first.json()) as { status: number; body: string };
  expect(answer.status, answer.body).toBe(200);
  const again = await writer.fetch('https://tasks.internal/rpc', { method: 'POST', body: JSON.stringify(request) });
  expect(await again.json()).toEqual(answer);
  const invalid = await writer.fetch('https://tasks.internal/rpc', {
    method: 'POST',
    body: JSON.stringify({ method: 'CreateTask', body: '{"unknown":true}' }),
  });
  expect(((await invalid.json()) as { status: number }).status).toBe(400);
  const refused = await reader.fetch('https://tasks.internal/rpc', { method: 'POST', body: JSON.stringify(request) });
  expect(((await refused.json()) as { status: number }).status).toBe(403);
});
