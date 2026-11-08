import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkloadInventory } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { WorkloadInventoryView } from './WorkloadInventoryView.tsx';

const INVENTORY: WorkloadInventory = {
  state: 'observed',
  workloads: [
    { workload_key: 'sample-api', state: 'ready', desired_count: 2, ready_count: 2, restart_count: 0, readiness_probe: true },
    { workload_key: 'sample-worker', state: 'starting', readiness_probe: false },
  ],
};

afterEach(cleanup);

describe('discovered workload readiness', () => {
  it('shows dynamic aliases, counts and probe declarations', () => {
    render(<WorkloadInventoryView inventory={INVENTORY} />);
    const api = screen.getByRole('rowheader', { name: 'sample-api' }).closest('tr') as HTMLElement;
    expect(within(api).getByText('就绪')).toBeVisible();
    expect(within(api).getByText('2 / 2')).toBeVisible();
    expect(within(api).getByText('0')).toBeVisible();
    expect(within(api).getByText('已声明就绪探针')).toBeVisible();
    const worker = screen.getByRole('rowheader', { name: 'sample-worker' }).closest('tr') as HTMLElement;
    expect(within(worker).getByText('启动中')).toBeVisible();
    expect(within(worker).getByText('? / ?')).toBeVisible();
    expect(within(worker).getByText('未知')).toBeVisible();
    expect(within(worker).getByText('未声明就绪探针')).toBeVisible();
  });
  it.each([undefined, null])('keeps legacy reports without an inventory unknown (%s)', (inventory) => {
    render(<WorkloadInventoryView inventory={inventory} />);
    expect(screen.getByText('未知：此报告未提供工作负载就绪观测。')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('keeps unavailable discovery unknown', () => {
    render(<WorkloadInventoryView inventory={{ state: 'unavailable', workloads: [] }} />);
    expect(screen.getByText('未知：本次未能读取工作负载清单。')).toBeVisible();
    expect(screen.queryByText(/未发现声明监控/)).toBeNull();
  });
  it('shows bounded rows while stating a truncated inventory is incomplete', () => {
    render(<WorkloadInventoryView inventory={{ ...INVENTORY, state: 'truncated' }} />);
    expect(screen.getByText(/清单不完整.*其余工作负载状态未知/)).toBeVisible();
    expect(screen.getByRole('rowheader', { name: 'sample-api' })).toBeVisible();
  });
  it('distinguishes a successful empty discovery from missing evidence', () => {
    render(<WorkloadInventoryView inventory={{ state: 'observed' }} />);
    expect(screen.getByText('本次未发现声明监控的工作负载。')).toBeVisible();
  });
});
