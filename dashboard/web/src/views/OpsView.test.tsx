import { screen, within } from '@testing-library/react'
import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { degradedApps, guardShed, healthy, status, todofyUnreachable, withLinkOnly, type Scenario } from '../test/fixtures'
import { freezeClock, renderApp, serve } from '../test/harness'

async function showOps(scenario: Scenario) {
  freezeClock()
  serve(scenario)
  renderApp('#/ops')
  await screen.findByRole('region', { name: '降载与操作' })
}

const region = (name: string) => screen.getByRole('region', { name })

describe('操作与记录', () => {
  it('shows MCP observations inside the existing app detail and keeps its alert controls', async () => {
    const scenario = healthy()
    const snapshot: OpsStatus = { ...status.mailHeroOk, app: 'personal-mcp', ui_url: null,
      signals: [{ code: 'subscription_rejected', severity: 'warning' as const, metrics: { rpc_code: -32015 } },
        { code: 'delivery_failed', severity: 'warning' as const, metrics: { count: 1 } },
        { code: 'source_unavailable', severity: 'warning' as const, metrics: {} }],
      counters: { active_subscriptions: 0, pending_deliveries: 0, accepted_deliveries: 0, failed_deliveries: 0 }, capabilities: [] }
    scenario.ops = { ...scenario.ops, apps: [...scenario.ops.apps, { entry: 'personal-mcp', reachable: true,
      checked_at: scenario.ops.generated_at, status_at: scenario.ops.generated_at, error: null, consecutive_failures: 0, status: snapshot }] }
    scenario.ops = { ...scenario.ops, attention: { level: 'warning', items: [{ source: 'personal-mcp', code: 'subscription_rejected',
      severity: 'warning', since: null, metrics: { rpc_code: -32015 }, target: { view: 'ops', entry: 'personal-mcp' },
      name: 'attentionItems/synthetic-mcp', etag: 'a1-0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a' }], info: [], held: [] } }
    await showOps(scenario)
    const mcp = within(region('应用详情')).getByRole('region', { name: '个人 MCP' })
    expect(within(mcp).getByText('ChatGPT 连接与订阅')).toBeInTheDocument()
    expect(within(mcp).getByText(/再在 Dots 中重新订阅/)).toBeInTheDocument()
    expect(within(mcp).getByText(/在 ChatGPT 中检查订阅/)).toBeInTheDocument()
    expect(within(mcp).getByText(/查看来源服务的检查状态/)).toBeInTheDocument()
    expect(within(mcp).queryByText(/打开 Mail Hero/)).not.toBeInTheDocument()
    expect(within(mcp).getByRole('button', { name: '关闭本次提醒' })).toBeInTheDocument()
    expect(within(mcp).getByText('当前信号')).toBeInTheDocument()
  })

  it('shows every ops-v1 app in full, the digest and the registry', async () => {
    await showOps(healthy())
    const details = region('应用详情')
    for (const [name, host] of [
      ['Mail Hero', 'https://mail-hero.ziyixi.science/'],
      ['Todofy', 'https://todofy.ziyixi.science/'],
    ] as const) {
      const app = within(details).getByRole('region', { name })
      expect(within(app).getAllByText('正常')[0]).toBeInTheDocument()
      const link = within(app).getByRole('link', { name: `打开 ${name}（新标签页）` })
      expect(link).toHaveAttribute('href', host)
      expect(link).toHaveAttribute('rel', 'noreferrer noopener')
      expect(within(app).getByText('没有活动信号。')).toBeInTheDocument()
    }
    // Every counter now, not a key subset.
    const counters = within(details).getByRole('region', { name: 'Mail Hero' }).querySelector('dl.counters') as HTMLElement
    expect(within(counters).getByText('今日收件').nextElementSibling).toHaveTextContent('41')
    expect(within(counters).getByText('已用容量').nextElementSibling).toHaveTextContent('1.2 GiB')
    expect(counters.querySelectorAll('.counter')).toHaveLength(15)

    const digest = region('运维摘要')
    expect(within(digest).getByText('当前没有需要汇报的项目。')).toBeInTheDocument()
    expect(within(digest).getByText('0 项')).toBeInTheDocument()

    const about = region('构建与注册表')
    expect(within(about).getByText('0123456789ab')).toBeInTheDocument()
    expect(within(about).getByText('浏览器本地（Asia/Shanghai）')).toBeInTheDocument()
    const rows = within(within(about).getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Mail Hero',
      'Todofy',
      '短链接',
      '网页监视',
      '服务器监控',
      '邮件分拣',
      '浏览记录',
      '简报',
      'Tasks',
      '个人网站',
      '网站同步',
      'Newsletter',
      '个人 MCP',
      '个人控制台',
      '自托管服务器',
      '平台运行时',
    ])
    expect(rows[1]).toHaveTextContent('ops-v1 状态接口')
    // The links app: a probe of a path its own Worker answers outside Access.
    expect(rows[2]).toHaveTextContent('公开地址探测')
    expect(within(rows[2] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('links')
    // The watch app: its Ops entrypoint, as Mail Hero and Todofy.
    expect(rows[3]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[3] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('watch')
    expect(rows[4]).toHaveTextContent('ops-v1 状态接口')
    // mailsort: its Ops entrypoint (counts and codes of the Gmail sorting).
    expect(rows[5]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[5] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('mailsort')
    // recall: its Ops entrypoint (counts and codes of the browsing record).
    expect(rows[6]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[6] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('recall')
    // Brief's status and guard are available through its own Ops binding.
    expect(rows[7]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[7] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('brief')
    expect(rows[8]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[8] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('tasks')
    expect(rows[9]).toHaveTextContent('公开地址探测')
    expect(rows[11]).toHaveTextContent('ops-v1 状态接口')
    // Hidden, with no Worker: it only names the self-hosted servers' backup bucket.
    expect(rows[14]).toHaveTextContent('未接入监控')
    expect(within(rows[14] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('—')
    expect(rows[12]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[12] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('personal-mcp')
  })

  it('names a link-only entry of the registry as such', async () => {
    await showOps(withLinkOnly())
    const about = region('构建与注册表')
    const row = within(within(about).getByRole('table')).getByRole('rowheader', { name: 'Link Demo' }).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('仅链接（受 Access 保护，不探测）')
  })

  it('shows degraded apps with plain-text signal labels', async () => {
    await showOps(degradedApps())
    const mail = within(region('应用详情')).getByRole('region', { name: 'Mail Hero' })
    expect(within(mail).getByText('降级')).toBeInTheDocument()
    const signal = within(mail).getByText('投递目标已阻断').closest('li') as HTMLElement
    expect(within(signal).getByText('严重')).toBeInTheDocument()
    expect(within(signal).getByText('endpoint_blocked')).toBeInTheDocument()
    expect(within(signal).getByText('waiting_deliveries')).toBeInTheDocument()
    const todofy = within(region('应用详情')).getByRole('region', { name: 'Todofy' })
    expect(within(todofy).getByText('备份过旧')).toBeInTheDocument()
  })

  it('shows an unreachable app with its last good status', async () => {
    await showOps(todofyUnreachable())
    const todofy = within(region('应用详情')).getByRole('region', { name: 'Todofy' })
    expect(within(todofy).getByText('无法连接')).toBeInTheDocument()
    expect(within(todofy).getByText(/最近一次 status\(\) 调用失败：超时（连续 2 次）/)).toBeInTheDocument()
    expect(within(todofy).getByText(/下方是 9月29日 23:30 的最后一次成功状态/)).toBeInTheDocument()
  })

  it('shows an active guard with its reason, per-app results and deferred jobs', async () => {
    await showOps(guardShed())
    const actions = region('降载与操作')
    expect(within(actions).getAllByText(/实际：非关键工作已延后/)).toHaveLength(2)
    expect(within(actions).getByText('下发失败：超时')).toBeInTheDocument()
    const mail = within(region('应用详情')).getByRole('region', { name: 'Mail Hero' })
    expect(within(mail).getByText('推迟的任务：原件对账、保留期清理、金丝雀清理、告警历史清理')).toBeInTheDocument()
    expect(within(within(region('应用详情')).getByRole('region', { name: 'Todofy' })).getByText(/上次下发降载设置失败：超时/)).toBeInTheDocument()
  })
})
