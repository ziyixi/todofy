import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BLOCKED_RUN, serve, show, world } from './test/world.tsx';

describe('运行列表 (RunsPage)', () => {
  it('lists each run with its trigger, state, outcome, duration, model call summary, and month navigation', async () => {
    serve(world({
      '/api/v1/runs': {
        month: '2026-10',
        earlier_month: '2026-09',
        later_month: '2026-11',
        runs: [
          {
            name: 'runs/00000000-0000-4000-8000-000000002900',
            issue_date: '2026-10-29',
            trigger: 'manual',
            state: 'running',
            create_time: '2026-10-29T07:00:00Z',
          },
          {
            name: BLOCKED_RUN,
            issue_date: '2026-10-28',
            trigger: 'scheduled',
            state: 'blocked',
            stop_reason: 'no_publishable_content',
            start_time: '2026-10-28T07:00:00Z',
            end_time: '2026-10-28T07:02:41Z',
            failure: {
              node_id: 'selection',
              kind: 'node_budget',
              elapsed_seconds: 161,
              budget_seconds: 150,
            },
            usage: { call_count: 3, input_tokens: 4000, output_tokens: 1400 },
          },
          {
            name: 'runs/00000000-0000-4000-8000-000000002700',
            issue_date: '2026-10-27',
            trigger: 'replay',
            state: 'ready',
            delivery_state: 'provider_accepted',
            create_time: '2026-10-27T07:00:00Z',
            end_time: '2026-10-27T07:01:30Z',
            usage: { call_count: 5, input_tokens: 10000, output_tokens: 2000 },
          },
        ],
      },
    }));
    show('#/runs?month=2026-10');

    expect(await screen.findByRole('heading', { name: '2026年10月' })).toBeVisible();
    const nav = within(screen.getByRole('navigation', { name: '其他月份' }));
    expect(nav.getByRole('link', { name: '‹ 2026年9月' })).toHaveAttribute('href', '#/runs?month=2026-09');
    expect(nav.getByRole('link', { name: '2026年11月 ›' })).toHaveAttribute('href', '#/runs?month=2026-11');

    const list = within(await screen.findByRole('list', { name: '2026年10月的运行' }));
    const rows = list.getAllByRole('link');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveTextContent('10月29日 周四手动');
    expect(rows[0]).toHaveTextContent('◆运行中');
    expect(rows[0]).toHaveTextContent('用时—');
    expect(rows[0]).toHaveTextContent('模型调用—');

    expect(rows[1]).toHaveTextContent('10月28日 周三每日');
    expect(rows[1]).toHaveTextContent('■已停止选题超出节点预算（用时 161 秒 / 预算 150 秒）');
    expect(rows[1]).toHaveTextContent('用时2 分 41 秒');
    expect(rows[1]).toHaveTextContent('模型调用3 次 · 5,400 tokens');

    expect(rows[2]).toHaveTextContent('10月27日 周二重放');
    expect(rows[2]).toHaveTextContent('●已生成邮件服务已接收');
    expect(rows[2]).toHaveTextContent('用时1 分 30 秒');
    expect(rows[2]).toHaveTextContent('模型调用5 次 · 1.2 万 tokens');
  });

  it('renders an empty state when a month has no recorded runs', async () => {
    serve(world({
      '/api/v1/runs': {
        month: '2026-08',
        runs: [],
      },
    }));
    show('#/runs?month=2026-08');
    expect(await screen.findByText('这个月没有运行记录。')).toBeVisible();
    expect(screen.getByText('‹ 没有更早的记录')).toBeVisible();
  });

  it('renders a notice when the runs endpoint fails', async () => {
    serve(world({
      '/api/v1/runs': () => new Response('unavailable', { status: 503 }),
    }));
    show('#/runs');
    expect(await screen.findByText('运行记录暂时读不到，稍后刷新。')).toBeVisible();
  });
});
