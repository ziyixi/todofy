import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILTERS } from './Issues.tsx';
import { fixture, serve, show, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const cards = async () => within(await screen.findByRole('list', { name: '2026年10月的期刊' })).getAllByRole('link');

describe('期刊', () => {
  it("lists the month's editions as cards: date, kind, title, introduction, sections, delivery and backup", async () => {
    serve(world());
    show('#/issues');
    expect(await screen.findByRole('heading', { name: '2026年10月' })).toBeVisible();
    const all = await cards();
    expect(all).toHaveLength(7);
    const daily = all[3]!;
    expect(daily).toHaveAttribute('href', '#/issues/00000000-0000-4000-8000-000000000027');
    expect(daily).toHaveTextContent('10月27日 周二日常');
    expect(daily).toHaveTextContent('合成期刊：港口与小模型');
    expect(daily).toHaveTextContent('2 个栏目 · 合成世界简报、合成研究进展');
    expect(daily).toHaveTextContent('投递●邮件服务已接收');
    expect(daily).toHaveTextContent('Notion 备份●已同步');
    expect(all[2]).toHaveTextContent('修订');
    expect(all[4]).toHaveTextContent('Notion 备份■有冲突');
    // The copy's state is the journal's; an unknown write is 待核对, never synced.
    expect(all[0]).toHaveTextContent('Notion 备份◆待核对');
  });

  it('filters by delivery and kind, with the count of each, and keeps the filter in the address', async () => {
    serve(world());
    show('#/issues?show=test');
    const filters = within(await screen.findByRole('navigation', { name: '筛选期刊' }));
    expect(filters.getByRole('link', { name: /测试/ })).toHaveAttribute('aria-current', 'page');
    expect((await cards()).map((card) => card.textContent?.includes('测试'))).toEqual([true, true]);
    expect(filters.getByRole('link', { name: '全部 7 期' })).toHaveAttribute('href', '#/issues?month=2026-10');
    expect(filters.getByRole('link', { name: '已投递 5 期' })).toHaveAttribute('href', '#/issues?month=2026-10&show=delivered');
    expect(filters.getByRole('link', { name: '未发出 0 期' })).toBeVisible();
  });

  it('never counts an unconfirmed delivery as 未发出, and says where a day without an issue is', async () => {
    const list = fixture<{ editions: Record<string, unknown>[] }>('editions');
    const unknown = { ...list.editions[3], delivery: { state: 'unknown' } };
    const rejected = { ...list.editions[5], delivery: { state: 'rejected', error_code: 'mail_rejected' } };
    const pick = (state: string) => FILTERS.find((item) => item.value === 'unsent')!.test({ kind: 'daily', delivery: { state: state as never } });
    expect(['unknown', 'submitting', 'provider_accepted'].map(pick)).toEqual([false, false, false]);
    expect(['not_requested', 'rejected', 'simulated'].map(pick)).toEqual([true, true, true]);
    serve(world({ '/api/v1/editions': { ...list, editions: [unknown, rejected] } }));
    show('#/issues?show=unsent');
    expect((await cards()).map((card) => card.textContent)).toEqual([expect.stringContaining('邮件服务拒绝')]);
    cleanup();
    serve(world());
    show('#/issues?show=unsent');
    const empty = await screen.findByText(/这个月没有生成后未发出的期刊/);
    expect(within(empty).getByRole('link', { name: '查看这个月的运行 →' })).toHaveAttribute('href', '#/runs?month=2026-10');
  });

  it('reads the month the address asks for, and offers the nearest months that have editions', async () => {
    const requested = serve(world({ '/api/v1/editions': { ...fixture<Record<string, unknown>>('editions'), earlier_month: '2026-09' } }));
    show('#/issues?month=2026-10');
    expect(await screen.findByRole('link', { name: '‹ 2026年9月' })).toHaveAttribute('href', '#/issues?month=2026-09');
    expect(requested.find((url) => url.includes('/api/v1/editions'))).toContain('month=2026-10');
  });
});
