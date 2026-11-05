import { expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import type { TaskRow } from '../src/model.ts';
import { taskValues, validateTask, validateTaskFields } from '../src/task-validation.ts';

function sampleRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    title: 'Synthetic task',
    description: 'Notes',
    project_id: '',
    section_id: '',
    parent_id: '',
    label_ids: '[]',
    priority: 4,
    sort_order: 10,
    due_date: '',
    due_datetime: '',
    due_timezone: '',
    deadline: '',
    duration_minutes: 0,
    recurrence: '',
    kind: 'task',
    effort: '',
    stage: 'none',
    committed_week: '',
    area: 'unassigned',
    lead_days: 0,
    planning_flags: '[]',
    key_result_id: '',
    completed: 0,
    completed_at: null,
    revision: 1,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  };
}

test('taskValues normalizes proto defaults, trims strings, and deduplicates labels', () => {
  const proto = create(TaskSchema, {
    title: '  Review quarterly draft  ',
    description: 'Body',
    labelIds: ['label-a', 'label-b', 'label-a'],
    recurrence: '  every week  ',
    planningFlags: [' frog '],
  });
  const values = taskValues(proto);
  expect(values.title).toBe('Review quarterly draft');
  expect(values.label_ids).toBe('["label-a","label-b"]');
  expect(values.priority).toBe(4);
  expect(values.sort_order).toBe(0);
  expect(values.recurrence).toBe('every week');
  expect(values.kind).toBe('task');
  expect(values.effort).toBe('');
  expect(values.stage).toBe('none');
  expect(values.area).toBe('unassigned');
  expect(values.committed_week).toBe('');
});

test('validateTaskFields enforces kind, effort, step rules, and field length/number limits', () => {
  expect(validateTaskFields(sampleRow({ label_ids: '["label-1","label-2"]' }))).toEqual(['label-1', 'label-2']);

  expect(() => validateTaskFields(sampleRow({ kind: 'milestone' }))).toThrow(
    'Choose a task or step and a valid effort preference',
  );
  expect(() => validateTaskFields(sampleRow({ effort: 'medium' }))).toThrow(
    'Choose a task or step and a valid effort preference',
  );
  expect(() =>
    validateTaskFields(sampleRow({ kind: 'step', parent_id: 'parent-1', key_result_id: 'kr-1' })),
  ).toThrow('A Step inherits its direct parent Key Result');
  expect(() => validateTaskFields(sampleRow({ kind: 'step', parent_id: '' }))).toThrow('A step needs a parent task');

  expect(() => validateTaskFields(sampleRow({ title: '' }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ title: 'x'.repeat(501) }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ description: 'x'.repeat(16001) }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ sort_order: Number.NaN }))).toThrow('Invalid task input');

  expect(() => validateTaskFields(sampleRow({ priority: 0 }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ priority: 5 }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ priority: 2.5 }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ duration_minutes: -1 }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ duration_minutes: 10081 }))).toThrow('Invalid task input');
  expect(() => validateTaskFields(sampleRow({ duration_minutes: 1.5 }))).toThrow('Invalid task input');
});

