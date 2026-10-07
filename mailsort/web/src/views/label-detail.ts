/**
 * One label's detail, opened inline under its row in 标签 (labels.ts): everything about the label in one place.
 *
 * - The description, what the model reads as `path: description` (without one the model never picks the label): it
 *   grows with its text and is saved when it loses the focus, or with 保存.
 * - 留在收件箱: the label is added and the mail stays in the inbox (账号安全, 政府法律).
 * - Its rules, one line each: the kind (发件人, 域名, 列表, 收件地址), the value, the subject words and the state;
 *   批准 for a proposal, 停用 / 启用 / 删除 behind ⋯. 添加规则 takes one value and infers its kind (ruleFor); 更多 holds
 *   the kind for a list or a delivered-to address, the subject words and the rule's 留在收件箱.
 * - Its examples (masked summaries, kept until deleted): the count, the list on demand, and deleting one.
 * - 高级, folded: the threshold, 可信, 敏感, 启用, rename, the Gmail state and delete.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Label_GmailState, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import type { Example } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Rule_Kind, Rule_State, RuleSchema, type Rule } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { chip, disclosure, growing, menu, segmented, toggle, type MenuAction } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { RULE_KIND_NAMES, when } from '../format.ts'
import type { Host } from '../app.ts'
import { act } from './common.ts'

/** The fields of a label the detail and its row change. */
export type LabelFields = Partial<Pick<Label, 'displayName' | 'description' | 'enabled' | 'live' | 'trustImplying' | 'keepInInbox' | 'sensitive' | 'threshold'>>

/** What the detail needs from the page (labels.ts). */
export interface DetailPage {
  readonly host: Host
  /** The label as the page holds it now: its etag follows every save. */
  readonly label: () => Label
  /** The label's rules, proposals first. */
  readonly rules: readonly Rule[]
  /** The rules the search matched (their names): drawn highlighted. */
  readonly hits: ReadonlySet<string>
  /** What stays open while this label is: 添加规则's 更多 and 高级. */
  readonly memory: { more: boolean; advanced: boolean }
  /** Saves `paths` of `fields` (the etag is the page's); the answer replaces the label and repaints its row. */
  readonly save: (fields: LabelFields, paths: readonly string[], done: string) => Promise<Label | null>
  /** Reads the labels and rules again and repaints, this label still open; then focuses the control marked `focus`. */
  readonly refresh: (focus: string) => Promise<void>
  /** Repaints from what the page holds (a rename moves the label in the tree); then focuses `focus`. */
  readonly repaint: (focus: string) => void
}

const GMAIL_STATES: Readonly<Record<number, string>> = {
  [Label_GmailState.PENDING]: '尚未创建',
  [Label_GmailState.LINKED]: '已关联',
  [Label_GmailState.ADOPTED]: '已沿用原有标签',
  [Label_GmailState.MISSING]: '已不存在',
  [Label_GmailState.NAME_TAKEN]: '已有同名标签，没有沿用。改个名字，或在设置里从 Gmail 同步沿用它',
}

/** How 添加规则 reads its value: by its shape, or as a list or the delivered-to address. */
export type Match = 'auto' | 'list' | 'to'

const MATCHES: readonly (readonly [Match, string])[] = [
  ['auto', '自动'],
  ['list', '列表'],
  ['to', '收件地址'],
]

/**
 * The rule a typed value makes. By its shape (`auto`): an address is a sender (`Name <x@y>` too), `@domain` and a bare
 * domain are a domain, `<list.id>` (a List-Id header) is a list. `list` and `to` take the value as that kind. The
 * Worker trims it and folds it to lower case.
 */
export function ruleFor(raw: string, match: Match): { readonly kind: Rule_Kind; readonly value: string } {
  const text = raw.trim()
  const bracketed = /<([^<>]*)>$/.exec(text)?.[1]?.trim()
  const value = bracketed ?? text
  if (match === 'list') return { kind: Rule_Kind.LIST_ID, value }
  if (match === 'to') return { kind: Rule_Kind.DELIVERED_TO, value }
  if (value.startsWith('@')) return { kind: Rule_Kind.SENDER_DOMAIN, value: value.slice(1) }
  if (value.includes('@')) return { kind: Rule_Kind.SENDER_ADDRESS, value }
  return { kind: bracketed === undefined ? Rule_Kind.SENDER_DOMAIN : Rule_Kind.LIST_ID, value }
}

