import { expect, test } from 'vitest';
import type { DayRow } from '../src/gtd.ts';
import { isoWeek, reviewBody, weekMonday, type ReviewFacts } from '../src/review.ts';

test('ISO weeks and their Mondays, across year ends', () => {
  const cases: [string, string, string][] = [
    ['2026-10-21', '2026-W43', '2026-10-19'],
    ['2026-10-25', '2026-W43', '2026-10-19'],
    ['2026-01-01', '2026-W01', '2025-12-29'],
    ['2027-01-01', '2026-W53', '2026-12-28'],
    ['2021-01-03', '2020-W53', '2020-12-28'],
  ];
  for (const [day, week, monday] of cases) {
    expect(isoWeek(day), day).toBe(week);
    expect(weekMonday(week), week).toBe(monday);
  }
});

const row = (values: Partial<DayRow>): DayRow => ({
  day: '2026-10-25',
  scope: 'all',
  open: 10,
  age_0_7: 4,
  age_8_14: 3,
  age_15_30: 2,
  age_31_plus: 1,
  oldest_days: 40,
  overdue: 3,
  undated: 5,
  created_7d: 6,
  completed_7d: 7,
  closed_1d: 1,
  mail_open: 2,
  complete: 1,
  computed_at: 1,
  ...values,
});
const NOW = Date.parse('2026-10-25T17:30:00Z');
const facts: ReviewFacts = {
  day: '2026-10-25',
  all: row({}),
  inbox: row({ scope: 'inbox', open: 6, oldest_days: 40, age_31_plus: 2 }),
  allBefore: row({ day: '2026-10-18', open: 12, overdue: 1, undated: 5, completed_7d: 9 }),
  inboxBefore: row({ day: '2026-10-18', scope: 'inbox', open: 4, oldest_days: 33 }),
  mail: { pending: 9, carried: 4 },
  lastDone: Date.parse('2026-10-18T18:00:00Z'),
  oldestInbox: ['task-a', 'task-b'],
  origin: 'https://tasks.example.test',
};

test('the review shows counts, trends, what stands out and links, never a task title', () => {
  expect(reviewBody(facts, NOW)).toBe(
    [
      '统计 2026-10-25（只含计数）',
      '收件箱：开放 6（上周 4，+2）；最老 40 天（上周 33，+7）；0–7 天 4 · 8–14 天 3 · 15–30 天 2 · >30 天 2',
      '全部项目：开放 10（上周 12，-2） · 逾期 3（上周 1，+2） · 无日期 5（上周 5，持平）',
      '近 7 天：新建 6 · 完成 7（上周 9，-2）',
      '邮件：待处理 9，其中 1–14 天前收到的 4',
      '收件箱最老的任务：https://tasks.example.test/?task=task-a  https://tasks.example.test/?task=task-b',
      '上次回顾：2026-10-18 完成（6 天前）',
      '本周重点：收件箱里超过 30 天的 2 项：逐个决定 做 / 委派 / 删除',
      '本周重点：逾期比上周多 2 项：重排日期，或删掉不再做的',
      '步骤：清空收件箱 → 看逾期与无日期 → 看项目与等待 → 想想下周',
      '周回顾：https://tasks.example.test/?review=1   GTD：https://tasks.example.test/#/gtd',
      '',
    ].join('\n'),
  );
});

test('without counts or mail the review says so', () => {
  const body = reviewBody(
    {
      ...facts,
      day: undefined,
      all: undefined,
      inbox: undefined,
      allBefore: undefined,
      inboxBefore: undefined,
      mail: undefined,
      lastDone: undefined,
      oldestInbox: [],
    },
    NOW,
  );
  expect(body.split('\n').slice(0, 3)).toEqual([
    '统计：本周没有可用的 GTD 统计（只含计数，稍后可在 Tasks 的 GTD 页查看）。',
    '邮件：不可用',
    '上次回顾：尚无完成记录',
  ]);
});
