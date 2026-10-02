/**
 * The UI's guarantees found missing in review, against the fake owner API: a shared link never fetches by itself;
 * a create whose response was lost lands on the watch the first request made; the settings form keeps what it does
 * not show and saves only what it edits; every ignored line can be taken back on the watch's page; and the preview and
 * the diff read well with a screen reader. Synthetic data only.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Change_State, Change_SuppressionReason } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { WatchSchema } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { PreviewWatchResponseSchema } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb'
import { mountApp } from './app.ts'
import { draftOf, watchOf } from './settings.ts'
import { change, FakeServer, NOW, watch } from './test/fakeServer.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits until `check` holds, at most `ms` of real time (withRetry pauses 800 ms before its repeat). */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await settle()
  expect(check(), document.body.textContent ?? '').toBe(true)
}

async function mount(server: FakeServer, path: string): Promise<HTMLElement> {
  server.install()
  window.history.replaceState(null, '', path)
  const root = document.createElement('div')
  document.body.append(root)
  await mountApp(root, { now: () => NOW, confirm: () => true })
  return root
}

function buttons(scope: ParentNode, label: string): HTMLButtonElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].filter((candidate) => candidate.textContent === label)
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = buttons(scope, label)[0]
  if (found === undefined) throw new Error(`no button ${label}`)
  return found
}

const text = (root: HTMLElement) => root.textContent ?? ''

