import { describe, expect, it } from 'vitest';
import type { ModelUsageDay } from '@ziyixi/proto/newsletter/ui/v1/model_call_wire';
import { datesBetween, MAX_BAR, OTHER, scaleOf, segmentRect, stackByModel } from './chart.ts';
import { labelled } from './Models.tsx';
import { fixture } from './test/world.tsx';

const day = (date: string, model: string, input: number, output = 0): ModelUsageDay =>
  ({ issue_date: date, model, usage: { call_count: 1, input_tokens: input, output_tokens: output } });

describe('the daily columns', () => {
  it('has one column per calendar date of the range, a date without calls included', () => {
    expect(datesBetween('2026-10-27', '2026-10-29')).toEqual(['2026-10-27', '2026-10-28', '2026-10-29']);
    expect(datesBetween('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(datesBetween('2026-10-29', '2026-10-27')).toEqual([]);
    expect(datesBetween('', '2026-10-27')).toEqual([]);
    expect(datesBetween('2026-01-01', '2026-12-31')).toHaveLength(90);
  });

  it('stacks the 30-day fixture by model, the same order in every column, input plus output', () => {
    const usage = fixture<{ days: ModelUsageDay[]; first_issue_date: string; last_issue_date: string }>('model-usage-30d');
    const stacked = stackByModel(usage.days, usage.first_issue_date, usage.last_issue_date);
    expect(stacked.columns).toHaveLength(30);
    expect(stacked.models).toEqual(['gpt-6.1-sol-2026-10-01', 'gpt-6.1-sol']);
    const october27 = stacked.columns.find((column) => column.date === '2026-10-27');
    expect(october27?.total).toBe(61000 + 5400);
    expect(stacked.columns.find((column) => column.date === '2026-10-26')?.segments).toEqual([]);
    expect(stacked.top).toBeGreaterThanOrEqual(66400);
    expect(stacked.ticks[0]).toBe(0);
    expect(stacked.ticks.at(-1)).toBe(stacked.top);
  });

  it('sums the models past the fourth as 其他, never dropping their tokens', () => {
    const days = ['a', 'b', 'c', 'd', 'e'].map((model, index) => day('2026-10-29', model, 100 - index * 10));
    const stacked = stackByModel(days, '2026-10-29', '2026-10-29');
    expect(stacked.models).toEqual(['a', 'b', 'c', OTHER]);
    const segments = stacked.columns[0]?.segments ?? [];
    expect(segments.map((segment) => [segment.model, segment.value])).toEqual([['a', 100], ['b', 90], ['c', 80], [OTHER, 70 + 60]]);
    expect(segments.map((segment) => [segment.from, segment.to])).toEqual([[0, 100], [100, 190], [190, 270], [270, 400]]);
  });

  it('draws a zero-based scale in clean steps, and a scale for no calls at all', () => {
    expect(scaleOf(66400)).toEqual({ top: 75000, ticks: [0, 25000, 50000, 75000] });
    expect(scaleOf(0)).toEqual({ top: 1, ticks: [0, 1] });
  });
});

describe('the bar geometry', () => {
  const stacked = stackByModel([day('2026-10-27', 'a', 300), day('2026-10-27', 'b', 100), day('2026-10-29', 'a', 150)], '2026-10-27', '2026-10-29');

  it('stacks segments from the bottom edge, in proportion to the scale', () => {
    expect(stacked.top).toBe(400);
    const [a, b] = stacked.columns[0]?.segments ?? [];
    const lower = segmentRect(stacked, 0, a!, 600, 100);
    const upper = segmentRect(stacked, 0, b!, 600, 100);
    expect(lower.y + lower.height).toBeCloseTo(100);
    expect(lower.height).toBeCloseTo(75);
    expect(upper.y + upper.height).toBeCloseTo(lower.y);
    expect(upper.height).toBeCloseTo(25);
  });

  it('centres each bar in its date, never wider than MAX_BAR, inside the box', () => {
    const third = segmentRect(stacked, 2, stacked.columns[2]!.segments[0]!, 600, 100);
    expect(third.width).toBe(MAX_BAR);
    expect(third.x + third.width / 2).toBeCloseTo(500);
    const narrow = segmentRect(stackByModel([day('2026-10-29', 'a', 1)], '2026-08-01', '2026-10-29'), 89,
      { model: 'a', value: 1, from: 0, to: 1 }, 720, 160);
    expect(narrow.width).toBeCloseTo(0.64 * 8);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(720);
  });

  it('labels every date of a week, a weekly date over a month, and always the last', () => {
    const week = labelled(7);
    expect([0, 1, 2, 3, 4, 5, 6].filter(week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const month = labelled(30);
    expect(Array.from({ length: 30 }, (_, i) => i).filter(month)).toEqual([0, 7, 14, 21, 29]);
    const quarter = labelled(90);
    expect(Array.from({ length: 90 }, (_, i) => i).filter(quarter)).toEqual([0, 15, 30, 45, 60, 75, 89]);
  });
});
