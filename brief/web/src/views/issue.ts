/**
 * An issue (`/issues/<YYYY-MM-DD>`, ../../docs/design.md §8, §11): what was emailed (or only archived), as in the email,
 * plus what the archive alone shows.
 *
 * - The head: the title, the state in words (sent and when; unknown, never sent again; refused; archived; being made
 *   and its step; failed and its code), 影子版, how many cards the pick compared, items the check dropped, and the
 *   pick's fallback to the gate order. A quiet day shows its note and its reason instead of items.
 * - The items by section (研究前沿, 还有, 世界与经济; or the deep read): each item's topic and format, title,
 *   paragraphs, why, the source line (venues, review status, 仅摘要, 原文; the deep read lists every document) and the
 *   pick's reason. Each `[n]` is a superscript that opens its quote under the paragraph: the source's own characters,
 *   its document, and what the entailment log said of it. The vote buttons show the current vote.
 * - 成本明细: each step's model, calls, tokens and dollars (the gate is charged by day, not by issue).
 *
 * Titles, texts and quotes are untrusted: they are set as text, and a document's link only when it is a web address.
 */
import { Issue_Kind, Issue_QuietReason, Issue_State, Item_Vote, Section, type Issue, type Item, type MoreItem, type Reference, type StepCost } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import type { ServiceStatus } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { api, ApiError, listAll } from '../api.ts'
import { card, chip, emptyState } from '../components.ts'
import { button, el, fill, type Child } from '../dom.ts'
import {
  abstractOnly,
  ARCHIVED_WHY,
  count,
  FORMAT_NAMES,
  ISSUE_STATES,
  modelName,
  QUIET_REASONS,
  REVIEW_NAMES,
  SECTION_NAMES,
  stepName,
  tokens,
  topicName,
  usd,
  VERDICTS,
  webLink,
  when,
} from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'

/** The model that writes when no fallback answered (design §7). */
const WRITER = 'claude-opus-5-5'

/** The vote buttons: the vote, its text and its name for assistive technology (the email's 👍 · 👎 · 多来点). */
const VOTES: readonly (readonly [Item_Vote, string, string])[] = [
  [Item_Vote.UP, '👍', '👍 选得好'],
  [Item_Vote.DOWN, '👎', '👎 不适合我'],
  [Item_Vote.MORE, '多来点', '多来点'],
]

/** A link to a fetched document in a new tab, or its text alone when the address is not a web page's. */
function docLink(uri: string, text: string): HTMLElement {
  const href = webLink(uri)
  return href === null ? el('span', {}, text) : el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)
}

/** `a · b · c`: the parts that are there (not null, false or empty), with a quiet separator between them. */
function joined(parts: readonly Child[]): Child[] {
  return parts.filter((part) => part !== null && part !== false && part !== '').flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))
}

/** The head: the title, the state in words, and what the archive adds about how the issue was made. */
function head(issue: Issue, status: ServiceStatus | null, ctx: ViewContext): HTMLElement {
  const now = ctx.host.now()
  const [words, warn] = ISSUE_STATES[issue.state] ?? ['—', false]
  let state = words
  // The code says more only where no words do (the pick's fallback has its own line).
  let code = issue.errorCode === 'pick_fallback' ? '' : issue.errorCode
  if (issue.state === Issue_State.SENT && issue.sendTime !== undefined) state = `${words} · ${when(issue.sendTime, now)}`
  if (issue.state === Issue_State.BUILDING && status !== null && status.currentIssue === issue.name && status.currentStep !== '') state = `${words}：${stepName(status.currentStep)}`
  const why = issue.state === Issue_State.ARCHIVED ? ARCHIVED_WHY[code] : undefined
  if (why !== undefined) {
    state = `${words}：${why}`
    code = ''
  }
  const back = el('a', { class: 'back', href: '/' }, '‹ 期刊')
  back.addEventListener('click', (event) => {
    event.preventDefault()
    void ctx.go('/')
  })
  return el(
    'div',
    { class: 'issue-head' },
    back,
    el('h2', { class: 'issue-title' }, issue.title),
    el(
      'p',
      { class: 'facts' },
      el('span', warn ? { class: 'warn' } : {}, state),
      code === '' ? null : el('span', { class: 'mono' }, code),
      issue.shadow ? chip('影子版', 'muted') : null,
      issue.candidateCount > 0 ? el('span', {}, `从 ${String(issue.candidateCount)} 张卡片中挑选`) : null,
      issue.droppedItemCount > 0 ? el('span', { class: 'warn' }, `核对删去 ${String(issue.droppedItemCount)} 条`) : null,
    ),
    issue.pickFallback ? el('p', { class: 'hint' }, '挑选没有完成，本期按初筛的顺序选条目') : null,
  )
}