describe('the add-from-phone link (/new#u=<url>)', () => {
  it('fills the box and shows the host, previews nothing until 预览 is tapped, and clears the fragment', async () => {
    const server = new FakeServer()
    const root = await mount(server, `/new#u=${encodeURIComponent('https://tracker.example.com/beacon?id=owner')}`)
    for (let i = 0; i < 20; i += 1) await settle()
    expect(root.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://tracker.example.com/beacon?id=owner')
    expect(root.querySelector('.shared strong')?.textContent).toBe('tracker.example.com')
    expect(server.mutations(':preview')).toEqual([])
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/new')
  })
})

describe('saving a new watch', () => {
  it('a create whose response was lost is repeated with the same request_id and lands on the watch it made', async () => {
    const server = new FakeServer()
    server.preview = () => create(PreviewWatchResponseSchema, { fetch: { httpStatus: 200, robotsAllowed: true }, normalizedLines: ['Price 100'] })
    const root = await mount(server, '/new')
    const uri = root.querySelector<HTMLInputElement>('input[type="url"]')
    if (uri === null) throw new Error('no url box')
    uri.value = 'https://shop.example.com/item'
    uri.dispatchEvent(new Event('input'))
    button(root, '预览').click()
    await until(() => text(root).includes('将比较的内容'))
    const name = root.querySelector<HTMLInputElement>('input[name="displayName"]')
    if (name === null) throw new Error('no name box')
    name.value = '合成：水壶'
    name.dispatchEvent(new Event('input'))
    server.loseNextResponse = '/api/v1/watches'
    button(root, '保存').click()
    await until(() => window.location.pathname.startsWith('/watches/w'))
    const creates = server.mutations().filter((call) => call.method === 'POST' && (call.path.split('?')[0] ?? '') === '/api/v1/watches')
    expect(creates).toHaveLength(2)
    expect(new Set(creates.map((call) => new URLSearchParams(call.path.split('?')[1]).get('request_id'))).size).toBe(1)
    expect([...server.watches.keys()]).toEqual([`watches${window.location.pathname.slice('/watches'.length)}`])
  })
})

describe('the settings form', () => {
  const stored = create(WatchSchema, {
    name: 'watches/kettle',
    etag: 'etag-kettle-1',
    displayName: 'Kettle',
    uri: 'https://shop.example.com/kettle',
    source: { html: { keepLandmarks: true } },
    normalize: { maskNumbers: true, disableDefaultMasks: true, ignoredLines: ['x'] },
    stability: { confirmDelayMinutes: 60 },
    trigger: { anyChange: { minChangedLines: 2, minChangedPercent: 10 } },
    ai: { intent: 'price drops only' },
  })

  it('keeps every field it does not show through a round trip', () => {
    const saved = watchOf(draftOf(stored))
    expect({
      maskNumbers: saved.normalize?.maskNumbers,
      disableDefaultMasks: saved.normalize?.disableDefaultMasks,
      confirmDelayMinutes: saved.stability?.confirmDelayMinutes,
      keepLandmarks: saved.source?.html?.keepLandmarks,
      minChangedPercent: saved.trigger?.anyChange?.minChangedPercent,
      intent: saved.ai?.intent,
    }).toEqual({ maskNumbers: true, disableDefaultMasks: true, confirmDelayMinutes: 60, keepLandmarks: true, minChangedPercent: 10, intent: 'price drops only' })
  })

  it('saves with an update_mask of what it edits (never the ignored lines), and offers the masks and landmarks', async () => {
    const server = new FakeServer([watch('kettle', { ...stored, health: undefined })])
    const root = await mount(server, '/watches/kettle')
    await until(() => text(root).includes('保存设置'))
    for (const label of ['数字也遮盖', '关闭默认遮盖', '导航、页眉和页脚也算']) expect(text(root)).toContain(label)
    // Another tab ignored a line meanwhile; the form's save must not write its stale copy back.
    const current = server.watches.get('watches/kettle')
    if (current?.normalize !== undefined) current.normalize.ignoredLines = ['x', 'y']
    button(root, '保存设置').click()
    await until(() => server.mutations().length === 1)
    const [save] = server.mutations()
    const mask = new URLSearchParams(save?.path.split('?')[1]).get('update_mask')?.split(',') ?? []
    expect(mask).toEqual(expect.arrayContaining(['display_name', 'source', 'trigger', 'normalize.mask_numbers', 'stability.skip_confirmation', 'etag']))
    expect(mask).not.toContain('normalize.ignored_lines')
    expect(mask).not.toContain('normalize')
    const after = server.watches.get('watches/kettle')
    expect(after?.normalize?.ignoredLines).toEqual(['x', 'y'])
    expect(after?.stability?.confirmDelayMinutes).toBe(60)
    expect(after?.trigger?.anyChange?.minChangedPercent).toBe(10)
  })
})

describe('ignored lines', () => {
  it('after ignoring two lines, each one can be taken back on the watch\'s page', async () => {
    const server = new FakeServer([watch('news')], [
      change('news', '0mvg000000000003', {
        state: Change_State.SUPPRESSED,
        suppressionReason: Change_SuppressionReason.BELOW_THRESHOLD,
        diffLines: [
          { kind: 1, text: 'Visitors 121' },
          { kind: 1, text: 'Weather sunny' },
        ],
      }),
    ])
    const root = await mount(server, '/')
    const drawer = root.querySelector<HTMLDetailsElement>('details.drawer')
    if (drawer === null) throw new Error('no drawer')
    drawer.open = true
    drawer.dispatchEvent(new Event('toggle'))
    await until(() => buttons(drawer, '忽略这一行').length === 2)
    buttons(drawer, '忽略这一行')[0]?.click()
    await until(() => server.mutations().length === 1)
    await until(() => buttons(drawer, '忽略这一行').length === 2)
    buttons(drawer, '忽略这一行')[1]?.click()
    await until(() => server.mutations().length === 2)
    expect(server.watches.get('watches/news')?.normalize?.ignoredLines).toEqual(['Visitors 121', 'Weather sunny'])
    // The toast's 撤销 is gone for the first line; the watch's page lists both, each with 取消忽略.
    window.history.replaceState(null, '', '/watches/news')
    root.replaceChildren()
    await mountApp(root, { now: () => NOW, confirm: () => true })
    await until(() => root.querySelectorAll('ul.ignored li').length === 2)
    const first = [...root.querySelectorAll('ul.ignored li')].find((li) => (li.textContent ?? '').includes('Visitors 121'))
    if (first === undefined) throw new Error('no ignored line')
    button(first, '取消忽略').click()
    await until(() => (server.watches.get('watches/news')?.normalize?.ignoredLines ?? []).length === 1)
    expect(server.watches.get('watches/news')?.normalize?.ignoredLines).toEqual(['Weather sunny'])
    const [undo] = server.mutations().slice(-1)
    expect(undo?.path).toContain('update_mask=normalize.ignored_lines%2Cetag')
    // Its own suppressed change offers 取消忽略 on a line that is still ignored.
    await until(() => buttons(root, '取消忽略').length >= 2)
    const sunny = [...root.querySelectorAll('ul.diff li')].find((li) => (li.textContent ?? '').includes('Weather sunny'))
    expect(sunny?.querySelector('button')?.textContent).toBe('取消忽略')
  })
})

describe('accessibility', () => {
  it('diff lines say 新增 or 删除 in words, and each line\'s button names its line', async () => {
    const server = new FakeServer([watch('news')], [change('news', '0mvg000000000004', { state: Change_State.SUPPRESSED, suppressionReason: Change_SuppressionReason.BELOW_THRESHOLD })])
    const root = await mount(server, '/watches/news')
    await until(() => root.querySelectorAll('ul.diff li').length === 2)
    const [removed, added] = [...root.querySelectorAll('ul.diff li')]
    expect(removed?.querySelector('.visually-hidden')?.textContent).toBe('删除：')
    expect(added?.querySelector('.visually-hidden')?.textContent).toBe('新增：')
    expect(added?.querySelector('.sign')?.getAttribute('aria-hidden')).toBe('true')
    expect(added?.querySelector('.sign')?.hasAttribute('aria-label')).toBe(false)
    expect(added?.querySelector('button')?.getAttribute('aria-label')).toBe('忽略这一行：Price 80')
  })

  it('the preview is not a live region; a short status line says what it will compare', async () => {
    const server = new FakeServer()
    server.preview = () =>
      create(PreviewWatchResponseSchema, {
        fetch: { httpStatus: 200, robotsAllowed: true },
        blocks: [{ selector: 'nav', tag: 'nav', text: 'Menu', lineCount: 1, counted: false, landmark: true }],
        normalizedLines: ['Price 100', 'Stock 3'],
      })
    const root = await mount(server, `/new#u=${encodeURIComponent('https://shop.example.com/item')}`)
    button(root, '预览').click()
    await until(() => text(root).includes('将比较的内容'))
    expect(root.querySelector('section.preview')?.hasAttribute('aria-live')).toBe(false)
    expect(root.querySelector('[role="status"]')?.textContent).toBe('将比较 2 行，已选 0 个区块')
    // A landmark block says that it does not count unless picked.
    expect(root.querySelector('button.block.landmark .note')?.textContent).toBe('导航/页眉区，默认不计入')
  })
})
