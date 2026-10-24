/** Fixed priority descriptions and read-only historical examples. */
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import type { Example } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { api, errorMessage } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { when } from '../format.ts'

function examplesPart(label: Label): HTMLElement {
  const count = label.exampleCount
  const figure = el('span', { class: 'meta' }, ` ${String(count)}`)
  const title = el('h3', {}, '历史例子', figure)
  const part = el('section', { class: 'part', 'aria-label': '历史例子' })
  const list = el('ul', { class: 'example-list', hidden: true })
  const more = el('div')
  const item = (example: Example): HTMLLIElement => {
    return el('li', {}, el('p', {}, example.summary), el('span', { class: 'meta' }, when(example.createTime)))
  }
  const load = async (pageToken: string) => {
    try {
      const answer = await api.listExamples({ label: label.name, pageSize: 50, pageToken })
      list.append(...answer.examples.map(item))
      fill(more, answer.nextPageToken === '' ? null : button('再看 50 个', () => void load(answer.nextPageToken), { class: 'quiet small' }))
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  let loaded = false
  const show = button('查看', () => {
    list.hidden = !list.hidden
    more.hidden = list.hidden
    show.textContent = list.hidden ? '查看' : '收起'
    show.setAttribute('aria-expanded', String(!list.hidden))
    if (!loaded) {
      loaded = true
      void load('')
    }
  }, { class: 'quiet small', 'aria-expanded': 'false' })
  fill(part, el('div', { class: 'part-head' }, title, show), el('p', { class: 'hint' }, '旧模型的学习记录，不用于当前 Claude 分级。'), list, more)
  return part
}

export function labelDetail(label: Label | undefined, description: string): HTMLElement[] {
  return [
    el('p', { class: 'hint' }, description),
    ...(label === undefined || label.exampleCount === 0 ? [] : [examplesPart(label)]),
  ]
}
