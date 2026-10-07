/**
 * The UI's words for the API's values: modes, review kinds, unsure reasons, rule kinds, and times in the browser's
 * zone.
 */
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { ReviewItem_Kind } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Rule_Kind } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { Mode } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'

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

/** The kinds a review row names (a suggestion is the plain case and carries no chip). */
export const KIND_NAMES: Readonly<Record<number, string>> = {
  [ReviewItem_Kind.UNSURE]: '拿不准',
  [ReviewItem_Kind.AUDIT]: '抽查',
}

export const UNSURE_REASONS: Readonly<Record<string, string>> = {
  below_threshold: '把握不够',
  none: '都不像',
  suspicious: '疑似钓鱼',
  trust_needs_rule: '可信类只能由规则打',
  label_disabled: '标签未启用',
  model_unavailable: '模型暂不可用',
  no_labels: '还没有启用的标签',
  no_model_labels: '没有带说明的标签',
}

/** A rule's kind in one word (标签's rule lines and 添加规则). */
export const RULE_KIND_NAMES: Readonly<Record<number, string>> = {
  [Rule_Kind.SENDER_ADDRESS]: '发件人',
  [Rule_Kind.SENDER_DOMAIN]: '域名',
  [Rule_Kind.LIST_ID]: '列表',
  [Rule_Kind.DELIVERED_TO]: '收件地址',
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
