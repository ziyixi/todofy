import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImport, importStatements } from '../import-model.ts';
import { startHarness } from '../../worker/test/runtime/harness.ts';

function fixture() {
  const base = {
    added_at: '2020-01-01T00:00:00Z',
    updated_at: '2026-10-17T00:00:00Z',
    priority: 1,
    labels: ['next'],
    description: "Preserve Unicode 中文 and a quote: '",
    parent_id: null,
    section_id: null,
  };
  return {
    version: 1,
    source: 'todoist',
    exported_at: '2026-10-17T00:00:00Z',
    time_zone: 'UTC',
    archived_contents_verified: true,
    recurring_history_verified: true,
    projects: [
      { id: 'inbox', name: 'Inbox', inbox_project: true },
      { id: 'archive', name: 'Archived project', is_archived: true },
    ],
    sections: [],
    labels: [{ id: 'label-next', name: 'next', color: 'blue' }],
    filters: [{ id: 'filter-next', name: 'Next', query: '@next', color: 'lavender' }],
    tasks: [
      {
        ...base,
        id: 'repeat',
        project_id: 'inbox',
        content: 'Current recurring title',
        due: { date: '2026-10-20', is_recurring: true, string: 'every Tue' },
        completed_count: 6,
      },
      { ...base, id: 'archived-task', project_id: 'archive', content: 'Archived unfinished task' },
    ],
    completed: [
      {
        ...base,
        id: 'repeat',
        project_id: 'inbox',
        content: 'Historical title',
        completed_at: '2026-10-06T10:00:00Z',
        due: { date: '2026-10-06' },
      },
      {
        ...base,
        id: 'repeat',
        project_id: 'inbox',
        content: 'Historical title 2',
        completed_at: '2026-10-13T10:00:00Z',
        due: { date: '2026-10-13' },
      },
    ],
  };
}

test('imports a frozen snapshot into real D1, preserves histories and IDs, and replays unchanged', async () => {
  const harness = await startHarness();
  try {
    const plan = prepareImport(fixture());
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.tasks.find((t) => t.id === 'repeat').completed_base_count, 6);
    const statements = importStatements(plan);
    for (const sql of statements) await harness.db.prepare(sql).run();
    for (const sql of statements) await harness.db.prepare(sql).run();
    const task = await (await harness.fetch('/api/tasks/v1/tasks/repeat')).json();
    assert.equal(task.id, 'repeat');
    assert.equal(task.completed_count, 6);
    assert.equal(task.create_time, '2020-01-01T00:00:00Z');
    assert.equal(task.description, fixture().tasks[0].description);
    assert.equal(task.priority, 4);
    const catalog = await (await harness.fetch('/api/tasks/v1/catalog')).json();
    assert.equal(catalog.filters.find((filter) => filter.id === 'filter-next').color, '#eb96eb');
    const archived = await (await harness.fetch('/api/tasks/v1/tasks/archived-task')).json();
    assert.equal(archived.archived, true);
    const history = await (await harness.fetch('/api/tasks/v1/completions?task_id=repeat')).json();
    assert.equal(history.completions.length, 2);
    assert.equal(history.completions[0].title, 'Historical title 2');
    assert.equal(history.completions[0].project_id, 'inbox');
    await harness.mutate('POST', '/api/tasks/v1/tasks?request_id=19f98fbb-7388-4d62-bf5e-29bd73a65ac5', {
      title: 'Owner started using Tasks',
    });
    await assert.rejects(() => harness.db.prepare(statements[0]).run());
  } finally {
    await harness.dispose();
  }
});

test('coverage gaps and unsupported recurrence block final import rather than discarding data', () => {
  const partial = fixture();
  partial.archived_contents_verified = false;
  const plan = prepareImport(partial);
  assert.deepEqual(plan.gaps, ['ARCHIVED_CONTENTS_UNVERIFIED']);
  assert.throws(() => importStatements(plan), /COVERAGE_NOT_VERIFIED/);
  assert.ok(importStatements(plan, true).length > 1);
  const unsupported = fixture();
  unsupported.tasks[0].due.string = 'every blue moon';
  const bad = prepareImport(unsupported);
  assert.equal(bad.issues[0].code, 'TASK_DATE_OR_RECURRENCE_UNSUPPORTED');
  assert.throws(() => importStatements(bad, true), /UNSUPPORTED_VALUES/);
});

