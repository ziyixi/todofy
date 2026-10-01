import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { Change_State, Change_SuppressionReason } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { FailureReason, Watch_State, WatchHealthSchema, WatchHealth_Outcome } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { PreviewWatchResponseSchema } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb'
import { mountApp } from './app.ts'
import { change, FakeServer, NOW, watch } from './test/fakeServer.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await settle()
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

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === label)
  if (found === undefined) throw new Error(`no button ${label}`)
  return found
}

const text = (root: HTMLElement) => root.textContent ?? ''

describe('the inbox', () => {
  it('lists new changes across watches; 已读 acknowledges with a request ID and the CSRF token', async () => {
    const server = new FakeServer([watch('kettle')], [change('kettle', '0mvg000000000001'), change('kettle', '0mvg000000000002', { state: Change_State.ACKNOWLEDGED })])
    const root = await mount(server, '/')
    await until(() => root.querySelectorAll('article.change').length === 1)
    expect(text(root)).toContain('Watch kettle')
    expect(text(root)).toContain('Price 80')
    button(root, '已读').click()
    await until(() => root.querySelectorAll('article.change').length === 0)
    const [ack] = server.mutations(':acknowledge')
    expect(ack?.headers['x-csrf-token']).toBe('synthetic-token')
    expect(ack?.body?.['request_id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(text(root)).toContain('没有新变化')
  })

  it('the drawer shows suppressed changes with their reason; ignoring a line updates the watch with the etag, and undo removes it', async () => {
    const server = new FakeServer([watch('news')], [change('news', '0mvg000000000003', { state: Change_State.SUPPRESSED, suppressionReason: Change_SuppressionReason.BELOW_THRESHOLD, diffLines: [{ kind: 1, text: 'Visitors 121' }] })])
    const root = await mount(server, '/')
    const drawer = root.querySelector<HTMLDetailsElement>('details.drawer')
    if (drawer === null) throw new Error('no drawer')
    drawer.open = true
    drawer.dispatchEvent(new Event('toggle'))
    await until(() => (drawer.textContent ?? '').includes('变化太小'))
    button(drawer, '忽略这一行').click()
    await until(() => server.mutations().length === 1)
    const [update] = server.mutations()
    expect(update?.method).toBe('PATCH')
    expect(update?.path).toContain('update_mask=normalize.ignored_lines%2Cetag')
    expect(update?.body).toMatchObject({ etag: 'etag-news-1', normalize: { ignored_lines: ['Visitors 121'] } })
    expect(server.watches.get('watches/news')?.normalize?.ignoredLines).toEqual(['Visitors 121'])
    await until(() => (document.getElementById('toast')?.textContent ?? '').includes('撤销'))
    button(document.getElementById('toast') ?? document.body, '撤销').click()
    await until(() => server.mutations().length === 2)
    await until(() => (server.watches.get('watches/news')?.normalize?.ignoredLines ?? ['x']).length === 0)
  })
})

describe('adding a watch', () => {
  it('prefills the URL from the fragment (/new#u=…), previews, and the block picker builds selectors', async () => {
    const server = new FakeServer()
    server.preview = (draft) =>
      create(PreviewWatchResponseSchema, {
        fetch: { httpStatus: 200, mimeType: 'text/html', finalUri: draft.uri, charset: 'gbk', metaCharset: true, robotsAllowed: true },
        blocks: [
          { selector: 'main > p:nth-of-type(1)', tag: 'p', text: 'Price 100', lineCount: 1, counted: true },
          { selector: 'aside#ads', tag: 'aside', text: 'Advertisement', lineCount: 1, counted: true },
        ],
        normalizedLines: (draft.source?.html?.excludeSelectors ?? []).includes('aside#ads') ? ['Price 100'] : ['Price 100', 'Advertisement'],
      })
    const root = await mount(server, `/new#u=${encodeURIComponent('https://shop.example.com/item?x=1')}`)
    expect(root.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://shop.example.com/item?x=1')
    // Nothing is fetched until the owner taps 预览 (the link alone must not make the Worker request the URL).
    expect(server.mutations(':preview')).toEqual([])
    button(root, '预览').click()
    await until(() => text(root).includes('gbk（来自 meta）'))
    // The fragment never reached the server: the preview carries the URL in its body.
    expect(server.calls.every((call) => !call.path.includes('shop.example.com'))).toBe(true)
    expect(server.mutations(':preview')[0]?.body).toMatchObject({ watch: { uri: 'https://shop.example.com/item?x=1', display_name: 'shop.example.com' } })
    button(root, '排除这些').click()
    const ads = [...root.querySelectorAll<HTMLButtonElement>('button.block')].find((node) => (node.textContent ?? '').includes('Advertisement'))
    ads?.click()
    await until(() => text(root).includes('将比较的内容（1 行'))
    expect(server.mutations(':preview').at(-1)?.body).toMatchObject({ watch: { source: { html: { exclude_selectors: ['aside#ads'] } } } })
    expect(text(root)).toContain('排除 aside#ads')
    button(root, '保存').click()
    await until(() => window.location.pathname.startsWith('/watches/'))
    const created = server.mutations().find((call) => call.method === 'POST' && call.path.startsWith('/api/v1/watches?'))
    expect(created?.body).toMatchObject({ uri: 'https://shop.example.com/item?x=1', source: { html: { exclude_selectors: ['aside#ads'] } }, check_interval_minutes: 360 })
  })

  it('shows a failed health gate as its reason, never as "no change"', async () => {
    const server = new FakeServer()
    server.preview = () => create(PreviewWatchResponseSchema, { fetch: { httpStatus: 403, robotsAllowed: true }, failure: FailureReason.CHALLENGE_PAGE })
    const root = await mount(server, `/new#u=${encodeURIComponent('https://blocked.example.com/')}`)
    button(root, '预览').click()
    await until(() => text(root).includes('被拦截（人机验证页面）'))
  })
})

describe('watches and health', () => {
  it('lists watches with their health; the health view groups broken, blocked and JS-quota watches', async () => {
    const failed = (failure: FailureReason, state: Watch_State = Watch_State.ACTIVE) =>
      ({ state, health: create(WatchHealthSchema, { lastCheckTime: timestampFromMs(NOW - 60_000), lastOutcome: WatchHealth_Outcome.FAILED, lastFailure: failure, lastHttpStatus: failure === FailureReason.HTTP_ERROR ? 500 : 0, consecutiveFailureCount: 3 }) }) as const
    const server = new FakeServer([
      watch('fine'),
      watch('broken', failed(FailureReason.HTTP_ERROR, Watch_State.BROKEN)),
      watch('blocked', failed(FailureReason.CHALLENGE_PAGE)),
      watch('spa', failed(FailureReason.JS_QUOTA_EXHAUSTED)),
    ])
    const root = await mount(server, '/watches')
    await until(() => root.querySelectorAll('article.watch').length === 4)
    expect(text(root)).toContain('网站返回错误（HTTP 500）')
    expect(text(root)).toContain('今日 JS 配额已用完')
    root.querySelector<HTMLAnchorElement>('nav a[href="/status"]')?.click()
    await until(() => text(root).includes('失效（连续 3 次失败）（1）'))
    expect(text(root)).toContain('被拦截（1）')
    expect(text(root)).toContain('今日 JS 配额已用完（1）')
    expect(root.querySelectorAll('section.group article.watch')).toHaveLength(3)
  })

  it('a watch\'s page pauses with its etag and refuses a stale save by loading the latest', async () => {
    const server = new FakeServer([watch('kettle')])
    const root = await mount(server, '/watches/kettle')
    await until(() => text(root).includes('Watch kettle'))
    button(root, '暂停').click()
    await until(() => server.watches.get('watches/kettle')?.state === Watch_State.PAUSED)
    expect(server.mutations(':pause')[0]?.body).toMatchObject({ etag: 'etag-kettle-1' })
    await until(() => text(root).includes('恢复'))
    // Another tab changes the watch; this page's save carries the old etag.
    const stored = server.watches.get('watches/kettle')
    if (stored !== undefined) server.watches.set('watches/kettle', { ...stored, etag: 'etag-elsewhere' })
    button(root, '保存设置').click()
    await until(() => (document.getElementById('toast')?.textContent ?? '').includes('已在别处修改'))
  })
})
