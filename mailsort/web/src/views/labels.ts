/**
 * 标签 (`/labels`): the one place for everything about a label (../../docs/design.md §9).
 *
 * - A search box over the labels' names and their rules' values (a sender, a domain, a list), so a sender's rule is
 *   found at once: a label shown for its rules names the matching values under its name, and its detail marks them.
 * - The labels as one tree in the labels' order, grouped by their top-level segment (开发 › CI通知, 平台工具; a label of
 *   one segment stands alone). One compact row each: the name, the rule count (when it has rules), a small bar of the
 *   precision bound when the label has verdicts, and the one switch, 正式打.
 * - A row opens its detail under it, one at a time (label-detail.ts): the description, 留在收件箱, the rules with
 *   添加规则, the examples and 高级.
 * - One quiet “+ 新标签” at the bottom. With no label at all, 套用推荐模板 previews the template's 15 labels (ImportRules
 *   with validate_only) and adds them on confirmation; “+ 新标签” sits beside it.
 *
 * Deleting a label leaves its Gmail label and mails as they are. (The sync with Gmail is in 设置.)
 */
import { create } from '@ziyixi/proto/protobuf'
import { LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import type { ImportRulesResponse } from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb'
import { Rule_State, type Rule } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { api, errorMessage, listAll, newRequestId, withRetry } from '../api.ts'
import { bar, card, emptyState } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { percent } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'
import { labelDetail, type DetailPage, type LabelFields } from './label-detail.ts'

/** Rule pages read at most: 5 of 100, the store's 500. */
const RULE_PAGES = 5

/** A group of the tree: the labels under one top-level segment, or ('') a run of labels of one segment. */
export interface Group<T> {
  readonly name: string
  readonly members: T[]
}

/**
 * Items grouped by the top-level segment of their path, in their order: `开发/CI通知` and `开发/平台工具` under 开发,
 * where 开发 first appears; paths of one segment, in a run, under no name.
 */
export function groupByTop<T>(items: readonly T[], path: (item: T) => string): Group<T>[] {
  const groups: Group<T>[] = []
  const named = new Map<string, Group<T>>()
  for (const item of items) {
    const segments = path(item).split('/')
    const top = segments.length > 1 ? (segments[0] ?? '') : ''
    let group = top === '' ? groups.at(-1) : named.get(top)
    if (group === undefined || (top === '' && group.name !== '')) {
      group = { name: top, members: [] }
      groups.push(group)
      if (top !== '') named.set(top, group)
    }
    group.members.push(item)
  }
  return groups
}

/** A label's name in its group: the path without the group's segment (`汽车 › 保养` under 生活). */
export function leafName(path: string, group: string): string {
  return group === '' ? path : path.split('/').slice(1).join(' › ')
}

/**
 * What the search shows: every label whose name holds the query, or one of whose rules' values does (with those
 * rules); every label, without hits, when the query is empty. Rule values are stored in lower case.
 */
export function searchLabels(labels: readonly Label[], rules: readonly Rule[], query: string): Map<string, Rule[]> {
  const q = query.trim().toLowerCase()
  const shown = new Map<string, Rule[]>()
  for (const label of labels) {
    const hits = q === '' ? [] : rules.filter((rule) => rule.label === label.name && rule.value.includes(q))
    if (q === '' || hits.length > 0 || label.displayName.toLowerCase().includes(q)) shown.set(label.name, hits)
  }
  return shown
}

function allRules(): Promise<Rule[]> {
  return listAll(async (pageToken) => {
    const page = await api.listRules({ pageSize: 100, pageToken })
    return { items: page.rules, next: page.nextPageToken }
  }, RULE_PAGES)
}

/** A label's precision bound, its verdicts, and whether it is below the target. */
interface Precision {
  readonly bound: number
  readonly count: number
  readonly below: boolean
}

/** The small bar of a precision bound (its figures in the title and for assistive technology). */
function precisionBar(score: Precision | undefined): HTMLElement {
  if (score === undefined) return el('span', { class: 'bar-slot' })
  const node = bar(score.bound, score.below ? 'warn' : '')
  return el('span', { class: 'bar-slot', title: `精确率下界 ${percent(score.bound)} · ${String(score.count)} 封` }, node, el('span', { class: 'visually-hidden' }, `，精确率 ${percent(score.bound)}`))
}

/** The values a search found among a label's rules, for the row: the first two and how many more. */
function hitText(hits: readonly Rule[]): string {
  const shown = hits.slice(0, 2).map((rule) => rule.value).join(' · ')
  return hits.length > 2 ? `${shown} +${String(hits.length - 2)}` : shown
}

/** The template's labels by group, and 添加这些标签 / 取消. */
function templateCard(answer: ImportRulesResponse, apply: () => Promise<boolean>, cancel: () => void): HTMLElement {
  const groups = groupByTop(answer.labels, (label) => label.path)
  const confirm = button('添加这些标签', () => {
    confirm.disabled = true
    void apply().then((done) => {
      confirm.disabled = done
    })
  }, { class: 'primary' })
  return card(
    '推荐模板',
    `${String(answer.labels.length)} 个标签`,
    el(
      'ul',
      { class: 'template' },
      ...groups.flatMap((group) =>
        group.name === ''
          ? group.members.map((label) => el('li', {}, el('strong', {}, label.path)))
          : [el('li', {}, el('strong', {}, group.name), el('span', { class: 'muted' }, group.members.map((label) => leafName(label.path, group.name)).join(' · ')))],
      ),
    ),
    el('div', { class: 'actions' }, confirm, button('取消', cancel, { class: 'quiet' })),
  )
}

/** A row of the tree and what it was drawn with. */
interface Row {
  readonly name: string
  readonly group: string
  readonly hits: readonly Rule[]
  readonly li: HTMLLIElement
  readonly slot: HTMLElement
}

function labelsPage(body: HTMLElement, ctx: ViewContext, labels: Label[], rules: Rule[], precision: ReadonlyMap<string, Precision>): void {
  const state = { labels, rules, query: '', open: '' }
  let memory = { more: false, advanced: false }
  let rows = new Map<string, Row>()

  const find = (name: string) => state.labels.find((label) => label.name === name)

  const saveLabel = async (name: string, fields: LabelFields, paths: readonly string[], done: string): Promise<Label | null> => {
    const current = find(name)
    if (current === undefined) return null
    const requestId = newRequestId()
    try {
      const answer = await withRetry(() => api.updateLabel({ label: create(LabelSchema, { ...fields, name, etag: current.etag }), updateMask: { paths: [...paths, 'etag'] }, requestId }))
      state.labels = state.labels.map((label) => (label.name === name ? answer : label))
      toast(done)
      return answer
    } catch (error) {
      toast(errorMessage(error))
      return null
    }
  }

  const refresh = async (focus = ''): Promise<void> => {
    try {
      const [nextLabels, nextRules] = await Promise.all([allLabels(), allRules()])
      state.labels = nextLabels
      state.rules = nextRules
    } catch (error) {
      toast(errorMessage(error))
      return
    }
    if (find(state.open) === undefined) state.open = ''
    paint(focus)
  }

  /** The row's own line: the name (and what the search found), the rule count, the precision bar and 正式打. */
  const paintHead = (row: Row) => {
    const label = find(row.name)
    if (label === undefined) return
    const own = state.rules.filter((rule) => rule.label === label.name)
    const proposed = own.filter((rule) => rule.state === Rule_State.PROPOSED).length
    const open = state.open === label.name
    const main = el(
      'button',
      { type: 'button', class: 'leaf-main', 'aria-expanded': String(open), 'aria-controls': row.slot.id, 'data-focus': `row:${label.name}` },
      el('span', { class: 'leaf-name' }, el('span', {}, leafName(label.displayName, row.group)), row.hits.length === 0 ? null : el('span', { class: 'leaf-hit mono' }, hitText(row.hits))),
      label.enabled ? null : el('span', { class: 'visually-hidden' }, '，未启用'),
      own.length === 0 ? null : el('span', { class: 'leaf-count' }, `${String(own.length)} 规则`, proposed === 0 ? null : el('span', { class: 'dot', title: `${String(proposed)} 条待批准` }, el('span', { class: 'visually-hidden' }, `，${String(proposed)} 条待批准`))),
      precisionBar(precision.get(label.name)),
    )
    main.addEventListener('click', () => {
      setOpen(label.name)
    })
    const live = el('input', { type: 'checkbox', class: 'switch', 'aria-label': `正式打：${label.displayName}`, ...(label.live ? { checked: true } : {}) })
    live.addEventListener('change', () => {
      const on = live.checked
      void saveLabel(label.name, { live: on }, ['live'], `${label.displayName}：正式打已${on ? '开' : '关'}`).then((answer) => {
        if (answer === null) live.checked = !on
      })
    })
    row.li.className = ['leaf', label.enabled ? '' : 'off', open ? 'open' : ''].filter((name) => name !== '').join(' ')
    const line = el('div', { class: 'leaf-row' }, main, el('label', { class: 'live', title: '正式打' }, live))
    const old = row.li.querySelector(':scope > .leaf-row')
    if (old === null) row.li.prepend(line)
    else old.replaceWith(line)
  }

  const detailPage = (row: Row): DetailPage => {
    const initial = find(row.name)
    return {
      host: ctx.host,
      label: () => find(row.name) ?? initial ?? create(LabelSchema),
      rules: state.rules.filter((rule) => rule.label === row.name).sort((a, b) => a.state - b.state),
      hits: new Set(row.hits.map((rule) => rule.name)),
      memory,
      save: async (fields, paths, done) => {
        const answer = await saveLabel(row.name, fields, paths, done)
        const current = rows.get(row.name)
        if (answer !== null && current !== undefined) paintHead(current)
        return answer
      },
      refresh,
      repaint: (focus) => {
        paint(focus)
      },
    }
  }

  const showDetail = (row: Row, open: boolean) => {
    row.slot.hidden = !open
    if (open) fill(row.slot, ...labelDetail(detailPage(row)))
    else row.slot.replaceChildren()
    paintHead(row)
  }

  /** Opens `name`'s detail (closing the one open), or closes it when it is the one open. */
  const setOpen = (name: string) => {
    const before = rows.get(state.open)
    state.open = state.open === name ? '' : name
    memory = { more: false, advanced: false }
    if (before !== undefined) showDetail(before, false)
    const now = rows.get(state.open)
    if (now !== undefined) showDetail(now, true)
    rows.get(name)?.li.querySelector<HTMLElement>('.leaf-main')?.focus()
  }

  const leaf = (label: Label, group: string, hits: readonly Rule[]): HTMLLIElement => {
    const slot = el('div', { class: 'detail', id: `detail-${label.name.replace(/^labels\//, '')}`, role: 'region', 'aria-label': label.displayName, hidden: true })
    const row: Row = { name: label.name, group, hits, li: el('li', {}, slot), slot }
    rows.set(label.name, row)
    showDetail(row, state.open === label.name)
    return row.li
  }

  const search = el('input', { type: 'search', placeholder: '搜索标签、发件人或域名', 'aria-label': '搜索标签或规则', autocomplete: 'off', spellcheck: 'false', 'data-focus': 'search' })
  const head = el('div', { class: 'tree-head' })
  const tree = el('div')

  const paintTree = () => {
    const shown = searchLabels(state.labels, state.rules, state.query)
    const searching = state.query.trim() !== ''
    fill(head, el('span', {}, searching ? `找到 ${String(shown.size)} 个` : `${String(state.labels.length)} 个标签`), el('span', { 'aria-hidden': 'true' }, '正式打'))
    rows = new Map()
    const groups = groupByTop(
      state.labels.filter((label) => shown.has(label.name)),
      (label) => label.displayName,
    )
    if (groups.length === 0) {
      fill(tree, emptyState('没有匹配的标签或规则'))
      return
    }
    fill(
      tree,
      el(
        'ul',
        { class: 'tree', 'aria-label': '标签' },
        ...groups.flatMap((group) => {
          const leaves = group.members.map((label) => leaf(label, group.name, shown.get(label.name) ?? []))
          return group.name === '' ? leaves : [el('li', { class: 'branch' }, el('span', { class: 'branch-name' }, group.name), el('ul', { 'aria-label': group.name }, ...leaves))]
        }),
      ),
    )
  }
  search.addEventListener('input', () => {
    state.query = search.value
    paintTree()
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return
    event.preventDefault()
    search.value = ''
    state.query = ''
    paintTree()
  })

  /** “+ 新标签”, and its one field once pressed: the new label opens with its description focused. */
  const newLabel = (): HTMLElement => {
    const box = el('div', { class: 'new-label' })
    const start = button('+ 新标签', () => {
      form()
    }, { class: 'quiet', 'data-focus': 'new-label' })
    const reset = () => {
      fill(box, start)
    }
    const form = () => {
      const path = el('input', { placeholder: '路径，如 金融/投资', maxlength: '100', 'aria-label': '新标签路径' })
      const submit = async () => {
        const value = path.value.trim()
        if (value === '') {
          path.focus()
          return
        }
        const created = await act((requestId) => api.createLabel({ label: create(LabelSchema, { displayName: value, enabled: true }), requestId }), '已创建', () => Promise.resolve())
        if (created === null) return
        reset()
        search.value = ''
        state.query = ''
        state.open = created.name
        memory = { more: false, advanced: false }
        await refresh('description')
      }
      const cancel = () => {
        reset()
        start.focus()
      }
      path.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void submit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      })
      fill(box, el('div', { class: 'actions' }, path, button('创建', () => void submit(), { class: 'primary' }), button('取消', cancel, { class: 'quiet' })))
      path.focus()
    }
    reset()
    return box
  }

  /** No label at all: 套用推荐模板 (previewed, then confirmed) or one's own. */
  const emptyPanel = (): HTMLElement[] => {
    const preview = el('div')
    const apply = async () => (await act((requestId) => api.importRules({ useTemplate: true, requestId }), (done) => `已添加 ${String(done.createdLabelCount)} 个标签`, () => refresh('search'))) !== null
    const showTemplate = async () => {
      try {
        const answer = await api.importRules({ useTemplate: true, validateOnly: true })
        fill(preview, templateCard(answer, apply, () => {
          preview.replaceChildren()
          offer.focus()
        }))
        preview.querySelector<HTMLButtonElement>('button.primary')?.focus()
      } catch (error) {
        toast(errorMessage(error))
      }
    }
    const offer = button('套用推荐模板', () => void showTemplate(), { class: 'primary' })
    return [el('div', { class: 'empty' }, el('strong', {}, '还没有标签'), el('div', { class: 'actions center' }, offer, newLabel())), preview]
  }

  const layout = [search, el('div', { class: 'tree-box' }, head, tree), newLabel()]
  const paint = (focus = '') => {
    if (state.labels.length === 0) {
      fill(body, ...emptyPanel())
    } else {
      if (!search.isConnected) fill(body, ...layout)
      paintTree()
    }
    if (focus !== '') [...body.querySelectorAll<HTMLElement>('[data-focus]')].find((node) => node.dataset['focus'] === focus)?.focus()
  }
  paint()
}

export async function renderLabels(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '标签', async (body) => {
    // The accuracy report only draws the bars: without it the page still works.
    const [labels, rules, report] = await Promise.all([allLabels(), allRules(), api.getAccuracyReport({ name: 'accuracyReport' }).catch(() => null)])
    const precision = new Map<string, Precision>()
    for (const row of report?.labels ?? []) {
      const count = row.confirmedCount + row.correctedCount
      if (count > 0) precision.set(row.label, { bound: row.precisionLowerBound, count, below: row.precisionLowerBound < (report?.precisionTarget ?? 0) })
    }
    labelsPage(body, ctx, labels, rules, precision)
  })
}
