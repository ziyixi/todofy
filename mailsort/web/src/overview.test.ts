/**
 * 概览 against the fake API (test/fakeServer.ts, the shared transcoder): the status line, today's four numbers with
 * their last 7 days, the flow diagram (its graph with 都不是 and 拿不准 split by 待审, hues, size, tooltip and theme
 * tokens, the zero skeleton on a day without mail, and its start on a phone), the table of the last 7 days per label
 * and the model budget's meter; no error box.
 */
import { mountApp, type Host } from './app.ts'
import { clamp, flowGraph, sankeyChart, skeletonGraph } from './flowchart.ts'
import { FakeServer, flowCount, label, NOW, settle } from './test/fakeServer.ts'
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import { LabelCountSchema, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { create } from '@ziyixi/proto/protobuf'

const host: Host = { now: () => NOW, confirm: () => true }

async function open(server: FakeServer, path: string): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, host)
  await settle()
  return root
}

/** A day of mail: the model writing labels of two groups, uncertain mail, a recorded label, skips, a deferral. */
function server(): FakeServer {
  const s = new FakeServer()
  s.labels = [label('finance-invest', '金融/投资'), label('finance-bank-pay', '金融/银行支付'), label('account-security', '账号安全'), label('travel', '出行')]
  s.flow = [
    flowCount(MailFlow_Stage.SKIPPED, MailFlow_Outcome.THREAD_SORTED, '', 3),
    flowCount(MailFlow_Stage.SKIPPED, MailFlow_Outcome.NOT_INBOX, '', 1),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/finance-invest', 5),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/account-security', 2),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/travel', 4),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE, '', 2),
    flowCount(MailFlow_Stage.CLEF_FLASH, MailFlow_Outcome.SUGGESTED, 'labels/finance-bank-pay', 1),
    flowCount(MailFlow_Stage.DEFERRED, MailFlow_Outcome.DEFERRED, '', 2),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.CORRECTED, 'labels/travel', 1),
  ]
  return s
}