/** A paragraph's text with each `[n]` as a superscript button that opens its quote in `panel`. */
function paragraph(text: string, item: Item, panel: HTMLElement): HTMLElement {
  const node = el('p', { class: 'para' })
  const buttons: HTMLButtonElement[] = []
  let open = 0
  const show = (n: number) => {
    open = open === n ? 0 : n
    for (const one of buttons) one.setAttribute('aria-expanded', String(Number(one.dataset['n']) === open))
    const citation = item.citations.find((one) => one.number === open)
    panel.hidden = citation === undefined
    if (citation === undefined) {
      panel.replaceChildren()
      return
    }
    const ref = item.references[citation.referenceIndex]
    const [verdict, doubt] = VERDICTS[citation.verdict] ?? ['未检查', false]
    fill(
      panel,
      el('blockquote', {}, citation.quote),
      el('p', { class: 'quote-source' }, ...joined([`[${String(citation.number)}]`, ref === undefined ? null : ref.venue, ref === undefined ? null : docLink(ref.uri, ref.title === '' ? '原文' : ref.title)])),
      chip(`模型核对：${verdict}`, doubt ? 'warn' : 'muted'),
    )
  }
  let last = 0
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1])
    if (!item.citations.some((citation) => citation.number === n)) continue
    node.append(text.slice(last, match.index))
    const cite = button(String(n), () => show(n), { class: 'cite', 'aria-expanded': 'false', 'aria-controls': panel.id, 'aria-label': `引文 ${String(n)}`, 'data-n': String(n) })
    buttons.push(cite)
    node.append(el('sup', {}, cite))
    last = match.index + match[0].length
  }
  node.append(text.slice(last))
  return node
}

/** The source line, by code (design §11): venues, the review status, 仅摘要, and 原文. */
function sourceLine(references: readonly Reference[]): HTMLElement | null {
  const primary = references[0]
  if (primary === undefined) return null
  const venues = [...new Set(references.map((ref) => ref.venue).filter((venue) => venue !== ''))].slice(0, 3).join('、')
  return el('p', { class: 'source-line' }, ...joined([venues, REVIEW_NAMES[primary.review] ?? null, abstractOnly(primary.textScope) ? '仅摘要' : null, docLink(primary.uri, '原文')]))
}

/** The deep read's documents, listed at its end. */
function referenceList(references: readonly Reference[]): HTMLElement {
  return el(
    'ol',
    { class: 'refs' },
    ...references.map((ref) => el('li', {}, ...joined([docLink(ref.uri, ref.title === '' ? ref.venue : ref.title), ref.venue, REVIEW_NAMES[ref.review] ?? null, abstractOnly(ref.textScope) ? '仅摘要' : null]))),
  )
}

/** The vote buttons, the current vote pressed; a press records it (VoteItem) and marks the answer's vote. */
function votes(item: Item): HTMLElement {
  const box = el('div', { class: 'votes', role: 'group', 'aria-label': '评价这条' })
  const paint = () => {
    fill(
      box,
      ...VOTES.map(([vote, text, label]) =>
        button(
          text,
          () => {
            if (item.vote === vote) return
            void act((requestId) => api.voteItem({ name: item.name, vote, requestId }), `已记下 ${text}`, (answer) => {
              item.vote = answer.vote
              paint()
            })
          },
          { class: 'small', 'aria-pressed': String(item.vote === vote), ...(label === text ? {} : { 'aria-label': label }) },
        ),
      ),
    )
  }
  paint()
  return box
}

let panels = 0

function article(item: Item): HTMLElement {
  const deep = item.section === Section.DEEP_READ
  const body: HTMLElement[] = []
  for (const part of item.paragraphs) {
    panels += 1
    const panel = el('div', { class: 'quote', id: `quote-${String(panels)}`, hidden: true })
    if (part.heading !== '') body.push(el('h4', { class: 'para-heading' }, part.heading))
    body.push(paragraph(part.text, item, panel), panel)
  }
  const kicker = [topicName(item.topic), FORMAT_NAMES[item.format] ?? ''].filter((part) => part !== '').join(' · ')
  return el(
    'article',
    { class: 'item' },
    kicker === '' ? null : el('p', { class: 'kicker' }, kicker),
    el('h3', { class: 'item-title' }, item.title),
    el('div', { class: 'prose' }, ...body),
    item.why === '' ? null : el('p', { class: 'why' }, `为什么看：${item.why}`),
    deep ? referenceList(item.references) : sourceLine(item.references),
    item.reason === '' ? null : el('p', { class: 'reason' }, `入选理由：${item.reason}`),
    votes(item),
  )
}

