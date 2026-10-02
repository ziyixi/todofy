// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { ActiveAlert_Severity, ActiveAlertSchema } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { installFakeServer } from '../test/fakeServer'
import { overview, renderAt, settings } from '../test/fixtures'
import App from './App'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function open(active: MessageInitShape<typeof ActiveAlertSchema>[]) {
  installFakeServer({ settings: settings(), overview: overview({ logicalBytes: 100, activeAlerts: active.map(alert => create(ActiveAlertSchema, alert)) }) })
  // An unknown route keeps the test on the shell without page-specific API calls.
  renderAt(<App />, '/synthetic-missing-page')
}

it('shows active warning and critical alerts in a status banner with the matching links', async () => {
  open([
    { code: 'endpoint_blocked', severity: ActiveAlert_Severity.CRITICAL, metrics: { waiting_deliveries: 2, current_blocked: 1, auto_recheck: 0 } },
    { code: 'policy_error', severity: ActiveAlert_Severity.WARNING, metrics: { count: 1 } },
    { code: 'synthetic_info', severity: ActiveAlert_Severity.INFO, metrics: {} },
  ])
  const banner = await screen.findByRole('status')
  expect(banner.textContent).toContain('投递目标被阻断，自动投递已停止')
  expect(banner.textContent).toContain('有邮件因策略读取失败只归档、未转发')
  expect(banner.textContent).not.toContain('synthetic_info')
  expect(banner.className).toContain('critical')
  const links = Array.from(banner.querySelectorAll('a')).map(link => link.getAttribute('href'))
  expect(links).toEqual(['/endpoints', '/settings'])
})

it('links a warning-only banner to settings without an endpoint link', async () => {
  open([{ code: 'delivery_failed', severity: ActiveAlert_Severity.WARNING, metrics: { count: 1 } }])
  const banner = await screen.findByRole('status')
  expect(banner.textContent).toContain('有投递已停止，需要处理')
  expect(banner.className).not.toContain('critical')
  expect(Array.from(banner.querySelectorAll('a')).map(link => link.getAttribute('href'))).toEqual(['/settings'])
})

it('shows no banner when no alert needs attention', async () => {
  open([{ code: 'synthetic_info', severity: ActiveAlert_Severity.INFO, metrics: {} }])
  await screen.findByText('已用 100 B')
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows the receive address and the effective pause from the settings', async () => {
  installFakeServer({ settings: settings({ effectiveSendPaused: true }), overview: overview() })
  renderAt(<App />, '/synthetic-missing-page')
  expect(await screen.findByText('hero@example.test')).toBeTruthy()
  expect(screen.getByText('投递已暂停')).toBeTruthy()
})
