/**
 * 搜索 (`/search`, ../../docs/design.md §6.2, §8.5): the box, the four filter chips and the results.
 *
 * - The box takes words, "phrases" and operators; an operator followed by a space or Enter becomes its chip and
 *   leaves the box (query.ts takeOperators), one that does not parse stays as text with one hint line, and nothing is
 *   searched while it is there. Backspace in an empty box removes the last chip, Escape (or the box's own ✕) clears
 *   it. The search runs on Enter and on every chip change, never per keystroke (each search reads rows the account's
 *   daily budget counts). A term of one Chinese character, which the index cannot find, is named in a hint line.
 * - The chips 时间, 网站, 类型, 停留: idle, a chip reads its name; set, its value in the accent with ✕. Each opens one
 *   small popover (one at a time; a choice, Escape or a click outside closes it and gives the focus back to its chip;
 *   on a phone a full-width panel under the chips).
 * - The line above the results (`10+ 个结果`, the exact count once the last page is in) and the sort 相关 · 最新, with
 *   相关 offered only when the box has words; a result: its title and snippet with the query's words marked, the site,
 *   the date of its latest visit within the range, its focus and visits; 加载更多 adds the next ten (the focus goes to
 *   the first of them). A capped search says which bound it reached. ↓ ↑ or j k move between results, Enter opens one.
 * - Without words or chips: 最近读过. No results: 没有找到, a button per set chip to drop it, and what the index covers.
 * - Back from a page's detail shows the results as they were (the pages 加载更多 added included), without asking again.
 */
import type { SearchResult } from '@ziyixi/proto/recall/ui/v1/page_pb'
import { quoteLiteral } from '@ziyixi/proto/filter'
import { api, ApiError, errorMessage } from '../api.ts'
import { emptyState, errorLine, keys, picker, segmented, skeleton, type PickerOption } from '../components.ts'
import { addDays, dayKey, parseDay } from '../day.ts'
import { button, el, fill, typing } from '../dom.ts'
import { duration, monthText, ms, shortWhen } from '../format.ts'
import { highlightWords, loneCharactersHint, marked } from '../marks.ts'
import {
  clearFilter,
  DWELL_PRESETS,
  FILTER_NAMES,
  FILTERS,
  filterValue,
  fromUrl,
  hasRange,
  hasWords,
  normalizeSite,
  parseDwell,
  presetStart,
  searchRequest,
  takeOperators,
  TIME_PRESETS,
  toUrl,
  type Filter,
  type SearchState,
} from '../query.ts'
import type { ViewContext } from '../app.ts'
import { titleOf } from './timeline.ts'

/** The sites the 网站 picker loads once and filters as the owner types (ListSites' largest page). */
const SITES_LOADED = 200

/** What a search showed: kept in the history entry, so back shows it again as it was. */
interface Shown {
  readonly asked: SearchState
  readonly results: readonly SearchResult[]
  readonly next: string
  readonly capped: boolean
}

/** The kept results of this entry, when they answer the search the URL holds. */
function restoredResults(ctx: ViewContext, state: SearchState): Shown | null {
  const kept = ctx.restored() as Partial<Shown> | undefined
  if (kept?.asked === undefined || !Array.isArray(kept.results) || toUrl(kept.asked) !== toUrl(state)) return null
  return { asked: kept.asked, results: kept.results, next: kept.next ?? '', capped: kept.capped === true }
}

/** The line a capped search adds: which bound it reached (design §6.3). */
function capText(asked: SearchState): string {
  if (hasRange(asked)) return '这段时间访问太多，只看了最近的 2 万次访问，缩短时间试试'
  if (hasWords(asked) && !asked.recent) return '匹配的页面太多，只看了最相关的 2000 个，加个条件或换个词试试'
  return '结果可能不全：只看了最近访问的 5000 个页面，加个时间范围或换个条件试试'
}