/** Subject words as typed: separated by commas (, ， 、). */
function words(input: HTMLInputElement): string[] {
  return input.value
    .split(/[,，、]/)
    .map((word) => word.trim())
    .filter((word) => word !== '')
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

/** One rule on one line: kind, value, subject words, keep and state; 批准 for a proposal, the rest behind ⋯. */
function ruleLine(rule: Rule, page: DetailPage): HTMLLIElement {
  const focus = `rule:${rule.name}`
  const approve = () => void act((requestId) => api.approveRule({ name: rule.name, requestId }), '规则已生效', () => page.refresh(focus))
  const disable = () => void act((requestId) => api.disableRule({ name: rule.name, requestId }), '规则已停用', () => page.refresh(focus))
  const remove = () => void act((requestId) => api.deleteRule({ name: rule.name, requestId }), '规则已删除', () => page.refresh('add-rule'))
  const proposed = rule.state === Rule_State.PROPOSED
  const disabled = rule.state === Rule_State.DISABLED
  const actions: MenuAction[] = [...(proposed ? [] : disabled ? [['启用', approve] as const] : [['停用', disable] as const]), ['删除', remove, 'danger']]
  return el(
    'li',
    { class: ['rule', disabled ? 'off' : '', page.hits.has(rule.name) ? 'hit' : ''].filter((name) => name !== '').join(' ') },
    el(
      'span',
      { class: 'rule-main' },
      chip(RULE_KIND_NAMES[rule.kind] ?? ''),
      el('span', { class: 'mono rule-value' }, rule.value),
      ...rule.subjectIncludes.map((word) => chip(`含 ${word}`, 'muted')),
      ...rule.subjectExcludes.map((word) => chip(`不含 ${word}`, 'muted')),
      rule.keepInInbox ? chip('留在收件箱', 'muted') : null,
      proposed ? chip('待批准', 'accent') : disabled ? el('span', { class: 'meta' }, '已停用') : null,
    ),
    el('span', { class: 'rule-actions' }, proposed ? button('批准', approve, { class: 'small' }) : null, menu(`规则 ${rule.value} 的操作`, actions, focus)),
  )
}

/** 添加规则: one value (its kind shown as it is typed), and 更多 for the kind, the subject words and keep. */
function addRule(page: DetailPage): HTMLElement {
  let match: Match = 'auto'
  const input = el('input', { placeholder: '地址或域名，如 noreply@github.com', 'aria-label': '添加规则', autocomplete: 'off', spellcheck: 'false', 'data-focus': 'add-rule' })
  const kind = el('span', { class: 'chip', hidden: true, 'aria-live': 'polite' })
  const includes = el('input', { placeholder: '主题包含（逗号分隔）', 'aria-label': '主题包含' })
  const excludes = el('input', { placeholder: '主题不含（逗号分隔）', 'aria-label': '主题不含' })
  const [keepBox, keep] = toggle('留在收件箱', false, '只加标签，不归档')
  const matches = el('div')
  const showKind = () => {
    kind.hidden = input.value.trim() === ''
    kind.textContent = RULE_KIND_NAMES[ruleFor(input.value, match).kind] ?? ''
  }
  const paintMatches = () => {
    fill(
      matches,
      segmented('类型', MATCHES, match, (value) => {
        match = value
        paintMatches()
        showKind()
        matches.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
      }),
    )
  }
  const addButton = button('添加', () => void add())
  // While a rule is sent the field is locked: what is typed meanwhile would join the value on its way out.
  const busy = (on: boolean) => {
    input.readOnly = on
    addButton.disabled = on
  }
  const add = async () => {
    if (input.readOnly) return
    if (input.value.trim() === '') {
      input.focus()
      return
    }
    const { kind: ruleKind, value } = ruleFor(input.value, match)
    const rule = create(RuleSchema, { kind: ruleKind, value, label: page.label().name, subjectIncludes: words(includes), subjectExcludes: words(excludes), keepInInbox: keep.checked })
    busy(true)
    await act((requestId) => api.createRule({ rule, requestId }), '规则已添加', () => {
      page.memory.more = false
      return page.refresh('add-rule')
    })
    // Added, the detail was drawn again with an empty field; refused, the value stays to be fixed.
    busy(false)
  }
  input.addEventListener('input', showKind)
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void add()
  })
  paintMatches()
  const more = disclosure('更多', el('div', { class: 'more-body' }, el('div', { class: 'inline' }, el('span', { class: 'hint' }, '类型'), matches), includes, excludes, keepBox))
  more.open = page.memory.more
  more.addEventListener('toggle', () => {
    page.memory.more = more.open
  })
  return el('div', { class: 'add-rule' }, el('div', { class: 'actions' }, input, kind, addButton), more)
}

