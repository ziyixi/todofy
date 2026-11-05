import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { SavedFilterSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { addDays, localDate } from '@ziyixi/task-dates';
import { objectReceiptHash, startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

async function resetCatalogDb(db: D1Database) {
  await db.batch([
    db.prepare('DELETE FROM task_labels'),
    db.prepare('DELETE FROM tasks'),
    db.prepare('DELETE FROM sections'),
    db.prepare('DELETE FROM projects'),
    db.prepare('DELETE FROM labels'),
    db.prepare('DELETE FROM filters'),
    db.prepare('DELETE FROM requests'),
    db.prepare('DELETE FROM changes'),
  ]);
}

describe('filter colors and receipt compatibility', () => {
  beforeAll(async () => {
    await resetCatalogDb(harness.db);
  });

  test('adding filter colors preserves existing filters, request receipts and completion history', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(readFileSync(new URL('../../../migrations/0001_tasks.sql', import.meta.url), 'utf8'));
      db.exec(
        "INSERT INTO filters(id,title,query,created_at,updated_at) VALUES('existing','Existing filter','today',1,1)",
      );
      db.exec(
        "INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES('existing-action','synthetic','{}',1,1)",
      );
      db.exec(
        "INSERT INTO completions(id,task_id,title,completed_at) VALUES('existing-history','existing-task','Synthetic completed task',1)",
      );
      const receipt = db.prepare('SELECT * FROM requests').get();
      const history = db.prepare('SELECT * FROM completions').get();
      db.exec(readFileSync(new URL('../../../migrations/0002_filter_colors.sql', import.meta.url), 'utf8'));
      expect(db.prepare('SELECT id,title,query,color,revision FROM filters').get()).toEqual({
        id: 'existing',
        title: 'Existing filter',
        query: 'today',
        color: '',
        revision: 1,
      });
      expect(db.prepare('SELECT * FROM requests').get()).toEqual(receipt);
      expect(db.prepare('SELECT * FROM completions').get()).toEqual(history);
    } finally {
      db.close();
    }
  });

  test('filter colors persist through catalog reads and partial edits, while invalid colors are rejected', async () => {
    const created = await harness.mutate('POST', `/api/tasks/v1/filters?request_id=${randomUUID()}`, {
      title: 'Synthetic colored filter',
      query: 'today',
      color: '#eb96eb',
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const filter = await created.json<{ id: string; name: string; etag: string; color: string }>();
    expect(filter.color).toBe('#eb96eb');
    const renamed = await harness.mutate(
      'PATCH',
      `/api/tasks/v1/${filter.name}?request_id=${randomUUID()}&etag=${filter.etag}&update_mask=title`,
      {
        title: 'Renamed synthetic filter',
      },
    );
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const saved = await renamed.json<{ id: string; etag: string; color: string }>();
    expect(saved.id).toBe(filter.id);
    expect(saved.color).toBe('#eb96eb');
    const invalid = await harness.mutate(
      'PATCH',
      `/api/tasks/v1/${filter.name}?request_id=${randomUUID()}&etag=${saved.etag}&update_mask=color`,
      {
        color: 'unrecognized-color',
      },
    );
    expect(invalid.status).toBe(400);
    const changed = await harness.mutate(
      'PATCH',
      `/api/tasks/v1/${filter.name}?request_id=${randomUUID()}&etag=${saved.etag}&update_mask=color`,
      {
        color: '#96c3eb',
      },
    );
    expect(changed.status, await changed.clone().text()).toBe(200);
    const catalog = await (
      await harness.fetch('/api/tasks/v1/catalog')
    ).json<{ filters: { id: string; color: string; query: string }[] }>();
    expect(catalog.filters.find((item) => item.id === filter.id)).toMatchObject({
      color: '#96c3eb',
      query: 'today',
    });
  });

  test('a request made before the color field was added replays its existing receipt unchanged', async () => {
    await resetCatalogDb(harness.db);
    const requestId = randomUUID();
    const resource: Record<string, unknown> = {
      ...create(SavedFilterSchema, { title: 'Synthetic old filter', query: 'today' }),
    };
    delete resource.color; // Exact typed input shape used before SavedFilter.color existed.
    const hash = await objectReceiptHash('create:filters', { requestId, id: '', resource });
    const previous = {
      id: 'previous-filter',
      name: 'filters/previous-filter',
      title: 'Synthetic old filter',
      query: 'today',
      etag: '1',
    };
    await harness.db
      .prepare('INSERT INTO filters(id,title,query,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(previous.id, previous.title, previous.query, 1, 1)
      .run();
    await harness.db
      .prepare('INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES(?,?,?,?,1)')
      .bind(requestId, hash, JSON.stringify(previous), 1)
      .run();
    const repeated = await harness.mutate('POST', `/api/tasks/v1/filters?request_id=${requestId}`, {
      title: previous.title,
      query: previous.query,
    });
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    expect(await repeated.json()).toMatchObject(previous);
    const changed = await harness.mutate('POST', `/api/tasks/v1/filters?request_id=${requestId}`, {
      title: previous.title,
      query: previous.query,
      color: '#db4035',
    });
    expect(changed.status).toBe(400);
    expect(await harness.db.prepare('SELECT COUNT(*) AS total FROM filters').first()).toEqual({ total: 1 });
    expect(
      await harness.db.prepare('SELECT fingerprint,response FROM requests WHERE id=?').bind(requestId).first(),
    ).toEqual({ fingerprint: hash, response: JSON.stringify(previous) });
  });
});

describe('catalog counts and view parity', () => {
  beforeAll(async () => {
    await resetCatalogDb(harness.db);
  });

  test('catalog counts match default task views, including subtasks, archive visibility and saved-filter predicates', async () => {
    const db = harness.db;
    const today = localDate(Date.now(), 'America/Los_Angeles');
    await db.batch([
      db.prepare("INSERT INTO projects(id,title,inbox,created_at,updated_at) VALUES('inbox','Inbox',1,1,1)"),
      db.prepare("INSERT INTO projects(id,title,created_at,updated_at) VALUES('studio','Synthetic studio',1,1)"),
      db.prepare(
        "INSERT INTO projects(id,title,archived,created_at,updated_at) VALUES('archive','Synthetic archive',1,1,1)",
      ),
      db.prepare("INSERT INTO labels(id,title,created_at,updated_at) VALUES('scope','Synthetic scope',1,1)"),
      db.prepare("INSERT INTO labels(id,title,created_at,updated_at) VALUES('empty','Synthetic empty',1,1)"),
      db
        .prepare("INSERT INTO filters(id,title,query,created_at,updated_at) VALUES('urgent','Synthetic urgent',?,1,1)")
        .bind('@Synthetic scope & (today | p1)'),
    ]);
    const tasks = [
      {
        id: 'unfiled',
        project: '',
        parent: '',
        date: '',
        priority: 4,
        archived: 0,
        completed: 0,
      },
      {
        id: 'inbox-root',
        project: 'inbox',
        parent: '',
        date: today,
        priority: 4,
        archived: 0,
        completed: 0,
      },
      {
        id: 'studio-root',
        project: 'studio',
        parent: '',
        date: addDays(today, -1),
        priority: 1,
        archived: 0,
        completed: 0,
      },
      {
        id: 'studio-child',
        project: 'studio',
        parent: 'studio-root',
        date: today,
        priority: 4,
        archived: 0,
        completed: 0,
      },
      {
        id: 'studio-next',
        project: 'studio',
        parent: '',
        date: addDays(today, 7),
        priority: 4,
        archived: 0,
        completed: 0,
      },
      {
        id: 'archived-root',
        project: 'archive',
        parent: '',
        date: today,
        priority: 1,
        archived: 1,
        completed: 0,
      },
      {
        id: 'done',
        project: 'studio',
        parent: '',
        date: today,
        priority: 1,
        archived: 0,
        completed: 1,
      },
    ];
    for (const task of tasks) {
      await db
        .prepare(
          `INSERT INTO tasks(id,title,project_id,parent_id,due_date,priority,project_archived,completed,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,1)`,
        )
        .bind(
          task.id,
          task.id,
          task.project,
          task.parent,
          task.date,
          task.priority,
          task.archived,
          task.completed,
        )
        .run();
      await db.prepare('INSERT INTO task_labels(task_id,label_id) VALUES(?,?)').bind(task.id, 'scope').run();
    }
    const response = await harness.fetch('/api/tasks/v1/catalog');
    expect(response.status, await response.clone().text()).toBe(200);
    const catalog = (await response.json()) as {
      task_counts: { view: string; id?: string; count?: number }[];
    };
    const count = (view: string, id = '') =>
      catalog.task_counts.find((row) => row.view === view && (row.id ?? '') === id)?.count ?? 0;
    expect(count('inbox')).toBe(2);
    expect(count('today')).toBe(3);
    expect(count('upcoming')).toBe(2);
    expect(count('project', 'studio')).toBe(2);
    expect(count('label', 'scope')).toBe(5);
    expect(count('label', 'empty')).toBe(0);
    expect(count('filter', 'urgent')).toBe(3);
    for (const row of catalog.task_counts) {
      const parameters = new URLSearchParams({
        view: row.view,
        page_size: '100',
      });
      if (['project', 'label', 'filter'].includes(row.view)) parameters.set(`${row.view}_id`, row.id ?? '');
      const list = await harness.fetch(`/api/tasks/v1/tasks?${parameters.toString()}`);
      expect(list.status, await list.clone().text()).toBe(200);
      const data = (await list.json()) as { tasks?: unknown[] };
      expect(row.count ?? 0, `${row.view}/${row.id ?? ''}`).toBe((data.tasks ?? []).length);
    }
  });

  test('saved-filter counts bind punctuation and batch across filter and parameter boundaries', async () => {
    const db = harness.db;
    await db
      .prepare("INSERT INTO labels(id,title,created_at,updated_at) VALUES('punctuation',?,1,1)")
      .bind("Synthetic owner's work")
      .run();
    await db.prepare("INSERT INTO task_labels(task_id,label_id) VALUES('studio-root','punctuation')").run();
    const query = "@Synthetic owner's work & (p1 | p2 | p3 | p4 | today | no date)";
    await db.batch(
      Array.from({ length: 25 }, (_, index) =>
        db
          .prepare('INSERT INTO filters(id,title,query,created_at,updated_at) VALUES(?,?,?,1,1)')
          .bind(`batched-${String(index)}`, `Synthetic batch ${String(index)}`, query),
      ),
    );
    const response = await harness.fetch('/api/tasks/v1/catalog');
    expect(response.status, await response.clone().text()).toBe(200);
    const data = (await response.json()) as {
      task_counts: { view: string; id?: string; count?: number }[];
    };
    const matches = data.task_counts.filter((row) => row.view === 'filter' && row.id?.startsWith('batched-'));
    expect(matches).toHaveLength(25);
    expect(matches.every((row) => row.count === 1)).toBe(true);
  });

  test('catalog metadata-only reads preserve organization while legacy and explicit full reads retain badges', async () => {
    const legacy = await harness.fetch('/api/tasks/v1/catalog');
    const explicit = await harness.fetch('/api/tasks/v1/catalog?include_task_counts=true');
    const metadata = await harness.fetch('/api/tasks/v1/catalog?include_task_counts=false');
    expect([legacy.status, explicit.status, metadata.status]).toEqual([200, 200, 200]);
    const full = (await legacy.json()) as Record<string, unknown>;
    expect(full.task_counts).toBeInstanceOf(Array);
    expect(await explicit.json()).toEqual(full);
    const { task_counts, ...organization } = full;
    expect((task_counts as unknown[]).length).toBeGreaterThan(0);
    expect(await metadata.json()).toEqual(organization);
  });

  test('ordinary views and badges exclude Steps while children and all-view searches retain them', async () => {
    const today = localDate(Date.now(), 'America/Los_Angeles');
    const baseline = (await (await harness.fetch('/api/tasks/v1/catalog')).json()) as {
      task_counts: { view: string; count?: number }[];
    };
    const before = baseline.task_counts.find((x) => x.view === 'today')?.count ?? 0;
    await harness.db.batch([
      harness.db
        .prepare(
          "INSERT INTO tasks(id,title,due_date,created_at,updated_at) VALUES('view-parent','Synthetic kind-view parent',?,1,1)",
        )
        .bind(today),
      harness.db
        .prepare(
          "INSERT INTO tasks(id,title,parent_id,due_date,created_at,updated_at) VALUES('view-child','Synthetic kind-view child','view-parent',?,1,1)",
        )
        .bind(today),
      harness.db
        .prepare(
          "INSERT INTO tasks(id,title,parent_id,kind,due_date,created_at,updated_at) VALUES('view-step','Synthetic kind-view only-step','view-parent','step',?,1,1)",
        )
        .bind(today),
    ]);
    const list = (await (await harness.fetch('/api/tasks/v1/tasks?view=today')).json()) as {
      tasks: { id: string; kind: string }[];
    };
    expect(list.tasks.some((x) => x.id === 'view-step')).toBe(false);
    expect(
      list.tasks
        .filter((x) => x.id.startsWith('view-'))
        .map((x) => x.id)
        .sort(),
    ).toEqual(['view-child', 'view-parent']);
    const catalog = (await (await harness.fetch('/api/tasks/v1/catalog')).json()) as {
      task_counts: { view: string; count?: number }[];
    };
    expect(catalog.task_counts.find((x) => x.view === 'today')?.count).toBe(before + 2);
    const children = (await (await harness.fetch('/api/tasks/v1/tasks?parent_id=view-parent')).json()) as {
      tasks: { id: string }[];
    };
    expect(children.tasks.map((x) => x.id).sort()).toEqual(['view-child', 'view-step']);
    const search = (await (
      await harness.fetch('/api/tasks/v1/tasks?view=all&query=Synthetic%20kind-view%20only-step')
    ).json()) as { tasks: { id: string }[] };
    expect(search.tasks.map((x) => x.id)).toEqual(['view-step']);
  });
});

describe('catalog deletion', () => {
  beforeAll(async () => {
    await resetCatalogDb(harness.db);
  });

  interface Resource {
    id: string;
    name: string;
    etag: string;
    label_ids?: string[];
  }
  async function make(kind: string, body: Record<string, unknown>): Promise<Resource> {
    const response = await harness.mutate('POST', `/api/tasks/v1/${kind}?request_id=${randomUUID()}`, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<Resource>;
  }
  async function remove(resource: Resource, requestId = randomUUID()) {
    return harness.mutate('DELETE', `/api/tasks/v1/${resource.name}?etag=${resource.etag}&request_id=${requestId}`);
  }
  async function exists(resource: Resource) {
    return (await harness.fetch(`/api/tasks/v1/${resource.name}`)).status;
  }

  test('deleting a nonempty project removes its whole hierarchy and emits task tombstones once', async () => {
    const project = await make('projects', { title: 'Synthetic parent project' });
    const nested = await make('projects', {
      title: 'Nested project',
      parent_id: project.id,
    });
    const section = await make('sections', {
      title: 'Nested section',
      project_id: nested.id,
    });
    const parent = await make('tasks', {
      title: 'Parent task',
      project_id: nested.id,
      section_id: section.id,
    });
    const child = await make('tasks', {
      title: 'Child task',
      parent_id: parent.id,
    });
    const outside = await make('tasks', { title: 'Unrelated Inbox task' });
    const cursor = await harness.db.prepare('SELECT MAX(sequence) AS n FROM changes').first<{ n: number }>();
    const id = randomUUID();
    expect((await remove(project, id)).status).toBe(200);
    expect(await exists(parent)).toBe(404);
    expect(await exists(child)).toBe(404);
    expect(await exists(outside)).toBe(200);
    const deleted = await harness.db
      .prepare('SELECT resource_id FROM changes WHERE sequence>? AND resource=? AND deleted=1')
      .bind(cursor?.n ?? 0, 'tasks')
      .all<{ resource_id: string }>();
    expect(deleted.results.map((row) => row.resource_id).sort()).toEqual([parent.id, child.id].sort());
    const count = await harness.db.prepare('SELECT COUNT(*) AS n FROM changes').first<{ n: number }>();
    expect((await remove(project, id)).status).toBe(200);
    expect(await harness.db.prepare('SELECT COUNT(*) AS n FROM changes').first()).toEqual(count);
    const catalogResponse = await harness.fetch('/api/tasks/v1/catalog');
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as { projects?: Resource[]; sections?: Resource[] };
    expect((catalog.projects ?? []).some((row) => row.id === project.id || row.id === nested.id)).toBe(false);
    expect((catalog.sections ?? []).some((row) => row.id === section.id)).toBe(false);
  });

  test('deleting a section includes descendants and preserves tasks in other sections', async () => {
    const project = await make('projects', { title: 'Section owner' });
    const section = await make('sections', {
      title: 'To remove',
      project_id: project.id,
    });
    const other = await make('sections', {
      title: 'To keep',
      project_id: project.id,
    });
    const parent = await make('tasks', {
      title: 'Section parent',
      project_id: project.id,
      section_id: section.id,
    });
    const child = await make('tasks', {
      title: 'Explicit child',
      parent_id: parent.id,
      project_id: project.id,
    });
    const outside = await make('tasks', {
      title: 'Other section task',
      project_id: project.id,
      section_id: other.id,
    });
    expect((await remove(section)).status).toBe(200);
    expect(await exists(parent)).toBe(404);
    expect(await exists(child)).toBe(404);
    expect(await exists(outside)).toBe(200);
  });

  test('deleting a used label detaches it without deleting tasks or unrelated labels', async () => {
    const label = await make('labels', { title: 'Remove me' });
    const other = await make('labels', { title: 'Keep me' });
    const first = await make('tasks', {
      title: 'Both labels',
      label_ids: [label.id, other.id],
    });
    const second = await make('tasks', {
      title: 'One label',
      label_ids: [label.id],
    });
    expect((await remove(label)).status).toBe(200);
    const saved = (await (await harness.fetch(`/api/tasks/v1/${first.name}`)).json()) as Resource;
    const savedSecond = (await (await harness.fetch(`/api/tasks/v1/${second.name}`)).json()) as Resource;
    expect(saved.label_ids).toEqual([other.id]);
    expect(savedSecond.label_ids ?? []).toEqual([]);
    expect(saved.etag).not.toEqual(first.etag);
    expect(await exists(first)).toBe(200);
    expect(await exists(second)).toBe(200);
  });
});
