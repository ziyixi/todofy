/**
 * 设置 (`/settings`, ../../docs/design.md §8.7): five cards and the build, in the owner's words (a code stays in a
 * tooltip only).
 *
 * - 设备: each device's label, latest upload (desktop warning after 24 hours; mobile foreground-only note), version, outbox, its last
 *   error as a sentence that says what to do, and clock skew; without one, the three steps to connect one (clicks
 *   only); items uploads lost in the last 7 days, and items waiting for a recall that reads them.
 * - 插件口令: the extension's token: 生成 or 重新生成 (the old one works 24 hours more), ⋯ to revoke the old one at once
 *   or to stop uploads; a new token is shown once, to copy into the extension's options. The export token of the
 *   change feed, optional, folded under it.
 * - 备份到 Dropbox: not connected, the four steps at Dropbox and the App key field with 连接 (the browser goes to
 *   Dropbox and comes back here with `?dropbox=<outcome>`); connected, the account, the last upload, what waits, the
 *   last failure in words and 断开. The feed's own consumers, if any, under it.
 * - 存储: the database against its budget, the texts kept in the cloud, how long a text stays there (the retention
 *   window, chosen from a short list; shortening it asks first), how many texts are in the cloud and how many only in
 *   Dropbox, and a line while Dropbox keeps retention paused; today's records written and read against the daily
 *   budgets, the counts and how far back the text index reaches.
 * - 网站名单: the owner's patterns in two lists, 只记网站 (no title or path: their own banks) and 不存正文, each with
 *   ✕, an add field with its list chosen, the built-in lists folded. Every change sends only the two lists with the
 *   settings' etag.
 *
 * The retention window and the lists share the settings' etag: each saves on top of the other's last change.
 */
import type { ArchiveConsumer, DropboxBackup, ServiceStatus, Settings } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api } from '../api.ts'
import { card, disclosure, kpi, meter, segmented } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { ago, compact, count, monthText, ms, span } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { backupLate, behindText, consumerName, late, STORAGE_HIGH_MIB } from '../health.ts'
import { act, frame } from './common.ts'
import { paintTokens } from './tokens.ts'

/** R2's free storage, shared by every app of the account (10 GB-month). */
const R2_FREE_MB = 10 * 1024

/** A device's last error code in words, and whether it needs the owner. */
const DEVICE_ERRORS: Readonly<Record<string, readonly [string, boolean]>> = {
  outbox_full: ['扩展存储已满，新页面的内容没有保存：打开扩展的选项检查', true],
  capture_failed: ['有页面的正文没读到（页面不让扩展读取时会这样）', false],
  screenshot_failed: ['有页面的截图没保存，已读取的正文仍会保存', false],
  upload_failed: ['上传失败过，扩展会自动重试', false],
}

/** A refusal's reason in words. */
const REFUSALS: Readonly<Record<string, string>> = {
  invalid_item: '格式不对',
  id_conflict: '编号冲突',
}

/** The Dropbox backup's last failure in words, and whether it needs the owner. */
const BACKUP_ERRORS: Readonly<Record<string, readonly [string, boolean]>> = {
  dropbox_refused: ['Dropbox 撤销了授权（或应用被删除了）：重新连接', true],
  dropbox_permission: ['Dropbox 应用缺少权限：在应用的 Permissions 里勾选 files.content.write 和 files.content.read，断开后再连接', true],
  dropbox_full: ['Dropbox 空间不足：腾出空间后会自动继续', true],
  dropbox_other_feed: ['这个 Dropbox 应用文件夹里已有另一份 recall 的归档：新建一个 Dropbox 应用，断开后用它的 App key 连接', true],
  dropbox_conflict: ['Dropbox 里有同名但内容不同的文件，没有覆盖它', true],
  dropbox_bad_request: ['Dropbox 拒绝了请求：断开后检查 App key 再连接', true],
  dropbox_revoke_failed: ['已断开，但 Dropbox 那边的授权没能撤销：可在 Dropbox 网站的 设置 → 已连接的应用 里移除', false],
  dropbox_rate_limited: ['Dropbox 暂时限流，稍后自动继续', false],
  dropbox_unavailable: ['暂时连不上 Dropbox，稍后自动重试', false],
  dropbox_token: ['Dropbox 的访问令牌到期了，正在自动续期', false],
  r2_unavailable: ['云端存储暂时不可用，稍后自动重试', false],
}

