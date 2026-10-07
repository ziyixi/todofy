/**
 * 设置 (`/settings`): three cards only.
 *
 * - 模式: 关闭, 影子 or 正式, and one line on what is in force (the deployment's MAILSORT_MODE ceiling or the breaker may
 *   lower the owner's choice; 解除熔断 once the breaker tripped). A choice names only `mode` (and the etag) in the
 *   mask, which is what clears a tripped breaker.
 * - 撤销: a time range (1 小时, 24 小时, 7 天 or one's own) and optionally one label; 预览 counts what an undo would take
 *   back, 确认撤销 then undoes it, 20 entries per call, until none is left. The safety net for every write.
 * - Gmail: 从 Gmail 同步 (renames and deletions made in Gmail; the owner's label of a label's path is adopted), and
 *   导出过滤器 (the active rules as Gmail's filter file, downloaded).
 *
 * The other settings (write limits, the neuron budget, thresholds) keep their stored values; the API still takes them.
 */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { Mode, SettingsSchema, type Settings } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { card, disclosure, segmented } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { BREAKER_REASONS, labelText, MODE_NAMES, ms } from '../format.ts'
import type { Host, ViewContext } from '../app.ts'
import { act, allLabels, frame, labelSelect } from './common.ts'

const MODES: readonly (readonly [Mode, string])[] = [Mode.OFF, Mode.SHADOW, Mode.LIVE].map((mode) => [mode, MODE_NAMES[mode] ?? ''] as const)

/** What each mode does, in one line. */
const MODE_HINTS: Readonly<Record<number, string>> = {
  [Mode.OFF]: '不读 Gmail，也不判断',
  [Mode.SHADOW]: '只给建议，不改 Gmail',
  [Mode.LIVE]: '有把握的邮件打标签并归档，从不标为已读',
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

type Range = 'hour' | 'day' | 'week' | 'custom'

const RANGES: readonly (readonly [Range, string])[] = [
  ['hour', '1 小时'],
  ['day', '24 小时'],
  ['week', '7 天'],
  ['custom', '自定义'],
]

const SPANS: Readonly<Record<Exclude<Range, 'custom'>, number>> = { hour: HOUR, day: DAY, week: 7 * DAY }

/** The API's longest range undo (UndoLedgerEntriesRequest.end_time). */
const RANGE_MAX = 31 * DAY

/** A preset range ends this far after the browser's clock, so a write the Worker's clock dates later is still in it. */
const CLOCK_SLACK = 10 * 60_000

/** Ledger pages a preview reads at most: 20 x 50 entries, a week of writes at the daily cap's default. */
const PREVIEW_PAGES_MAX = 20

/** Calls of one range undo at most: 30 x 20 entries, more than a month of writes at the daily cap's default. */
const UNDO_ROUNDS_MAX = 30

/** What SyncLabels did, in the owner's words. */
function syncMessage(answer: { linkedCount: number; renamedCount: number; missingCount: number }): string {
  return `已同步：关联 ${String(answer.linkedCount)}，改名 ${String(answer.renamedCount)}，Gmail 中缺失 ${String(answer.missingCount)}`
}

/** A settings row: its name and one hint line on the left, its control on the right. */
function setting(name: string, hint: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'setting' }, el('div', {}, el('span', {}, name), el('span', { class: 'hint' }, hint)), control)
}

function setMode(settings: Settings, mode: Mode, requestId: string): Promise<Settings> {
  return api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode, etag: settings.etag }), updateMask: { paths: ['mode', 'etag'] }, requestId })
}

