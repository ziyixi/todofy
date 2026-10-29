import { render, screen } from '@testing-library/react'
import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { NewsletterConfigDetails } from './NewsletterConfigDetails'

const NOW = new Date('2026-10-03T00:00:00Z')
const status = (code?: string): OpsStatus => ({
  version: 'ops-v1', app: 'newsletter', generated_at: NOW.toISOString(), health: 'ok', modes: { maintenance: false },
  guard: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] },
  signals: code ? [{ code, severity: code.endsWith('failed') || code.endsWith('stale') ? 'warning' : 'info', metrics: {} }] : [],
  counters: code ? { newsletter_config_last_attempt_at: NOW.getTime() / 1000 - 300, newsletter_config_last_success_at: NOW.getTime() / 1000 - 900 } : {},
  last_backup_at: null, ui_url: 'https://fleet.example.test/', capabilities: [],
})

describe('Home Newsletter configuration details', () => {
  it('shows the source check clocks and Fleet link independently of Home polling time', () => {
    render(<NewsletterConfigDetails status={status('newsletter_config_current')} now={NOW} />)
    expect(screen.getByText('与上次检查目标一致')).toBeInTheDocument()
    expect(screen.getByText('最近配置检查').nextElementSibling?.querySelector('time')).toHaveAttribute('datetime', '2026-10-02T23:55:00.000Z')
    expect(screen.getByText('最近成功检查').nextElementSibling?.querySelector('time')).toHaveAttribute('datetime', '2026-10-02T23:45:00.000Z')
    expect(screen.getByRole('link', { name: /查看 Fleet 配置详情/ })).toHaveAttribute('href', 'https://fleet.example.test/')
    expect(screen.getByText(/未核对检查之后的新发布/)).toBeInTheDocument()
  })
  it.each([
    ['newsletter_config_pending', 'Newsletter 配置等待激活'],
    ['newsletter_config_failed', 'Newsletter 配置检查失败'],
    ['newsletter_config_stale', 'Newsletter 配置检查延迟'],
    ['newsletter_config_pinned', 'Newsletter 配置使用固定版本'],
    ['newsletter_config_unobserved', 'Newsletter 配置尚未观测'],
  ])('shows %s without changing process or delivery wording', (code, label) => {
    render(<NewsletterConfigDetails status={status(code)} now={NOW} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.queryByText('与上次检查目标一致')).toBeNull()
    if (code === 'newsletter_config_failed') expect(screen.getByText(/不代表每日投递失败/)).toBeInTheDocument()
  })
  it('keeps legacy and unavailable source metadata visibly unobserved', () => {
    render(<NewsletterConfigDetails status={status()} now={NOW} />)
    expect(screen.getByText('Newsletter 配置尚未观测')).toBeInTheDocument()
    expect(screen.getAllByText('暂无观测')).toHaveLength(2)
  })
})
