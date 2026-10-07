/**
 * 标签 against the fake API (test/fakeServer.ts, the shared transcoder): the tree grouped by top-level segment with one
 * compact row per label, a row's detail opened inline one at a time, the search over labels and rules' values,
 * 添加规则 with its kind inferred, 正式打 on the row, the rule menu (one open at a time, 删除 asking first), the
 * description, the examples, the Gmail state, 高级, a new label, and the template offered when there is no label.
 */
import { mountApp, type Host } from './app.ts'
import { groupByTop, leafName, searchLabels } from './views/labels.ts'
import { ruleFor } from './views/label-detail.ts'
import { example, FakeServer, label, NOW, settle, TEMPLATE_PATHS } from './test/fakeServer.ts'
import { Label_GmailState } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { Rule_Kind, Rule_State, RuleSchema, type Rule } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { LabelAccuracySchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { create } from '@ziyixi/proto/protobuf'

const host: Host = { now: () => NOW, confirm: () => true }

async function open(server: FakeServer, with_: Host = host): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', '/labels')
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, with_)
  await settle()
  return root
}

function rule(id: string, labelId: string, kind: Rule_Kind, value: string, init: Partial<Rule> = {}): Rule {
  return Object.assign(create(RuleSchema, { name: `rules/${id}`, kind, value, label: `labels/${labelId}`, state: Rule_State.ACTIVE }), init)
}

/** A store like the owner's: two groups, labels of one segment between them, and a few rules. */
function server(): FakeServer {
  const s = new FakeServer()
  s.labels = [label('dev-ci', '开发/CI通知'), label('dev-platform', '开发/平台工具'), label('account-security', '账号安全'), label('life-car-service', '生活/汽车/保养'), label('life-health', '生活/医疗'), label('travel', '出行')]
  s.rules = [
    rule('r1', 'dev-ci', Rule_Kind.SENDER_ADDRESS, 'notifications@github.com'),
    rule('r2', 'dev-platform', Rule_Kind.SENDER_DOMAIN, 'github.com', { subjectIncludes: ['账单'] }),
    rule('r3', 'dev-ci', Rule_Kind.LIST_ID, 'ci.example.org', { state: Rule_State.PROPOSED, correctionCount: 2 }),
    rule('r4', 'travel', Rule_Kind.SENDER_DOMAIN, 'rail.example.com'),
  ]
  s.accuracy = [create(LabelAccuracySchema, { label: 'labels/dev-ci', confirmedCount: 40, precisionLowerBound: 0.92 }), create(LabelAccuracySchema, { label: 'labels/travel', confirmedCount: 3, correctedCount: 2, precisionLowerBound: 0.3 })]
  return s
}

const toastText = (root: HTMLElement) => root.querySelector('#toast')?.textContent ?? ''

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (found === undefined) throw new Error(`no button ${text}`)
  return found
}

/** The row of the label named `name` in its group (`CI通知`, `汽车 › 保养`). */
function row(root: HTMLElement, name: string): HTMLLIElement {
  const found = [...root.querySelectorAll<HTMLLIElement>('li.leaf')].find((node) => node.querySelector('.leaf-name > span')?.textContent === name)
  if (found === undefined) throw new Error(`no row ${name}`)
  return found
}

function rowButton(root: HTMLElement, name: string): HTMLButtonElement {
  const found = row(root, name).querySelector<HTMLButtonElement>('.leaf-main')
  if (found === null) throw new Error(`no row button ${name}`)
  return found
}

function input(root: ParentNode, name: string): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)
  if (found === null) throw new Error(`no input ${name}`)
  return found
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

const openDetails = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.detail')].filter((node) => !node.hidden)

