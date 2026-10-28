import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { SnapshotSchema, SnapshotImageSchema } from '@ziyixi/proto/watch/ui/v1/snapshot_pb'
import { mountApp } from './app.ts'
import { change, FakeServer, NOW, watch } from './test/fakeServer.ts'

const BEFORE = 'watches/news/snapshots/0000000000000001'
const AFTER = 'watches/news/snapshots/0000000000000002'
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

function expand(scope: ParentNode, label: string): HTMLDetailsElement {
  const summary = [...scope.querySelectorAll('summary')].find((candidate) => candidate.textContent === label)
  if (!(summary?.parentElement instanceof HTMLDetailsElement)) throw new Error(`no evidence drawer ${label}`)
  const drawer = summary.parentElement
  drawer.open = true
  drawer.dispatchEvent(new Event('toggle'))
  return drawer
}

function capture(server: FakeServer, name: string, markdown: string, image = false): void {
  server.snapshots.set(name, create(SnapshotSchema, {
    name, createTime: timestampFromMs(NOW), uri: 'https://news.example.com/captured', title: 'Synthetic page',
    markdown, contentAvailable: true, imageAvailable: image, imageError: image ? '' : 'not_recorded',
  }))
}

const calls = (server: FakeServer, suffix: string) => server.calls.filter((call) => call.path.split('?')[0]?.endsWith(suffix))