test('unresolved hierarchy or label identities are never flattened or silently dropped', () => {
  const missing = fixture();
  missing.tasks[0].parent_id = 'missing';
  assert.throws(() => prepareImport(missing), /PARENT_RESOURCE_MISSING/);
  const label = fixture();
  label.tasks[0].labels = ['deleted-label'];
  assert.throws(() => prepareImport(label), /LABEL_IDENTITY_UNRESOLVED/);
});

test('historical deleted label names get stable native IDs while current unknown labels still refuse import', async () => {
  const source = fixture();
  source.completed.push(
    { ...source.completed[0], id: 'former-task-one', labels: ['Former Sprint', 'Former Context'] },
    { ...source.completed[0], id: 'former-task-two', labels: ['Former Sprint'] },
  );
  const plan = prepareImport(source);
  const again = prepareImport(structuredClone(source));
  assert.equal(plan.recoveredHistoricalLabels, 2);
  assert.equal(plan.labels.find((label) => label.title === 'next').id, 'label-next');
  const former = plan.labels.find((label) => label.title === 'Former Sprint');
  assert.match(former.id, /^imported-label-[a-f0-9]{64}$/);
  assert.equal(former.favorite, 0);
  assert.deepEqual(plan.labels, again.labels);
  const harness = await startHarness();
  try {
    for (const sql of importStatements(plan)) await harness.db.prepare(sql).run();
    for (const sql of importStatements(again)) await harness.db.prepare(sql).run();
    const catalog = await (await harness.fetch('/api/tasks/v1/catalog')).json();
    assert.equal(catalog.labels.filter((label) => label.title.startsWith('Former')).length, 2);
    const task = await (await harness.fetch('/api/tasks/v1/tasks/former-task-one')).json();
    assert.deepEqual(new Set(task.label_ids), new Set(plan.labels.filter((label) => label.title.startsWith('Former')).map((label) => label.id)));
  } finally { await harness.dispose(); }
  const invalidCurrent = structuredClone(source);
  invalidCurrent.tasks[0].labels = ['Former Sprint'];
  assert.throws(() => prepareImport(invalidCurrent), /LABEL_IDENTITY_UNRESOLVED/);
});

