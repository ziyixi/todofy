/** Settings keeps mode and range undo, with old model evaluation readable as history. */
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { ClassificationProvider, Mode, ServiceStatus_AuthState, SettingsSchema, type ServiceStatus, type Settings } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { card, segmented } from '../components.ts'
import { button, el, toast } from '../dom.ts'
import { BREAKER_REASONS, classificationProvider, classificationProviderName, labelText, MODE_HINTS, MODE_NAMES, ms, relative, when } from '../format.ts'
import type { Host, ViewContext } from '../app.ts'
import { replayCard } from './replay.ts'
import { promptCard } from './prompt.ts'
import { act, allLabels, frame, labelSelect } from './common.ts'
import { classifierDetails } from './classifier.ts'

const MODES: readonly (readonly [Mode, string])[] = [Mode.OFF, Mode.SHADOW, Mode.LIVE].map((mode) => [mode, MODE_NAMES[mode] ?? ''] as const)
const PROVIDERS: readonly (readonly [ClassificationProvider, string])[] = [
  [ClassificationProvider.CLAUDE, 'Claude API'],
  [ClassificationProvider.CODEX, 'VPS Codex'],
]
const CLASSIFICATION_INTERVALS = [5, 15, 30, 60].map((minutes) => [minutes, `${String(minutes)} 分钟`] as const)

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

function setMode(settings: Settings, mode: Mode, requestId: string): Promise<Settings> {
  return api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode, etag: settings.etag }), updateMask: { paths: ['mode', 'etag'] }, requestId })
}

/** The owner chose 正式, but the grant is read-only (mint-token's readonly scope): nothing would be written. */
function readOnly(settings: Settings, status: ServiceStatus | null): boolean {
  return settings.mode === Mode.LIVE && status !== null && status.authState === ServiceStatus_AuthState.OK && !status.writeScope
}

function modeCard(settings: Settings, status: ServiceStatus | null, ctx: ViewContext, reload: () => Promise<void>): HTMLElement {
  const after = async () => {
    ctx.refreshStatus()
    await reload()
  }
  const choose = (mode: Mode) => {
    if (mode === settings.mode) return
    if (mode === Mode.LIVE && !ctx.host.confirm('切到正式？新邮件会打上 P1、P2、P3、P4 标签。P1 留在收件箱，P2、P3、P4 自动归档，未读状态保持不变。')) return
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
      : readOnly(settings, status)
        ? 'Gmail 只读授权，还不会写入：在本机运行 mint-token.mjs --scope modify'
        : (MODE_HINTS[settings.mode] ?? '')
  const warn = settings.breakerTripped || (settings.effectiveMode === settings.mode && readOnly(settings, status))
  return card(
    '模式',
    '',
    segmented('模式', MODES, settings.mode, choose),
    el('p', { class: warn ? 'hint warn' : 'hint' }, line),
    settings.breakerTripped ? el('div', { class: 'actions' }, button('解除熔断', resetBreaker)) : null,
  )
}

function providerCard(settings: Settings, status: ServiceStatus | null, ctx: ViewContext, reload: () => Promise<void>): HTMLElement {
  const selected = classificationProvider(settings.classificationProvider)
  const feedback = el('p', { class: 'hint warn', role: 'status', 'aria-live': 'polite' })
  let saving = false
  const save = async (provider: ClassificationProvider) => {
    if (saving || provider === selected) return
    saving = true
    for (const control of choices.querySelectorAll('button')) control.disabled = true
    feedback.textContent = '正在保存…'
    const requestId = newRequestId()
    try {
      await withRetry(() => api.updateSettings({
        settings: create(SettingsSchema, { name: 'settings', classificationProvider: provider, etag: settings.etag }),
        updateMask: { paths: ['classification_provider', 'etag'] },
        requestId,
      }))
      toast(`已切到 ${classificationProviderName(provider)}`)
      ctx.refreshStatus()
      await reload()
    } catch (error) {
      feedback.textContent = errorMessage(error)
    } finally {
      saving = false
      for (const control of choices.querySelectorAll('button')) control.disabled = false
    }
  }
  const choices = segmented('分类引擎', PROVIDERS, selected, (provider) => void save(provider))
  return card(
    '分类引擎',
    '',
    choices,
    el('p', { class: 'hint' }, '切换从下一批生效；已分类邮件不重判。'),
    classifierDetails(status, ctx.host.now(), selected),
    feedback,
  )
}

function intervalCard(settings: Settings, status: ServiceStatus | null, ctx: ViewContext, reload: () => Promise<void>): HTMLElement {
  const selected = settings.classificationIntervalMinutes || 15
  let saving = false
  const save = async (minutes: number) => {
    if (saving || minutes === selected) return
    saving = true
    for (const control of choices.querySelectorAll('button')) control.disabled = true
    try {
      await act((requestId) => api.updateSettings({
        settings: create(SettingsSchema, { name: 'settings', classificationIntervalMinutes: minutes, etag: settings.etag }),
        updateMask: { paths: ['classification_interval_minutes', 'etag'] }, requestId,
      }), `自动分类间隔已设为 ${String(minutes)} 分钟`, async () => {
        ctx.refreshStatus()
        await reload()
      })
    } finally {
      saving = false
      for (const control of choices.querySelectorAll('button')) control.disabled = false
    }
  }
  const choices = segmented('自动分类间隔', CLASSIFICATION_INTERVALS, selected, (minutes) => void save(minutes))
  const next = status?.classifier === undefined && classificationProvider(settings.classificationProvider) === ClassificationProvider.CLAUDE
    ? status?.claudeBudget?.nextBatchTime : status?.classifier?.nextBatchTime
  return card(
    '自动分类间隔', '', choices,
    el('p', { class: 'hint' }, '自动分类只补最近 48 小时的 Inbox 未分类邮件，已读也处理；已归档和更早的邮件不自动回扫。'),
    el('p', { class: 'hint' }, 'Gmail 维护检查仍每 5 分钟运行。积压批次、失败重试和额度等待沿用各自的时间。'),
    el('p', { class: 'hint' }, next === undefined ? '下批判断时间尚未提供' : `下批判断最早在 ${relative(next, ctx.host.now())}（${when(next)}）。`),
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
  const label = labelSelect(labels, '', '全部分级', { 'aria-label': '分级' })
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

export async function renderSettings(ctx: ViewContext): Promise<void> {
  const prompt = promptCard()
  const reload: () => Promise<void> = await frame(ctx.main, '设置', async (body) => {
    // The header's status (its grant) only adds a line: without it the page still works.
    const [settings, labels, status] = await Promise.all([api.getSettings({ name: 'settings' }), allLabels(), ctx.status().catch(() => null)])
    body.replaceChildren(modeCard(settings, status, ctx, () => reload()), providerCard(settings, status, ctx, () => reload()), intervalCard(settings, status, ctx, () => reload()), prompt, undoCard(labels, ctx.host), await replayCard(labels))
  })
}
