/**
 * The shell against the fake API: the three tabs (only marked, so a tab chosen by keyboard keeps the focus), the quiet
 * status line and its problems (a device or an archive that stopped, storage near its budget; a retired one stops
 * warning), an unknown path, `/` focusing the search box, a page's detail over the tab it came from, and back.
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { FakeServer, HOUR, MINUTE, NOW, page, pageId, textOf } from './test/fakeServer.ts'
import { open, press } from './test/helpers.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick()
}

const line = (root: HTMLElement) => [...root.querySelectorAll('.status-line > span')].map((node) => [node.textContent, node.className])
const DAY = 24 * HOUR

describe('the shell', () => {
  it('has three tabs, the quiet status line, and answers an unknown path', async () => {
    const root = await open(new FakeServer(), '/nowhere')
    expect(root.querySelector('.brand')?.textContent).toBe('浏览记录')
    const tabs = [...root.querySelectorAll<HTMLAnchorElement>('.tabs a')]
    expect(tabs.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['时间线', '/'],
      ['搜索', '/search'],
      ['设置', '/settings'],
    ])
    expect(root.querySelector('.tabs a[aria-current]')).toBeNull()
    expect(line(root)).toEqual([
      ['上传 3 分钟前', ''],
      ['NAS 已同步', ''],
    ])
    expect(root.textContent).toContain('找不到这个页面')
  })

  it('says in the warning color what stopped: a device, an archive, the storage', async () => {
    const fake = new FakeServer()
    fake.status = {
      devices: [
        { $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'a', label: 'MacBook', extensionVersion: '1', lastHeartbeatTime: timestampFromMs(NOW - 2 * DAY), queuedCount: 0, lastErrorCode: '', stale: true, clockSkewSeconds: 0 },
        // Retired long ago: no longer watched.
        { $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'b', label: 'Old', extensionVersion: '1', lastHeartbeatTime: timestampFromMs(NOW - 40 * DAY), queuedCount: 0, lastErrorCode: '', stale: true, clockSkewSeconds: 0 },
      ],
      archiveConsumers: [{ $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'nas', syncedSeq: 1, lastPullTime: timestampFromMs(NOW - 3 * DAY), behindCount: 50, oldestUnsyncedTime: timestampFromMs(NOW - 3 * DAY), stale: true }],
      storageUsedMib: 850,
    }
    const root = await open(fake, '/')
    expect(line(root)).toEqual([
      ['MacBook 2 天没有上传', 'problem'],
      ['NAS 3 天没有同步', 'problem'],
      ['存储接近上限', 'problem'],
    ])
  })

  it('tells an archive waiting on its next pull from one that fell a day behind', async () => {
    const fake = new FakeServer()
    fake.status = {
      archiveConsumers: [
        { $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'nas', syncedSeq: 1, lastPullTime: timestampFromMs(NOW - 10 * MINUTE), behindCount: 12, oldestUnsyncedTime: timestampFromMs(NOW - 20 * MINUTE), stale: false },
        { $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'backup-disk', syncedSeq: 1, lastPullTime: timestampFromMs(NOW - 10 * MINUTE), behindCount: 120, oldestUnsyncedTime: timestampFromMs(NOW - 2 * DAY), stale: false },
      ],
    }
    const root = await open(fake, '/')
    expect(line(root).slice(1)).toEqual([
      ['NAS 待同步 12 条', ''],
      ['backup-disk 落后 120 条', 'problem'],
    ])
  })

  it('before the first upload, says so quietly', async () => {
    const fake = new FakeServer()
    fake.status = { devices: [], archiveConsumers: [] }
    const root = await open(fake, '/settings')
    expect(line(root)).toEqual([['还没有上传', '']])
  })

  it('keeps the focus on a tab chosen by keyboard: the tabs are only marked, never drawn again', async () => {
    const root = await open(new FakeServer(), '/')
    const settings = root.querySelector<HTMLAnchorElement>('.tabs a[href="/settings"]')
    if (settings === null) throw new Error('no tab')
    settings.focus()
    settings.click()
    await settled()
    expect(settings.isConnected).toBe(true)
    expect(document.activeElement).toBe(settings)
    expect(settings.getAttribute('aria-current')).toBe('page')
    expect(root.querySelectorAll('.tabs a[aria-current]').length).toBe(1)
  })

  it('focuses the search box with / from anywhere, but not while typing', async () => {
    const root = await open(new FakeServer(), '/settings')
    const field = root.querySelector<HTMLInputElement>('.denylist input')
    field?.focus()
    press('/')
    await settled()
    expect(window.location.pathname).toBe('/settings')
    field?.blur()
    press('/')
    await settled()
    expect(window.location.pathname).toBe('/search')
    expect(document.activeElement?.id).toBe('q')
  })

  it('opens a page’s detail over the tab it came from, and goes back', async () => {
    const fake = new FakeServer()
    const read = page('a')
    fake.addText(read, textOf('a', '一段读过的正文'))
    fake.pages = [read]
    let root = await open(fake, '/settings')
    root.querySelector<HTMLAnchorElement>('.tabs a[href="/search"]')?.click()
    await settled()
    root.querySelector<HTMLAnchorElement>('a.result-link')?.click()
    await settled()
    expect(window.location.pathname).toBe(`/pages/${pageId('a')}`)
    expect(root.querySelector('.tabs a[aria-current]')?.textContent).toBe('搜索')
    window.history.back()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await settled()
    expect(window.location.pathname).toBe('/search')
    expect(root.querySelector('.tabs a[aria-current]')?.textContent).toBe('搜索')
    // A link opened afresh: 搜索 when it carries a query, else 时间线.
    root = await open(fake, `/pages/${pageId('a')}?q=x`)
    expect(root.querySelector('.tabs a[aria-current]')?.textContent).toBe('搜索')
    root = await open(fake, `/pages/${pageId('a')}`)
    expect(root.querySelector('.tabs a[aria-current]')?.textContent).toBe('时间线')
  })
})
