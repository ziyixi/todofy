import { expect, test } from 'vitest';
import type { KeyResultRow, ObjectiveRow } from '../src/goal-model.ts';
import {
  checkedGoalUrl,
  goalPaths,
  selectableKeyResult,
  validateKeyResult,
  validateKeyResultLink,
  validateObjective,
} from '../src/goal-validation.ts';

function sampleObjective(overrides: Partial<ObjectiveRow> = {}): ObjectiveRow {
  return {
    id: 'obj-1',
    year: 2030,
    title: 'Ship resilient personal cloud',
    description: 'Annual objective notes',
    source_url: 'https://example.test/objectives/1',
    archived: 0,
    sort_order: 1,
    revision: 1,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  };
}

function sampleKeyResult(overrides: Partial<KeyResultRow> = {}): KeyResultRow {
  return {
    id: 'kr-1',
    objective_id: 'obj-1',
    year: 2030,
    objective_archived: 0,
    title: 'Keep weekly review latency low',
    kind: 'outcome',
    completed: 0,
    floor_text: '95%',
    target_text: '99%',
    milestones: '[]',
    source_url: 'https://example.test/kr/1',
    notes: 'Notes',
    focus_start_month: '2030-01',
    focus_end_month: '2030-03',
    focus_text: 'Q1 focus',
    archived: 0,
    sort_order: 1,
    revision: 1,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...overrides,
  };
}

test('goalPaths validates explicit masks and allowed field names', () => {
  expect(() => goalPaths(undefined, ['title'])).toThrow('An explicit update_mask is required');
  expect(() => goalPaths({ paths: [] }, ['title'])).toThrow('An explicit update_mask is required');
  expect(() => goalPaths({ paths: ['*'] }, ['title'])).toThrow('Unsupported goal update field');
  expect(() => goalPaths({ paths: ['title', 'unknown_field'] }, ['title'])).toThrow(
    'Unsupported goal update field',
  );
  expect(goalPaths({ paths: ['title', 'source_url'] }, ['title', 'source_url', 'notes'])).toEqual([
    'title',
    'source_url',
  ]);
});

test('checkedGoalUrl accepts empty or HTTP/HTTPS URLs and rejects invalid or oversized URLs', () => {
  expect(checkedGoalUrl('')).toBe('');
  expect(checkedGoalUrl('https://example.test/doc')).toBe('https://example.test/doc');
  expect(checkedGoalUrl('http://example.test/doc')).toBe('http://example.test/doc');
  expect(() => checkedGoalUrl(`https://example.test/${'a'.repeat(2000)}`)).toThrow('A goal URL is too long');
  expect(() => checkedGoalUrl('ftp://example.test/doc')).toThrow('A goal URL must use HTTP or HTTPS');
  expect(() => checkedGoalUrl('not a url')).toThrow('A goal URL must use HTTP or HTTPS');
});

test('validateObjective checks year, title, description, sort_order, and source_url', () => {
  expect(() => {
    validateObjective(sampleObjective());
  }).not.toThrow();
  expect(() => {
    validateObjective(sampleObjective({ year: 1999 }));
  }).toThrow('Choose a calendar year from 2000 through 2199');
  expect(() => {
    validateObjective(sampleObjective({ title: '' }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateObjective(sampleObjective({ title: 'x'.repeat(301) }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateObjective(sampleObjective({ description: 'x'.repeat(2001) }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateObjective(sampleObjective({ sort_order: Number.POSITIVE_INFINITY }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateObjective(sampleObjective({ source_url: 'javascript:alert(1)' }));
  }).toThrow('A goal URL must use HTTP or HTTPS');
});

test('validateKeyResult enforces field limits, kind, and focus month range rules', () => {
  expect(() => {
    validateKeyResult(sampleKeyResult());
  }).not.toThrow();
  expect(() => {
    validateKeyResult(sampleKeyResult({ focus_start_month: '', focus_end_month: '', focus_text: '' }));
  }).not.toThrow();

  expect(() => {
    validateKeyResult(sampleKeyResult({ objective_id: 'bad/id' }));
  }).toThrow('Invalid resource ID');
  expect(() => {
    validateKeyResult(sampleKeyResult({ title: '' }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateKeyResult(sampleKeyResult({ floor_text: 'x'.repeat(2001) }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateKeyResult(sampleKeyResult({ target_text: 'x'.repeat(2001) }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateKeyResult(sampleKeyResult({ notes: 'x'.repeat(8001) }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateKeyResult(sampleKeyResult({ focus_text: 'x'.repeat(1001) }));
  }).toThrow('Invalid task input');
  expect(() => {
    validateKeyResult(sampleKeyResult({ kind: 'habit' }));
  }).toThrow('Invalid task input');

  expect(() => {
    validateKeyResult(sampleKeyResult({ focus_start_month: '2030-04', focus_end_month: '2030-02' }));
  }).toThrow('Focus needs an ordered month range within the Key Result year');
  expect(() => {
    validateKeyResult(sampleKeyResult({ focus_start_month: '2029-12', focus_end_month: '2030-02' }));
  }).toThrow('Focus needs an ordered month range within the Key Result year');
  expect(() => {
    validateKeyResult(sampleKeyResult({ focus_start_month: '', focus_end_month: '', focus_text: 'Orphan focus' }));
  }).toThrow('Focus text needs its month range');
});

test('selectableKeyResult and validateKeyResultLink require an active Key Result', async () => {
  const check = selectableKeyResult('kr-active');
  expect(check.values).toEqual(['kr-active']);
  expect(check.message).toBe('Choose an active Key Result');
  expect(() => selectableKeyResult('bad/id')).toThrow('Invalid resource ID');

  const makeDb = (row: { title: string } | null): D1Database =>
    ({
      prepare: () => ({
        bind: () => ({
          first: () => Promise.resolve(row),
        }),
      }),
    }) as unknown as D1Database;

  await expect(validateKeyResultLink(makeDb({ title: 'Active KR' }), 'kr-active')).resolves.toBe('Active KR');
  await expect(validateKeyResultLink(makeDb(null), 'kr-archived')).rejects.toThrow('Choose an active Key Result');
});
