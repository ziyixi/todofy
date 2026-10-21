/** Native executable eligibility runs after receipt replay, so an exact retry does not revalidate a later task. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); });
afterAll(async () => { await harness.dispose(); });

interface WireTask { name: string; id: string; etag: string }
async function ok<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<T>;
}
function make(body: Record<string, unknown>) {
  return harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, body).then(ok<WireTask>);
}
function move(body: Record<string, unknown>) {
  return harness.mutate('POST', '/api/tasks/v1/focusDays:moveStep', body);
}
async function refused(response: Response) {
  expect(response.status).toBe(400);
  const body = await response.json<{ error: { status: string; details: { reason?: string }[] } }>();
  expect(body.error.status).toBe('FAILED_PRECONDITION');
  expect(body.error.details.some(detail => detail.reason === 'PRECONDITION_FAILED')).toBe(true);
}

test('new queue writes reject ordinary outcomes and accept Steps, Standalone actions and Quick tasks', async () => {
  const outcome = await make({ title: 'Synthetic ordinary outcome' });
  await refused(await move({ task_id: outcome.id, destination_day: '2030-10-21', request_id: randomUUID() }));
  expect((await harness.db.prepare('SELECT task_id FROM day_steps WHERE task_id=?').bind(outcome.id).all()).results).toEqual([]);
  const step = await make({ title: 'Synthetic executable Step', parent_id: outcome.id, kind: 'step' });
  const standalone = await make({ title: 'Synthetic Standalone action', planning_flags: ['task'] });
  const quick = await make({ title: 'Synthetic Quick task', planning_flags: ['quick'] });
  for (const task of [step, standalone, quick]) {
    await ok(await move({ task_id: task.id, destination_day: '2030-10-21', request_id: randomUUID() }));
  }
  expect((await harness.db.prepare("SELECT task_id FROM day_steps WHERE day='2030-10-21' AND deleted_at IS NULL ORDER BY position").all()).results.map(row => row['task_id']))
    .toEqual([step.id, standalone.id, quick.id]);
});

test('a successful exact receipt replays after reclassification and deletion without restoring the queue', async () => {
  const task = await make({ title: 'Synthetic replayed action', planning_flags: ['task'] });
  const request = { task_id: task.id, destination_day: '2030-10-22', request_id: randomUUID() };
  const first = await ok(await move(request));
  const changed = await ok<WireTask>(await harness.mutate('PATCH',
    `/api/tasks/v1/${task.name}?request_id=${randomUUID()}&etag=${task.etag}&update_mask=planning_flags`, { planning_flags: [] }));
  await refused(await move({ ...request, request_id: randomUUID() }));
  expect(await ok(await move(request))).toEqual(first);
  await ok(await harness.mutate('DELETE', `/api/tasks/v1/${task.name}?request_id=${randomUUID()}&etag=${changed.etag}`));
  expect(await ok(await move(request))).toEqual(first);
  expect((await harness.db.prepare('SELECT task_id FROM day_steps WHERE task_id=? AND deleted_at IS NULL').bind(task.id).all()).results).toEqual([]);
});

test('an old queue entry can still be removed after it loses executable classification', async () => {
  const task = await make({ title: 'Synthetic old queued outcome' });
  await harness.db.prepare("INSERT INTO day_steps(day,task_id,position,created_at,updated_at) VALUES('2030-10-23',?,1,1,1)").bind(task.id).run();
  await ok(await move({ task_id: task.id, source_day: '2030-10-23', request_id: randomUUID() }));
  expect((await harness.db.prepare('SELECT task_id FROM day_steps WHERE task_id=? AND deleted_at IS NULL').bind(task.id).all()).results).toEqual([]);
});