/** Why retention removes nothing now, in words (ServiceStatus.text_retention_paused_reason). */
const RETENTION_PAUSES: Readonly<Record<string, string>> = {
  dropbox_not_connected: 'Dropbox 备份未连接：暂不从云端移除正文和截图，连接后自动开始',
  dropbox_failing: 'Dropbox 备份最近失败：暂不从云端移除正文和截图，备份恢复后自动继续',
}

/** The retention windows offered, in days; null keeps every text in the cloud. */
const RETENTION_CHOICES: readonly (number | null)[] = [7, 30, 90, 180, 365, 730, 1095, 1825, 3650, null]

/** A retention window in words: `90 天`, `1 年`, `永久`. */
function retentionName(days: number | null): string {
  if (days === null) return '永久'
  return days % 365 === 0 ? `${String(days / 365)} 年` : `${String(days)} 天`
}

/** The settings two cards change (the lists and the retention window): one etag, the latest answer of either. */
interface SettingsBox {
  current: Settings
}

/** What the browser came back from Dropbox with (/settings?dropbox=<outcome>). */
const CONNECT_OUTCOMES: Readonly<Record<string, string>> = {
  connected: '已连接 Dropbox：几分钟内开始备份',
  denied: '你在 Dropbox 取消了授权，没有连接',
  expired: '这次连接已过期：请再点一次 连接',
  failed: '没有连上 Dropbox：检查 App key 和 Redirect URI 后再试',
}

export async function renderSettings(ctx: ViewContext): Promise<void> {
  const now = ctx.host.now()
  const outcome = new URLSearchParams(window.location.search).get('dropbox')
  if (outcome !== null) {
    // Once: the outcome leaves the address, so a reload says nothing again.
    ctx.replace('/settings')
    toast(CONNECT_OUTCOMES[outcome] ?? CONNECT_OUTCOMES['failed'] ?? '')
  }
  await frame(ctx.main, '设置', async (body) => {
    const [status, settings] = await Promise.all([ctx.status(), api.getSettings({ name: 'settings' })])
    const shared: SettingsBox = { current: settings }
    const denylist = el('div', { class: 'denylist' })
    paintDenylist(denylist, shared)
    const tokens = el('div', { class: 'tokens' })
    paintTokens(ctx, tokens, status.machineTokens)
    fill(
      body,
      devicesCard(status, now),
      card('插件口令', '', tokens),
      backupCard(ctx, status, now),
      storageCard(ctx, status, shared),
      card('网站名单', `${String(settings.siteOnlyPatterns.length + settings.denylistPatterns.length)} 条`, denylist),
      status.build === '' ? null : el('p', { class: 'meta build' }, `版本 ${status.build.slice(0, 7)}`),
    )
  })
}

function devicesCard(status: ServiceStatus, now: number): HTMLElement {
  const notes = status.rejectedItems.map((item) =>
    item.reason === 'unsupported_item'
      ? el('p', { class: 'hint', role: 'note' }, `7 天内有 ${String(item.count)} 条记录来自比 recall 新的扩展，正在扩展里等 recall 更新后再上传`)
      : el('p', { class: 'hint warn', role: 'note', title: item.reason }, `7 天内有 ${String(item.count)} 条上传被拒（${REFUSALS[item.reason] ?? '其他原因'}），已丢失：扩展可能有问题`),
  )
  if (status.devices.length === 0) {
    return card(
      '设备',
      '',
      el('p', {}, '还没有设备上传。连上一台：'),
      el(
        'ol',
        { class: 'steps' },
        el('li', {}, '在下面的 插件口令 填写设备名，点 添加设备口令 并复制'),
        el('li', {}, '在 Chrome 打开 ', el('code', { class: 'mono' }, 'chrome://extensions'), '，打开 开发者模式，点 加载已解压的扩展程序，选扩展的文件夹'),
        el('li', {}, '在扩展的选项里粘贴口令，填上设备名（服务器地址已经填好）'),
      ),
      ...notes,
    )
  }
  return card(
    '设备',
    `${String(status.devices.length)} 台`,
    el(
      'ul',
      { class: 'rows' },
      ...status.devices.map((device) => {
        const heard = ms(device.lastHeartbeatTime)
        const skew = device.clockSkewSeconds
        const stale = device.stale && !device.mobile
        const [error, urgent] = device.lastErrorCode === '' ? ['', false] : (DEVICE_ERRORS[device.lastErrorCode] ?? ['扩展报告了一个错误', false])
        return el(
          'li',
          {},
          el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, device.label), el('span', { class: stale ? 'meta warn' : 'meta' }, `最近上传 ${heard === null ? '—' : ago(heard, now)}`)),
          stale ? el('p', { class: 'hint warn' }, '检查 Chrome 是否开着、扩展是否启用（开发者模式）') : null,
          device.mobile ? el('p', { class: 'hint' }, '手机仅在浏览器前台运行，打开后继续采集和上传。') : null,
          error === '' ? null : el('p', { class: urgent ? 'hint warn' : 'hint', title: device.lastErrorCode }, error),
          el(
            'p',
            { class: 'facts' },
            el('span', {}, `版本 ${device.extensionVersion}`),
            el('span', {}, `待上传 ${count(device.queuedCount)}`),
            skew === 0 ? null : el('span', { class: 'warn' }, `时钟差 ${span(skew * 1000)}`),
          ),
        )
      }),
    ),
    ...notes,
  )
}

