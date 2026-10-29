import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewsletterConfigSync } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';
import { NewsletterConfigView } from './NewsletterConfigView.tsx';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const CONFIG: NewsletterConfigSync = {
  active_revision: '1'.repeat(40), active_digest: 'a'.repeat(64), wanted_revision: '1'.repeat(40),
  wanted_digest: 'a'.repeat(64), wanted_commit: '2'.repeat(40),
  last_attempt_time: '2026-10-02T23:55:00Z', last_success_time: '2026-10-02T23:55:00Z',
};
afterEach(cleanup);

describe('Fleet Newsletter configuration details', () => {
  it('shows both full identities and the observation clocks without claiming latest publication', () => {
    render(<NewsletterConfigView config={CONFIG} now={NOW} />);
    expect(screen.getByText('与上次检查目标一致')).toBeVisible();
    expect(screen.getAllByText(CONFIG.active_revision ?? '')).toHaveLength(2);
    expect(screen.getAllByText(CONFIG.active_digest ?? '')).toHaveLength(2);
    expect(screen.getByText(CONFIG.wanted_commit ?? '')).toBeVisible();
    expect(screen.getByText('最近检查').nextElementSibling?.querySelector('time')).toHaveAttribute('datetime', CONFIG.last_attempt_time);
    expect(screen.getByText(/未核对检查之后的新发布/)).toBeVisible();
  });
  it.each([
    [{ ...CONFIG, active_digest: 'b'.repeat(64) }, '等待激活'],
    [{ ...CONFIG, error: 'CONFIG_ACTIVATION_FAILED' }, '配置检查失败'],
    [{ ...CONFIG, last_attempt_time: '2026-10-02T23:00:00Z' }, '配置检查延迟'],
    [{ ...CONFIG, pinned_digest: CONFIG.active_digest }, '固定版本'],
    [null, '尚未取得完整配置观测'],
  ] as const)('states an independent configuration observation', (config, label) => {
    render(<NewsletterConfigView config={config} now={NOW} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('与上次检查目标一致')).toBeNull();
    if (config?.error) expect(screen.getByText(config.error)).toBeVisible();
  });
});