function modeCard(settings: Settings, ctx: ViewContext, reload: () => Promise<void>): HTMLElement {
  const after = async () => {
    ctx.refreshStatus()
    await reload()
  }
  const choose = (mode: Mode) => {
    if (mode === settings.mode) return
    if (mode === Mode.LIVE && !ctx.host.confirm('切到正式？开了“正式打”的标签会在 Gmail 里打标签并归档。')) return
    void act((requestId) => setMode(settings, mode, requestId), `已切到${MODE_NAMES[mode] ?? ''}`, after)
  }
  const resetBreaker = () => {
    if (!ctx.host.confirm(`解除熔断，恢复“${MODE_NAMES[settings.mode] ?? ''}”？`)) return
    void act((requestId) => setMode(settings, settings.mode, requestId), '已解除熔断', after)
  }
  const effective = MODE_NAMES[settings.effectiveMode] ?? '—'
  const line = settings.breakerTripped
    ? `已熔断（${BREAKER_REASONS[settings.breakerReason] ?? settings.breakerReason}），暂按影子运行`
    : settings.effectiveMode !== settings.mode
      ? `受部署上限限制，按${effective}运行`
      : (MODE_HINTS[settings.mode] ?? '')
  return card(
    '模式',
    '',
    segmented('模式', MODES, settings.mode, choose),
    el('p', { class: settings.breakerTripped ? 'hint warn' : 'hint' }, line),
    settings.breakerTripped ? el('div', { class: 'actions' }, button('解除熔断', resetBreaker)) : null,
  )
}

/**
 * How many entries of [from, to) a range undo would take back (of `label` when set): the ledger's pages, newest
 * first, until one reaches back before `from`. `capped` when it stopped at PREVIEW_PAGES_MAX first.
 */
async function countUndoable(from: number, to: number, label: string): Promise<{ count: number; capped: boolean }> {
  let count = 0
  let pageToken = ''
  for (let page = 0; page < PREVIEW_PAGES_MAX; page++) {
    const answer = await api.listLedgerEntries({ pageSize: 50, pageToken, label })
    for (const entry of answer.ledgerEntries) {
      const at = ms(entry.createTime) ?? 0
      if (entry.undoable && at >= from && at < to) count += 1
    }
    const oldest = ms(answer.ledgerEntries.at(-1)?.createTime) ?? 0
    if (answer.nextPageToken === '' || oldest < from) return { count, capped: false }
    pageToken = answer.nextPageToken
  }
  return { count, capped: true }
}

/** Undoes every undoable entry of [from, to) (of `label` only when set), 20 per call, and answers the totals. */
async function undoAll(from: number, to: number, label: string): Promise<{ undone: number; failed: number; remaining: number }> {
  const totals = { undone: 0, failed: 0, remaining: 0 }
  for (let round = 0; round < UNDO_ROUNDS_MAX; round++) {
    const requestId = newRequestId()
    const answer = await withRetry(() => api.undoLedgerEntries({ startTime: timestampFromMs(from), endTime: timestampFromMs(to), label, requestId }))
    totals.undone += answer.undoneCount
    totals.failed += answer.failedCount
    totals.remaining = answer.remainingCount
    // Nothing left, or a call that undid nothing (Gmail refused them all): repeating would not help.
    if (answer.remainingCount === 0 || answer.undoneCount === 0) break
  }
  return totals
}

