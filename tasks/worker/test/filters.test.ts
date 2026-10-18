import { expect, test } from 'vitest';
import { taskFilter } from '../src/filters.ts';
test('parses the existing grouped lead-time filter using bound values', () => {
  const filter = taskFilter(
    'deadline before: today & !@active, (@lead_1w & deadline after: yesterday & deadline before: in 7 days & !@waiting)',
    '2026-10-17',
  );
  expect(filter.sql).toContain(' OR ');
  expect(filter.values).toEqual(['2026-10-17', 'active', 'lead_1w', '2026-10-16', '2026-10-24', 'waiting']);
  expect(filter.sql).not.toContain('active');
});
test('a project term treats the empty project ID as the Inbox project', () => {
  const filter = taskFilter('#Inbox & !#Work', '2026-10-17');
  expect(filter.values).toEqual(['Inbox', 'Work']);
  expect(filter.sql).toContain("p.inbox=1 AND t.project_id=''");
});
test('invalid expressions never become a wider filter', () => {
  for (const filter of ['@x &', '(@x', 'some unsupported term', 'due before: banana'])
    expect(() => taskFilter(filter, '2026-10-17')).toThrow();
});
