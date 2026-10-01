/**
 * The read-only Todoist client and the sync plan (../src/todoist.ts, ../src/sync.ts), in Node without bindings.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseProjects, planSync, serializeProjects } from '../src/sync.ts';
import { FULL_SYNC_TOKEN, MAX_SYNC_ITEMS, TODOIST_SYNC_URL, TodoistError, durationMinutes, fetchSync, itemToRow, parseSyncAnswer, todoistColorToHex } from '../src/todoist.ts';

const answer = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

describe('fetchSync', () => {
  it('POSTs the token and the two resource types to the Sync API with the bearer key, nothing else', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(answer({ sync_token: 'next', full_sync: true, items: [], projects: [] })));
    const result = await fetchSync('secret-key', FULL_SYNC_TOKEN, fetcher);
    expect(result).toEqual({ syncToken: 'next', fullSync: true, items: [], projects: [] });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(TODOIST_SYNC_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-key' });
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    expect([...form.keys()].sort()).toEqual(['resource_types', 'sync_token']);
    expect(form.get('sync_token')).toBe('*');
    expect(form.get('resource_types')).toBe('["items","projects"]');
  });

  it('maps failures: 401/403 unauthorized, other statuses and network errors unavailable, bad JSON invalid', async () => {
    const run = (response: Response | Error) =>
      fetchSync('k', 'tok', () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
    await expect(run(new Response('', { status: 401 }))).rejects.toMatchObject({ failure: 'unauthorized' });
    await expect(run(new Response('', { status: 403 }))).rejects.toMatchObject({ failure: 'unauthorized' });
    await expect(run(new Response('bad gateway', { status: 502 }))).rejects.toMatchObject({ failure: 'unavailable', status: 502 });
    await expect(run(new Error('network'))).rejects.toMatchObject({ failure: 'unavailable' });
    await expect(run(new Response('not json'))).rejects.toMatchObject({ failure: 'invalid_answer' });
    await expect(run(answer({ items: [] }))).rejects.toBeInstanceOf(TodoistError);
  });
});

describe('parseSyncAnswer', () => {
  it('reads items and projects defensively, accepting numeric ids and 0/1 flags', () => {
    const parsed = parseSyncAnswer({
      sync_token: 'abc',
      full_sync: false,
      items: [{ id: 42, content: 'Task', project_id: 7, checked: 1, is_deleted: 0, labels: ['a', 3], due: { date: '2026-04-13' }, duration: { amount: 2, unit: 'day' } }, { content: 'no id' }],
      projects: [{ id: 7, name: 'P', color: 'red', is_deleted: true }],
    });
    expect(parsed.items).toEqual([expect.objectContaining({ id: '42', project_id: '7', checked: true, is_deleted: false, labels: ['a'], due: { date: '2026-04-13' }, duration: { amount: 2, unit: 'day' } })]);
    expect(parsed.projects).toEqual([{ id: '7', name: 'P', color: 'red', is_deleted: true, is_archived: false }]);
  });

  it(`refuses more than ${String(MAX_SYNC_ITEMS)} items`, () => {
    expect(() => parseSyncAnswer({ sync_token: 't', items: new Array(MAX_SYNC_ITEMS + 1).fill({ id: '1' }) })).toThrow(TodoistError);
  });
});

describe('item transform', () => {
  it('converts durations (days are 480 minutes), due days, priorities and project names', () => {
    expect(durationMinutes({ amount: 90, unit: 'minute' })).toBe(90);
    expect(durationMinutes({ amount: 2, unit: 'day' })).toBe(960);
    expect(durationMinutes(null)).toBeNull();
    expect(todoistColorToHex('sky_blue')).toBe('#14aaf5');
    expect(todoistColorToHex('unknown')).toBe('#808080');
    const projects = new Map([['p1', { name: 'Inbox', color: '#ff9933' }]]);
    const base = { id: 't', content: 'Write', description: '', project_id: 'p1', priority: 9, labels: ['x'], due: { date: '2026-04-15T09:30:00' }, duration: null, added_at: '2026-04-10T00:00:00Z', completed_at: null, checked: false, is_deleted: false };
    expect(itemToRow(base, projects)).toEqual({
      id: 't', todoist_id: 't', title: 'Write', description: null, project_name: 'Inbox', project_color: '#ff9933', priority: 1, labels: '["x"]',
      estimated_mins: null, is_completed: 0, completed_at: null, due_date: '2026-04-15', created_at: '2026-04-10T00:00:00Z', todoist_project_id: 'p1',
    });
  });
});

describe('sync plan', () => {
  const item = (id: string, patch: Record<string, unknown> = {}) => ({ id, content: id, description: '', project_id: 'p1', priority: 1, labels: [], due: null, duration: null, added_at: null, completed_at: null, checked: false, is_deleted: false, ...patch });

  it('incremental: upserts active items, hides completed and deleted ones, renames changed projects', () => {
    const stored = new Map([['p1', { name: 'Old', color: '#4073ff' }], ['p2', { name: 'Same', color: '#4073ff' }]]);
    const plan = planSync(
      { syncToken: 's', fullSync: false, items: [item('a'), item('b', { checked: true }), item('c', { is_deleted: true })], projects: [{ id: 'p1', name: 'New', color: 'blue', is_deleted: false, is_archived: false }] },
      stored,
      '2026-04-13T00:00:00.000Z',
    );
    // 1 upsert chunk + due_date + todoist_id + restore + hide + project rename
    expect(plan.taskStatements).toHaveLength(6);
    expect(serializeProjects(plan.projects)).toBe('{"p1":["New","#4073ff"],"p2":["Same","#4073ff"]}');
  });

  it('full: replaces the project map and hides everything not listed instead of applying flags', () => {
    const plan = planSync({ syncToken: 's', fullSync: true, items: [item('a')], projects: [{ id: 'p9', name: 'Only', color: 'red', is_deleted: false, is_archived: false }] }, new Map([['p1', { name: 'Gone', color: '#000000' }]]), 'now');
    expect(plan.taskStatements).toHaveLength(5);
    expect([...plan.projects.keys()]).toEqual(['p9']);
  });

  it('the stored project map round-trips and survives damage', () => {
    const map = new Map([['b', { name: 'B', color: '#1' }], ['a', { name: 'A', color: '#2' }]]);
    expect(serializeProjects(parseProjects(serializeProjects(map)))).toBe('{"a":["A","#2"],"b":["B","#1"]}');
    expect(parseProjects('not json').size).toBe(0);
    expect(parseProjects(null).size).toBe(0);
  });
});
