/**
 * 例子与向量库 (`/examples`): how many examples each label has, how many still wait for their embedding, the examples
 * (masked summaries) of one label or all, deleting one, and rebuilding every embedding.
 */
import type { Example } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { api } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, ORIGINS, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame, labelSelect } from './common.ts'

function item(example: Example, labels: readonly Label[], reload: () => Promise<void>): HTMLElement {
  return el(
    'article',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('span', { class: 'chip' }, labelText(example.label, labels)), el('span', { class: 'muted' }, `${ORIGINS[example.origin] ?? ''} · ${when(example.createTime)}${example.embedded ? '' : ' · 未生成向量'}`)),
    el('p', {}, example.summary),
    el('div', { class: 'actions' }, button('删除', () => void act((requestId) => api.deleteExample({ name: example.name, requestId }), '已删除', reload), { class: 'small danger' })),
  )
}

export async function renderExamples(ctx: ViewContext): Promise<void> {
  let filter = ''
  const reload: () => Promise<void> = await frame(ctx.main, '例子与向量库', async (body) => {
    const [labels, status, page] = await Promise.all([allLabels(), api.getServiceStatus({ name: 'serviceStatus' }), api.listExamples({ pageSize: 50, label: filter })])
    const select = labelSelect(labels, filter, true, { 'aria-label': '只看' })
    select.options[0]?.replaceChildren('全部')
    select.addEventListener('change', () => {
      filter = select.value
      void reload()
    })
    const total = labels.reduce((sum, label) => sum + label.exampleCount, 0)
    fill(
      body,
      el(
        'dl',
        { class: 'facts' },
        el('dt', {}, '例子总数'),
        el('dd', {}, String(total)),
        el('dt', {}, '待生成向量'),
        el('dd', {}, String(status.unembeddedExampleCount)),
        ...labels.flatMap((label) => [el('dt', {}, label.displayName), el('dd', {}, String(label.exampleCount))]),
      ),
      el('div', { class: 'actions' }, select, button('重建全部向量', () => void act((requestId) => api.rebuildExampleEmbeddings({ requestId }), '已排队重建', () => reload()))),
      page.examples.length === 0 ? el('p', { class: 'empty' }, '还没有例子：确认或改正待审邮件，或在 Gmail 里改标签，都会生成例子。') : el('div', { class: 'list' }, ...page.examples.map((example) => item(example, labels, () => reload()))),
    )
  })
}
