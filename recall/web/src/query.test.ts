/**
 * The search's state on its own (query.ts): every operator and its hint, operators inside quotes, the URL both ways,
 * the chips' words, local days, and the request the server gets (its times are the owner's local midnights).
 */
import { timestampMs } from '@ziyixi/proto/protobuf/wkt'
import { PageType, SortOrder } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb'
import { addDays, dayStart, parseDay } from './day.ts'
import { EMPTY_SEARCH, filterValue, fromUrl, normalizeSite, parseDwell, searchRequest, takeOperators, toUrl } from './query.ts'
import { NOW } from './test/fakeServer.ts'

const TODAY = '2026-10-09'

describe('operators', () => {
  it('takes each complete operator out of the box into the state, keeping the words', () => {
    const taken = takeOperators('durable site:GitHub.com after:2026-09-01 before:2026/10/01 type:read dwell:2m alarm', EMPTY_SEARCH, false, TODAY)
    expect(taken.text).toBe('durable alarm')
    expect(taken.state).toEqual({ ...EMPTY_SEARCH, site: 'github.com', after: '2026-09-01', before: '2026-10-01', read: true, dwell: 120 })
    expect(taken.hint).toBe('')
  })

  it('waits for a space or Enter before taking the last one', () => {
    expect(takeOperators('site:github.com', EMPTY_SEARCH, false, TODAY)).toEqual({ text: 'site:github.com', state: EMPTY_SEARCH, hint: '' })
    expect(takeOperators('冷启动 site:github.com', EMPTY_SEARCH, true, TODAY)).toEqual({ text: '冷启动 ', state: { ...EMPTY_SEARCH, site: 'github.com' }, hint: '' })
  })

  it('leaves an operator inside quotes as words', () => {
    const taken = takeOperators('"see site:x.com here" ', EMPTY_SEARCH, false, TODAY)
    expect(taken.text).toBe('"see site:x.com here" ')
    expect(taken.state).toBe(EMPTY_SEARCH)
  })

  it('keeps an operator that does not parse as text, with one hint saying what it expects', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['after:2026-13-01 ', 'after: 需要日期，如 after:2026-10-01 或 after:昨天'],
      ['before:yesterday ', 'before: 需要日期，如 before:2026-10-01 或 before:今天'],
      ['site:-not.a.host ', 'site: 需要网站，如 site:github.com'],
      ['type:video ', 'type: 只有 type:read（读过的页面）'],
      ['dwell:soon ', 'dwell: 需要时长，如 dwell:2m、30s、1h'],
      ['dwell:2d ', 'dwell: 需要时长，如 dwell:2m、30s、1h'],
    ]
    for (const [text, hint] of cases) {
      const taken = takeOperators(text, EMPTY_SEARCH, false, TODAY)
      expect(taken.text).toBe(text)
      expect(taken.state).toBe(EMPTY_SEARCH)
      expect(taken.hint).toBe(hint)
    }
  })

  it('reads 今天, 昨天 and 前天 as dates, and a host with an underscore as a site', () => {
    expect(takeOperators('after:昨天 before:今天 ', EMPTY_SEARCH, false, TODAY).state).toEqual({ ...EMPTY_SEARCH, after: '2026-10-08', before: '2026-10-09' })
    expect(takeOperators('after:前天 ', EMPTY_SEARCH, false, TODAY).state.after).toBe('2026-10-07')
    expect(takeOperators('site:my_team.example.com ', EMPTY_SEARCH, false, TODAY).state.site).toBe('my_team.example.com')
  })

  it('refuses a range that ends before it starts', () => {
    expect(takeOperators('after:2026-10-01 before:2026-09-01 ', EMPTY_SEARCH, false, TODAY).hint).toBe('before: 要晚于 after 的日期')
    expect(takeOperators('after:2026-10-05 ', { ...EMPTY_SEARCH, before: '2026-10-05' }, false, TODAY).hint).toBe('after: 要早于 before 的日期')
  })

  it('reads dates, sites and durations as the API needs them', () => {
    expect(parseDay('2026/9/1')).toBe('2026-09-01')
    expect(parseDay('2026-02-30')).toBeNull()
    expect(normalizeSite('https://www.Example.com:8443/a?b#c')).toBe('example.com')
    expect(normalizeSite('exa mple.com')).toBeNull()
    expect([parseDwell('30s'), parseDwell('2m'), parseDwell('1H'), parseDwell('0m'), parseDwell('25h')]).toEqual([30, 120, 3600, null, null])
  })
})

