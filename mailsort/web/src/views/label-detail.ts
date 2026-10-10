/**
 * One label's detail, opened inline under its row in 标签 (labels.ts): everything about the label in one place.
 *
 * - First, only when Gmail takes nothing from it: one line on why (Gmail has a label of its name that is the owner's,
 *   or its own label was deleted there) and what to do.
 * - The description, what the model reads as `path: description` (without one the model never picks the label): it
 *   grows with its text and is saved when it loses the focus, or with 保存.
 * - 留在收件箱: the label is added and the mail stays in the inbox (账号安全, 政府法律).
 * - A trust label's trusted domains (learned from the owner's review choices, never typed), each with 删除.
 * - Its examples (masked summaries, kept until deleted): the count, the list on demand, and deleting one.
 * - 高级, folded: 可信, 敏感, 启用, rename, the Gmail state while it is not simply linked, and delete.
 */
import { Label_GmailState, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import type { Example } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { api, errorMessage } from '../api.ts'
import { disclosure, growing, toggle } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { when } from '../format.ts'
import type { Host } from '../app.ts'
import { act } from './common.ts'

/** The fields of a label the detail and its row change. */
export type LabelFields = Partial<Pick<Label, 'displayName' | 'description' | 'enabled' | 'trustImplying' | 'keepInInbox' | 'sensitive'>>

/** What the detail needs from the page (labels.ts). */
export interface DetailPage {
  readonly host: Host
  /** The label as the page holds it now: its etag follows every save. */
  readonly label: () => Label
  /** What stays open while this label is: 高级 (`more` is kept for the page's memory). */
  readonly memory: { more: boolean; advanced: boolean }
  /** Saves `paths` of `fields` (the etag is the page's); the answer replaces the label and repaints its row. */
  readonly save: (fields: LabelFields, paths: readonly string[], done: string) => Promise<Label | null>
  /** Reads the labels again and repaints, this label still open; then focuses the control marked `focus`. */
  readonly refresh: (focus: string) => Promise<void>
  /** Repaints from what the page holds (a rename moves the label in the tree); then focuses `focus`. */
  readonly repaint: (focus: string) => void
}

/** The Gmail states 高级 names (a linked label says nothing). */
const GMAIL_STATES: Readonly<Record<number, string>> = {
  [Label_GmailState.PENDING]: '尚未创建',
  [Label_GmailState.ADOPTED]: '已沿用原有标签',
}

/** The Gmail states where nothing is written with the label: said at the top of its detail, with what to do. */
const GMAIL_PROBLEMS: Readonly<Record<number, string>> = {
  [Label_GmailState.NAME_TAKEN]: 'Gmail 里已有同名标签，改个名字或到 设置 → 从 Gmail 同步 沿用',
  [Label_GmailState.MISSING]: 'Gmail 里已没有这个标签，不再打它；在 Gmail 建回同名标签后到 设置 → 从 Gmail 同步',
}

/** A switch that saves one boolean field of the label at once (and puts itself back when that fails). */
function fieldSwitch(page: DetailPage, name: string, hint: string, field: 'keepInInbox' | 'trustImplying' | 'sensitive' | 'enabled', path: string, after?: (label: Label) => void, ask?: (on: boolean) => boolean): HTMLLabelElement {
  const [box, input] = toggle(name, page.label()[field], hint)
  input.addEventListener('change', () => {
    const on = input.checked
    if (ask !== undefined && !ask(on)) {
      input.checked = !on
      return
    }
    const fields: LabelFields = {}
    fields[field] = on
    void page.save(fields, [path], '已保存').then((answer) => {
      if (answer === null) input.checked = !on
      else after?.(answer)
    })
  })
  return box
}

/** The description: it grows with its text and is saved on blur, or with 保存 (shown while it differs). */
function descriptionBox(page: DetailPage): HTMLElement {
  let saved = page.label().description
  const area = growing(el('textarea', { rows: '2', maxlength: '300', 'aria-label': '说明', placeholder: '这类邮件是什么。没写说明，模型不会选它', 'data-focus': 'description' }, saved))
  const store = async () => {
    const value = area.value
    if (value === saved) return
    const before = saved
    saved = value
    save.hidden = true
    if ((await page.save({ description: value }, ['description'], '说明已保存')) === null) {
      saved = before
      save.hidden = area.value === saved
    }
  }
  const save = button('保存', () => void store(), { class: 'small', hidden: true })
  area.addEventListener('input', () => {
    save.hidden = area.value === saved
  })
  area.addEventListener('blur', () => void store())
  return el('div', { class: 'desc' }, area, save)
}

/** A trust label's trusted domains, each with 删除 (there is no add: they are learned from the review queue). */
function domainsPart(page: DetailPage): HTMLElement | null {
  const label = page.label()
  if (!label.trustImplying) return null
  const remove = (domain: string) =>
    void act((requestId) => api.removeTrustedDomain({ name: label.name, domain, etag: page.label().etag, requestId }), `已删除 ${domain}`, () => page.refresh('description'))
  return el(
    'section',
    { class: 'part', 'aria-label': '可信域名' },
    el('h3', {}, '可信域名', el('span', { class: 'meta' }, ` ${String(label.trustedDomains.length)}`)),
    label.trustedDomains.length === 0
      ? el('p', { class: 'hint' }, '在待审里选这个标签，发件人通过 DMARC 时，它的域名就会记在这里')
      : el('ul', { class: 'example-list' }, ...label.trustedDomains.map((domain) => el('li', {}, el('p', { class: 'mono' }, domain), button('删除', () => { remove(domain) }, { class: 'quiet small danger', 'aria-label': `删除 ${domain}` })))),
  )
}

/** The examples: their count, and the list (50 at a time) on 查看, each with 删除. */
function examplesPart(page: DetailPage): HTMLElement {
  const label = page.label()
  let count = label.exampleCount
  const figure = el('span', { class: 'meta' }, ` ${String(count)}`)
  const title = el('h3', {}, '例子', figure)
  const part = el('section', { class: 'part', 'aria-label': '例子' })
  if (label.sensitive || count === 0) {
    fill(part, title, el('p', { class: 'hint' }, label.sensitive ? '敏感标签不留例子' : '确认或改为这个标签的邮件会留下例子'))
    return part
  }
  const list = el('ul', { class: 'example-list', hidden: true })
  const more = el('div')
  const item = (example: Example): HTMLLIElement => {
    const gone = () => {
      node.remove()
      count -= 1
      figure.textContent = ` ${String(count)}`
      page.label().exampleCount = count
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

/** 高级: 可信, 敏感 (which deletes the examples), 启用, rename, the Gmail state while not simply linked, and delete. */
function advanced(page: DetailPage, examplesChanged: () => void): HTMLDetailsElement {
  const label = page.label()
  const path = el('input', { value: label.displayName, maxlength: '100', 'aria-label': '路径', 'data-focus': 'rename' })
  const rename = async () => {
    const value = path.value.trim()
    if (value === '' || value === page.label().displayName) return
    if ((await page.save({ displayName: value }, ['display_name'], '已改名')) !== null) page.repaint('rename')
  }
  const remove = () => {
    const current = page.label()
    if (!page.host.confirm(`删除“${current.displayName}”和它的例子、可信域名？Gmail 里的标签和邮件不变，它打过的标签也不能再撤销。`)) return
    void act((requestId) => api.deleteLabel({ name: current.name, etag: current.etag, requestId }), '已删除', () => page.refresh('search'))
  }
  const deletesExamples = (on: boolean) => !on || page.label().exampleCount === 0 || page.host.confirm(`打开“敏感”会删掉这个标签的 ${String(page.label().exampleCount)} 个例子，继续？`)
  const gmail = GMAIL_STATES[label.gmailState]
  const body = el(
    'div',
    { class: 'more-body' },
    fieldSwitch(page, '可信', '只给通过 DMARC 的可信域名发件人打它', 'trustImplying', 'trust_implying'),
    fieldSwitch(page, '敏感', '不留这类邮件的例子', 'sensitive', 'sensitive', examplesChanged, deletesExamples),
    fieldSwitch(page, '启用', '关掉后不再建议或打它', 'enabled', 'enabled'),
    el('div', { class: 'actions' }, path, button('改名', () => void rename())),
    gmail === undefined ? null : el('p', { class: 'hint' }, `Gmail：${gmail}`),
    el('div', { class: 'actions' }, button('删除标签', remove, { class: 'small danger' })),
  )
  const details = disclosure('高级', body)
  details.open = page.memory.advanced
  details.addEventListener('toggle', () => {
    page.memory.advanced = details.open
  })
  return details
}

/** The detail's parts, in order. */
export function labelDetail(page: DetailPage): HTMLElement[] {
  let examples = examplesPart(page)
  const examplesChanged = () => {
    const next = examplesPart(page)
    examples.replaceWith(next)
    examples = next
  }
  const problem = GMAIL_PROBLEMS[page.label().gmailState]
  const domains = domainsPart(page)
  return [
    ...(problem === undefined ? [] : [el('p', { class: 'hint warn', role: 'note' }, problem)]),
    descriptionBox(page),
    fieldSwitch(page, '留在收件箱', '只加标签，不归档', 'keepInInbox', 'keep_in_inbox'),
    ...(domains === null ? [] : [domains]),
    examples,
    advanced(page, examplesChanged),
  ]
}
