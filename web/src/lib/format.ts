/** The first UUID group; enough to recognise an event and to type as a confirmation. */
export function shortId(eventId: string): string {
  return eventId.slice(0, 8).toLowerCase()
}

const number = new Intl.NumberFormat('zh-CN')
export function formatNumber(value: number): string {
  return number.format(value)
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
