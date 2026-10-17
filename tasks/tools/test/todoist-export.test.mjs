import test from 'node:test';
import assert from 'node:assert/strict';
import { completionWindows, exportSnapshot, readArchivedSections, readPages, todoistRead, privateOutput } from '../todoist-export.mjs';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('private output permits a sibling temporary directory and rejects repository output or overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-export-test-'));
  try {
    const output = join(directory, 'snapshot.json');
    await privateOutput(output, { synthetic: true });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { synthetic: true });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(() => privateOutput(output, {}), { code: 'EEXIST' });
    await assert.rejects(() => privateOutput(fileURLToPath(new URL('../do-not-create.json', import.meta.url)), {}), /OUTSIDE_REPOSITORY/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function snapshotReader(calls, transform = (path, value) => value) {
  return async (path, body) => {
    calls.push([path, body]);
    let value;
    if (path === '/sync') value = {
      full_sync: true,
      sync_token: 'synthetic',
      items: [{ id: 'task-1', project_id: 'project-1', content: 'Synthetic current task' }],
      projects: [{ id: 'project-1' }], sections: [], labels: [], filters: [],
      user: { tz_info: { timezone: 'UTC' }, is_premium: true },
    };
    else if (path.startsWith('/projects/archived')) value = { results: [{ id: 'archive-1', is_archived: true }] };
    else if (path === '/projects/archive-1/full') value = {
      project: { id: 'archive-1', is_archived: true },
      tasks: [{ id: 'archived-task', project_id: 'archive-1' }],
      sections: [],
    };
    else if (path === '/projects/project-1/full') value = {
      project: { id: 'project-1' }, tasks: [], sections: [],
    };
    else if (path.startsWith('/sections/archived')) {
      const archivedSections = new URL(path, 'https://api.example.test').searchParams.get('project_id') === 'archive-1'
        ? [{ id: 'section-1', project_id: 'archive-1', is_archived: true }] : [];
      value = { completed_info: [], sections: archivedSections, total: archivedSections.length, has_more: false };
    }
    else if (path.startsWith('/tasks?')) value = { results: [{ id: 'archived-section-task', project_id: 'archive-1', section_id: 'section-1' }] };
    else if (path.startsWith('/activities')) value = path.includes('cursor=activities-second') ? {
      results: [{ id: 102, object_type: 'item', event_type: 'completed', object_id: 'task-1', event_date: '2026-10-04T00:00:00Z', extra_data: { content: 'Recurring completion 2' } }],
      next_cursor: null,
    } : {
      results: [{ id: 101, object_type: 'item', event_type: 'completed', object_id: 'task-1', event_date: '2026-10-03T00:00:00Z', extra_data: { content: 'Recurring completion 1' } }],
      next_cursor: 'activities-second',
    };
    else value = path.includes('cursor=second') ? {
      items: [{ id: 'task-3', completed_at: '2026-10-02T00:00:00Z' }],
    } : {
      items: [{ id: 'task-2', completed_at: '2026-10-01T00:00:00Z' }], next_cursor: 'second',
    };
    return transform(path, value);
  };
}

test('export includes archived tasks and recurring activity without mutation commands', async () => {
  const calls = [];
  const result = await exportSnapshot(
    snapshotReader(calls),
    '2026-10-01',
    new Date('2026-10-17T00:00:00Z'),
  );
  assert.equal(result.tasks.length, 3);
  assert.ok(result.tasks.some((task) => task.id === 'archived-section-task'));
  assert.equal(result.projects.length, 2);
  assert.equal(result.sections.length, 1);
  assert.equal(result.completed.length, 2);
  assert.equal(result.completion_events.length, 2);
  assert.equal(result.archived_contents_verified, true);
  assert.equal(result.recurring_history_verified, true);
  assert.ok(calls.every(([, body]) => !body?.commands));
});

test('a malformed full-project response or limited history cannot claim complete coverage', async () => {
  await assert.rejects(() => exportSnapshot(snapshotReader([], (path, value) =>
    path.endsWith('/full') ? { ...value, tasks: [{ id: 'wrong-project', project_id: 'unrelated' }] } : value,
  ), '2026-10-01', new Date('2026-10-17T00:00:00Z')), /FULL_PROJECT_INVALID/);
  const limited = await exportSnapshot(snapshotReader([], (path, value) =>
    path === '/sync' && value.user ? { ...value, user: { ...value.user, is_premium: false } } : value,
  ), '2026-10-01', new Date('2026-10-17T00:00:00Z'));
  assert.equal(limited.recurring_history_verified, false);
  assert.equal(limited.history_access, 'limited_or_unknown');
  await assert.rejects(() => exportSnapshot(snapshotReader([], (path, value) =>
    path.startsWith('/activities') ? { results: value.results } : value,
  ), '2026-10-01', new Date('2026-10-17T00:00:00Z')), /ACTIVITY_PAGE_INCOMPLETE/);
});

test('history windows cover the requested range without gaps', () => {
  const windows = completionWindows('2026-01-01', '2026-04-01');
  assert.equal(windows[0].since, '2026-01-01T00:00:00.000Z');
  assert.equal(windows.at(-1).until, '2026-04-01T00:00:00.000Z');
  for (let index = 1; index < windows.length; index++) assert.equal(windows[index].since, windows[index - 1].until);
});

test('activity reads stay within seven-day windows and deduplicate boundaries while preserving the exact requested times', async () => {
  const ranges = [];
  const events = [
    { id: 201, event_date: '2026-10-01T09:29:59Z' },
    { id: 202, event_date: '2026-10-01T09:30:00Z' },
    { id: 203, event_date: '2026-10-08T00:00:00Z' },
    { id: 204, event_date: '2026-10-17T13:00:00Z' },
    { id: 205, event_date: '2026-10-17T12:59:59Z' },
  ].map((row) => ({ ...row, object_type: 'item', event_type: 'completed', object_id: 'task-1' }));
  const result = await exportSnapshot(snapshotReader([], (path, value) => {
    if (!path.startsWith('/activities')) return value;
    const query = new URL(path, 'https://api.example.test').searchParams;
    const start = query.get('date_from');
    const end = query.get('date_to');
    assert.match(start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(end, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Date.parse(end) - Date.parse(start) <= 7 * 86_400_000);
    if (!query.has('cursor')) ranges.push([start, end]);
    const matching = events.filter((event) => Date.parse(event.event_date) >= Date.parse(start) && Date.parse(event.event_date) <= Date.parse(end));
    const offset = query.has('cursor') ? 1 : 0;
    return { results: matching.slice(offset, offset ? undefined : 1), next_cursor: !offset && matching.length > 1 ? 'next' : null };
  }), '2026-10-01T09:30:00Z', new Date('2026-10-17T13:00:00Z'));
  assert.deepEqual(ranges, [['2026-10-01', '2026-10-08'], ['2026-10-08', '2026-10-15'], ['2026-10-15', '2026-10-18']]);
  assert.deepEqual(result.completion_events.map((event) => event.id).sort(), [202, 203, 205]);
});

test('archived sections use their observed sections/has_more/total shape', async () => {
  const sections = Array.from({ length: 3 }, (_, index) => ({ id: `section-${index}`, project_id: 'project-1' }));
  const result = await readArchivedSections(async (path) => {
    const url = new URL(path, 'https://api.example.test');
    assert.equal(url.pathname, '/sections/archived');
    assert.equal(url.searchParams.get('project_id'), 'project-1');
    assert.equal(url.searchParams.has('cursor'), false);
    assert.equal(url.searchParams.has('offset'), false);
    return { completed_info: [], sections, total: sections.length, has_more: false };
  }, 'project-1');
  assert.deepEqual(result, sections);
});

test('archived-section reads refuse unverified pagination or an incomplete terminal page', async () => {
  await assert.rejects(() => readArchivedSections(async () => ({
    sections: [{ id: 'section-1', project_id: 'project-1' }], total: 2, has_more: true,
  }), 'project-1'), /ARCHIVED_SECTION_PAGINATION_UNVERIFIED/);
  await assert.rejects(() => readArchivedSections(async () => ({
    sections: [{ id: 'section-1', project_id: 'project-1' }], total: 2, has_more: false,
  }), 'project-1'), /ARCHIVED_SECTION_PAGE_INCOMPLETE/);
});

test('incomplete pages and repeated cursors stop instead of silently losing records', async () => {
  await assert.rejects(() => readPages(async () => ({}), '/tasks'), /PAGE_INVALID/);
  await assert.rejects(() => readPages(async () => ({ results: [], next_cursor: 'same' }), '/tasks'), /CURSOR_INVALID/);
});

test('authentication failure exposes status but neither body nor token', async () => {
  await assert.rejects(
    () =>
      todoistRead('synthetic-secret', '/projects', {
        fetcher: async () => new Response('private upstream details', { status: 403 }),
      }),
    { message: 'TODOIST_READ_HTTP_403' },
  );
});

test('raw unsafe numeric source IDs retain their exact decimal identity', async () => {
  const page = await todoistRead('synthetic-secret', '/activities', {
    fetcher: async () => new Response('{"results":[{"id":9007199254740993123},{"id":9007199254740993124},{"id":42}],"next_cursor":null}'),
  });
  assert.deepEqual(page.results.map((event) => event.id), ['9007199254740993123', '9007199254740993124', 42]);
});

test('Sync uses the official form transport without mutation commands', async () => {
  let request;
  await todoistRead('synthetic-secret', '/sync', {
    body: { sync_token: '*', resource_types: ['items', 'projects'] },
    fetcher: async (url, init) => {
      request = init;
      assert.equal(url, 'https://api.todoist.com/api/v1/sync');
      return Response.json({});
    },
  });
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(request.body.get('sync_token'), '*');
  assert.deepEqual(JSON.parse(request.body.get('resource_types')), ['items', 'projects']);
  assert.equal(request.body.has('commands'), false);
});
