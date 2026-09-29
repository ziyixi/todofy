import { describe, expect, it } from 'vitest'
import { formatCompact, formatDuration, formatRelative, shortDay, shortId, todoistTaskUrl, utcDay } from './format'

describe('format', () => {
  it('shortens event IDs to the lowercase first group', () => {
    expect(shortId('F8C1E9A0-1A98-4FB8-8CA1-4C0A3E710001')).toBe('f8c1e9a0')
  })

  it('formats relative times in Chinese', () => {
    const now = new Date('2026-09-28T12:00:00Z')
    expect(formatRelative('2026-09-28T09:00:00Z', now)).toBe('3小时前')
    expect(formatRelative('2026-09-28T12:12:00Z', now)).toBe('12分钟后')
    expect(formatRelative('2026-09-28T12:00:20Z', now)).toBe('现在')
  })

  it('builds Todoist links and UTC days', () => {
    expect(todoistTaskUrl('6X7rM8997g3RQmvh')).toBe('https://app.todoist.com/app/task/6X7rM8997g3RQmvh')
    expect(utcDay(new Date('2026-09-28T23:59:59-07:00'))).toBe('2026-09-29')
  })

  it('formats chart values: durations, compact counts and short days', () => {
    expect(formatDuration(42)).toBe('42 秒')
    expect(formatDuration(600)).toBe('10 分钟')
    expect(formatDuration(3 * 3600)).toBe('3.0 小时')
    expect(formatCompact(400_000)).toBe('40万')
    expect(shortDay('2026-09-07')).toBe('9/7')
  })
})
