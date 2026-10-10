/**
 * The search's state (../../docs/design.md §6.2, §8.5): the words and the four filters, in the URL
 * (`/search?q=…&site=…&after=…&before=…&type=read&dwell=120&sort=recent`, so reload and back work), as the filter
 * chips name them, as typed operators (site:, after:, before:, type:, dwell:) and as the typed SearchPagesRequest. The
 * server never parses an operator: the UI turns each into its field.
 *
 * Days are local day keys (day.ts): `after` is the first day of the range and `before` the day after its last, as
 * the operators read them (`before:2026-10-01` ends at the midnight starting 1 October, which is not included); the
 * operators also read 今天, 昨天 and 前天.
 */
import type { MessageInitShape } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { PageType, SortOrder, type SearchPagesRequestSchema } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb'
import { addDays, dayStart, parseDay } from './day.ts'
import { dateText, duration } from './format.ts'

export interface SearchState {
  /** The words, without operators. */
  readonly q: string
  /** A host, '' for any. */
  readonly site: string
  /** The range's first day, '' for no lower bound. */
  readonly after: string
  /** The day after the range's last, '' for no upper bound. */
  readonly before: string
  /** Only pages with a captured text (读过). */
  readonly read: boolean
  /** The least focus, in seconds; 0 for any. */
  readonly dwell: number
  /** Sorted by the latest visit (最新) rather than relevance; only with words. */
  readonly recent: boolean
}

export const EMPTY_SEARCH: SearchState = { q: '', site: '', after: '', before: '', read: false, dwell: 0, recent: false }

/** The most focus a search can ask for (SearchPagesRequest.min_focus_seconds). */
const DWELL_MAX_SECONDS = 86_400
/** A host as the API's site filter takes it (`_` included, as the archive's Site format has it). */
const HOST = /^[a-z0-9_]([a-z0-9._-]{0,251}[a-z0-9_])?$/

/** A typed site as the API's host: lower case, without a scheme, port, path or leading `www.`; null when it is no host. */
export function normalizeSite(text: string): string | null {
  const host = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
  return HOST.test(host) ? host : null
}

/** `30s`, `2m`, `1h` as seconds (1 to 86400); null otherwise. */
export function parseDwell(text: string): number | null {
  const match = /^(\d{1,6})\s*([smh])$/i.exec(text.trim())
  if (match === null) return null
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[(match[2] ?? 's').toLowerCase() as 's' | 'm' | 'h']
  return seconds >= 1 && seconds <= DWELL_MAX_SECONDS ? seconds : null
}

export function fromUrl(params: URLSearchParams): SearchState {
  const after = parseDay(params.get('after') ?? '') ?? ''
  const before = parseDay(params.get('before') ?? '') ?? ''
  const dwell = Number(params.get('dwell') ?? '0')
  return {
    q: params.get('q') ?? '',
    site: normalizeSite(params.get('site') ?? '') ?? '',
    after,
    before: after !== '' && before !== '' && before <= after ? '' : before,
    read: params.get('type') === 'read',
    dwell: Number.isInteger(dwell) && dwell > 0 && dwell <= DWELL_MAX_SECONDS ? dwell : 0,
    recent: params.get('sort') === 'recent',
  }
}

/** The search's path: only what is set. */
export function toUrl(state: SearchState): string {
  const params = new URLSearchParams()
  if (state.q.trim() !== '') params.set('q', state.q.trim())
  if (state.site !== '') params.set('site', state.site)
  if (state.after !== '') params.set('after', state.after)
  if (state.before !== '') params.set('before', state.before)
  if (state.read) params.set('type', 'read')
  if (state.dwell > 0) params.set('dwell', String(state.dwell))
  if (state.recent && hasWords(state)) params.set('sort', 'recent')
  const query = params.toString()
  return query === '' ? '/search' : `/search?${query}`
}

export function hasWords(state: SearchState): boolean {
  return state.q.trim() !== ''
}

export function hasRange(state: SearchState): boolean {
  return state.after !== '' || state.before !== ''
}

export type Filter = 'time' | 'site' | 'type' | 'dwell'

export const FILTERS: readonly Filter[] = ['time', 'site', 'type', 'dwell']

export const FILTER_NAMES: Readonly<Record<Filter, string>> = { time: '时间', site: '网站', type: '类型', dwell: '停留' }

/** The time chip's presets: the last n days, today included (近 7 天 is today and the six days before it). */
export const TIME_PRESETS: readonly (readonly [number, string])[] = [
  [1, '今天'],
  [7, '7 天'],
  [30, '30 天'],
]

/** The first day of a preset of the last `days` days, today included. */
export function presetStart(today: string, days: number): string {
  return addDays(today, 1 - days)
}

/** The 停留 chip's presets, in seconds (不限 is 0). */
export const DWELL_PRESETS: readonly (readonly [number, string])[] = [
  [0, '不限'],
  [30, '30 秒'],
  [120, '2 分'],
  [600, '10 分'],
]

/** The time range in words: `今天`, `近 7 天`, `10月9日`, `9月1日 至 9月30日`, `9月1日 起`, `至 9月30日`; null without one. */
function timeValue(state: SearchState, today: string, now: number): string | null {
  const { after, before } = state
  const date = (key: string) => dateText(dayStart(key), now)
  if (after === '' && before === '') return null
  if (before === '') {
    const preset = TIME_PRESETS.find(([days]) => presetStart(today, days) === after)
    if (preset !== undefined) return preset[0] === 1 ? '今天' : `近 ${preset[1]}`
    return `${date(after)} 起`
  }
  const last = addDays(before, -1)
  if (after === '') return `至 ${date(last)}`
  return after === last ? date(after) : `${date(after)} 至 ${date(last)}`
}

