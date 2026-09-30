/**
 * Formatting in the browser's locale-independent Chinese style. Times use the browser's time zone
 * (Intl without an explicit timeZone); the API sends RFC 3339 UTC.
 */
import type { QuotaUnit } from '../../../worker/src/api-types.ts'

/** The browser's IANA time zone, shown once on the page so every time is unambiguous. */
export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'
}

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
export function formatNumber(value: number): string {
  return number.format(value)
}

/** One decimal at most, e.g. 81.5%. */
export function formatPercent(value: number): string {
  return `${number.format(Math.round(value * 10) / 10)}%`
}

const DECIMAL_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
/** Decimal units (10^3), as Cloudflare states its storage allowances. */
export function formatBytesDecimal(value: number): string {
  let size = value
  let unit = 0
  while (size >= 1000 && unit < DECIMAL_UNITS.length - 1) {
    size /= 1000
    unit += 1
  }
  return `${unit === 0 ? size : Math.round(size * 100) / 100} ${DECIMAL_UNITS[unit]}`
}

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
/** Binary units (2^10), as the apps count their own capacity. */
export function formatBytesBinary(value: number): string {
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BINARY_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? size : Math.round(size * 10) / 10} ${BINARY_UNITS[unit]}`
}

/** A quota amount in its unit, e.g. "12,345 次", "1.2 GB", "310.5 GB·s". */
export function formatQuantity(value: number, unit: QuotaUnit): string {
  switch (unit) {
    case 'bytes':
      return formatBytesDecimal(value)
    case 'gb_seconds':
      return `${formatNumber(value)} GB·s`
    case 'rows':
      return `${formatNumber(Math.round(value))} 行`
    case 'requests':
    case 'operations':
      return `${formatNumber(Math.round(value))} 次`
  }
}

const sameYear = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const otherYear = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const full = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
})

/** "9月29日 16:05" in the browser's time zone; the year only when it is not the current one. */
export function formatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  return (date.getFullYear() === now.getFullYear() ? sameYear : otherYear).format(date)
}

/** "16:05" in the browser's time zone. */
export function formatClock(iso: string): string {
  return clock.format(new Date(iso))
}

const clockSeconds = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** "16:05:30" in the browser's time zone. */
export function formatClockSeconds(iso: string): string {
  return clockSeconds.format(new Date(iso))
}

/** Full timestamp with seconds and zone, for title attributes and screen readers. */
export function formatFullTime(iso: string): string {
  return full.format(new Date(iso))
}

const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "3 小时前" / "12 分钟后"; under a minute reads as "刚刚". */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit)
  }
  return '刚刚'
}

/** A duration in words: "42 秒", "3 分钟", "1 小时 5 分钟", "2 天 3 小时". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`
}

/** Milliseconds between two ISO timestamps, or null when either is missing. */
export function between(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  return new Date(to).getTime() - new Date(from).getTime()
}

/** The UTC day (YYYY-MM-DD) of an instant; canary days and manual-run limits count by it. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** "16:00 UTC（本地 00:00）": a fixed UTC hour of the day with its local clock time in the browser's zone. */
export function utcHourWithLocal(hourUtc: number, now: Date): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc))
  const utc = `${String(hourUtc).padStart(2, '0')}:00 UTC`
  return at.getTimezoneOffset() === 0 ? utc : `${utc}（本地 ${formatClock(at.toISOString())}）`
}
