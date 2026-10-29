import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serve, show, USAGE, world } from './test/world.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('模型', () => {
  it('asks for the range in the address (7 by default) and marks it', async () => {
    const requested = serve(world());
    show('#/models?days=30');
    await section('每日 tokens');
    const usage = requested.filter((url) => decodeURIComponent(url).includes(USAGE));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatch(/day_?count=30/i);
    const ranges = within(screen.getByRole('navigation', { name: '时间范围' }));
    expect(ranges.getByRole('link', { name: '30 天' })).toHaveAttribute('aria-current', 'page');
    expect(ranges.getByRole('link', { name: '7 天' })).toHaveAttribute('href', '#/models');
    expect(ranges.getByRole('link', { name: '90 天' })).toHaveAttribute('href', '#/models?days=90');
    expect(screen.getByText(/9月30日 – 10月29日 · 30 天/)).toBeVisible();
  });

  it('sums the calls, failures, tokens, models and the estimate, which is not a bill', async () => {
    serve(world());
    show('#/models');
    const tiles = within(await screen.findByLabelText('用量'));
    expect(tiles.getByText('调用').nextElementSibling).toHaveTextContent('19 次');
    expect(tiles.getByText('失败 1 · 用量不完整 1')).toBeVisible();
    expect(tiles.getByText('输入 tokens').nextElementSibling).toHaveTextContent('21.8 万');
    expect(tiles.getByText('缓存命中 7.2 万（33%）')).toBeVisible();
    expect(tiles.getByText('模型').nextElementSibling).toHaveTextContent('2 个');
    expect(tiles.getByText('估算费用').nextElementSibling).toHaveTextContent('$0.01');
    expect(tiles.getByText(/订阅额度不是账单/)).toBeVisible();
    expect(tiles.getByText('有用时记录').nextElementSibling).toHaveTextContent('10 / 19 次');
  });

  it('draws a stacked column per date with a legend and a table twin', async () => {
    serve(world());
    show('#/models?days=30');
    const chart = await section('每日 tokens');
    expect(within(chart.getByRole('list', { name: '模型' })).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['gpt-6.1-sol-2026-10-01', 'gpt-6.1-sol']);
    const plot = chart.getByRole('img');
    expect(plot.querySelectorAll('g')).toHaveLength(30);
    expect(plot.querySelectorAll('rect')).toHaveLength(5);
    expect(chart.getByRole('table')).toBeInTheDocument();
    expect(chart.getAllByRole('row')).toHaveLength(6);
  });

  it('shows each node and purpose, saying 上线前未记录 for calls recorded before purposes and times', async () => {
    serve(world());
    show('#/models');
    const rows = (await section('按节点')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveTextContent('搜集上线前未记录');
    expect(rows[0]).toHaveTextContent('上线前未记录 / 240 秒');
    expect(rows[1]).toHaveTextContent('搜集搜集');
    expect(rows[1]).toHaveTextContent('98 秒');
    expect(rows[2]).toHaveTextContent('失败 1');
    expect(rows[2]).toHaveTextContent('下限');
    expect(rows[4]).toHaveTextContent('简讯审校');
    expect(screen.getByText(/这里是 Newsletter 自己的调用账本；Model Router 的请求记录是另一份账本/)).toBeVisible();
  });
});
