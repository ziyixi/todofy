import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WebsiteSyncStatus } from '../../../worker/src/api-types.ts'
import { freezeClock, json, renderApp, serve } from '../test/harness'
import { healthy, NOW } from '../test/fixtures'

const RUN_URL = 'https://github.com/example/cloud/actions/runs/12001'
const DETAILS: WebsiteSyncStatus = {
  observed_at: NOW.toISOString(), next_check_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
  last_check: { checked_at: NOW.toISOString(), decision: 'unchanged', run_id: '12001', run_url: RUN_URL },
  last_publish: { verified_at: new Date(NOW.getTime() - 86_400_000).toISOString(), worker_version_id: '47ba3ae6-017c-40ca-aab4-0e3cc58b722c', code_sha: 'a'.repeat(40), run_id: '12000', run_url: 'https://github.com/example/cloud/actions/runs/12000' },
}
const region = () => screen.getByRole('region', { name: '网站同步' })

describe('website content checks and owner request', () => {
  it('shows separate check and verified publication clocks and never calls a no-op a new publication', async () => {
    freezeClock()
    const scenario = healthy()
    scenario.home = { ...scenario.home, website_sync: DETAILS }
    serve(scenario)
    renderApp()
    await screen.findByRole('region', { name: '网站同步' })
    expect(within(region()).getByText(/内容没有变化/)).toBeInTheDocument()
    const checks = region().querySelectorAll('time')
    expect([...checks].map(node => node.dateTime)).toContain(DETAILS.last_check?.checked_at)
    expect([...checks].map(node => node.dateTime)).toContain(DETAILS.last_publish?.verified_at)
    expect(within(region()).getByTitle(DETAILS.last_publish?.worker_version_id ?? '')).toBeInTheDocument()
    expect(within(region()).getByRole('button', { name: '立即同步' })).toBeEnabled()
  })

  it('keeps one UUID when acceptance is uncertain, then allows a new queued action while a run is active', async () => {
    freezeClock()
    const scenario = healthy()
    scenario.home = { ...scenario.home, website_sync: { ...DETAILS, active_run: { run_id: '12001', run_url: RUN_URL, run_attempt: 1, state: 'checking', started_at: NOW.toISOString() } } }
    let requests = 0
    const calls = serve(scenario, call => {
      const input = JSON.parse(call.body ?? '{}') as { request_id: string }
      requests += 1
      return json({ request: { request_id: input.request_id, state: requests === 1 ? 'unconfirmed' : 'accepted', ...(requests === 1 ? { error_code: 'dispatch_unconfirmed' } : { run_id: '12001', run_url: RUN_URL }) } })
    })
    renderApp()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '立即同步' }))
    await user.click(await screen.findByRole('button', { name: '核对本次请求' }))
    expect(await screen.findByText(/请求已加入发布队列，尚未完成/)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '立即同步' }))
    await screen.findByText(/请求已加入发布队列，尚未完成/)
    const ids = calls.filter(call => call.path === '/api/v1/websiteSync:request').map(call => (JSON.parse(call.body ?? '{}') as { request_id: string }).request_id)
    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('shows stale checks and failed runs with actionable links', async () => {
    freezeClock()
    const scenario = healthy()
    scenario.home = { ...scenario.home, website_sync: { ...DETAILS, last_check: { checked_at: new Date(NOW.getTime() - 27 * 3_600_000).toISOString(), decision: 'unchanged', run_id: '12001', run_url: RUN_URL }, latest_attempt: { run_id: '12001', run_url: RUN_URL, run_attempt: 1, state: 'failed', started_at: NOW.toISOString(), error_code: 'sync_build_failed' } } }
    serve(scenario)
    renderApp()
    await screen.findByRole('region', { name: '网站同步' })
    expect(within(region()).getByText(/超过 26 小时没有完成内容检查/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '个人网站 状态：正常，查看详情' })).toBeInTheDocument()
    expect(within(region()).getByText(/网站构建失败。请打开本次 Actions，修复构建错误后立即同步/)).toBeInTheDocument()
    expect(within(region()).getAllByRole('link', { name: '查看本次 Actions' }).some(link => link.getAttribute('href') === RUN_URL)).toBe(true)
    expect(within(region()).getByRole('button', { name: '立即同步' })).toBeEnabled()
  })

  it('does not claim older evidence exists when provider observation has no check or publication', async () => {
    freezeClock()
    const scenario = healthy()
    scenario.home = { ...scenario.home, website_sync: { observed_at: NOW.toISOString(), next_check_at: DETAILS.next_check_at, error_code: 'github_permission_denied' } }
    serve(scenario)
    renderApp()
    await screen.findByRole('region', { name: '网站同步' })
    expect(within(region()).getByText(/GitHub 权限不足/)).toBeInTheDocument()
    expect(within(region()).queryByText(/保留上次/)).not.toBeInTheDocument()
    expect(within(region()).getByText('无完整检查记录')).toBeInTheDocument()
  })
})
