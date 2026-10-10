/**
 * 设置 (`/settings`, ../../docs/design.md §8.7): four cards and the build, in the owner's words (a code stays in a
 * tooltip only).
 *
 * - 设备: each device's label, latest upload (warning after 24 hours, with what to check), version, outbox, its last
 *   error as a sentence that says what to do, and clock skew; without one, the three steps to connect one; items
 *   uploads lost in the last 7 days, and items waiting for a recall that reads them.
 * - 归档: each archive consumer's last pull and how far behind it is; without one, where the archive contract lives.
 * - 存储: the database against its budget, the texts kept in the cloud, today's records written and read against the
 *   daily budgets, the counts and how far back the text index reaches.
 * - 网站名单: the owner's patterns in two lists, 只记网站 (no title or path: their own banks) and 不存正文, each with
 *   ✕, an add field with its list chosen, the built-in lists folded. Every change sends only the two lists with the
 *   settings' etag.
 */
import type { ServiceStatus, Settings } from '@ziyixi/proto/recall/ui/v1/status_pb'
import { api } from '../api.ts'
import { card, disclosure, emptyState, kpi, meter, segmented } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { ago, compact, count, monthText, ms, span } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { behindText, consumerName, late, STORAGE_HIGH_MIB } from '../health.ts'
import { act, frame } from './common.ts'

/** R2's free storage, shared by every app of the account (10 GB-month). */
const R2_FREE_MB = 10 * 1024

/** A device's last error code in words, and whether it needs the owner. */
const DEVICE_ERRORS: Readonly<Record<string, readonly [string, boolean]>> = {
  outbox_full: ['扩展存储已满，新页面的正文没有保存：打开扩展的选项检查', true],
  capture_failed: ['有页面的正文没读到（页面不让扩展读取时会这样）', false],
  upload_failed: ['上传失败过，扩展会自动重试', false],
}

/** A refusal's reason in words. */
const REFUSALS: Readonly<Record<string, string>> = {
  invalid_item: '格式不对',
  id_conflict: '编号冲突',
}

export async function renderSettings(ctx: ViewContext): Promise<void> {
  const now = ctx.host.now()
  await frame(ctx.main, '设置', async (body) => {
    const [status, settings] = await Promise.all([ctx.status(), api.getSettings({ name: 'settings' })])
    const denylist = el('div', { class: 'denylist' })
    paintDenylist(denylist, settings)
    fill(
      body,
      devicesCard(status, now),
      archiveCard(status, now),
      storageCard(status),
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
        el('li', {}, '在自己的电脑上运行 ', el('code', { class: 'mono' }, 'node recall/deploy/mint-tokens.mjs'), '，生成上传令牌（已复制到剪贴板）'),
        el('li', {}, '在 Chrome 打开 ', el('code', { class: 'mono' }, 'chrome://extensions'), '，打开开发者模式，加载扩展的文件夹'),
        el('li', {}, '在扩展的选项里粘贴令牌，填上设备名'),
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
        const [error, urgent] = device.lastErrorCode === '' ? ['', false] : (DEVICE_ERRORS[device.lastErrorCode] ?? ['扩展报告了一个错误', false])
        return el(
          'li',
          {},
          el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, device.label), el('span', { class: device.stale ? 'meta warn' : 'meta' }, `最近上传 ${heard === null ? '—' : ago(heard, now)}`)),
          device.stale ? el('p', { class: 'hint warn' }, '检查 Chrome 是否开着、扩展是否启用（开发者模式）') : null,
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

function archiveCard(status: ServiceStatus, now: number): HTMLElement {
  if (status.archiveConsumers.length === 0) {
    return card('归档', '', emptyState('还没有归档连上', ''), el('p', { class: 'hint' }, '归档的接口与格式见仓库里的 ', el('code', { class: 'mono' }, 'contracts/recall-archive-v1/README.md')))
  }
  return card(
    '归档',
    '',
    el(
      'ul',
      { class: 'rows' },
      ...status.archiveConsumers.map((consumer) => {
        const pulled = ms(consumer.lastPullTime)
        const oldest = ms(consumer.oldestUnsyncedTime)
        // A stale archive is not counted: its oldest change not archived says how far behind it is.
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
      }),
    ),
  )
}

function storageCard(status: ServiceStatus): HTMLElement {
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
    el('div', { class: 'kpis' }, kpi('页面', compact(status.pageCount)), kpi('访问', compact(status.visitCount)), kpi('正文', compact(status.documentCount))),
    line(
      '数据库',
      `${count(used)} / ${count(budget)} MB`,
      meter(used, budget, '数据库用量', used >= budget ? 'danger' : used >= STORAGE_HIGH_MIB ? 'warn' : ''),
      used >= STORAGE_HIGH_MIB ? '接近上限：最早页面的正文会移出搜索索引（标题和网址仍能搜到，全文仍在云端和归档里）' : '',
    ),
    line('云端正文', `${count(status.blobStoredMib)} MB / 10 GB 免费（账户共用）`, meter(status.blobStoredMib, R2_FREE_MB, '云端正文用量')),
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
function paintDenylist(box: HTMLElement, settings: Settings, focusField = false, adding: List = 'siteOnly'): void {
  const lists: Record<List, readonly string[]> = { siteOnly: settings.siteOnlyPatterns, noText: settings.denylistPatterns }
  const save = async (next: Record<List, readonly string[]>, done: string, keepFocus: boolean) => {
    const saved = await act(
      (requestId) =>
        api.updateSettings({
          settings: { name: 'settings', denylistPatterns: [...next.noText], siteOnlyPatterns: [...next.siteOnly], etag: settings.etag },
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
    paintDenylist(box, shown, keepFocus, list)
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
    el('p', { class: 'hint' }, '只记网站：只记录访问时间和网站，不记标题和路径（自己的银行、私人网站）。不存正文：记录访问时间、网址和标题，不保存正文。'),
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
