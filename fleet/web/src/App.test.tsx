import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromWire } from '@ziyixi/proto/wire-json';
import { FleetStatusSchema } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import fixture from '../../../contracts/fleet-report-v1/fixtures/healthy.json';
import { App } from './App.tsx';
import { client } from './api.ts';

const BASE = {
  name: 'fleetStatus',
  generate_time: '2026-10-03T00:00:00Z',
  freshness: 'never_seen',
  changes: [],
  build_sha: '1'.repeat(40),
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function show(value: unknown): void {
  vi.spyOn(client, 'getFleetStatus').mockResolvedValue(fromWire(FleetStatusSchema, value).message);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><App /></QueryClientProvider>);
}

describe('Fleet owner page', () => {
  it('shows truthful never-seen state and no invented healthy service', async () => {
    show(BASE);
    expect(await screen.findByRole('heading', { name: '尚未接入' })).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新状态' })).toBeVisible();
    expect(screen.queryByText('进程健康')).toBeNull();
  });
  it('marks old observations and shows desired and actual identities separately', async () => {
    const report = structuredClone(fixture);
    const workload = report.runtime.workloads[0];
    if (!workload) throw new Error('missing fixture workload');
    workload.release.actual.source_sha = '2'.repeat(40);
    show({ ...BASE, freshness: 'stale', report, receive_time: '2026-10-03T00:00:00Z' });
    expect(await screen.findByRole('heading', { name: '观测延迟' })).toBeVisible();
    expect(screen.getByText('以下是历史观测，不能代表当前服务健康。')).toBeVisible();
    expect(screen.getByText('2'.repeat(40))).toBeVisible();
    expect(screen.getByText('目标提交：')).toBeVisible();
    expect(screen.getByText('实际提交：')).toBeVisible();
  });
  it('shows a held release independently of healthy workload observations', async () => {
    const report = {
      ...fixture,
      runtime: {
        ...fixture.runtime,
        current_release: {
          name: 'releases/6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
          request_id: '6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
          phase: 'held',
          etag: 'version-3',
          update_time: '2026-10-03T00:00:00Z',
          error_code: 'BUSINESS_OUTCOME_UNKNOWN',
        },
      },
    };
    show({ ...BASE, freshness: 'fresh', report, receive_time: '2026-10-03T00:00:00Z' });
    expect(await screen.findByRole('heading', { name: '当前发布操作' })).toBeVisible();
    expect(screen.getByText('BUSINESS_OUTCOME_UNKNOWN')).toBeVisible();
    expect(screen.getByText(/暂停待处理/)).toBeVisible();
  });
  it('explains the unknown aggregate independently of process health and links to configured Home', async () => {
    const report = structuredClone(fixture);
    report.newsletter.unknown_count = 32;
    show({ ...BASE, freshness: 'fresh', report, receive_time: '2026-10-03T00:00:00Z' });
    expect(await screen.findByRole('heading', { name: 'Newsletter' })).toBeVisible();
    expect(screen.getByText('未确认完成记录').nextElementSibling).toHaveTextContent('32');
    expect(screen.getByText(/后台进程：健康/)).toBeVisible();
    expect(screen.getByText(/合计并非失败邮件数/)).toBeVisible();
    expect(screen.queryByText(/关闭提醒/)).toBeNull();
    expect(screen.getByRole('link', { name: '返回 Home' })).toHaveAttribute('href', import.meta.env.VITE_HOME_URL);
  });
  it('does not turn missing Newsletter observations into zero or a healthy process', async () => {
    const report = { ...fixture, newsletter: { state: 'unavailable', drain_state: 'unknown' } };
    show({ ...BASE, freshness: 'fresh', report, receive_time: '2026-10-03T00:00:00Z' });
    expect(await screen.findByRole('heading', { name: 'Newsletter' })).toBeVisible();
    expect(screen.getByText('未确认完成记录').nextElementSibling).toHaveTextContent('未知');
    expect(screen.getByText(/后台进程：未知/)).toBeVisible();
  });
  it.each([
    ['provider_accepted', '邮件服务已接收'],
    ['rejected', '邮件服务拒绝'],
    ['unknown', '结果尚未确认'],
  ])('shows the latest %s outcome independently of a healthy process and historical records', async (state, outcome) => {
    const report = {
      ...fixture,
      newsletter: {
        ...fixture.newsletter,
        unknown_count: 4,
        unknown_revision: 7,
        unknown_by_kind: {
          interrupted_activities: 2, packets: 1, workflow_attempts: 0,
          notion_entities: 0, notion_versions: 0, delivery: 1,
        },
        latest_delivery_state: state,
        latest_delivery_time: '2026-10-02T23:30:00.000Z',
      },
    };
    show({ ...BASE, freshness: 'fresh', report, receive_time: '2026-10-03T00:00:00Z' });
    expect(await screen.findByRole('heading', { name: 'Newsletter' })).toBeVisible();
    expect(screen.getByText(/后台进程：健康/)).toBeVisible();
    expect(screen.getByText(new RegExp(`最近投递记录：${outcome}`))).toHaveTextContent('2026-10-02T23:30:00Z');
    expect(screen.getByText('未确认完成记录').nextElementSibling).toHaveTextContent('4');
    expect(screen.getByText('运行中断').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('邮件投递').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText(/需要核对/)).toBeVisible();
  });
  it('keeps absent legacy delivery metadata visibly unobserved', async () => {
    show({ ...BASE, freshness: 'fresh', report: fixture, receive_time: '2026-10-03T00:00:00Z' });
    expect(await screen.findByText('最近投递记录：暂未取得')).toBeVisible();
    expect(screen.queryByText('运行中断')).toBeNull();
  });
});
