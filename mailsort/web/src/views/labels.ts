/**
 * 标签 (`/labels`): the one place for everything about a label (../../docs/design.md §9).
 *
 * - A search box over the labels' names.
 * - The labels as one tree in the labels' order, grouped by their top-level segment (开发 › CI通知, 平台工具; a label of
 *   one segment stands alone). One compact row each: the name (未启用 beside it when off), how many mails the model
 *   gave it in the last 7 days (the label report's confident decisions), and the one switch, 启用 (an enabled label is
 *   offered to the model, and written to Gmail in live mode).
 * - A row opens its detail under it, one at a time (label-detail.ts): a line when Gmail has a label of its name, the
 *   description, 归档, a trust label's trusted domains, the examples and 高级.
 * - One quiet “+ 新标签” at the bottom; with no label at all, the page is that one offer.
 *
 * Deleting a label leaves its Gmail label and mails as they are. (The sync with Gmail is in 设置.) There are no rules
 * and no per-label 正式打 since 2026-10-10.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { emptyState } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'
import { labelDetail, type DetailPage, type LabelFields } from './label-detail.ts'

/** A label mailsort cannot write, said on its row; its detail says what to do. */
const GMAIL_TROUBLE: Partial<Record<Label_GmailState, string>> = {
  [Label_GmailState.NAME_TAKEN]: '同名已占用',
  [Label_GmailState.MISSING]: 'Gmail 中已删除',
}

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

/** What the search shows: every label whose name holds the query; every label when the query is empty. */
export function searchLabels(labels: readonly Label[], query: string): Set<string> {
  const q = query.trim().toLowerCase()
  return new Set(labels.filter((label) => q === '' || label.displayName.toLowerCase().includes(q)).map((label) => label.name))
}

/** A row of the tree and what it was drawn with. */
interface Row {
  readonly name: string
  readonly group: string
  readonly li: HTMLLIElement
  readonly slot: HTMLElement
}

/**
 * The page. `counts` are the last 7 days' confident decisions per label (empty when the report could not be read: the
 * rows then show none).
 */
function labelsPage(body: HTMLElement, ctx: ViewContext, labels: Label[], counts: ReadonlyMap<string, number>): void {
  const state = { labels, query: '', open: '' }
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
      state.labels = await allLabels()
    } catch (error) {
      toast(errorMessage(error))
      return
    }
    if (find(state.open) === undefined) state.open = ''
    paint(focus)
  }

  /** The row's own line: the name, the last 7 days' count and 启用. */
  const paintHead = (row: Row) => {
    const label = find(row.name)
    if (label === undefined) return
    const open = state.open === label.name
    const trouble = GMAIL_TROUBLE[label.gmailState]
    const count = counts.get(label.name) ?? 0
    const main = el(
      'button',
      { type: 'button', class: 'leaf-main', 'aria-expanded': String(open), 'aria-controls': row.slot.id, 'data-focus': `row:${label.name}` },
      el('span', { class: 'leaf-name' }, el('span', {}, leafName(label.displayName, row.group))),
      label.enabled ? null : el('span', { class: 'meta' }, '未启用'),
      trouble === undefined ? null : el('span', { class: 'meta warn' }, trouble),
      count === 0 ? null : el('span', { class: 'leaf-count', title: '最近 7 天模型有把握的邮件' }, `7 天 ${String(count)} 封`),
    )
    main.addEventListener('click', () => {
      setOpen(label.name)
    })
    const enabled = el('input', { type: 'checkbox', class: 'switch', 'aria-label': `启用：${label.displayName}`, ...(label.enabled ? { checked: true } : {}) })
    enabled.addEventListener('change', () => {
      const on = enabled.checked
      void saveLabel(label.name, { enabled: on }, ['enabled'], `${label.displayName}：已${on ? '启用' : '停用'}`).then((answer) => {
        if (answer === null) enabled.checked = !on
        else paintHead(row)
      })
    })
    row.li.className = ['leaf', label.enabled ? '' : 'off', open ? 'open' : ''].filter((name) => name !== '').join(' ')
    const line = el('div', { class: 'leaf-row' }, main, el('label', { class: 'live', title: '启用' }, enabled))
    const old = row.li.querySelector(':scope > .leaf-row')
    if (old === null) row.li.prepend(line)
    else old.replaceWith(line)
  }

  const detailPage = (row: Row): DetailPage => {
    const initial = find(row.name)
    return {
      host: ctx.host,
      label: () => find(row.name) ?? initial ?? create(LabelSchema),
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

  const leaf = (label: Label, group: string): HTMLLIElement => {
    const slot = el('div', { class: 'detail', id: `detail-${label.name.replace(/^labels\//, '')}`, role: 'region', 'aria-label': label.displayName, hidden: true })
    const row: Row = { name: label.name, group, li: el('li', {}, slot), slot }
    rows.set(label.name, row)
    showDetail(row, state.open === label.name)
    return row.li
  }

  const search = el('input', { type: 'search', placeholder: '搜索标签', 'aria-label': '搜索标签', autocomplete: 'off', spellcheck: 'false', 'data-focus': 'search' })
  const head = el('div', { class: 'tree-head' })
  const tree = el('div')

  const paintTree = () => {
    const shown = searchLabels(state.labels, state.query)
    const searching = state.query.trim() !== ''
    fill(head, el('span', {}, searching ? `找到 ${String(shown.size)} 个` : `${String(state.labels.length)} 个标签`), el('span', { 'aria-hidden': 'true' }, '启用'))
    rows = new Map()
    const groups = groupByTop(
      state.labels.filter((label) => shown.has(label.name)),
      (label) => label.displayName,
    )
    if (groups.length === 0) {
      fill(tree, emptyState('没有匹配的标签'))
      return
    }
    fill(
      tree,
      el(
        'ul',
        { class: 'tree', 'aria-label': '标签' },
        ...groups.flatMap((group) => {
          const leaves = group.members.map((label) => leaf(label, group.name))
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

  /** No label at all: one's own first one. */
  const emptyPanel = (): HTMLElement[] => [emptyState('还没有标签', '', el('div', { class: 'actions center' }, newLabel()))]

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
    // The counts only add a figure to each row: without the report the page still works.
    const [labels, report] = await Promise.all([allLabels(), api.getLabelReport({ name: 'labelReport' }).catch(() => null)])
    labelsPage(body, ctx, labels, new Map((report?.labels ?? []).map((row) => [row.label, row.autoCount])))
  })
}
