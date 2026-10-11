/**
 * The shell against the fake API: the three tabs (only marked, so a tab chosen by keyboard keeps the focus), the quiet
 * status line and its problems (a device that stopped, the Dropbox backup not connected or a day behind, storage near
 * its budget; a retired device stops warning), an unknown path, `/` focusing the search box, a page's detail over the tab it came from, and back.
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
      ['Dropbox 已备份', ''],
    ])
    expect(root.textContent).toContain('找不到这个页面')
  })

  it('says in the warning color what stopped: a device, the backup, the storage', async () => {
    const fake = new FakeServer()
    fake.status = {
      devices: [
        { $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'a', label: 'MacBook', extensionVersion: '1', lastHeartbeatTime: timestampFromMs(NOW - 2 * DAY), queuedCount: 0, lastErrorCode: '', stale: true, clockSkewSeconds: 0 },
        // Retired long ago: no longer watched.
        { $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'b', label: 'Old', extensionVersion: '1', lastHeartbeatTime: timestampFromMs(NOW - 40 * DAY), queuedCount: 0, lastErrorCode: '', stale: true, clockSkewSeconds: 0 },
      ],
      // A feed consumer far behind is 设置's business only.
      archiveConsumers: [{ $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'nas', syncedSeq: 1, lastPullTime: timestampFromMs(NOW - 3 * DAY), behindCount: 50, oldestUnsyncedTime: timestampFromMs(NOW - 3 * DAY), stale: true }],
      storageUsedMib: 850,
    }
    fake.backup.connected = false
    const root = await open(fake, '/')
    expect(line(root)).toEqual([
      ['MacBook 2 天没有上传', 'problem'],
      ['Dropbox 备份未连接', 'problem'],
      ['存储接近上限', 'problem'],
    ])
  })

  it('tells changes waiting for the next hourly backup from a backup a day behind, counted from the connection', async () => {
    const fake = new FakeServer()
    Object.assign(fake.backup, { pendingCount: 12, oldestPendingTime: timestampFromMs(NOW - 20 * MINUTE) })
    expect(line(await open(fake, '/')).slice(1)).toEqual([['Dropbox 待备份 12 条', '']])
    Object.assign(fake.backup, { pendingCount: 500, oldestPendingTime: timestampFromMs(NOW - 2 * DAY) })
    expect(line(await open(fake, '/')).slice(1)).toEqual([['Dropbox 落后 500+ 条', 'problem']])
    // Connected an hour ago to a store whose changes are older: its first upload is no lag.
    Object.assign(fake.backup, { connectTime: timestampFromMs(NOW - HOUR) })
    expect(line(await open(fake, '/')).slice(1)).toEqual([['Dropbox 待备份 500+ 条', '']])
  })

  it('before the first upload, says so quietly', async () => {
    const fake = new FakeServer()
    fake.status = { devices: [] }
    const root = await open(fake, '/settings')
    expect(line(root)).toEqual([
      ['还没有上传', ''],
      ['Dropbox 已备份', ''],
    ])
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