test('shuffled imported history pages stay chronological without inflating lifetime counts after undo', async () => {
  const snapshot = fixture();
  const completed = Array.from({ length: 120 }, (_, index) => ({
    ...snapshot.completed[0],
    content: `Synthetic completion ${String(index + 1)}`,
    completed_at: new Date(Date.UTC(2026, 0, index + 1, 10)).toISOString(),
  }));
  // Emulate several provider windows, each returned newest first, then concatenated.
  snapshot.completed = [completed.slice(80).reverse(), completed.slice(0, 40).reverse(), completed.slice(40, 80).reverse()].flat();
  snapshot.completion_events = [
    ...completed.map((row, index) => ({
      id: 1234 + index, object_id: 'repeat', object_type: 'item', event_type: 'completed',
      event_date: new Date(Date.parse(row.completed_at) - 60_000).toISOString(), parent_project_id: 'inbox',
      extra_data: { content: index ? row.content : 'Activity title for the same completion' },
    })),
    {
      id: 9999, object_id: 'deleted-source-task', object_type: 'item', event_type: 'completed',
      event_date: '2025-02-01T10:00:00Z', parent_project_id: 'old-unavailable-project',
      extra_data: { content: 'Accessible historical task, now deleted' },
    },
  ];
  const harness = await startHarness();
  try {
    const plan = prepareImport(snapshot);
    assert.equal(plan.completions.length, 121);
    assert.ok(plan.completions.every((completion) => completion.imported === 1));
    assert.equal(plan.tasks.some((task) => task.id === 'deleted-source-task'), false);
    for (const sql of importStatements(plan)) await harness.db.prepare(sql).run();
    const task = await (await harness.fetch('/api/tasks/v1/tasks/repeat')).json();
    assert.equal(task.completed_count, 6);
    const first = await (await harness.fetch('/api/tasks/v1/completions?task_id=repeat&page_size=100')).json();
    assert.equal(first.completions.length, 100);
    assert.equal(first.completions[0].title, 'Synthetic completion 120');
    assert.equal(first.completions.at(-1).title, 'Synthetic completion 21');
    const second = await (await harness.fetch(`/api/tasks/v1/completions?task_id=repeat&page_size=100&page_token=${encodeURIComponent(first.next_page_token)}`)).json();
    assert.equal(second.completions.length, 20);
    assert.equal(second.completions[0].title, 'Synthetic completion 20');
    assert.equal(second.completions.at(-1).title, 'Activity title for the same completion');
    const historical = await (await harness.fetch('/api/tasks/v1/completions?task_id=deleted-source-task')).json();
    assert.equal(historical.completions[0].title, 'Accessible historical task, now deleted');
    const response = await harness.mutate('POST', '/api/tasks/v1/tasks/repeat:complete', {
      etag: task.etag, request_id: '8cb6e4f8-484f-46f4-91ab-2d5eae967c9c',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).completed_count, 7);
    assert.equal((await (await harness.fetch('/api/tasks/v1/tasks/repeat')).json()).completed_count, 7);
  } finally { await harness.dispose(); }
});

test('a recurring task without its authoritative completion count is an explicit coverage gap', () => {
  const source = fixture();
  delete source.tasks[0].completed_count;
  const plan = prepareImport(source);
  assert.ok(plan.gaps.includes('RECURRING_COMPLETION_COUNT_MISSING'));
  assert.throws(() => importStatements(plan), /COVERAGE_NOT_VERIFIED/);
});

test('distinct source activity IDs survive the same timestamp while duplicate event IDs replay once', () => {
  const source = fixture();
  const event = {
    id: 1, object_id: 'repeat', object_type: 'item', event_type: 'completed',
    event_date: source.completed[0].completed_at, parent_project_id: 'inbox',
    extra_data: { content: 'First source event' },
  };
  source.completion_events = [event, { ...event, id: 2, extra_data: { content: 'Second source event' } }, event];
  const plan = prepareImport(source);
  assert.equal(plan.completions.length, 2);
  assert.equal(new Set(plan.completions.map((row) => row.id)).size, 2);
  assert.ok(plan.completions.some((row) => row.title === 'First source event'));
  assert.ok(plan.completions.some((row) => row.title === 'Second source event'));
});

test('activity occurrences replace task-state history by task ID without timestamp guessing', () => {
  const source = fixture();
  source.completed = [
    { ...source.completed[0], id: 'closed-with-activity', description: 'Keep the complete closed-task description' },
    { ...source.completed[1], id: 'snapshot-only', content: 'Snapshot fallback for unavailable activity' },
  ];
  source.completion_events = [{
    id: 5001, object_id: 'closed-with-activity', object_type: 'item', event_type: 'completed',
    event_date: '2026-10-06T10:12:00Z', parent_project_id: 'inbox',
    extra_data: { content: 'Actual completion occurrence' },
  }];
  const plan = prepareImport(source);
  assert.equal(plan.completions.length, 2);
  assert.equal(plan.completions.find((row) => row.task_id === 'closed-with-activity').completed_at, Date.parse('2026-10-06T10:12:00Z'));
  assert.equal(plan.completions.find((row) => row.task_id === 'snapshot-only').title, 'Snapshot fallback for unavailable activity');
  const closed = plan.tasks.find((row) => row.id === 'closed-with-activity');
  assert.equal(closed.description, 'Keep the complete closed-task description');
  assert.equal(closed.completed_at, Date.parse('2026-10-06T10:00:00Z'));
});
