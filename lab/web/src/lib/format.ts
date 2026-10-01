/**
 * Display helpers. Times follow the browser's own time zone (Intl without a timeZone option); deck ids
 * are calendar days and are shown as written, never shifted.
 */
import { SendMode, type Card } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { BuildPhase, Notice } from '@ziyixi/proto/lab/ui/v1/home_pb'
import { paperOf } from './messages'

/** `YYYY-MM-DD`: a deck's day. */
type Day = string

/** "A. Author, B. Author 等 7 人" (the first two names, then the count). */
export function formatAuthors(authors: string): string {
  const names = authors
    .split(/\s*,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} 等 ${names.length} 人`
}

/** "9月29日" from a YYYY-MM-DD day id. */
export function formatDay(day: Day): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return day
  return `${Number(match[2])}月${Number(match[3])}日`
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

const TIME = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/** "今晚 23:30", "今天 09:10", "明天 04:30", "10月2日 04:30", in the browser's time zone. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = TIME.format(at)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (localDayKey(at) === localDayKey(now)) return `${at.getHours() >= 18 ? '今晚' : '今天'} ${time}`
  if (localDayKey(at) === localDayKey(tomorrow)) return `明天 ${time}`
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`
}

/** Saturday or Sunday in the browser's zone: arXiv announces nothing. */
export function isWeekend(now: Date = new Date()): boolean {
  const day = now.getDay()
  return day === 0 || day === 6
}

/** Sentences of an English abstract (a period, ! or ? followed by space). */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)
    .filter((part) => part !== '')
}

/** The card's main text: the 简介, or the abstract's first two sentences when the 简介 is missing. */
export function cardBrief(card: Card): { readonly text: string; readonly generated: boolean } {
  if (card.brief && card.brief.trim() !== '') return { text: card.brief.trim(), generated: true }
  return { text: sentences(paperOf(card).abstractText).slice(0, 2).join(' '), generated: false }
}

/** A short title for snackbars: at most `max` code points with an ellipsis. */
export function shortTitle(title: string, max = 18): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/** The Todoist parent title Lab will create (docs/design.md §9). */
export function parentTitle(day: Day, count: number, generation: number): string {
  return generation > 1 ? `论文雷达 ${day}（补发）· ${count} 篇` : `论文雷达 ${day} · ${count} 篇`
}

/** The live preview under the mode control (docs/ux.md §5). */
export function sendPreview(mode: SendMode, day: Day, count: number, generation = 1): string {
  if (count === 0) return '没有要发送的论文'
  if (mode === SendMode.SUBTASKS) return `将在 Todoist 创建「${parentTitle(day, count, generation)}」和 ${count} 个子任务`
  return `将在 Todoist 创建 ${count} 个任务`
}

/** Each build phase's copy; a phase this build does not know reads as UNSPECIFIED (lenient read) and shows nothing. */
export const PHASES: Readonly<Record<BuildPhase, string>> = {
  [BuildPhase.UNSPECIFIED]: '',
  [BuildPhase.WAITING]: '等待 arXiv 发布',
  [BuildPhase.FETCHING]: '抓取',
  [BuildPhase.EMBEDDING]: '计算向量',
  [BuildPhase.RANKING]: '排序',
  [BuildPhase.SUMMARIZING]: '生成简介',
  [BuildPhase.PAUSED]: '已暂停',
  [BuildPhase.CAP_HIT]: '今日 AI 额度已用完',
  [BuildPhase.FAILED]: '出错，稍后自动重试',
}

export const NOTICES: Readonly<Record<Exclude<Notice, typeof Notice.UNSPECIFIED>, string>> = {
  [Notice.CAP_HIT]: '今日 AI 额度已用完，缺少的简介明天补上；卡片先显示原文摘要节选。',
  [Notice.FEED_STALE]: 'arXiv 源暂时没有更新，今天的论文可能稍晚到。',
  [Notice.PAUSED]: '论文抓取已暂停，可以在设置里恢复。',
}

/** A random UUID v4 for one mutation (its request_id, AIP-155). */
export function newOpId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Only https links on arxiv.org leave the page (the Worker builds them from the ID; this re-checks). */
export function safeArxivUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'arxiv.org' && url.username === '' && url.password === '' ? url.href : null
  } catch {
    return null
  }
}
