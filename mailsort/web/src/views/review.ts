/**
 * 待审 (`/`): the few uncertain mails a day the model asks about (at most a daily quota, ../../docs/design.md §5), newest
 * first, one compact row each: the masked subject and sender (kept 14 days), why the model was uncertain in plain
 * words, and the answers as one-tap buttons: the model's most likely options with their probabilities (the first
 * always, and primary; the others from 5 %), 都不是 among them or after them, 其他… (the searchable picker over every
 * label) and 跳过. A label or 都不是 is ResolveReviewItem; 跳过 is SkipReviewItem. An answer leaves the list at once
 * and the next row takes the focus.
 *
 * Keyboard: j / k move between rows, 1 to 4 choose that answer, Enter the first (or 其他… when the model gave none), c
 * opens 其他…, s skips. A suspected phishing mail, or a trust label for a sender not trusted yet, says so in a warning
 * line; then no answer is primary and a label asks first. Any answer that would teach a trust label a domain
 * (ReviewItem.teachable_domain, ../../docs/design.md §3.2) asks first too, naming the domain, whatever the reason, and
 * is never primary: one tap must not trust a sender. A mail the model gave no answer for has no primary answer either.
 */
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import type { ReviewItem } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import { api, listAll } from '../api.ts'
import { emptyState, picker, type PickerOption } from '../components.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, percent, UNSURE_REASONS, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, allLabels, frame } from './common.ts'

/** Reasons where the pipeline held the label back on purpose: one tap must not file such a mail under it. */
const CAUTION: Readonly<Record<string, string>> = {
  suspicious: '疑似钓鱼：先在 Gmail 里核对发件人和链接',
  untrusted_sender: '发件人还不可信：先在 Gmail 里核对发件人',
}

/** The page with nothing to answer. */
const QUIET = '没有需要你确认的邮件'

/** One answer of a row: a label ('' for 都不是) and its probability when the model gave one. */
interface Choice {
  readonly label: string
  readonly probability: number | undefined
}

interface Row {
  readonly node: HTMLLIElement
  /** Chooses the row's answer at `index` (0 is the first); nothing past the last. */
  readonly choose: (index: number) => void
  /** Enter: the first answer, or 其他… when the model gave none. */
  readonly enter: () => void
  readonly other: () => void
  readonly skip: () => void
}

/** Below this probability an option after the first is not worth a button of its own (其他… still has every label). */
const OPTION_MIN = 0.05

/**
 * A row's answers: the model's options in its order (the first always, the others from OPTION_MIN), 都不是 included
 * where the model ranked it, else after them. A mail without a model answer has 都不是 only.
 */
export function choices(item: ReviewItem): Choice[] {
  const ranked: Choice[] = item.candidates
    .filter((candidate, index) => index === 0 || candidate.probability >= OPTION_MIN)
    .map((candidate) => ({ label: candidate.label, probability: candidate.probability }))
  return ranked.some((choice) => choice.label === '') ? ranked : [...ranked, { label: '', probability: undefined }]
}

