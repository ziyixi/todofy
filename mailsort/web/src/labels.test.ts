/**
 * 标签 against the fake API (test/fakeServer.ts, the shared transcoder): the tree grouped by top-level segment with one
 * compact row per label (its last 7 days' count and 启用), a row's detail opened inline one at a time, the search over
 * labels' names, the description, 归档, a trust label's trusted domains (删除 each), the examples, the Gmail state,
 * 高级, and a new label, also when there is none yet.
 */
import { mountApp, type Host } from './app.ts'
import { groupByTop, leafName, searchLabels } from './views/labels.ts'
import { example, FakeServer, label, NOW, settle } from './test/fakeServer.ts'
import { Label_GmailState } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { LabelCountSchema } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
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

/**
 * A store like the owner's: two groups, labels of one segment between them, a trust label with a trusted domain; one
 * label with mail this week.
 */
function server(): FakeServer {
  const s = new FakeServer()
  s.labels = [label('dev-ci', '开发/CI通知'), label('dev-platform', '开发/平台工具'), label('account-security', '账号安全'), label('life-car-service', '生活/汽车/保养'), label('life-health', '生活/医疗'), label('travel', '出行')]
  Object.assign(s.labels[0] ?? {}, { exampleCount: 2 })
  Object.assign(s.labels[2] ?? {}, { trustImplying: true, trustedDomains: ['bank.example.com'] })
  s.report = [create(LabelCountSchema, { label: 'labels/dev-ci', autoCount: 12, unsureCount: 1 })]
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
    const paths = ['开发/CI通知', '开发/平台工具', '金融/投资', '金融/银行支付', '账号安全', '政府法律', '购物/订单物流', '购物/促销', '订阅收据', '出行', '生活/账单住房', '生活/汽车', '生活/医疗', '求职', '学校与社群']
    const groups = groupByTop(paths, (path) => path)
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

  it('draws one tree: quiet group headings, one compact row per label with its last 7 days and 启用', async () => {
    const root = await open(server())
    const tree = root.querySelector('ul.tree')
    const top = [...(tree?.children ?? [])].map((node) => (node.classList.contains('branch') ? `${node.querySelector('.branch-name')?.textContent ?? ''} ›` : node.querySelector('.leaf-name > span')?.textContent))
    expect(top).toEqual(['开发 ›', '账号安全', '生活 ›', '出行'])
    const dev = tree?.querySelector('.branch')
    expect([...(dev?.querySelectorAll('.leaf-name > span:first-child') ?? [])].map((node) => node.textContent)).toEqual(['CI通知', '平台工具'])
    expect(row(root, '汽车 › 保养').closest('.branch')?.querySelector('.branch-name')?.textContent).toBe('生活')
    expect(root.querySelector('.tree-head')?.textContent).toBe('6 个标签启用')

    const ci = row(root, 'CI通知')
    // Nothing else on the row: the name, the count of the last 7 days and one switch.
    expect(ci.querySelector('.leaf-count')?.textContent).toBe('7 天 12 封')
    expect(ci.querySelectorAll('.leaf-row input').length).toBe(1)
    expect(ci.querySelector('.leaf-row input')?.getAttribute('aria-label')).toBe('启用：开发/CI通知')
    expect(ci.querySelectorAll('.leaf-row button').length).toBe(1)
    expect(root.textContent).not.toContain('正式打')
    expect(root.textContent).not.toContain('规则')
    // No mail this week, no count.
    expect(row(root, '账号安全').querySelector('.leaf-count')).toBeNull()
  })

  it('still draws the tree when the week cannot be read, without counts', async () => {
    const s = server()
    s.reportFails = true
    const root = await open(s)
    expect(root.querySelectorAll('li.leaf').length).toBe(6)
    expect(root.querySelector('.leaf-count')).toBeNull()
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
    expect([...(detail?.querySelectorAll('h3') ?? [])].map((node) => node.textContent)).toEqual(['例子 2'])
    expect(detail?.querySelector(':scope > details.more > summary')?.textContent).toBe('高级')

    rowButton(root, '出行').click()
    expect(openDetails(root).map((node) => node.getAttribute('aria-label'))).toEqual(['出行'])
    expect(rowButton(root, 'CI通知').getAttribute('aria-expanded')).toBe('false')
    rowButton(root, '出行').click()
    expect(openDetails(root).length).toBe(0)
  })

  it('turns 启用 off and on with only enabled and the etag in the mask, and puts the switch back when refused', async () => {
    const s = server()
    const root = await open(s)
    const enabled = () => row(root, '平台工具').querySelector<HTMLInputElement>('.leaf-row input.switch')
    const flip = (on: boolean) => {
      const node = enabled()
      if (node === null) throw new Error('no switch')
      node.checked = on
      node.dispatchEvent(new Event('change'))
    }
    expect(enabled()?.checked).toBe(true)
    flip(false)
    await settle()
    const patch = s.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('/api/v2/labels/dev-platform?update_mask=enabled,etag')
    expect(patch?.body).toMatchObject({ etag: 'etag-dev-platform' })
    expect(toastText(root)).toBe('开发/平台工具：已停用')
    expect(s.labels.find((item) => item.name === 'labels/dev-platform')?.enabled).toBe(false)
    expect(row(root, '平台工具').querySelector('.leaf-main > .meta')?.textContent).toBe('未启用')
    // The next save carries the new etag: the fake refuses a stale one.
    flip(true)
    await settle()
    expect(toastText(root)).toBe('开发/平台工具：已启用')
    expect(s.labels.find((item) => item.name === 'labels/dev-platform')?.enabled).toBe(true)
    // Changed elsewhere meanwhile: refused, and the switch is as before.
    const changed = s.labels.find((item) => item.name === 'labels/dev-platform')
    if (changed !== undefined) changed.etag = 'elsewhere'
    flip(false)
    await settle()
    expect(toastText(root)).toBe('这一项已在别处修改，请刷新后重试')
    expect(enabled()?.checked).toBe(true)
  })
})