/** The 备份到 Dropbox card: the connection or the steps to make one, and the feed's own consumers under it. */
function backupCard(ctx: ViewContext, status: ServiceStatus, now: number): HTMLElement {
  const backup = status.dropboxBackup
  const body = backup?.connected === true ? connectedBackup(ctx, backup, now) : connectBackup(ctx, backup)
  const consumers = status.archiveConsumers
  return card(
    '备份到 Dropbox',
    '',
    ...body,
    consumers.length === 0 ? null : el('h3', {}, '读取变更 feed 的程序'),
    consumers.length === 0 ? null : el('ul', { class: 'rows' }, ...consumers.map((consumer) => consumerRow(consumer, now))),
  )
}

function errorLine(backup: DropboxBackup | undefined): HTMLElement | null {
  if (backup === undefined || backup.errorCode === '') return null
  const [text, urgent] = BACKUP_ERRORS[backup.errorCode] ?? ['备份到 Dropbox 时出错，稍后自动重试', false]
  return el('p', { class: urgent ? 'hint warn' : 'hint', title: backup.errorCode }, text)
}

/** Not connected: the steps at Dropbox, the App key and 连接. */
function connectBackup(ctx: ViewContext, backup: DropboxBackup | undefined): HTMLElement[] {
  const field = el('input', { type: 'text', placeholder: 'App key', 'aria-label': 'Dropbox App key', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', value: backup?.appKey ?? '' })
  const connect = async () => {
    const appKey = field.value.trim()
    if (appKey === '') {
      toast('先粘贴 Dropbox 应用的 App key')
      return
    }
    await act((requestId) => api.connectDropboxBackup({ name: 'dropboxBackup', appKey, requestId }), '正在前往 Dropbox…', (answer) => {
      ctx.host.navigate(answer.authorizeUrl)
    })
  }
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void connect()
  })
  return [
    errorLine(backup),
    el('p', {}, '还没有连接。recall 会把归档（访问记录、正文、截图和删除记录）大约每小时写进你自己的 Dropbox 应用文件夹；NAS 再用 Cloud Drives 把它同步下来。连接一次：'),
    el(
      'ol',
      { class: 'steps' },
      el('li', {}, '在 Dropbox 网站打开 ', el('code', { class: 'mono' }, 'dropbox.com/developers/apps'), '，Create app：Scoped access → App folder → 任意名字'),
      el('li', {}, '在应用的 Permissions 里勾选 files.content.write 和 files.content.read，点 Submit'),
      el('li', {}, '在 Settings → OAuth 2 → Redirect URIs 里加上 ', el('code', { class: 'mono' }, `${window.location.origin}/api/dropbox/callback`)),
      el('li', {}, '复制同一页的 App key，粘贴到这里，点 连接，在 Dropbox 里允许'),
    ),
    el('div', { class: 'actions' }, field, button('连接', () => void connect())),
  ].filter((node): node is HTMLElement => node !== null)
}

