/** Synthetic fixtures only (no real paper, person or account data). */
import type { DeckCard, DeckKind, Paper, SendStatus, TodayResponse } from '../../../worker/src/api-types.ts'

export const DAY = '2026-09-30'
export const NOW = new Date('2026-09-30T12:00:00Z')

export function paper(n: number, overrides: Partial<Paper> = {}): Paper {
  const id = `2609.${String(10000 + n)}`
  return {
    id: `arxiv:${id}`,
    version: 1,
    title: `Synthetic Paper ${n}: Ranking Things With Other Things`,
    authors: 'Ada Example, Ben Sample, Cy Placeholder, Dee Fixture',
    categories: ['cs.IR', 'cs.LG'],
    primary_category: 'cs.IR',
    abstract: `We study synthetic problem ${n}. Our method improves a made-up metric. Code is not real. Further details follow here.`,
    announce_type: n % 3 === 0 ? 'cross' : 'new',
    announced_on: DAY,
    abs_url: `https://arxiv.org/abs/${id}`,
    pdf_url: `https://arxiv.org/pdf/${id}`,
    new_version: false,
    ...overrides,
  }
}

export function card(n: number, overrides: Partial<DeckCard> = {}): DeckCard {
  return {
    position: n,
    paper: paper(n),
    brief: `这是第 ${n} 篇合成论文的简介。它提出了一个虚构的方法。结果只用于测试。`,
    because: n === 1 ? null : { id: 'arxiv:2601.00001', title: 'A Seed Paper About Retrieval' },
    ...overrides,
  }
}

export function cards(count: number): DeckCard[] {
  return Array.from({ length: count }, (_, index) => card(index + 1))
}

export function today(overrides: Partial<TodayResponse> = {}, kind: DeckKind = 'ranked', total = 4): TodayResponse {
  return {
    deck: { deck_id: DAY, kind, total, decided: 0, finished: false },
    building: null,
    next_run_at: '2026-10-01T06:30:00Z',
    cold_start: false,
    older_unfinished: [],
    notice: null,
    ...overrides,
  }
}

export function sendStatus(overrides: Partial<SendStatus> = {}): SendStatus {
  return {
    generation: 1,
    intent_id: `deck-${DAY}-g1`,
    mode: 'subtasks',
    state: 'created',
    recorded: true,
    items: 2,
    tasks_total: 3,
    tasks_created: 3,
    error_code: null,
    frozen: true,
    poll_after: null,
    updated_at: '2026-09-30T12:00:00Z',
    ...overrides,
  }
}
