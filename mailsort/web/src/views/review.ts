/**
 * 待审 (`/`): the few uncertain mails waiting for the owner, newest first, one compact row each: the masked subject and
 * sender (kept 14 days), the model's most likely label with its confidence and why it was uncertain, and 确认 (that
 * label), 改为… (the searchable label picker, 都不是 first) and 跳过. Every choice is ResolveReviewItem with a label or
 * 都不是. A choice leaves the list at once and the next row takes the focus. (The redesign of 2026-10-10 replaces this
 * view; until then it is the v1 view on mailsort.ui.v2.)
 *
 * Keyboard: j / k move between rows, Enter confirms the focused row, c opens 改为…, s skips. A suspected phishing
 * mail, or a trust label for a sender not trusted yet, says so, and its 确认 is not the primary action and asks first;
 * its picker starts at 都不是 (another mail's at the model's next choice).
 */
import type { ReviewItem } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { api, listAll } from '../api.ts'
import { bar, chip, emptyState, picker, type PickerOption } from '../components.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, percent, UNSURE_REASONS, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'

/** Reasons where the pipeline refused the label on purpose: one key must not file such a mail under it. */
const CAUTION: Readonly<Record<string, string>> = {
  suspicious: '疑似钓鱼：先在 Gmail 里核对发件人和链接',
  untrusted_sender: '发件人还不可信：先在 Gmail 里核对发件人',
}

interface Row {
  readonly node: HTMLLIElement
  readonly confirm: () => void
  readonly change: () => void
  readonly skip: () => void
}

/** Why the model was uncertain: `把握不够`, `两次判断不一致`. */
function why(item: ReviewItem): string {
  return item.reason === '' ? '' : (UNSURE_REASONS[item.reason] ?? item.reason)
}

/** The keyboard hint, shown where there is a keyboard (styles.css .keys). */
function keys(): HTMLElement {
  const key = (name: string) => el('kbd', {}, name)
  return el('p', { class: 'hint keys' }, key('j'), ' ', key('k'), ' 移动 · ', key('Enter'), ' 确认 · ', key('c'), ' 改为 · ', key('s'), ' 跳过')
}

