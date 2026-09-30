import { card } from '../test/fixtures'
import { cardBrief, formatAuthors, formatDay, formatWhen, parentTitle, safeArxivUrl, sendPreview, shortTitle } from './format'

describe('format', () => {
  it('shortens long author lists', () => {
    expect(formatAuthors('A. One, B. Two')).toBe('A. One, B. Two')
    expect(formatAuthors('A. One, B. Two, C. Three, D. Four, E. Five, F. Six, G. Seven')).toBe('A. One, B. Two 等 7 人')
  })

  it('shows deck days as written and times in the browser zone (Asia/Shanghai in tests)', () => {
    expect(formatDay('2026-09-29')).toBe('9月29日')
    const now = new Date('2026-09-30T12:00:00Z') // 20:00 in Shanghai
    expect(formatWhen('2026-09-30T14:30:00Z', now)).toBe('今晚 22:30')
    expect(formatWhen('2026-09-30T01:10:00Z', now)).toBe('今天 09:10')
    expect(formatWhen('2026-10-01T06:30:00Z', now)).toBe('明天 14:30')
    expect(formatWhen('2026-10-03T06:30:00Z', now)).toBe('10月3日 14:30')
    expect(formatWhen('not a date', now)).toBe('')
  })

  it('uses the 简介, or the first two abstract sentences when it is missing', () => {
    expect(cardBrief(card(1))).toEqual({ text: expect.stringContaining('合成论文') as string, generated: true })
    expect(cardBrief(card(2, { brief: null }))).toEqual({
      text: 'We study synthetic problem 2. Our method improves a made-up metric.',
      generated: false,
    })
  })

  it('previews both send modes and the 补发 title', () => {
    expect(sendPreview('subtasks', '2026-09-30', 5)).toBe('将在 Todoist 创建「论文雷达 2026-09-30 · 5 篇」和 5 个子任务')
    expect(sendPreview('separate', '2026-09-30', 5)).toBe('将在 Todoist 创建 5 个任务')
    expect(sendPreview('subtasks', '2026-09-30', 0)).toBe('没有要发送的论文')
    expect(parentTitle('2026-09-30', 2, 2)).toBe('论文雷达 2026-09-30（补发）· 2 篇')
  })

  it('shortens titles by code point', () => {
    expect(shortTitle('短标题')).toBe('短标题')
    expect(shortTitle('A'.repeat(30), 10)).toBe(`${'A'.repeat(10)}…`)
  })

  it('lets only https arxiv.org links through', () => {
    const base = ['https:', '', 'arxiv.org'].join('/')
    expect(safeArxivUrl(`${base}/abs/2609.10001`)).toBe(`${base}/abs/2609.10001`)
    expect(safeArxivUrl(`${base.replace('https', 'http')}/abs/1`)).toBeNull()
    expect(safeArxivUrl(['https:', '', 'arxiv.org.example.com', 'abs'].join('/'))).toBeNull()
    expect(safeArxivUrl('javascript:alert(1)')).toBeNull()
  })
})
