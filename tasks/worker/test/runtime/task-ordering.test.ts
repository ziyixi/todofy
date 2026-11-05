import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

async function resetOrderingDb(db: D1Database) {
  await db.batch([
    db.prepare('DELETE FROM task_labels'),
    db.prepare('DELETE FROM tasks'),
    db.prepare('DELETE FROM sections'),
    db.prepare('DELETE FROM projects'),
    db.prepare('DELETE FROM requests'),
    db.prepare('DELETE FROM changes'),
  ]);
}

describe('task sort_order creation and sibling placement', () => {
  beforeAll(async () => {
    await resetOrderingDb(harness.db);
  });

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
    const response = await harness.mutate(
      'PATCH',
      `/api/tasks/v1/${third.name}?request_id=${randomUUID()}&etag=${third.etag}&update_mask=sort_order`,
      {
        sort_order: (first.sort_order + second.sort_order) / 2,
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const listed = await (
      await harness.fetch('/api/tasks/v1/tasks?view=inbox&order_by=sort_order')
    ).json<{ tasks: WireTask[] }>();
    expect(listed.tasks.map((task) => task.id)).toEqual([first.id, third.id, second.id]);
  });

  test('concurrent creates have distinct append positions and explicit zero is preserved', async () => {
    const parent = await create('Ordering parent');
    const children = await Promise.all(
      Array.from({ length: 4 }, (_, i) => create(`Child ${String(i)}`, { parent_id: parent.id })),
    );
    expect(new Set(children.map((task) => task.sort_order)).size).toBe(4);
    const explicit = await create('Explicit first child', { parent_id: parent.id, sort_order: 0 });
    expect(explicit.sort_order).toBe(0);
  });
});

describe('batch task reorder', () => {
  beforeAll(async () => {
    await resetOrderingDb(harness.db);
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
    const answer = await response.json<{
      tasks: { id: string; etag: string; sort_order: number; description?: string }[];
    }>();
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
});

describe('cross-project task and section moves', () => {
  beforeAll(async () => {
    await resetOrderingDb(harness.db);
  });

  interface Resource {
    id: string;
    name: string;
    etag: string;
    project_id?: string;
    parent_id?: string;
    section_id?: string;
    archived?: boolean;
  }
  async function make(kind: string, body: Record<string, unknown>): Promise<Resource> {
    const response = await harness.mutate('POST', `/api/tasks/v1/${kind}?request_id=${randomUUID()}`, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<Resource>;
  }
  async function patch(resource: Resource, fields: Record<string, unknown>, requestId = randomUUID()) {
    return harness.mutate(
      'PATCH',
      `/api/tasks/v1/${resource.name}?etag=${resource.etag}&update_mask=${Object.keys(fields).join(',')}&request_id=${requestId}`,
      fields,
    );
  }
  async function read(resource: Resource): Promise<Resource> {
    if (resource.name.startsWith('sections/')) {
      const response = await harness.fetch('/api/tasks/v1/catalog');
      const catalog = (await response.json()) as { sections?: Resource[] };
      const section = catalog.sections?.find((row) => row.id === resource.id);
      if (!section) throw new Error('Section missing from catalog');
      return section;
    }
    const response = await harness.fetch(`/api/tasks/v1/${resource.name}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<Resource>;
  }
  async function family() {
    const project = await make('projects', { title: 'Synthetic source' });
    const destination = await make('projects', { title: 'Synthetic destination' });
    const section = await make('sections', { title: 'Move this section', project_id: project.id });
    const parent = await make('tasks', { title: 'Parent', project_id: project.id, section_id: section.id });
    const older = await make('tasks', { title: 'Created before its future parent', parent_id: parent.id });
    const newer = await make('tasks', { title: 'Created after its future child', parent_id: parent.id });
    const reparent = await patch(older, { parent_id: newer.id });
    expect(reparent.status, await reparent.clone().text()).toBe(200);
    return { project, destination, section, parent, older, newer };
  }

  test('cross-project task move follows hierarchy instead of task creation order', async () => {
    const { destination, parent, older, newer } = await family();
    const outside = await make('tasks', { title: 'Unrelated task' });
    const requestId = randomUUID();
    const response = await patch(parent, { project_id: destination.id }, requestId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await read(parent)).project_id).toBe(destination.id);
    expect(await read(newer)).toMatchObject({ project_id: destination.id, parent_id: parent.id });
    expect(await read(older)).toMatchObject({ project_id: destination.id, parent_id: newer.id });
    expect((await read(outside)).project_id ?? '').toBe('');
    const changes = await harness.db.prepare('SELECT COUNT(*) AS n FROM changes').first();
    expect((await patch(parent, { project_id: destination.id }, requestId)).status).toBe(200);
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM changes').first()).toEqual(changes);
  });

  test('section project move keeps task IDs, hierarchy and section membership consistent', async () => {
    const { project, destination, section, parent, older, newer } = await family();
    const descendant = await make('tasks', {
      title: 'Descendant without its own section',
      project_id: project.id,
      parent_id: older.id,
    });
    const outside = await make('tasks', { title: 'Outside this section', project_id: project.id });
    const requestId = randomUUID();
    const response = await patch(section, { project_id: destination.id }, requestId);
    expect(response.status, await response.clone().text()).toBe(200);
    for (const task of [parent, newer, older]) {
      expect(await read(task)).toMatchObject({ project_id: destination.id, section_id: section.id });
    }
    expect((await read(older)).parent_id).toBe(newer.id);
    expect((await read(newer)).parent_id).toBe(parent.id);
    expect(await read(descendant)).toMatchObject({ project_id: destination.id, parent_id: older.id });
    expect((await read(descendant)).section_id ?? '').toBe('');
    const saved = await read(older);
    expect((await patch(saved, { title: 'Still editable after the move' })).status).toBe(200);
    expect((await read(outside)).project_id).toBe(project.id);
    const changes = await harness.db.prepare('SELECT COUNT(*) AS n FROM changes').first();
    expect((await patch(section, { project_id: destination.id }, requestId)).status).toBe(200);
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM changes').first()).toEqual(changes);
  });

  test('section move can archive in the same operation and refuses an unrelated outside parent', async () => {
    const { project, destination, section, parent } = await family();
    const response = await patch(section, { project_id: destination.id, archived: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await read(section)).toMatchObject({ project_id: destination.id, archived: true });
    expect((await read(parent)).project_id).toBe(destination.id);
    const otherSection = await make('sections', { title: 'Child-only section', project_id: project.id });
    const outsideParent = await make('tasks', { title: 'Keep this parent', project_id: project.id });
    const child = await make('tasks', {
      title: 'Section child with an outside parent',
      project_id: project.id,
      parent_id: outsideParent.id,
      section_id: otherSection.id,
    });
    const rejected = await patch(otherSection, { project_id: destination.id });
    expect(rejected.status).toBe(400);
    const failure = (await rejected.json()) as { error?: { message?: string } };
    expect(failure.error?.message).toContain('parent');
    expect((await read(child)).project_id).toBe(project.id);
    expect((await read(otherSection)).project_id).toBe(project.id);
  });
});