describe('stored page evidence', () => {
  it('reads current source on expansion and image bytes separately, displaying page markup as text', async () => {
    const server = new FakeServer([watch('news', { latestSnapshot: AFTER })])
    capture(server, AFTER, '<script>do not execute</script>\n<img src="https://remote.example.com/pixel">', true)
    const saved = server.snapshots.get(AFTER)
    if (saved !== undefined) {
      saved.links = [{ $typeName: 'watch.ui.v1.SnapshotLink', text: 'Untrusted', url: 'javascript:alert(1)' }]
      saved.metadata = [{ $typeName: 'watch.ui.v1.SnapshotMetadata', name: 'description', content: 'Synthetic metadata' }]
    }
    server.images.set(`${AFTER}/image`, create(SnapshotImageSchema, { name: `${AFTER}/image`, jpegBase64: '/9j/2Q==', available: true, width: 320, height: 640 }))
    const root = await mount(server, '/watches/news')
    expect(calls(server, '/snapshots/0000000000000002')).toHaveLength(0)
    const evidence = expand(root, '最近抓取的页面')
    await until(() => evidence.textContent?.includes('<script>do not execute</script>') === true)
    expect(calls(server, '/snapshots/0000000000000002')).toHaveLength(1)
    expect(calls(server, '/image')).toHaveLength(0)
    expect(evidence.querySelector('script, iframe, img, a')).toBeNull()
    expect(evidence.textContent).toContain('javascript:alert(1)')
    expect(evidence.textContent).toContain('Synthetic metadata')
    const screenshot = expand(evidence, '查看截图')
    await until(() => screenshot.querySelector('img') !== null)
    expect(screenshot.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/2Q==')
    expect(screenshot.querySelector('img')?.alt).toBe('抓取时保存的页面截图')
    expect(calls(server, '/image')).toHaveLength(1)
    screenshot.open = false
    screenshot.dispatchEvent(new Event('toggle'))
    expand(evidence, '查看截图')
    await settle()
    expect(calls(server, '/image')).toHaveLength(1)
  })

  it('uses the change detail references for both saved sides instead of the latest capture', async () => {
    const item = change('news', '0mvg000000000001', { beforeSnapshot: BEFORE, afterSnapshot: AFTER })
    const server = new FakeServer([watch('news')], [item])
    capture(server, BEFORE, 'Before: price 100')
    capture(server, AFTER, 'After: price 80')
    const root = await mount(server, '/')
    expect(calls(server, '/changes/0mvg000000000001')).toHaveLength(0)
    const drawer = expand(root, '查看变化前后的页面')
    await until(() => drawer.textContent?.includes('After: price 80') === true)
    expect(drawer.textContent).toContain('Before: price 100')
    expect(calls(server, '/changes/0mvg000000000001')).toHaveLength(1)
    expect(calls(server, '/snapshots/0000000000000001')).toHaveLength(1)
    expect(calls(server, '/snapshots/0000000000000002')).toHaveLength(1)
  })

  it('distinguishes unrecorded, expired and truncated evidence while retaining frozen legacy context', async () => {
    const legacy = change('news', '0mvg000000000001', { contextAvailable: true, contextTruncated: true, beforeContext: ['Old context'], afterContext: ['New context'] })
    const server = new FakeServer([watch('news', { latestSnapshot: AFTER })], [legacy])
    capture(server, AFTER, 'Only retained text')
    const saved = server.snapshots.get(AFTER)
    if (saved !== undefined) saved.contentTruncated = true
    const root = await mount(server, '/watches/news')
    const current = expand(root, '最近抓取的页面')
    await until(() => current.textContent?.includes('页面证据已截断') === true)
    expect(current.textContent).toContain('此记录未保存截图')
    const drawer = expand(root, '查看变化前后的页面')
    await until(() => drawer.textContent?.includes('Old context') === true)
    expect(drawer.textContent).toContain('此记录未保存页面证据')
    expect(drawer.textContent).toContain('上下文已截断')
    legacy.beforeSnapshot = BEFORE
    legacy.afterSnapshot = AFTER
    drawer.remove()
    // A new visit reads the retained refs; the pruned side is explicit and the surviving side remains readable.
    root.remove()
    const again = await mount(server, '/watches/news')
    const expired = expand(again, '查看变化前后的页面')
    await until(() => expired.textContent?.includes('页面证据已过期') === true)
    expect(expired.textContent).toContain('Only retained text')
  })

  it('shows the full bounded source beyond the old diff context window', async () => {
    const server = new FakeServer([watch('news', { latestSnapshot: AFTER })])
    const markdown = `${'Synthetic body.\n'.repeat(16_000)}End of retained evidence.`
    capture(server, AFTER, markdown)
    const root = await mount(server, '/watches/news')
    const drawer = expand(root, '最近抓取的页面')
    await until(() => drawer.querySelector('pre') !== null)
    expect(drawer.querySelector('pre')?.textContent).toBe(markdown)
    expect(drawer.textContent).toContain('End of retained evidence.')
  })

  it('shows extraction issues beside retained text and keeps a successful empty capture distinct', async () => {
    const server = new FakeServer([watch('news')], [change('news', '0mvg000000000001', { beforeSnapshot: BEFORE, afterSnapshot: AFTER })])
    capture(server, BEFORE, '')
    capture(server, AFTER, 'Retained synthetic paragraph')
    const partial = server.snapshots.get(AFTER)
    if (partial !== undefined) partial.contentError = 'SELECTOR_MISS'
    const root = await mount(server, '/')
    const drawer = expand(root, '查看变化前后的页面')
    await until(() => drawer.querySelector('[aria-label="变化后"] pre') !== null)
    const before = drawer.querySelector('[aria-label="变化前"]')
    const after = drawer.querySelector('[aria-label="变化后"]')
    expect(before?.textContent).toContain('已保存的页面正文为空。')
    expect(before?.querySelector('.warn')).toBeNull()
    expect(after?.querySelector('pre')?.textContent).toBe('Retained synthetic paragraph')
    expect(after?.querySelector('.warn')?.textContent).toContain('SELECTOR_MISS')
    expect(after?.textContent).not.toContain('已保存的页面正文为空。')
  })

  it('explains an unrecorded current capture without making an evidence request', async () => {
    const server = new FakeServer([watch('news')])
    const root = await mount(server, '/watches/news')
    const drawer = expand(root, '最近抓取的页面')
    await until(() => drawer.textContent?.includes('此记录未保存页面证据') === true)
    expect(server.calls.some((call) => call.path.includes('/snapshots/'))).toBe(false)
  })

  it('keeps a failed screenshot separate from unavailable page text', async () => {
    const server = new FakeServer([watch('news', { latestSnapshot: AFTER })])
    server.snapshots.set(AFTER, create(SnapshotSchema, {
      name: AFTER, contentAvailable: false, contentError: 'unavailable', imageError: 'screenshot_failed',
    }))
    const root = await mount(server, '/watches/news')
    const drawer = expand(root, '最近抓取的页面')
    await until(() => drawer.textContent?.includes('页面正文暂时无法读取') === true)
    expect(drawer.textContent).toContain('截图抓取失败')
    expect(drawer.querySelector('pre, img')).toBeNull()
    expect(calls(server, '/image')).toHaveLength(0)
  })

  it('shows a missing screenshot as expired even when capture metadata still advertises it', async () => {
    const server = new FakeServer([watch('news', { latestSnapshot: AFTER })])
    capture(server, AFTER, 'Text survives', true)
    const root = await mount(server, '/watches/news')
    const current = expand(root, '最近抓取的页面')
    await until(() => current.textContent?.includes('Text survives') === true)
    const image = expand(current, '查看截图')
    await until(() => image.textContent?.includes('截图已过期') === true)
    expect(image.querySelector('img')).toBeNull()
  })
})
