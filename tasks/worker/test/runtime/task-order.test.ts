import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); });
afterAll(async () => { await harness.dispose(); });

type WireTask = { name: string; id: string; etag: string; sort_order: number; title: string };
async function create(title: string, extra: Record<string, unknown> = {}) {
  const requestId = randomUUID();
  const path = `/api/tasks/v1/tasks?request_id=${requestId}`;
  const body = { title, ...extra };
  const response = await harness.mutate('POST', path, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const task = await response.json<WireTask>();
  expect(await (await harness.mutate('POST', path, body)).json()).toEqual(task);
  return task;
}

test('ordinary creates append and a task can persist between its new siblings', async () => {
  const first = await create('First ordered task');
  const second = await create('Second ordered task');
  const third = await create('Third ordered task');
  expect(first.sort_order).toBeLessThan(second.sort_order);
  expect(second.sort_order).toBeLessThan(third.sort_order);
  const response = await harness.mutate('PATCH', `/api/tasks/v1/${third.name}?request_id=${randomUUID()}&etag=${third.etag}&update_mask=sort_order`, {
    sort_order: (first.sort_order + second.sort_order) / 2,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const listed = await (await harness.fetch('/api/tasks/v1/tasks?view=inbox&order_by=sort_order')).json<{tasks: WireTask[]}>();
  expect(listed.tasks.map(task => task.id)).toEqual([first.id, third.id, second.id]);
});

test('concurrent creates have distinct append positions and explicit zero is preserved', async () => {
  const parent = await create('Ordering parent');
  const children = await Promise.all(Array.from({ length: 4 }, (_, i) => create(`Child ${String(i)}`, { parent_id: parent.id })));
  expect(new Set(children.map(task => task.sort_order)).size).toBe(4);
  const explicit = await create('Explicit first child', { parent_id: parent.id, sort_order: 0 });
  expect(explicit.sort_order).toBe(0);
});
