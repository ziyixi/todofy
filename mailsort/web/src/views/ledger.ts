/**
 * 操作记录 (`/ledger`): every Gmail write by mailsort, newest first, with undo (the label removed, INBOX restored when it
 * archived), and undo for a time range (20 entries per call; the page repeats until none is left).
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { LedgerEntry_State, type LedgerEntry } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { labelText, LEDGER_STATES, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'

function entry(item: LedgerEntry, labels: readonly Label[], reload: () => Promise<void>): HTMLElement {
  return el(
    'article',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('span', { class: 'chip' }, LEDGER_STATES[item.state] ?? ''), el('span', { class: 'time' }, when(item.createTime))),
    el('p', {}, `${labelText(item.label, labels)}${item.archived ? ' · 已归档' : ''} · ${item.origin === 'owner' ? '你的选择' : '自动'}`),
    el('p', { class: 'hint mono' }, item.messageId),
    item.state === LedgerEntry_State.APPLIED ? el('div', { class: 'actions' }, button('撤销', () => void act((requestId) => api.undoLedgerEntry({ name: item.name, requestId }), '已撤销', reload))) : null,
  )
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
      await act((requestId) => api.undoLedgerEntries({ startTime: timestampFromMs(from), endTime: timestampFromMs(to), requestId }), '已撤销一批', () => reload())
    }
    fill(
      body,
      el('section', { class: 'card' }, el('h2', {}, '按时间段撤销'), start, end, el('div', { class: 'actions' }, button('撤销这段时间', () => void undoRange()))),
      page.ledgerEntries.length === 0 ? el('p', { class: 'empty' }, '还没有写入 Gmail 的记录。') : el('div', { class: 'list' }, ...page.ledgerEntries.map((item) => entry(item, labels, () => reload()))),
    )
  })
}
