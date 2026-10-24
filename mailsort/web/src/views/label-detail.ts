/** Fixed priority descriptions and learned examples; no label policy controls. */
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import type { Example } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { api, errorMessage } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { when } from '../format.ts'
import { act } from './common.ts'

function examplesPart(label: Label): HTMLElement {
  let count = label.exampleCount
  const figure = el('span', { class: 'meta' }, ` ${String(count)}`)
  const title = el('h3', {}, '例子', figure)
  const part = el('section', { class: 'part', 'aria-label': '例子' })
  if (count === 0) {
    fill(part, title, el('p', { class: 'hint' }, '在 Gmail 中改正分级后，模型会学习相应例子。'))
    return part
  }
  const list = el('ul', { class: 'example-list', hidden: true })
  const more = el('div')
  const item = (example: Example): HTMLLIElement => {
    const gone = () => {
      node.remove()
      count -= 1
      figure.textContent = ` ${String(count)}`
      show.focus()
    }
    const remove = () => void act((requestId) => api.deleteExample({ name: example.name, requestId }), '例子已删除', gone)
    const node = el('li', {}, el('p', {}, example.summary), el('span', { class: 'meta' }, when(example.createTime)), button('删除', remove, { class: 'quiet small danger', 'aria-label': '删除这个例子' }))
    return node
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
  fill(part, el('div', { class: 'part-head' }, title, show), list, more)
  return part
}

export function labelDetail(label: Label | undefined, description: string): HTMLElement[] {
  return [
    el('p', { class: 'hint' }, description),
    ...(label === undefined ? [] : [examplesPart(label)]),
  ]
}