/** A set filter's value in words (`近 7 天`, `github.com`, `读过`, `≥ 2 分`); null when it is not set. */
export function filterValue(state: SearchState, filter: Filter, today: string, now: number): string | null {
  switch (filter) {
    case 'time':
      return timeValue(state, today, now)
    case 'site':
      return state.site === '' ? null : state.site
    case 'type':
      return state.read ? '读过' : null
    case 'dwell':
      return state.dwell === 0 ? null : `≥ ${duration(state.dwell)}`
  }
}

/** The state without one filter. */
export function clearFilter(state: SearchState, filter: Filter): SearchState {
  switch (filter) {
    case 'time':
      return { ...state, after: '', before: '' }
    case 'site':
      return { ...state, site: '' }
    case 'type':
      return { ...state, read: false }
    case 'dwell':
      return { ...state, dwell: 0 }
  }
}

const RELATIVE_DAYS: Readonly<Record<string, number>> = { 今天: 0, 昨天: -1, 前天: -2 }

/** A date an operator takes: `2026-10-01`, `2026/10/1`, or 今天, 昨天, 前天. */
function operatorDay(value: string, today: string): string | null {
  const relative = RELATIVE_DAYS[value.trim()]
  return relative === undefined ? parseDay(value) : addDays(today, relative)
}

/** One operator applied to the state (`today` reads 今天, 昨天 and 前天), or the hint line saying what it expects. */
export function applyOperator(state: SearchState, name: string, value: string, today: string): SearchState | string {
  switch (name) {
    case 'site': {
      const site = normalizeSite(value)
      return site === null ? 'site: 需要网站，如 site:github.com' : { ...state, site }
    }
    case 'after': {
      const day = operatorDay(value, today)
      if (day === null) return 'after: 需要日期，如 after:2026-10-01 或 after:昨天'
      return state.before !== '' && day >= state.before ? 'after: 要早于 before 的日期' : { ...state, after: day }
    }
    case 'before': {
      const day = operatorDay(value, today)
      if (day === null) return 'before: 需要日期，如 before:2026-10-01 或 before:今天'
      return state.after !== '' && day <= state.after ? 'before: 要晚于 after 的日期' : { ...state, before: day }
    }
    case 'type':
      return value.toLowerCase() === 'read' ? { ...state, read: true } : 'type: 只有 type:read（读过的页面）'
    case 'dwell': {
      const seconds = parseDwell(value)
      return seconds === null ? 'dwell: 需要时长，如 dwell:2m、30s、1h' : { ...state, dwell: seconds }
    }
    default:
      return state
  }
}

const OPERATOR = /^(site|after|before|type|dwell):(.*)$/i

export interface Taken {
  /** The box's text without the operators that became chips. */
  readonly text: string
  readonly state: SearchState
  /** What a typed operator that does not parse expects; '' when none. */
  readonly hint: string
}

/**
 * The operators typed into the box, taken out of it into the state. An operator is complete when a space follows it,
 * or on Enter (`final`); one inside double quotes is a word. One that does not parse stays as text, with its hint.
 */
export function takeOperators(text: string, state: SearchState, final: boolean, today: string): Taken {
  let next = state
  let hint = ''
  let out = ''
  let at = 0
  let quoted = false
  let start = -1
  const close = (end: number) => {
    const token = text.slice(start, end)
    const match = OPERATOR.exec(token)
    const complete = end < text.length || final
    const applied = match !== null && complete ? applyOperator(next, (match[1] ?? '').toLowerCase(), match[2] ?? '', today) : null
    if (typeof applied === 'string') {
      if (hint === '') hint = applied
    } else if (applied !== null) {
      next = applied
      out += text.slice(at, start)
      // The space after it goes too.
      at = end < text.length ? end + 1 : end
    }
    start = -1
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    if (start === -1 && !/\s/u.test(char)) {
      start = i
      quoted = false
    }
    if (start === -1) continue
    if (char === '"') quoted = !quoted
    else if (/\s/u.test(char) && !quoted) close(i)
  }
  if (start !== -1 && !quoted) close(text.length)
  out += text.slice(at)
  return { text: out, state: next, hint }
}

/** The request of a search: its fields from the state (without words and filters, the pages read lately). */
export function searchRequest(state: SearchState, pageToken: string): MessageInitShape<typeof SearchPagesRequestSchema> {
  const plain = !hasWords(state) && !hasRange(state) && state.site === '' && !state.read && state.dwell === 0
  return {
    query: state.q.trim(),
    ...(state.after === '' ? {} : { startTime: timestampFromMs(dayStart(state.after)) }),
    ...(state.before === '' ? {} : { endTime: timestampFromMs(dayStart(state.before)) }),
    site: state.site,
    pageType: state.read || plain ? PageType.READ : PageType.UNSPECIFIED,
    minFocusSeconds: state.dwell,
    sortOrder: state.recent && hasWords(state) ? SortOrder.RECENT : SortOrder.UNSPECIFIED,
    pageToken,
  }
}
