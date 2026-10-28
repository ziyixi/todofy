import { describe, expect, it } from 'vitest';
import { niceStep, runs, stepLabel, timeTicks, valueScale } from './chart.ts';

const GIB = 1024 ** 3;

describe('chart geometry', () => {
  it('picks clean steps', () => {
    expect([0.3, 1, 1.4, 2.2, 4, 7, 33].map(niceStep)).toEqual([0.5, 1, 2, 2.5, 5, 10, 50]);
  });
  it('builds a zero-based axis in the unit of its top value', () => {
    const cpu = valueScale('percent', 12, 4);
    expect(cpu.max).toBe(15);
    expect(cpu.ticks.map((t) => t.label)).toEqual(['0', '5%', '10%', '15%']);
    expect(valueScale('percent', 100, 4).max).toBe(100);
    const memory = valueScale('bytes', 16 * GIB, 4);
    expect(memory.max).toBe(20 * GIB);
    expect(memory.ticks.map((t) => t.label)).toEqual(['0', '5 GiB', '10 GiB', '15 GiB', '20 GiB']);
    expect(valueScale('bytes_per_second', 300 * 1024, 3).ticks.at(-1)?.label).toBe('300 KiB/s');
    expect(valueScale('cores', 0, 2).max).toBeGreaterThan(0);
    const workload = valueScale('bytes', 730 * 1024 ** 2, 2);
    expect(workload.ticks.map((t) => t.label)).toEqual(['0', '0.5 GiB', '1 GiB']);
  });
  it('never bridges a missing step', () => {
    expect(runs([1, 2, null, 4, null, null, 7, 8, 9])).toEqual([[0, 1], [3], [6, 7, 8]]);
    expect(runs([null, null])).toEqual([]);
    expect(runs([0, 0])).toEqual([[0, 1]]);
  });
  it('labels local hours for a day and thins labels that would collide', () => {
    const start = new Date(2026, 9, 2, 0, 5).getTime();
    const end = start + 86_400_000;
    const x = (t: number): number => ((t - start) / 86_400_000) * 800;
    const ticks = timeTicks(start, end, 'day', x);
    expect(ticks.map((t) => t.label)).toEqual(['03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '10/3']);
    const narrow = timeTicks(start, end, 'day', (t) => ((t - start) / 86_400_000) * 200);
    expect(narrow.length).toBeLessThan(ticks.length);
    expect(narrow.map((t) => t.label)).toContain('10/3');
  });
  it('labels months and years for long ranges', () => {
    const start = new Date(2025, 0, 15).getTime();
    const end = new Date(2026, 11, 15).getTime();
    const x = (t: number): number => ((t - start) / (end - start)) * 2000;
    expect(timeTicks(start, end, 'two_years', x).map((t) => t.label)).toEqual(
      ['4月', '7月', '10月', '2026年', '4月', '7月', '10月'],
    );
    const narrow = timeTicks(start, end, 'two_years', (t) => ((t - start) / (end - start)) * 260, 72);
    expect(narrow.map((t) => t.label)).toContain('2026年');
  });
  it('states a step as its span when it holds more than one sample', () => {
    const start = new Date(2026, 9, 2, 14, 0).getTime();
    expect(stepLabel(start, 300, 'day')).toMatch(/10\/2.*14:00/);
    expect(stepLabel(start, 3600, 'week')).toMatch(/14:00.*–.*15:00/);
  });
});
