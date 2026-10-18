import { expect, test } from 'vitest';
import { clampMonthEnd, daysBetween, nextOccurrence, previewDate, recurrenceRule, validDate } from '../src/index.ts';

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

test('annual ordinal dates preview and return to the fixed calendar date after completion', () => {
  const preview = previewDate('every 1st Jan', '2026-10-17', 'UTC');
  expect(preview.dueDate).toBe('2027-01-01');
  expect(preview.recurrence).toBe('every 1st Jan');
  expect(nextOccurrence(preview, Date.parse('2027-01-03T12:00:00Z'), 'UTC').dueDate).toBe('2028-01-01');
});

test('a named weekday anchors a biweekly schedule rather than the day it was entered', () => {
  const preview = previewDate('every 2 weeks Tue', '2026-10-17', 'UTC');
  expect(preview.dueDate).toBe('2026-10-20');
  expect(nextOccurrence(preview, Date.parse('2026-10-20T12:00:00Z'), 'UTC').dueDate).toBe('2026-11-03');
  expect(nextOccurrence(preview, Date.parse('2026-10-22T12:00:00Z'), 'UTC').dueDate).toBe('2026-11-03');
  expect(nextOccurrence(preview, Date.parse('2026-11-04T12:00:00Z'), 'UTC').dueDate).toBe('2026-11-17');
});

test('the 30th clamps to February month-end and then returns to March 30', () => {
  expect(previewDate('every 30th', '2027-02-01', 'UTC').dueDate).toBe('2027-02-28');
  for (const [year, february] of [[2027, '2027-02-28'], [2028, '2028-02-29']] as const) {
    const january = previewDate('every 30th', `${year}-01-30`, 'UTC');
    expect(january.dueDate).toBe(`${year}-01-30`);
    const next = nextOccurrence(january, Date.parse(`${year}-01-30T12:00:00Z`), 'UTC');
    expect(next.dueDate).toBe(february);
    expect(nextOccurrence(next, Date.parse(`${february}T12:00:00Z`), 'UTC').dueDate).toBe(`${year}-03-30`);
    expect(nextOccurrence(january, Date.parse(`${year}-03-01T12:00:00Z`), 'UTC').dueDate).toBe(`${year}-03-30`);
  }
});

/** Completes each occurrence on its due day and lists the dates it advances to. */
function occurrences(recurrence: string, dueDate: string, count: number): string[] {
  const dates: string[] = [];
  let current = { dueDate, dueDatetime: '', dueTimezone: '', recurrence: clampMonthEnd(recurrence, dueDate) };
  for (let index = 0; index < count; index++) {
    current = nextOccurrence(current, Date.parse(`${current.dueDate}T12:00:00Z`), 'UTC');
    dates.push(current.dueDate);
  }
  return dates;
}

test('month-end interval rules keep the last day instead of skipping short months', () => {
  expect(clampMonthEnd('every month', '2026-01-31')).toBe('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31,-1;BYSETPOS=1');
  expect(occurrences('every month', '2026-01-31', 2)).toEqual(['2026-02-28', '2026-03-31']);
  expect(occurrences('Monthly', '2026-01-31', 1)).toEqual(['2026-02-28']);
  expect(occurrences('every 3 months', '2026-11-30', 2)).toEqual(['2027-02-28', '2027-05-30']);
  expect(occurrences('quarterly', '2026-11-30', 1)).toEqual(['2027-02-28']);
  expect(occurrences('every year', '2028-02-29', 4)).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  expect(occurrences('yearly', '2028-02-29', 1)).toEqual(['2029-02-28']);
});

test('other rules and earlier anchor days keep their text', () => {
  expect(clampMonthEnd('every month', '2026-01-28')).toBe('every month');
  expect(clampMonthEnd('every! month', '2026-01-31')).toBe('every! month');
  expect(clampMonthEnd('every week', '2026-01-31')).toBe('every week');
  expect(clampMonthEnd('every 30th', '2026-01-30')).toBe('every 30th');
  expect(clampMonthEnd('RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31', '2026-01-31')).toBe(
    'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31',
  );
  expect(clampMonthEnd('every month', '')).toBe('every month');
});

test('days between calendar dates count across months and backwards', () => {
  expect(daysBetween('2026-10-20', '2026-10-27')).toBe(7);
  expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  expect(daysBetween('2026-10-27', '2026-10-20')).toBe(-7);
  expect(() => daysBetween('2026-02-30', '2026-03-01')).toThrow();
});
