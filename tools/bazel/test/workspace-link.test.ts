import { expect, test } from 'vitest';
import { addDays, validDate } from '@ziyixi/task-dates';

test('resolves a workspace package with its declared runtime dependencies', () => {
  expect(validDate('2026-10-29')).toBe(true);
  expect(addDays('2026-10-29', 1)).toBe('2026-10-30');
});