describe('the tree', () => {
  it('groups paths by their top-level segment, in their order, and names a leaf within its group', () => {
    const groups = groupByTop(TEMPLATE_PATHS, (path) => path)
    expect(groups.map((group) => [group.name, group.members.length])).toEqual([
      ['开发', 2],
      ['金融', 2],
      ['', 2],
      ['购物', 2],
      ['', 2],
      ['生活', 3],
      ['', 2],
    ])
    expect(groupByTop(['生活/医疗', '出行', '生活/汽车'], (path) => path).map((group) => group.members)).toEqual([['生活/医疗', '生活/汽车'], ['出行']])
    expect(leafName('生活/汽车/保养', '生活')).toBe('汽车 › 保养')
    expect(leafName('出行', '')).toBe('出行')
  })

  it('draws one tree: quiet group headings, one compact row per label with its rule count, a precision bar and 正式打', async () => {
    const root = await open(server())
    const tree = root.querySelector('ul.tree')
    const top = [...(tree?.children ?? [])].map((node) => (node.classList.contains('branch') ? `${node.querySelector('.branch-name')?.textContent ?? ''} ›` : node.querySelector('.leaf-name > span')?.textContent))
    expect(top).toEqual(['开发 ›', '账号安全', '生活 ›', '出行'])
    const dev = tree?.querySelector('.branch')
    expect([...(dev?.querySelectorAll('.leaf-name > span:first-child') ?? [])].map((node) => node.textContent)).toEqual(['CI通知', '平台工具'])
    expect(row(root, '汽车 › 保养').closest('.branch')?.querySelector('.branch-name')?.textContent).toBe('生活')
    expect(root.querySelector('.tree-head')?.textContent).toBe('6 个标签正式打')

    const ci = row(root, 'CI通知')
    // Nothing else on the row: the name, the count (a dot for the proposal), the bar, and one switch.
    expect(ci.querySelector('.leaf-count')?.textContent).toContain('2 条规则')
    expect(ci.querySelector('.leaf-count .dot')?.getAttribute('title')).toBe('1 条待批准')
    expect(ci.querySelector('.bar-slot')?.getAttribute('title')).toBe('准确率 92% · 40 封')
    expect(ci.querySelectorAll('.leaf-row input').length).toBe(1)
    expect(ci.querySelector('.leaf-row input')?.getAttribute('aria-label')).toBe('正式打：开发/CI通知')
    expect(ci.querySelectorAll('.leaf-row button').length).toBe(1)
    // Below the target: the warning tone. Without verdicts: an empty slot keeps the column.
    expect(row(root, '出行').querySelector('.bar.warn')).not.toBeNull()
    expect(row(root, '账号安全').querySelector('.bar')).toBeNull()
    // No rule, no count.
    expect(row(root, '账号安全').querySelector('.leaf-count')).toBeNull()
  })

  it('still draws the rows when the accuracy report fails', async () => {
    const s = server()
    s.accuracyFails = true
    const root = await open(s)
    expect(root.querySelectorAll('li.leaf').length).toBe(6)
    expect(root.querySelector('.bar')).toBeNull()
  })
})

