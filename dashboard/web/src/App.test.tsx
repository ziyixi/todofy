import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OverviewResponse } from '../../worker/src/api-types.ts'
import {
  analyticsUnavailableOverview,
  canaryFailedOverview,
  degradedOverview,
  guardActiveOverview,
  healthyOverview,
  unreachableOverview,
} from './test/fixtures'
import { apiError, freezeClock, installFetch, json, renderApp } from './test/harness'

function serve(overview: OverviewResponse) {
  return installFetch((call) => {
    if (call.path.startsWith('/api/v1/overview')) return json(overview)
    return apiError(404, 'not_found')
  })
}

async function showOverview(overview: OverviewResponse) {
  freezeClock()
  const calls = serve(overview)
  renderApp()
  await screen.findByRole('region', { name: /总体状态/ })
  return calls
}

function card(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

describe('overview page', () => {
  it('renders a healthy overview in the browser time zone', async () => {
    const calls = await showOverview(healthyOverview())

    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/overview' })
    expect(calls[0]?.init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' })

    const banner = screen.getByRole('region', { name: /总体状态/ })
    expect(within(banner).getByText('正常')).toBeInTheDocument()
    expect(within(banner).queryByRole('list', { name: '当前问题' })).not.toBeInTheDocument()
    // 16:30:04 UTC is 00:30 on the next day in Asia/Shanghai.
    expect(within(banner).getByText(/9月30日 00:30/)).toBeInTheDocument()
    expect(screen.getByText('时间按浏览器时区（Asia/Shanghai）显示')).toBeInTheDocument()

    for (const [name, host] of [
      ['Mail Hero', 'https://mail.example.com/'],
      ['Todofy', 'https://todofy.example.com/'],
    ] as const) {
      const region = card(name)
      expect(within(region).getAllByText('正常')[0]).toBeInTheDocument()
      const link = within(region).getByRole('link', { name: new RegExp(`打开 ${name}`) })
      expect(link).toHaveAttribute('href', host)
      expect(link).toHaveAttribute('rel', 'noreferrer noopener')
      expect(within(region).getByText('没有活动信号。')).toBeInTheDocument()
    }
    // Key counters on the card; every counter again behind "全部计数".
    const counters = card('Mail Hero').querySelector('dl.counters') as HTMLElement
    expect(within(counters).getByText('今日收件').nextElementSibling).toHaveTextContent('41')
    expect(within(counters).getByText('已用容量').nextElementSibling).toHaveTextContent('1.2 GiB')
    expect(within(card('Mail Hero')).getByText('全部计数（15）')).toBeInTheDocument()
    expect(within(card('Todofy')).getAllByText('24 小时收到')[0]).toBeInTheDocument()

    const quota = card('Cloudflare 用量（Workers Free）')
    expect(within(quota).getByText('最新')).toBeInTheDocument()
    expect(within(quota).getByText(/整个 Cloudflare 账户的用量/)).toBeInTheDocument()
    expect(within(quota).getByRole('heading', { name: /每日/ })).toBeInTheDocument()
    expect(within(quota).getByRole('heading', { name: /每月/ })).toBeInTheDocument()
    expect(within(quota).getByRole('heading', { name: /存储/ })).toBeInTheDocument()
    const workers = within(quota).getByRole('meter', { name: 'Workers 请求' })
    expect(workers).toHaveAttribute('aria-valuenow', '12.3')
    expect(workers).toHaveAttribute('aria-valuetext', '已用 12,345 次，上限 100,000 次，12.3%')
    expect(within(quota).getByText(/按当前速度线性估算，本 UTC 日结束约 17,428 次（17.4%）/)).toBeInTheDocument()
    expect(within(quota).getByText(/只是把已用量按已过时间等比放大，不是预测/)).toBeInTheDocument()
    const doStorage = within(quota).getByRole('meter', { name: 'Durable Objects SQLite 存储' })
    expect(doStorage).not.toHaveAttribute('aria-valuenow')
    expect(doStorage).toHaveAttribute('aria-valuetext', '无数据')
    expect(within(quota).getAllByRole('meter')).toHaveLength(13)

    const canary = card('投递与处理金丝雀')
    expect(within(canary).getAllByText('成功').length).toBeGreaterThan(0)
    const steps = within(within(canary).getByRole('list', { name: '运行阶段' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringMatching(/^创建完成 · 00:00/),
      expect.stringMatching(/^已排队完成 · 00:00（\+1 秒）/),
      expect.stringMatching(/^已投递完成 · 00:00（\+4 秒）尝试 1 次，最后 HTTP 204/),
      expect.stringMatching(/^Todofy 完成完成 · 00:00（\+26 秒）/),
      expect.stringMatching(/^结束完成 · 00:30（\+30 分钟）/),
    ])
    const history = within(canary).getByRole('table')
    expect(within(history).getAllByRole('row')).toHaveLength(4)
    expect(within(history).getByText('已跳过')).toBeInTheDocument()
    expect(within(history).getByText('启动阶段：投递已强制暂停')).toBeInTheDocument()

    const digest = card('运维摘要')
    expect(within(digest).getByText('当前没有需要汇报的项目。')).toBeInTheDocument()
    expect(within(digest).getByText('已保存，0 项')).toBeInTheDocument()
  })

  it('shows degraded apps with plain-text signal labels', async () => {
    await showOverview(degradedOverview())

    const banner = screen.getByRole('region', { name: /总体状态/ })
    expect(within(banner).getByText('严重')).toBeInTheDocument()
    const issues = within(banner).getByRole('list', { name: '当前问题' })
    // Each chip names its app and links to the card that explains it.
    const blocked = within(issues).getByRole('link', { name: 'Mail Hero：投递目标已阻断' })
    expect(blocked).toHaveAttribute('href', '#app-mail-hero')
    expect(within(issues).getByRole('link', { name: 'Todofy：备份过旧' })).toHaveAttribute('href', '#app-todofy')
    expect(within(issues).getByRole('link', { name: 'Mail Hero：存储容量超过 70%' })).toBeInTheDocument()

    const mail = card('Mail Hero')
    expect(within(mail).getByText('降级')).toBeInTheDocument()
    const signal = within(mail).getByText('投递目标已阻断').closest('li') as HTMLElement
    expect(within(signal).getByText('严重')).toBeInTheDocument()
    expect(within(signal).getByText('endpoint_blocked')).toBeInTheDocument()
    expect(within(signal).getByText('waiting_deliveries')).toBeInTheDocument()
    expect(within(mail).getByText('存储容量超过 70%')).toBeInTheDocument()

    const todofy = card('Todofy')
    expect(within(todofy).getByText('降级')).toBeInTheDocument()
    expect(within(todofy).getByText('备份过旧')).toBeInTheDocument()
    expect(within(todofy).getByText('有需要处理的事件')).toBeInTheDocument()

    const digest = card('运维摘要')
    expect(within(digest).getByRole('list', { name: '摘要项目' }).querySelectorAll(':scope > li')).toHaveLength(3)
  })

  it('shows an unreachable app with its last good status', async () => {
    await showOverview(unreachableOverview())

    const todofy = card('Todofy')
    expect(within(todofy).getByText('无法连接')).toBeInTheDocument()
    expect(within(todofy).getByText(/最近一次 status\(\) 调用失败：超时（连续 3 次）/)).toBeInTheDocument()
    expect(within(todofy).getByText(/下方是 9月29日 23:30 的最后一次成功状态/)).toBeInTheDocument()
    expect(within(card('Mail Hero')).getAllByText('正常')[0]).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: '当前问题' })).getByText('Todofy：应用无法连接')).toBeInTheDocument()
  })

  it('shows an active guard, its reason and per-app results', async () => {
    await showOverview(guardActiveOverview())

    const actions = card('降载与操作')
    // The overall pill plus Mail Hero's row; Todofy's row carries its failed call.
    expect(within(actions).getAllByText('降载中')).toHaveLength(2)
    expect(within(actions).getByText('原因：配额：D1 读取行数')).toBeInTheDocument()
    expect(within(actions).getByText('自动（按配额）')).toBeInTheDocument()
    expect(within(actions).getByText('降载中（上次下发失败：超时）')).toBeInTheDocument()

    const mail = card('Mail Hero')
    expect(within(mail).getByText('推迟的任务：原件对账、保留期清理、金丝雀清理、告警历史清理')).toBeInTheDocument()
    expect(within(card('Todofy')).getByText(/上次下发降载设置失败：超时/)).toBeInTheDocument()

    const quota = card('Cloudflare 用量（Workers Free）')
    const meter = within(quota).getByRole('meter', { name: 'D1 读取行数' })
    expect(meter).toHaveAttribute('aria-valuenow', '84')
    const item = meter.closest('li') as HTMLElement
    expect(within(item).getByText('超过 80%')).toBeInTheDocument()
    expect(within(item).getByText(/按此速度将超出上限/)).toBeInTheDocument()
    expect(within(item).getByText(/查询结果已达行数上限/)).toBeInTheDocument()
  })

  it('shows a failed canary with the stage that stopped it', async () => {
    await showOverview(canaryFailedOverview())

    const canary = card('投递与处理金丝雀')
    const today = within(canary).getByRole('list', { name: '运行阶段' }).parentElement as HTMLElement
    expect(within(today).getAllByText('失败')[0]).toBeInTheDocument()
    expect(within(today).getByText('投递阶段：HTTP 503')).toBeInTheDocument()
    const steps = within(within(today).getByRole('list', { name: '运行阶段' })).getAllByRole('listitem')
    expect(steps[2]?.textContent).toBe('已投递失败尝试 4 次，最后 HTTP 503')
    expect(steps[3]?.textContent).toBe('Todofy 完成未开始')
    expect(steps[4]?.textContent).toMatch(/^结束完成/)
    expect(within(canary).getByText('1 / 3 次')).toBeInTheDocument()
  })

  it('explains unavailable analytics without inventing numbers', async () => {
    await showOverview(analyticsUnavailableOverview())

    const quota = card('Cloudflare 用量（Workers Free）')
    expect(within(quota).getByText('无法获取')).toBeInTheDocument()
    expect(within(quota).getByText(/获取用量失败：HTTP 401：令牌无效或权限不足（连续 5 次）/)).toBeInTheDocument()
    expect(within(quota).getByText('还没有成功获取过用量数据。')).toBeInTheDocument()
    expect(within(quota).getByText(/没有最新用量时不会自动进入降载。/)).toBeInTheDocument()
    expect(within(quota).queryAllByRole('meter')).toHaveLength(0)
    expect(within(screen.getByRole('list', { name: '当前问题' })).getByRole('link', { name: '运维面板：用量数据获取失败' })).toHaveAttribute('href', '#quota')
  })

  it('shows unknown codes as they are and never links a non-https URL', async () => {
    const overview = healthyOverview()
    const mail = overview.apps['mail-hero']
    const status = mail.status
    if (!status) throw new Error('fixture')
    await showOverview({
      ...overview,
      overall: { level: 'warning', items: [{ source: 'mail-hero', code: 'brand_new_code', severity: 'warning' }] },
      apps: {
        ...overview.apps,
        'mail-hero': {
          ...mail,
          url: 'javascript:alert(1)',
          status: { ...status, signals: [{ code: 'brand_new_signal', severity: 'warning', metrics: { n: 2 } }] },
        },
      },
    })

    expect(within(screen.getByRole('list', { name: '当前问题' })).getByText('Mail Hero：brand_new_code')).toBeInTheDocument()
    expect(within(card('Mail Hero')).getByText('brand_new_signal')).toBeInTheDocument()
    expect(within(card('Mail Hero')).queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps the same code from both apps apart', async () => {
    const overview = unreachableOverview()
    await showOverview({
      ...overview,
      overall: {
        level: 'critical',
        items: [
          { source: 'mail-hero', code: 'app_unreachable', severity: 'critical' },
          { source: 'todofy', code: 'app_unreachable', severity: 'critical' },
        ],
      },
    })
    const issues = within(screen.getByRole('list', { name: '当前问题' }))
    expect(issues.getAllByRole('listitem')).toHaveLength(2)
    expect(issues.getByRole('link', { name: 'Mail Hero：应用无法连接' })).toHaveAttribute('href', '#app-mail-hero')
    expect(issues.getByRole('link', { name: 'Todofy：应用无法连接' })).toHaveAttribute('href', '#app-todofy')
  })

  it('says so when the scheduled checks stopped', async () => {
    const overview = healthyOverview()
    await showOverview({
      ...overview,
      overall: { level: 'warning', items: [{ source: 'dashboard', code: 'tick_stale', severity: 'warning' }] },
      // The fixed clock is 17:00 UTC: three hours without a tick.
      refresh: { ...overview.refresh, last_tick_at: '2026-09-29T14:00:00.000Z' },
    })
    const banner = screen.getByRole('region', { name: /总体状态/ })
    expect(within(banner).getByText('需要关注')).toBeInTheDocument()
    expect(within(banner).queryByText(/都没有需要处理的问题/)).not.toBeInTheDocument()
    expect(within(banner).getByText('定时检查已 3 小时 未运行：自动降载、金丝雀和运维摘要都已停止，下方数据可能过时。')).toBeInTheDocument()
    expect(within(banner).getByRole('link', { name: '运维面板：定时检查已停止' })).toBeInTheDocument()
  })

  it('names the canary scope and the UTC day it counts by', async () => {
    await showOverview(healthyOverview())
    const canary = card('投递与处理金丝雀')
    expect(within(canary).getByText(/不覆盖：来源邮箱转发、Email Routing 收件、原件保存与 MIME 解析/)).toBeInTheDocument()
    // 17:00 UTC on 9-29 is already 9-30 in Asia/Shanghai: the page says which day it means.
    expect(within(canary).getByText(/每天 16:00 UTC（本地 00:00）之后/)).toBeInTheDocument()
    expect(within(canary).getByRole('heading', { name: '本 UTC 日（2026-09-29）' })).toBeInTheDocument()
    expect(within(canary).getByText('本 UTC 日（2026-09-29）手动运行')).toBeInTheDocument()
  })

  it('does not claim the quota is normal when there is no usage data', async () => {
    const overview = analyticsUnavailableOverview()
    await showOverview({ ...overview, guard: { ...overview.guard, desired: { level: 'normal', reason: 'usage_unknown', until: null, source: 'auto' } } })
    const actions = card('降载与操作')
    expect(within(actions).getByText('原因：无最新用量，不会自动降载')).toBeInTheDocument()
    expect(within(actions).queryByText(/配额正常/)).not.toBeInTheDocument()
  })

  it('shows the first-tick state before any data exists', async () => {
    const overview = healthyOverview()
    await showOverview({
      ...overview,
      overall: { level: 'unknown', items: [] },
      refresh: { ...overview.refresh, last_tick_at: null },
    })
    const banner = screen.getByRole('region', { name: /总体状态/ })
    expect(within(banner).getByText('暂无数据')).toBeInTheDocument()
    expect(within(banner).getByText('尚未完成定时检查')).toBeInTheDocument()
  })

  it('reports a load failure and retries on request', async () => {
    freezeClock()
    let fail = true
    const calls = installFetch(() => (fail ? apiError(503, 'unavailable', '服务暂时不可用', 'aaaaaaaaaaaaaaaa') : json(healthyOverview())))
    renderApp()

    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载运维数据：服务暂时不可用（请求 aaaaaaaaaaaaaaaa）')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('region', { name: /总体状态/ })
    expect(calls).toHaveLength(2)
  })

  it('offers keyboard navigation to every section', async () => {
    await showOverview(healthyOverview())
    const nav = screen.getByRole('navigation', { name: '页面部分' })
    const targets = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    expect(targets).toEqual(['#apps', '#quota', '#canary', '#actions', '#digest'])
    for (const target of targets) expect(document.querySelector(target as string)).not.toBeNull()
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main')
  })
})
