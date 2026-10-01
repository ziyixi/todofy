/**
 * The UI's words for the API's values (Chinese) and its times (the browser's time zone). Pure functions.
 *
 * A failed check is always said as what failed (never as "no change"), and the states the health view groups by come
 * from here: BROKEN, blocked (a bot challenge), robots.txt, rate limited, and "JS quota exhausted today".
 */
import { Change_State, Change_SuppressionReason, Change_TriggerKind, type Change } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { FailureReason, Watch_PauseReason, Watch_State, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb'

const FAILURES: Readonly<Record<number, string>> = {
  [FailureReason.HTTP_ERROR]: '网站返回错误',
  [FailureReason.CHALLENGE_PAGE]: '被拦截（人机验证页面）',
  [FailureReason.WRONG_CONTENT_TYPE]: '内容类型与来源不符',
  [FailureReason.SELECTOR_MISS]: '选择器没有匹配到内容',
  [FailureReason.TOO_SHORT]: '页面内容太短（可能需要 JavaScript）',
  [FailureReason.MOJIBAKE]: '乱码（编码无法识别）',
  [FailureReason.JS_QUOTA_EXHAUSTED]: '今日 JS 配额已用完',
  [FailureReason.ROBOTS_DISALLOWED]: 'robots.txt 不允许抓取',
  [FailureReason.RATE_LIMITED]: '网站要求放慢，稍后再试',
  [FailureReason.TIMEOUT]: '超时（15 秒）',
  [FailureReason.NETWORK_ERROR]: '网络错误',
  [FailureReason.TOO_LARGE]: '页面超过 2 MB',
  [FailureReason.REDIRECT_REFUSED]: '跳转到了不允许的地址',
  [FailureReason.PARSE_ERROR]: '无法解析内容',
  [FailureReason.VALUE_MISSING]: '找不到要监视的数值',
  [FailureReason.BROWSER_UNAVAILABLE]: '浏览器抓取尚未开放',
  [FailureReason.INTERNAL_ERROR]: '检查出错（会逐渐拉长间隔重试）',
}

/** What a failed check says. */
export function failureText(reason: FailureReason, httpStatus = 0): string {
  const text = FAILURES[reason] ?? '检查失败'
  return reason === FailureReason.HTTP_ERROR && httpStatus > 0 ? `${text}（HTTP ${String(httpStatus)}）` : text
}

export const SUPPRESSION: Readonly<Record<number, string>> = {
  [Change_SuppressionReason.BELOW_THRESHOLD]: '变化太小',
  [Change_SuppressionReason.TRIGGER_NOT_MET]: '未满足触发条件',
  [Change_SuppressionReason.FLICKER]: '很快又恢复了（闪变）',
}

export const TRIGGERS: Readonly<Record<number, string>> = {
  [Change_TriggerKind.ANY_CHANGE]: '任何变化',
  [Change_TriggerKind.TEXT_APPEARS]: '出现文字',
  [Change_TriggerKind.TEXT_DISAPPEARS]: '文字消失',
  [Change_TriggerKind.NEW_ITEM]: '新条目',
  [Change_TriggerKind.NUMBER]: '数值',
  [Change_TriggerKind.AVAILABILITY]: '供货状态',
}

export const CHANGE_STATES: Readonly<Record<number, string>> = {
  [Change_State.PENDING_CONFIRMATION]: '待确认',
  [Change_State.CONFIRMED]: '新',
  [Change_State.SUPPRESSED]: '已过滤',
  [Change_State.ACKNOWLEDGED]: '已读',
}

/** A watch's state as a label and a CSS class. */
export function watchState(watch: Pick<Watch, 'state' | 'pauseReason'>): { readonly label: string; readonly tone: 'ok' | 'paused' | 'broken' } {
  if (watch.state === Watch_State.BROKEN) return { label: '失效', tone: 'broken' }
  if (watch.state === Watch_State.PAUSED) return { label: watch.pauseReason === Watch_PauseReason.BROKEN_TOO_LONG ? '失效太久，已暂停' : '已暂停', tone: 'paused' }
  return { label: '正常', tone: 'ok' }
}

/** The group a watch's health belongs to in the health view, or null when it is fine. */
export type HealthGroup = 'broken' | 'blocked' | 'robots' | 'rate_limited' | 'js_quota' | 'failing'

export function healthGroup(watch: Watch): HealthGroup | null {
  const failure = watch.health?.lastFailure ?? FailureReason.UNSPECIFIED
  if (watch.state === Watch_State.BROKEN) return 'broken'
  if (failure === FailureReason.CHALLENGE_PAGE) return 'blocked'
  if (failure === FailureReason.ROBOTS_DISALLOWED) return 'robots'
  if (failure === FailureReason.RATE_LIMITED) return 'rate_limited'
  if (failure === FailureReason.JS_QUOTA_EXHAUSTED) return 'js_quota'
  if (failure !== FailureReason.UNSPECIFIED) return 'failing'
  return null
}

export const HEALTH_GROUPS: Readonly<Record<HealthGroup, string>> = {
  broken: '失效（连续 3 次失败）',
  blocked: '被拦截',
  robots: 'robots.txt 不允许',
  rate_limited: '网站要求放慢',
  js_quota: '今日 JS 配额已用完',
  failing: '最近一次失败',
}

/** Epoch milliseconds of a Timestamp, or null. */
export function ms(timestamp: Timestamp | undefined): number | null {
  return timestamp === undefined ? null : timestampMs(timestamp)
}

const clock = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

/** A time in the browser's zone, `10-01 16:00`. */
export function when(timestamp: Timestamp | undefined): string {
  const at = ms(timestamp)
  return at === null ? '—' : clock.format(at).replace(/\//g, '-')
}

/** A past or future time relative to `now`: `3 分钟前`, `2 小时后`. */
export function relative(timestamp: Timestamp | undefined, now: number): string {
  const at = ms(timestamp)
  if (at === null) return '—'
  const delta = at - now
  const minutes = Math.round(Math.abs(delta) / 60_000)
  const text = minutes < 1 ? '不到 1 分钟' : minutes < 60 ? `${String(minutes)} 分钟` : minutes < 48 * 60 ? `${String(Math.round(minutes / 60))} 小时` : `${String(Math.round(minutes / 1440))} 天`
  return delta < 0 ? `${text}前` : `${text}后`
}

/** The host of a URL, or the text itself. */
export function hostOf(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return uri
  }
}

/** The watch ID of a resource name (`watches/x` or `watches/x/changes/y`). */
export function watchIdOf(name: string): string {
  return name.split('/')[1] ?? ''
}

/** A change's values, `1299 → 999`, or ''. */
export function values(change: Pick<Change, 'previousValue' | 'currentValue'>): string {
  if (change.previousValue === '' && change.currentValue === '') return ''
  return `${change.previousValue === '' ? '（无）' : change.previousValue} → ${change.currentValue === '' ? '（无）' : change.currentValue}`
}

/** Check intervals the UI offers, in minutes, with their labels. */
export const INTERVALS: readonly (readonly [number, string])[] = [
  [60, '每小时'],
  [180, '每 3 小时'],
  [360, '每 6 小时'],
  [720, '每 12 小时'],
  [1440, '每天'],
  [4320, '每 3 天'],
  [10080, '每周'],
]

/** The URL of an add-from-phone link's fragment (`/new#u=<encoded url>`), or ''. The fragment never reaches a server. */
export function sharedUrl(hash: string): string {
  const match = /(?:^#|&)u=([^&]*)/.exec(hash)
  if (match === null) return ''
  try {
    return decodeURIComponent(match[1] ?? '').trim()
  } catch {
    return ''
  }
}
