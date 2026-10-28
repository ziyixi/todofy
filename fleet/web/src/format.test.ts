import { describe, expect, it } from 'vitest';
import { ago, bytes, bytesOf, cores, daemonLabel, duration, load, percent, rate, tone } from './format.ts';

const GIB = 1024 ** 3;

describe('value formatting', () => {
  it('keeps unknown visibly unknown instead of zero', () => {
    for (const format of [percent, bytes, rate, load, cores]) expect(format(undefined)).toBe('未知');
    expect(percent(0)).toBe('0.0%');
    expect(bytes(0)).toBe('0 B');
  });
  it('uses binary units with at most three significant digits', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.50 KiB');
    expect(bytes(15.6 * GIB)).toBe('15.6 GiB');
    expect(bytes(500 * GIB)).toBe('500 GiB');
    expect(rate(200 * 1024)).toBe('200 KiB/s');
    expect(bytesOf(6 * GIB, 16 * GIB)).toBe('6.00 / 16.0 GiB');
    expect(bytesOf(512 * 1024 ** 2, 16 * GIB)).toBe('0.50 / 16.0 GiB');
  });
  it('shows small CPU shares without invented digits', () => {
    expect(cores(0.0021)).toBe('0.0021 核');
    expect(cores(0.015)).toBe('0.015 核');
    expect(cores(1.234)).toBe('1.23 核');
    expect(cores(0)).toBe('0 核');
    expect(load(0.4)).toBe('0.40');
  });
  it('reads durations in two units at most', () => {
    expect(duration(8 * 60 + 5)).toBe('8 分钟');
    expect(duration(5 * 3600 + 12 * 60)).toBe('5 小时 12 分钟');
    expect(duration(3 * 86400 + 4 * 3600 + 59)).toBe('3 天 4 小时');
    expect(duration(2 * 86400)).toBe('2 天');
    const now = Date.parse('2026-10-03T01:00:00Z');
    expect(ago('2026-10-03T00:59:30Z', now)).toBe('刚刚');
    expect(ago('2026-10-03T00:57:00Z', now)).toBe('3 分钟前');
    expect(ago('2026-10-02T21:30:00Z', now)).toBe('3 小时前');
    expect(ago(undefined, now)).toBe('暂无观测');
  });
  it('never makes an unlisted state look healthy, and a missing unit is not a missing host', () => {
    expect(tone('active')).toBe('ok');
    expect(tone('failed')).toBe('bad');
    expect(tone('unknown')).toBe('unknown');
    expect(tone('something_new')).toBe('warn');
    expect(daemonLabel('missing')).toBe('未找到');
    expect(daemonLabel('active')).toBe('运行中');
  });
});
