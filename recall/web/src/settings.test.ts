/**
 * 设置 against the fake API, in the owner's words: devices (the latest connection, stale with what to check, version,
 * outbox, the last error as a sentence, clock skew), the steps without one, lost items and items waiting for a newer
 * recall; the extension's token (生成, shown once with 复制, 重新生成 with its grace, revoked at once, stopped; the
 * export token folded); the Dropbox backup (the steps and the App key, 连接 to Dropbox, the outcome it came back with,
 * connected with what waits and its failures in words, 断开) and the feed's own consumers; storage (counts, meters, the day's budgets,
 * the index's reach, the retention window: its choice, the texts in the cloud and only in Dropbox, a pause in words, a
 * shorter window asked first, 永久, the etag it shares with the lists); the owner's two lists (add to either, a pattern moving between them, remove, only the lists with
 * the etag, a stale etag, the server's refusal, the built-in lists) and the build.
 */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { DropboxBackupSchema, MachineTokenSchema } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { at, FakeServer, HOUR, MINUTE, NOW } from './test/fakeServer.ts'
import { buttonNamed, open, testHost, toastText, type, urlParams } from './test/helpers.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i++) await tick()
}

const cards = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.card')]
const card = (root: HTMLElement, title: string) => cards(root).find((node) => node.querySelector('h2')?.textContent === title) ?? (() => { throw new Error(`no card ${title}`) })()

describe('设备', () => {
  it('shows each device’s latest connection, version, outbox, error and clock skew; a stale one says what to check', async () => {
    const fake = new FakeServer()
    fake.status = {
      devices: [
        { $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'a', label: 'MacBook · 工作', extensionVersion: '2026.1009.1200', lastHeartbeatTime: timestampFromMs(NOW - 3 * MINUTE), queuedCount: 0, lastErrorCode: '', stale: false, mobile: false, clockSkewSeconds: 3600 },
        { $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'b', label: 'Mini · 家', extensionVersion: '2026.1001.900', lastHeartbeatTime: timestampFromMs(NOW - 50 * HOUR), queuedCount: 12, lastErrorCode: 'outbox_full', stale: true, mobile: false, clockSkewSeconds: 0 },
      ],
      rejectedItems: [
        { $typeName: 'recall.ui.v1.RejectedItems', reason: 'invalid_item', count: 3, lastTime: timestampFromMs(NOW - HOUR) },
        { $typeName: 'recall.ui.v1.RejectedItems', reason: 'unsupported_item', count: 2, lastTime: timestampFromMs(NOW - HOUR) },
      ],
    }
    const root = await open(fake, '/settings')
    const devices = card(root, '设备')
    const [mac, mini] = [...devices.querySelectorAll('.rows > li')]
    expect(mac?.querySelector('.row-head')?.textContent).toBe('MacBook · 工作最近连接 3 分钟前')
    expect([...(mac?.querySelectorAll('.facts > span') ?? [])].map((node) => node.textContent)).toEqual(['版本 2026.1009.1200', '待上传 0', '时钟差 1 小时'])
    expect(mac?.querySelector('.facts .warn')?.textContent).toBe('时钟差 1 小时')
    expect(mini?.querySelector('.row-head .meta.warn')?.textContent).toBe('最近连接 2 天前')
    // The last error as what it means and what to do, in the warning color when it needs the owner; the code in a tooltip.
    expect([...(mini?.querySelectorAll('p.hint.warn') ?? [])].map((node) => node.textContent)).toEqual(['检查 Chrome 是否开着、扩展是否启用（开发者模式）', '扩展存储已满，新页面的内容没有保存：打开扩展的选项检查'])
    expect(mini?.querySelectorAll('p.hint.warn')[1]?.getAttribute('title')).toBe('outbox_full')
    expect([...(mini?.querySelectorAll('.facts > span') ?? [])].map((node) => node.textContent)).toEqual(['版本 2026.1001.900', '待上传 12'])
    expect([...devices.querySelectorAll(':scope > p.hint')].map((node) => [node.textContent, node.classList.contains('warn')])).toEqual([
      ['同名连接只折叠显示，不合并设备。旧电脑的访问记录仍可查看；仅可移除无记录且没有待上传内容的连接。', false],
      ['连接成功可能只是心跳；实际记录见时间线。', false],
      ['7 天内有 3 条上传被拒（格式不对），已丢失：扩展可能有问题', true],
      ['7 天内有 2 条记录来自比 recall 新的扩展，正在扩展里等 recall 更新后再上传', false],
    ])
  })

  it('shows a phone’s pending uploads and error without a warning for being closed', async () => {
    const fake = new FakeServer()
    fake.status = { devices: [{
      $typeName: 'recall.ui.v1.DeviceStatus', deviceId: 'phone', label: 'iPhone', mobile: true,
      extensionVersion: '1', queuedCount: 4, lastErrorCode: 'upload_failed', stale: true,
      clockSkewSeconds: 0, lastHeartbeatTime: timestampFromMs(NOW - 50 * HOUR),
    }] }
    const root = await open(fake, '/settings')
    const phone = card(root, '设备').querySelector('.rows > li')
    expect(phone?.textContent).toContain('最近连接 2 天前')
    expect(phone?.textContent).toContain('手机仅在浏览器前台运行，打开后继续采集和上传。')
    expect(phone?.textContent).toContain('待上传 4')
    expect(phone?.textContent).toContain('上传失败过，扩展会自动重试')
    expect(phone?.querySelector('.warn')).toBeNull()
    expect(root.querySelector('.status-line .problem')).toBeNull()
  })

  it('without a device, gives the three steps to connect one, clicks only', async () => {
    const fake = new FakeServer()
    fake.status = { devices: [] }
    const root = await open(fake, '/settings')
    expect([...card(root, '设备').querySelectorAll('ol.steps li')].map((node) => node.textContent)).toEqual([
      '在下面的 插件口令 填写名称，点 添加口令 并复制',
      '在浏览器中加载 Recall 扩展，打开扩展的设置',
      '粘贴口令，填写设备名并保存',
    ])
  })
})