/** Connected: the account, the last upload, what waits, the last failure, 断开. */
function connectedBackup(ctx: ViewContext, backup: DropboxBackup, now: number): HTMLElement[] {
  const uploaded = ms(backup.lastUploadTime)
  const oldest = ms(backup.oldestPendingTime)
  const behind = backupLate(backup.oldestPendingTime, backup.connectTime, now)
  const disconnect = async () => {
    if (!ctx.host.confirm('断开 Dropbox？已经备份的文件留在 Dropbox 里；之后的新记录不再上传，直到重新连接。')) return
    await act((requestId) => api.disconnectDropboxBackup({ name: 'dropboxBackup', requestId }), '已断开 Dropbox', async () => {
      await ctx.go('/settings')
    })
  }
  return [
    el(
      'div',
      { class: 'row-head' },
      el('span', { class: 'row-title' }, backup.accountDisplayName === '' ? 'Dropbox' : `Dropbox · ${backup.accountDisplayName}`),
      el('span', { class: 'meta', title: `seq ${String(backup.syncedSeq)}` }, uploaded === null ? '还没上传' : `${ago(uploaded, now)}上传`),
    ),
    el('p', { class: behind ? 'facts warn' : 'facts' }, oldest === null ? '已全部备份' : `待备份 ${behindText(backup.pendingCount)}（最早一条 ${ago(oldest, now)}）`),
    errorLine(backup),
    el('p', { class: 'hint' }, '只增不删：删除页面后，备份里多一条删除记录，原来的文件留在 Dropbox 里。'),
    el('div', { class: 'actions' }, button('断开', () => void disconnect(), { class: 'quiet' })),
  ].filter((node): node is HTMLElement => node !== null)
}

/** A feed consumer: its name, its last pull and how far behind it is. */
function consumerRow(consumer: ArchiveConsumer, now: number): HTMLElement {
  const pulled = ms(consumer.lastPullTime)
  const oldest = ms(consumer.oldestUnsyncedTime)
  // A stale consumer is not counted: its oldest change not taken says how far behind it is.
  const behind = oldest === null ? '已全部同步' : consumer.stale ? `最早一条没同步的是 ${ago(oldest, now)}` : `落后 ${behindText(consumer.behindCount)}（最早一条 ${ago(oldest, now)}）`
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'row-head' },
      el('span', { class: 'row-title' }, consumerName(consumer.consumer)),
      el('span', { class: consumer.stale ? 'meta warn' : 'meta', title: `seq ${String(consumer.syncedSeq)}` }, pulled === null ? '还没同步' : `${ago(pulled, now)}同步`),
    ),
    el('p', { class: consumer.stale || late(oldest, now) ? 'facts warn' : 'facts' }, behind),
  )
}

/**
 * The retention window: the choice (shortening it asks first), what it means, the texts in the cloud and only in
 * Dropbox, and why nothing leaves the cloud while Dropbox keeps it paused.
 */
function retentionBlock(ctx: ViewContext, status: ServiceStatus, shared: SettingsBox): HTMLElement {
  const box = el('div', { class: 'stack' })
  const paint = () => {
    const days = shared.current.textRetentionDays ?? null
    // A window set through the API that the list does not offer is shown as it is.
    const choices = days !== null && !RETENTION_CHOICES.includes(days) ? [days, ...RETENTION_CHOICES] : RETENTION_CHOICES
    const select = el('select', { id: 'retention' }, ...choices.map((choice) => el('option', { value: choice === null ? 'off' : String(choice) }, retentionName(choice))))
    select.value = days === null ? 'off' : String(days)
    select.addEventListener('change', () => void choose(select.value === 'off' ? null : Number(select.value)))
    const pause = days === null ? '' : (RETENTION_PAUSES[status.textRetentionPausedReason] ?? '')
    // A choice repaints the block: the focus stays on the choice.
    const focused = box.contains(document.activeElement)
    fill(
      box,
      el('div', { class: 'retention' }, el('label', { for: 'retention' }, '正文和截图在云端保留'), select),
      el(
        'p',
        { class: 'hint' },
        days === null
          ? '所有正文和截图都留在云端。'
          : `最近 ${retentionName(days)}的正文和截图留在云端；更早的内容确认已备份后移到 Dropbox，打开快照时按需读取。页面、访问记录和预算范围内的全文索引继续保留。`,
      ),
      el('p', { class: 'facts' }, el('span', {}, `云端 ${count(Math.max(0, status.documentCount - status.archivedTextCount))} 份`), el('span', {}, `已归档 ${count(status.archivedTextCount)} 份`)),
      pause === '' ? null : el('p', { class: 'hint warn', role: 'note', title: status.textRetentionPausedReason }, pause),
    )
    if (focused) select.focus()
  }
  const choose = async (next: number | null) => {
    const days = shared.current.textRetentionDays ?? null
    const shorter = next !== null && (days === null || next < days)
    if (shorter && !ctx.host.confirm(`改成保留 ${retentionName(next)}？更早的正文和截图在 Dropbox 确认备份后会从云端移除，打开时从归档读取；页面、访问记录和全文索引不变。`)) {
      paint()
      return
    }
    const saved = await act(
      (requestId) =>
        api.updateSettings({
          settings: { name: 'settings', ...(next === null ? {} : { textRetentionDays: next }), etag: shared.current.etag },
          updateMask: { paths: ['text_retention_days', 'etag'] },
          requestId,
        }),
      next === null ? '正文和截图会一直留在云端' : `正文和截图在云端保留 ${retentionName(next)}`,
      () => undefined,
    )
    if (saved !== null) shared.current = saved
    else {
      // Refused (another tab changed the settings, or the network): the toast said why; show what is stored now.
      try {
        shared.current = await api.getSettings({ name: 'settings' })
      } catch {
        // Painted as it was.
      }
    }
    paint()
  }
  paint()
  return box
}

