import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fromWire } from '@ziyixi/proto/wire-json';
import { ReorderTasksRequestSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { reorderTasks } from '../../src/task-order.ts';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

async function seed(prefix: string, count = 100) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index)}`,
    position: index + 0.25,
  }));
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,description,sort_order,created_at,updated_at)
    SELECT value->>'id','Synthetic reorder task','Keep full stored description',value->>'position',1,1 FROM json_each(?)`,
    )
    .bind(JSON.stringify(rows))
    .run();
  return rows;
}
async function stored(prefix: string) {
  return (
    await harness.db
      .prepare('SELECT id,sort_order,revision,description FROM tasks WHERE id LIKE ? ORDER BY sort_order,id')
      .bind(`${prefix}-%`)
      .all()
  ).results;
}

test('one reorder atomically permutes 100 positions, preserves unlisted tasks and replays without another write', async () => {
  const rows = await seed('hundred');
  const positions = [...rows].reverse().map((row, index) => ({
    name: `tasks/${row.id}`,
    etag: '1',
    sort_order: rows[index]?.position,
  }));
  const outside = await seed('outside', 1);
  const body = { positions, request_id: randomUUID() };
  const response = await harness.mutate('POST', '/api/tasks/v1/tasks:reorder', body);
  expect(response.status, await response.clone().text()).toBe(200);
  // The answer is the repositioned tasks in the order given, at their new etags, without descriptions.
  const answer = await response.json<{ tasks: { id: string; etag: string; sort_order: number; description?: string }[] }>();
  expect(answer.tasks.map((task) => [task.id, task.etag, task.sort_order])).toEqual(
    positions.map((position) => [position.name.slice('tasks/'.length), '2', position.sort_order]),
  );
  expect(answer.tasks.every((task) => task.description === undefined)).toBe(true);
  const after = await stored('hundred');
  expect(after.map((row) => row.id)).toEqual([...rows].reverse().map((row) => row.id));
  expect(after.every((row) => row.revision === 2 && row.description === 'Keep full stored description')).toBe(
    true,
  );
  expect(await stored('outside')).toEqual([
    {
      id: outside[0]?.id,
      sort_order: 0.25,
      revision: 1,
      description: 'Keep full stored description',
    },
  ]);
  const replayed = await harness.mutate('POST', '/api/tasks/v1/tasks:reorder', body);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toEqual(answer);
  expect(await stored('hundred')).toEqual(after);
  const changes = await harness.db
    .prepare('SELECT count(*) n FROM changes WHERE resource_id LIKE ?')
    .bind('hundred-%')
    .first();
  expect(changes).toEqual({ n: 200 }); // 100 creates and 100 position changes; no replay writes.
});

test('a stale non-first task rejects the complete reorder, and a no-op keeps resource revisions unchanged', async () => {
  const rows = await seed('stale', 3);
  await harness.db.prepare('UPDATE tasks SET revision=2 WHERE id=?').bind(rows[2]?.id).run();
  const before = await stored('stale');
  const positions = [...rows].reverse().map((row, index) => ({
    name: `tasks/${row.id}`,
    etag: '1',
    sort_order: index + 5,
  }));
  const rejected = await harness.mutate('POST', '/api/tasks/v1/tasks:reorder', {
    positions,
    request_id: randomUUID(),
  });
  expect(rejected.status).toBe(409);
  expect(await stored('stale')).toEqual(before);
  const unchanged = await harness.mutate('POST', '/api/tasks/v1/tasks:reorder', {
    positions: rows.map((row, index) => ({
      name: `tasks/${row.id}`,
      etag: index === 2 ? '2' : '1',
      sort_order: row.position,
    })),
    request_id: randomUUID(),
  });
  expect(unchanged.status).toBe(200);
  expect(await stored('stale')).toEqual(before);
});

test('reorder rejects duplicate identities and more than 100 tasks without changing storage', async () => {
  const rows = await seed('invalid', 2);
  const first = rows[0];
  if (!first) throw new Error('Missing synthetic task');
  const position = { name: `tasks/${first.id}`, etag: '1', sort_order: 3 };
  for (const positions of [
    [],
    [position, position],
    Array.from({ length: 101 }, (_, index) => ({
      ...position,
      name: `tasks/too-many-${String(index)}`,
    })),
  ]) {
    expect(
      (
        await harness.mutate('POST', '/api/tasks/v1/tasks:reorder', {
          positions,
          request_id: randomUUID(),
        })
      ).status,
    ).toBe(400);
  }
  expect((await stored('invalid')).map((row) => row.revision)).toEqual([1, 1]);
});

test('the transactional guard rejects a non-first task changed after the pre-read without partially reordering', async () => {
  const rows = await seed('raced', 3);
  const last = rows.at(-1);
  if (!last) throw new Error('Missing synthetic task');
  const db = {
    prepare: (sql: string) => harness.db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      await harness.db.prepare('UPDATE tasks SET revision=2 WHERE id=?').bind(last.id).run();
      return harness.db.batch(statements);
    },
  } as unknown as D1Database;
  const input = fromWire(ReorderTasksRequestSchema, {
    positions: rows.map((row, index) => ({
      name: `tasks/${row.id}`,
      etag: '1',
      sort_order: index + 5,
    })),
    request_id: randomUUID(),
  }).message;
  await expect(reorderTasks(db, input, Date.now(), 'UTC')).rejects.toMatchObject({
    reason: 'ETAG_MISMATCH',
  });
  const after = await stored('raced');
  expect(after.map((row) => row.sort_order)).toEqual(rows.map((row) => row.position));
  expect(after.map((row) => row.revision)).toEqual([1, 1, 2]);
  expect(
    await harness.db.prepare('SELECT id FROM requests WHERE id=?').bind(input.requestId).first(),
  ).toBeNull();
});