/** The keyboard hint, shown where there is a keyboard (styles.css .keys). */
function keys(): HTMLElement {
  const key = (name: string) => el('kbd', {}, name)
  return el('p', { class: 'hint keys' }, key('j'), ' ', key('k'), ' 移动 · ', key('1'), '–', key('4'), ' 选择 · ', key('c'), ' 其他 · ', key('s'), ' 跳过')
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
    const quiet = () => emptyState(QUIET, '只有模型拿不准的少数邮件会来这里')
    if (items.length === 0) {
      fill(body, quiet())
      return
    }
    const options: PickerOption[] = labels.map((label) => ({ value: label.name, text: label.displayName }))
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
    // An answered row leaves; the one after it (or before, at the end) takes its place and the focus.
    const leave = (row: Row) => {
      const index = rows.indexOf(row)
      rows.splice(index, 1)
      row.node.remove()
      ctx.refreshStatus()
      if (rows.length === 0) fill(body, quiet())
      else select(index, true)
    }

    const build = (item: ReviewItem): Row => {
      const caution = CAUTION[item.reason]
      const answers = choices(item)
      const first = item.candidates[0]?.label
      // Without the model's options there is nothing to suggest: no primary answer, and Enter opens 其他….
      const unanswered = item.candidates.length === 0
      const subject = item.subject === '' ? '（无主题）' : item.subject
      const node = el('li', { tabindex: '-1', 'aria-label': subject })
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
      const resolve = (label: string) => {
        const name = labelText(label, labels)
        const teaching = teaches(label, item, labels)
        if (label !== '' && (caution !== undefined || teaching !== '')) {
          const question = caution === undefined ? `选“${name}”？${teaching}` : `${caution}。仍然选“${name}”？${teaching}`
          if (!ctx.host.confirm(question)) return
        }
        void run((requestId) => api.resolveReviewItem({ name: item.name, label, requestId }), `${unanswered ? '已选' : label === first ? '已确认' : '已改为'}：${name}`)
      }
      const skip = () => void run((requestId) => api.skipReviewItem({ name: item.name, requestId }), '已跳过')
      const otherButton = button('其他…', () => {
        if (slot.hidden) other()
        else close()
      }, { class: 'quiet', 'aria-expanded': 'false' })
      const close = () => {
        slot.hidden = true
        slot.replaceChildren()
        otherButton.setAttribute('aria-expanded', 'false')
      }
      const other = () => {
        // The first label the buttons do not already offer is highlighted.
        const offered = new Set(answers.map((choice) => choice.label))
        const next = options.find((option) => !offered.has(option.value))?.value ?? ''
        slot.replaceChildren(
          picker(options, next, (value) => {
            close()
            resolve(value)
          }, () => {
            close()
            otherButton.focus()
          }),
        )
        slot.hidden = false
        otherButton.setAttribute('aria-expanded', 'true')
        slot.querySelector('input')?.focus()
        // Now that the list is on the page, its highlighted label can be scrolled into sight.
        slot.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
      }
      const answerButton = ({ label, probability }: Choice, index: number) => {
        const name = labelText(label, labels)
        const primary = index === 0 && caution === undefined && !unanswered && teaches(label, item, labels) === ''
        const answer = button(name, () => {
          resolve(label)
        }, { ...(primary ? { class: 'primary' } : {}), 'aria-label': probability === undefined ? name : `${name}，${percent(probability)}` })
        // The probability after the name, quieter (the aria-label already says it).
        if (probability !== undefined) answer.append(el('span', { class: 'odds', 'aria-hidden': 'true' }, percent(probability)))
        return answer
      }
      const reason = unanswered ? `${UNSURE_REASONS[item.reason] ?? item.reason}：可用 其他… 选标签` : (UNSURE_REASONS[item.reason] ?? item.reason)
      fill(
        node,
        el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, subject), el('span', { class: 'meta' }, when(item.receiveTime))),
        el('div', { class: 'row-sub' }, item.sender),
        // A warning line says why for the reasons that need care; the others in a quiet word.
        caution === undefined ? (reason === '' ? null : el('p', { class: 'hint' }, reason)) : el('p', { class: 'hint warn', role: 'note' }, caution),
        el('div', { class: 'actions answers' }, ...answers.map(answerButton), otherButton, button('跳过', skip, { class: 'quiet skip' })),
        slot,
      )
      const row: Row = {
        node,
        choose: (index) => {
          const choice = answers[index]
          if (choice !== undefined) resolve(choice.label)
        },
        enter: () => {
          if (unanswered) other()
          else row.choose(0)
        },
        other,
        skip,
      }
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
        row.enter()
      } else if (/^[1-4]$/.test(event.key)) {
        event.preventDefault()
        row.choose(Number(event.key) - 1)
      } else if (event.key === 'c') {
        event.preventDefault()
        row.other()
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

/**
 * What choosing `label` would teach (../../docs/design.md §3.2), for the question before it: the item's teachable
 * domain for a trust label that does not list it yet; '' for any other answer.
 */
function teaches(label: string, item: ReviewItem, labels: readonly Label[]): string {
  const domain = item.teachableDomain
  const chosen = labels.find((candidate) => candidate.name === label)
  if (domain === '' || chosen?.trustImplying !== true || chosen.trustedDomains.includes(domain)) return ''
  return `这会把 ${domain} 记为“${chosen.displayName}”的可信域名，以后这个域名的邮件可以自动打上它。`
}
