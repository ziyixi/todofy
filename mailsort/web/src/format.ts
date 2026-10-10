/**
 * The UI's words for the API's values: modes, uncertain reasons, and times in the browser's zone.
 */
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'

export const MODE_NAMES: Readonly<Record<number, string>> = {
  [Mode.OFF]: '关闭',
  [Mode.SHADOW]: '影子',
  [Mode.LIVE]: '正式',
}

/** Why the breaker tripped (Settings.breaker_reason). */
export const BREAKER_REASONS: Readonly<Record<string, string>> = {
  daily_limit: '超过每天写入上限',
  run_limit: '超过每次运行写入上限',
  label_share: '某个标签占比突增',
}

/** Why the model was uncertain (ReviewItem.reason). */
export const UNSURE_REASONS: Readonly<Record<string, string>> = {
  low_confidence: '把握不够',
  views_disagree: '两次判断不一致',
  suspicious: '疑似钓鱼',
  untrusted_sender: '发件人还不可信',
  model_unavailable: '模型暂不可用',
}

export function ms(time: Timestamp | undefined): number | null {
  return time === undefined ? null : timestampMs(time)
}

/** A time in the browser's zone, `10-01 16:05`. */
export function when(time: Timestamp | undefined): string {
  const value = ms(time)
  if (value === null) return '—'
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `3 分钟前`, `2 小时后`; within a minute, 刚刚 before and 马上 after. */
export function relative(time: Timestamp | undefined, now: number): string {
  const value = ms(time)
  if (value === null) return '—'
  const minutes = Math.round((value - now) / 60_000)
  const size = Math.abs(minutes)
  if (size < 1) return value > now ? '马上' : '刚刚'
  const text = size < 60 ? `${String(size)} 分钟` : size < 48 * 60 ? `${String(Math.round(size / 60))} 小时` : `${String(Math.round(size / 1440))} 天`
  return minutes < 0 ? `${text}前` : `${text}后`
}

export function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/** labels/x -> the label's display name (or the ID when unknown); '' -> 都不是. */
export function labelText(name: string, labels: readonly Label[]): string {
  if (name === '') return '都不是'
  return labels.find((label) => label.name === name)?.displayName ?? name.replace(/^labels\//, '')
}
