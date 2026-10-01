/**
 * The read-only Todoist client and the sync plan (../src/todoist.ts, ../src/sync.ts), in Node without bindings.
 */
import { describe, expect, it, vi } from 'vitest';
import { AUTO_SYNC_MIN_INTERVAL_MS, SYNC_CHUNK, autoInterval, claimValue, parseClaim, parsePending, parseProjects, planChunk, serializeProjects } from '../src/sync.ts';
import {
  FULL_SYNC_TOKEN,
  MAX_SYNC_BYTES,
  MAX_SYNC_ITEMS,
  TODOIST_SYNC_URL,
  TodoistError,
  durationMinutes,
  fetchSync,
  itemToRow,
  parseSyncAnswer,
  readCapped,
  todoistColorToHex,
} from '../src/todoist.ts';

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

  it('refuses a body over MAX_SYNC_BYTES counted in bytes, also without a content-length', async () => {
    expect(MAX_SYNC_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
    // 1.2 M three-byte characters: 3.6 MB as UTF-8 but only 1.2 M UTF-16 units (the old check counted units).
    const wide = '\u20ac'.repeat(700_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wide));
        controller.close();
      },
    });
    expect(wide.length).toBeLessThan(MAX_SYNC_BYTES);
    await expect(readCapped(new Response(stream), MAX_SYNC_BYTES)).rejects.toMatchObject({ failure: 'too_large' });
    await expect(fetchSync('k', 'tok', () => Promise.resolve(new Response(`{"sync_token":"${wide}"}`)))).rejects.toMatchObject({ failure: 'too_large' });
    const declared = new Response('{}', { headers: { 'content-length': String(MAX_SYNC_BYTES + 1) } });
    await expect(fetchSync('k', 'tok', () => Promise.resolve(declared))).rejects.toMatchObject({ failure: 'too_large' });
    expect(await readCapped(new Response('\u20ac\u20ac'), 6)).toBe('\u20ac\u20ac');
    await expect(readCapped(new Response('\u20ac\u20ac\u20ac'), 6)).rejects.toMatchObject({ failure: 'too_large' });
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
  const project = (id: string, patch: Record<string, unknown> = {}) => ({ id, name: id, color: 'blue', is_deleted: false, is_archived: false, ...patch });
  const settingsOf = (plan: { settingStatements: unknown[] }) => JSON.stringify(plan.settingStatements);

  it('incremental: upserts active items, hides completed and deleted ones, renames changed projects', () => {
    const stored = new Map([['p1', { name: 'Old', color: '#4073ff' }], ['p2', { name: 'Same', color: '#4073ff' }]]);
    const plan = planChunk(
      { syncToken: 's', fullSync: false, items: [item('a'), item('b', { checked: true }), item('c', { is_deleted: true })], projects: [project('p1', { name: 'New' })] },
      'old',
      null,
      stored,
      '2026-04-13T00:00:00.000Z',
    );
    // 1 upsert chunk + restore + hide + project rename
    expect(plan.taskStatements).toHaveLength(4);
    expect(plan.partial).toBe(false);
    expect(serializeProjects(plan.projects)).toBe('{"p1":["New","#4073ff"],"p2":["Same","#4073ff"]}');
  });

  it('full: replaces the project map and hides everything not listed instead of applying flags', () => {
    const plan = planChunk({ syncToken: 's', fullSync: true, items: [item('a')], projects: [project('p9', { name: 'Only', color: 'red' })] }, '*', null, new Map([['p1', { name: 'Gone', color: '#000000' }]]), 'now');
    // upsert + restore + orphan
    expect(plan.taskStatements).toHaveLength(3);
    expect([...plan.projects.keys()]).toEqual(['p9']);
  });

  it('archived or deleted projects: dropped from the map, their tasks hidden, their items treated as gone', () => {
    const stored = new Map([['p1', { name: 'Kept', color: '#4073ff' }], ['p2', { name: 'Archived', color: '#4073ff' }]]);
    const plan = planChunk(
      { syncToken: 's', fullSync: false, items: [item('a', { project_id: 'p2' })], projects: [project('p2', { is_archived: true })] },
      'old',
      null,
      stored,
      'now',
    );
    // hide of item a + hide of project p2's tasks (no upsert: a is in an archived project)
    expect(plan.taskStatements).toHaveLength(2);
    expect([...plan.projects.keys()]).toEqual(['p1']);
    expect(plan.partial).toBe(false);
  });

  it('a project the map does not know (new or unarchived) schedules a full pass right after', () => {
    const plan = planChunk({ syncToken: 's2', fullSync: false, items: [], projects: [project('p7')] }, 's1', null, new Map(), 'now');
    expect(plan.partial).toBe(true);
    expect(settingsOf(plan)).toContain('{\\"base\\":\\"*\\",\\"token\\":null,\\"after\\":\\"\\"}');
    // A full answer never schedules another one.
    expect(planChunk({ syncToken: 's3', fullSync: true, items: [], projects: [project('p7')] }, '*', { base: '*', token: null, after: '' }, new Map(), 'now').partial).toBe(false);
  });

  it('applies a large answer in id-ordered chunks of SYNC_CHUNK, keeping the first answer\'s token until the end', () => {
    const items = Array.from({ length: SYNC_CHUNK * 2 + 5 }, (_, n) => item(`t${String(n).padStart(4, '0')}`)).reverse();
    const first = planChunk({ syncToken: 'first', fullSync: true, items, projects: [] }, '*', null, new Map(), 'now');
    expect(first.partial).toBe(true);
    expect(settingsOf(first)).toContain(`\\"after\\":\\"t${String(SYNC_CHUNK - 1).padStart(4, '0')}\\"`);
    expect(settingsOf(first)).toContain('\\"token\\":\\"first\\"');
    const pending = parsePending(`{"base":"*","token":"first","after":"t${String(2 * SYNC_CHUNK - 1).padStart(4, '0')}"}`);
    const last = planChunk({ syncToken: 'third', fullSync: true, items, projects: [] }, '*', pending, new Map(), 'now');
    expect(last.partial).toBe(false);
    // upsert of the last 5 + restore + orphan; the stored token is the pass's first one.
    expect(last.taskStatements).toHaveLength(3);
    expect(settingsOf(last)).toContain('"first"');
    expect(settingsOf(last)).not.toContain('"third"');
  });

  it('an incremental pass that Todoist answers with a full sync restarts as a full pass', () => {
    const items = Array.from({ length: SYNC_CHUNK + 1 }, (_, n) => item(`t${String(n).padStart(4, '0')}`));
    const plan = planChunk({ syncToken: 'reset', fullSync: true, items, projects: [] }, 'old', { base: 'old', token: 'x', after: 't0100' }, new Map(), 'now');
    expect(settingsOf(plan)).toContain('{\\"base\\":\\"*\\",\\"token\\":\\"reset\\",\\"after\\":\\"t0199\\"}');
  });

  it('the stored project map round-trips and survives damage', () => {
    const map = new Map([['b', { name: 'B', color: '#1' }], ['a', { name: 'A', color: '#2' }]]);
    expect(serializeProjects(parseProjects(serializeProjects(map)))).toBe('{"a":["A","#2"],"b":["B","#1"]}');
    expect(parseProjects('not json').size).toBe(0);
    expect(parseProjects(null).size).toBe(0);
  });

  it('claims and pending passes parse strictly; the automatic interval doubles per failure up to 32 times', () => {
    expect(parseClaim('1776063600000')).toEqual({ at: 1776063600000, failures: 0 });
    expect(parseClaim('1776063600000:3')).toEqual({ at: 1776063600000, failures: 3 });
    expect(parseClaim('x')).toBeNull();
    expect(claimValue({ at: 5, failures: 0 })).toBe('5');
    expect(claimValue({ at: 5, failures: 2 })).toBe('5:2');
    expect(parsePending('{"base":"*","token":null,"after":""}')).toEqual({ base: '*', token: null, after: '' });
    expect(parsePending('{"base":"","token":null,"after":""}')).toBeNull();
    expect(parsePending('nope')).toBeNull();
    expect(autoInterval(0)).toBe(AUTO_SYNC_MIN_INTERVAL_MS);
    expect(autoInterval(1)).toBe(2 * AUTO_SYNC_MIN_INTERVAL_MS);
    expect(autoInterval(50)).toBe(32 * AUTO_SYNC_MIN_INTERVAL_MS);
  });
});
