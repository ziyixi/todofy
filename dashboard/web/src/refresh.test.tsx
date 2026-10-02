import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { VIEW_INTERVAL_MS } from './api/queries'
import { NOW, healthy } from './test/fixtures'
import { freezeClock, installFetch, json, renderApp, serve, PATHS } from './test/harness'

describe('refresh', () => {
  it('keeps the data age in the top bar and says, relatively, when 刷新 works again (F4)', async () => {
    freezeClock()
    const scenario = healthy()
    // A status was read 2 minutes ago: the next one is due in 8 minutes.
    const calls = serve({ ...scenario, home: { ...scenario.home, refresh: { ...scenario.home.refresh, next_refresh_at: new Date(NOW.getTime() + 8 * 60_000).toISOString() } } })
    renderApp()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })
    const button = screen.getByRole('button', { name: '刷新' })
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'))
    // Still focusable, with the data age and the wait in its description; no wall-clock time with seconds.
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(/^数据 ?29分钟前 8 分钟后可再次刷新$/)
    expect(screen.getByText('29分钟前')).toBeInTheDocument()
    await userEvent.setup().click(button)
    expect(screen.getByText('8 分钟后可再次刷新。')).toHaveAttribute('role', 'status')
    expect(calls.map((call) => call.path)).not.toContain(PATHS.refreshHome)
  })

  it('re-reads the statuses with /home?refresh=1, then the visible view', async () => {
    freezeClock()
    const base = healthy()
    let refreshed = true
    let next = NOW.toISOString()
    const calls = serve((call) => ({
      ...base,
      // The page's own GET keeps the button usable; only the declined refresh answers a later window.
      home: { ...base.home, refresh: { ...base.home.refresh, refreshed, last_refresh_at: NOW.toISOString(), next_refresh_at: call.path.endsWith(':refresh') ? next : NOW.toISOString() } },
    }))
    renderApp('#/flows')
    const user = userEvent.setup()
    await screen.findByRole('article', { name: '邮件 → 任务' })
    const button = screen.getByRole('button', { name: '刷新' })
    // The data age: the last tick (16:30:04 UTC), just under 30 minutes before the fixed clock.
    expect(button).toHaveAccessibleDescription(/^数据 ?29分钟前$/)

    await user.click(button)
    await waitFor(() => expect(screen.getByText('已刷新。')).toHaveAttribute('role', 'status'))
    await waitFor(() => expect(calls.filter((call) => call.path === PATHS.flows)).toHaveLength(2))
    expect(calls.map((call) => call.path)).toContain(PATHS.refreshHome)

    // Declined: the note says when the Worker fetches again (next_refresh_at), not a fixed minute.
    refreshed = false
    next = new Date(NOW.getTime() + 7 * 60_000 + 10_000).toISOString()
    await user.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(screen.getByText('刚刚刷新过，请在 8 分钟后再试。')).toBeInTheDocument())
  })

  it('re-reads only the visible view every 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    const calls = serve(healthy())
    renderApp('#/cloudflare')
    await screen.findByRole('heading', { name: '账户额度' })
    const views = () => calls.filter((call) => call.path !== PATHS.registry).map((call) => call.path)
    expect(views()).toEqual([PATHS.cloudflare])

    await act(() => vi.advanceTimersByTimeAsync(VIEW_INTERVAL_MS - 1_000))
    expect(views()).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await waitFor(() => expect(views()).toEqual([PATHS.cloudflare, PATHS.cloudflare]))
  })

  it('keeps showing the last data when a background update fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    const scenario = healthy()
    let fail = false
    installFetch((call) => {
      if (call.path === PATHS.registry) return json(scenario.registry)
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