describe('the flow diagram', () => {
  it('builds the graph: every mail once (延后 holds only mail still waiting), no correction, groups colored by top level', () => {
    const s = server()
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(20)
    expect(graph.nodes.map((node) => node.name)).toEqual(['新邮件', '跳过', 'Clef 27B', 'Clef-flash', '延后（额度）', '金融/投资', '账号安全', '出行', '拿不准（没进待审）', '影子建议（未写入）'])
    expect(graph.nodes.find((node) => node.id === 'skipped')?.detail).toEqual(['对话已分拣 3', '已发送、草稿或垃圾邮件 1'])
    // 金融/投资 and 金融/银行支付 share a group, so a color.
    expect(graph.groups).toEqual([
      { name: '金融', slot: 1 },
      { name: '账号安全', slot: 2 },
      { name: '出行', slot: 3 },
    ])
  })

  it('never runs out of hues for the template’s ten groups: a later group borrows a slot the day leaves free (QA D3)', () => {
    const paths = ['开发/CI通知', '开发/平台工具', '金融/投资', '金融/银行支付', '账号安全', '政府法律', '购物/订单物流', '购物/促销', '订阅收据', '出行', '生活/账单住房', '生活/汽车', '生活/医疗', '求职', '学校与社群', '新闻/周报']
    const labels = paths.map((path, index) => label(`l${String(index)}`, path))
    const written = (path: string, n: number) => flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, `labels/l${String(paths.indexOf(path))}`, n)
    // Five groups in a day, three of them past the eighth: none is gray, and no two share a hue.
    const graph = flowGraph([written('开发/CI通知', 3), written('金融/投资', 2), written('求职', 1), written('学校与社群', 1), written('新闻/周报', 4)], labels)
    const slotOf = (group: string) => graph.groups.find((item) => item.name === group)?.slot
    expect(slotOf('开发')).toBe(1)
    expect(slotOf('金融')).toBe(2)
    const shown = ['开发', '金融', '求职', '学校与社群', '新闻'].map(slotOf)
    expect(shown.every((slot) => slot !== undefined && slot > 0)).toBe(true)
    expect(new Set(shown).size).toBe(5)
    // The first eight groups keep their slot every day (a day never repaints them).
    const other = flowGraph([written('金融/投资', 1), written('出行', 1)], labels)
    expect(other.groups.find((item) => item.name === '金融')?.slot).toBe(2)
    expect(other.groups.find((item) => item.name === '出行')?.slot).toBe(7)
    // A disabled label's group does not take a hue from the groups that sort mail.
    const disabledFirst = [Object.assign(label('old', '旧/归档'), { enabled: false }), ...labels]
    expect(flowGraph([written('开发/CI通知', 1)], disabledFirst).groups.find((item) => item.name === '开发')?.slot).toBe(1)
    // Only a day with more than eight groups has gray ones, and the legend says so.
    const all = flowGraph(paths.map((path) => written(path, 1)), labels)
    expect(all.groups.filter((item) => item.slot === 0).map((item) => item.name)).toEqual(['求职', '学校与社群', '新闻'])
    expect(sankeyChart(all).querySelector('.flow-legend')?.textContent).toContain('新闻（灰色：分组超过八种颜色）')
    expect(sankeyChart(graph).querySelector('.flow-legend')?.textContent).not.toContain('灰色')
  })

  it('names 都不是 apart from 拿不准, and splits 拿不准 by whether the mail went to 待审', () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.NO_LABEL, '', 3), flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE_SHOWN, '', 1), flowCount(MailFlow_Stage.NO_MODEL, MailFlow_Outcome.UNSURE_SHOWN, '', 1))
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(25)
    expect(graph.nodes.slice(-4).map((node) => node.name)).toEqual(['都不是（留在收件箱）', '拿不准（进了待审）', '拿不准（没进待审）', '影子建议（未写入）'])
    expect(graph.links).toContainEqual({ source: 'clef', target: 'none', value: 3 })
    expect(graph.links).toContainEqual({ source: 'clef', target: 'unsure', value: 2 })
    expect(graph.links).toContainEqual({ source: 'clef', target: 'unsure_shown', value: 1 })
    expect(graph.links).toContainEqual({ source: 'no_model', target: 'unsure_shown', value: 1 })
    // 都不是 is a decision, not a warning: the pipeline's neutral color; 拿不准 in the warning color.
    const box = sankeyChart(graph)
    const fill = (name: string) => [...box.querySelectorAll('.flow-node')].find((node) => node.textContent.startsWith(name))?.querySelector('rect')?.getAttribute('fill')
    expect(fill('都不是')).toBe('var(--flow-node)')
    expect(fill('拿不准（进了待审）')).toBe('var(--warn)')
    // The tooltip says what each means.
    const shown = [...box.querySelectorAll<SVGGElement>('.flow-node')].find((node) => node.textContent.startsWith('拿不准（进了待审）'))
    shown?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toContain('留在收件箱，在待审里问你')
  })

  it('scales the SVG to its box (no fixed size) and exposes its nodes to assistive technology', () => {
    const s = server()
    const box = sankeyChart(flowGraph(s.flow, s.labels))
    const svg = box.querySelector('svg')
    expect(svg?.getAttribute('width')).toBeNull()
    expect(svg?.getAttribute('height')).toBeNull()
    expect(svg?.getAttribute('viewBox')).toMatch(/^0 0 720 \d+$/)
    // role=img would make every child presentational: the nodes must stay reachable.
    expect(svg?.getAttribute('role')).toBe('group')
    expect(svg?.getAttribute('aria-label')).toBe('邮件流程：共 20 封')
    expect(box.querySelectorAll('.flow-node[tabindex="0"]').length).toBe(10)
  })

  it('keeps the tooltip inside the chart’s box by its measured size, and above the pointer near the bottom', () => {
    expect(clamp(400, 0, 95)).toBe(95)
    expect(clamp(-3, 0, 95)).toBe(0)
    expect(clamp(20, 0, -10)).toBe(0)
    const s = server()
    const box = sankeyChart(flowGraph(s.flow, s.labels))
    document.body.append(box)
    // A phone's box: 351 px wide, 300 px high; the tip as wide as its 16rem maximum.
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 351, height: 300, right: 351, bottom: 300, x: 0, y: 0, toJSON: () => ({}) })
    const tip = box.querySelector<HTMLElement>('.flow-tip')
    if (tip === null) throw new Error('no tip')
    Object.defineProperty(tip, 'offsetWidth', { value: 256 })
    Object.defineProperty(tip, 'offsetHeight', { value: 60 })
    const link = box.querySelector('.flow-link')
    link?.dispatchEvent(new MouseEvent('pointerenter', { clientX: 300, clientY: 280 }))
    expect(tip.hidden).toBe(false)
    expect(tip.style.left).toBe('95px')
    expect(Number.parseFloat(tip.style.top) + 60).toBeLessThanOrEqual(300)
    link?.dispatchEvent(new MouseEvent('pointerenter', { clientX: 10, clientY: 10 }))
    expect(tip.style.left).toBe('22px')
    expect(tip.style.top).toBe('22px')
    box.remove()
  })

  it('draws in the theme’s tokens, with counts and a tooltip on focus', () => {
    const s = server()
    const box = sankeyChart(flowGraph(s.flow, s.labels))
    expect(box.querySelectorAll('.flow-link').length).toBe(9)
    const nodes = [...box.querySelectorAll<SVGGElement>('.flow-node')]
    expect(nodes.map((node) => node.getAttribute('aria-label'))).toContain('出行：4 封，占 20%')
    // Colors are tokens, never hex in the markup.
    const travel = nodes.find((node) => node.textContent.startsWith('出行'))
    expect(travel?.querySelector('rect')?.getAttribute('fill')).toBe('var(--series-3)')
    expect(box.querySelector('svg')?.outerHTML).not.toMatch(/#[0-9a-f]{6}/i)
    travel?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toContain('4 封 · 占全部 20%')
  })

  it('draws the whole skeleton at zero on a day without mail: muted nodes, hairline links, every count 0', () => {
    const skeleton = skeletonGraph()
    expect(skeleton.nodes.map((node) => node.name)).toEqual(['新邮件', '跳过', 'Clef 27B', 'Clef-flash', '未调用模型', '延后（额度）', '打标签', '都不是（留在收件箱）', '拿不准（进了待审）', '拿不准（没进待审）', '影子建议（未写入）'])
    const box = sankeyChart(flowGraph([], []))
    const svg = box.querySelector('svg')
    expect(svg?.getAttribute('aria-label')).toBe('邮件流程：还没有邮件')
    const nodes = [...box.querySelectorAll<SVGGElement>('.flow-node')]
    expect(nodes.length).toBe(11)
    expect(nodes.every((node) => node.classList.contains('zero') && node.querySelector('.flow-count')?.textContent === '0')).toBe(true)
    expect(nodes.every((node) => node.querySelector('rect')?.getAttribute('fill') === 'var(--flow-zero)')).toBe(true)
    // Named, but not eleven Tab stops that each say 0.
    expect(nodes.every((node) => node.getAttribute('tabindex') === '-1')).toBe(true)
    // Every rect has a real size (laid out as one mail per path), none is NaN.
    expect(nodes.every((node) => Number(node.querySelector('rect')?.getAttribute('height')) > 0)).toBe(true)
    const links = [...box.querySelectorAll('.flow-link')]
    expect(links.length).toBe(17)
    expect(links.every((link) => link.classList.contains('zero') && link.getAttribute('stroke-width') === '1')).toBe(true)
    expect(nodes[0]?.getAttribute('aria-label')).toBe('新邮件：0 封')
    nodes[0]?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toBe('新邮件0 封')
  })
})