function undoCard(labels: readonly Label[], host: Host): HTMLElement {
  let range: Range = 'day'
  const start = el('input', { type: 'datetime-local', 'aria-label': '开始' })
  const end = el('input', { type: 'datetime-local', 'aria-label': '结束' })
  const custom = el('div', { class: 'range', hidden: true }, start, end)
  const label = labelSelect(labels, '', '全部标签', { 'aria-label': '标签' })
  const result = el('div', { class: 'actions', 'aria-live': 'polite' })
  const ranges = el('div')
  const clear = () => {
    result.replaceChildren()
  }
  const paintRanges = () => {
    ranges.replaceChildren(
      segmented('时间', RANGES, range, (value) => {
        range = value
        custom.hidden = value !== 'custom'
        paintRanges()
        clear()
      }),
    )
  }
  for (const input of [start, end, label]) input.addEventListener('change', clear)

  const bounds = (): [number, number] | string => {
    if (range !== 'custom') {
      const to = host.now() + CLOCK_SLACK
      return [to - CLOCK_SLACK - SPANS[range], to]
    }
    const from = Date.parse(start.value)
    const to = Date.parse(end.value)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '请选择开始和结束时间'
    if (to - from > RANGE_MAX) return '最多 31 天'
    return [from, to]
  }
  const undo = async (from: number, to: number, only: string) => {
    for (const node of result.querySelectorAll('button')) node.disabled = true
    try {
      const { undone, failed, remaining } = await undoAll(from, to, only)
      toast(`已撤销 ${String(undone)} 条${failed > 0 ? `，${String(failed)} 条失败` : ''}${remaining > 0 ? `，还剩 ${String(remaining)} 条` : ''}`)
    } catch (error) {
      toast(errorMessage(error))
    }
    clear()
  }
  const preview = async () => {
    const span = bounds()
    if (typeof span === 'string') {
      toast(span)
      return
    }
    const [from, to] = span
    const only = label.value
    result.replaceChildren(el('span', { class: 'hint' }, '正在统计…'))
    try {
      const { count, capped } = await countUndoable(from, to, only)
      if (count === 0) {
        result.replaceChildren(el('span', { class: 'hint' }, '这段时间没有可撤销的写入'))
        return
      }
      const scope = only === '' ? '' : `“${labelText(only, labels)}”的`
      result.replaceChildren(
        el('span', {}, `将撤销${scope} ${capped ? '至少 ' : ''}${String(count)} 条`),
        button('确认撤销', () => void undo(from, to, only), { class: 'primary' }),
        button('取消', clear, { class: 'quiet' }),
      )
    } catch (error) {
      clear()
      toast(errorMessage(error))
    }
  }
  paintRanges()
  return card(
    '撤销',
    '',
    el('p', { class: 'hint' }, '撤掉本应用在 Gmail 打的标签，归档的邮件回到收件箱。'),
    ranges,
    custom,
    el('div', { class: 'actions' }, label, button('预览', () => void preview())),
    result,
  )
}

function gmailCard(): HTMLElement {
  const exported = el('div', { hidden: true })
  let url = ''
  const exportFilters = async () => {
    const answer = await act(() => api.exportGmailFilters({}), (done) => `已导出 ${String(done.ruleCount)} 条规则`, () => Promise.resolve())
    if (answer === null) return
    if (url !== '') URL.revokeObjectURL(url)
    url = URL.createObjectURL(new Blob([answer.xml], { type: 'application/xml' }))
    const link = el('a', { href: url, download: 'mailsort-filters.xml' }, '下载过滤器文件')
    fill(
      exported,
      el('p', {}, `${String(answer.ruleCount)} 条规则 · `, link),
      answer.skippedCount === 0
        ? null
        : disclosure(
            `${String(answer.skippedCount)} 条没有导出`,
            el('p', {}, '过滤器查不了 DMARC，所以可信类和要求 DMARC 的规则不导出；带主题条件的规则和它覆盖的同一发件人的普通规则也不导出，否则 Gmail 会同时套用两条。'),
          ),
      el('p', { class: 'hint' }, '在 Gmail 设置 → 过滤器和屏蔽的地址 → 导入过滤器。'),
    )
    exported.hidden = false
    link.click()
  }
  return card(
    'Gmail',
    '',
    setting('从 Gmail 同步', '跟上你在 Gmail 里的改名和删除，沿用同名标签', button('同步', () => void act((requestId) => api.syncLabels({ requestId }), syncMessage, () => Promise.resolve()))),
    setting('导出过滤器', '把规则存成 Gmail 能导入的过滤器文件', button('导出', () => void exportFilters())),
    exported,
  )
}

export async function renderSettings(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '设置', async (body) => {
    const [settings, labels] = await Promise.all([api.getSettings({ name: 'settings' }), allLabels()])
    body.replaceChildren(modeCard(settings, ctx, () => reload()), undoCard(labels, ctx.host), gmailCard())
  })
}
