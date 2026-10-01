/**
 * Synthetic fixtures only (no real paper, person or account data). Each is written as the Worker sends it, in
 * lab.ui.v1's wire JSON (snake_case, enum names, RFC 3339), and read with the wire profile into the message
 * the UI gets: a fixture that is not a valid answer fails here, not in a view. An override set to undefined
 * leaves the field out (unset).
 */
import { CardSchema, SendSchema, type Card, type Send } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { TodaySchema, type Today } from '@ziyixi/proto/lab/ui/v1/home_pb'
import { LikedPaperSchema, type LikedPaper } from '@ziyixi/proto/lab/ui/v1/library_pb'
import type { DescMessage, MessageShape } from '@ziyixi/proto/protobuf'
import { fromWire } from '@ziyixi/proto/wire-json'

export const DAY = '2026-09-30'
export const NOW = new Date('2026-09-30T12:00:00Z')

type Wire = Readonly<Record<string, unknown>>

/** A wire JSON object read as `schema` (undefined values dropped, as JSON.stringify drops them). */
export function read<Desc extends DescMessage>(schema: Desc, wire: Wire): MessageShape<Desc> {
  return fromWire(schema, JSON.parse(JSON.stringify(wire)), { strict: true }).message
}

export function paperWire(n: number, overrides: Wire = {}): Wire {
  const id = `2609.${String(10000 + n)}`
  return {
    id: `arxiv:${id}`,
    version: 1,
    title: `Synthetic Paper ${n}: Ranking Things With Other Things`,
    authors: 'Ada Example, Ben Sample, Cy Placeholder, Dee Fixture',
    categories: ['cs.IR', 'cs.LG'],
    primary_category: 'cs.IR',
    abstract_text: `We study synthetic problem ${n}. Our method improves a made-up metric. Code is not real. Further details follow here.`,
    announce_type: n % 3 === 0 ? 'cross' : 'new',
    abstract_uri: `https://arxiv.org/abs/${id}`,
    pdf_uri: `https://arxiv.org/pdf/${id}`,
    ...overrides,
  }
}

export function cardWire(n: number, overrides: Wire = {}): Wire {
  return {
    position: n,
    paper: paperWire(n),
    brief: `这是第 ${n} 篇合成论文的简介。它提出了一个虚构的方法。结果只用于测试。`,
    because: n === 1 ? undefined : { paper_id: 'arxiv:2601.00001', title: 'A Seed Paper About Retrieval' },
    ...overrides,
  }
}

export function card(n: number, overrides: Wire = {}): Card {
  return read(CardSchema, cardWire(n, overrides))
}

export function cards(count: number): Card[] {
  return Array.from({ length: count }, (_, index) => card(index + 1))
}

export function likedPaper(n: number, overrides: Wire = {}): LikedPaper {
  return read(LikedPaperSchema, {
    name: `likedPapers/2609.${String(10000 + n)}`,
    paper: paperWire(n),
    brief: `第 ${n} 篇的简介。第二句。`,
    create_time: '2026-09-30T01:00:00Z',
    deck: `decks/${DAY}`,
    ...overrides,
  })
}

export function today(overrides: Wire = {}, kind = 'ranked', total = 4): Today {
  return read(TodaySchema, {
    name: 'today',
    deck: { deck: `decks/${DAY}`, kind, total },
    next_fetch_time: '2026-10-01T06:30:00Z',
    ...overrides,
  })
}

export function sendStatus(overrides: Wire = {}): Send {
  return read(SendSchema, {
    name: `decks/${DAY}/send`,
    generation: 1,
    intent_id: `deck-${DAY}-g1`,
    mode: 'subtasks',
    state: 'created',
    recorded: true,
    item_count: 2,
    tasks_total: 3,
    tasks_created: 3,
    frozen: true,
    update_time: '2026-09-30T12:00:00Z',
    ...overrides,
  })
}