export async function renderSearch(ctx: ViewContext): Promise<void> {
  const now = ctx.host.now()
  const today = dayKey(now)
  let state = fromUrl(new URLSearchParams(window.location.search))

  const box = el('input', {
    id: 'q',
    type: 'search',
    placeholder: '搜索读过的内容、标题或网址',
    'aria-label': '搜索',
    autocomplete: 'off',
    enterkeyhint: 'search',
    spellcheck: 'false',
  })
  box.value = state.q
  const form = el('form', { class: 'search-form', role: 'search' }, box)
  const hint = el('p', { class: 'hint op-hint', 'aria-live': 'polite', hidden: true })
  const termsHint = el('p', { class: 'hint terms-hint', 'aria-live': 'polite', hidden: true })
  const chips = el('div', { class: 'filters', role: 'group', 'aria-label': '条件' })
  const popover = el('div', { class: 'popover', role: 'dialog', hidden: true })
  // The line above the results stays while a search runs, so its sort keeps the focus.
  const count = el('span', { class: 'meta' })
  const sort = segmented('排序', [[false, '相关'], [true, '最新']], state.recent, (recent) => {
    if (recent === state.recent) return
    state = { ...state, recent }
    markSort()
    void search()
  })
  const line = el('div', { class: 'results-line', hidden: true }, count, sort)
  const results = el('div', { class: 'stack results-area' })
  ctx.main.replaceChildren(
    el('h1', { class: 'visually-hidden' }, '搜索'),
    el('div', { class: 'body' }, form, hint, el('div', { class: 'filters-wrap' }, chips, popover), termsHint, line, results, keys([['↓', '↑'], '选择'], [['Enter'], '打开'], [['Esc'], '清空'])),
  )

  const showHint = (text: string) => {
    hint.textContent = text
    hint.hidden = text === ''
  }
  const markSort = () => {
    sort.querySelectorAll('button').forEach((node, index) => node.setAttribute('aria-pressed', (index === 1) === state.recent ? 'true' : 'false'))
  }

  // ---- the chips and their popovers ----------------------------------------------------------------------------

  let openFilter: Filter | null = null
  const chipButton = (filter: Filter) => chips.querySelector<HTMLButtonElement>(`[data-filter="${filter}"]`)

  const paintChips = () => {
    fill(
      chips,
      ...FILTERS.map((filter) => {
        const value = filterValue(state, filter, today, now)
        const expanded = openFilter === filter ? 'true' : 'false'
        if (value === null) {
          return button(el('span', {}, FILTER_NAMES[filter], el('span', { 'aria-hidden': 'true' }, ' ▾')), () => toggle(filter), { class: 'filter', 'data-filter': filter, 'aria-expanded': expanded, 'aria-haspopup': 'dialog' })
        }
        const text = filter === 'dwell' ? `${FILTER_NAMES[filter]} ${value}` : value
        return el(
          'span',
          { class: 'filter set' },
          button(text, () => toggle(filter), { class: 'filter-value', 'data-filter': filter, 'aria-label': `${FILTER_NAMES[filter]}：${value}`, 'aria-expanded': expanded, 'aria-haspopup': 'dialog' }),
          // The focus stays on the chip, idle now.
          button('✕', () => choose(clearFilter(state, filter), false, filter), { class: 'filter-clear', 'aria-label': `去掉 ${FILTER_NAMES[filter]}` }),
        )
      }),
    )
  }

  const outside = (event: Event) => {
    const target = event.target
    if (target instanceof Node && (popover.contains(target) || chips.contains(target))) return
    closePopover()
  }
  const onPopoverKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closePopover()
  }
  popover.addEventListener('keydown', onPopoverKey)

  /** Closes the open popover; the focus goes back to its chip unless the owner put it somewhere else. */
  const closePopover = () => {
    const filter = openFilter
    if (filter === null) return
    openFilter = null
    const active = document.activeElement
    const inside = active === null || active === document.body || popover.contains(active) || chips.contains(active)
    popover.hidden = true
    popover.replaceChildren()
    document.removeEventListener('click', outside)
    paintChips()
    if (inside) chipButton(filter)?.focus()
  }
  ctx.onLeave(() => {
    document.removeEventListener('click', outside)
  })

  /** Applies a new state from a chip: it closes the popover (or puts the focus on `focusChip`) and searches. */
  const choose = (next: SearchState, fromPopover = true, focusChip?: Filter) => {
    state = next
    if (fromPopover && openFilter !== null) closePopover()
    else {
      paintChips()
      if (focusChip !== undefined) chipButton(focusChip)?.focus()
    }
    void search()
  }

  const toggle = (filter: Filter) => {
    if (openFilter === filter) {
      closePopover()
      return
    }
    if (openFilter !== null) closePopover()
    openFilter = filter
    popover.setAttribute('aria-label', FILTER_NAMES[filter])
    popover.replaceChildren(...popoverBody(filter))
    popover.hidden = false
    paintChips()
    place(filter)
    // After this click is done, so that the click that opened it does not close it.
    setTimeout(() => {
      if (openFilter === filter) document.addEventListener('click', outside)
    }, 0)
    // The chosen option first, so that a reflex Enter changes nothing.
    const first = popover.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? popover.querySelector<HTMLElement>('input, button')
    first?.focus()
  }

  /** On a wide screen the popover sits under its chip (a phone's is a full-width panel, styles.css). */
  const place = (filter: Filter) => {
    popover.style.left = ''
    const chip = chipButton(filter)
    if (chip === null || getComputedStyle(popover).position !== 'absolute') return
    const left = (chip.closest<HTMLElement>('.filter') ?? chip).offsetLeft
    popover.style.left = `${String(Math.max(0, Math.min(left, (chips.parentElement?.clientWidth ?? 0) - popover.offsetWidth)))}px`
  }

  const popoverBody = (filter: Filter): HTMLElement[] => {
    switch (filter) {
      case 'time':
        return timePopover()
      case 'site':
        return [sitePicker()]
      case 'type':
        return [segmented('类型', [[false, '全部'], [true, '读过']], state.read, (read) => choose({ ...state, read }))]
      case 'dwell':
        return dwellPopover()
    }
  }

  const timePopover = (): HTMLElement[] => {
    const preset = state.before === '' ? TIME_PRESETS.find(([days]) => presetStart(today, days) === state.after)?.[0] : undefined
    const custom = el('div', { class: 'custom', hidden: true })
    const from = el('input', { type: 'date', 'aria-label': '从', max: today, value: state.after })
    const to = el('input', { type: 'date', 'aria-label': '到', max: today, value: state.before === '' ? '' : addDays(state.before, -1) })
    // One picked day is that day; picking 到 as well makes a range.
    from.addEventListener('change', () => {
      if (to.value === '' || to.value < from.value) to.value = from.value
    })
    const problem = el('p', { class: 'hint warn', hidden: true })
    const apply = () => {
      const after = parseDay(from.value) ?? ''
      const last = parseDay(to.value) ?? after
      if (after !== '' && last !== '' && last < after) {
        problem.textContent = '结束日期不能早于开始日期'
        problem.hidden = false
        return
      }
      choose({ ...state, after, before: last === '' ? '' : addDays(last, 1) })
    }
    custom.append(el('div', { class: 'range' }, el('label', {}, el('span', { class: 'meta' }, '从'), from), el('label', {}, el('span', { class: 'meta' }, '到'), to)), problem, el('div', { class: 'actions' }, button('确定', apply, { class: 'primary small' })))
    const isCustom = preset === undefined && hasRange(state)
    custom.hidden = !isCustom
    const options: (readonly [number | 'custom', string])[] = [...TIME_PRESETS, ['custom', '自定义']]
    return [
      segmented<number | 'custom'>('时间', options, isCustom ? 'custom' : (preset ?? null), (value) => {
        if (value === 'custom') {
          custom.hidden = false
          for (const node of popover.querySelectorAll('.segmented button')) node.setAttribute('aria-pressed', node.textContent === '自定义' ? 'true' : 'false')
          from.focus()
        } else choose({ ...state, after: presetStart(today, value), before: '' })
      }),
      custom,
      el('div', { class: 'actions' }, button('任何时间', () => choose(clearFilter(state, 'time')), { class: 'quiet small' })),
    ]
  }

  const dwellPopover = (): HTMLElement[] => {
    const preset = DWELL_PRESETS.find(([seconds]) => seconds === state.dwell)?.[0]
    const custom = el('div', { class: 'custom', hidden: preset !== undefined })
    const field = el('input', { type: 'text', 'aria-label': '至少停留', placeholder: '如 5m、90s、1h', autocomplete: 'off', value: preset === undefined ? `${String(state.dwell)}s` : '' })
    const problem = el('p', { class: 'hint warn', hidden: true })
    const apply = () => {
      const seconds = parseDwell(field.value)
      if (seconds === null) {
        problem.textContent = '需要时长，如 5m、90s、1h'
        problem.hidden = false
        return
      }
      choose({ ...state, dwell: seconds })
    }
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      apply()
    })
    custom.append(el('div', { class: 'actions' }, field, button('确定', apply, { class: 'primary small' })), problem)
    const options: (readonly [number | 'custom', string])[] = [...DWELL_PRESETS, ['custom', '自定义']]
    return [
      segmented<number | 'custom'>('停留', options, preset ?? 'custom', (value) => {
        if (value === 'custom') {
          custom.hidden = false
          for (const node of popover.querySelectorAll('.segmented button')) node.setAttribute('aria-pressed', node.textContent === '自定义' ? 'true' : 'false')
          field.focus()
        } else choose({ ...state, dwell: value })
      }),
      custom,
    ]
  }

  // The top sites are loaded once per visit of 搜索; past them, the server's prefix filter answers what was typed.
  let topSites: Promise<{ readonly sites: readonly string[]; readonly more: boolean }> | null = null
  let siteAsk = 0
  const siteOptions = async (typed: string): Promise<readonly PickerOption[]> => {
    topSites ??= api.listSites({ pageSize: SITES_LOADED }).then((page) => ({ sites: page.sites.map((site) => site.name.replace(/^sites\//, '')), more: page.nextPageToken !== '' }))
    const top = await topSites
    const text = typed.toLowerCase().replace(/^www\./, '')
    // What was typed first, then the hosts that start with it, then those that hold it (each in focus order).
    const rank = (site: string) => (site === text ? 0 : site.startsWith(text) ? 1 : 2)
    const local = top.sites.filter((site) => site.includes(text)).sort((a, b) => rank(a) - rank(b))
    let found = local
    siteAsk += 1
    const mine = siteAsk
    if (top.more && text !== '') {
      // A pause first, so that typing a host asks the server once, for the last text.
      await new Promise((resolve) => setTimeout(resolve, 200))
      if (mine !== siteAsk) return []
      const page = await api.listSites({ pageSize: 20, filter: quoteLiteral(text) })
      found = [...local, ...page.sites.map((site) => site.name.replace(/^sites\//, '')).filter((site) => !local.includes(site))]
    }
    // A typed domain is an option of its own, first: the filter covers its subdomains, so `google.com` is not
    // `docs.google.com`, and Enter takes what was typed.
    const host = normalizeSite(typed)
    const own = host !== null && host.includes('.') ? [{ value: host, text: `${host}（含子域名）` }] : []
    return [...own, ...found.filter((site) => site !== host).map((site) => ({ value: site, text: site }))]
  }
  const sitePicker = () =>
    picker('网站', '输入网站，如 github.com', (typed) => siteOptions(typed).catch(() => []), (site) => choose({ ...state, site }), closePopover, normalizeSite)

  // ---- the box -------------------------------------------------------------------------------------------------

  /** Moves the operators typed so far into chips (`final` on Enter, when the last one is complete too); true when one moved. */
  const takeTyped = (final: boolean): boolean => {
    const taken = takeOperators(box.value, state, final, today)
    const changed = taken.state !== state
    showHint(taken.hint)
    if (taken.text !== box.value) box.value = taken.text
    state = taken.state
    if (changed) paintChips()
    return changed
  }
  box.addEventListener('input', () => {
    if (takeTyped(false)) void search()
    // Emptied (the box's own ✕, or every character deleted): the search without words, as Escape.
    else if (box.value === '' && state.q !== '') void search()
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    takeTyped(true)
    void search()
  })
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && box.value === '') {
      const last = [...FILTERS].reverse().find((filter) => filterValue(state, filter, today, now) !== null)
      if (last === undefined) return
      event.preventDefault()
      choose(clearFilter(state, last), false)
    } else if (event.key === 'Escape' && box.value !== '') {
      event.preventDefault()
      box.value = ''
      showHint('')
      void search()
    }
  })

  // ---- the results ---------------------------------------------------------------------------------------------

  let searches = 0
  let shown: Shown | null = null
  let list = el('ul', { class: 'results', 'aria-label': '结果' })
  const tail = el('div', { class: 'stack' })
  ctx.keep(() => shown)

  const paintLine = (asked: SearchState, total: number, more: boolean) => {
    const plain = !hasWords(asked) && FILTERS.every((filter) => filterValue(asked, filter, today, now) === null)
    count.textContent = plain ? '最近读过' : `${String(total)}${more ? '+' : ''} 个结果`
    sort.hidden = !hasWords(asked)
    line.hidden = false
  }

  const paintTail = (current: Shown) => {
    fill(
      tail,
      current.next === '' ? null : button('加载更多', () => void more(), { class: 'more-results' }),
      current.capped ? el('p', { class: 'hint warn cap' }, capText(current.asked)) : null,
    )
  }

  /** The results of `current`, drawn whole (a search's first page, or the kept results of back). */
  const paintResults = (current: Shown) => {
    shown = current
    list = el('ul', { class: 'results', 'aria-label': '结果' }, ...current.results.map((result) => resultRow(ctx, result, current.asked, highlightWords(current.asked.q), now)))
    paintLine(current.asked, current.results.length, current.next !== '')
    paintTail(current)
    fill(results, list, tail)
  }

  /** 加载更多: the next ten, added under the others; the focus goes to the first of them. */
  const more = async () => {
    const current = shown
    if (current === null || current.next === '') return
    const mine = searches
    let answer
    try {
      answer = await api.searchPages(searchRequest(current.asked, current.next))
    } catch (error) {
      if (mine === searches) fill(tail, errorLine(errorMessage(error), () => void more()))
      return
    }
    if (mine !== searches) return
    const added = answer.results.map((result) => resultRow(ctx, result, current.asked, highlightWords(current.asked.q), now))
    shown = { ...current, results: [...current.results, ...answer.results], next: answer.nextPageToken, capped: current.capped || answer.candidatesCapped }
    list.append(...added)
    paintLine(shown.asked, shown.results.length, shown.next !== '')
    paintTail(shown)
    added[0]?.querySelector<HTMLElement>('a')?.focus()
  }

  /** Runs the search of the box's words and the chips into `results` (its URL replacing the entry's). */
  const search = async (): Promise<void> => {
    // An operator that does not parse stays in the box with its hint: nothing is searched until it is fixed.
    const pending = takeOperators(box.value, state, true, today)
    if (pending.hint !== '') {
      showHint(pending.hint)
      return
    }
    searches += 1
    const mine = searches
    state = { ...state, q: box.value.trim() }
    ctx.replace(toUrl(state))
    const asked = state
    termsHint.textContent = loneCharactersHint(asked.q)
    termsHint.hidden = termsHint.textContent === ''
    fill(results, skeleton(4))
    let answer
    try {
      answer = await api.searchPages(searchRequest(asked, ''))
    } catch (error) {
      if (mine !== searches) return
      shown = null
      line.hidden = true
      // A query of single Chinese characters only, or a day's read budget spent, is not a failure to retry.
      if (error instanceof ApiError && (error.reason === 'QUERY_NOT_SEARCHABLE' || error.reason === 'SEARCH_OVER_BUDGET')) fill(results, el('p', { class: 'hint warn' }, error.message))
      else fill(results, errorLine(errorMessage(error), () => void search()))
      return
    }
    if (mine !== searches) return
    const current: Shown = { asked, results: answer.results, next: answer.nextPageToken, capped: answer.candidatesCapped }
    if (current.results.length === 0) {
      shown = current
      line.hidden = true
      fill(results, await noResults(asked, current.capped))
      return
    }
    paintResults(current)
  }

  /** No results: a button per set chip to drop it, what the index covers, and the bound when one was reached. */
  const noResults = async (asked: SearchState, capped: boolean): Promise<HTMLElement> => {
    const set = FILTERS.flatMap((filter) => {
      const value = filterValue(asked, filter, today, now)
      return value === null ? [] : [[filter, value] as const]
    })
    if (!hasWords(asked) && set.length === 0 && !capped) return emptyState('还没有读过的页面', '停留 10 秒以上的页面会保存正文，之后能在这里搜到。')
    let oldest: number | null = null
    try {
      oldest = ms((await ctx.status()).oldestIndexedTextTime)
    } catch {
      // The status is the header's to report.
    }
    return emptyState(
      '没有找到',
      '',
      set.length === 0 ? null : el('div', { class: 'actions center' }, ...set.map(([filter, value]) => button(`去掉 ${FILTER_NAMES[filter]}：${value}`, () => choose(clearFilter(state, filter), false)))),
      capped ? el('p', { class: 'hint warn cap' }, capText(asked)) : null,
      el('p', { class: 'hint' }, '正文只搜每页前 32 KB'),
      oldest === null ? null : el('p', { class: 'hint' }, `正文搜索覆盖 ${monthText(oldest)} 起，更早的页面只按标题和网址搜索（全文仍在页面详情和 Dropbox 归档里）`),
    )
  }

  // ↓ ↑ or j k between results, ↓ from the box to the first; Enter opens the focused one (it is a link).
  const onKey = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const links = [...results.querySelectorAll<HTMLElement>('.result-link')]
    const index = links.findIndex((link) => link === document.activeElement)
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp'
    let to: number
    if (event.target === box) {
      if (event.key !== 'ArrowDown') return
      to = 0
    } else if (typing(event) || (!arrow && event.key !== 'j' && event.key !== 'k') || (index === -1 && event.key !== 'j')) {
      // A result has the focus for ↑ ↓ and k; j from anywhere else starts at the first.
      return
    } else {
      to = index + (event.key === 'ArrowDown' || event.key === 'j' ? 1 : -1)
    }
    if (links.length === 0) return
    event.preventDefault()
    if (to < 0) box.focus()
    else links[Math.min(links.length - 1, to)]?.focus()
  }
  document.addEventListener('keydown', onKey)
  ctx.onLeave(() => {
    document.removeEventListener('keydown', onKey)
  })

  paintChips()
  markSort()
  // Back from a page's detail: the results as they were, without a search.
  const kept = restoredResults(ctx, state)
  if (kept !== null && kept.results.length > 0) {
    termsHint.textContent = loneCharactersHint(kept.asked.q)
    termsHint.hidden = termsHint.textContent === ''
    paintResults(kept)
    return
  }
  if (ctx.host.desktop()) box.focus()
  await search()
}

/** One result: title and snippet with the query's words marked; site, date, focus and visits. */
function resultRow(ctx: ViewContext, result: SearchResult, asked: SearchState, words: readonly string[], now: number): HTMLLIElement {
  const id = result.page.replace(/^pages\//, '')
  const href = hasWords(asked) ? `/pages/${id}?q=${encodeURIComponent(asked.q.trim())}` : `/pages/${id}`
  const last = ms(result.lastVisitTime)
  const meta = [result.site, last === null ? '' : shortWhen(last, now), `停留 ${duration(result.focusSeconds)}`, `${String(result.visitCount)} 次`].filter((part) => part !== '').join(' · ')
  const snippet =
    result.snippet.length > 0
      ? el('span', { class: 'snippet' }, ...result.snippet.map((part) => (part.highlighted ? el('mark', {}, part.text) : document.createTextNode(part.text))))
      : el('span', { class: 'result-url mono' }, result.url)
  const link = el('a', { class: 'result-link', href }, el('span', { class: 'result-title' }, ...marked(titleOf(result.title, result.url), words)), el('span', { class: 'result-meta' }, meta), snippet)
  link.addEventListener('click', (event) => {
    event.preventDefault()
    void ctx.go(href)
  })
  return el('li', { class: 'result' }, link)
}
