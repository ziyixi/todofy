/**
 * The UI's words for the API's values (../../docs/design.md §11): issue dates (calendar days of America/Los_Angeles, so
 * read without a zone), times in the browser's zone, dollars, token counts, and the names of modes, states, review
 * statuses, formats, verdicts, steps, models and topics.
 */
import { Citation_Verdict, Issue_QuietReason, Issue_State, Item_Format, Review, Section, TextScope } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { Source_State } from '@ziyixi/proto/brief/ui/v1/source_pb'
import { Mode } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (n: number) => String(n).padStart(2, '0')

export function ms(time: Timestamp | undefined): number | null {
  return time === undefined ? null : timestampMs(time)
}

/** `issues/2026-10-12` -> `2026-10-12`; '' for another name. */
export function issueDay(name: string): string {
  const day = name.startsWith('issues/') ? name.slice('issues/'.length) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/** An issue's day as the list names it: `10月12日 周一`, with the year when it is not now's year (`2025年…`). */
export function dayText(day: string, now: number): string {
  const [year, month, date] = day.split('-').map(Number)
  if (year === undefined || month === undefined || date === undefined) return day
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()] ?? ''
  const prefix = year === new Date(now).getFullYear() ? '' : `${String(year)}年`
  return `${prefix}${String(month)}月${String(date)}日 ${weekday}`
}

/** `10月12日 06:31`, or `今天 06:31`, in the browser's zone. */
export function when(time: Timestamp | undefined, now: number): string {
  const value = ms(time)
  if (value === null) return '—'
  const date = new Date(value)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === today.toDateString()) return `今天 ${clock}`
  const year = date.getFullYear() === today.getFullYear() ? '' : `${String(date.getFullYear())}年`
  return `${year}${String(date.getMonth() + 1)}月${String(date.getDate())}日 ${clock}`
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

/** US dollars: `$0.82`, `$12.40`, `<$0.01` for a cost under a cent, `$0` for none. */
export function usd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}

/** A budget in whole dollars where it is one: `$40`, `$12.5`. */
export function budget(value: number): string {
  return `$${String(Math.round(value * 100) / 100)}`
}

/** A count with thousands separators: `8,400`. */
export function count(value: number): string {
  return value.toLocaleString('en-US')
}

/** Tokens in at most six characters: `8,400`, `1.6 万`, `32 万`. */
export function tokens(value: number): string {
  if (value < 10_000) return count(value)
  return `${(value / 10_000).toFixed(value < 100_000 ? 1 : 0)} 万`
}

/** A learned weight: `×1.12`, `×1`. */
export function weight(value: number): string {
  return `×${String(Math.round(value * 100) / 100)}`
}

export const MODE_NAMES: Readonly<Record<number, string>> = {
  [Mode.OFF]: '关闭',
  [Mode.ARCHIVE]: '仅归档',
  [Mode.SHADOW]: '影子',
  [Mode.LIVE]: '正式',
}

/** What each mode does, in one line (设置). */
export const MODE_HINTS: Readonly<Record<number, string>> = {
  [Mode.OFF]: '只抓取来源，不调用模型、不生成期刊、不发信',
  [Mode.ARCHIVE]: '生成并归档期刊，不发信',
  [Mode.SHADOW]: '发信，标题带“[影子版]”',
  [Mode.LIVE]: '工作日 06:30、周六 07:30（美西时间）发信',
}

/** Why a day sent its note instead of items (design §11). */
export const QUIET_REASONS: Readonly<Record<number, string>> = {
  [Issue_QuietReason.NO_CANDIDATES]: '没有新的候选',
  [Issue_QuietReason.NOT_SCORED]: '候选未能打分',
  [Issue_QuietReason.NONE_GROUNDED]: '入选条目都未通过核对',
  [Issue_QuietReason.NO_READABLE_THREAD]: '没有可读全文的线索',
  [Issue_QuietReason.BUDGET_SPENT]: '预算已用完',
  [Issue_QuietReason.CALLS_REJECTED]: '调用被拒',
  [Issue_QuietReason.WRITE_FAILED]: '写作未能完成',
}

/** The source line's review status (design §11). */
export const REVIEW_NAMES: Readonly<Record<number, string>> = {
  [Review.PEER_REVIEWED]: '同行评议',
  [Review.PREPRINT]: '预印本（未经同行评议）',
  [Review.INSTITUTION]: '机构发布',
  [Review.COMMENTARY]: '评论',
  [Review.NEWS]: '新闻报道',
  [Review.GOVERNMENT]: '官方发布',
  [Review.DATA]: '数据',
}

/** Whether only an abstract or a feed's summary was read (the source line's 仅摘要). */
export function abstractOnly(scope: TextScope): boolean {
  return scope === TextScope.ABSTRACT || scope === TextScope.FEED_SUMMARY
}

