/**
 * 期刊 (`/`, ../../docs/design.md §11): the issues, newest first (an issue being made on top), 30 a page with 更多. A
 * row is a link to the issue: its title (the email's subject, which names the day), its cost, and one line of chips
 * and figures: 制作中 or 待发送 while it is not out yet, 未知 for a send whose outcome is unknown, 未发送 when nothing
 * was emailed, 失败, 影子版, 无条目, and its item count.
 */
import { Issue_QuietReason, Issue_State, type Issue } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { api, errorMessage } from '../api.ts'
import { chip, emptyState, type Tone } from '../components.ts'
import { button, el, fill, toast } from '../dom.ts'
import { dayText, issueDay, usd } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { frame } from './common.ts'

const PAGE_SIZE = 30

/** The row's chips, in the order they read. */
export function issueChips(issue: Issue): [string, Tone][] {
  const chips: [string, Tone][] = []
  const state: Readonly<Partial<Record<number, [string, Tone]>>> = {
    [Issue_State.BUILDING]: ['制作中', 'muted'],
    [Issue_State.READY]: ['待发送', 'muted'],
    [Issue_State.SEND_UNKNOWN]: ['未知', 'warn'],
    [Issue_State.SEND_REJECTED]: ['未发送', 'warn'],
    [Issue_State.ARCHIVED]: ['未发送', 'muted'],
    [Issue_State.FAILED]: ['失败', 'warn'],
  }
  const own = state[issue.state]
  if (own !== undefined) chips.push(own)
  if (issue.shadow) chips.push(['影子版', 'muted'])
  if (issue.quietReason !== Issue_QuietReason.UNSPECIFIED) chips.push(['无条目', 'muted'])
  return chips
}

function row(issue: Issue, ctx: ViewContext): HTMLElement {
  const day = issueDay(issue.name)
  const link = el(
    'a',
    { class: 'row-link', href: `/issues/${day}` },
    el('span', { class: 'row-head' }, el('span', { class: 'row-title' }, issue.title === '' ? dayText(day, ctx.host.now()) : issue.title), issue.state === Issue_State.BUILDING ? null : el('span', { class: 'meta' }, usd(issue.costUsd))),
    el('span', { class: 'row-chips' }, ...issueChips(issue).map(([text, tone]) => chip(text, tone)), issue.itemCount > 0 ? el('span', { class: 'meta' }, `${String(issue.itemCount)} 条`) : null),
  )
  link.addEventListener('click', (event) => {
    event.preventDefault()
    void ctx.go(`/issues/${day}`)
  })
  return el('li', {}, link)
}

export async function renderIssues(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '期刊', async (body) => {
    const first = await api.listIssues({ pageSize: PAGE_SIZE })
    if (first.issues.length === 0) {
      body.replaceChildren(emptyState('还没有期刊', '工作日 06:30、周六 07:30（美西时间）各一期；仅归档模式下只存档、不发信'))
      return
    }
    const list = el('ul', { class: 'rows issues' }, ...first.issues.map((issue) => row(issue, ctx)))
    const more = el('div', { class: 'actions center' })
    const paintMore = (token: string) => {
      const load = async () => {
        try {
          const page = await api.listIssues({ pageSize: PAGE_SIZE, pageToken: token })
          list.append(...page.issues.map((issue) => row(issue, ctx)))
          paintMore(page.nextPageToken)
        } catch (error) {
          toast(errorMessage(error))
        }
      }
      fill(more, token === '' ? null : button('更多', () => void load()))
    }
    paintMore(first.nextPageToken)
    body.replaceChildren(list, more)
  })
}
