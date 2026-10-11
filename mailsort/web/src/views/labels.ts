/**
 * 标签 (`/labels`): the one place for everything about a label (../../docs/design.md §9).
 *
 * - A search box over the labels' names.
 * - The labels as a flat list in their stored order, including legacy names until migration finishes. One compact row each: the name (未启用 beside it when off), how many mails the model
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
import { LabelConsolidation_State } from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb'
import { ApiError, api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { emptyState } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'
import { LABEL_PROBLEMS, labelNameInput, labelNameProblem } from './label-name.ts'
import { labelDetail, type DetailPage, type LabelFields } from './label-detail.ts'

/** A label mailsort cannot write, said on its row; its detail says what to do. */
const GMAIL_TROUBLE: Partial<Record<Label_GmailState, string>> = {
  [Label_GmailState.NAME_TAKEN]: '同名已占用',
  [Label_GmailState.MISSING]: 'Gmail 中已删除',
}

/** What the search shows: every label whose name holds the query; every label when the query is empty. */
export function searchLabels(labels: readonly Label[], query: string): Set<string> {
  const q = query.trim().toLowerCase()
  return new Set(labels.filter((label) => q === '' || label.displayName.toLowerCase().includes(q)).map((label) => label.name))
}

/** A label row and what it was drawn with. */
interface Row {
  readonly name: string
  readonly li: HTMLLIElement
  readonly slot: HTMLElement
}

/**
 * The page. `counts` are the last 7 days' confident decisions per label (empty when the report could not be read: the
 * rows then show none).
 */
function labelsPage(body: HTMLElement, ctx: ViewContext, labels: Label[], counts: ReadonlyMap<string, number>, hold: string | null): void {
  const state = { labels, query: '', open: '' }
  let memory = { more: false, advanced: false }
  let rows = new Map<string, Row>()

  const find = (name: string) => state.labels.find((label) => label.name === name)

  const saveLabel = async (name: string, fields: LabelFields, paths: readonly string[], done: string): Promise<Label | null> => {
    if (hold !== null) { toast(hold); return null }
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
    const trouble = GMAIL_TROUBLE[label.gmailState] ?? (LABEL_PROBLEMS[label.problem] === undefined ? undefined : '需整理')
    const count = counts.get(label.name) ?? 0
    const main = el(
      'button',
      { type: 'button', class: 'leaf-main', 'aria-expanded': String(open), 'aria-controls': row.slot.id, 'data-focus': `row:${label.name}` },
      el('span', { class: 'leaf-name' }, el('span', {}, label.displayName)),
      label.enabled ? null : el('span', { class: 'meta' }, '未启用'),
      trouble === undefined ? null : el('span', { class: 'meta warn' }, trouble),
      count === 0 ? null : el('span', { class: 'leaf-count', title: '最近 7 天模型有把握的邮件' }, `7 天 ${String(count)} 封`),
    )
    main.addEventListener('click', () => {
      setOpen(label.name)
    })
    const enabled = el('input', { type: 'checkbox', class: 'switch', 'aria-label': `启用：${label.displayName}`, disabled: hold !== null, ...(label.enabled ? { checked: true } : {}) })
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
      readOnly: hold !== null,
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

  const leaf = (label: Label): HTMLLIElement => {
    const slot = el('div', { class: 'detail', id: `detail-${label.name.replace(/^labels\//, '')}`, role: 'region', 'aria-label': label.displayName, hidden: true })
    const row: Row = { name: label.name, li: el('li', {}, slot), slot }
    rows.set(label.name, row)
    showDetail(row, state.open === label.name)
    return row.li
  }

  const search = el('input', { type: 'search', placeholder: '搜索标签', 'aria-label': '搜索标签', autocomplete: 'off', spellcheck: 'false', 'data-focus': 'search' })
  const head = el('div', { class: 'label-list-head' })
  const list = el('div')

  const paintList = () => {
    const shown = searchLabels(state.labels, state.query)
    const searching = state.query.trim() !== ''
    fill(head, el('span', {}, searching ? `找到 ${String(shown.size)} 个` : `${String(state.labels.length)} 个标签`), el('span', { 'aria-hidden': 'true' }, '启用'))
    rows = new Map()
    const visible = state.labels.filter((label) => shown.has(label.name))
    fill(list, visible.length === 0 ? emptyState('没有匹配的标签') : el('ul', { class: 'label-list', 'aria-label': '标签' }, ...visible.map(leaf)))
  }
  search.addEventListener('input', () => {
    state.query = search.value
    paintList()
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || search.value === '') return
    event.preventDefault()
    search.value = ''
    state.query = ''
    paintList()
  })

  /** “+ 新标签”, and its one field once pressed: the new label opens with its description focused. */
  const newLabel = (): HTMLElement => {
    const box = el('div', { class: 'new-label' })
    const start = button('+ 新标签', () => {
      form()
    }, { class: 'quiet', 'data-focus': 'new-label', disabled: hold !== null })
    const reset = () => {
      fill(box, start)
    }
    const form = () => {
      const path = labelNameInput('', '新标签名称')
      const submit = async () => {
        const value = path.value.trim()
        const problem = labelNameProblem(path.value)
        if (problem !== null) {
          toast(problem)
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

  const notice = hold === null ? null : el('p', { class: 'hint warn', role: 'status' }, hold)
  const layout = [notice, search, el('div', { class: 'label-list-box' }, head, list), newLabel()]
  const paint = (focus = '') => {
    if (state.labels.length === 0) {
      fill(body, notice, ...emptyPanel())
    } else {
      if (!search.isConnected) fill(body, ...layout)
      paintList()
    }
    if (focus !== '') [...body.querySelectorAll<HTMLElement>('[data-focus]')].find((node) => node.dataset['focus'] === focus)?.focus()
  }
  paint()
}

export async function renderLabels(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '标签', async (body) => {
    // The counts only add a figure to each row: without the report the page still works.
    const [labels, report, hold] = await Promise.all([allLabels(), api.getLabelReport({ name: 'labelReport' }).catch(() => null), api.getLabelConsolidation({ name: 'labelConsolidation' }).then((job) => job.state === LabelConsolidation_State.SUCCEEDED ? null : '标签正在整理，编辑暂时停用；到设置查看进度或继续任务').catch((error: unknown) => error instanceof ApiError && error.reason === 'NOT_FOUND' ? null : '整理状态读取失败，编辑暂时停用；请刷新页面')])
    labelsPage(body, ctx, labels, new Map((report?.labels ?? []).map((row) => [row.label, row.autoCount])), hold)
  })
}
