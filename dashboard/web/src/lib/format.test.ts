import {
  browserTimeZone,
  formatBytesBinary,
  formatBytesDecimal,
  formatClock,
  formatDuration,
  formatPercent,
  formatQuantity,
  formatRelative,
  formatTime,
} from './format'
import { httpsUrl } from './url'

const now = new Date('2026-09-29T17:00:00.000Z')

describe('format', () => {
  it('uses the browser time zone (Asia/Shanghai in tests)', () => {
    expect(browserTimeZone()).toBe('Asia/Shanghai')
    expect(formatTime('2026-09-29T16:30:00.000Z', now)).toBe('9月30日 00:30')
    // 16:00 UTC on 12-31 is already 2026-01-01 in Shanghai: the current year, so no year is shown.
    expect(formatTime('2025-12-31T16:00:00Z', now)).toBe('1月1日 00:00')
    expect(formatTime('2025-12-31T15:00:00Z', now)).toBe('2025年12月31日 23:00')
    expect(formatClock('2026-09-29T16:05:00Z')).toBe('00:05')
  })

  it('formats relative times and durations in words', () => {
    expect(formatRelative('2026-09-29T16:30:00Z', now)).toBe('30分钟前')
    expect(formatRelative('2026-09-29T19:00:00Z', now)).toBe('2小时后')
    expect(formatRelative('2026-09-29T16:59:40Z', now)).toBe('刚刚')
    expect(formatDuration(42_000)).toBe('42 秒')
    expect(formatDuration(3 * 60_000)).toBe('3 分钟')
    expect(formatDuration(65 * 60_000)).toBe('1 小时 5 分钟')
    expect(formatDuration(2 * 3600_000)).toBe('2 小时')
    expect(formatDuration(51 * 3600_000)).toBe('2 天 3 小时')
  })

  it('formats quota amounts in their units', () => {
    expect(formatQuantity(12345, 'requests')).toBe('12,345 次')
    expect(formatQuantity(4_200_000, 'rows')).toBe('4,200,000 行')
    expect(formatQuantity(410.54, 'gb_seconds')).toBe('410.5 GB·s')
    expect(formatQuantity(5_000_000_000, 'bytes')).toBe('5 GB')
    expect(formatBytesDecimal(999)).toBe('999 B')
    expect(formatBytesDecimal(1_300_000_000)).toBe('1.3 GB')
    expect(formatBytesBinary(5_368_709_120)).toBe('5 GiB')
    expect(formatPercent(81.54)).toBe('81.5%')
  })

  it('links only https URLs', () => {
    expect(httpsUrl('https://mail.example.com/')).toBe('https://mail.example.com/')
    expect(httpsUrl('http://mail.example.com/')).toBeNull()
    expect(httpsUrl('javascript:alert(1)')).toBeNull()
    expect(httpsUrl('/relative')).toBeNull()
    expect(httpsUrl(null)).toBeNull()
  })
})