describe('插件口令', () => {
  it('adds independent device credentials, shows each secret once, and stops only the chosen one', async () => {
    const fake = new FakeServer()
    const phone = create(MachineTokenSchema, { name: 'machineTokens/00000000-0000-4000-8000-0000000000bb', label: 'iPhone', createTime: timestampFromMs(NOW - HOUR) })
    fake.tokens.push(phone)
    const host = testHost()
    const root = await open(fake, '/settings', host)
    const tokens = card(root, '插件口令')
    const field = tokens.querySelector<HTMLInputElement>('input[aria-label="口令名称"]')!
    type(field, ' iPad ')
    buttonNamed(tokens, '添加口令').click()
    await settled()
    const call = fake.calls.find((item) => item.method === 'POST' && item.path.startsWith('/api/v1/machineTokens?'))
    expect(call?.body).toEqual({ label: 'iPad' })
    expect(call?.path).toMatch(/request_id=[0-9a-f-]{36}/u)
    expect(call?.headers['x-csrf-token']).toBe('csrf-token')
    expect(tokens.querySelector('.token-once input')?.getAttribute('value')).toBe(`recall_ingest_${'N'.repeat(43)}`)
    expect([...tokens.querySelectorAll('.token-list > li:not(.shared-token) .row-title')].map((row) => row.textContent)).toEqual(['iPhone', 'iPad'])
    buttonNamed(tokens, 'iPhone的更多操作').click()
    buttonNamed(tokens, '停用').click()
    await settled()
    expect(host.asked).toEqual(['停用“iPhone”的上传口令？使用这个口令的设备会停止上传，已记录内容保留。'])
    expect(fake.tokens.map((token) => token.label || token.name)).toEqual(['machineTokens/ingest', 'machineTokens/export', 'iPad'])
    expect(tokens.querySelector('.shared-token')?.textContent).toContain('共享插件口令')
    const again = await open(fake, '/settings')
    expect(card(again, '插件口令').querySelector('.token-once')).toBeNull()
  })

  it('generates the first token and shows it once, with 复制 and the server address', async () => {
    const fake = new FakeServer()
    fake.tokens = [create(MachineTokenSchema, { name: 'machineTokens/ingest' }), create(MachineTokenSchema, { name: 'machineTokens/export' })]
    const root = await open(fake, '/settings')
    const tokens = card(root, '插件口令')
    expect(tokens.querySelector('.shared-token p.hint')?.textContent).toBe('还没有口令：生成后粘贴到扩展的选项里，扩展才能上传。')
    buttonNamed(tokens, '生成').click()
    await settled()
    const call = fake.calls.find((item) => item.path === '/api/v1/machineTokens/ingest:regenerate')
    expect(call?.method).toBe('POST')
    expect(call?.headers['x-csrf-token']).toBe('csrf-token')
    const once = tokens.querySelector('.token-once')
    expect(once?.querySelector('input')?.value).toBe(`recall_ingest_${'T'.repeat(43)}`)
    expect(once?.querySelector('.hint.warn')?.textContent).toBe('新的共享插件口令只显示这一次：现在复制，粘贴到扩展的选项里。离开或刷新这一页后不会再显示。')
    expect(once?.querySelector('.hint:not(.warn)')?.textContent).toBe(`扩展里的服务器地址：${window.location.origin}`)
    expect(tokens.querySelector('.shared-token .token-meta')?.textContent).toContain('刚刚生成')
    expect(toastText(root)).toBe('已生成新的共享插件口令')
    // Never shown again: the status carries no token, and the page drawn again has none.
    const again = await open(fake, '/settings')
    expect(card(again, '插件口令').querySelector('.token-once')).toBeNull()
  })

  it('asks before 重新生成, and says how long the old token still works', async () => {
    const fake = new FakeServer()
    const host = testHost()
    const root = await open(fake, '/settings', host)
    const tokens = card(root, '插件口令')
    expect(tokens.querySelector('.shared-token .token-meta')?.textContent).toContain('7 天前生成')
    buttonNamed(tokens, '共享插件口令的更多操作').click()
    buttonNamed(tokens, '重新生成').click()
    await settled()
    expect(host.asked).toEqual(['重新生成共享插件口令？旧口令 24 小时内仍可用，在这之前把新口令粘贴到扩展的选项里。'])
    expect(fake.calls.find((item) => item.path.endsWith(':regenerate'))?.body).toMatchObject({ request_id: expect.any(String) as string })
    expect(tokens.querySelector('.shared-token p.hint')?.textContent).toBe('旧口令 24 小时内仍可用')
  })

  it('revokes a leaked token at once, or stops uploads, from its ⋯ menu', async () => {
    const fake = new FakeServer()
    const host = testHost()
    const root = await open(fake, '/settings', host)
    const tokens = card(root, '插件口令')
    buttonNamed(tokens, '共享插件口令的更多操作').click()
    buttonNamed(tokens, '旧口令泄露：立即作废并重新生成').click()
    await settled()
    expect(host.asked).toEqual(['旧口令会立即失效，扩展换上新口令前无法上传。继续？'])
    expect(fake.calls.find((item) => item.path.endsWith(':regenerate'))?.body).toMatchObject({ revoke_previous: true })
    expect(tokens.querySelector('.token-once input')).not.toBeNull()
    buttonNamed(tokens, '共享插件口令的更多操作').click()
    buttonNamed(tokens, '停用').click()
    await settled()
    expect(fake.calls.find((item) => item.method === 'DELETE')?.path).toMatch(/^\/api\/v1\/machineTokens\/ingest\?request_id=/)
    expect(tokens.querySelector('.shared-token p.hint')?.textContent).toBe('还没有口令：生成后粘贴到扩展的选项里，扩展才能上传。')
    expect(tokens.querySelector('.token-once')).toBeNull()
  })

  it('folds the optional export token, says what it is for, and shows a new one open', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    const folded = card(root, '插件口令').querySelector('details')
    expect(folded?.querySelector('summary')?.textContent).toBe('导出口令（可选）')
    expect(folded?.querySelector('p.hint')?.textContent).toBe('只给通过变更 feed 读取全部记录的程序用；Dropbox 备份不需要它。')
    if (folded === null || folded === undefined) throw new Error('no export token')
    buttonNamed(folded, '生成').click()
    await settled()
    const opened = card(root, '插件口令').querySelector('details')
    expect(opened?.hasAttribute('open')).toBe(true)
    expect(opened?.querySelector('.token-once input')?.getAttribute('value')).toBe(`recall_export_${'T'.repeat(43)}`)
  })
})

