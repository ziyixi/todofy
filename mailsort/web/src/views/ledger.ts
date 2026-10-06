/**
 * 操作记录 (`/ledger`): every Gmail write by mailsort, newest first (加载更多 for older pages), each with the mail's
 * masked subject and sender while they are kept, and undo where the server accepts it (the label removed, INBOX
 * restored when it archived). Undo for a time range repeats the server's call (20 entries each) until nothing
 * undoable is left, then says how many were undone, failed and left.
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import type { LedgerEntry } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { labelText, LEDGER_STATES, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame, pagedList } from './common.ts'

/** Calls of one range undo at most: 30 x 20 entries, more than a month of writes at the daily cap's default. */
const RANGE_ROUNDS_MAX = 30

function entry(item: LedgerEntry, labels: readonly Label[], reload: () => Promise<void>): HTMLElement {
  return el(
    'article',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('span', { class: 'chip' }, LEDGER_STATES[item.state] ?? ''), el('span', { class: 'time' }, when(item.createTime))),
    item.subject === '' ? null : el('p', { class: 'subject' }, item.subject),
    item.sender === '' ? null : el('p', { class: 'muted' }, item.sender),
    el('p', {}, `${labelText(item.label, labels)}${item.archived ? ' · 已归档' : ''} · ${item.origin === 'owner' ? '你的选择' : '自动'}`),
    el('p', { class: 'hint mono' }, item.messageId),
    // The server says whether an undo would be accepted: not after the owner changed the label in Gmail, nor once the
    // label was deleted here or went missing in Gmail.
    item.undoable ? el('div', { class: 'actions' }, button('撤销', () => void act((requestId) => api.undoLedgerEntry({ name: item.name, requestId }), '已撤销', reload))) : null,
  )
}

/** Undoes every undoable entry of [from, to), 20 per call, and answers the totals. */
async function undoAll(from: number, to: number): Promise<{ undone: number; failed: number; remaining: number }> {
  const totals = { undone: 0, failed: 0, remaining: 0 }
  for (let round = 0; round < RANGE_ROUNDS_MAX; round++) {
    const requestId = newRequestId()
    const answer = await withRetry(() => api.undoLedgerEntries({ startTime: timestampFromMs(from), endTime: timestampFromMs(to), requestId }))
    totals.undone += answer.undoneCount
    totals.failed += answer.failedCount
    totals.remaining = answer.remainingCount
    // Nothing left, or a call that undid nothing (Gmail refused them all): repeating would not help.
    if (answer.remainingCount === 0 || answer.undoneCount === 0) break
  }
  return totals
}

export async function renderLedger(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '操作记录', async (body) => {
    const [page, labels] = await Promise.all([api.listLedgerEntries({ pageSize: 50 }), allLabels()])
    const start = el('input', { type: 'datetime-local', 'aria-label': '开始' })
    const end = el('input', { type: 'datetime-local', 'aria-label': '结束' })
    const undoRange = async () => {
      const from = Date.parse(start.value)
      const to = Date.parse(end.value)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        toast('请选择开始和结束时间')
        return
      }
      if (!ctx.host.confirm('撤销这段时间内本应用打的所有标签？')) return
      try {
        const { undone, failed, remaining } = await undoAll(from, to)
        toast(`已撤销 ${String(undone)} 条${failed > 0 ? `，${String(failed)} 条失败` : ''}${remaining > 0 ? `，还剩 ${String(remaining)} 条` : ''}`)
      } catch (error) {
        toast(errorMessage(error))
      }
      await reload()
    }
    const render = (item: LedgerEntry) => entry(item, labels, () => reload())
    fill(
      body,
      el('section', { class: 'card' }, el('h2', {}, '按时间段撤销'), start, end, el('div', { class: 'actions' }, button('撤销这段时间', () => void undoRange()))),
      page.ledgerEntries.length === 0
        ? el('p', { class: 'empty' }, '还没有写入 Gmail 的记录。')
        : pagedList({ items: page.ledgerEntries, next: page.nextPageToken }, async (pageToken) => {
            const more = await api.listLedgerEntries({ pageSize: 50, pageToken })
            return { items: more.ledgerEntries, next: more.nextPageToken }
          }, render),
    )
  })
}
