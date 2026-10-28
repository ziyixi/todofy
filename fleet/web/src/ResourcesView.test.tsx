import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromWire } from '@ziyixi/proto/wire-json';
import {
  SummarizeNodeMetricsRequest_Range as Range,
  SummarizeNodeMetricsResponseSchema,
} from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import type { Node } from '@ziyixi/proto/fleet/ui/v1/node_wire';
import { client } from './api.ts';
import { ResourcesView } from './ResourcesView.tsx';
import { daySummary, NODE } from './test/nodes.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(nodes: Node[], summary: unknown = daySummary(), failed = false) {
  const spy = vi.spyOn(client, 'summarizeNodeMetrics')
    .mockResolvedValue(fromWire(SummarizeNodeMetricsResponseSchema, summary).message);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><ResourcesView nodes={nodes} loading={false} failed={failed} /></QueryClientProvider>);
  return spy;
}

describe('resources view', () => {
  it('explains an empty fleet instead of drawing empty charts', () => {
    const spy = show([]);
    expect(screen.getByRole('heading', { name: '尚未收到节点指标' })).toBeVisible();
    expect(screen.getByText(/连续两份报告/)).toBeVisible();
    expect(spy).not.toHaveBeenCalled();
  });
  it('does not mistake an unreadable node list for an empty fleet', () => {
    const spy = show([], daySummary(), true);
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取节点列表');
    expect(screen.queryByRole('heading', { name: '尚未收到节点指标' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps a filesystem role\'s colour when another role is absent', async () => {
    const summary = daySummary();
    show([NODE], { ...summary, series: summary.series.filter((s) => s.label !== 'root') });
    const disk = await screen.findByRole('group', { name: /^磁盘使用率/ });
    expect(disk.querySelector('[data-run="k3s"] path:last-child')).toHaveAttribute('stroke', '#eb6834');
  });
  it('draws the node charts and workload small multiples for the day', async () => {
    const spy = show([NODE]);
    for (const title of ['CPU 使用率', '内存', '磁盘使用率', '网络', '负载']) {
      expect(await screen.findByRole('group', { name: new RegExp(`^${title}，24 小时`) })).toBeInTheDocument();
    }
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'nodes/vps', range: Range.DAY }));
    const workloads = screen.getByRole('region', { name: '工作负载' });
    expect(within(workloads).getAllByRole('group', { name: /^newsletter，/ })).toHaveLength(2);
    expect(within(workloads).getAllByRole('group', { name: /^platform-runtime，/ })).toHaveLength(2);
    expect(screen.getByText(/本地时区/)).toBeVisible();
    expect(screen.getByText(/空白处表示没有数据，不代表为零/)).toBeVisible();
  });
  it('requests the chosen range with a keyboard-reachable selector', async () => {
    const user = userEvent.setup();
    const spy = show([NODE]);
    await screen.findByRole('group', { name: /^CPU 使用率/ });
    const week = screen.getByRole('radio', { name: '7 天' });
    await user.click(week);
    expect(week).toBeChecked();
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ range: Range.WEEK }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '30 天' })).toBeChecked();
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ range: Range.MONTH }));
  });
  it('says when a range has no workload data and keeps empty charts framed', async () => {
    const summary = daySummary();
    show([NODE], { ...summary, series: summary.series.filter((s) => !s.metric.startsWith('workload_') && s.metric !== 'cpu_percent' && s.metric !== 'cpu_iowait_percent') });
    expect(await screen.findByText('此范围内没有工作负载数据。')).toBeVisible();
    const cpu = screen.getByRole('group', { name: /^CPU 使用率/ });
    expect(within(cpu).getByText('此范围内没有数据')).toBeVisible();
  });
  it('lets the owner choose among several nodes', async () => {
    const user = userEvent.setup();
    const spy = show([NODE, { ...NODE, name: 'nodes/edge' }]);
    await screen.findByRole('group', { name: /^CPU 使用率/ });
    await user.selectOptions(screen.getByRole('combobox', { name: '节点' }), 'nodes/edge');
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'nodes/edge' }));
  });
});
