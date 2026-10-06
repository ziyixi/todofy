/**
 * 待审 (`/`): shadow suggestions, unsure mails and the daily audit of labelled mails, newest first. Confirm takes the
 * suggested label, the select corrects to another label or "都不是", skip leaves it. Subjects and senders are masked
 * and kept 14 days.
 */
import type { ReviewItem } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api, listAll } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import { DECIDERS, KIND_NAMES, labelText, percent, UNSURE_REASONS, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame, labelSelect } from './common.ts'

function card(item: ReviewItem, labels: readonly Label[], reload: () => Promise<void>): HTMLElement {
  const select = labelSelect(labels, item.suggestedLabel, true, { 'aria-label': '改为' })
  const candidates = item.candidates.map((candidate) => `${labelText(candidate.label, labels)} ${percent(candidate.probability)}`).join(' · ')
  return el(
    'article',
    { class: 'card review-item' },
    el('div', { class: 'card-head' }, el('span', { class: `chip kind-${String(item.kind)}` }, KIND_NAMES[item.kind] ?? '?'), el('span', { class: 'time' }, when(item.receiveTime))),
    el('p', { class: 'subject' }, item.subject === '' ? '（无主题）' : item.subject),
    el('p', { class: 'muted' }, item.sender),
    el(
      'p',
      { class: 'summary' },
      item.suggestedLabel === '' ? '建议：都不是' : `建议：${labelText(item.suggestedLabel, labels)}`,
      `（${DECIDERS[item.decider] ?? item.decider}${item.unsureReason === '' ? '' : `，${UNSURE_REASONS[item.unsureReason] ?? item.unsureReason}`}）`,
    ),
    candidates === '' ? null : el('p', { class: 'hint' }, candidates),
    el(
      'div',
      { class: 'actions' },
      item.suggestedLabel === '' ? null : button('确认', () => void act((requestId) => api.confirmReviewItem({ name: item.name, requestId }), '已确认', reload), { class: 'primary' }),
      select,
      button('改为所选', () => void act((requestId) => api.correctReviewItem({ name: item.name, label: select.value, requestId }), '已改正', reload)),
      button('跳过', () => void act((requestId) => api.skipReviewItem({ name: item.name, requestId }), '已跳过', reload), { class: 'small' }),
    ),
  )
}

export async function renderReview(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '待审', async (body) => {
    const [items, labels] = await Promise.all([
      listAll(async (pageToken) => {
        const page = await api.listReviewItems({ pageSize: 50, pageToken })
        return { items: page.reviewItems, next: page.nextPageToken }
      }, 4),
      allLabels(),
    ])
    fill(
      body,
      el('p', { class: 'hint' }, '确认或改正会成为例子和评测数据；正式模式下还会在 Gmail 里打上你选的标签并归档（不会标为已读）。'),
      items.length === 0 ? el('p', { class: 'empty' }, '没有待审的邮件。') : el('div', { class: 'list' }, ...items.map((item) => card(item, labels, () => reload()))),
    )
  })
}
