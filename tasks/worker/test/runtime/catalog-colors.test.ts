import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { SavedFilterSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { fingerprint } from '../../src/receipts.ts';
import { startHarness } from './harness.ts';

test('adding filter colors preserves existing filters, request receipts and completion history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../../../migrations/0001_tasks.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO filters(id,title,query,created_at,updated_at) VALUES('existing','Existing filter','today',1,1)");
    db.exec("INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES('existing-action','synthetic','{}',1,1)");
    db.exec("INSERT INTO completions(id,task_id,title,completed_at) VALUES('existing-history','existing-task','Synthetic completed task',1)");
    const receipt = db.prepare('SELECT * FROM requests').get();
    const history = db.prepare('SELECT * FROM completions').get();
    db.exec(readFileSync(new URL('../../../migrations/0002_filter_colors.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT id,title,query,color,revision FROM filters').get()).toEqual({
      id: 'existing', title: 'Existing filter', query: 'today', color: '', revision: 1,
    });
    expect(db.prepare('SELECT * FROM requests').get()).toEqual(receipt);
    expect(db.prepare('SELECT * FROM completions').get()).toEqual(history);
  } finally {
    db.close();
  }
});

test('filter colors persist through catalog reads and partial edits, while invalid colors are rejected', async () => {
  const harness = await startHarness();
  try {
    const created = await harness.mutate('POST', `/api/tasks/v1/filters?request_id=${randomUUID()}`, {
      title: 'Synthetic colored filter', query: 'today', color: '#eb96eb',
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const filter = await created.json<{ id: string; name: string; etag: string; color: string }>();
    expect(filter.color).toBe('#eb96eb');
    const renamed = await harness.mutate('PATCH', `/api/tasks/v1/${filter.name}?request_id=${randomUUID()}&etag=${filter.etag}&update_mask=title`, {
      title: 'Renamed synthetic filter',
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const saved = await renamed.json<{ id: string; etag: string; color: string }>();
    expect(saved.id).toBe(filter.id);
    expect(saved.color).toBe('#eb96eb');
    const invalid = await harness.mutate('PATCH', `/api/tasks/v1/${filter.name}?request_id=${randomUUID()}&etag=${saved.etag}&update_mask=color`, {
      color: 'unrecognized-color',
    });
    expect(invalid.status).toBe(400);
    const changed = await harness.mutate('PATCH', `/api/tasks/v1/${filter.name}?request_id=${randomUUID()}&etag=${saved.etag}&update_mask=color`, {
      color: '#96c3eb',
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const catalog = await (await harness.fetch('/api/tasks/v1/catalog')).json<{ filters: { id: string; color: string; query: string }[] }>();
    expect(catalog.filters.find((item) => item.id === filter.id)).toMatchObject({ color: '#96c3eb', query: 'today' });
  } finally {
    await harness.dispose();
  }
});

test('a request made before the color field was added replays its existing receipt unchanged', async () => {
  const harness = await startHarness();
  try {
    const requestId = randomUUID();
    const resource: Record<string, unknown> = { ...create(SavedFilterSchema, { title: 'Synthetic old filter', query: 'today' }) };
    delete resource.color; // Exact typed input shape used before SavedFilter.color existed.
    const hash = await fingerprint('create:filters', { requestId, id: '', resource });
    const previous = { id: 'previous-filter', name: 'filters/previous-filter', title: 'Synthetic old filter', query: 'today', etag: '1' };
    await harness.db.prepare('INSERT INTO filters(id,title,query,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(previous.id, previous.title, previous.query, 1, 1).run();
    await harness.db.prepare('INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES(?,?,?,?,1)')
      .bind(requestId, hash, JSON.stringify(previous), 1).run();
    const repeated = await harness.mutate('POST', `/api/tasks/v1/filters?request_id=${requestId}`, { title: previous.title, query: previous.query });
    expect(repeated.status, await repeated.clone().text()).toBe(200);
    expect(await repeated.json()).toMatchObject(previous);
    const changed = await harness.mutate('POST', `/api/tasks/v1/filters?request_id=${requestId}`, { title: previous.title, query: previous.query, color: '#db4035' });
    expect(changed.status).toBe(400);
    expect(await harness.db.prepare('SELECT COUNT(*) AS total FROM filters').first()).toEqual({ total: 1 });
    expect(await harness.db.prepare('SELECT fingerprint,response FROM requests WHERE id=?').bind(requestId).first())
      .toEqual({ fingerprint: hash, response: JSON.stringify(previous) });
  } finally {
    await harness.dispose();
  }
});