describe('a row', () => {
  it('says on the row when Gmail holds its name or lost the label', async () => {
    const s = server()
    s.labels[2]!.gmailState = Label_GmailState.NAME_TAKEN
    s.labels[5]!.gmailState = Label_GmailState.MISSING
    const root = await open(s)
    expect(row(root, '账号安全').querySelector('.leaf-main > .meta.warn')?.textContent).toBe('同名已占用')
    expect(row(root, '出行').querySelector('.leaf-main > .meta.warn')?.textContent).toBe('Gmail 中已删除')
    expect(row(root, 'CI通知').querySelector('.leaf-main > .meta.warn')).toBeNull()
  })

  it('opens its detail inline, one at a time, and closes again', async () => {
    const root = await open(server())
    expect(openDetails(root).length).toBe(0)
    rowButton(root, 'CI通知').click()
    expect(openDetails(root).length).toBe(1)
    expect(rowButton(root, 'CI通知').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(rowButton(root, 'CI通知'))
    const detail = openDetails(root)[0]
    expect(detail?.getAttribute('aria-label')).toBe('开发/CI通知')
    expect(detail?.querySelector('textarea')?.value).toBe('开发/CI通知 的说明')
    expect([...(detail?.querySelectorAll('h3') ?? [])].map((node) => node.textContent)).toEqual(['规则 2', '例子 0'])
    expect(detail?.querySelector(':scope > details.more > summary')?.textContent).toBe('高级')

    rowButton(root, '出行').click()
    expect(openDetails(root).map((node) => node.getAttribute('aria-label'))).toEqual(['出行'])
    expect(rowButton(root, 'CI通知').getAttribute('aria-expanded')).toBe('false')
    rowButton(root, '出行').click()
    expect(openDetails(root).length).toBe(0)
  })

  it('turns 正式打 on and off with only live and the etag in the mask, and puts the switch back when refused', async () => {
    const s = server()
    const root = await open(s)
    const live = () => row(root, '平台工具').querySelector<HTMLInputElement>('.leaf-row input.switch')
    const flip = (on: boolean) => {
      const node = live()
      if (node === null) throw new Error('no switch')
      node.checked = on
      node.dispatchEvent(new Event('change'))
    }
    flip(true)
    await settle()
    const patch = s.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('/api/v1/labels/dev-platform?update_mask=live,etag')
    expect(patch?.body).toMatchObject({ live: true, etag: 'etag-dev-platform' })
    expect(toastText(root)).toBe('开发/平台工具：正式打已开')
    expect(s.labels.find((item) => item.name === 'labels/dev-platform')?.live).toBe(true)
    // The next save carries the new etag: the fake refuses a stale one.
    flip(false)
    await settle()
    expect(toastText(root)).toBe('开发/平台工具：正式打已关')
    expect(s.labels.find((item) => item.name === 'labels/dev-platform')?.live).toBe(false)
    // Changed elsewhere meanwhile: refused, and the switch is as before.
    const changed = s.labels.find((item) => item.name === 'labels/dev-platform')
    if (changed !== undefined) changed.etag = 'elsewhere'
    flip(true)
    await settle()
    expect(toastText(root)).toBe('这一项已在别处修改，请刷新后重试')
    expect(live()?.checked).toBe(false)
  })
})

describe('the search', () => {
  it('finds labels by name and by their rules’ values', () => {
    const s = server()
    expect([...searchLabels(s.labels, s.rules, 'GitHub')].map(([name, hits]) => [name, hits.map((item) => item.value)])).toEqual([
      ['labels/dev-ci', ['notifications@github.com']],
      ['labels/dev-platform', ['github.com']],
    ])
    expect([...searchLabels(s.labels, s.rules, '生活').keys()]).toEqual(['labels/life-car-service', 'labels/life-health'])
    expect(searchLabels(s.labels, s.rules, '  ').size).toBe(6)
  })

  it('filters the tree as one types, names the values it found, marks them in the detail, and clears with Escape', async () => {
    const root = await open(server())
    const search = input(root, '搜索标签或规则')
    search.focus()
    type(search, 'github')
    expect([...root.querySelectorAll('.leaf-name > span:first-child')].map((node) => node.textContent)).toEqual(['CI通知', '平台工具'])
    expect(row(root, 'CI通知').querySelector('.leaf-hit')?.textContent).toBe('notifications@github.com')
    expect(root.querySelector('.tree-head span')?.textContent).toBe('找到 2 个')
    // The focus stays in the box while the tree repaints.
    expect(document.activeElement).toBe(search)
    rowButton(root, '平台工具').click()
    const hit = openDetails(root)[0]?.querySelector('.rule.hit')
    expect(hit?.querySelector('.rule-value')?.textContent).toBe('github.com')
    expect(hit?.textContent).toContain('含 账单')

    type(search, 'rail.example')
    expect([...root.querySelectorAll('li.leaf')].length).toBe(1)
    type(search, '没有这个')
    expect(root.querySelector('.empty')?.textContent).toBe('没有匹配的标签或规则')
    press(search, 'Escape')
    expect(search.value).toBe('')
    expect(root.querySelectorAll('li.leaf').length).toBe(6)
  })
})

describe('添加规则', () => {
  it('infers the kind from the one value', () => {
    expect(ruleFor(' noreply@github.com ', 'auto')).toEqual({ kind: Rule_Kind.SENDER_ADDRESS, value: 'noreply@github.com' })
    expect(ruleFor('GitHub <noreply@github.com>', 'auto')).toEqual({ kind: Rule_Kind.SENDER_ADDRESS, value: 'noreply@github.com' })
    expect(ruleFor('github.com', 'auto')).toEqual({ kind: Rule_Kind.SENDER_DOMAIN, value: 'github.com' })
    expect(ruleFor('@github.com', 'auto')).toEqual({ kind: Rule_Kind.SENDER_DOMAIN, value: 'github.com' })
    expect(ruleFor('News <digest.news.example.com>', 'auto')).toEqual({ kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com' })
    expect(ruleFor('digest.news.example.com', 'list')).toEqual({ kind: Rule_Kind.LIST_ID, value: 'digest.news.example.com' })
    expect(ruleFor('me+shop@example.com', 'to')).toEqual({ kind: Rule_Kind.DELIVERED_TO, value: 'me+shop@example.com' })
  })

  it('adds a rule from one field, shows its kind as typed, and keeps the field ready for the next', async () => {
    const s = server()
    const root = await open(s)
    rowButton(root, '账号安全').click()
    const field = input(root, '添加规则')
    const kind = field.parentElement?.querySelector<HTMLElement>('.chip')
    expect(kind?.hidden).toBe(true)
    type(field, 'security@example.com')
    expect(kind?.textContent).toBe('发件人')
    type(field, 'example.com')
    expect(kind?.textContent).toBe('域名')
    type(field, 'security@example.com')
    press(field, 'Enter')
    // Locked while it is sent: a second Enter (or more typing) does not send it twice.
    expect(field.readOnly).toBe(true)
    press(field, 'Enter')
    await settle()
    expect(s.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/api/v1/rules?')).length).toBe(1)
    const post = s.calls.find((call) => call.method === 'POST' && call.path.startsWith('/api/v1/rules?'))
    expect(post?.body).toMatchObject({ kind: 'sender_address', value: 'security@example.com', label: 'labels/account-security' })
    expect(post?.body?.['subject_includes']).toBeUndefined()
    expect(toastText(root)).toBe('规则已添加')
    // The detail stayed open with the new rule, the row counts it, and the field is empty and focused again.
    const detail = openDetails(root)[0]
    expect(detail?.querySelector('.rule .rule-value')?.textContent).toBe('security@example.com')
    expect(row(root, '账号安全').querySelector('.leaf-count')?.textContent).toBe('1 条规则')
    expect(document.activeElement).toBe(input(root, '添加规则'))
    expect(input(root, '添加规则').value).toBe('')
  })

  it('takes the kind and the subject words from 更多; 留在收件箱 is the label’s own switch only', async () => {
    const s = server()
    const root = await open(s)
    rowButton(root, '出行').click()
    const detail = openDetails(root)[0]
    if (detail === undefined) throw new Error('no detail')
    const more = [...detail.querySelectorAll<HTMLDetailsElement>('details.more')].find((node) => node.querySelector('summary')?.textContent === '更多')
    expect(more?.open).toBe(false)
    buttonNamed(detail, '收件地址').click()
    // The choice is drawn again and keeps the focus.
    expect(document.activeElement?.textContent).toBe('收件地址')
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true')
    type(input(detail, '添加规则'), 'me+travel@example.com')
    expect(detail.querySelector('.add-rule .chip')?.textContent).toBe('收件地址')
    type(input(detail, '主题包含'), '取件码，pickup code')
    type(input(detail, '主题不含'), '广告')
    expect(detail.querySelector('.add-rule label.check')).toBeNull()
    expect(input(detail, '添加规则').placeholder).toBe('发件地址或域名')
    buttonNamed(detail, '添加').click()
    await settle()
    const post = s.calls.find((call) => call.method === 'POST' && call.path.startsWith('/api/v1/rules?'))
    expect(post?.body).toMatchObject({ kind: 'delivered_to', value: 'me+travel@example.com', subject_includes: ['取件码', 'pickup code'], subject_excludes: ['广告'] })
    expect(post?.body?.['keep_in_inbox']).toBeUndefined()
    const added = [...(openDetails(root)[0]?.querySelectorAll('.rule') ?? [])].find((node) => node.textContent.includes('me+travel@example.com'))
    expect([...(added?.querySelectorAll('.chip') ?? [])].map((node) => node.textContent)).toEqual(['收件地址', '含 取件码', '含 pickup code', '不含 广告'])
  })

  it('still names a rule that keeps its mail in the inbox (an imported one)', async () => {
    const s = server()
    s.rules.push(rule('r5', 'travel', Rule_Kind.SENDER_ADDRESS, 'pickup@rail.example.com', { keepInInbox: true }))
    const root = await open(s)
    rowButton(root, '出行').click()
    const kept = [...(openDetails(root)[0]?.querySelectorAll('.rule') ?? [])].find((node) => node.textContent.includes('pickup@rail.example.com'))
    expect([...(kept?.querySelectorAll('.chip') ?? [])].map((node) => node.textContent)).toEqual(['发件人', '留在收件箱'])
  })
})

describe('the rules of a label', () => {
  it('lists the proposal first with 批准, and keeps 停用 / 启用 / 删除 (asking first) behind ⋯', async () => {
    const s = server()
    const asked: string[] = []
    let answer = false
    const root = await open(s, { now: () => NOW, confirm: (message) => (asked.push(message), answer) })
    rowButton(root, 'CI通知').click()
    const lines = () => [...(openDetails(root)[0]?.querySelectorAll<HTMLLIElement>('.rule') ?? [])]
    expect(lines().map((node) => node.querySelector('.rule-value')?.textContent)).toEqual(['ci.example.org', 'notifications@github.com'])
    const [proposal, active] = lines()
    expect(proposal?.querySelector('.chip.accent')?.textContent).toBe('待批准')
    // An active rule shows no action until ⋯ is pressed.
    const opener = active?.querySelector<HTMLButtonElement>('.menu > button')
    expect(opener?.getAttribute('aria-label')).toBe('规则 notifications@github.com 的操作')
    expect(active?.querySelector<HTMLElement>('.menu-items')?.hidden).toBe(true)
    opener?.click()
    expect(opener?.getAttribute('aria-expanded')).toBe('true')
    expect([...(active?.querySelectorAll('.menu-items button') ?? [])].map((node) => node.textContent)).toEqual(['停用', '删除'])
    expect(document.activeElement?.textContent).toBe('停用')
    press(document.activeElement ?? root, 'Escape')
    expect(active?.querySelector<HTMLElement>('.menu-items')?.hidden).toBe(true)
    expect(document.activeElement).toBe(opener)

    buttonNamed(proposal ?? root, '批准').click()
    await settle()
    expect(s.rules.find((item) => item.name === 'rules/r3')?.state).toBe(Rule_State.ACTIVE)
    expect(toastText(root)).toBe('规则已生效')
    expect(row(root, 'CI通知').querySelector('.dot')).toBeNull()

    const github = lines().find((node) => node.textContent.includes('notifications@github.com'))
    github?.querySelector<HTMLButtonElement>('.menu > button')?.click()
    buttonNamed(github ?? root, '停用').click()
    await settle()
    const stopped = lines().find((node) => node.textContent.includes('notifications@github.com'))
    expect(stopped?.classList.contains('off')).toBe(true)
    expect(stopped?.textContent).toContain('已停用')
    stopped?.querySelector<HTMLButtonElement>('.menu > button')?.click()
    expect([...(stopped?.querySelectorAll('.menu-items button') ?? [])].map((node) => node.textContent)).toEqual(['启用', '删除'])
    // Refused: nothing is sent.
    buttonNamed(stopped ?? root, '删除').click()
    await settle()
    expect(asked).toEqual(['删除规则 notifications@github.com？'])
    expect(s.calls.some((call) => call.method === 'DELETE')).toBe(false)
    answer = true
    stopped?.querySelector<HTMLButtonElement>('.menu > button')?.click()
    buttonNamed(stopped ?? root, '删除').click()
    await settle()
    expect(s.rules.some((item) => item.name === 'rules/r1')).toBe(false)
    expect(lines().map((node) => node.querySelector('.rule-value')?.textContent)).toEqual(['ci.example.org'])
  })

  it('keeps one ⋯ menu open at a time, and closes it on a click elsewhere or a key that takes the focus out of it', async () => {
    const root = await open(server())
    rowButton(root, 'CI通知').click()
    const [proposal, active] = [...(openDetails(root)[0]?.querySelectorAll<HTMLLIElement>('.rule') ?? [])]
    const opener = (line: HTMLLIElement | undefined) => {
      const found = line?.querySelector<HTMLButtonElement>('.menu > button')
      if (found === null || found === undefined) throw new Error('no menu')
      return found
    }
    const isOpen = (line: HTMLLIElement | undefined) => line?.querySelector<HTMLElement>('.menu-items')?.hidden === false
    opener(active).click()
    opener(proposal).click()
    expect([isOpen(proposal), isOpen(active)]).toEqual([true, false])
    expect(opener(active).getAttribute('aria-expanded')).toBe('false')
    document.body.click()
    expect(isOpen(proposal)).toBe(false)
    // A click inside it, between its actions, leaves it open; one on the rest of the line does not.
    opener(active).click()
    active?.querySelector('.menu-items')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(isOpen(active)).toBe(true)
    active?.querySelector('.rule-value')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(isOpen(active)).toBe(false)
    opener(active).click()
    // A key within it (the focus is on its first action) leaves it open; Tab out of it does not.
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }))
    expect(isOpen(active)).toBe(true)
    const area = openDetails(root)[0]?.querySelector('textarea')
    area?.focus()
    area?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }))
    expect(isOpen(active)).toBe(false)
  })
})