describe('备份到 Dropbox', () => {
  it('not connected: the steps at Dropbox with the exact Redirect URI, and 连接 goes to Dropbox with the App key', async () => {
    const fake = new FakeServer()
    fake.backup = create(DropboxBackupSchema, { name: 'dropboxBackup' })
    const host = testHost()
    const root = await open(fake, '/settings', host)
    const backup = card(root, '备份到 Dropbox')
    expect([...backup.querySelectorAll('ol.steps li')].map((node) => node.textContent)).toEqual([
      '在 Dropbox 网站打开 dropbox.com/developers/apps，Create app：Scoped access → App folder → 任意名字',
      '在应用的 Permissions 里勾选 files.content.write 和 files.content.read，点 Submit',
      `在 Settings → OAuth 2 → Redirect URIs 里加上 ${window.location.origin}/api/dropbox/callback`,
      '复制同一页的 App key，粘贴到这里，点 连接，在 Dropbox 里允许',
    ])
    const field = backup.querySelector<HTMLInputElement>('input[aria-label="Dropbox App key"]')
    if (field === null) throw new Error('no field')
    type(field, ' syntheticappkey1 ')
    buttonNamed(backup, '连接').click()
    await settled()
    expect(fake.calls.find((item) => item.path === '/api/v1/dropboxBackup:connect')?.body).toMatchObject({ app_key: 'syntheticappkey1' })
    expect(host.navigated).toEqual(['/oauth2/authorize?client_id=syntheticappkey1&state=s'])
    expect(root.querySelector('.status-line .problem')?.textContent).toBe('Dropbox 备份未连接')
  })

  it("shows the server's refusal of an App key, and says when Dropbox refused the token", async () => {
    const fake = new FakeServer()
    fake.backup = create(DropboxBackupSchema, { name: 'dropboxBackup', appKey: 'syntheticappkey1', errorCode: 'dropbox_refused', errorTime: timestampFromMs(NOW - HOUR) })
    const host = testHost()
    const root = await open(fake, '/settings', host)
    const backup = card(root, '备份到 Dropbox')
    expect(backup.querySelector('p.hint.warn')?.textContent).toBe('Dropbox 撤销了授权（或应用被删除了）：重新连接')
    const field = backup.querySelector<HTMLInputElement>('input[aria-label="Dropbox App key"]')
    expect(field?.value).toBe('syntheticappkey1')
    if (field === null) throw new Error('no field')
    type(field, 'App Secret!')
    buttonNamed(backup, '连接').click()
    await settled()
    expect(host.navigated).toEqual([])
  })

  it('says how the connection went when Dropbox sends the browser back, once', async () => {
    for (const [outcome, said] of [
      ['connected', '已连接 Dropbox：几分钟内开始备份'],
      ['denied', '你在 Dropbox 取消了授权，没有连接'],
      ['expired', '这次连接已过期：请再点一次 连接'],
      ['other', '没有连上 Dropbox：检查 App key 和 Redirect URI 后再试'],
    ]) {
      const root = await open(new FakeServer(), `/settings?dropbox=${outcome}`)
      expect(toastText(root), outcome).toBe(said)
      expect(urlParams().has('dropbox')).toBe(false)
      root.remove()
    }
  })

  it('connected: the account, the last upload, what waits (late in the warning color), a failure in words, 断开', async () => {
    const fake = new FakeServer()
    Object.assign(fake.backup, { pendingCount: 32, oldestPendingTime: timestampFromMs(NOW - 26 * HOUR), errorCode: 'dropbox_full', errorTime: timestampFromMs(NOW - HOUR) })
    const host = testHost()
    const root = await open(fake, '/settings', host)
    const backup = card(root, '备份到 Dropbox')
    expect(backup.querySelector('.row-head')?.textContent).toBe('Dropbox · 合成 Dropbox20 分钟前上传')
    expect(backup.querySelector('.row-head .meta')?.getAttribute('title')).toBe('seq 10432')
    const facts = backup.querySelector('.facts')
    expect([facts?.textContent, facts?.classList.contains('warn')]).toEqual(['待备份 32 条（最早一条 26 小时前）', true])
    expect(backup.querySelector('p.hint.warn')?.textContent).toBe('Dropbox 空间不足：腾出空间后会自动继续')
    expect(backup.querySelector('p.hint.warn')?.getAttribute('title')).toBe('dropbox_full')
    buttonNamed(backup, '断开').click()
    await settled()
    expect(host.asked).toEqual(['断开 Dropbox？已经备份的文件留在 Dropbox 里；之后的新记录不再上传，直到重新连接。'])
    expect(fake.calls.some((item) => item.path === '/api/v1/dropboxBackup:disconnect')).toBe(true)
    expect(card(root, '备份到 Dropbox').querySelector('ol.steps')).not.toBeNull()
  })

  it('lists the feed’s own consumers under it: the last pull and how far behind, late or stale in the warning color', async () => {
    const fake = new FakeServer()
    fake.status = {
      archiveConsumers: [
        { $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'nas', syncedSeq: 10432, lastPullTime: timestampFromMs(NOW - 2 * MINUTE), behindCount: 0, stale: false },
        { $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'backup-disk', syncedSeq: 900, lastPullTime: timestampFromMs(NOW - 3 * 24 * HOUR), behindCount: 0, oldestUnsyncedTime: timestampFromMs(NOW - 3 * 24 * HOUR), stale: true },
        { $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'laptop', syncedSeq: 10400, lastPullTime: timestampFromMs(NOW - 10 * MINUTE), behindCount: 32, oldestUnsyncedTime: timestampFromMs(NOW - 3 * HOUR), stale: false },
        { $typeName: 'recall.ui.v1.ArchiveConsumer', consumer: 'catch-up', syncedSeq: 10, lastPullTime: timestampFromMs(NOW - MINUTE), behindCount: 500, oldestUnsyncedTime: timestampFromMs(NOW - 30 * 24 * HOUR), stale: false },
      ],
    }
    const root = await open(fake, '/settings')
    const rows = [...card(root, '备份到 Dropbox').querySelectorAll('.rows > li')]
    expect(rows.map((row) => row.textContent)).toEqual([
      'NAS2 分钟前同步已全部同步',
      'backup-disk3 天前同步最早一条没同步的是 3 天前',
      'laptop10 分钟前同步落后 32 条（最早一条 3 小时前）',
      'catch-up1 分钟前同步落后 500+ 条（最早一条 30 天前）',
    ])
    expect(rows[0]?.querySelector('.row-head .meta')?.getAttribute('title')).toBe('seq 10432')
    expect(rows[1]?.querySelector('.row-head .meta')?.classList.contains('warn')).toBe(true)
    expect(rows[1]?.querySelector('.facts')?.classList.contains('warn')).toBe(true)
    expect(rows[2]?.querySelector('.facts')?.classList.contains('warn')).toBe(false)
    expect(rows[3]?.querySelector('.facts')?.classList.contains('warn')).toBe(true)
  })

  it('without one, lists none', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect(card(root, '备份到 Dropbox').querySelector('h3')).toBeNull()
  })
})

