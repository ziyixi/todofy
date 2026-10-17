import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let harness: Harness;
beforeAll(async () => { harness = await startHarness(); });
afterAll(async () => { await harness.dispose(); });

test('next N days includes today and N-1, excludes overdue and N, and uses deadline only without a date', async () => {
  const labelResponse = await harness.mutate('POST', `/api/tasks/v1/labels?request_id=${randomUUID()}`, { title: 'Synthetic scope' });
  const label = await labelResponse.json() as { id: string };
  const cases = [
    { title: 'Overdue', due_date: '2026-10-16' },
    { title: 'Today', due_date: '2026-10-17' },
    { title: 'Third day', due_date: '2026-10-19' },
    { title: 'After third day', due_date: '2026-10-20' },
    { title: 'Seventh day', due_date: '2026-10-23' },
    { title: 'After seventh day', due_date: '2026-10-24' },
    { title: 'No date' },
    { title: 'Only deadline', deadline: '2026-10-18' },
    { title: 'Only overdue deadline', deadline: '2026-10-16' },
    { title: 'Only deadline today', deadline: '2026-10-17' },
    { title: 'Only future deadline', deadline: '2026-10-24' },
    { title: 'Date takes precedence', due_date: '2026-10-24', deadline: '2026-10-18' },
  ];
  for (const row of cases) {
    const response = await harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, { ...row, label_ids: [label.id] });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  async function titles(query: string, view = 'filter') {
    const parameters = new URLSearchParams({ view, query, date: '2026-10-17', page_size: '100' });
    const response = await harness.fetch(`/api/tasks/v1/tasks?${parameters.toString()}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const data = await response.json() as { tasks: { title: string }[] };
    return data.tasks.map((task) => task.title).sort();
  }
  expect(await titles('@Synthetic scope & (no date | 3 days)')).toEqual([
    'No date', 'Only deadline', 'Only deadline today', 'Only future deadline', 'Only overdue deadline', 'Third day', 'Today',
  ]);
  expect(await titles('(overdue | 7 days) & @Synthetic scope')).toEqual([
    'After third day', 'Only deadline', 'Only deadline today', 'Only overdue deadline', 'Overdue', 'Seventh day', 'Third day', 'Today',
  ]);
  expect(await titles('next 3 days')).toEqual(['Only deadline', 'Only deadline today', 'Third day', 'Today']);
  expect(await titles('today')).toEqual(['Only deadline today', 'Today']);
  expect(await titles('overdue')).toEqual(['Only overdue deadline', 'Overdue']);
  expect(await titles('no date')).toEqual(['No date', 'Only deadline', 'Only deadline today', 'Only future deadline', 'Only overdue deadline']);
  expect(await titles('', 'today')).toEqual(['Overdue', 'Today']);
  expect(await titles('', 'upcoming')).toEqual(['After third day', 'Seventh day', 'Third day', 'Today']);
});
