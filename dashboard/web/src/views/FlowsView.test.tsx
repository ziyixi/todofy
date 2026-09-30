import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CANARY_DISABLED_NOTE } from '../components/Canary'
import { canaryDisabled, canaryFailed, healthy, oneWarning, todofyUnreachable, type Scenario } from '../test/fixtures'
import { freezeClock, renderApp, serve } from '../test/harness'

async function showFlows(scenario: Scenario, hash = '#/flows') {
  freezeClock()
  serve(scenario)
  renderApp(hash)
  await screen.findByRole('heading', { level: 1, name: '业务流程' })
  return userEvent.setup()
}

const card = (name: string) => screen.getByRole('article', { name })

describe('业务流程', () => {
  it('groups the flows by business, each a chain of stages', async () => {
    await showFlows(healthy())
    const groups = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(groups).toEqual(expect.arrayContaining(['邮件与任务', '内容与发布', '平台']))

    // All fine: every card starts collapsed with its compact chain and freshness.
    const site = card('网站发布')
    expect(within(site).getByRole('button', { name: '展开 网站发布' })).toHaveAttribute('aria-expanded', 'false')
    const pills = within(within(site).getByRole('list', { name: '阶段' })).getAllByRole('listitem')
    expect(pills.map((pill) => pill.textContent)).toEqual(['Notion：未接入', '→发布：正常', '→网站可用：正常'])
    expect(within(site).getByText('已监测 2/3')).toBeInTheDocument()
    expect(within(site).getByText('最近有请求 今天 00 时')).toBeInTheDocument()

    // Fewer than half the stages seen: never a green dot.
    const newsletter = card('每日 Newsletter')
    expect(within(newsletter).getByText('部分接入')).toBeInTheDocument()
    expect(within(newsletter).queryByText('正常', { selector: '.level-badge .level-word' })).toBeNull()
    expect(within(newsletter).getByText('无法判断新鲜度：部分阶段尚未接入')).toBeInTheDocument()

    expect(within(card('运维摘要')).getByText('上次摘要 昨天 23:00 · Todofy 已接收')).toBeInTheDocument()
  })

  it('opens the flow with a problem on its failing stage', async () => {
    await showFlows(oneWarning())
    const mail = card('邮件 → 任务')
    expect(within(mail).getByRole('button', { name: '收起 邮件 → 任务' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(mail).getByText('需关注', { selector: '.level-badge .level-word' })).toBeInTheDocument()
    expect(within(mail).getByText('最后一次端到端成功：今天 00:06（金丝雀） · 近 14 次运行 13 次成功')).toBeInTheDocument()

    const nodes = within(within(mail).getByRole('list', { name: '阶段' })).getAllByRole('button')
    expect(nodes.map((node) => node.getAttribute('aria-label'))).toEqual([
      '阶段 1 来源转发：未接入，—',
      '阶段 2 收件与保存：正常，今日 37 封',
      '阶段 3 解析：正常，待处理任务 0',
      '阶段 4 Webhook 投递：正常，投递失败 0，金丝雀已验证',
      '阶段 5 Todofy 摘要：需关注，24 小时 41 封，金丝雀已验证',
      '阶段 6 Todoist 与提醒：正常，需处理事件 0',
    ])
    expect(nodes[4]).toHaveAttribute('aria-pressed', 'true')

    const detail = within(mail).getByRole('region', { name: /^Todofy 摘要/ })
    expect(within(detail).getByText('Gemini 预算超过 80%')).toBeInTheDocument()
    expect(within(detail).getByText('gemini_budget_80')).toBeInTheDocument()
    expect(within(detail).getByText(/24 小时 41 封 · Gemini 调用 43 · 处理中事件 0/)).toBeInTheDocument()
    expect(within(detail).getByRole('link', { name: '在 Cloudflare 中查看 todofy、todofy-core →' })).toHaveAttribute(
      'href',
      '#/cloudflare/worker/todofy',
    )
    expect(within(detail).getByRole('link', { name: '打开 Todofy（新标签页）' })).toHaveAttribute('target', '_blank')
  })

  it('shows another stage on click, and why an unseen stage is unseen', async () => {
    const user = await showFlows(oneWarning())
    const mail = card('邮件 → 任务')
    const forward = within(mail).getByRole('button', { name: /^阶段 1 来源转发/ })
    await user.click(forward)
    expect(forward).toHaveAttribute('aria-pressed', 'true')
    const detail = within(mail).getByRole('region', { name: /^来源转发/ })
    expect(within(detail).getByText('来源邮箱的转发在面板之外')).toBeInTheDocument()
  })

  it('shows the canary inside the mail flow: 14 days, today and its scope verbatim', async () => {
    await showFlows(oneWarning())
    const canary = within(card('邮件 → 任务')).getByRole('region', { name: /^金丝雀 · 每天 16:00 UTC（本地 00:00） ?定时$/ })
    const days = within(within(canary).getByRole('list', { name: '近 14 天金丝雀结果（按 UTC 日）' })).getAllByRole('img')
    expect(days).toHaveLength(14)
    expect(days[0]).toHaveAccessibleName('9月16日：成功，用时 6 分钟')
    expect(days[6]).toHaveAccessibleName('9月22日：已跳过（Todofy 处理已暂停，未测试链路）')
    expect(days[13]).toHaveAccessibleName('9月29日（今天，UTC）：成功，用时 6 分钟')
    expect(within(canary).getByText('14 天：13 次成功 · 1 次跳过 · 0 次失败')).toBeInTheDocument()
    expect(
      within(canary).getByText('覆盖范围：由 Mail Hero 直接创建合成邮件，验证投递与 Todofy 处理；不经过来源转发、收件和解析，也不创建 Todoist 任务。'),
    ).toBeInTheDocument()

    const steps = within(within(canary).getByRole('list', { name: '运行阶段' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringMatching(/^创建完成 · 00:00/),
      expect.stringMatching(/^已排队完成 · 00:00（\+1 秒）/),
      expect.stringMatching(/^已投递完成 · 00:02（\+2 分钟）尝试 1 次，最后 HTTP 204/),
      expect.stringMatching(/^Todofy 完成完成 · 00:06（\+6 分钟）/),
      expect.stringMatching(/^结束完成 · 00:06（\+6 分钟）/),
    ])
    expect(within(canary).getByText('本 UTC 日（2026-09-29）手动运行').nextElementSibling).toHaveTextContent('0 / 3 次')
    expect(within(canary).getByRole('link', { name: '“操作与记录”' })).toHaveAttribute('href', '#/ops')
    expect(within(canary).getByText('最近 14 次运行')).toBeInTheDocument()
  })

  it('marks a failed canary on its stage and in the day strip', async () => {
    await showFlows(canaryFailed())
    const mail = card('邮件 → 任务')
    expect(within(mail).getByRole('button', { name: /^阶段 4 Webhook 投递：故障，投递失败 0，金丝雀金丝雀失败/ })).toBeInTheDocument()
    const days = within(within(mail).getByRole('list', { name: '近 14 天金丝雀结果（按 UTC 日）' })).getAllByRole('img')
    expect(days[13]).toHaveAccessibleName('9月29日（今天，UTC）：失败（HTTP 503）')
    const today = within(mail).getByRole('list', { name: '运行阶段' }).parentElement as HTMLElement
    expect(within(today).getByText('投递阶段：HTTP 503')).toBeInTheDocument()
  })

  it('explains a switched-off canary', async () => {
    await showFlows(canaryDisabled(), '#/flows/mail-to-task')
    const mail = card('邮件 → 任务')
    expect(within(mail).getByText(CANARY_DISABLED_NOTE)).toBeInTheDocument()
    expect(within(mail).getByText('下次定时运行').nextElementSibling).toHaveTextContent('已关闭')
    expect(within(mail).getByRole('heading', { name: '正在运行' })).toBeInTheDocument()
  })

  it('opens the flow named in the route and toggles a card', async () => {
    const user = await showFlows(healthy(), '#/flows/ops-digest')
    const digest = card('运维摘要')
    expect(within(digest).getByRole('button', { name: '收起 运维摘要' })).toHaveAttribute('aria-expanded', 'true')
    const site = card('网站发布')
    await user.click(within(site).getByRole('button', { name: '展开 网站发布' }))
    const serve = within(site).getByRole('button', { name: '阶段 3 网站可用：正常，HTTP 200 · 180 ms' })
    await user.click(serve)
    const detail = within(site).getByRole('region', { name: /^网站可用/ })
    expect(within(detail).getByText(/HTTP 200 · 180 ms · 今天 00:30 检查/)).toBeInTheDocument()
    await user.click(within(site).getByRole('button', { name: /^阶段 2 发布/ }))
    expect(within(site).getByText(/16 · 错误 1（样本太少，不判定） · 最近有请求 今天 00 时/)).toBeInTheDocument()
  })

  it('shows unreachable stages as faults and keeps unclassified codes', async () => {
    const scenario = todofyUnreachable()
    const mail = scenario.flows.flows[0]!
    scenario.flows = {
      ...scenario.flows,
      flows: [{ ...mail, unclassified: [{ entry: 'todofy', code: 'brand_new_signal', severity: 'warning' }] }, ...scenario.flows.flows.slice(1)],
    }
    await showFlows(scenario)
    const card5 = within(card('邮件 → 任务')).getByRole('region', { name: /^Todofy 摘要/ })
    expect(within(card5).getByText(/原因：无法连接/)).toBeInTheDocument()
    const unclassified = within(card('邮件 → 任务')).getByRole('region', { name: '未归类的信号' })
    expect(unclassified).toHaveTextContent('Todofy：brand_new_signal')
  })
})
