import { expect, test } from 'vitest';
import { nextOccurrence, previewDate, recurrenceRule, validDate } from '../src/index.ts';

test('plain dates remain calendar dates and timed input resolves the account timezone', () => {
  expect(previewDate('tomorrow', '2026-10-17', 'America/Los_Angeles')).toEqual({
    dueDate: '2026-10-18',
    dueDatetime: '',
    dueTimezone: '',
    recurrence: '',
  });
  expect(previewDate('tomorrow at 9am', '2026-10-17', 'America/Los_Angeles').dueDatetime).toBe(
    '2026-10-18T16:00:00.000Z',
  );
  expect(validDate('2026-02-30')).toBe(false);
  expect(() => previewDate('meeting Friday plus nonsense', '2026-10-17', 'UTC')).toThrow();
});
test('scheduled and completion-anchored intervals differ when completed late', () => {
  const base = {
    dueDate: '2026-10-01',
    dueDatetime: '',
    dueTimezone: '',
    recurrence: 'every 2 weeks',
  };
  const now = Date.parse('2026-10-20T12:00:00Z');
  expect(nextOccurrence(base, now, 'UTC').dueDate).toBe('2026-10-29');
  expect(nextOccurrence({ ...base, recurrence: 'every! 2 weeks' }, now, 'UTC').dueDate).toBe('2026-11-03');
});
test('timed weekly recurrence retains local clock across daylight saving', () => {
  const next = nextOccurrence(
    {
      dueDate: '2026-10-27',
      dueDatetime: '2026-10-27T16:00:00.000Z',
      dueTimezone: 'America/Los_Angeles',
      recurrence: 'every Tue',
    },
    Date.parse('2026-10-27T18:00:00Z'),
    'UTC',
  );
  expect(next.dueDate).toBe('2026-11-03');
  expect(next.dueDatetime).toBe('2026-11-03T17:00:00.000Z');
});
test('unsupported or unbounded recurrence is rejected rather than silently weakened', () => {
  expect(() => recurrenceRule('every moon phase', '2026-10-17')).toThrow();
  expect(() => recurrenceRule('RRULE:FREQ=SECONDLY', '2026-10-17')).toThrow();
  expect(() => recurrenceRule('every 0 days', '2026-10-17')).toThrow();
});

test('Todoist every week follows completion day while named weekdays remain fixed', () => {
  const base = { dueDate: '2026-10-19', dueDatetime: '', dueTimezone: '', recurrence: 'every week' };
  expect(nextOccurrence(base, Date.parse('2026-10-20T12:00:00Z'), 'UTC').dueDate).toBe('2026-10-27');
  expect(nextOccurrence({ ...base, recurrence: 'every Mon' }, Date.parse('2026-10-20T12:00:00Z'), 'UTC').dueDate).toBe(
    '2026-10-26',
  );
});
