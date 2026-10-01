import { describe, expect, it } from 'vitest';
import { cleanLine, MASK, maskLine, normalizeLines } from '../src/normalize.ts';

const masked = (line: string, maskNumbers = false) => maskLine(cleanLine(line), maskNumbers).text;
const defaults = { ignoredLines: [], defaultMasks: true, maskNumbers: false };

describe('cleanLine', () => {
  it('applies NFKC, drops zero-width characters and collapses whitespace', () => {
    expect(cleanLine('  Ｆｕｌｌ​ width \t text  ')).toBe('Full width text');
    expect(cleanLine('a﻿b­c')).toBe('abc');
  });
});

describe('the default masks', () => {
  it.each([
    ['Updated 3 minutes ago', `Updated ${MASK.relativeTime}`],
    ['posted an hour ago by x', `posted ${MASK.relativeTime} by x`],
    ['5m ago', MASK.relativeTime],
    ['just now', MASK.relativeTime],
    ['in 5 min', MASK.relativeTime],
    ['发布于 3小时前', `发布于 ${MASK.relativeTime}`],
    ['5 分钟前 更新', `${MASK.relativeTime} 更新`],
    ['半小时前', MASK.relativeTime],
    ['三天前', MASK.relativeTime],
    ['刚刚 有人购买', `${MASK.relativeTime} 有人购买`],
    ['昨天 12:30 发布', `${MASK.relativeTime} 发布`],
  ])('masks the relative time in %j', (line, expected) => {
    expect(masked(line)).toBe(expected);
  });

  it('masks times with seconds and the time part of ISO date-times, keeping the date', () => {
    expect(masked('Server time 2026-10-01T12:34:56Z')).toBe(`Server time 2026-10-01 ${MASK.time}`);
    expect(masked('at 12:34:56 today')).toBe(`at ${MASK.time} today`);
    expect(masked('2026-10-01 08:00:00+08:00')).toBe(`2026-10-01 ${MASK.time}`);
  });

  it('masks tokens: UUIDs, long hex, base64, nonce and cache-busting query values, epoch milliseconds', () => {
    expect(masked('id 123e4567-e89b-42d3-a456-426614174000')).toBe(`id ${MASK.token}`);
    expect(masked('build 9fa2c3d4e5f60718a')).toBe(`build ${MASK.token}`);
    expect(masked('nonce aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNl')).toBe(`nonce ${MASK.token}`);
    expect(masked('https://x.example.com/a.js?v=12345&token=abc')).toBe(`https://x.example.com/a.js?v=${MASK.token}&token=${MASK.token}`);
    expect(masked('ts 1790812800000')).toBe(`ts ${MASK.token}`);
  });

  it('masks copyright years, a range included', () => {
    expect(masked('© 2019-2026 Example')).toBe(`© 2019-${MASK.year} Example`);
    expect(masked('Copyright 2026')).toBe(`Copyright ${MASK.year}`);
    expect(masked('版权所有 2026')).toBe(`版权所有 ${MASK.year}`);
  });

  it('keeps absolute dates, prices, versions and times of day without seconds', () => {
    for (const line of ['Price ¥1,299.00', 'Version 1.2.3', 'Open 09:00-18:00', 'Due 2026-10-15', '库存 42 件', 'abcdefabcdefabcd']) expect(masked(line)).toBe(cleanLine(line));
  });

  it('mask_numbers masks every remaining number', () => {
    expect(masked('Visitors 1,234 today', true)).toBe(`Visitors ${MASK.number} today`);
  });
});

describe('normalizeLines', () => {
  it('drops empty and ignored lines (after masking), counts masks and ignored lines', () => {
    const result = normalizeLines(['  ', 'Updated 3 minutes ago', 'keep me', 'Updated 5 minutes ago'], { ...defaults, ignoredLines: [`Updated ${MASK.relativeTime}`] });
    expect(result).toEqual({ lines: ['keep me'], masked: 2, ignored: 2 });
  });

  it('disable_default_masks keeps the text as it is', () => {
    expect(normalizeLines(['Updated 3 minutes ago'], { ...defaults, defaultMasks: false }).lines).toEqual(['Updated 3 minutes ago']);
  });

  it('is deterministic: the same input gives the same output', () => {
    const lines = ['刚刚', '© 2026', 'x 12:00:01'];
    expect(normalizeLines(lines, defaults)).toEqual(normalizeLines(lines, defaults));
  });
});