describe('the search', () => {
  it('finds labels by name', () => {
    const s = server()
    expect([...searchLabels(s.labels, '生活')]).toEqual(['labels/life-car-service', 'labels/life-health'])
    expect([...searchLabels(s.labels, 'ci通知')]).toEqual(['labels/dev-ci'])
    expect(searchLabels(s.labels, '  ').size).toBe(6)
  })

  it('filters the tree as one types and clears with Escape', async () => {
    const root = await open(server())
    const search = input(root, '搜索标签')
    search.focus()
    type(search, '生活')
    expect([...root.querySelectorAll('.leaf-name > span:first-child')].map((node) => node.textContent)).toEqual(['汽车 › 保养', '医疗'])
    expect(root.querySelector('.tree-head span')?.textContent).toBe('找到 2 个')
    // The focus stays in the box while the tree repaints.
    expect(document.activeElement).toBe(search)
    type(search, '没有这个')
    expect(root.querySelector('.empty')?.textContent).toBe('没有匹配的标签')
    press(search, 'Escape')
    expect(search.value).toBe('')
    expect(root.querySelectorAll('li.leaf').length).toBe(6)
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

  it('saves 归档 at once: on archives (the default), off keeps the mail in the inbox', async () => {
    const s = server()
    const root = await open(s)
    rowButton(root, '账号安全').click()
    const archive = [...(openDetails(root)[0]?.querySelectorAll(':scope > label.check') ?? [])].find((node) => node.textContent.startsWith('归档'))?.querySelector('input')
    if (archive === undefined || archive === null) throw new Error('no switch')
    expect(archive.checked).toBe(true)
    archive.checked = false
    archive.dispatchEvent(new Event('change'))
    await settle()
    const patch = s.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('update_mask=keep_in_inbox,etag')
    expect(patch?.body).toMatchObject({ keep_in_inbox: true })
    expect(s.labels.find((item) => item.name === 'labels/account-security')?.keepInInbox).toBe(true)
    archive.checked = true
    archive.dispatchEvent(new Event('change'))
    await settle()
    expect(s.labels.find((item) => item.name === 'labels/account-security')?.keepInInbox).toBe(false)
  })

  it('lists a trust label\'s trusted domains, each with 删除, and none for another label', async () => {
    const s = server()
    const root = await open(s)
    rowButton(root, '账号安全').click()
    const part = openDetails(root)[0]?.querySelector('[aria-label="可信域名"]')
    expect(part?.querySelector('h3')?.textContent).toBe('可信域名 1')
    expect([...(part?.querySelectorAll('li p') ?? [])].map((node) => node.textContent)).toEqual(['bank.example.com'])
    // There is no add: the domains are learned from the review queue.
    expect(part?.querySelector('input')).toBeNull()
    part?.querySelector<HTMLButtonElement>('button')?.click()
    await settle()
    const call = s.calls.find((item) => item.path.includes(':removeTrustedDomain'))
    expect(call?.path).toBe('/api/v2/labels/account-security:removeTrustedDomain')
    expect(call?.body).toMatchObject({ domain: 'bank.example.com', etag: 'etag-account-security' })
    expect(toastText(root)).toBe('已删除 bank.example.com')
    expect(openDetails(root)[0]?.querySelector('[aria-label="可信域名"]')?.textContent).toContain('可信域名 0')
    rowButton(root, '出行').click()
    expect(openDetails(root)[0]?.querySelector('[aria-label="可信域名"]')).toBeNull()
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
    expect(s.calls.some((call) => call.path.startsWith('/api/v2/examples'))).toBe(false)
    buttonNamed(part ?? root, '查看').click()
    await settle()
    expect([...(part?.querySelectorAll('.example-list p') ?? [])].map((node) => node.textContent)).toEqual(['火车票 [number] 出票成功', '例子 e2 的摘要'])
    expect(s.calls.find((call) => call.path.startsWith('/api/v2/examples'))?.path).toContain('label=labels%2Ftravel')
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

  it('folds 可信, 敏感 (asking before it deletes examples), rename and delete under 高级, and no threshold', async () => {
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
    // 启用 is on the row only.
    expect([...detail().querySelectorAll('details.more label.check')].map((node) => node.querySelector(':scope > span')?.firstChild?.textContent)).toEqual(['可信', '敏感'])
    // Turned 可信, the label shows its (still empty) trusted domains and says what that means.
    const trust = switchNamed('可信')
    trust.checked = true
    trust.dispatchEvent(new Event('change'))
    await settle()
    expect(detail().querySelector('[aria-label="可信域名"]')?.textContent).toBe('可信域名 0还没有，所以这个标签还不会自动打。在待审里选它、且发件人身份经 Gmail 验证（DMARC 通过）时，发件域会记在这里')
    const sensitive = switchNamed('敏感')
    sensitive.checked = true
    sensitive.dispatchEvent(new Event('change'))
    await settle()
    expect(asked).toEqual(['打开“敏感”会删掉这个标签的 1 个例子，继续？'])
    expect(s.examples.length).toBe(0)
    expect(detail().querySelector('[aria-label="例子"]')?.textContent).toContain('敏感标签不留例子')

    const enabled = row(root, '出行').querySelector<HTMLInputElement>('.leaf-row input.switch')
    if (enabled === null) throw new Error('no switch')
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
    expect(asked.at(-1)).toBe('删除“生活/出行”和它的例子、可信域名？Gmail 里的标签和邮件不变，它打过的标签也不能再撤销。')
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
    expect(s.calls.find((call) => call.method === 'POST' && call.path.startsWith('/api/v2/labels?'))?.body).toMatchObject({ display_name: '求职', enabled: true })
    expect(openDetails(root).map((node) => node.getAttribute('aria-label'))).toEqual(['求职'])
    expect(document.activeElement).toBe(openDetails(root)[0]?.querySelector('textarea'))
    expect(root.querySelector('.new-label')?.textContent).toBe('+ 新标签')
  })
})

describe('no label yet', () => {
  it('offers one quiet + 新标签 and nothing else; the label it makes starts the tree', async () => {
    const s = new FakeServer()
    s.labels = []
    const root = await open(s)
    expect(root.querySelector('.empty strong')?.textContent).toBe('还没有标签')
    expect(root.querySelector('input[type="search"]')).toBeNull()
    expect(root.textContent).not.toContain('推荐模板')
    buttonNamed(root, '+ 新标签').click()
    const path = input(root, '新标签路径')
    path.value = '订阅'
    buttonNamed(root, '创建').click()
    await settle()
    expect(root.querySelectorAll('li.leaf').length).toBe(1)
  })
})
