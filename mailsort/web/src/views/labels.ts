/** The four fixed Gmail priority labels, with their learned examples on demand. */
import { Label_GmailState, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { PRIORITIES } from '../priorities.ts'
import { allLabels, frame } from './common.ts'
import { labelDetail } from './label-detail.ts'
import { unreadClassificationCard } from './unread-classification.ts'

const GMAIL_STATE: Readonly<Partial<Record<Label_GmailState, string>>> = {
  [Label_GmailState.PENDING]: '等待创建 Gmail 标签',
  [Label_GmailState.NAME_TAKEN]: 'Gmail 同名标签待关联',
  [Label_GmailState.MISSING]: 'Gmail 标签待恢复',
}

function priorityRow(priority: (typeof PRIORITIES)[number], label: Label | undefined, count: number): HTMLLIElement {
  const detail = el('div', { class: 'detail', id: `detail-${priority.id}`, role: 'region', 'aria-label': priority.title, hidden: true })
  const problem = label === undefined ? '等待初始化' : GMAIL_STATE[label.gmailState]
  const main = el('button', { type: 'button', class: 'leaf-main', 'aria-expanded': 'false', 'aria-controls': detail.id },
    el('span', { class: 'leaf-name' }, el('span', {}, priority.title)),
    el('span', { class: 'priority-policy' }, priority.policy),
    problem === undefined ? null : el('span', { class: 'meta' }, problem),
    count === 0 ? null : el('span', { class: 'leaf-count', title: '最近 7 天分到此级的邮件' }, `7 天 ${String(count)} 封`),
  )
  const row = el('li', { class: 'leaf priority-row' }, el('div', { class: 'leaf-row' }, main), detail)
  main.addEventListener('click', () => {
    detail.hidden = !detail.hidden
    main.setAttribute('aria-expanded', String(!detail.hidden))
    row.classList.toggle('open', !detail.hidden)
    if (!detail.hidden && detail.childElementCount === 0) fill(detail, ...labelDetail(label, priority.description))
  })
  return row
}

function prioritiesReady(labels: readonly Label[]): boolean {
  return PRIORITIES.every((priority) => labels.some((label) =>
    label.name === `labels/${priority.id}` && label.displayName === priority.title && label.enabled &&
    label.keepInInbox === (priority.id === 'p1') && !label.trustImplying &&
    (label.gmailState === Label_GmailState.LINKED || label.gmailState === Label_GmailState.ADOPTED),
  ))
}

export async function renderLabels(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '分级', async (body) => {
    const [initial, report, status] = await Promise.all([allLabels(), api.getLabelReport({ name: 'labelReport' }).catch(() => null), ctx.status().catch(() => null)])
    let labels = initial
    let ready = status?.prioritiesInitialized === true && prioritiesReady(labels)
    let continuing = false
    const setup = el('section', { class: 'card priority-setup', 'aria-label': '启用分级' })
    const result = el('p', { class: 'hint', role: 'status', hidden: true })
    const start = button('启用 P1–P4 分级', () => void initialize(), { class: 'primary' })
    const unread = unreadClassificationCard(ctx, status)
    const list = el('ul', { class: 'label-list', 'aria-label': '分级' })
    const counts = new Map((report?.labels ?? []).map((row) => [row.label, row.autoCount]))
    const paint = () => {
      setup.hidden = ready
      unread.hidden = !ready
      start.textContent = continuing ? '继续设置' : '启用 P1–P4 分级'
      fill(list, ...PRIORITIES.map((priority) => {
        const label = labels.find((item) => item.name === `labels/${priority.id}`)
        return priorityRow(priority, label, counts.get(`labels/${priority.id}`) ?? 0)
      }))
    }
    const initialize = async () => {
      if (start.disabled) return
      start.disabled = true
      start.textContent = '设置中…'
      result.hidden = true
      const requestId = newRequestId()
      try {
        const answer = await withRetry(() => api.initializePriorities({ requestId }))
        labels = answer.labels
        ready = answer.completed
        continuing = !answer.completed
        result.textContent = answer.completed ? 'P1、P2、P3、P4 已启用。邮件及原有未读状态保持不变。' : '本批设置已完成，点击“继续设置”接着处理。邮件保持不变。'
        result.className = 'hint'
        ctx.refreshStatus()
      } catch (error) {
        continuing = true
        result.textContent = errorMessage(error)
        result.className = 'hint warn'
      }
      start.disabled = false
      result.hidden = false
      paint()
    }
    fill(setup,
      el('h2', {}, '启用 P1–P4 分级'),
      el('p', { class: 'hint' }, '这会移除本应用的旧 Gmail 分类标签及旧学习记录，创建 P1、P2、P3、P4。已有邮件不会删除，收件箱位置和未读状态不变。模式和模型预算保持原值。'),
      el('div', { class: 'actions' }, start),
    )
    fill(body,
      el('p', { class: 'hint lead' }, '新邮件使用 P1、P2、P3、P4 四个 Gmail 标签。拿不准时归 P1；分类保持原有未读状态。'),
      setup,
      result,
      unread,
      el('div', { class: 'label-list-box' },
        el('div', { class: 'label-list-head' }, el('span', {}, '4 个优先级'), el('span', {}, '最近 7 天')),
        list,
      ),
    )
    paint()
  })
}
