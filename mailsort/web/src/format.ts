/**
 * The UI's words for the API's values: modes, uncertain reasons, and times in the browser's zone.
 */
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { ClassificationProvider, Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'

export const MODE_NAMES: Readonly<Record<number, string>> = {
  [Mode.OFF]: '关闭',
  [Mode.SHADOW]: '影子',
  [Mode.LIVE]: '正式',
}

/** What each mode does, in one line (设置, 概览's status line). */
export const MODE_HINTS: Readonly<Record<number, string>> = {
  [Mode.OFF]: '不读 Gmail，也不判断',
  [Mode.SHADOW]: '只判断和记录，不改 Gmail',
  [Mode.LIVE]: '按 P1、P2、P3、P4 分级；P1 留在收件箱，P2、P3、P4 归档，未读状态不变',
}

/** Why the model was uncertain (ReviewItem.reason). */
export const UNSURE_REASONS: Readonly<Record<string, string>> = {
  low_confidence: '把握不够',
  views_disagree: '两次判断不一致',
  suspicious: '旧分级记录',
  untrusted_sender: '旧分级记录',
  model_unavailable: '模型暂不可用',
}

/** Safe provider error codes; these describe the last attempt, not a new classification. */
const CLAUDE_ERRORS: Readonly<Record<string, string>> = {
  claude_not_configured: 'Claude API 尚未配置',
  claude_auth: 'Claude API 授权失败，需检查专用工作区密钥',
  claude_not_allowed: 'Model Router 不允许本应用使用 Claude 模型，需检查 Router 授权',
  claude_401: 'Claude API 授权失败，需检查专用工作区密钥',
  claude_403: 'Claude API 权限不足，需检查专用工作区权限',
  claude_budget_exhausted: '本月模型预算已用完，待下个月继续',
  claude_spend_limit: 'Anthropic 工作区已达到消费上限，等待额度恢复',
  claude_rate_limit: 'Claude API 请求受限，等待重试',
  claude_quota: 'Claude API 额度暂不可用，等待重试',
  claude_unavailable: 'Claude API 暂不可用，等待重试',
  claude_bad_answer: 'Claude 返回格式无效，本次没有生成分级',
  claude_timeout: 'Claude API 请求超时，等待重试',
  claude_network: 'Claude API 网络请求失败，等待重试',
  claude_http_429: 'Claude API 请求受限，等待重试',
  claude_response_too_large: 'Claude 返回超过大小上限，本次没有生成分级',
  claude_bad_model: 'Claude 返回的模型不符合配置，本次没有生成分级',
  claude_bad_usage: 'Claude 未返回有效用量，本次没有生成分级',
  claude_bad_items: 'Claude 返回的邮件结果不完整，本次没有生成分级',
  claude_incomplete: 'Claude 未完成回答，本次没有生成分级',
  claude_bad_content: 'Claude 返回内容无效，本次没有生成分级',
  claude_bad_json: 'Claude 返回格式无效，本次没有生成分级',
  claude_bad_input: '模型请求内容无效，本次没有生成分级',
}

export function claudeErrorMessage(code: string): string {
  const http = /^claude_http_(\d{3})$/.exec(code)
  if (http !== null && code !== 'claude_http_429') return `Claude API 返回 HTTP ${http[1] as string}，本次没有生成分级`
  return Object.hasOwn(CLAUDE_ERRORS, code) ? CLAUDE_ERRORS[code] as string : `Claude 请求失败（${code}）`
}

/** Older settings and status responses did not carry a provider. */
export function classificationProvider(value: ClassificationProvider | undefined): ClassificationProvider {
  return value === ClassificationProvider.CODEX ? ClassificationProvider.CODEX : ClassificationProvider.CLAUDE
}

export function classificationProviderName(value: ClassificationProvider): string {
  return value === ClassificationProvider.CODEX ? 'VPS Codex' : 'Claude API'
}

const CODEX_ERRORS: Readonly<Record<string, string>> = {
  codex_not_configured: 'VPS Codex 尚未配置',
  codex_auth: 'VPS Codex 授权失败，需检查服务凭据或订阅登录',
  codex_not_allowed: 'Model Router 不允许本应用使用 Codex 模型，需检查 Router 授权',
  codex_rate_limit: 'Codex 请求受限，等待重试',
  codex_quota: 'Codex 订阅额度暂不可用，等待额度恢复',
  codex_unavailable: 'VPS Codex 暂不可用，等待重试',
  codex_timeout: 'VPS Codex 请求超时，等待重试',
  codex_network: 'VPS Codex 网络请求失败，等待重试',
  codex_bad_answer: 'Codex 返回格式无效，本次没有生成分级',
  codex_bad_json: 'Codex 返回格式无效，本次没有生成分级',
  codex_bad_items: 'Codex 返回的邮件结果不完整，本次没有生成分级',
  codex_bad_input: '模型请求内容无效，本次没有生成分级',
  codex_response_too_large: 'Codex 返回超过大小上限，本次没有生成分级',
  codex_bad_model: 'Codex 返回的模型不符合配置，本次没有生成分级',
  codex_bad_usage: 'Codex 未返回有效用量，本次没有生成分级',
}

export function classifierErrorMessage(provider: ClassificationProvider, code: string): string {
  if (provider === ClassificationProvider.CLAUDE) return claudeErrorMessage(code)
  const http = /^codex_http_(\d{3})$/.exec(code)
  if (http !== null) return `VPS Codex 返回 HTTP ${http[1] as string}，本次没有生成分级`
  return Object.hasOwn(CODEX_ERRORS, code) ? CODEX_ERRORS[code] as string : 'VPS Codex 请求失败，待重试；可刷新查看状态'
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

/** Current priority names, a quiet marker for historical labels, and the legacy no-label answer. */
export function labelText(name: string, labels: readonly Label[]): string {
  if (name === '') return '都不是'
  return labels.find((label) => label.name === name)?.displayName ?? '历史分级'
}
