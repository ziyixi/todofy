import { screen, within } from '@testing-library/react'
import { degradedApps, guardShed, healthy, todofyUnreachable, withLinkOnly, type Scenario } from '../test/fixtures'
import { freezeClock, renderApp, serve } from '../test/harness'

async function showOps(scenario: Scenario) {
  freezeClock()
  serve(scenario)
  renderApp('#/ops')
  await screen.findByRole('region', { name: '降载与操作' })
}

const region = (name: string) => screen.getByRole('region', { name })

describe('操作与记录', () => {
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
    expect(within(digest).getByText('已保存，0 项')).toBeInTheDocument()

    const about = region('构建与注册表')
    expect(within(about).getByText('0123456789ab')).toBeInTheDocument()
    expect(within(about).getByText('浏览器本地（Asia/Shanghai）')).toBeInTheDocument()
    const rows = within(within(about).getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Mail Hero',
      'Todofy',
      'FlowDay',
      '短链接',
      '网页监视',
      '服务器监控',
      '邮件分拣',
      '个人网站',
      '网站同步',
      'Newsletter',
      '个人控制台',
      '自托管服务器',
      '平台运行时',
    ])
    expect(rows[1]).toHaveTextContent('ops-v1 状态接口')
    // FlowDay and the links app: a probe of a path their own Worker answers outside Access.
    expect(rows[2]).toHaveTextContent('公开地址探测')
    expect(within(rows[2] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('flowday')
    expect(rows[3]).toHaveTextContent('公开地址探测')
    expect(within(rows[3] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('links')
    // The watch app: its Ops entrypoint, as Mail Hero and Todofy.
    expect(rows[4]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[4] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('watch')
    expect(rows[5]).toHaveTextContent('ops-v1 状态接口')
    // mailsort: its Ops entrypoint (counts and codes of the Gmail sorting).
    expect(rows[6]).toHaveTextContent('ops-v1 状态接口')
    expect(within(rows[6] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('mailsort')
    expect(rows[7]).toHaveTextContent('公开地址探测')
    expect(rows[9]).toHaveTextContent('ops-v1 状态接口')
    // Hidden, with no Worker: it only names the self-hosted servers' backup bucket.
    expect(rows[11]).toHaveTextContent('未接入监控')
    expect(within(rows[11] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('—')
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
