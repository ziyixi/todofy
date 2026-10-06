/**
 * The owner's round-2 views against the fake API (test/fakeServer.ts, the shared transcoder): 流程's diagram, range,
 * tooltip, keyboard and link to a label's 操作记录, its table per label, and the compact diagram on 运行状态; labels as a
 * tree with 归档 and 敏感; 导入导出's strict reading, preview and confirmation, the template, and the export; and a rule
 * with subject conditions.
 */
import { mountApp, type Host } from './app.ts'
import { clamp, flowGraph, sankeyChart } from './flowchart.ts'
import { FakeServer, flowCount, label, ledgerEntry, NOW, settle } from './test/fakeServer.ts'
import { parseImport } from './views/import.ts'
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v1/flow_pb'

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

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (found === undefined) throw new Error(`no button ${text}`)
  return found
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

describe('流程', () => {
  it('builds the graph: every mail once (延后 holds only mail still waiting), corrections only in the table, groups colored by top level', () => {
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
    expect(graph.breakdown.map((row) => [row.name, row.written, row.kept, row.suggested, row.byRule, row.byModel, row.corrected])).toEqual([
      ['金融/投资', 5, 0, 0, 5, 0, 0],
      ['金融/银行支付', 0, 0, 1, 0, 1, 0],
      ['账号安全', 2, 2, 0, 2, 0, 0],
      ['出行', 4, 0, 0, 0, 4, 1],
    ])
  })

  it('never runs out of hues for the template’s ten groups: a later group borrows a slot the range leaves free (QA D3)', () => {
    const paths = ['开发/CI通知', '开发/平台工具', '金融/投资', '金融/银行支付', '账号安全', '政府法律', '购物/订单物流', '购物/促销', '订阅收据', '出行', '生活/账单住房', '生活/汽车', '生活/医疗', '求职', '学校与社群', '新闻/周报']
    const labels = paths.map((path, index) => label(`l${String(index)}`, path))
    const written = (path: string, n: number) => flowCount(MailFlow_Stage.RULE, MailFlow_Outcome.ARCHIVED, `labels/l${String(paths.indexOf(path))}`, n)
    // Five groups in range, three of them past the eighth: none is gray, and no two share a hue.
    const graph = flowGraph([written('开发/CI通知', 3), written('金融/投资', 2), written('求职', 1), written('学校与社群', 1), written('新闻/周报', 4)], labels)
    const slotOf = (group: string) => graph.groups.find((item) => item.name === group)?.slot
    expect(slotOf('开发')).toBe(1)
    expect(slotOf('金融')).toBe(2)
    const shown = ['开发', '金融', '求职', '学校与社群', '新闻'].map(slotOf)
    expect(shown.every((slot) => slot !== undefined && slot > 0)).toBe(true)
    expect(new Set(shown).size).toBe(5)
    // The first eight groups keep their slot in every range (a range never repaints them).
    const other = flowGraph([written('金融/投资', 1), written('出行', 1)], labels)
    expect(other.groups.find((item) => item.name === '金融')?.slot).toBe(2)
    expect(other.groups.find((item) => item.name === '出行')?.slot).toBe(7)
    // A disabled label's group does not take a hue from the groups that sort mail.
    const disabledFirst = [Object.assign(label('old', '旧/归档'), { enabled: false }), ...labels]
    expect(flowGraph([written('开发/CI通知', 1)], disabledFirst).groups.find((item) => item.name === '开发')?.slot).toBe(1)
    // Only a range with more than eight groups has gray ones, and the legend says so.
    const all = flowGraph(paths.map((path) => written(path, 1)), labels)
    expect(all.groups.filter((item) => item.slot === 0).map((item) => item.name)).toEqual(['求职', '学校与社群', '新闻'])
    const box = sankeyChart(all, {})
    expect(box.querySelector('.flow-legend')?.textContent).toContain('新闻（灰色：此范围的分组超过八种颜色）')
    expect(sankeyChart(graph, {}).querySelector('.flow-legend')?.textContent).not.toContain('灰色')
  })

  it('credits the neighbours apart from the model, in the graph and the table', async () => {
    const s = server()
    s.flow.push(flowCount(MailFlow_Stage.NEIGHBOURS, MailFlow_Outcome.ARCHIVED, 'labels/travel', 3))
    const graph = flowGraph(s.flow, s.labels)
    expect(graph.total).toBe(23)
    expect(graph.breakdown.find((row) => row.name === '出行')).toMatchObject({ written: 7, byRule: 0, byNeighbours: 3, byModel: 4 })
    expect(graph.nodes.map((node) => node.name)).toContain('向量近邻')
    const root = await open(s, '/flow')
    const header = [...root.querySelectorAll('.flow-table thead th')].map((cell) => cell.textContent)
    expect(header.slice(0, 5)).toEqual(['标签', '合计', '规则', '近邻', '模型'])
    const travel = [...root.querySelectorAll('.flow-table tbody tr')].find((row) => row.textContent.startsWith('出行'))
    expect([...(travel?.children ?? [])].slice(2, 5).map((cell) => cell.textContent)).toEqual(['0', '3', '4'])
  })

  it('scales the SVG to its box (no fixed size) and exposes its nodes to assistive technology', () => {
    const s = server()
    const box = sankeyChart(flowGraph(s.flow, s.labels))
    const svg = box.querySelector('svg')
    expect(svg?.getAttribute('width')).toBeNull()
    expect(svg?.getAttribute('height')).toBeNull()
    expect(svg?.getAttribute('viewBox')).toMatch(/^0 0 720 \d+$/)
    // role=img would make every child presentational: the label links must stay reachable.
    expect(svg?.getAttribute('role')).toBe('group')
    expect(svg?.getAttribute('aria-label')).toBe('邮件流程：共 20 封')
    expect(box.querySelectorAll('.flow-node[role="link"]').length).toBe(3)
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

  it('draws the diagram in the theme’s tokens, with counts, tooltips and a keyboard path to a label’s ledger', async () => {
    const s = server()
    s.ledgerEntries = [ledgerEntry('a', { label: 'labels/travel' }), ledgerEntry('b', { label: 'labels/finance-invest' })]
    const root = await open(s, '/flow')
    expect(s.calls.find((call) => call.path.startsWith('/api/v1/mailFlows/today'))).toBeDefined()
    const svg = root.querySelector('svg.flow-svg')
    expect(svg).not.toBeNull()
    expect(root.querySelectorAll('.flow-link').length).toBe(10)
    const nodes = [...root.querySelectorAll<SVGGElement>('.flow-node')]
    expect(nodes.map((node) => node.getAttribute('aria-label'))).toContain('出行：4 封，占 20%')
    // Colors are tokens, never hex in the markup.
    const travel = nodes.find((node) => node.textContent.startsWith('出行'))
    expect(travel?.querySelector('rect')?.getAttribute('fill')).toBe('var(--series-3)')
    expect(svg?.outerHTML).not.toMatch(/#[0-9a-f]{6}/i)
    travel?.dispatchEvent(new FocusEvent('focus'))
    expect(root.querySelector('.flow-tip')?.textContent).toContain('4 封 · 占全部 20%')
    travel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()
    expect(window.location.pathname + window.location.search).toBe('/ledger?label=labels%2Ftravel')
    expect(s.calls.some((call) => call.path.startsWith('/api/v1/ledgerEntries') && call.path.includes('label=labels%2Ftravel'))).toBe(true)
    expect(root.querySelectorAll('article.card').length).toBe(1)
    expect(root.textContent).toContain('只看“出行”的记录')
  })

  it('switches the range and shows the table per label', async () => {
    const s = server()
    const root = await open(s, '/flow')
    const rows = [...root.querySelectorAll('.flow-table tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent))
    expect(rows[0]?.slice(0, 3)).toEqual(['金融/投资', '5 25%', '5'])
    expect(rows[3]?.at(-1)).toBe('1')
    buttonNamed(root, '30 天').click()
    await settle()
    expect(s.calls.some((call) => call.path.startsWith('/api/v1/mailFlows/last-30-days'))).toBe(true)
    expect(buttonNamed(root, '30 天').getAttribute('aria-pressed')).toBe('true')
  })

  it('says so when no mail went through', async () => {
    const s = new FakeServer()
    const root = await open(s, '/flow')
    expect(root.textContent).toContain('这段时间还没有邮件经过')
  })

  it('shows today’s compact diagram on 运行状态', async () => {
    const root = await open(server(), '/status')
    expect(root.querySelector('.flow-chart.compact svg')).not.toBeNull()
    expect(root.textContent).toContain('今天的流程')
    expect(root.textContent).toContain('查看流程')
  })
})

describe('标签 as a tree', () => {
  it('groups nested labels under their top level and saves 归档 and 敏感 with the mask', async () => {
    const s = server()
    s.labels[2] = Object.assign(label('account-security', '账号安全'), { keepInInbox: true })
    const root = await open(s, '/labels')
    const groups = [...root.querySelectorAll('.label-group')]
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['分拣/金融', '分拣/账号安全', '分拣/出行'])
    expect(groups[0]?.querySelectorAll('.label-card').length).toBe(2)
    expect(groups[0]?.querySelector('.group-name')?.textContent).toContain('2 个标签')
    const security = groups[1]?.querySelector('.label-card')
    const archive = [...(security?.querySelectorAll('label.check') ?? [])].find((node) => node.textContent.startsWith('归档'))?.querySelector('input')
    expect(archive?.checked).toBe(false)
    if (archive) archive.checked = true
    const save = [...(security?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '保存')
    save?.click()
    await settle()
    const patch = s.calls.find((call) => call.method === 'PATCH' && call.path.startsWith('/api/v1/labels/account-security'))
    expect(patch?.path).toContain('keep_in_inbox')
    expect(patch?.path).toContain('sensitive')
    expect(patch?.body?.['keep_in_inbox']).toBeUndefined()
  })

  it('nests a three-level path under its own prefix, not beside its parent’s siblings', async () => {
    const s = server()
    s.labels = [label('life-car-service', '生活/汽车/保养'), label('life-health', '生活/医疗'), label('life-car-insurance', '生活/汽车/保险'), label('travel', '出行')]
    const root = await open(s, '/labels')
    const top = [...root.querySelectorAll('.label-group')]
    expect(top.map((group) => group.getAttribute('aria-label'))).toEqual(['分拣/生活', '分拣/出行'])
    expect(top[0]?.querySelector(':scope > .group-name')?.textContent).toContain('3 个标签')
    const car = top[0]?.querySelector('.label-subgroup')
    expect(car?.getAttribute('aria-label')).toBe('分拣/生活/汽车')
    expect(car?.querySelector('h3')?.textContent).toContain('2 个标签')
    expect([...(car?.querySelectorAll('.label-card strong') ?? [])].map((node) => node.textContent)).toEqual(['分拣/生活/汽车/保养', '分拣/生活/汽车/保险'])
    // 生活/医疗 is a card right under 分拣/生活, beside the 汽车 section.
    const direct = [...(top[0]?.querySelector(':scope > .list.nested')?.children ?? [])].map((node) => node.getAttribute('aria-label') ?? node.querySelector('strong')?.textContent)
    expect(direct).toEqual(['分拣/生活/汽车', '分拣/生活/医疗'])
  })

  it('opens the template’s preview in one click', async () => {
    const s = server()
    const root = await open(s, '/labels')
    buttonNamed(root, '套用推荐模板').click()
    await settle()
    expect(window.location.pathname).toBe('/import')
    expect(s.imports[0]).toMatchObject({ useTemplate: true, validateOnly: true })
    expect(root.textContent).toContain('预览：推荐模板')
    expect(root.textContent).toContain('分拣/账号安全')
    buttonNamed(root, '确认导入').click()
    await settle()
    expect(s.imports[1]).toMatchObject({ useTemplate: true, validateOnly: false })
    expect(String(s.calls.at(-1)?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('导入导出', () => {
  const file = JSON.stringify([
    { id: 'bank-login', match: { from_address: 'statements@bank.example.com' }, label: '分拣/账号安全', keep_in_inbox: true, trust: true, require_dmarc: true, evidence: 'synthetic', notes: '', subject_includes: ['登录'] },
    { id: 'bank', match: { from_domain: 'bank.example.com' }, label: '分拣/金融/银行支付', keep_in_inbox: false, trust: true, require_dmarc: true, evidence: '', notes: '' },
  ])

  it('reads the owner’s rule file strictly and names the entry of a mistake', () => {
    expect(parseImport(file).rules.map((rule) => rule.id)).toEqual(['bank-login', 'bank'])
    expect(parseImport(file).rules[0]).toMatchObject({ keepInInbox: true, subjectIncludes: ['登录'], match: { fromAddress: 'statements@bank.example.com' } })
    expect(parseImport(JSON.stringify({ labels: [{ path: '分拣/出行', description: '行程' }], rules: [] })).labels[0]?.path).toBe('分拣/出行')
    // An export carries each label's switch; a file without it leaves the switch unset (QA D10).
    expect(parseImport(JSON.stringify({ labels: [{ path: '分拣/出行', enabled: false }], rules: [] })).labels[0]?.enabled).toBe(false)
    expect(parseImport(JSON.stringify({ labels: [{ path: '分拣/出行' }], rules: [] })).labels[0]?.enabled).toBeUndefined()
    expect(() => parseImport('[{"id": "x", "match": {"from_adress": "a@example.com"}, "label": "分拣/a"}]')).toThrow(/第 1 个规则/)
    expect(() => parseImport('[{"match": {"from_address": "a@example.com"}, "label": "分拣/a"}]')).toThrow(/第 1 个规则/)
    expect(() => parseImport('{"rules": [], "extra": 1}')).toThrow(/labels 和 rules/)
    expect(() => parseImport('not json')).toThrow('不是有效的 JSON')
    expect(() => parseImport('[]')).toThrow('没有任何标签或规则')
  })

  it('previews pasted JSON, then imports it on 确认导入', async () => {
    const s = server()
    const root = await open(s, '/import')
    const area = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="要导入的 JSON"]')
    if (area === null) throw new Error('no textarea')
    area.value = file
    buttonNamed(root, '预览').click()
    await settle()
    expect(s.imports[0]?.validateOnly).toBe(true)
    expect(s.imports[0]?.rules.map((rule) => rule.id)).toEqual(['bank-login', 'bank'])
    expect(root.querySelectorAll('.import-table tbody tr').length).toBe(2)
    expect(root.textContent).toContain('规则：新建 2')
    buttonNamed(root, '确认导入').click()
    await settle()
    expect(s.imports[1]?.validateOnly).toBe(false)
    expect(root.querySelector('#toast')?.textContent).toContain('已导入')
  })

  it('shows why an entry is invalid and keeps 确认导入 disabled', async () => {
    const s = server()
    const root = await open(s, '/import')
    const area = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="要导入的 JSON"]')
    if (area === null) throw new Error('no textarea')
    area.value = JSON.stringify([{ id: 'two', match: { from_address: 'a@example.com', from_domain: 'example.com' }, label: '分拣/出行' }])
    buttonNamed(root, '预览').click()
    await settle()
    expect(root.textContent).toContain('match 里要有且只有一个')
    expect(buttonNamed(root, '确认导入').disabled).toBe(true)
  })

  it('exports every label and rule as JSON', async () => {
    const s = server()
    const root = await open(s, '/import')
    buttonNamed(root, '导出').click()
    await settle()
    const output = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="导出的 JSON"]')
    expect(output?.hidden).toBe(false)
    expect(output?.value).toContain('"rules"')
    expect(root.querySelector('#toast')?.textContent).toContain('已导出 4 个标签')
  })
})

describe('规则 with subject conditions', () => {
  it('creates a carve-out that keeps its mail in the inbox', async () => {
    const s = server()
    const root = await open(s, '/rules')
    const value = root.querySelector<HTMLInputElement>('input[aria-label="值"]')
    const includes = root.querySelector<HTMLInputElement>('input[aria-label="主题包含"]')
    const keep = root.querySelector<HTMLInputElement>('input[aria-label="留在收件箱"]')
    if (value === null || includes === null || keep === null) throw new Error('no form')
    value.value = 'notice@parcel.example.cn'
    includes.value = '取件码，pickup code'
    keep.checked = true
    buttonNamed(root, '创建').click()
    await settle()
    const rule = s.calls.find((call) => call.method === 'POST' && call.path.startsWith('/api/v1/rules?'))?.body
    expect(rule).toMatchObject({ value: 'notice@parcel.example.cn', subject_includes: ['取件码', 'pickup code'], keep_in_inbox: true })
    expect(root.textContent).toContain('主题包含：取件码、pickup code')
    expect(root.textContent).toContain('留在收件箱')
  })
})
