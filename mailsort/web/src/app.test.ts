/** The shell, read-only model history, mode settings and range undo, through the shared API. */
import { mountApp, type Host } from './app.ts'
import { relative } from './format.ts'
import { FakeServer, flowCount, label, ledgerEntry, NOW, reviewItem, settle } from './test/fakeServer.ts'
import { MailFlow_Outcome, MailFlow_Stage } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import { ReplayEvaluation_State, ReplayEvaluationSchema } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { Mode, ServiceStatus_AuthState } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'

const host: Host = { now: () => NOW, confirm: () => true }

async function open(server: FakeServer, path: string, with_: Host = host): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, with_)
  await settle()
  return root
}

const toastText = (root: HTMLElement) => root.querySelector('#toast')?.textContent ?? ''

function buttonNamed(root: ParentNode, text: string, index = 0): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].filter((node) => node.textContent === text)
  const button = found[index]
  if (button === undefined) throw new Error(`no button ${text}`)
  return button
}

describe('the shell', () => {
  it('uses P1-P4 names in review, charts, reports, undo options and replay results', async () => {
    const server = new FakeServer()
    server.labels = [label('p1', 'P1'), label('p2', 'P2'), label('p3', 'P3'), label('p4', 'P4')]
    server.reviewItems = [reviewItem('a')]
    server.flow = [flowCount(MailFlow_Stage.CLEF, MailFlow_Outcome.ARCHIVED, 'labels/p2', 2)]
    server.replay = create(ReplayEvaluationSchema, { name: 'replayEvaluation', state: ReplayEvaluation_State.SUCCEEDED, totalCount: 1, evaluatedCount: 1, autoCount: 1, mismatches: [{ decidedLabel: 'labels/p2', ownerLabel: 'labels/p3', mailCount: 1 }] })
    const root = await open(server, '/review')
    expect(root.querySelector('.rows')?.textContent).toContain('P2')
    const navigate = async (path: string) => {
      root.querySelector<HTMLAnchorElement>(`.tabs a[href="${path}"]`)?.click()
      await settle()
      expect(root.textContent).not.toContain('旧主题')
    }
    await navigate('/overview')
    expect(root.querySelector('.flow-legend')?.textContent).toContain('P2')
    expect(root.querySelector('.report')?.textContent).toContain('P3')
    await navigate('/settings')
    expect([...root.querySelectorAll('select[aria-label="分级"] option')].map((node) => node.textContent)).toEqual(['全部分级', 'P1', 'P2', 'P3', 'P4'])
    expect(root.querySelector('.replay-mismatches')?.textContent).toContain('P2 → 你的回答：P3')
    await navigate('/labels')
    expect([...root.querySelectorAll('.leaf-name')].map((node) => node.textContent)).toEqual(['P1', 'P2', 'P3', 'P4'])
  })

  it('opens overview by default without reading a review queue', async () => {
    const server = new FakeServer()
    const root = await open(server, '/')
    expect(root.querySelector('h1')?.textContent).toBe('概览')
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('概览')
    expect(server.calls.some((call) => call.path.includes('reviewItems'))).toBe(false)
  })

  it('has exactly three tabs, the quiet status line, and answers an unknown path', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b'), reviewItem('c')]
    const root = await open(server, '/nowhere')
    const tabs = [...root.querySelectorAll<HTMLAnchorElement>('.tabs a')]
    expect(tabs.map((a) => a.firstChild?.textContent)).toEqual(['概览', '分级', '设置'])
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual(['/overview', '/labels', '/settings'])
    expect(root.querySelector('.tabs .chip')).toBeNull()
    const line = root.querySelector('.status-line')
    expect([...(line?.children ?? [])].map((part) => part.textContent)).toEqual(['影子', 'Gmail ✓ 只读', '下次 Gmail 维护 5 分钟后'])
    expect(root.textContent).toContain('找不到这个页面')
  })

  it('says what is wrong with Gmail instead of the check mark, and badges the live mode', async () => {
    const server = new FakeServer()
    server.status = { authState: ServiceStatus_AuthState.FAILED, effectiveMode: Mode.LIVE }
    const root = await open(server, '/settings')
    expect(root.querySelector('.status-line .chip.accent')?.textContent).toBe('正式')
    expect(root.querySelector('.status-line .problem')?.textContent).toBe('Gmail 授权失效')
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('设置')
  })

  it('keeps the focus on a tab chosen by keyboard: the tabs are only marked, never drawn again', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a')]
    const root = await open(server, '/review')
    const overview = root.querySelector<HTMLAnchorElement>('.tabs a[href="/overview"]')
    if (overview === null) throw new Error('no tab')
    overview.focus()
    overview.click()
    await settle()
    expect(overview.isConnected).toBe(true)
    expect(document.activeElement).toBe(overview)
    expect(overview.getAttribute('aria-current')).toBe('page')
    expect(root.querySelectorAll('.tabs a[aria-current]').length).toBe(1)
  })

  it('says 马上 for a time less than a minute ahead, 刚刚 for one just past', () => {
    expect(relative(timestampFromMs(NOW + 20_000), NOW)).toBe('马上')
    expect(relative(timestampFromMs(NOW - 20_000), NOW)).toBe('刚刚')
    expect(relative(timestampFromMs(NOW + 300_000), NOW)).toBe('5 分钟后')
    expect(relative(timestampFromMs(NOW - 3 * 3_600_000), NOW)).toBe('3 小时前')
  })

  it('moves between tabs without reloading; 规则 has no page of its own any more', async () => {
    const server = new FakeServer()
    const root = await open(server, '/rules')
    expect(root.textContent).toContain('找不到这个页面')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/labels"]')?.click()
    await settle()
    expect(window.location.pathname).toBe('/labels')
    expect(root.querySelector('.tabs a[aria-current="page"]')?.textContent).toBe('分级')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/overview"]')?.click()
    await settle()
    expect(window.location.pathname).toBe('/overview')
    expect(root.querySelector('h1')?.textContent).toBe('概览')
  })
})

