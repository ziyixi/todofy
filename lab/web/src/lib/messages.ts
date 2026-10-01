/**
 * Small helpers over the lab.ui.v1 messages (proto/lab/ui/v1) the UI reads: a card's paper, timestamps as
 * the ISO strings the formatters take, and the API's Decision against the UI's swipe directions.
 */
import { create } from '@ziyixi/proto/protobuf'
import { timestampDate, type Timestamp } from '@ziyixi/proto/protobuf/wkt'
import type { Card } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { Decision, PaperSchema, type Paper } from '@ziyixi/proto/lab/ui/v1/paper_pb'
import type { Swipe } from './swipe'

const NO_PAPER: Paper = create(PaperSchema)

/** A card's paper (the Worker always sets it; an empty paper keeps a broken answer from crashing a view). */
export function paperOf(card: Card): Paper {
  return card.paper ?? NO_PAPER
}

/** A card's paper ID (`arxiv:<id>`), the key of decisions. */
export function idOf(card: Card): string {
  return paperOf(card).id
}

/** A timestamp as RFC 3339, or null when unset. */
export function isoOf(time: Timestamp | undefined): string | null {
  return time === undefined ? null : timestampDate(time).toISOString()
}

/** The milliseconds of a timestamp, or null when unset. */
export function msOf(time: Timestamp | undefined): number | null {
  return time === undefined ? null : timestampDate(time).getTime()
}

export const DECISION_OF: Readonly<Record<Swipe, Decision>> = { like: Decision.LIKE, dislike: Decision.DISLIKE }

/** The swipe direction of a decision (null for none). */
export function swipeOf(decision: Decision | undefined): Swipe | null {
  if (decision === Decision.LIKE) return 'like'
  if (decision === Decision.DISLIKE) return 'dislike'
  return null
}
