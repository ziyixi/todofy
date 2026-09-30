import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { VIEW_INTERVAL_MS } from './api/queries'
import { NOW, healthy } from './test/fixtures'
import { freezeClock, installFetch, json, renderApp, serve } from './test/harness'

describe('refresh', () => {
  it('keeps 刷新 disabled until the Worker allows the next refresh', async () => {
    freezeClock()
    const scenario = healthy()
    serve({ ...scenario, home: { ...scenario.home, refresh: { ...scenario.home.refresh, next_refresh_at: new Date(NOW.getTime() + 30_000).toISOString() } } })
    renderApp()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })
    const button = screen.getByRole('button', { name: '刷新' })
    await waitFor(() => expect(button).toBeDisabled())
    // 17:00:30 UTC in Asia/Shanghai.
    expect(button).toHaveAccessibleDescription('01:00:30 后可再次刷新')
  })

  it('re-reads the statuses with /home?refresh=1, then the visible view', async () => {
    freezeClock()
    const base = healthy()
    let refreshed = true
    const calls = serve(() => ({
      ...base,
      home: { ...base.home, refresh: { ...base.home.refresh, refreshed, last_refresh_at: NOW.toISOString(), next_refresh_at: NOW.toISOString() } },
    }))
    renderApp('#/flows')
    const user = userEvent.setup()
    await screen.findByRole('article', { name: '邮件 → 任务' })
    const button = screen.getByRole('button', { name: '刷新' })
    // The data age: the last tick (16:30:04 UTC), just under 30 minutes before the fixed clock.
    expect(button).toHaveAccessibleDescription(/^数据 ?29分钟前$/)

    await user.click(button)
    await waitFor(() => expect(screen.getByText('已刷新。')).toHaveAttribute('role', 'status'))
    await waitFor(() => expect(calls.filter((call) => call.path === '/api/v2/flows')).toHaveLength(2))
    expect(calls.map((call) => call.path)).toContain('/api/v2/home?refresh=1')

    refreshed = false
    await user.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(screen.getByText('刚刚刷新过，请在 1 分钟后再试。')).toBeInTheDocument())
  })

  it('re-reads only the visible view every 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    const calls = serve(healthy())
    renderApp('#/cloudflare')
    await screen.findByRole('heading', { name: '账户额度' })
    const views = () => calls.filter((call) => call.path !== '/api/v2/registry').map((call) => call.path)
    expect(views()).toEqual(['/api/v2/cloudflare'])

    await act(() => vi.advanceTimersByTimeAsync(VIEW_INTERVAL_MS - 1_000))
    expect(views()).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await waitFor(() => expect(views()).toEqual(['/api/v2/cloudflare', '/api/v2/cloudflare']))
  })

  it('keeps showing the last data when a background update fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    const scenario = healthy()
    let fail = false
    installFetch((call) => {
      if (call.path === '/api/v2/registry') return json(scenario.registry)
      if (fail) throw new TypeError('redirect')
      return json(scenario.home)
    })
    renderApp()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })
    fail = true
    await act(() => vi.advanceTimersByTimeAsync(VIEW_INTERVAL_MS + 1_000))
    const alert = (await screen.findByText(/自动更新失败/)).closest('[role="alert"]')
    expect(alert).toHaveTextContent('自动更新失败：无法连接个人控制台，或登录已过期，请刷新页面。下面显示的是')
    expect(screen.getByRole('link', { name: /打开 Mail Hero/ })).toBeInTheDocument()
  })
})