export async function renderReview(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '待审', async (body) => {
    const [items, labels] = await Promise.all([
      listAll(async (pageToken) => {
        const page = await api.listReviewItems({ pageSize: 50, pageToken })
        return { items: page.reviewItems, next: page.nextPageToken }
      }, 4),
      allLabels(),
    ])
    if (items.length === 0) {
      fill(body, emptyState('都处理完了'))
      return
    }
    const options: PickerOption[] = [{ value: '', text: '都不是' }, ...labels.map((label) => ({ value: label.name, text: label.displayName }))]
    const list = el('ul', { class: 'rows', 'aria-label': '待审邮件' })
    const rows: Row[] = []
    let active = -1

    const select = (index: number, focus: boolean) => {
      active = Math.max(0, Math.min(index, rows.length - 1))
      rows.forEach((row, i) => {
        row.node.classList.toggle('active', i === active)
        row.node.tabIndex = i === active ? 0 : -1
      })
      if (focus) rows[active]?.node.focus()
    }
    // A resolved row leaves; the one after it (or before, at the end) takes its place and the focus.
    const leave = (row: Row) => {
      const index = rows.indexOf(row)
      rows.splice(index, 1)
      row.node.remove()
      ctx.refreshStatus()
      if (rows.length === 0) fill(body, emptyState('都处理完了'))
      else select(index, true)
    }

    const build = (item: ReviewItem): Row => {
      const caution = CAUTION[item.reason]
      const suggested = item.candidates[0]?.label ?? ''
      const probability = item.candidates.find((candidate) => candidate.label === suggested)?.probability
      const node = el('li', { tabindex: '-1', 'aria-label': item.subject === '' ? '（无主题）' : item.subject })
      const slot = el('div', { hidden: true })
      let busy = false
      // Done, the row leaves; refused, it stays to be tried again.
      const run = async (call: (requestId: string) => Promise<unknown>, done: string) => {
        if (busy) return
        busy = true
        const answer = await act(call, done, () => {
          leave(row)
        })
        if (answer === null) busy = false
      }
      const confirm = () => {
        if (suggested === '') return
        if (caution !== undefined && !ctx.host.confirm(`${caution}。仍然确认为“${labelText(suggested, labels)}”？`)) return
        void run((requestId) => api.resolveReviewItem({ name: item.name, label: suggested, requestId }), `已确认：${labelText(suggested, labels)}`)
      }
      const correct = (label: string) => void run((requestId) => api.resolveReviewItem({ name: item.name, label, requestId }), `已改为：${labelText(label, labels)}`)
      const skip = () => void run((requestId) => api.skipReviewItem({ name: item.name, requestId }), '已跳过')
      const changeButton = button('改为…', () => {
        if (slot.hidden) change()
        else close()
      }, { 'aria-expanded': 'false' })
      const close = () => {
        slot.hidden = true
        slot.replaceChildren()
        changeButton.setAttribute('aria-expanded', 'false')
      }
      const change = () => {
        // A suspected phishing mail starts at 都不是; another at the model's next choice.
        const next = item.reason === 'suspicious' ? '' : (item.candidates.find((candidate) => candidate.label !== suggested)?.label ?? '')
        slot.replaceChildren(
          picker(options, next, (value) => {
            close()
            correct(value)
          }, () => {
            close()
            changeButton.focus()
          }),
        )
        slot.hidden = false
        changeButton.setAttribute('aria-expanded', 'true')
        slot.querySelector('input')?.focus()
        // Now that the list is on the page, its highlighted label can be scrolled into sight.
        slot.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
      }
      // A warning line already says why (疑似钓鱼): the small text then says nothing more.
      const reason = caution === undefined ? why(item) : ''
      fill(
        node,
        el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, item.subject === '' ? '（无主题）' : item.subject), el('span', { class: 'meta' }, when(item.receiveTime))),
        el('div', { class: 'row-sub' }, item.sender),
        caution === undefined ? null : el('p', { class: 'hint warn', role: 'note' }, caution),
        el(
          'div',
          { class: 'row-foot' },
          el(
            'span',
            { class: 'suggestion' },
            suggested === '' ? chip('都不是', 'muted') : chip(labelText(suggested, labels), 'accent'),
            probability === undefined ? null : bar(probability),
            probability === undefined ? null : el('span', { class: 'meta' }, percent(probability)),
            reason === '' ? null : el('span', { class: 'meta' }, reason),
          ),
          el(
            'div',
            { class: 'actions' },
            suggested === '' ? null : button('确认', confirm, caution === undefined ? { class: 'primary' } : {}),
            changeButton,
            button('跳过', skip, { class: 'quiet' }),
          ),
        ),
        slot,
      )
      const row: Row = { node, confirm, change, skip }
      node.addEventListener('focusin', () => {
        if (rows[active] !== row) select(rows.indexOf(row), false)
      })
      return row
    }

    for (const item of items) rows.push(build(item))
    list.append(...rows.map((row) => row.node))

    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || rows.length === 0) return
      // Typing in the picker (or any field) is typing, never a shortcut.
      if (event.target instanceof Element && event.target.closest('input, textarea, select') !== null) return
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault()
        select(active < 0 ? 0 : active + (event.key === 'j' ? 1 : -1), true)
        return
      }
      const row = rows[active]
      if (row === undefined) return
      if (event.key === 'Enter' && event.target === row.node) {
        event.preventDefault()
        row.confirm()
      } else if (event.key === 'c') {
        event.preventDefault()
        row.change()
      } else if (event.key === 's') {
        event.preventDefault()
        row.skip()
      }
    }
    document.addEventListener('keydown', onKey)
    ctx.onLeave(() => {
      document.removeEventListener('keydown', onKey)
    })
    fill(body, list, keys())
  })
}