describe('存储', () => {
  it('counts what is kept and meters the database, R2 and the day’s rows; the index’s reach', async () => {
    const root = await open(new FakeServer(), '/settings')
    const storage = card(root, '存储')
    expect([...storage.querySelectorAll('.kpi')].map((node) => node.textContent)).toEqual(['页面1,234', '访问5,678', '快照345'])
    expect([...storage.querySelectorAll('.gauge-head')].map((node) => node.textContent)).toEqual([
      '数据库120 / 900 MB',
      '云端文件40 MB / 10 GB 免费（账户共用）',
      '今天写入4,210 / 20,000 条记录',
      '今天读取52,000 / 1,500,000 条记录',
    ])
    expect([...storage.querySelectorAll('[role="meter"]')].map((node) => [node.getAttribute('aria-valuenow'), node.getAttribute('aria-valuemax'), node.className])).toEqual([
      ['120', '900', 'meter'],
      ['40', '10240', 'meter'],
      ['4210', '20000', 'meter'],
      ['52000', '1500000', 'meter'],
    ])
    expect(storage.querySelector(':scope > p.hint')?.textContent).toBe('正文搜索覆盖全部')
  })

  it('warns near the budget and when the day’s rows ran out; large counts stay short', async () => {
    const fake = new FakeServer()
    fake.status = { storageUsedMib: 860, rowsWrittenTodayCount: 20000, rowsReadTodayCount: 1_500_000, pageCount: 12_345, visitCount: 220_000, documentCount: 1_234_567, oldestIndexedTextTime: timestampFromMs(at('2025-03-04 10:00')) }
    const root = await open(fake, '/settings')
    const storage = card(root, '存储')
    expect([...storage.querySelectorAll('[role="meter"]')].map((node) => node.className)).toEqual(['meter warn', 'meter', 'meter warn', 'meter warn'])
    expect([...storage.querySelectorAll('.gauge .hint.warn')].map((node) => node.textContent)).toEqual([
      '接近上限：最早页面的正文会移出搜索索引（标题和网址仍能搜到，全文仍可从云端或 Dropbox 归档读取）',
      '今天的写入额度用完了，上传会等到明天（UTC）再继续，扩展里的记录不会丢',
      '今天的读取额度用完了，搜索要等到明天（UTC）；时间线和页面照常能看',
    ])
    expect([...storage.querySelectorAll('.kpi-value')].map((node) => node.textContent)).toEqual(['1.2 万', '22.0 万', '123 万'])
    expect(storage.querySelector(':scope > p.hint')?.textContent).toBe('正文搜索覆盖 2025年3月 起')
    expect(root.querySelector('.status-line .problem')?.textContent).toBe('存储接近上限')
  })
})