/** The rules: one line each, then 添加规则. */
function rulesPart(page: DetailPage): HTMLElement {
  return el(
    'section',
    { class: 'part', 'aria-label': '规则' },
    el('h3', {}, '规则', el('span', { class: 'meta' }, ` ${String(page.rules.length)}`)),
    page.rules.length === 0 ? null : el('ul', { class: 'rule-list' }, ...page.rules.map((rule) => ruleLine(rule, page))),
    addRule(page),
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
    fill(part, title, el('p', { class: 'hint' }, label.sensitive ? '敏感标签不留例子' : '确认或改正这类邮件后会留下例子'))
    return part
  }
  const list = el('ul', { class: 'example-list', hidden: true })
  const more = el('div')
  const item = (example: Example): HTMLLIElement => {
    const remove = async () => {
      const requestId = newRequestId()
      try {
        await withRetry(() => api.deleteExample({ name: example.name, requestId }))
      } catch (error) {
        toast(errorMessage(error))
        return
      }
      node.remove()
      count -= 1
      figure.textContent = ` ${String(count)}`
      page.label().exampleCount = count
      toast('例子已删除')
      show.focus()
    }
    const node = el('li', {}, el('p', {}, example.summary), el('span', { class: 'meta' }, when(example.createTime)), button('删除', () => void remove(), { class: 'quiet small danger', 'aria-label': '删除这个例子' }))
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

/** 高级: the threshold, 可信, 敏感 (which deletes the examples), 启用, rename, the Gmail state and delete. */
function advanced(page: DetailPage, examplesChanged: () => void): HTMLDetailsElement {
  const label = page.label()
  const threshold = el('input', { type: 'number', min: '0.5', max: '0.99', step: '0.01', inputmode: 'decimal', value: label.threshold === 0 ? '' : String(label.threshold), placeholder: '默认', 'aria-label': '阈值' })
  threshold.addEventListener('change', () => {
    const value = threshold.value === '' ? 0 : Number(threshold.value)
    if (value !== 0 && !(value >= 0.5 && value <= 0.99)) {
      toast('阈值在 0.5 到 0.99 之间，空为默认')
      return
    }
    void page.save({ threshold: value }, ['threshold'], '已保存')
  })
  const path = el('input', { value: label.displayName, maxlength: '100', 'aria-label': '路径', 'data-focus': 'rename' })
  const rename = async () => {
    const value = path.value.trim()
    if (value === '' || value === page.label().displayName) return
    if ((await page.save({ displayName: value }, ['display_name'], '已改名')) !== null) page.repaint('rename')
  }
  const remove = () => {
    const current = page.label()
    if (!page.host.confirm(`删除“${current.displayName}”和它的规则、例子？Gmail 里的标签和邮件不变，它打过的标签也不能再撤销。`)) return
    void act((requestId) => api.deleteLabel({ name: current.name, etag: current.etag, requestId }), '已删除', () => page.refresh('search'))
  }
  const deletesExamples = (on: boolean) => !on || page.label().exampleCount === 0 || page.host.confirm(`打开“敏感”会删掉这个标签的 ${String(page.label().exampleCount)} 个例子，继续？`)
  const gmail = GMAIL_STATES[label.gmailState]
  const body = el(
    'div',
    { class: 'more-body' },
    el('label', { class: 'setting' }, el('span', {}, '阈值'), threshold),
    fieldSwitch(page, '可信', '只有 DMARC 通过的规则能打它', 'trustImplying', 'trust_implying'),
    fieldSwitch(page, '敏感', '不留这类邮件的例子', 'sensitive', 'sensitive', examplesChanged, deletesExamples),
    fieldSwitch(page, '启用', '关掉后不再建议或打它', 'enabled', 'enabled'),
    el('div', { class: 'actions' }, path, button('改名', () => void rename())),
    gmail === undefined ? null : el('p', { class: label.gmailState === Label_GmailState.MISSING || label.gmailState === Label_GmailState.NAME_TAKEN ? 'hint warn' : 'hint' }, `Gmail：${gmail}`),
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
  return [descriptionBox(page), fieldSwitch(page, '留在收件箱', '只加标签，不归档', 'keepInInbox', 'keep_in_inbox'), rulesPart(page), examples, advanced(page, examplesChanged)]
}