describe('historical review', () => {
  it('shows legacy records and candidates without learning or mutation controls', async () => {
    const server = new FakeServer()
    server.reviewItems = [reviewItem('a'), reviewItem('b', { reason: 'model_unavailable', candidates: [] })]
    const root = await open(server, '/review')
    expect(root.querySelector('h1')?.textContent).toBe('历史待审记录')
    expect(root.querySelectorAll('ul.rows > li')).toHaveLength(2)
    expect(root.querySelector('.rows')?.textContent).toContain('主题 a')
    expect(root.querySelector('.rows')?.textContent).toContain('旧模型候选：P2 60%')
    expect(root.querySelector('.rows')?.textContent).toContain('模型暂不可用')
    expect(root.querySelector('#view')?.textContent).toContain('不再从确认或纠正中学习')
    expect(root.querySelectorAll('#view button, #view input, #view select')).toHaveLength(0)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    await settle()
    expect(server.calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('reports empty historical records without promising an uncertainty fallback', async () => {
    const root = await open(new FakeServer(), '/review')
    expect(root.querySelector('.empty strong')?.textContent).toBe('没有历史待审记录')
    expect(root.textContent).not.toContain('拿不准的邮件已归 P1')
    expect(root.querySelector('.tabs a .chip')).toBeNull()
  })
})

describe('设置', () => {
  it('has mode, undo and read-only model history', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect([...root.querySelectorAll('h2')].map((node) => node.textContent)).toEqual(['模式', '分类引擎', '自动分类间隔', '分类提示词', '撤销', '历史效果检查'])
    expect(root.querySelectorAll('input[type="number"]').length).toBe(0)
    expect(root.querySelector('[aria-label="模式"] [aria-pressed="true"]')?.textContent).toBe('影子')
    expect(root.textContent).toContain('只判断和记录，不改 Gmail')
    expect(root.textContent).not.toContain('导出过滤器')
  })

  it('changes the mode with only mode and the etag in the mask, after asking for 正式', async () => {
    const server = new FakeServer()
    const asked: string[] = []
    const root = await open(server, '/settings', { now: () => NOW, confirm: (message) => (asked.push(message), true) })
    buttonNamed(root, '正式').click()
    await settle()
    expect(asked).toEqual(['切到正式？新邮件会打上 P1、P2、P3、P4 标签。P1 留在收件箱，P2、P3、P4 自动归档，未读状态保持不变。'])
    const patch = server.calls.find((call) => call.method === 'PATCH')
    expect(decodeURIComponent(patch?.path ?? '')).toContain('update_mask=mode,etag')
    expect(patch?.body).toMatchObject({ mode: 'live', etag: 's1' })
    expect(toastText(root)).toBe('已切到正式')
    expect(root.querySelector('[aria-label="模式"] [aria-pressed="true"]')?.textContent).toBe('正式')
    expect(root.querySelector('.status-line .chip')?.textContent).toBe('正式')
    // Choosing the mode in force sends nothing.
    buttonNamed(root, '正式').click()
    await settle()
    expect(server.calls.filter((call) => call.method === 'PATCH').length).toBe(1)
  })

  it('says when 正式 cannot write yet: the grant is read-only', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.LIVE })
    const root = await open(server, '/settings')
    const line = root.querySelector('.card p.hint')
    expect(line?.textContent).toBe('Gmail 只读授权，还不会写入：在本机运行 mint-token.mjs --scope modify')
    expect(line?.classList.contains('warn')).toBe(true)
    // With the write grant, what live does.
    server.status = { writeScope: true }
    const again = await open(server, '/settings')
    expect(again.querySelector('.card p.hint')?.textContent).toBe('按 P1、P2、P3、P4 分级；P1 留在收件箱，P2、P3、P4 归档，未读状态不变')
  })

  it('explains the deployment’s ceiling in one line', async () => {
    const server = new FakeServer()
    Object.assign(server.settings, { mode: Mode.LIVE, effectiveMode: Mode.SHADOW })
    const root = await open(server, '/settings')
    expect(root.textContent).toContain('受部署上限限制，按影子运行')
  })

  it('previews a range undo, then undoes it in rounds of 20 until none is left', async () => {
    const server = new FakeServer()
    const old = timestampFromMs(NOW - 3 * 86_400_000)
    server.ledgerEntries = [
      ...Array.from({ length: 45 }, (_, i) => ledgerEntry(`e${String(i).padStart(2, '0')}`)),
      ledgerEntry('gone', { undoable: false }),
      ...Array.from({ length: 10 }, (_, i) => ledgerEntry(`old${String(i)}`, { createTime: old })),
    ]
    const root = await open(server, '/settings')
    // 24 小时 is the default range.
    expect(root.querySelector('[aria-label="时间"] [aria-pressed="true"]')?.textContent).toBe('24 小时')
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销 45 条')
    expect(server.calls.some((call) => call.path === '/api/v2/ledgerEntries:undo')).toBe(false)
    buttonNamed(root, '确认撤销').click()
    await settle(20)
    const undos = server.calls.filter((call) => call.path === '/api/v2/ledgerEntries:undo')
    expect(undos.length).toBe(3)
    expect(new Set(undos.map((call) => String(call.body?.['request_id']))).size).toBe(3)
    expect(server.ledgerEntries.filter((item) => item.undoable).map((item) => item.name)).toEqual(Array.from({ length: 10 }, (_, i) => `ledgerEntries/old${String(i)}`))
    expect(toastText(root)).toBe('已撤销 45 条')
    expect(root.textContent).not.toContain('确认撤销')
  })

  it('undoes one label’s entries only when a label is chosen, and says so in the preview', async () => {
    const server = new FakeServer()
    server.labels = [label('p4', 'P4'), label('p2', 'P2')]
    server.ledgerEntries = [ledgerEntry('t1', { label: 'labels/p4' }), ledgerEntry('n1'), ledgerEntry('t2', { label: 'labels/p4' })]
    const root = await open(server, '/settings')
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="分级"]')
    if (select === null) throw new Error('no select')
    expect(select.options[0]?.textContent).toBe('全部分级')
    select.value = 'labels/p4'
    select.dispatchEvent(new Event('change'))
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销“P4”的 2 条')
    buttonNamed(root, '确认撤销').click()
    await settle(10)
    expect(server.calls.find((call) => call.path === '/api/v2/ledgerEntries:undo')?.body?.['label']).toBe('labels/p4')
    expect(server.ledgerEntries.map((item) => [item.name, item.undoable])).toEqual([
      ['ledgerEntries/t1', false],
      ['ledgerEntries/n1', true],
      ['ledgerEntries/t2', false],
    ])
    expect(toastText(root)).toBe('已撤销 2 条')
  })

  it('says when there is nothing to undo, and checks a range of one’s own', async () => {
    const server = new FakeServer()
    server.ledgerEntries = [ledgerEntry('old', { createTime: timestampFromMs(NOW - 2 * 86_400_000) })]
    const root = await open(server, '/settings')
    buttonNamed(root, '1 小时').click()
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('这段时间没有可撤销的写入')
    expect([...root.querySelectorAll('button')].some((node) => node.textContent === '确认撤销')).toBe(false)

    buttonNamed(root, '自定义').click()
    const [start, end] = [...root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]')]
    if (start === undefined || end === undefined) throw new Error('no range inputs')
    expect(start.closest('[hidden]')).toBeNull()
    buttonNamed(root, '预览').click()
    expect(toastText(root)).toBe('请选择开始和结束时间')
    start.value = '2026-08-01T00:00'
    end.value = '2026-09-15T00:00'
    buttonNamed(root, '预览').click()
    expect(toastText(root)).toBe('最多 31 天')
    start.value = '2026-09-29T00:00'
    end.value = '2026-09-30T00:00'
    buttonNamed(root, '预览').click()
    await settle(10)
    expect(root.textContent).toContain('将撤销 1 条')
  })

  it('keeps old label consolidation and Gmail import out of settings and out of API reads', async () => {
    const server = new FakeServer()
    const root = await open(server, '/settings')
    expect(root.textContent).not.toMatch(/整理标签|从 Gmail 同步|可信域名/)
    expect(server.calls.some((call) => /labelConsolidation|:sync/.test(call.path))).toBe(false)
  })
})
