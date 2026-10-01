/**
 * The watches (`/watches`), newest first, each with its health in one line: its state, its last check (or what failed:
 * never "no change" for a failure), its new changes, and "立即检查". A search box filters by name and URL (ListWatches'
 * AIP-160 filter, the text as one quoted literal).
 */
import { quoteLiteral } from '@ziyixi/proto/filter'
import { WatchHealth_Outcome, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { api, errorMessage, listAllWatches, newRequestId, withRetry } from '../api.ts'
import { button, el, toast } from '../dom.ts'
import { failureText, hostOf, relative, watchIdOf, watchState } from '../format.ts'
import type { ViewContext } from '../app.ts'

/** A watch's last check in words. */
export function lastCheck(watch: Watch, now: number): string {
  const health = watch.health
  if (health?.lastCheckTime === undefined) return '尚未检查'
  if (health.lastOutcome === WatchHealth_Outcome.FAILED) return `${relative(health.lastCheckTime, now)}：${failureText(health.lastFailure, health.lastHttpStatus)}`
  const outcome = health.lastOutcome === WatchHealth_Outcome.CHANGED ? '有变化' : health.lastOutcome === WatchHealth_Outcome.NOT_MODIFIED ? '未修改（304）' : '无变化'
  return `${relative(health.lastCheckTime, now)}检查：${outcome}`
}

export function watchRow(ctx: ViewContext, watch: Watch, onChange: () => void): HTMLElement {
  const id = watchIdOf(watch.name)
  const state = watchState(watch)
  const name = el('a', { href: `/watches/${id}`, class: 'watch-name' }, watch.displayName)
  name.addEventListener('click', (event) => {
    event.preventDefault()
    ctx.go(`/watches/${id}`)
  })
  return el(
    'article',
    { class: 'card watch', 'data-watch': id },
    el('div', { class: 'card-head' }, name, el('span', { class: `chip ${state.tone}` }, state.label)),
    el('p', { class: 'muted' }, hostOf(watch.uri)),
    el('p', { class: 'health' }, lastCheck(watch, ctx.host.now())),
    watch.health?.pendingConfirmation === true ? el('p', { class: 'hint' }, '有变化等待确认') : null,
    el(
      'div',
      { class: 'actions' },
      watch.newChangeCount > 0 ? el('span', { class: 'chip new' }, `${String(watch.newChangeCount)} 个新变化`) : null,
      button('立即检查', () => {
        const requestId = newRequestId()
        void withRetry(() => api.checkWatch({ name: watch.name, requestId })).then(
          (checked) => {
            toast(`已安排检查：${relative(checked.health?.nextCheckTime, ctx.host.now())}`)
            onChange()
          },
          (error: unknown) => toast(errorMessage(error)),
        )
      }, { class: 'small' }),
    ),
  )
}

export async function renderWatches(ctx: ViewContext): Promise<void> {
  const search = el('input', { type: 'search', placeholder: '按名称或网址筛选', 'aria-label': '筛选监视', autocomplete: 'off' })
  const list = el('section', { class: 'list', 'aria-label': '监视' })
  const add = button('添加监视', () => ctx.go('/new'), { class: 'primary' })
  ctx.main.replaceChildren(el('div', { class: 'row' }, el('h1', {}, '监视'), add), search, list)
  const load = async () => {
    try {
      const text = search.value.trim()
      const watches = await listAllWatches(text === '' ? '' : quoteLiteral(text))
      list.replaceChildren(...watches.map((watch) => watchRow(ctx, watch, () => void load())))
      if (watches.length === 0) list.append(el('p', { class: 'empty' }, text === '' ? '还没有监视。点“添加监视”开始。' : '没有匹配的监视。'))
    } catch (error) {
      list.replaceChildren(el('p', { class: 'status' }, errorMessage(error)))
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => void load(), 250)
  })
  await load()
}