describe('概览', () => {
  it('shows the status line, today’s four numbers with their 7 days, the flow, the week per label and the budget, and no error box', async () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.NO_LABEL, '', 3), flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE_SHOWN, '', 1))
    s.report = [
      create(LabelCountSchema, { label: 'labels/finance-invest', autoCount: 38, gmailCorrectionCount: 1, reviewCorrectionCount: 1, unsureCount: 2 }),
      create(LabelCountSchema, { label: 'labels/travel', autoCount: 5, unsureCount: 1, shownCount: 1 }),
      create(LabelCountSchema, { label: 'labels/account-security' }),
    ]
    const root = await open(s, '/overview')
    expect(s.calls.find((call) => call.path.startsWith('/api/v2/mailFlows/today'))).toBeDefined()
    expect(root.querySelector('.lead')?.textContent).toBe('影子：只判断和记录，不改 Gmail · 上次同步 2 分钟前 · 2 封待判断')
    // Today from the flow (skips, deferrals and corrections are not decisions), the last 7 days from the label report.
    const kpis = [...root.querySelectorAll('.kpi')].map((node) => [node.querySelector('.kpi-label')?.textContent, node.querySelector('.kpi-value')?.textContent, node.querySelector('.kpi-sub')?.textContent])
    expect(kpis).toEqual([
      ['处理', '18', '7 天 50'],
      ['有把握', '12', '7 天 40'],
      ['都不是', '3', '7 天 5'],
      ['拿不准', '3', '7 天 5'],
    ])
    expect(root.querySelector('svg.flow-svg')?.getAttribute('aria-label')).toBe('邮件流程：共 24 封')
    expect(root.textContent).toContain('共 24 封')
    expect(root.textContent).not.toContain('今天还没有邮件')
    // Only the labels with mail this week: automatic labels, the owner's corrections, uncertain mail.
    const table = root.querySelector('table.report')
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((cell) => cell.textContent)).toEqual(['标签', '自动', '改正', '拿不准'])
    expect([...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ['金融/投资', '38', '2', '2'],
      ['出行', '5', '0', '1'],
    ])
    expect(root.textContent).toContain('各标签 · 最近 7 天')
    expect(root.textContent).not.toContain('准确率')
    const budget = root.querySelector('[role="meter"]')
    expect(budget?.getAttribute('aria-valuenow')).toBe('523')
    expect(budget?.getAttribute('aria-valuemax')).toBe('7000')
    expect(root.textContent).toContain('523 / 7000')
    // A transient error code (the fake reports gmail_429) never stays on the page.
    expect(root.textContent).not.toContain('gmail_429')
    // Wide enough for the diagram: it is not scrolled.
    expect(root.querySelector('.flow-scroll')?.scrollLeft).toBe(0)
  })

  it('starts the diagram at its right end where it scrolls inside its box (a phone), where the mail went', async () => {
    // jsdom has no layout: a 600 px drawing in a 294 px box.
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(600)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(294)
    const root = await open(server(), '/overview')
    expect(root.querySelector('.flow-scroll')?.scrollLeft).toBe(600)
  })

  it('still draws the diagram on a day without mail, and says so in one line each', async () => {
    const s = new FakeServer()
    s.report = []
    s.status = { recentErrorCodes: [], neuronsToday: 6000, decisionModel: 'clef-flash', deferredCount: 4 }
    const root = await open(s, '/overview')
    expect(root.querySelector('svg.flow-svg')?.getAttribute('aria-label')).toBe('邮件流程：还没有邮件')
    expect(root.querySelectorAll('.flow-node.zero').length).toBe(11)
    expect(root.textContent).toContain('今天还没有邮件')
    expect([...root.querySelectorAll('.kpi-value')].map((node) => node.textContent)).toEqual(['0', '0', '0', '0'])
    expect(root.querySelector('table.report')).toBeNull()
    // The week had mail (7 天 50 above), just none on a label: the line says so, not that there was no mail.
    expect(root.querySelector('.empty strong')?.textContent).toBe('最近 7 天还没有邮件归到标签')
    s.reportDecidedCount = 0
    const quiet = await open(s, '/overview')
    expect(quiet.querySelector('.empty strong')?.textContent).toBe('最近 7 天还没有邮件')
    // Past 70 % of the budget: the warning tone and why.
    expect(root.querySelector('[role="meter"]')?.classList.contains('warn')).toBe(true)
    expect(root.textContent).toContain('已过 70%，今天改用 Clef-flash；4 封等明天的额度')
  })
  it('says in the status line when 正式 cannot write yet: the grant is read-only', async () => {
    const s = new FakeServer()
    Object.assign(s.settings, { mode: Mode.LIVE, effectiveMode: Mode.LIVE })
    s.status = { pendingCount: 0 }
    const root = await open(s, '/overview')
    expect(root.querySelector('.lead')?.textContent).toBe('正式：Gmail 只读授权，还不会写入 · 上次同步 2 分钟前')
  })
})
