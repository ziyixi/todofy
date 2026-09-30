import {
  CalendarClock,
  CloudUpload,
  Database,
  FlaskConical,
  Gauge,
  Globe,
  Link,
  ListChecks,
  Lock,
  Mail,
  Newspaper,
  NotebookPen,
  Server,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { Accent, IconKey, Level } from '../../../worker/src/api-v2-types.ts'
import { LEVEL, type Tone } from '../lib/labels'

/** The closed icon set of the registry (bundled lucide strokes, never fetched). */
const ENTRY_ICONS: Readonly<Record<IconKey, LucideIcon>> = {
  mail: Mail,
  'list-checks': ListChecks,
  'calendar-clock': CalendarClock,
  'notebook-pen': NotebookPen,
  'flask-conical': FlaskConical,
  globe: Globe,
  'upload-cloud': CloudUpload,
  newspaper: Newspaper,
  gauge: Gauge,
  server: Server,
  database: Database,
  link: Link,
}

/** An entry's icon on its accent chip (sized by CSS); unknown keys fall back to a plain link icon. */
export function EntryIcon({ icon, accent, small = false }: { icon: IconKey; accent: Accent; small?: boolean }) {
  const Icon = Object.hasOwn(ENTRY_ICONS, icon) ? ENTRY_ICONS[icon] : Link
  return (
    <span className={`icon-chip${small ? ' icon-chip-small' : ''} accent-${accent}`} aria-hidden="true">
      <Icon strokeWidth={2} />
    </span>
  )
}

/** The Access lock: informational, with its own accessible name (never an emoji). */
export function AccessLock({ size = 14 }: { size?: number }) {
  return (
    <span className="access-lock" role="img" aria-label="受 Access 保护" title="受 Access 保护">
      <Lock size={size} aria-hidden="true" />
    </span>
  )
}

export type Shape = 'circle' | 'bars' | 'triangle' | 'square' | 'diamond' | 'ring' | 'none'

const LEVEL_SHAPE: Readonly<Record<Level, Shape>> = {
  ok: 'circle',
  held: 'bars',
  warning: 'triangle',
  critical: 'square',
  unknown: 'diamond',
  unmonitored: 'ring',
  link: 'none',
}

const TONE_SHAPE: Readonly<Record<Tone, Shape>> = {
  ok: 'circle',
  warn: 'triangle',
  danger: 'square',
  info: 'bars',
  neutral: 'diamond',
}

/** The shape half of a status mark (● ‖ ▲ ■ ◆ ○). Decorative: the word next to it carries the meaning. */
export function Mark({ shape, tone, size = 11 }: { shape: Shape; tone: Tone; size?: number }) {
  if (shape === 'none') return null
  return (
    <svg className={`mark mark-${tone}`} width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {shape === 'circle' ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {shape === 'ring' ? <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
      {shape === 'triangle' ? <path d="M6 1.2 11.2 10.6H.8z" fill="currentColor" /> : null}
      {shape === 'square' ? <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="currentColor" /> : null}
      {shape === 'diamond' ? <path d="M6 .8 11.2 6 6 11.2.8 6z" fill="currentColor" /> : null}
      {shape === 'bars' ? (
        <>
          <rect x="2.5" y="1.5" width="2.6" height="9" rx=".6" fill="currentColor" />
          <rect x="6.9" y="1.5" width="2.6" height="9" rx=".6" fill="currentColor" />
        </>
      ) : null}
    </svg>
  )
}

export function toneShape(tone: Tone): Shape {
  return TONE_SHAPE[tone]
}

/** A level as shape + word, e.g. "▲ 需关注". `word` overrides the default word (e.g. 部分接入). */
export function LevelMark({
  level,
  word,
  size = 11,
  className = '',
  children,
}: {
  level: Level
  word?: string
  size?: number
  className?: string
  children?: ReactNode
}) {
  const info = LEVEL[level]
  return (
    <span className={`level level-${info.tone} ${className}`}>
      <Mark shape={LEVEL_SHAPE[level]} tone={info.tone} size={size} />
      <span className="level-word">{word ?? info.word}</span>
      {children}
    </span>
  )
}

/** Just the shape of a level. */
export function LevelShape({ level, size = 11 }: { level: Level; size?: number }) {
  return <Mark shape={LEVEL_SHAPE[level]} tone={LEVEL[level].tone} size={size} />
}
