import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReconcilePlan } from '@ziyixi/proto/platform/runtime/v1/runtime_wire';
import { ReconcileView } from './ReconcileView.tsx';
import { ACTIONS_RECONCILE_URL, REBUILD_DOC_URL } from './deployment.ts';

const PLAN: ReconcilePlan = {
  name: 'reconcilePlan', state: 'clean', base_release: 'releases/6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
  base_etag: 'version-1', fingerprint: 'a'.repeat(64), observed_at: '2026-10-03T00:00:00Z', changes: [],
};

afterEach(cleanup);

describe('runtime repair guidance', () => {
  it('does not present missing observations as a clean configuration', () => {
    render(<ReconcileView plan={null} />);
    expect(screen.getByText(/尚未收到配置检查结果/)).toBeVisible();
    expect(screen.queryByText(/当前无需修复/)).toBeNull();
  });
  it('links a bounded repair to Actions and leaves a host recovery path', () => {
    render(<ReconcileView plan={{ ...PLAN, state: 'repairable', changes: [{ resource_key: 'newsletter', action: 'update', reason_code: 'RUNTIME_FIELDS_CHANGED' }] }} />);
    expect(screen.getByText(/修复当前已接受的版本/)).toBeVisible();
    expect(screen.getByRole('link', { name: '打开 GitHub 检查／修复' })).toHaveAttribute('href', ACTIONS_RECONCILE_URL);
    expect(screen.getByRole('link', { name: 'daemon 或宿主不可达时的恢复步骤' })).toHaveAttribute('href', REBUILD_DOC_URL);
  });
  it('states that a clean check does not restart and explains manual pause', () => {
    const view = render(<ReconcileView plan={PLAN} />);
    expect(screen.getByText(/不会重启服务/)).toBeVisible();
    view.rerender(<ReconcileView plan={{ ...PLAN, state: 'manual_required', reason_code: 'BUSINESS_PAUSED' }} />);
    expect(screen.getByText(/修复会保留暂停状态/)).toBeVisible();
    expect(screen.queryByText(/在 GitHub 运行 repair/)).toBeNull();
  });
});
