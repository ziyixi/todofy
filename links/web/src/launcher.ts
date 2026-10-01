/**
 * The launcher's pure logic (../../docs/design.md §10): what the search box matches and in which order, what Enter
 * opens, how a typed rest becomes a short-link path, the edit form's values, and how an import file is cut into
 * requests the API accepts. No DOM and no network here (view.ts and api.ts), so every rule is a unit test.
 */
import { timestampDate, timestampFromDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import { Link_PathMode, Link_Visibility, type Link, type LinkSchema } from '@ziyixi/proto/links/ui/v1/link_pb'
import type { MessageInitShape } from '@ziyixi/proto/protobuf'
import { IMPORT_CHARS_MAX, IMPORT_LINES_MAX, KEY_PATTERN, RESERVED_KEYS, TAG_PATTERN, TAGS_MAX } from '../../worker/src/limits.ts'

export function keyOf(link: Link): string {
  return link.name.startsWith('links/') ? link.name.slice('links/'.length) : link.name
}

/** Lower-cases ASCII letters only, as the Worker does with keys. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32))
}

/** Whether `text` may be a new key: the Worker's pattern and not reserved (case-insensitive). */
export function isNewKey(text: string): boolean {
  const key = asciiLower(text)
  return KEY_PATTERN.test(key) && !RESERVED_KEYS.has(key)
}

export function isDeleted(link: Link): boolean {
  return link.deleteTime !== undefined
}

export function isExpired(link: Link, now: number): boolean {
  return link.expireTime !== undefined && timestampDate(link.expireTime).getTime() <= now
}

/** What the search box holds: the key typed first, and the rest of the line (a path to pass through). */
export interface Query {
  readonly key: string
  readonly rest: string
}

/** `gh ziyixi/todofy` is the key `gh` with the rest `ziyixi/todofy`; a `/` also ends the key (`gh/ziyixi`). */
export function parseQuery(text: string): Query {
  const trimmed = text.trim()
  const end = trimmed.search(/[\s/]/)
  if (end === -1) return { key: asciiLower(trimmed), rest: '' }
  return { key: asciiLower(trimmed.slice(0, end)), rest: trimmed.slice(end + 1).trim().replace(/^\/+/, '') }
}

/** The same-origin path that follows a key with a rest: each segment percent-encoded (the Worker decodes it). */
export function shortPath(key: string, rest = ''): string {
  const segments = rest === '' ? [] : rest.split('/').map((segment) => encodeURIComponent(segment))
  return `/${key}${segments.length === 0 ? '' : `/${segments.join('/')}`}`
}

/**
 * The links that match a query, best first: the exact key, then keys that start with it, then keys that contain
 * it, then links whose description, target or tags contain it (case-insensitively); key order within each. An
 * empty query lists every link in key order.
 */
export function rank(links: readonly Link[], text: string): Link[] {
  const query = parseQuery(text)
  if (query.key === '') return [...links].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  const needle = asciiLower(text.trim()).split(/\s+/)[0] ?? ''
  const scored: { link: Link; score: number }[] = []
  for (const link of links) {
    const key = keyOf(link)
    let score: number
    if (key === query.key) score = 0
    else if (key.startsWith(query.key)) score = 1
    else if (key.includes(query.key)) score = 2
    else if ([link.description, link.target, ...link.tags].some((field) => asciiLower(field).includes(needle))) score = 3
    else continue
    scored.push({ link, score })
  }
  return scored.sort((a, b) => a.score - b.score || keyOf(a.link).localeCompare(keyOf(b.link))).map(({ link }) => link)
}

// ---- the edit form ----------------------------------------------------------------------------------------------------

export type ModeName = 'exact' | 'append' | 'template'
export type VisibilityName = 'private' | 'public'

/** The edit form's values, as the inputs hold them. */
export interface FormValues {
  readonly key: string
  readonly target: string
  readonly mode: ModeName
  readonly visibility: VisibilityName
  readonly description: string
  /** Comma- or space-separated. */
  readonly tags: string
  /** A `YYYY-MM-DD` date (the link stops at the end of that day, in this browser's zone), or ''. */
  readonly expire: string
}

const MODE_VALUES: Readonly<Record<ModeName, Link_PathMode>> = { exact: Link_PathMode.EXACT, append: Link_PathMode.APPEND, template: Link_PathMode.TEMPLATE }
const VISIBILITY_VALUES: Readonly<Record<VisibilityName, Link_Visibility>> = { private: Link_Visibility.PRIVATE, public: Link_Visibility.PUBLIC }

function modeName(value: Link_PathMode): ModeName {
  return value === Link_PathMode.APPEND ? 'append' : value === Link_PathMode.TEMPLATE ? 'template' : 'exact'
}

/** The form of a new link, or of an existing one. */
export function formValues(link: Link | null, key = ''): FormValues {
  if (link === null) return { key, target: '', mode: 'exact', visibility: 'private', description: '', tags: '', expire: '' }
  return {
    key: keyOf(link),
    target: link.target,
    mode: modeName(link.pathMode),
    visibility: link.visibility === Link_Visibility.PUBLIC ? 'public' : 'private',
    description: link.description,
    tags: link.tags.join(', '),
    expire: link.expireTime === undefined ? '' : dateInput(link.expireTime),
  }
}

/** The tags typed (comma or space separated), lower-cased; null when they break the Worker's rule. */
export function parseTags(text: string): string[] | null {
  const tags = text.split(/[\s,，]+/).filter(Boolean).map(asciiLower)
  if (tags.length > TAGS_MAX || new Set(tags).size !== tags.length || !tags.every((tag) => TAG_PATTERN.test(tag))) return null
  return tags
}

/** The last day a link resolves, as a date input shows it: the day before its expire_time, in this zone. */
export function dateInput(expire: Timestamp): string {
  const date = new Date(timestampDate(expire).getTime() - 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The expire_time of a date input: the start of the next day in this zone (the link resolves through that date). */
export function expireOf(value: string): Timestamp | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return undefined
  return timestampFromDate(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
}

/** The Link fields the form sets. */
export type LinkFields = MessageInitShape<typeof LinkSchema>

/** The fields of a Link the form sets (the Worker validates the target). Null when the tags break their rule. */
export function linkFields(values: FormValues): LinkFields | null {
  const tags = parseTags(values.tags)
  if (tags === null) return null
  return {
    target: values.target.trim(),
    pathMode: MODE_VALUES[values.mode],
    visibility: VISIBILITY_VALUES[values.visibility],
    description: values.description.trim(),
    tags,
    expireTime: expireOf(values.expire),
  }
}

// ---- import ------------------------------------------------------------------------------------------------------------

/** One ImportLinks request's share of a file: its non-blank lines, and the file line number of each. */
export interface ImportChunk {
  readonly content: string
  readonly lines: readonly number[]
}

/**
 * Cuts a JSON Lines file into requests of at most IMPORT_LINES_MAX lines and IMPORT_CHARS_MAX characters, never
 * splitting a line and leaving blank lines out. A single line longer than the limit is a request of its own (the
 * Worker refuses it). The Worker numbers a request's lines from 1; `lines` maps them back to the file.
 */
export function importChunks(text: string): ImportChunk[] {
  const chunks: ImportChunk[] = []
  let lines: string[] = []
  let numbers: number[] = []
  let chars = 0
  const flush = () => {
    if (lines.length > 0) chunks.push({ content: lines.join('\n'), lines: numbers })
    lines = []
    numbers = []
    chars = 0
  }
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') return
    if (lines.length === IMPORT_LINES_MAX || (lines.length > 0 && chars + line.length + 1 > IMPORT_CHARS_MAX)) flush()
    lines.push(line)
    numbers.push(index + 1)
    chars += line.length + 1
  })
  flush()
  return chunks
}

/** The file name of an export taken at `now`: links-YYYY-MM-DD.jsonl (this zone's date). */
export function exportName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `links-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.jsonl`
}
