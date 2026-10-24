/** Legacy review records remain readable after prompt-only Claude classification. */
import type { ReviewItem } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { api, listAll } from '../api.ts'
import { emptyState } from '../components.ts'
import { el, fill } from '../dom.ts'
import { labelText, percent, UNSURE_REASONS, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { allLabels, frame } from './common.ts'

function reviewRow(item: ReviewItem, labels: readonly Label[]): HTMLLIElement {
  const subject = item.subject || '（无主题）'
  return el('li', { 'aria-label': subject },
    el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, subject), el('span', { class: 'meta' }, when(item.receiveTime))),
    el('div', { class: 'row-sub' }, item.sender),
    item.reason === '' ? null : el('p', { class: 'hint' }, UNSURE_REASONS[item.reason] ?? item.reason),
    item.candidates.length === 0 ? null : el('p', { class: 'hint' }, `旧模型候选：${item.candidates.map((candidate) => `${labelText(candidate.label, labels)} ${percent(candidate.probability)}`).join(' · ')}`),
  )
}

export async function renderReview(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '历史待审记录', async (body) => {
    const [items, labels] = await Promise.all([
      listAll(async (pageToken) => {
        const page = await api.listReviewItems({ pageSize: 50, pageToken })
        return { items: page.reviewItems, next: page.nextPageToken }
      }, 4),
      allLabels(),
    ])
    fill(body,
      el('p', { class: 'hint lead' }, '旧模型的待审记录仅供查看。当前 Claude 分级使用固定提示词，不再从确认或纠正中学习。'),
      items.length === 0 ? emptyState('没有历史待审记录') : el('ul', { class: 'rows', 'aria-label': '历史待审邮件' }, ...items.map((item) => reviewRow(item, labels))),
    )
  })
}