describe('the detail', () => {
  it('saves the description on blur with only it and the etag in the mask', async () => {
    const s = server()
    const root = await open(s)
    rowButton(root, '出行').click()
    const area = openDetails(root)[0]?.querySelector('textarea')
    if (area === undefined || area === null) throw new Error('no description')
    const save = area.parentElement?.querySelector('button')
    expect(save?.hidden).toBe(true)
    type(area, '火车、机票、酒店的订单与行程变更')
    expect(save?.hidden).toBe(false)
    area.dispatchEvent(new Event('blur'))
    await settle()
    const patch = s.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('update_mask=description,etag')
    expect(patch?.body).toMatchObject({ description: '火车、机票、酒店的订单与行程变更' })
    expect(toastText(root)).toBe('说明已保存')
    expect(save?.hidden).toBe(true)
    // Blurring again without a change sends nothing.
    area.dispatchEvent(new Event('blur'))
    await settle()
    expect(s.calls.filter((call) => call.method === 'PATCH').length).toBe(1)
  })

  it('saves 留在收件箱 at once', async () => {
    const s = server()
    const root = await open(s)
    rowButton(root, '账号安全').click()
    const keep = [...(openDetails(root)[0]?.querySelectorAll(':scope > label.check') ?? [])].find((node) => node.textContent.startsWith('留在收件箱'))?.querySelector('input')
    if (keep === undefined || keep === null) throw new Error('no switch')
    keep.checked = true
    keep.dispatchEvent(new Event('change'))
    await settle()
    expect(decodeURIComponent(s.calls.find((call) => call.method === 'PATCH')?.path ?? '')).toContain('update_mask=keep_in_inbox,etag')
    expect(s.labels.find((item) => item.name === 'labels/account-security')?.keepInInbox).toBe(true)
  })

  it('lists the examples on demand and deletes one', async () => {
    const s = server()
    const travel = s.labels.find((item) => item.name === 'labels/travel')
    if (travel !== undefined) travel.exampleCount = 2
    s.examples = [example('e1', 'travel', '火车票 [number] 出票成功'), example('e2', 'travel')]
    const root = await open(s)
    rowButton(root, '出行').click()
    const part = openDetails(root)[0]?.querySelector('[aria-label="例子"]')
    expect(part?.querySelector('h3')?.textContent).toBe('例子 2')
    expect(s.calls.some((call) => call.path.startsWith('/api/v1/examples'))).toBe(false)
    buttonNamed(part ?? root, '查看').click()
    await settle()
    expect([...(part?.querySelectorAll('.example-list p') ?? [])].map((node) => node.textContent)).toEqual(['火车票 [number] 出票成功', '例子 e2 的摘要'])
    expect(s.calls.find((call) => call.path.startsWith('/api/v1/examples'))?.path).toContain('label=labels%2Ftravel')
    part?.querySelector<HTMLButtonElement>('.example-list button')?.click()
    await settle()
    expect(s.examples.map((item) => item.name)).toEqual(['examples/e2'])
    expect(part?.querySelector('h3')?.textContent).toBe('例子 1')
    expect(toastText(root)).toBe('例子已删除')
  })

  it('says first, in one line, when Gmail takes nothing from the label: its name is taken there, or its label is gone', async () => {
    const s = server()
    const states: Readonly<Record<string, Label_GmailState>> = { 'labels/travel': Label_GmailState.NAME_TAKEN, 'labels/account-security': Label_GmailState.MISSING, 'labels/life-health': Label_GmailState.PENDING }
    for (const item of s.labels) item.gmailState = states[item.name] ?? item.gmailState
    const root = await open(s)
    const opened = (name: string) => {
      rowButton(root, name).click()
      const detail = openDetails(root)[0]
      if (detail === undefined) throw new Error('no detail')
      return detail
    }
    const taken = opened('出行')
    expect(taken.firstElementChild?.matches('p.hint.warn[role="note"]')).toBe(true)
    expect(taken.firstElementChild?.textContent).toBe('Gmail 里已有同名标签，改个名字或到 设置 → 从 Gmail 同步 沿用')
    // Said once: 高级 does not repeat it.
    expect(taken.querySelector(':scope > details.more')?.textContent).not.toContain('Gmail')
    expect(opened('账号安全').firstElementChild?.textContent).toBe('Gmail 里已没有这个标签，不再打它；在 Gmail 建回同名标签后到 设置 → 从 Gmail 同步')
    // A label not in Gmail yet says so quietly under 高级; a linked one says nothing about Gmail.
    const pending = opened('医疗')
    expect(pending.querySelector('p.warn')).toBeNull()
    expect(pending.querySelector(':scope > details.more p.hint')?.textContent).toBe('Gmail：尚未创建')
    expect(opened('CI通知').textContent).not.toContain('Gmail')
  })

  it('folds 可信, 敏感 (asking before it deletes examples), 启用, rename and delete under 高级, and no threshold', async () => {
    const s = server()
    const travel = s.labels.find((item) => item.name === 'labels/travel')
    if (travel !== undefined) travel.exampleCount = 1
    s.examples = [example('e1', 'travel')]
    const asked: string[] = []
    const root = await open(s, { now: () => NOW, confirm: (message) => (asked.push(message), true) })
    rowButton(root, '出行').click()
    const detail = () => openDetails(root)[0] ?? root
    const advanced = detail().querySelector<HTMLDetailsElement>(':scope > details.more')
    expect(advanced?.open).toBe(false)
    expect(advanced?.querySelector('input[type="number"]')).toBeNull()
    expect(advanced?.textContent).not.toContain('阈值')
    if (advanced) advanced.open = true
    advanced?.dispatchEvent(new Event('toggle'))
    const switchNamed = (name: string) => {
      const found = [...detail().querySelectorAll('details.more label.check')].find((node) => node.querySelector(':scope > span')?.firstChild?.textContent === name)?.querySelector('input')
      if (found === undefined || found === null) throw new Error(`no switch ${name}`)
      return found
    }
    const sensitive = switchNamed('敏感')
    sensitive.checked = true
    sensitive.dispatchEvent(new Event('change'))
    await settle()
    expect(asked).toEqual(['打开“敏感”会删掉这个标签的 1 个例子，继续？'])
    expect(s.examples.length).toBe(0)
    expect(detail().querySelector('[aria-label="例子"]')?.textContent).toContain('敏感标签不留例子')

    const enabled = switchNamed('启用')
    enabled.checked = false
    enabled.dispatchEvent(new Event('change'))
    await settle()
    // Off is said in words on the row, not by its gray alone.
    expect(row(root, '出行').classList.contains('off')).toBe(true)
    expect(row(root, '出行').querySelector('.leaf-main > .meta')?.textContent).toBe('未启用')

    // A rename moves the label in the tree; it stays open with 高级 open and the focus on the path.
    const path = input(detail(), '路径')
    path.value = '生活/出行'
    buttonNamed(detail(), '改名').click()
    await settle()
    expect(decodeURIComponent(s.calls.filter((call) => call.method === 'PATCH').at(-1)?.path ?? '')).toContain('update_mask=display_name,etag')
    expect(row(root, '出行').closest('.branch')?.querySelector('.branch-name')?.textContent).toBe('生活')
    expect(detail().querySelector<HTMLDetailsElement>(':scope > details.more')?.open).toBe(true)
    expect(document.activeElement).toBe(input(detail(), '路径'))

    buttonNamed(detail(), '删除标签').click()
    await settle()
    expect(asked.at(-1)).toBe('删除“生活/出行”和它的规则、例子？Gmail 里的标签和邮件不变，它打过的标签也不能再撤销。')
    expect(s.labels.some((item) => item.name === 'labels/travel')).toBe(false)
    expect(root.querySelectorAll('li.leaf').length).toBe(5)
    expect(openDetails(root).length).toBe(0)
  })
})

