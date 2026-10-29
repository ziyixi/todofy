import { describe, expect, it } from 'vitest';
import { count, deliveryState, duration, issueDate, month, nodeName, replicaState, runState, short, stripDay, webUrl } from './format.ts';

describe('the vocabulary', () => {
  it('shows a code it does not know as it is, with ▲, never as healthy', () => {
    expect(runState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn' });
    expect(deliveryState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn' });
    expect(replicaState('brand_new')).toEqual({ label: 'brand_new', tone: 'warn' });
    expect(nodeName({ type: 'brand_new', node_id: 'custom' })).toBe('custom');
  });

  it("uses Fleet's delivery words", () => {
    expect(deliveryState('provider_accepted')).toEqual({ label: '邮件服务已接收', tone: 'ok' });
    expect(deliveryState('unknown')).toEqual({ label: '结果尚未确认', tone: 'unknown' });
    expect(deliveryState('rejected')).toEqual({ label: '邮件服务拒绝', tone: 'bad' });
  });
});

describe('dates and numbers', () => {
  it('reads an issue date as the service calendar day, never shifted', () => {
    expect(issueDate('2026-10-28')).toBe('10月28日');
    expect(issueDate('2026-10-28', true)).toBe('10月28日 周三');
    expect(stripDay('2026-10-29')).toEqual({ day: '29', weekday: '四' });
    expect(month('2026-10')).toBe('2026年10月');
    expect(issueDate('garbage')).toBe('garbage');
  });

  it('writes durations, counts and identities compactly', () => {
    expect(duration(0.4)).toBe('0.4 秒');
    expect(duration(58.6)).toBe('59 秒');
    expect(duration(88)).toBe('1 分 28 秒');
    expect(duration(5400)).toBe('1 小时 30 分');
    expect(duration(undefined)).toBe('未记录');
    expect(count(5400)).toBe('5,400');
    expect(count(218000)).toBe('21.8 万');
    expect(short('89abcdef0123456789abcdef0123456789abcdef')).toBe('89abcde');
    expect(short('packaged')).toBe('packaged');
  });

  it('turns only http and https URLs into links', () => {
    expect(webUrl('https://example.test/a')).toBe('https://example.test/a');
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'notaurl', '']) expect(webUrl(value)).toBeNull();
  });
});