/** 还有: titles of the owner's own field that ran without text (design §6), each to its original. */
function moreItems(more: readonly MoreItem[]): HTMLElement {
  return el(
    'section',
    { class: 'more-items' },
    el('h3', {}, '还有'),
    el('ul', {}, ...more.map((one) => el('li', {}, docLink(one.uri, one.title), el('span', { class: 'meta' }, ...joined([one.venue, REVIEW_NAMES[one.review] ?? null]))))),
  )
}

function section(title: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'section' }, el('h2', { class: 'section-title' }, title), ...children)
}

/** 成本明细: one row per step and serving model. */
function costCard(issue: Issue): HTMLElement {
  const fallbacks = issue.writerModels.filter((model) => model !== WRITER)
  const row = (cost: StepCost) =>
    el(
      'li',
      {},
      el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, `${stepName(cost.step)} · ${modelName(cost.model)}`), el('span', { class: 'meta' }, usd(cost.costUsd))),
      el(
        'p',
        { class: 'facts' },
        el('span', {}, `${String(cost.callCount)} 次`),
        el('span', {}, `输入 ${tokens(cost.inputTokenCount)}`),
        cost.cacheReadTokenCount + cost.cacheWriteTokenCount > 0 ? el('span', {}, `缓存 ${tokens(cost.cacheReadTokenCount + cost.cacheWriteTokenCount)}`) : null,
        el('span', {}, `输出 ${tokens(cost.outputTokenCount)}`),
      ),
    )
  return card(
    '成本明细',
    `${issue.itemCount > 0 ? `${count(issue.itemCount)} 条 · ` : ''}本期 ${usd(issue.costUsd)}`,
    issue.stepCosts.length === 0 ? el('p', { class: 'hint' }, '本期没有模型调用') : el('ul', { class: 'rows' }, ...issue.stepCosts.map(row)),
    fallbacks.length === 0 ? null : el('p', { class: 'hint' }, `部分内容由 ${fallbacks.map(modelName).join('、')} 写作（服务端回退）`),
    el('p', { class: 'hint' }, '初筛按天计费，不计入单期；输出含思考'),
  )
}

export async function renderIssue(ctx: ViewContext, day: string): Promise<void> {
  const name = `issues/${day}`
  await frame(ctx.main, '一期简报', async (body) => {
    const loaded = await Promise.all([
      api.getIssue({ name }),
      listAll(async (pageToken) => {
        const page = await api.listItems({ parent: name, pageToken })
        return { items: page.items, next: page.nextPageToken }
      }, 2),
    ]).catch((error: unknown) => {
      if (error instanceof ApiError && error.reason === 'NOT_FOUND') return null
      throw error
    })
    if (loaded === null) {
      body.replaceChildren(emptyState('找不到这一期', '它可能还没开始制作，或已超过两年的保留期'))
      return
    }
    const [issue, items] = loaded
    const status = issue.state === Issue_State.BUILDING ? await ctx.status().catch(() => null) : null
    const of = (wanted: Section) => items.filter((item) => item.section === wanted)
    const research = of(Section.RESEARCH)
    const world = of(Section.WORLD)
    const deep = of(Section.DEEP_READ)
    const quiet = QUIET_REASONS[issue.quietReason]
    fill(
      body,
      head(issue, status, ctx),
      issue.quietReason === Issue_QuietReason.UNSPECIFIED || quiet === undefined ? null : el('p', { class: 'note' }, `${issue.kind === Issue_Kind.DEEP_READ ? '本周无深读' : '今日无条目'}：${quiet}`),
      issue.state === Issue_State.BUILDING && items.length === 0 ? el('p', { class: 'hint' }, '还在制作，完成后这里显示条目') : null,
      research.length === 0 && issue.moreItems.length === 0 ? null : section(SECTION_NAMES[Section.RESEARCH] ?? '', ...research.map(article), issue.moreItems.length === 0 ? null : moreItems(issue.moreItems)),
      world.length === 0 ? null : section(SECTION_NAMES[Section.WORLD] ?? '', ...world.map(article)),
      ...deep.map(article),
      issue.state === Issue_State.BUILDING ? null : costCard(issue),
    )
  })
}