describe('the URL and the chips', () => {
  it('writes only what is set and reads it back; a bad value is dropped', () => {
    const state = { q: '冷启动 优化', site: 'github.com', after: '2026-09-01', before: '2026-10-01', read: true, dwell: 120, recent: true }
    const url = toUrl(state)
    expect(url).toBe('/search?q=%E5%86%B7%E5%90%AF%E5%8A%A8+%E4%BC%98%E5%8C%96&site=github.com&after=2026-09-01&before=2026-10-01&type=read&dwell=120&sort=recent')
    expect(fromUrl(new URL(url, 'https://recall.ziyixi.science').searchParams)).toEqual(state)
    expect(toUrl({ ...EMPTY_SEARCH, recent: true })).toBe('/search')
    expect(fromUrl(new URLSearchParams('after=2026-10-05&before=2026-10-01&dwell=-3&type=all&site=%20'))).toEqual({ ...EMPTY_SEARCH, after: '2026-10-05' })
  })

  it('names a set filter by its value', () => {
    const value = (state: Partial<typeof EMPTY_SEARCH>, filter: Parameters<typeof filterValue>[1]) => filterValue({ ...EMPTY_SEARCH, ...state }, filter, TODAY, NOW)
    expect(value({}, 'time')).toBeNull()
    expect(value({ after: TODAY }, 'time')).toBe('今天')
    // 近 7 天 is today and the six days before it.
    expect(value({ after: addDays(TODAY, -6) }, 'time')).toBe('近 7 天')
    expect(value({ after: addDays(TODAY, -29) }, 'time')).toBe('近 30 天')
    expect(value({ after: addDays(TODAY, -7) }, 'time')).toBe('10月2日 起')
    expect(value({ after: '2026-09-01' }, 'time')).toBe('9月1日 起')
    expect(value({ before: '2026-10-01' }, 'time')).toBe('至 9月30日')
    expect(value({ after: '2026-10-08', before: '2026-10-09' }, 'time')).toBe('10月8日')
    expect(value({ after: '2025-03-01', before: '2025-03-08' }, 'time')).toBe('2025年3月1日 至 2025年3月7日')
    expect(value({ site: 'github.com' }, 'site')).toBe('github.com')
    expect(value({ read: true }, 'type')).toBe('读过')
    expect(value({ dwell: 120 }, 'dwell')).toBe('≥ 2 分')
    expect(value({ dwell: 30 }, 'dwell')).toBe('≥ 30 秒')
  })
})

describe('the request', () => {
  it('turns local days into their midnights and the chips into typed fields', () => {
    const request = searchRequest({ q: ' durable ', site: 'github.com', after: '2026-09-01', before: '2026-10-01', read: true, dwell: 120, recent: true }, 'token')
    expect(request.query).toBe('durable')
    expect(timestampMs(request.startTime as never)).toBe(Date.parse('2026-08-31T16:00:00Z'))
    expect(timestampMs(request.endTime as never)).toBe(dayStart('2026-10-01'))
    expect([request.site, request.pageType, request.minFocusSeconds, request.sortOrder, request.pageToken]).toEqual(['github.com', PageType.READ, 120, SortOrder.RECENT, 'token'])
  })

  it('without words or chips asks for the pages read lately; 最新 needs words', () => {
    expect(searchRequest(EMPTY_SEARCH, '').pageType).toBe(PageType.READ)
    expect(searchRequest({ ...EMPTY_SEARCH, site: 'a.com' }, '').pageType).toBe(PageType.UNSPECIFIED)
    expect(searchRequest({ ...EMPTY_SEARCH, recent: true }, '').sortOrder).toBe(SortOrder.UNSPECIFIED)
  })
})
