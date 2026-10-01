import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiError, freezeClock, installFetch, json, renderApp, serve } from '../test/harness'
import { analyticsUnavailable, healthy, observedOnly, oneWarning, shell, todofyUnreachable, withLinkOnly, type Scenario } from '../test/fixtures'

async function showHome(scenario: Scenario) {
  freezeClock()
  const calls = serve(scenario)
  renderApp()
  await screen.findByRole('region', { name: '业务流程' })
  return calls
}

const launcher = () => screen.getByRole('region', { name: '入口' })

describe('首页', () => {
  it('shows the tiles grouped by kind, in registry order, as real links to new tabs', async () => {
    await showHome(healthy())
    const apps = within(launcher()).getByRole('region', { name: '应用' })
    const links = within(apps).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      '打开 Mail Hero（新标签页），mail-hero.ziyixi.science',
      '打开 Todofy（新标签页），todofy.ziyixi.science',
      '打开 论文雷达（新标签页），lab.ziyixi.science',
    ])
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer noopener')
      expect(link.getAttribute('href')).toMatch(/^https:\/\/[a-z-]+\.ziyixi\.science\/$/)
    }
    // Access-protected entries carry the lock with its own name; never an emoji.
    expect(within(apps).getAllByRole('img', { name: '受 Access 保护' })).toHaveLength(3)

    // Status lines are separate buttons (never inside the link).
    const mail = within(apps).getByRole('button', { name: 'Mail Hero 状态：正常，查看详情' })
    expect(mail).toHaveTextContent('正常· 今日收件 37')
    expect(within(apps).getByRole('button', { name: 'Todofy 状态：正常，查看详情' })).toHaveTextContent('24 小时 41 封')
    // Lab's tile has its own status button (its ops-v1 status is not in these fixtures: 未知).
    expect(within(apps).getAllByRole('button')).toHaveLength(3)
    expect(within(apps).queryByText(/Flowday/)).toBeNull()

    const sites = within(launcher()).getByRole('region', { name: '站点' })
    expect(within(sites).getByRole('link', { name: '打开 个人网站（新标签页），www.ziyixi.science' })).toHaveAttribute('href', 'https://www.ziyixi.science/')
    expect(within(sites).getByRole('button', { name: '个人网站 状态：正常，查看详情' })).toHaveTextContent('响应 180 ms')

    const services = within(launcher()).getByRole('region', { name: '后台服务' })
    expect(within(services).getByRole('link', { name: 'Notion 发布：正常，今天 00 时有请求，查看 Cloudflare 中的 Worker' })).toHaveAttribute(
      'href',
      '#/cloudflare/worker/ziyixi-notion-publish',
    )
    const newsletter = within(services).getByRole('link', { name: 'Newsletter：未接入监控，查看业务流程' })
    expect(newsletter).toHaveAttribute('href', '#/flows/daily-newsletter')
    expect(newsletter).toHaveTextContent('未接入监控')

    // The dashboard itself has no tile.
    expect(within(launcher()).queryByText('个人控制台')).toBeNull()
  })

  it('shows a link-only tile as its host: no status button, no fake green', async () => {
    await showHome(withLinkOnly())
    const apps = within(launcher()).getByRole('region', { name: '应用' })
    const link = within(apps).getByRole('link', { name: '打开 Link Demo（新标签页），link-demo.ziyixi.science，未接入监控（仅链接）' })
    expect(link).toHaveAttribute('href', 'https://link-demo.ziyixi.science/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(apps).getAllByRole('img', { name: '受 Access 保护' })).toHaveLength(4)
    expect(within(apps).queryByRole('button', { name: /Link Demo/ })).toBeNull()
  })

  it('shows one quiet line when everything is fine', async () => {
    await showHome(healthy())
    const strip = screen.getByRole('region', { name: /^全部正常 ?· 下次巡检 01:30$/ })
    expect(within(strip).queryByRole('list')).toBeNull()
  })

  it('lists one line per flow and four mini bars', async () => {
    await showHome(healthy())
    const flows = screen.getByRole('region', { name: '业务流程' })
    const rows = within(flows).getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('#/flows/'))
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      '邮件 → 任务：正常，端到端成功 今天 00:06，已监测 5/6',
      '网站发布：正常，最近有请求 今天 00 时，已监测 2/3',
      '每日 Newsletter：部分接入，部分阶段尚未接入，已监测 1/3',
      '运维摘要：正常，上次摘要 昨天 23:00 · Todofy 已接收',
    ])
    expect(within(flows).getByRole('link', { name: '全部流程 →' })).toHaveAttribute('href', '#/flows')

    const cf = screen.getByRole('region', { name: 'Cloudflare 今日' })
    const meters = within(cf).getAllByRole('meter')
    expect(meters.map((meter) => meter.getAttribute('aria-valuetext'))).toEqual([
      '已用 712 次，上限 100,000 次，0.7%',
      '已用 7,142 行，上限 5,000,000 行，0.1%',
      '已用 300 neurons，上限 10,000 neurons，3%，剩余 9,700 neurons',
      '已用 837 MB，上限 10 GB，8.4%',
    ])
    expect(within(cf).getByText('712 / 10 万 ·')).toBeInTheDocument()
    expect(within(cf).getByText('837 MB / 10 GB ·')).toBeInTheDocument()
    // Workers AI states the neurons left today (on phones in place of the percent, which the bar shows).
    const ai = within(cf).getByRole('meter', { name: 'Workers AI neurons' }).closest('li') as HTMLElement
    expect(within(ai).getByText('剩余 9,700')).toHaveClass('mini-quota-remaining')
    expect(within(ai).getByText('300 / 1 万 ·')).toHaveClass('mini-quota-amount')
    expect(within(ai).getByText('3% ·')).toHaveClass('mini-quota-amount')
    expect(within(ai).getByText('AI neurons')).toHaveClass('name-short')
    // DO requests left the home bars for Workers AI; it stays on the Cloudflare view.
    expect(within(cf).queryByRole('meter', { name: 'Durable Objects 请求' })).toBeNull()
    expect(within(cf).getByRole('link', { name: /5 个 Worker · 今日错误 3/ })).toHaveTextContent('未降载')
  })

  it('shows one warning on its tile, its flow and the strip', async () => {
    await showHome(oneWarning())
    const strip = screen.getByRole('region', { name: '1 项需关注' })
    const item = within(strip).getByRole('listitem')
    expect(item).toHaveTextContent('邮件 → 任务 › Todofy 摘要：Gemini 预算超过 80%（82%） · 开始于 昨天 11:20')
    expect(within(item).getByRole('link')).toHaveAttribute('href', '#/flows/mail-to-task/consume')

    const todofy = within(launcher()).getByRole('button', { name: 'Todofy 状态：需关注，查看详情' })
    expect(todofy).toHaveTextContent('需关注· 24 小时 41 封')
    expect(within(launcher()).getByRole('button', { name: 'Mail Hero 状态：正常，查看详情' })).toBeInTheDocument()

    const flows = screen.getByRole('region', { name: '业务流程' })
    expect(
      within(flows).getByRole('link', { name: '邮件 → 任务：需关注，Todofy 摘要：Gemini 预算超过 80%，端到端成功 今天 00:06' }),
    ).toBeInTheDocument()
  })

  it('opens a tile\'s detail sheet from its status line and returns focus', async () => {
    await showHome(oneWarning())
    const user = userEvent.setup()
    const button = within(launcher()).getByRole('button', { name: 'Todofy 状态：需关注，查看详情' })
    await user.click(button)
    const sheet = screen.getByRole('dialog', { name: 'Todofy 状态' })
    expect(within(sheet).getByText('原因').nextElementSibling).toHaveTextContent('Gemini 预算超过 80%')
    const signals = within(sheet).getByRole('list', { name: '主要信号' })
    expect(within(signals).getByText('gemini_budget_80')).toBeInTheDocument()
    const links = within(within(sheet).getByRole('list', { name: '相关位置' })).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['查看流程：邮件 → 任务 →', '#/flows/mail-to-task'],
      ['查看流程：GTD 循环 →', '#/flows/gtd'],
      ['查看流程：每日 Newsletter →', '#/flows/daily-newsletter'],
      ['查看流程：运维摘要 →', '#/flows/ops-digest'],
      ['查看 Worker：todofy →', '#/cloudflare/worker/todofy'],
      ['查看 Worker：todofy-core →', '#/cloudflare/worker/todofy-core'],
      ['应用详情 →', '#/ops'],
      ['打开 Todofy（新标签页）', 'https://todofy.ziyixi.science/'],
    ])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
  })

  it('greys only the unreachable app and says why', async () => {
    await showHome(todofyUnreachable())
    const todofy = within(launcher()).getByRole('button', { name: 'Todofy 状态：无法连接，查看详情' })
    expect(todofy).toHaveTextContent('无法连接· 连续 2 次')
    expect(within(launcher()).getByRole('button', { name: 'Mail Hero 状态：正常，查看详情' })).toBeInTheDocument()
    const strip = screen.getByRole('region', { name: '1 项故障' })
    expect(within(strip).getByRole('listitem')).toHaveTextContent('Todofy：应用无法连接')
    expect(within(strip).getByRole('link')).toHaveAttribute('href', '#/ops')
  })

  it('never says 全部正常 while a tile is 未知 or 需关注: observed items lead, unknown first, with badges', async () => {
    await showHome(observedOnly())
    expect(screen.queryByText('全部正常')).toBeNull()
    const strip = screen.getByRole('region', { name: '1 项未知 · 1 项需关注' })
    const items = within(strip).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['Todofy：无法连接查看：Todofy：无法连接 →', '个人网站：HTTP 状态异常查看：个人网站：HTTP 状态异常 →'])
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '#/')
    expect(screen.getByRole('link', { name: '首页，2 项需关注' })).toBeInTheDocument()
  })

  it('says so when the scheduled checks stopped (C3)', async () => {
    const base = healthy()
    const lastTick = '2026-09-29T14:00:00.000Z'
    const item = {
      source: 'dashboard',
      code: 'tick_stale',
      severity: 'warning' as const,
      since: lastTick,
      metrics: { minutes_since: 180 },
      target: { view: 'flows' as const, flow: 'ops-digest', stage: 'collect' },
    }
    const home = {
      ...base.home,
      attention: { level: 'warning' as const, items: [item], info: [], held: [] },
      badges: { ...base.home.badges, flows: 1 },
      refresh: { ...base.home.refresh, last_tick_at: lastTick },
    }
    await showHome({ ...base, home })
    const strip = screen.getByRole('region', { name: '1 项需关注' })
    expect(within(strip).getByText(/定时检查已/, { selector: '.strip-note' })).toHaveTextContent('定时检查已 3 小时 未运行：自动降载、金丝雀和运维摘要都已停止，页面数据可能过时。')
    expect(within(strip).getByRole('listitem')).toHaveTextContent('运维摘要 › 巡检：定时检查已停止')
  })

  it('shows the first-tick state before any data exists, never 全部正常 (C3)', async () => {
    const base = healthy()
    const fresh = shell({ attention: { level: 'unknown', items: [], info: [], held: [] }, refresh: { ...base.home.refresh, last_tick_at: null } })
    await showHome({ ...base, home: { ...base.home, ...fresh } })
    expect(screen.getByRole('region', { name: /^尚未完成巡检 ?· 下次巡检 01:30$/ })).toBeInTheDocument()
    expect(screen.queryByText('全部正常')).toBeNull()
  })

  it('says so when Cloudflare usage is unavailable instead of inventing bars', async () => {
    await showHome(analyticsUnavailable())
    const cf = screen.getByRole('region', { name: 'Cloudflare 今日' })
    expect(within(cf).queryAllByRole('meter')).toHaveLength(0)
    expect(within(cf).getByText('用量无法获取')).toBeInTheDocument()
    expect(within(cf).getByText('还没有用量数据。')).toBeInTheDocument()
    // No GraphQL answer yet: no made-up "0 个 Worker · 今日错误 0".
    expect(within(cf).getByRole('link', { name: /Worker 暂无数据/ })).toBeInTheDocument()
    expect(within(cf).queryByText(/0 个 Worker/)).not.toBeInTheDocument()
  })

  it('keeps the tiles as links while loading, with same-size skeletons', async () => {
    freezeClock()
    const scenario = healthy()
    installFetch((call) => (call.path === '/api/v2/registry' ? json(scenario.registry) : new Promise<Response>(() => undefined)))
    renderApp()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })
    expect(launcher()).toHaveAttribute('aria-busy', 'true')
    expect(within(launcher()).getByRole('status')).toHaveTextContent('正在加载')
    expect(within(launcher()).queryAllByRole('button')).toHaveLength(0)
  })

  it('marks every status unknown when the view fails, keeping the links', async () => {
    freezeClock()
    const scenario = healthy()
    installFetch((call) => (call.path === '/api/v2/registry' ? json(scenario.registry) : apiError(503, 'unavailable', '服务暂时不可用')))
    renderApp()
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载首页数据：服务暂时不可用')
    const mail = await within(launcher()).findByRole('button', { name: 'Mail Hero 状态：未知，查看详情' })
    expect(mail).toHaveTextContent('无法获取这一项的数据')
    expect(within(launcher()).getByRole('link', { name: /打开 Mail Hero/ })).toBeInTheDocument()
  })
})
