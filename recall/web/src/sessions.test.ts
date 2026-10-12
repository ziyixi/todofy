/**
 * A timeline day's arithmetic on its own (sessions.ts, marks.ts): spans cut to the day, their union, the focus per
 * hour, sessions with their five-minute gaps, the sites' colors with borrowing, and the query's words marked.
 */
import { highlightWords, markRanges, splitTerms } from './marks.ts'
import { daySpans, homeSlot, hourSeconds, sessions, siteSlots, unionSeconds } from './sessions.ts'
import { at, visit } from './test/fakeServer.ts'

const DAY = '2026-10-09'
const start = at('2026-10-09 00:00')
const end = at('2026-10-10 00:00')

describe('a day of spans', () => {
  it('cuts spans to the day and counts two devices at once only once', () => {
    const spans = daySpans(
      [
        visit('late', [['2026-10-08 23:50', '2026-10-09 00:20']]),
        visit('a', [['09:00', '09:30']]),
        visit('b', [['09:20', '09:40']], { deviceLabel: 'iPad' }),
      ],
      start,
      end,
    )
    expect(spans.map((span) => [span.start, span.end])).toEqual([
      [start, at('2026-10-09 00:20')],
      [at('2026-10-09 09:00'), at('2026-10-09 09:30')],
      [at('2026-10-09 09:20'), at('2026-10-09 09:40')],
    ])
    expect(unionSeconds(spans)).toBe((20 + 40) * 60)
    const hours = hourSeconds(spans, DAY)
    expect(hours[0]).toBe(20 * 60)
    expect(hours[9]).toBe(40 * 60)
    expect(hours.reduce((sum, value) => sum + value, 0)).toBe(60 * 60)
  })

  it('keeps simultaneous devices separate while joining each device’s own consecutive visits', () => {
    const spans = daySpans([
      visit('desktop-a', [['09:00', '09:10']], { deviceId: 'mac', deviceLabel: 'Mac' }),
      visit('phone', [['09:02', '09:08']], { deviceId: 'phone', deviceLabel: 'iPhone' }),
      visit('desktop-b', [['09:12', '09:20']], { deviceId: 'mac', deviceLabel: 'Mac' }),
    ], start, end)
    expect(sessions(spans).map((session) => [session.deviceLabel, session.seconds, session.pages.length])).toEqual([
      ['Mac', 18 * 60, 2], ['iPhone', 6 * 60, 1],
    ])
    expect(unionSeconds(spans)).toBe(18 * 60)
  })

  it('splits a span that crosses an hour', () => {
    const hours = hourSeconds(daySpans([visit('a', [['10:50', '11:20']])], start, end), DAY)
    expect([hours[10], hours[11]]).toEqual([600, 1200])
  })

  it('makes sessions of consecutive focus on one site, merging gaps of up to five minutes', () => {
    const all = sessions(
      daySpans(
        [
          visit('a', [['09:00', '09:10']], { site: 'github.com' }),
          visit('b', [['09:14', '09:20']], { site: 'github.com', title: 'PR' }),
          visit('c', [['09:30', '09:40']], { site: 'github.com' }),
          visit('d', [['09:41', '09:42']], { site: 'news.example' }),
          visit('a', [['09:43', '09:50']], { site: 'github.com' }),
        ],
        start,
        end,
      ),
    )
    expect(all.map((session) => [session.site, session.seconds, session.pages.length])).toEqual([
      ['github.com', 16 * 60, 2],
      ['github.com', 10 * 60, 1],
      ['news.example', 60, 1],
      ['github.com', 7 * 60, 1],
    ])
    expect(all[0]?.pages.map((page) => [page.title, page.seconds])).toEqual([
      ['页面 a', 600],
      ['PR', 360],
    ])
  })
})

describe('site colors', () => {
  it('keeps a site its own slot; the less focused of two wanting one borrows a free one; past eight, muted', () => {
    // Synthetic hosts whose home slots collide.
    const hosts = Array.from({ length: 40 }, (_, i) => `site${String(i)}.example`)
    const first = hosts[0] ?? ''
    const twin = hosts.find((host) => host !== first && homeSlot(host) === homeSlot(first)) ?? ''
    const slots = siteSlots(new Map([[first, 100], [twin, 50]]))
    expect(slots.get(first)).toBe(homeSlot(first))
    expect(slots.get(twin)).not.toBe(homeSlot(first))
    expect(slots.get(twin)).toBeGreaterThan(0)
    const many = siteSlots(new Map(hosts.slice(0, 10).map((host, i) => [host, 100 - i])))
    expect(new Set(hosts.slice(0, 8).map((host) => many.get(host))).size).toBe(8)
    expect(hosts.slice(8, 10).map((host) => many.get(host))).toEqual([0, 0])
  })
})

describe('marked words', () => {
  it('splits terms as the Worker does and drops what the index cannot find', () => {
    expect(splitTerms('durable  "冷启动 优化" alarm')).toEqual(['durable', '冷启动 优化', 'alarm'])
    expect(highlightWords('数 "冷启动 优化" D1')).toEqual(['冷启动', '优化', 'd1'])
  })

  it('finds words ignoring case and width, longest first, without overlaps', () => {
    const text = 'Ｄurable Objects: durable alarms'
    expect(markRanges(text, highlightWords('durable dur')).map(([from, to]) => text.slice(from, to))).toEqual(['Ｄurable', 'durable'])
  })
})
