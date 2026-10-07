/**
 * 概览 against the fake API (test/fakeServer.ts, the shared transcoder): today's four numbers, the flow diagram (its
 * graph, hues, size, tooltip and theme tokens, and the zero skeleton on a day without mail), accuracy per label with
 * data, the model budget's meter and the latest error.
 */
import { mountApp, type Host } from './app.ts'
import { clamp, flowGraph, sankeyChart, skeletonGraph } from './flowchart.ts'
import { FakeServer, flowCount, label, NOW, settle } from './test/fakeServer.ts'
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v1/flow_pb'
import { LabelAccuracySchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
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

/** A day of mail: rules and the model writing labels of two groups, an unsure mail, a suggestion, skips, a deferral. */
function server(): FakeServer {
  const s = new FakeServer()
  s.labels = [label('finance-invest', '金融/投资'), label('finance-bank-pay', '金融/银行支付'), label('account-security', '账号安全'), label('travel', '出行')]
  s.flow = [
    flowCount(MailFlow_Stage.SKIPPED, MailFlow_Outcome.THREAD_SORTED, '', 3),
    flowCount(MailFlow_Stage.SKIPPED, MailFlow_Outcome.NOT_INBOX, '', 1),
    flowCount(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, 'labels/finance-invest', 5),
    flowCount(MailFlow_Stage.RULE, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/account-security', 2),
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
    expect(graph.nodes.map((node) => node.name)).toEqual(['新邮件', '跳过', '规则', 'Clef 27B', 'Clef-flash', '延后（额度）', '金融/投资', '账号安全', '出行', '拿不准（留在收件箱）', '影子建议（未写入）'])
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
    const written = (path: string, n: number) => flowCount(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, `labels/l${String(paths.indexOf(path))}`, n)
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

  it('names the neighbours apart from the model', () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.NEIGHBOURS, MailFlow_Outcome.ARCHIVED, 'labels/travel', 3))
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(23)
    expect(graph.nodes.map((node) => node.name)).toContain('向量近邻')
    expect(graph.links).toContainEqual({ source: 'neighbours', target: 'label:labels/travel', value: 3 })
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
    expect(box.querySelectorAll('.flow-node[tabindex="0"]').length).toBe(11)
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
    expect(box.querySelectorAll('.flow-link').length).toBe(10)
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
    expect(skeleton.nodes.map((node) => node.name)).toEqual(['新邮件', '跳过', '规则', '向量近邻', 'Clef 27B', 'Clef-flash', '未调用模型', '延后（额度）', '打标签', '拿不准（留在收件箱）', '影子建议（未写入）'])
    const box = sankeyChart(flowGraph([], []))
    const svg = box.querySelector('svg')
    expect(svg?.getAttribute('aria-label')).toBe('邮件流程：还没有邮件')
    const nodes = [...box.querySelectorAll<SVGGElement>('.flow-node')]
    expect(nodes.length).toBe(11)
    expect(nodes.every((node) => node.classList.contains('zero') && node.querySelector('.flow-count')?.textContent === '0')).toBe(true)
    expect(nodes.every((node) => node.querySelector('rect')?.getAttribute('fill') === 'var(--flow-zero)')).toBe(true)
    // Every rect has a real size (laid out as one mail per path), none is NaN.
    expect(nodes.every((node) => Number(node.querySelector('rect')?.getAttribute('height')) > 0)).toBe(true)
    const links = [...box.querySelectorAll('.flow-link')]
    expect(links.length).toBe(18)
    expect(links.every((link) => link.classList.contains('zero') && link.getAttribute('stroke-width') === '1')).toBe(true)
    expect(nodes[0]?.getAttribute('aria-label')).toBe('新邮件：0 封')
    nodes[0]?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toBe('新邮件0 封')
  })
})

describe('概览', () => {
  it('shows today’s four numbers, the flow, accuracy for labels with data, the budget and the latest error', async () => {
    const s = server()
    s.status = { decidedTodayCount: 16, appliedTodayCount: 11, unsureTodayCount: 2, reviewCount: 3 }
    s.accuracy = [
      create(LabelAccuracySchema, { label: 'labels/finance-invest', confirmedCount: 38, correctedCount: 2, precisionLowerBound: 0.92 }),
      create(LabelAccuracySchema, { label: 'labels/travel', confirmedCount: 5, correctedCount: 1, precisionLowerBound: 0.44 }),
      create(LabelAccuracySchema, { label: 'labels/account-security' }),
    ]
    const root = await open(s, '/overview')
    expect(s.calls.find((call) => call.path.startsWith('/api/v1/mailFlows/today'))).toBeDefined()
    const kpis = [...root.querySelectorAll('.kpi')].map((node) => [node.querySelector('.kpi-label')?.textContent, node.querySelector('.kpi-value')?.textContent])
    expect(kpis).toEqual([
      ['处理', '16'],
      ['已打标签', '11'],
      ['待审', '3'],
      ['拿不准', '2'],
    ])
    expect(root.querySelector('svg.flow-svg')?.getAttribute('aria-label')).toBe('邮件流程：共 20 封')
    expect(root.textContent).toContain('共 20 封')
    expect(root.textContent).not.toContain('今天还没有邮件')
    // Only the labels with verdicts, the one below the target in the warning tone.
    const bars = [...root.querySelectorAll('.bars li')]
    expect(bars.map((row) => row.querySelector('.name')?.textContent)).toEqual(['金融/投资', '出行'])
    expect(bars.map((row) => row.querySelector('.figures')?.textContent)).toEqual(['92% · 40', '44% · 6'])
    expect(bars[1]?.querySelector('.bar')?.classList.contains('warn')).toBe(true)
    expect(root.textContent).toContain('目标 90%')
    const budget = root.querySelector('[role="meter"]')
    expect(budget?.getAttribute('aria-valuenow')).toBe('523')
    expect(budget?.getAttribute('aria-valuemax')).toBe('7000')
    expect(root.textContent).toContain('523 / 7000')
    expect(root.querySelector('.notice')?.textContent).toBe('最近错误：gmail_429')
  })

  it('still draws the diagram on a day without mail, and says so in one line each', async () => {
    const s = new FakeServer()
    s.accuracy = []
    s.status = { recentErrorCodes: [], neuronsToday: 6000, decisionModel: 'clef-flash', deferredCount: 4 }
    const root = await open(s, '/overview')
    expect(root.querySelector('svg.flow-svg')?.getAttribute('aria-label')).toBe('邮件流程：还没有邮件')
    expect(root.querySelectorAll('.flow-node.zero').length).toBe(11)
    expect(root.textContent).toContain('今天还没有邮件')
    expect(root.querySelector('.bars')).toBeNull()
    expect(root.textContent).toContain('还没有确认或纠正过的邮件')
    // Past 70 % of the budget: the warning tone and why.
    expect(root.querySelector('[role="meter"]')?.classList.contains('warn')).toBe(true)
    expect(root.textContent).toContain('已过 70%，今天改用 Clef-flash；4 封等明天的额度')
    expect(root.querySelector('.notice')).toBeNull()
  })
})