describe('正文在云端保留', () => {
  const retention = (root: HTMLElement) => card(root, '存储').querySelector<HTMLSelectElement>('[id="retention"]') ?? (() => { throw new Error('no choice') })()
  const choose = async (root: HTMLElement, value: string) => {
    const select = retention(root)
    select.focus()
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settled()
  }

  it('shows the window, the texts in the cloud and only in Dropbox, and why nothing leaves the cloud now', async () => {
    const fake = new FakeServer()
    fake.status = { documentCount: 345, archivedTextCount: 45, textRetentionPausedReason: 'dropbox_not_connected' }
    const root = await open(fake, '/settings')
    const storage = card(root, '存储')
    expect(storage.querySelector('label[for="retention"]')?.textContent).toBe('正文和截图在云端保留')
    expect(retention(root).value).toBe('7')
    expect([...retention(root).options].map((node) => node.textContent)).toEqual(['7 天', '30 天', '90 天', '180 天', '1 年', '2 年', '3 年', '5 年', '10 年', '永久'])
    expect(storage.querySelector('.retention + p.hint')?.textContent).toBe(
      '最近 7 天的正文和截图留在云端；更早的内容确认已备份后移到 Dropbox，打开快照时按需读取。页面、访问记录和预算范围内的全文索引继续保留。',
    )
    expect([...storage.querySelectorAll('.stack .facts span')].map((node) => node.textContent)).toEqual(['云端 300 份', '已归档 45 份'])
    const pause = storage.querySelector('.stack p.hint.warn')
    expect([pause?.textContent, pause?.getAttribute('title')]).toEqual(['Dropbox 备份未连接：暂不从云端移除正文和截图，连接后自动开始', 'dropbox_not_connected'])
  })

  it('says when a failing backup keeps the texts in the cloud, and shows a window the list does not offer', async () => {
    const fake = new FakeServer()
    fake.settings.textRetentionDays = 400
    fake.status = { textRetentionPausedReason: 'dropbox_failing' }
    const root = await open(fake, '/settings')
    expect(retention(root).value).toBe('400')
    expect(retention(root).options[0]?.textContent).toBe('400 天')
    expect(card(root, '存储').querySelector('.stack p.hint.warn')?.textContent).toBe('Dropbox 备份最近失败：暂不从云端移除正文和截图，备份恢复后自动继续')
  })

  it('asks before a shorter window, sends only it with the etag, and the lists save on top of its change', async () => {
    const fake = new FakeServer()
    fake.settings.textRetentionDays = 365
    const host = testHost()
    const root = await open(fake, '/settings', host)
    await choose(root, '90')
    expect(host.asked).toEqual(['改成保留 90 天？更早的正文和截图在 Dropbox 确认备份后会从云端移除，打开时从归档读取；页面、访问记录和全文索引不变。'])
    const update = fake.calls.find((call) => call.method === 'PATCH')
    expect(update?.path).toMatch(/^\/api\/v1\/settings\?update_mask=text_retention_days%2Cetag&request_id=[0-9a-f-]{36}$/)
    expect(update?.body).toEqual({ text_retention_days: 90, etag: 's1' })
    expect(fake.settings.textRetentionDays).toBe(90)
    expect(toastText(root)).toBe('正文和截图在云端保留 90 天')
    expect(retention(root).value).toBe('90')
    expect(document.activeElement).toBe(retention(root))
    // The lists' next change carries the etag the window's change gave.
    const list = card(root, '网站名单')
    const field = list.querySelector<HTMLInputElement>('input')
    if (field === null) throw new Error('no field')
    type(field, 'wiki.example')
    buttonNamed(list, '添加').click()
    await settled()
    expect(fake.calls.filter((call) => call.method === 'PATCH')[1]?.body).toMatchObject({ etag: 's1+' })
    expect(fake.settings.siteOnlyPatterns).toEqual(['wiki.example'])
    // A longer window asks nothing.
    await choose(root, '730')
    expect(host.asked).toHaveLength(1)
    expect(fake.settings.textRetentionDays).toBe(730)
  })

  it('keeps the window when the owner says no, and keeps every text with 永久 without asking', async () => {
    const fake = new FakeServer()
    fake.settings.textRetentionDays = 365
    fake.status = { textRetentionPausedReason: 'dropbox_not_connected' }
    const host = testHost(false)
    const root = await open(fake, '/settings', host)
    await choose(root, '30')
    expect([host.asked.length, retention(root).value, fake.calls.some((call) => call.method === 'PATCH')]).toEqual([1, '365', false])
    await choose(root, 'off')
    expect(host.asked).toHaveLength(1)
    const update = fake.calls.find((call) => call.method === 'PATCH')
    expect(update?.path).toContain('update_mask=text_retention_days%2Cetag')
    // Named in the mask without a value: kept forever.
    expect(update?.body).toEqual({ etag: 's1' })
    expect(fake.settings.textRetentionDays).toBeUndefined()
    expect(toastText(root)).toBe('正文和截图会一直留在云端')
    const storage = card(root, '存储')
    expect([retention(root).value, storage.querySelector('.retention + p.hint')?.textContent, storage.querySelector('.stack p.hint.warn')]).toEqual(['off', '所有正文和截图都留在云端。', null])
  })
})

