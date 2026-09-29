/** The first UUID group; enough to recognise an event and to type as a confirmation. */
export function shortId(eventId: string): string {
  return eventId.slice(0, 8).toLowerCase()
}

const number = new Intl.NumberFormat('zh-CN')
export function formatNumber(value: number): string {
  return number.format(value)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']
/** A byte count in binary units with at most one decimal, e.g. 1.8 MB. */
export function formatBytes(value: number): string {
  let size = value
  let unit = 0
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? size : Math.round(size * 10) / 10} ${BYTE_UNITS[unit]}`
}

const sameYear = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const otherYear = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const full = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long' })

/** A timestamp in the browser's time zone; the year only when it is not the current one. */
export function formatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  return (date.getFullYear() === now.getFullYear() ? sameYear : otherYear).format(date)
}

export function formatFullTime(iso: string): string {
  return full.format(new Date(iso))
}

const relative = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** "3 小时前" / "12 分钟后"; under a minute reads as "现在". */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit)
  }
  return '现在'
}

export function todoistTaskUrl(taskId: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(taskId)}`
}

/** Today's UTC day as YYYY-MM-DD, the key of reminder rows. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
/** Axis labels: "40万" rather than "400,000". */
export function formatCompact(value: number): string {
  return compact.format(value)
}

/** A wait in seconds, in the largest unit that keeps it readable. */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} 秒`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

/** A UTC day (YYYY-MM-DD) as "9/27" for chart axes. */
export function shortDay(day: string): string {
  const [, month, date] = day.split('-')
  return `${Number(month)}/${Number(date)}`
}
