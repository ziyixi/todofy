import test from 'node:test';
import assert from 'node:assert/strict';
import { completionWindows, exportSnapshot, readPages, todoistRead, privateOutput } from '../todoist-export.mjs';
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
    if (path === '/sync') value = body.sync_token === '*' ? {
      full_sync: true,
      sync_token: 'synthetic',
      items: [{ id: 'task-1', project_id: 'project-1', content: 'Before final sync' }],
      projects: [{ id: 'project-1' }], sections: [], labels: [], filters: [],
      user: { tz_info: { timezone: 'UTC' }, is_premium: true },
    } : {
      full_sync: false, sync_token: 'synthetic-current',
      items: [{ id: 'task-1', project_id: 'project-1', content: 'Final current title' }],
    };
    else if (path.startsWith('/projects/archived')) value = { results: [{ id: 'archive-1', is_archived: true }] };
    else if (path === '/projects/archive-1/full') value = {
      project: { id: 'archive-1', is_archived: true },
      tasks: [{ id: 'archived-task', project_id: 'archive-1' }],
      sections: [{ id: 'section-1', project_id: 'archive-1', is_archived: true }],
    };
    else if (path === '/projects/project-1/full') value = {
      project: { id: 'project-1' }, tasks: [], sections: [],
    };
    else if (path.startsWith('/sections/archived')) value = { results: [] };
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
  assert.equal(result.tasks.length, 2);
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
