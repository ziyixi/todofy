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
import { ClassificationProvider, ClassifierStatusSchema, ClaudeBudgetSchema, LabelCountSchema, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'

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
  s.labels = [label('p1', 'P1'), label('p2', 'P2'), label('p3', 'P3'), label('p4', 'P4')]
  s.flow = [
    flowCount(MailFlow_Stage.SKIPPED, MailFlow_Outcome.THREAD_SORTED, '', 3),
    flowCount(MailFlow_Stage.SKIPPED, MailFlow_Outcome.NOT_INBOX, '', 1),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/p2', 5),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/p1', 2),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/p4', 4),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE, '', 2),
    flowCount(MailFlow_Stage.CLEF_FLASH, MailFlow_Outcome.SUGGESTED, 'labels/p3', 1),
    flowCount(MailFlow_Stage.DEFERRED, MailFlow_Outcome.DEFERRED, '', 2),
    flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.CORRECTED, 'labels/p4', 1),
  ]
  return s
}

describe('the flow diagram', () => {
  it('builds the graph: every mail once (延后 holds only mail still waiting), no correction, priorities retain their order and individual colors', () => {
    const s = server()
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(20)
    expect(graph.nodes.map((node) => node.name)).toEqual(['新邮件', '跳过', '历史 Clef 27B', '历史 Clef-flash', '等待判断', 'P1', 'P2', 'P4', '旧记录：未确认', '影子建议（未写入）'])
    expect(graph.nodes.find((node) => node.id === 'skipped')?.detail).toEqual(['对话已分拣 3', '已发送、草稿或垃圾邮件 1'])
    // Each priority has its own stable color.
    expect(graph.groups).toEqual([
      { name: 'P1', slot: 1 },
      { name: 'P2', slot: 2 },
      { name: 'P3', slot: 3 },
      { name: 'P4', slot: 4 },
    ])
  })

  it('borrows unused color slots for later flat labels, keeping stable colors for earlier labels', () => {
    const names = Array.from({ length: 11 }, (_, index) => `Category ${String(index + 1)}`)
    const labels = names.map((name, index) => label(`l${String(index)}`, name))
    const written = (index: number) => flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, `labels/l${String(index)}`, 1)
    const graph = flowGraph([0, 2, 8, 9, 10].map(written), labels)
    const slotOf = (index: number) => graph.groups.find((item) => item.name === names[index])?.slot
    expect(slotOf(0)).toBe(1)
    expect(slotOf(2)).toBe(3)
    const shown = [0, 2, 8, 9, 10].map(slotOf)
    expect(shown.every((slot) => slot !== undefined && slot > 0)).toBe(true)
    expect(new Set(shown).size).toBe(5)
    const other = flowGraph([2, 6].map(written), labels)
    expect(other.groups.find((item) => item.name === names[2])?.slot).toBe(3)
    expect(other.groups.find((item) => item.name === names[6])?.slot).toBe(7)
    const disabledFirst = [Object.assign(label('old', 'Legacy/Archive'), { enabled: false }), ...labels]
    expect(flowGraph([written(0)], disabledFirst).groups.find((item) => item.name === names[0])?.slot).toBe(1)
    const all = flowGraph(names.map((_, index) => written(index)), labels)
    expect(all.groups.filter((item) => item.slot === 0).map((item) => item.name)).toEqual(names.slice(8))
    expect(sankeyChart(all).querySelector('.flow-legend')?.textContent).toContain('Category 11（灰色：标签超过八种颜色）')
    expect(sankeyChart(graph).querySelector('.flow-legend')?.textContent).not.toContain('灰色')
  })

  it('names 都不是 apart from 拿不准, and splits 拿不准 by whether the mail went to 待审', () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.NO_LABEL, '', 3), flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE_SHOWN, '', 1), flowCount(MailFlow_Stage.NO_MODEL, MailFlow_Outcome.UNSURE_SHOWN, '', 1))
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(25)
    expect(graph.nodes.slice(-4).map((node) => node.name)).toEqual(['旧记录：未分级', '旧记录：待确认', '旧记录：未确认', '影子建议（未写入）'])
    expect(graph.links).toContainEqual({ source: 'clef', target: 'none', value: 3 })
    expect(graph.links).toContainEqual({ source: 'clef', target: 'unsure', value: 2 })
    expect(graph.links).toContainEqual({ source: 'clef', target: 'unsure_shown', value: 1 })
    expect(graph.links).toContainEqual({ source: 'no_model', target: 'unsure_shown', value: 1 })
    // 都不是 is a decision, not a warning: the pipeline's neutral color; 拿不准 in the warning color.
    const box = sankeyChart(graph)
    const fill = (name: string) => [...box.querySelectorAll('.flow-node')].find((node) => node.textContent.startsWith(name))?.querySelector('rect')?.getAttribute('fill')
    expect(fill('旧记录：未分级')).toBe('var(--flow-node)')
    expect(fill('旧记录：待确认')).toBe('var(--warn)')
    // The tooltip says what each means.
    const shown = [...box.querySelectorAll<SVGGElement>('.flow-node')].find((node) => node.textContent.startsWith('旧记录：待确认'))
    shown?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toContain('旧分类流程留下的确认记录，邮件留在收件箱')
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
    expect(nodes.map((node) => node.getAttribute('aria-label'))).toContain('P4：4 封，占 20%')
    // Colors are tokens, never hex in the markup.
    const travel = nodes.find((node) => node.textContent.startsWith('P4'))
    expect(travel?.querySelector('rect')?.getAttribute('fill')).toBe('var(--series-4)')
    expect(box.querySelector('svg')?.outerHTML).not.toMatch(/#[0-9a-f]{6}/i)
    travel?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toContain('4 封 · 占全部 20%')
  })

  it('draws the whole skeleton at zero on a day without mail: muted nodes, hairline links, every count 0', () => {
    const skeleton = skeletonGraph()
    expect(skeleton.nodes.map((node) => node.name)).toEqual(['新邮件', '跳过', 'Claude Opus 5.5', '等待判断', 'P1', 'P2', 'P3', 'P4', '影子建议（未写入）'])
    const box = sankeyChart(flowGraph([], []))
    const svg = box.querySelector('svg')
    expect(svg?.getAttribute('aria-label')).toBe('邮件流程：还没有邮件')
    const nodes = [...box.querySelectorAll<SVGGElement>('.flow-node')]
    expect(nodes.length).toBe(9)
    expect(nodes.every((node) => node.classList.contains('zero') && node.querySelector('.flow-count')?.textContent === '0')).toBe(true)
    expect(nodes.every((node) => node.querySelector('rect')?.getAttribute('fill') === 'var(--flow-zero)')).toBe(true)
    // Named, but not nine Tab stops that each say 0.
    expect(nodes.every((node) => node.getAttribute('tabindex') === '-1')).toBe(true)
    // Every rect has a real size (laid out as one mail per path), none is NaN.
    expect(nodes.every((node) => Number(node.querySelector('rect')?.getAttribute('height')) > 0)).toBe(true)
    const links = [...box.querySelectorAll('.flow-link')]
    expect(links.length).toBe(8)
    expect(links.every((link) => link.classList.contains('zero') && link.getAttribute('stroke-width') === '1')).toBe(true)
    expect(nodes[0]?.getAttribute('aria-label')).toBe('新邮件：0 封')
    nodes[0]?.dispatchEvent(new FocusEvent('focus'))
    expect(box.querySelector('.flow-tip')?.textContent).toBe('新邮件0 封')
  })
})

