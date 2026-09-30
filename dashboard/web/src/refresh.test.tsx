import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { OVERVIEW_INTERVAL_MS } from './api/queries'
import { NOW, healthyOverview } from './test/fixtures'
import { freezeClock, installFetch, json, renderApp } from './test/harness'

describe('refresh', () => {
  it('keeps the refresh button disabled until next_refresh_at', async () => {
    freezeClock()
    const overview = healthyOverview()
    installFetch(() =>
      json({ ...overview, refresh: { ...overview.refresh, next_refresh_at: new Date(NOW.getTime() + 30_000).toISOString() } }),
    )
    renderApp()
    const button = await screen.findByRole('button', { name: '刷新' })
    expect(button).toBeDisabled()
    // 17:00:30 UTC in Asia/Shanghai.
    expect(button).toHaveAccessibleDescription('01:00:30 后可再次刷新')
  })

  it('fetches with refresh=1 and announces whether the Worker refreshed', async () => {
    freezeClock()
    const overview = healthyOverview()
    let refreshed = true
    const calls = installFetch((call) =>
      json(
        call.path.endsWith('?refresh=1')
          ? {
              ...overview,
              generated_at: NOW.toISOString(),
              refresh: { ...overview.refresh, refreshed, next_refresh_at: NOW.toISOString() },
            }
          : overview,
      ),
    )
    renderApp()
    const user = userEvent.setup()
    const button = await screen.findByRole('button', { name: '刷新' })
    expect(button).toBeEnabled()
    expect(button).toHaveAccessibleDescription('数据生成于 9月30日 00:30')

    await user.click(button)
    await waitFor(() => expect(screen.getByText('已刷新。')).toBeInTheDocument())
    expect(screen.getByText('已刷新。')).toHaveAttribute('role', 'status')
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/overview', '/api/v1/overview?refresh=1'])
    expect(await screen.findByRole('button', { name: '刷新' })).toHaveAccessibleDescription('数据生成于 9月30日 01:00')

    refreshed = false
    await user.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(screen.getByText('距上次刷新不足 1 分钟，显示的是缓存数据。')).toBeInTheDocument())
  })

  it('re-reads the overview every 5 minutes while the page is visible', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    const calls = installFetch(() => json(healthyOverview()))
    renderApp()
    await screen.findByRole('button', { name: '刷新' })
    expect(calls).toHaveLength(1)

    await act(() => vi.advanceTimersByTimeAsync(OVERVIEW_INTERVAL_MS - 1_000))
    expect(calls).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls.every((call) => call.path === '/api/v1/overview')).toBe(true)
  })

  it('keeps showing the last data when a background update fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    let fail = false
    installFetch(() => {
      if (fail) throw new TypeError('redirect')
      return json(healthyOverview())
    })
    renderApp()
    await screen.findByRole('button', { name: '刷新' })
    fail = true
    await act(() => vi.advanceTimersByTimeAsync(OVERVIEW_INTERVAL_MS + 1_000))
    const alert = (await screen.findByText(/自动更新失败/)).closest('[role="alert"]')
    expect(alert).toHaveTextContent('自动更新失败：无法连接运维面板，或登录已过期，请刷新页面。下面显示的是')
    expect(screen.getByRole('region', { name: /总体状态/ })).toBeInTheDocument()
  })
})