function storageCard(ctx: ViewContext, status: ServiceStatus, shared: SettingsBox): HTMLElement {
  const used = status.storageUsedMib
  const budget = status.storageBudgetMib
  const written = status.rowsWrittenTodayCount
  const writeBudget = status.dailyRowBudget
  const read = status.rowsReadTodayCount
  const readBudget = status.dailyReadBudget
  const oldest = ms(status.oldestIndexedTextTime)
  const line = (name: string, figure: string, bar: HTMLElement, note = '') =>
    el('div', { class: 'gauge' }, el('div', { class: 'gauge-head' }, el('span', {}, name), el('span', { class: 'meta' }, figure)), bar, note === '' ? null : el('p', { class: 'hint warn' }, note))
  return card(
    '存储',
    '',
    el('div', { class: 'kpis' }, kpi('页面', compact(status.pageCount)), kpi('访问', compact(status.visitCount)), kpi('快照', compact(status.documentCount))),
    line(
      '数据库',
      `${count(used)} / ${count(budget)} MB`,
      meter(used, budget, '数据库用量', used >= budget ? 'danger' : used >= STORAGE_HIGH_MIB ? 'warn' : ''),
      used >= STORAGE_HIGH_MIB ? '接近上限：最早页面的正文会移出搜索索引（标题和网址仍能搜到，全文仍可从云端或 Dropbox 归档读取）' : '',
    ),
    line('云端文件', `${count(status.blobStoredMib)} MB / 10 GB 免费（账户共用）`, meter(status.blobStoredMib, R2_FREE_MB, '云端正文和截图用量')),
    retentionBlock(ctx, status, shared),
    line(
      '今天写入',
      `${count(written)} / ${count(writeBudget)} 条记录`,
      meter(written, writeBudget, '今天写入的记录数', written >= writeBudget ? 'warn' : ''),
      written >= writeBudget ? '今天的写入额度用完了，上传会等到明天（UTC）再继续，扩展里的记录不会丢' : '',
    ),
    line(
      '今天读取',
      `${count(read)} / ${count(readBudget)} 条记录`,
      meter(read, readBudget, '今天读取的记录数', read >= readBudget ? 'warn' : ''),
      read >= readBudget ? '今天的读取额度用完了，搜索要等到明天（UTC）；时间线和页面照常能看' : '',
    ),
    el('p', { class: 'hint' }, oldest === null ? '正文搜索覆盖全部' : `正文搜索覆盖 ${monthText(oldest)} 起`),
  )
}

/** The owner's two lists. */
type List = 'siteOnly' | 'noText'

const LIST_NAMES: Readonly<Record<List, string>> = { siteOnly: '只记网站', noText: '不存正文' }

/**
 * The 网站名单 card's body: the owner's patterns of both lists with ✕, the add field and its list, the built-in lists
 * folded. After an addition the add field keeps the focus.
 */
