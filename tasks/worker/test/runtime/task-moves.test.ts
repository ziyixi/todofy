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
    const catalog = await response.json() as { sections?: Resource[] };
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
    title: 'Descendant without its own section', project_id: project.id, parent_id: older.id,
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
  const failure = await rejected.json() as { error?: { message?: string } };
  expect(failure.error?.message).toContain('parent');
  expect((await read(child)).project_id).toBe(project.id);
  expect((await read(otherSection)).project_id).toBe(project.id);
});