describe('概览', () => {
  it.each([
    { name: 'mixed', fallbackCount: 67, note: '明确 P1 14 封 · 历史保底 P1 67 封' },
    { name: 'all fallback', fallbackCount: 81, note: '明确 P1 0 封 · 历史保底 P1 81 封' },
    { name: 'no fallback', fallbackCount: 0, note: '明确 P1 81 封 · 历史保底 P1 0 封' },
    { name: 'older server', fallbackCount: undefined, note: '历史 P1 保底拆分未提供，请刷新或等待服务更新。' },
  ])('shows $name P1 counts without changing category totals or the flow', async ({ fallbackCount, note }) => {
    const s = server()
    s.report = [
      create(LabelCountSchema, { label: 'labels/p1', autoCount: 81, ...(fallbackCount === undefined ? {} : { fallbackCount }) }),
      create(LabelCountSchema, { label: 'labels/p2', fallbackCount: 0 }),
      create(LabelCountSchema, { label: 'labels/p3', fallbackCount: 0 }),
      create(LabelCountSchema, { label: 'labels/p4', autoCount: 19, fallbackCount: 0 }),
    ]
    const root = await open(s, '/overview')
    const report = [...root.querySelectorAll('.card')].find((card) => card.querySelector('table.report') !== null)
    expect(report?.querySelector('.hint')?.textContent).toBe(note)
    expect([...(report?.querySelectorAll('tbody tr') ?? [])].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ['P1', '81', '0'],
      ['P4', '19', '0'],
    ])
    expect([...root.querySelectorAll('.kpi-value')].map((node) => node.textContent)).toEqual(['14', '12', '2', '10'])
    expect([...root.querySelectorAll('.kpi-sub')].map((node) => node.textContent)).toEqual(['7 天 50', '7 天 40', '7 天 81', '7 天 19'])
    expect(root.querySelector('svg.flow-svg')?.getAttribute('aria-label')).toBe('邮件流程：共 20 封')
    expect(root.querySelectorAll('.tabs a')).toHaveLength(3)
    expect(root.textContent).not.toContain('准确率')
    if (fallbackCount === undefined) expect(report?.textContent).not.toContain('明确 P1')
  })

  it('shows the status line, today’s four numbers with their 7 days, the flow, the week per label and the budget, and no error box', async () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.NO_LABEL, '', 3), flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.UNSURE_SHOWN, '', 1))
    s.report = [
      create(LabelCountSchema, { label: 'labels/p2', autoCount: 38, gmailCorrectionCount: 1, reviewCorrectionCount: 1, unsureCount: 2 }),
      create(LabelCountSchema, { label: 'labels/p4', autoCount: 5, unsureCount: 1, shownCount: 1 }),
      create(LabelCountSchema, { label: 'labels/p1' }),
    ]
    const root = await open(s, '/overview')
    expect(s.calls.find((call) => call.path.startsWith('/api/v2/mailFlows/today'))).toBeDefined()
    expect(root.querySelector('.lead')?.textContent).toBe('影子：只判断和记录，不改 Gmail · 上次同步 2 分钟前 · 2 封待判断')
    // Today from the flow (skips, deferrals and corrections are not decisions), the last 7 days from the label report.
    const kpis = [...root.querySelectorAll('.kpi')].map((node) => [node.querySelector('.kpi-label')?.textContent, node.querySelector('.kpi-value')?.textContent, node.querySelector('.kpi-sub')?.textContent])
    expect(kpis).toEqual([
      ['处理', '18', '7 天 50'],
      ['已分级', '12', '7 天 40'],
      ['P1', '2', '7 天 0'],
      ['P2、P3、P4', '10', '7 天 43'],
    ])
    expect(root.querySelector('svg.flow-svg')?.getAttribute('aria-label')).toBe('邮件流程：共 24 封')
    expect(root.textContent).toContain('共 24 封')
    expect(root.textContent).not.toContain('今天还没有邮件')
    // Only the labels with mail this week: automatic labels, the owner's corrections, uncertain mail.
    const table = root.querySelector('table.report')
    expect([...(table?.querySelectorAll('thead th') ?? [])].map((cell) => cell.textContent)).toEqual(['分级', '自动', '改正'])
    expect([...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ['P2', '38', '2'],
      ['P4', '5', '0'],
    ])
    expect(root.textContent).toContain('各分级 · 最近 7 天')
    expect(root.textContent).not.toContain('准确率')
    const budget = root.querySelector('[role="meter"]')
    expect(budget?.getAttribute('aria-valuenow')).toBe('0.5234')
    expect(budget?.getAttribute('aria-valuemax')).toBe('20')
    expect(root.textContent).toContain('本月费用 US$ 0.52 / 配置月上限 US$ 20.00')
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
    expect(root.querySelectorAll('.flow-node.zero').length).toBe(9)
    expect(root.textContent).toContain('今天还没有邮件')
    expect([...root.querySelectorAll('.kpi-value')].map((node) => node.textContent)).toEqual(['0', '0', '0', '0'])
    expect(root.querySelector('table.report')).toBeNull()
    // The week had mail (7 天 50 above), just none on a label: the line says so, not that there was no mail.
    expect(root.querySelector('.empty strong')?.textContent).toBe('最近 7 天还没有分级记录')
    s.reportDecidedCount = 0
    const quiet = await open(s, '/overview')
    expect(quiet.querySelector('.empty strong')?.textContent).toBe('最近 7 天还没有邮件')
    // Historical neuron fields cannot change the current model or its budget.
    expect(root.querySelector('[role="meter"]')?.classList.contains('warn')).toBe(false)
    expect(root.textContent).not.toContain('70%')
    expect(root.textContent).toContain('4 封暂缓，后台按额度或重试时间继续')
  })
  it('shows recorded monthly usage, nominal cost and the next batch without claiming the workspace balance', async () => {
    const s = server()
    s.status = { claudeBudget: create(ClaudeBudgetSchema, {
      model: 'claude-opus-5-5', effort: 'medium', month: '2026-10', limitUsd: 20, spentUsd: 3.514105,
      inputTokens: 125000, cacheReadTokens: 100000, cacheWriteTokens: 5000, outputTokens: 16000, thinkingTokens: 5000,
      nextBatchTime: timestampFromMs(NOW + 3_600_000), lastRequestTime: timestampFromMs(NOW - 600_000),
    }) }
    const root = await open(s, '/overview')
    expect(root.textContent).toContain('Claude Opus 5.5 · medium · 提示词可在设置中编辑')
    expect(root.textContent).toContain('本月费用 US$ 3.51 / 配置月上限 US$ 20.00')
    expect(root.textContent).toContain('本应用记录的 API 用量：输入总计（含缓存）125000 token · 输出（含思考）16000 token · 思考明细 5000 token')
    expect(root.textContent).toContain('缓存读取 100000 token · 缓存写入 5000 token，均已计入输入总计')
    expect(root.textContent).toContain('缓存有效期为 5 分钟，连续批次可能命中')
    expect(root.textContent).toContain('不含赠金、折扣或本应用以外的调用')
    expect(root.textContent).toContain('下批判断最早在 1 小时后')
    expect(root.querySelector('.status-line')?.textContent).toContain('下次检查 5 分钟后')
    expect(s.calls.filter((call) => call.path === '/api/v2/serviceStatus')).toHaveLength(1)
  })

  it.each([
    { spentUsd: 20, providerLimitReached: false, lastErrorCode: '', message: '本月模型预算已用完' },
    { spentUsd: 3, providerLimitReached: true, lastErrorCode: 'claude_spend_limit', message: 'Anthropic 工作区已达到消费上限' },
    { spentUsd: 3, providerLimitReached: false, lastErrorCode: 'claude_bad_json', message: 'Claude 返回格式无效，本次没有生成分级' },
  ])('shows a genuine budget wait or failed attempt: $message', async ({ message, ...fields }) => {
    const s = server()
    s.status = { claudeBudget: create(ClaudeBudgetSchema, { model: 'claude-opus-5-5', effort: 'medium', month: '2026-10', limitUsd: 20, ...fields }) }
    const root = await open(s, '/overview')
    expect(root.textContent).toContain(message)
    expect(root.textContent).toContain('思考明细未提供')
    expect(root.textContent).not.toContain('思考明细 0 token')
    expect(root.textContent).not.toContain('已过 70%')
  })

  it('does not invent zero usage or a cap when an older response omits the budget', async () => {
    const s = new FakeServer()
    s.status = { claudeBudget: undefined }
    const root = await open(s, '/overview')
    expect(root.textContent).toContain('Claude 用量未提供，请刷新或等待服务更新')
    expect(root.textContent).not.toContain('US$ 0.00')
    expect(root.textContent).not.toContain('US$ 20.00')
    expect(root.textContent).not.toContain('缓存读取')
    expect(root.querySelector('[role="meter"]')).toBeNull()
  })

  it('shows zero cache usage for legacy uncached records without claiming savings', async () => {
    const root = await open(new FakeServer(), '/overview')
    expect(root.textContent).toContain('输入总计（含缓存）24000 token')
    expect(root.textContent).toContain('缓存读取 0 token · 缓存写入 0 token')
    expect(root.textContent).toContain('相隔约一小时的单批通常不会命中')
    expect(root.textContent).not.toContain('节省')
  })

  it('routes current Claude results through the model while retaining historic Clef counts', () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.CLAUDE, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/p1', 3))
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(23)
    expect(graph.links).toContainEqual({ source: 'claude', target: 'label:labels/p1', value: 3 })
    expect(graph.nodes.map((node) => node.name)).toContain('Claude Opus 5.5')
    expect(graph.nodes.map((node) => node.name)).toContain('历史 Clef 27B')
  })

  it('keeps Codex and Claude counters on their own model nodes', () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.CLAUDE, MailFlow_Outcome.KEPT_IN_INBOX, 'labels/p1', 3), flowCount(MailFlow_Stage.CODEX, MailFlow_Outcome.ARCHIVED, 'labels/p2', 4))
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(27)
    expect(graph.links).toContainEqual({ source: 'claude', target: 'label:labels/p1', value: 3 })
    expect(graph.links).toContainEqual({ source: 'codex', target: 'label:labels/p2', value: 4 })
    expect(graph.nodes.map((node) => node.name)).toContain('VPS Codex')
    expect(graph.nodes.map((node) => node.name)).toContain('Claude Opus 5.5')
  })

  it('uses Codex in an empty-day diagram when it is the selected provider', async () => {
    const s = new FakeServer()
    s.status = { classifier: create(ClassifierStatusSchema, { provider: ClassificationProvider.CODEX, model: 'gpt-6.1-sol', effort: 'medium', configured: true }) }
    const root = await open(s, '/overview')
    const nodes = [...root.querySelectorAll('.flow-node')].map((node) => node.textContent)
    expect(nodes).toContain('VPS Codex0')
    expect(nodes).not.toContain('Claude Opus 5.50')
    expect(root.querySelectorAll('.flow-node.zero')).toHaveLength(9)
  })

  it('says in the status line when 正式 cannot write yet: the grant is read-only', async () => {
    const s = new FakeServer()
    Object.assign(s.settings, { mode: Mode.LIVE, effectiveMode: Mode.LIVE })
    s.status = { pendingCount: 0 }
    const root = await open(s, '/overview')
    expect(root.querySelector('.lead')?.textContent).toBe('正式：Gmail 只读授权，还不会写入 · 上次同步 2 分钟前')
  })
})
