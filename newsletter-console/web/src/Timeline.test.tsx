import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Run, RunNode, RunNodeItem } from '@ziyixi/proto/newsletter/ui/v1/run_wire';
import { Timeline } from './Timeline.tsx';

describe('节点时间线 (Timeline)', () => {
  it('shows the unstarted notice when nodes are empty, unstarted, or have a degenerate time span', () => {
    const emptyRun: Run = { name: 'runs/1', nodes: [] };
    const { rerender } = render(<Timeline run={emptyRun} />);
    expect(screen.getByText('这次运行还没有节点开始。')).toBeVisible();

    const unstartedRun: Run = {
      name: 'runs/2',
      nodes: [{ node_id: 'feeds', state: 'pending', budget_seconds: 120 }],
    };
    rerender(<Timeline run={unstartedRun} />);
    expect(screen.getByText('这次运行还没有节点开始。')).toBeVisible();

    const zeroSpanRun: Run = {
      name: 'runs/3',
      start_time: '2026-10-28T07:00:00Z',
      end_time: '2026-10-28T07:00:00Z',
      nodes: [{ node_id: 'feeds', state: 'succeeded', start_time: '2026-10-28T07:00:00Z', end_time: '2026-10-28T07:00:00Z' }],
    };
    rerender(<Timeline run={zeroSpanRun} />);
    expect(screen.getByText('这次运行还没有节点开始。')).toBeVisible();
  });

  it('renders unstarted, running, degraded, unknown, over-budget, and mapped nodes with table twin', () => {
    const now = Date.parse('2026-10-28T07:10:00Z');
    const run: Run = {
      name: 'runs/4',
      nodes: [
        {
          node_id: 'feeds',
          type: 'api_feed',
          state: 'succeeded',
          degraded: true,
          error_code: 'partial_failure',
          start_time: '2026-10-28T07:00:00Z',
          end_time: '2026-10-28T07:01:00Z',
          budget_seconds: 90,
        },
        {
          node_id: 'selection',
          type: 'selection',
          state: 'failed',
          error_code: 'timeout',
          start_time: '2026-10-28T07:01:00Z',
          end_time: '2026-10-28T07:03:41Z',
          budget_seconds: 150,
        },
        {
          node_id: 'briefs',
          type: 'story_brief',
          state: 'running',
          start_time: '2026-10-28T07:03:41Z',
          budget_seconds: 180,
          item_count: 2,
          failed_item_count: 1,
          items: [
            {
              item_id: 'item-1',
              label: '01-port',
              state: 'succeeded',
              start_time: '2026-10-28T07:03:45Z',
              end_time: '2026-10-28T07:04:15Z',
            },
            {
              item_id: 'item-2',
              state: 'running',
              start_time: '2026-10-28T07:04:15Z',
            },
          ],
        },
        {
          node_id: 'deep',
          type: 'story_deep',
          state: 'unknown',
          start_time: '2026-10-28T07:04:00Z',
          end_time: '2026-10-28T07:05:00Z',
        },
        {
          node_id: 'publish',
          type: 'publish',
          state: 'pending',
          budget_seconds: 60,
        },
      ],
    };

    const { container } = render(<Timeline run={run} now={now} />);
    const gantt = within(screen.getByRole('list', { name: '节点时间线' }));
    const rows = gantt.getAllByRole('listitem');
    expect(rows).toHaveLength(5);

    expect(rows[0]).toHaveTextContent('订阅源');
    expect(rows[0]).toHaveTextContent('60 秒 / 90 秒');
    expect(rows[1]).toHaveTextContent('选题');
    expect(rows[1]).toHaveTextContent('161 秒 / 150 秒■超出预算');
    expect(rows[1]?.querySelector('.bar.over')).not.toBeNull();
    expect(rows[2]).toHaveTextContent('简讯');
    // Its budget is each item's: the running node's whole span is never drawn past it.
    expect(rows[2]).toHaveTextContent('每项预算 180 秒');
    expect(rows[2]?.querySelector('.bar.running.open')).not.toBeNull();
    expect(rows[2]?.querySelector('.bar.over')).toBeNull();
    expect(rows[3]).toHaveTextContent('深读');
    expect(rows[3]).toHaveTextContent('1 分');
    expect(rows[4]).toHaveTextContent('发布');
    expect(rows[4]).toHaveTextContent('未开始');
    expect(rows[4]).toHaveTextContent('预算 60 秒');

    const toggle = gantt.getByRole('button', { name: '1/2 完成' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(gantt.getByText('01-port')).toBeVisible();
    expect(gantt.getByText('item-2')).toBeVisible();
    expect(gantt.getByText('30 秒')).toBeVisible();
    expect(gantt.getByText('运行中')).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(gantt.queryByText('01-port')).toBeNull();

    const table = within(container.querySelector('details.twin table') as HTMLElement);
    const tableRows = table.getAllByRole('row').slice(1);
    expect(tableRows).toHaveLength(5);
    expect(tableRows[0]).toHaveTextContent('订阅源');
    expect(tableRows[0]).toHaveTextContent('▲部分失败');
    expect(tableRows[0]).toHaveTextContent('partial_failure');
    expect(tableRows[1]).toHaveTextContent('■失败');
    expect(tableRows[1]).toHaveTextContent('timeout');
    expect(tableRows[4]).toHaveTextContent('○未开始');
  });

  it('holds each item of a mapped node, never its whole span, to the budget', () => {
    // Discovery's directions run one after another, each under its own 240-second budget.
    const item = (n: number, from: string, to: string): RunNodeItem => ({
      item_id: `0${String(n)}-direction`, state: 'succeeded', start_time: from, end_time: to,
    });
    const discovery = (last: string): RunNode => ({
      node_id: 'discovery',
      type: 'discovery',
      state: 'succeeded',
      start_time: '2026-10-27T15:01:00Z',
      end_time: last,
      budget_seconds: 240,
      item_count: 3,
      items: [
        item(1, '2026-10-27T15:01:00Z', '2026-10-27T15:04:00Z'),
        item(2, '2026-10-27T15:04:00Z', '2026-10-27T15:07:00Z'),
        item(3, '2026-10-27T15:07:00Z', last),
      ],
    });
    const run = (last: string): Run => ({
      name: 'runs/6', start_time: '2026-10-27T15:00:00Z', end_time: '2026-10-27T15:20:00Z', nodes: [discovery(last)],
    });
    const { container, rerender } = render(<Timeline run={run('2026-10-27T15:10:30Z')} />);
    let row = screen.getByRole('list', { name: '节点时间线' }).querySelector('li');
    // 570 seconds in all, no item past 240: within budget.
    expect(row).toHaveTextContent('9 分 30 秒 · 每项预算 240 秒');
    expect(row).not.toHaveTextContent('超出预算');
    expect(container.querySelector('.bar.over')).toBeNull();
    expect(container.querySelector('details.twin tbody tr')).toHaveTextContent('每项 240 秒');

    rerender(<Timeline run={run('2026-10-27T15:11:20Z')} />);
    row = screen.getByRole('list', { name: '节点时间线' }).querySelector('li');
    expect(row).toHaveTextContent('超出预算');
    fireEvent.click(screen.getByRole('button', { name: '3/3 完成' }));
    const items = screen.getByRole('list', { name: '节点时间线' }).querySelectorAll('li.item');
    expect(items[1]).not.toHaveTextContent('超出预算');
    expect(items[2]).toHaveTextContent('4 分 20 秒■超出预算');
    expect(items[2]?.querySelector('.bar.over')).not.toBeNull();
  });

  it('falls back to the 3600s axis step when total run duration exceeds 6 hours', () => {
    const longRun: Run = {
      name: 'runs/5',
      start_time: '2026-10-28T00:00:00Z',
      end_time: '2026-10-28T07:00:00Z',
      nodes: [
        {
          node_id: 'feeds',
          type: 'api_feed',
          state: 'succeeded',
          start_time: '2026-10-28T00:00:00Z',
          end_time: '2026-10-28T07:00:00Z',
        },
      ],
    };
    const { container } = render(<Timeline run={longRun} />);
    const ticks = Array.from(container.querySelectorAll('.axis-tick')).map((el) => el.textContent);
    expect(ticks).toEqual(['0', '+1 小时', '+2 小时', '+3 小时', '+4 小时', '+5 小时', '+6 小时', '+7 小时']);
  });
});