describe('网站名单', () => {
  it('adds a pattern from a pasted address to 只记网站 by default, sending only the two lists with the etag', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    const list = card(root, '网站名单')
    expect(list.querySelector('.card-head .meta')?.textContent).toBe('1 条')
    const field = list.querySelector<HTMLInputElement>('input')
    if (field === null) throw new Error('no field')
    type(field, 'https://Portal.Bank.Example/#/accounts')
    buttonNamed(list, '添加').click()
    await settled()
    const update = fake.calls.find((call) => call.method === 'PATCH')
    expect(update?.path).toMatch(/^\/api\/v1\/settings\?update_mask=denylist_patterns%2Csite_only_patterns%2Cetag&request_id=[0-9a-f-]{36}$/)
    expect(update?.body).toEqual({ denylist_patterns: ['bank.example'], site_only_patterns: ['portal.bank.example'], etag: 's1' })
    const rows = () => [...list.querySelectorAll('.patterns li')].map((row) => [row.querySelector('.mono')?.textContent, row.querySelector('.chip')?.textContent])
    expect(rows()).toEqual([
      ['portal.bank.example', '只记网站'],
      ['bank.example', '不存正文'],
    ])
    expect(list.querySelector('.card-head .meta')?.textContent).toBe('2 条')
    expect(toastText(root)).toBe('已添加 portal.bank.example（只记网站）')
    expect(document.activeElement).toBe(list.querySelector('input'))
  })

  it('adds to 不存正文 when chosen; a pattern moves from one list to the other', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    const list = card(root, '网站名单')
    buttonNamed(list, '不存正文').click()
    const field = list.querySelector<HTMLInputElement>('input')
    if (field === null) throw new Error('no field')
    type(field, 'wiki.example/private')
    buttonNamed(list, '添加').click()
    await settled()
    expect(fake.settings.denylistPatterns).toEqual(['bank.example', 'wiki.example/private'])
    // bank.example to 只记网站: it leaves 不存正文.
    buttonNamed(list, '只记网站').click()
    const again = list.querySelector<HTMLInputElement>('input')
    if (again === null) throw new Error('no field')
    type(again, 'bank.example')
    buttonNamed(list, '添加').click()
    await settled()
    expect([fake.settings.siteOnlyPatterns, fake.settings.denylistPatterns]).toEqual([['bank.example'], ['wiki.example/private']])
  })

  it('removes a pattern with its ✕, with the etag the last change gave', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    const list = card(root, '网站名单')
    buttonNamed(list, '移除 bank.example').click()
    await settled()
    // The wire profile leaves an empty list out; the mask still names it, so the list becomes empty.
    const update = fake.calls.find((call) => call.method === 'PATCH')
    expect(update?.path).toContain('update_mask=denylist_patterns%2Csite_only_patterns%2Cetag')
    expect(update?.body).toEqual({ etag: 's1' })
    expect(list.querySelector('.patterns')).toBeNull()
    expect(fake.settings.denylistPatterns).toEqual([])
  })

  it('shows the server’s refusal, and after a stale etag the list as it is now', async () => {
    const fake = new FakeServer()
    const root = await open(fake, '/settings')
    const list = card(root, '网站名单')
    const field = list.querySelector<HTMLInputElement>('input')
    if (field === null) throw new Error('no field')
    type(field, 'bad_host!')
    buttonNamed(list, '添加').click()
    await settled()
    expect(toastText(root)).toBe('网站格式不对')
    // Another tab changed the list meanwhile.
    fake.settings = Object.assign(fake.settings, { denylistPatterns: ['bank.example', 'other.example'], etag: 's9' })
    const again = list.querySelector<HTMLInputElement>('input')
    if (again === null) throw new Error('no field')
    type(again, 'new.example')
    buttonNamed(list, '添加').click()
    await settled()
    expect(toastText(root)).toBe('设置已在别处修改，已载入最新内容')
    expect([...list.querySelectorAll('.patterns .mono')].map((node) => node.textContent)).toEqual(['bank.example', 'other.example'])
  })

  it('folds the built-in lists in their two groups', async () => {
    const root = await open(new FakeServer(), '/settings')
    const builtin = card(root, '网站名单').querySelector('details')
    expect(builtin?.querySelector('summary')?.textContent).toBe('内置 3 条')
    expect([...(builtin?.querySelectorAll('h3') ?? [])].map((node) => node.textContent)).toEqual(['只记网站', '不存正文'])
    expect([...(builtin?.querySelectorAll('.builtin') ?? [])].map((node) => node.textContent)).toEqual(['mail.examplechat.example', 'ziyixi.science'])
  })

  it('ends with the build’s short commit', async () => {
    const root = await open(new FakeServer(), '/settings')
    expect(root.querySelector('.build')?.textContent).toBe('版本 0123456')
  })
})

describe('a failure', () => {
  it('shows one line with 重试 where the content would be, and 重试 asks again', async () => {
    const fake = new FakeServer()
    fake.statusFailures = 1
    const root = await open(fake, '/settings')
    expect(root.querySelector('.status-line')?.textContent).toBe('状态读取失败')
    expect(root.querySelector('#view .error-line span')?.textContent).toBe('服务暂时不可用，请稍后再试')
    buttonNamed(root, '重试').click()
    await settled()
    expect(cards(root).map((node) => node.querySelector('h2')?.textContent)).toEqual(['设备', '插件口令', '备份到 Dropbox', '存储', '网站名单'])
    expect(root.querySelector('.status-line')?.textContent).toBe('最近连接 3 分钟前Dropbox 已备份')
  })
})
