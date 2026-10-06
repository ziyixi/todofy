/**
 * The UI's words for the API's values: modes, review kinds, unsure reasons, rule kinds, ledger states, and times in the
 * browser's zone.
 */
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { ReviewItem_Kind, LedgerEntry_State, Example_Origin } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Rule_Kind, Rule_State } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { Mode, ServiceStatus_AuthState } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'

export const MODE_NAMES: Readonly<Record<number, string>> = {
  [Mode.OFF]: '关闭',
  [Mode.SHADOW]: '只给建议（影子）',
  [Mode.LIVE]: '正式打标签',
}

/** Why the breaker tripped (Settings.breaker_reason). */
export const BREAKER_REASONS: Readonly<Record<string, string>> = {
  daily_limit: '超过每天写入上限',
  run_limit: '超过每次运行写入上限',
  label_share: '某个标签占比突增',
}

export const KIND_NAMES: Readonly<Record<number, string>> = {
  [ReviewItem_Kind.SUGGESTION]: '建议',
  [ReviewItem_Kind.UNSURE]: '拿不准',
  [ReviewItem_Kind.AUDIT]: '抽查',
}

export const UNSURE_REASONS: Readonly<Record<string, string>> = {
  below_threshold: '概率低于阈值',
  none: '都不像',
  suspicious: '疑似钓鱼',
  trust_needs_rule: '可信类标签只能由规则打',
  label_disabled: '标签未启用',
  model_unavailable: '模型暂时不可用',
  no_labels: '还没有启用的标签',
  no_model_labels: '没有带说明的标签可交给模型',
}

export const DECIDERS: Readonly<Record<string, string>> = {
  rule: '规则',
  neighbours: '相似例子',
  clef: 'Clef',
  'clef-flash': 'Clef-flash',
  audit: '抽查',
  none: '—',
}

export const RULE_KINDS: readonly (readonly [Rule_Kind, string])[] = [
  [Rule_Kind.SENDER_ADDRESS, '发件人地址'],
  [Rule_Kind.SENDER_DOMAIN, '发件人域名'],
  [Rule_Kind.LIST_ID, '邮件列表 (List-Id)'],
  [Rule_Kind.DELIVERED_TO, '收件地址 (Delivered-To)'],
]

export const RULE_STATES: Readonly<Record<number, string>> = {
  [Rule_State.PROPOSED]: '待批准',
  [Rule_State.ACTIVE]: '生效中',
  [Rule_State.DISABLED]: '已停用',
}

export const LEDGER_STATES: Readonly<Record<number, string>> = {
  [LedgerEntry_State.INTENDED]: '待写入',
  [LedgerEntry_State.APPLIED]: '已打标签',
  [LedgerEntry_State.FAILED]: '失败',
  [LedgerEntry_State.UNDONE]: '已撤销',
}

export const ORIGINS: Readonly<Record<number, string>> = {
  [Example_Origin.CORRECTION]: '纠正',
  [Example_Origin.CONFIRMATION]: '确认',
  [Example_Origin.WEAK_ACCEPT]: '默认接受',
}

export const AUTH_STATES: Readonly<Record<number, string>> = {
  [ServiceStatus_AuthState.NOT_CONFIGURED]: '未授权（需运行 mint-token）',
  [ServiceStatus_AuthState.OK]: '正常',
  [ServiceStatus_AuthState.FAILED]: '授权失效，已停止访问 Gmail',
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

/** `3 分钟前`, `2 小时后`. */
export function relative(time: Timestamp | undefined, now: number): string {
  const value = ms(time)
  if (value === null) return '—'
  const minutes = Math.round((value - now) / 60_000)
  const size = Math.abs(minutes)
  const text = size < 1 ? '刚刚' : size < 60 ? `${String(size)} 分钟` : size < 48 * 60 ? `${String(Math.round(size / 60))} 小时` : `${String(Math.round(size / 1440))} 天`
  return size < 1 ? text : minutes < 0 ? `${text}前` : `${text}后`
}

export function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`
}

/** labels/x -> the label's display name (or the ID when unknown); '' -> 都不是. */
export function labelText(name: string, labels: readonly Label[]): string {
  if (name === '') return '都不是'
  return labels.find((label) => label.name === name)?.displayName ?? name.replace(/^labels\//, '')
}