function paintDenylist(box: HTMLElement, shared: SettingsBox, focusField = false, adding: List = 'siteOnly'): void {
  const settings = shared.current
  const lists: Record<List, readonly string[]> = { siteOnly: settings.siteOnlyPatterns, noText: settings.denylistPatterns }
  const save = async (next: Record<List, readonly string[]>, done: string, keepFocus: boolean) => {
    const saved = await act(
      (requestId) =>
        api.updateSettings({
          settings: { name: 'settings', denylistPatterns: [...next.noText], siteOnlyPatterns: [...next.siteOnly], etag: shared.current.etag },
          updateMask: { paths: ['denylist_patterns', 'site_only_patterns', 'etag'] },
          requestId,
        }),
      done,
      () => undefined,
    )
    let shown = saved
    if (shown === null) {
      // Refused (another tab changed the lists, or the network): the toast said why; show what is stored now.
      try {
        shown = await api.getSettings({ name: 'settings' })
      } catch {
        return
      }
    }
    shared.current = shown
    paintDenylist(box, shared, keepFocus, list)
    box.closest('.card')?.querySelector('.card-head .meta')?.replaceChildren(`${String(shown.siteOnlyPatterns.length + shown.denylistPatterns.length)} 条`)
  }

  let list: List = adding
  const field = el('input', { type: 'text', placeholder: 'example.com 或 example.com/path', 'aria-label': '网站或网址前缀', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' })
  const choice = segmented<List>('加到', [['siteOnly', LIST_NAMES.siteOnly], ['noText', LIST_NAMES.noText]], list, (value) => {
    list = value
    choice.querySelectorAll('button').forEach((node, index) => node.setAttribute('aria-pressed', (index === 0) === (value === 'siteOnly') ? 'true' : 'false'))
  })
  const add = () => {
    // A pasted address loses its scheme, query, fragment and trailing `/`; the Worker checks the rest of the pattern's
    // rule (INVALID_SETTINGS, whose message the toast shows).
    const value = field.value
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
    if (value === '') return
    if (lists[list].includes(value)) {
      toast(`${value} 已在名单里`)
      return
    }
    // A pattern lives in one list: adding it to one takes it out of the other.
    const without = (name: List) => lists[name].filter((item) => item !== value)
    const next: Record<List, readonly string[]> = list === 'siteOnly' ? { siteOnly: [...lists.siteOnly, value], noText: without('noText') } : { siteOnly: without('siteOnly'), noText: [...lists.noText, value] }
    void save(next, `已添加 ${value}（${LIST_NAMES[list]}）`, true)
  }
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    add()
  })

  const rows = (['siteOnly', 'noText'] as const).flatMap((name) =>
    lists[name].map((pattern) =>
      el(
        'li',
        {},
        el('span', { class: 'mono' }, pattern),
        el('span', { class: 'chip muted' }, LIST_NAMES[name]),
        button('✕', () => void save({ ...lists, [name]: lists[name].filter((item) => item !== pattern) }, `已移除 ${pattern}`, false), { class: 'quiet icon', 'aria-label': `移除 ${pattern}` }),
      ),
    ),
  )
  const builtin = settings.builtinSiteOnlyPatterns.length + settings.builtinDenylistPatterns.length
  fill(
    box,
    el('p', { class: 'hint' }, '只记网站：只记录访问时间和网站，不记标题和路径（自己的银行、私人网站）。不存正文：记录访问时间、网址和标题，不保存正文和截图。'),
    rows.length === 0 ? null : el('ul', { class: 'patterns' }, ...rows),
    el('div', { class: 'actions' }, field, choice, button('添加', add)),
    disclosure(
      `内置 ${String(builtin)} 条`,
      el('h3', {}, '只记网站'),
      el('p', { class: 'hint' }, '邮件、聊天、银行、控制台：不记标题和路径'),
      el('ul', { class: 'builtin' }, ...settings.builtinSiteOnlyPatterns.map((pattern) => el('li', { class: 'mono' }, pattern))),
      el('h3', {}, '不存正文'),
      el('ul', { class: 'builtin' }, ...settings.builtinDenylistPatterns.map((pattern) => el('li', { class: 'mono' }, pattern))),
    ),
  )
  if (focusField) field.focus()
}