test('validateTaskFields validates calendar dates, timed dates, recurrence, label limits, and IDs', () => {
  expect(() => validateTaskFields(sampleRow({ due_date: '2030-02-30' }))).toThrow('Invalid calendar date');
  expect(() => validateTaskFields(sampleRow({ deadline: 'not-a-date' }))).toThrow('Invalid calendar date');

  expect(() =>
    validateTaskFields(
      sampleRow({
        due_date: '',
        due_datetime: '2030-04-15T14:00:00Z',
        due_timezone: 'America/Los_Angeles',
      }),
    ),
  ).toThrow('Timed date and timezone must agree');
  expect(() =>
    validateTaskFields(
      sampleRow({
        due_date: '2030-04-15',
        due_datetime: '2030-04-16T14:00:00Z',
        due_timezone: 'UTC',
      }),
    ),
  ).toThrow('Timed date and timezone must agree');
  expect(() =>
    validateTaskFields(
      sampleRow({
        due_date: '2030-04-15',
        due_datetime: '2030-04-15T14:00:00Z',
        due_timezone: 'Invalid/Zone',
      }),
    ),
  ).toThrow('Timed date and timezone must agree');
  expect(() => validateTaskFields(sampleRow({ due_timezone: 'UTC' }))).toThrow('Timezone needs a timed date');

  expect(
    validateTaskFields(
      sampleRow({
        due_date: '2030-04-15',
        due_datetime: '2030-04-15T14:00:00Z',
        due_timezone: 'UTC',
        recurrence: 'every week',
      }),
    ),
  ).toEqual([]);
  expect(() =>
    validateTaskFields(sampleRow({ due_date: '2030-04-15', recurrence: 'every blue moon' })),
  ).toThrow('Unsupported recurrence; choose an explicit supported rule');

  const thirtyOneLabels = JSON.stringify(Array.from({ length: 31 }, (_, i) => `label-${String(i)}`));
  expect(() => validateTaskFields(sampleRow({ label_ids: thirtyOneLabels }))).toThrow('Too many labels');
  expect(() => validateTaskFields(sampleRow({ project_id: 'bad/id' }))).toThrow('Invalid resource ID');
});

interface FakeQueryHandler {
  first?: (sql: string, args: unknown[]) => unknown;
  all?: (sql: string, args: unknown[]) => unknown[];
  batch?: (statements: { sql: string; args: unknown[] }[]) => { results: unknown[] }[];
}

function fakeDb(handler: FakeQueryHandler): D1Database {
  const makeStatement = (sql: string, args: unknown[] = []): D1PreparedStatement =>
    ({
      sql,
      args,
      bind: (...bound: unknown[]) => makeStatement(sql, bound),
      first: () => Promise.resolve(handler.first ? handler.first(sql, args) : null),
      all: () => Promise.resolve({ results: handler.all ? handler.all(sql, args) : [] }),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: (statements: D1PreparedStatement[]) => {
      const unwrapped = statements as unknown as { sql: string; args: unknown[] }[];
      return Promise.resolve(
        handler.batch ? handler.batch(unwrapped) : unwrapped.map(() => ({ results: [{ id: 'ok' }] })),
      );
    },
  } as unknown as D1Database;
}

test('validateTask checks project/section/parent/label references, hierarchy cycles, and step conversion', async () => {
  const missingRefDb = fakeDb({
    batch: () => [{ results: [] }],
  });
  await expect(validateTask(missingRefDb, sampleRow({ project_id: 'proj-1' }))).rejects.toThrow(
    'A task reference is missing or archived',
  );

  const cycleDb = fakeDb({
    all: () => [{ id: 'task-1', depth: 2 }],
  });
  await expect(validateTask(cycleDb, sampleRow({ parent_id: 'parent-1' }))).rejects.toThrow(
    'Task hierarchy would contain a cycle or exceed 32 levels',
  );

  const stepWithChildrenDb = fakeDb({
    all: () => [{ id: 'parent-1', depth: 1 }],
    first: (sql) => {
      if (sql.includes('FROM tasks p LEFT JOIN key_results k')) {
        return { id: 'kr-parent', title: 'Parent Key Result' };
      }
      if (sql.includes('WHERE parent_id=?')) {
        return { id: 'child-1' };
      }
      return null;
    },
  });
  const stepRow = sampleRow({ kind: 'step', parent_id: 'parent-1' });
  await expect(validateTask(stepWithChildrenDb, stepRow)).rejects.toThrow(
    'A task with children cannot become a step',
  );
  expect(stepRow.effective_key_result_id).toBe('kr-parent');
  expect(stepRow.key_result_title).toBe('Parent Key Result');

  const taskWithKrDb = fakeDb({
    batch: () => [{ results: [{ id: 'label-a' }, { id: 'label-b' }] }],
    first: () => ({ id: 'kr-direct', title: 'Direct Key Result' }),
  });
  const directRow = sampleRow({ label_ids: '["label-a","label-b"]', key_result_id: 'kr-direct' });
  await validateTask(taskWithKrDb, directRow);
  expect(directRow.effective_key_result_id).toBe('kr-direct');
  expect(directRow.key_result_title).toBe('Direct Key Result');
});