describe('a new label', () => {
  it('is one quiet button; the label it creates opens with its description focused', async () => {
    const s = server()
    const root = await open(s)
    expect(root.querySelector('.new-label')?.textContent).toBe('+ 新标签')
    buttonNamed(root, '+ 新标签').click()
    const path = input(root, '新标签路径')
    expect(document.activeElement).toBe(path)
    path.value = '求职'
    press(path, 'Enter')
    await settle()
    expect(s.calls.find((call) => call.method === 'POST' && call.path.startsWith('/api/v1/labels?'))?.body).toMatchObject({ display_name: '求职', enabled: true })
    expect(openDetails(root).map((node) => node.getAttribute('aria-label'))).toEqual(['求职'])
    expect(document.activeElement).toBe(openDetails(root)[0]?.querySelector('textarea'))
    expect(root.querySelector('.new-label')?.textContent).toBe('+ 新标签')
  })
})

describe('no label yet', () => {
  it('offers the template: a preview of its 15 labels, then 添加这些标签', async () => {
    const s = new FakeServer()
    s.labels = []
    const root = await open(s)
    expect(root.querySelector('.empty strong')?.textContent).toBe('还没有标签')
    expect(root.querySelector('input[type="search"]')).toBeNull()
    buttonNamed(root, '套用推荐模板').click()
    await settle()
    const preview = s.calls.find((call) => call.path === '/api/v1/rules:import')
    expect(preview?.body).toMatchObject({ use_template: true, validate_only: true })
    expect(s.labels.length).toBe(0)
    const card = root.querySelector('.card')
    expect(card?.querySelector('.card-head')?.textContent).toBe('推荐模板15 个标签')
    const lines = [...(card?.querySelectorAll('.template li') ?? [])].map((node) => node.textContent)
    expect(lines.slice(0, 3)).toEqual(['开发CI通知 · 平台工具', '金融投资 · 银行支付', '账号安全'])
    expect(lines.length).toBe(10)
    expect(document.activeElement?.textContent).toBe('添加这些标签')
    // One primary action at a time: the offer waits while its preview is shown.
    expect(buttonNamed(root, '套用推荐模板').hidden).toBe(true)

    buttonNamed(root, '添加这些标签').click()
    await settle()
    const applied = s.calls.filter((call) => call.path === '/api/v1/rules:import').at(-1)
    expect(applied?.body?.['validate_only']).toBeUndefined()
    expect(String(applied?.body?.['request_id'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(toastText(root)).toBe('已添加 15 个标签')
    expect(root.querySelectorAll('li.leaf').length).toBe(15)
    expect(document.activeElement).toBe(input(root, '搜索标签或规则'))
  })

  it('lets one cancel the preview, or make a label of one’s own', async () => {
    const s = new FakeServer()
    s.labels = []
    const root = await open(s)
    buttonNamed(root, '套用推荐模板').click()
    await settle()
    expect(buttonNamed(root, '套用推荐模板').hidden).toBe(true)
    buttonNamed(root, '取消').click()
    expect(root.querySelector('.template')).toBeNull()
    expect(buttonNamed(root, '套用推荐模板').hidden).toBe(false)
    expect(document.activeElement?.textContent).toBe('套用推荐模板')
    buttonNamed(root, '+ 新标签').click()
    const path = input(root, '新标签路径')
    path.value = '订阅'
    buttonNamed(root, '创建').click()
    await settle()
    expect(root.querySelectorAll('li.leaf').length).toBe(1)
    expect(s.calls.filter((call) => call.path === '/api/v1/rules:import').length).toBe(1)
  })
})