export const FORMAT_NAMES: Readonly<Record<number, string>> = {
  [Item_Format.PROFESSIONAL]: '专业',
  [Item_Format.FAMILIAR]: '熟悉',
  [Item_Format.PLAIN]: '通俗',
  [Item_Format.WORLD_SHORT]: '世界·短',
}

export const SECTION_NAMES: Readonly<Record<number, string>> = {
  [Section.RESEARCH]: '研究前沿',
  [Section.WORLD]: '世界与经济',
  [Section.DEEP_READ]: '深读',
}

/** The entailment log's verdict on a quote (design §8: it only logs), and whether it is a doubt. */
export const VERDICTS: Readonly<Record<number, readonly [string, boolean]>> = {
  [Citation_Verdict.UNSPECIFIED]: ['未检查', false],
  [Citation_Verdict.SUPPORTED]: ['相符', false],
  [Citation_Verdict.OVERSTATED]: ['说过头', true],
  [Citation_Verdict.UNSUPPORTED]: ['不相符', true],
}

/** An issue's state in a few words (the issue's head), and whether it needs the owner's eye. */
export const ISSUE_STATES: Readonly<Record<number, readonly [string, boolean]>> = {
  [Issue_State.BUILDING]: ['制作中', false],
  [Issue_State.READY]: ['已就绪，等待发送', false],
  [Issue_State.SENT]: ['已发送', false],
  [Issue_State.SEND_UNKNOWN]: ['发送结果未知：请查看收件箱，不会重发', true],
  [Issue_State.SEND_REJECTED]: ['Resend 拒收，未发送', true],
  [Issue_State.ARCHIVED]: ['仅归档，未发信', false],
  [Issue_State.FAILED]: ['失败', true],
}

/** Why an issue was only archived (Issue.error_code of STATE_ARCHIVED, design §12). */
export const ARCHIVED_WHY: Readonly<Record<string, string>> = {
  mode_archive: '部署为仅归档模式',
  mode_off: '部署为关闭模式',
  paused: '发信时已暂停',
  mail_not_configured: '发信未配置',
  after_cutoff: '到 12:00 截止时还没做完',
}

/** A source's health (design §3.2), and whether it is a problem. OK has no chip. */
export const SOURCE_STATES: Readonly<Record<number, readonly [string, boolean]>> = {
  [Source_State.OK]: ['正常', false],
  [Source_State.FAILING]: ['失败', true],
  [Source_State.PAUSED]: ['已暂停', true],
  [Source_State.DISABLED]: ['已停用', false],
  [Source_State.STALE]: ['沉寂', true],
  [Source_State.NEW]: ['未抓取', false],
}

/** A poll's failure code (Source.last_error_code) in words; another code shows as it is. */
export function pollError(code: string): string {
  const http = /^http_(\d{3})$/.exec(code)
  if (http !== null) return `HTTP ${http[1] ?? ''}`
  const words: Readonly<Record<string, string>> = { timeout: '超时', network_error: '网络错误', too_large: '内容过大', redirect_refused: '跳转被拒', parse_error: '解析失败', url_refused: '地址被拒' }
  return words[code] ?? code
}

/** An issue's step (StepCost.step, ServiceStatus.current_step). */
const STEPS: Readonly<Record<string, string>> = {
  gate: '初筛',
  pick: '挑选',
  shortlist: '整理',
  read: '读全文',
  write: '写作',
  check: '核对',
  repair: '修复',
  render: '排版',
  entail: '核对日志',
  send: '发送',
  thread: '选线索',
  deep_pick: '深读挑选',
  deep_read: '深读写作',
  deep_repair: '深读修复',
}

export function stepName(step: string): string {
  return STEPS[step] ?? step
}

/** `claude-opus-5-5` -> `Opus 5.5`; another ID as it is. */
export function modelName(model: string): string {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(model)
  if (match === null) return model
  const family = match[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2] ?? ''}${match[3] === undefined ? '' : `.${match[3]}`}`
}

/** The profile's topics (content-config/profile.md) by a short name; another ID shows as it is. */
const TOPICS: Readonly<Record<string, string>> = {
  'geo.seismology': '地震学',
  'geo.earth': '固体地球',
  'geo.ml': '地球物理 ML',
  ai4sci: 'AI for science',
  'llm.architecture': '大模型结构',
  'llm.systems': '训练与推理',
  'llm.agents': '智能体',
  'ir.ranking': '检索与排序',
  'ml.other': '其他机器学习',
  'world.affairs': '国际',
  'world.economy': '经济',
  'world.disaster': '灾害',
}

export function topicName(topic: string): string {
  return TOPICS[topic] ?? topic
}

/** A link's address when it is a web page's (http or https), else null: data text never becomes a script link. */
export function webLink(uri: string): string | null {
  try {
    const url = new URL(uri)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}
