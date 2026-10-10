/**
 * The UI's words for times, durations and counts, in the browser's zone (../../docs/design.md §8.4-§8.7): `10月9日 周四`,
 * `今天 14:20`, `28 分`, `4 小时 12 分`, `3 分钟前`.
 */
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { dayKey } from './day.ts'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (n: number) => String(n).padStart(2, '0')

export function ms(time: Timestamp | undefined): number | null {
  return time === undefined ? null : timestampMs(time)
}

/** `10月9日`, with the year when it is another year than now's: `2025年3月1日`. */
export function dateText(at: number, now: number): string {
  const date = new Date(at)
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `${String(date.getFullYear())}年`
  return `${year}${String(date.getMonth() + 1)}月${String(date.getDate())}日`
}

/** A day as the day bar names it: `10月9日 周四`. */
export function dayTitle(at: number, now: number): string {
  return `${dateText(at, now)} ${WEEKDAYS[new Date(at).getDay()] ?? ''}`
}

/** `09:12`. */
export function clock(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `今天 14:20` for a time today, else its date. */
export function shortWhen(at: number, now: number): string {
  return dayKey(at) === dayKey(now) ? `今天 ${clock(at)}` : dateText(at, now)
}

/** `2025年3月`. */
export function monthText(at: number): string {
  const date = new Date(at)
  return `${String(date.getFullYear())}年${String(date.getMonth() + 1)}月`
}

/** Seconds of focus: `20 秒`, `28 分`, `4 小时 12 分`, `2 小时`. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${String(Math.max(0, Math.round(seconds)))} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分`
  const rest = minutes % 60
  return `${String(Math.floor(minutes / 60))} 小时${rest === 0 ? '' : ` ${String(rest)} 分`}`
}

/** A length of time in words: `3 分钟`, `5 小时`, `2 天` (at least a minute). */
export function span(lengthMs: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(lengthMs) / 60_000))
  if (minutes < 60) return `${String(minutes)} 分钟`
  if (minutes < 48 * 60) return `${String(Math.round(minutes / 60))} 小时`
  return `${String(Math.round(minutes / 1440))} 天`
}

/** `3 分钟前`; within a minute, 刚刚. */
export function ago(at: number, now: number): string {
  return now - at < 60_000 ? '刚刚' : `${span(now - at)}前`
}

/** A count with thousands separators: `20,000`. */
export function count(value: number): string {
  return value.toLocaleString('en-US')
}

/** A KPI's count in at most five characters, for a third of a phone: `9,876`, `22.0 万`, `120 万`. */
export function compact(value: number): string {
  if (value < 10_000) return count(value)
  return `${(value / 10_000).toFixed(value < 1_000_000 ? 1 : 0)} 万`
}
