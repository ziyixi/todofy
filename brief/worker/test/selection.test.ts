/**
 * The gate's and the pick's rules (design §5, §6): the gate's strict reader, the order with corroboration recomputed
 * at the cutoff, the refused-candidate fallback (the percentile mapping), the pick's caps and its fallback to the gate
 * order, 还有; and the stale cadence of a source (§3.2).
 */
import { describe, expect, it } from 'vitest';
import { cosine, percentileScore, unit } from '../src/cluster.ts';
import { health } from '../src/health.ts';
import { DAY } from '../src/limits.ts';
import { gateRequest, readGate, readPick, readWrite, type GateCandidate } from '../src/prompts.ts';
import { bundled } from '../src/registry.ts';
import { cutoffOf } from '../src/schedule.ts';
import { fallbackShortlist, moreItems, researchCards, researchOrder, type ResearchCard } from '../src/select.ts';
import { Store, type ItemRow, type SourceRow } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

const { registry, topics } = bundled();
const NOW = Date.parse('2026-10-12T10:30:00Z');

function card(id: string, topic: string, overrides: Partial<ResearchCard> = {}): ResearchCard {
  return { id, rowid: Number(id.slice(1)), key: `k${id}`, section: 'research', topic, venues: ['arXiv'], review: 'preprint', title: id, summary: '', corroboration: '', readable: true, heldBack: null, order: 0, sourceIds: [], listed: false, ...overrides };
}

describe('the gate', () => {
  const group: GateCandidate[] = [
    { id: 'c1', section: 'research', venue: 'arXiv', review: 'preprint', title: 'a', summary: 's', otherVenues: [] },
    { id: 'c2', section: 'world', venue: 'BBC', review: 'news', title: 'b', summary: 's', otherVenues: ['DW'] },
  ];
  it('keeps one cache breakpoint at the end of the frozen system block and reads strictly', () => {
    const { params } = gateRequest(group, topics);
    expect(params.system).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
    expect(params.output_config).toMatchObject({ effort: 'low' });
    expect(JSON.stringify(params.system)).not.toMatch(/2026/);
    const ok = readGate({ scores: [{ id: 'c1', topic: 'geo.seismology', score: 7 }, { id: 'c2', topic: 'world.economy', score: 4 }] }, group, topics);
    expect(ok?.get('c1')).toEqual({ topic: 'geo.seismology', score: 7 });
    expect(readGate({ scores: [{ id: 'c1', topic: 'geo.seismology', score: 7 }] }, group, topics)).toBeNull();
    expect(readGate({ scores: [{ id: 'c1', topic: 'world.economy', score: 7 }, { id: 'c2', topic: 'world.economy', score: 4 }] }, group, topics)).toBeNull();
    expect(readGate({ scores: [{ id: 'c1', topic: 'geo.seismology', score: 11 }, { id: 'c2', topic: 'world.economy', score: 4 }] }, group, topics)).toBeNull();
    expect(readGate({ scores: [{ id: 'c9', topic: 'geo.seismology', score: 1 }, { id: 'c2', topic: 'world.economy', score: 4 }] }, group, topics)).toBeNull();
  });

  it('scores a refused candidate at its similarity percentile among the day scored ones', () => {
    const scored = [0.1, 0.2, 0.3, 0.4, 0.5].map((similarity, i) => ({ similarity, score: [3, 5, 6, 8, 9][i] ?? 0 }));
    expect(percentileScore(0.45, scored)).toBe(8);
    expect(percentileScore(0.05, scored)).toBe(3);
    expect(percentileScore(0.9, scored)).toBe(9);
    expect(percentileScore(0.3, [])).toBeNull();
    expect(cosine(unit(Float32Array.from([1, 2, 3])), Float32Array.from([2, 4, 6]))).toBeCloseTo(1, 6);
  });
});

describe('the order at the cutoff', () => {
  function item(overrides: Partial<ItemRow>): ItemRow {
    return { rowid: 1, key: 'arxiv:2410.00001', section: 'research', title: 't', summary: '', body: null, link: '', doi: null, arxiv: '2410.00001', published_ms: null, fetched_ms: NOW, sources: '["arxiv-llm-agents"]', candidate: 1, text_tier: 'page_full', upvotes: 0, upvote_pct: 0, mentions: '[]', cluster: null, gate: 'scored', gate_day: null, topic: 'llm.agents', score: 7, embedded: 1, ran: null, listed: null, ...overrides };
  }
  const weights = { sources: new Map<string, number>(), topics: new Map<string, number>() };
  it('adds corroboration: independent sources, a mention, the upvote percentile (capped at 3)', () => {
    expect(researchOrder(item({}), registry, weights)).toEqual({ order: 7, corroboration: '单一来源' });
    const corroborated = researchOrder(item({ sources: '["arxiv-llm-agents","arxiv-llm-architecture","hf-daily-papers"]', mentions: '[{"s":"import-ai","i":9}]', upvote_pct: 0.9 }), registry, weights);
    // Two independent names (arXiv twice is one): 0.75; a mention: 1; upvotes 1.5 x 0.9 = 1.35; capped at 3.
    expect(corroborated.order).toBeCloseTo(10, 6);
    expect(corroborated.corroboration).toBe('2 个独立来源；Import AI 链接；Hugging Face 当日前 10%');
    const weighted = researchOrder(item({}), registry, { sources: new Map([['arxiv-llm-agents', 1.2]]), topics: new Map([['llm.agents', 0.6]]) });
    expect(weighted.order).toBeCloseTo(7 * 1.2 * 0.6, 6);
  });
});

describe('the pick and its fallback', () => {
  const research: ResearchCard[] = [card('r1', 'llm.agents'), card('r2', 'llm.agents'), card('r3', 'llm.agents'), card('r4', 'geo.seismology'), card('r5', 'geo.ml'), card('r6', 'geo.seismology'), card('r7', 'ai4sci'), card('r8', 'ir.ranking'), card('r9', 'llm.systems'), card('r10', 'ml.other')];
  const world = [{ id: 'w1', score: 8 }, { id: 'w2', score: 6 }, { id: 'w3', score: 7 }, { id: 'w4', score: 9 }].map((w) => (({ ...card(w.id, 'world.affairs'), section: 'world' as const, score: w.score, members: [], signals: [], cluster: null })));

  it('keeps card IDs only, at most 3 world and 8 research with 2 per topic, 8 in all, in the pick order', () => {
    const picked = readPick(
      {
        research: [{ id: 'r1', reason: '一'.repeat(80) }, { id: 'r2', reason: 'b' }, { id: 'r3', reason: 'third agent paper' }, { id: 'x9', reason: 'unknown' }, ...research.slice(3).map((c) => ({ id: c.id, reason: 'r' }))],
        world: [{ id: 'w4', reason: 'a' }, { id: 'w1', reason: 'b' }, { id: 'w2', reason: 'c' }, { id: 'w3', reason: 'd' }],
      },
      research,
      world,
    );
    // Three world stories leave five research items.
    expect(picked?.research.map((p) => p.id)).toEqual(['r1', 'r2', 'r4', 'r5', 'r6']);
    expect(picked?.research[0]?.reason).toHaveLength(60);
    expect(picked?.world.map((p) => p.id)).toEqual(['w4', 'w1', 'w2']);
    const noWorld = readPick({ research: research.map((c) => ({ id: c.id, reason: 'r' })), world: [] }, research, world);
    expect(noWorld?.research.map((p) => p.id)).toEqual(['r1', 'r2', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(readPick({ research: 'no' }, research, [])).toBeNull();
  });

  it('falls back to the gate order: 3 world with score 7 or more, research to 8 in all, each topic once first', () => {
    const shortlist = fallbackShortlist(research, world);
    expect(shortlist.world.map((p) => p.id)).toEqual(['w1', 'w3', 'w4']);
    expect(shortlist.research.map((p) => p.id)).toEqual(['r1', 'r4', 'r5', 'r7', 'r8']);
    // Without world stories: every topic's best first (seven topics), then the best second one, in gate order.
    expect(fallbackShortlist(research, []).research.map((p) => p.id)).toEqual(['r1', 'r2', 'r4', 'r5', 'r7', 'r8', 'r9', 'r10']);
  });

  it('lists 还有 from the 专业 topics the pick did not take, never an item an earlier 还有 listed', () => {
    expect(moreItems(research, new Set(['r4']), topics).map((c) => c.id)).toEqual(['r5', 'r6']);
    const listed = research.map((c) => (c.id === 'r5' ? { ...c, listed: true } : c));
    expect(moreItems(listed, new Set(['r4']), topics).map((c) => c.id)).toEqual(['r6']);
  });

  it('reads the writer answer strictly: known packets, one item each', () => {
    const packets = [{ id: 'p1', section: 'research' as const, topic: 'geo.seismology', format: 'professional' as const, documents: [], signals: [], heldBack: null }];
    const answer = { items: [{ packet: 'p1', section: 'research', title: '标题', paragraphs: [{ heading: '', text: '正文[1]。' }], why: '一句', claims: [{ n: 1, doc: 'd1', quote: 'a quote of twenty characters' }] }], omitted: [{ packet: 'p9', code: 'weak' }] };
    expect(readWrite(answer, packets)?.items).toHaveLength(1);
    expect(readWrite(answer, packets)?.omitted).toEqual([]);
    expect(readWrite({ ...answer, items: [...answer.items, ...answer.items] }, packets)).toBeNull();
    expect(readWrite({ items: [{ ...answer.items[0], packet: 'p7' }], omitted: [] }, packets)).toBeNull();
    // A weekday item has no headings (its rules leave them empty): one the writer sent anyway is dropped unread.
    const headed = { ...answer, items: [{ ...answer.items[0], paragraphs: [{ heading: '裁员 3 万人', text: '正文[1]。' }] }] };
    expect(readWrite(headed, packets)?.items[0]?.paragraphs).toEqual([{ heading: '', text: '正文[1]。' }]);
  });
});

describe('the cards at the cutoff', () => {
  it('keeps every topic best cards first: corroborated ML papers never crowd the owner own field out', () => {
    const store = new Store(memorySql());
    store.migrate();
    const cutoff = cutoffOf('2026-10-12');
    let n = 0;
    const add = (topic: string, sources: string[], score: number, upvotes: number, day: number): void => {
      n++;
      store.insert('items', { key: `url:https://synthetic.example.org/${String(n)}`, section: 'research', title: `${topic} ${String(n)}`, link: `https://synthetic.example.org/${String(n)}`, fetched_ms: cutoff - (day + 0.5) * DAY, sources: JSON.stringify(sources), candidate: 1, text_tier: 'page_full', gate: 'scored', topic, score, upvote_pct: upvotes });
    };
    for (let day = 0; day < 6; day++) {
      for (const topic of ['llm.architecture', 'llm.systems', 'llm.agents']) for (let i = 0; i < 6; i++) add(topic, ['arxiv-llm-agents', 'hf-daily-papers'], 8, 0.5, day);
      for (let i = 0; i < 3; i++) add('ai4sci', ['arxiv-ai-for-science', 'hf-daily-papers'], 8, 0.5, day);
      for (let i = 0; i < 3; i++) add('geo.seismology', ['gji'], 9, 0, day);
      for (let i = 0; i < 2; i++) add('geo.earth', ['jgr-solid-earth'], 9, 0, day);
      add('geo.ml', ['jgr-machine-learning-computation'], 9, 0, day);
    }
    const weights = { sources: new Map<string, number>(), topics: new Map<string, number>() };
    const cards = researchCards(store, registry, weights, '2026-10-12', topics);
    const count = (topic: string) => cards.filter((c) => c.topic === topic).length;
    expect(cards).toHaveLength(40);
    // The 专业 topics keep 5 each, the others 3; then the rest fills by order, at most 10 a topic.
    expect(count('geo.seismology')).toBe(5);
    expect(count('geo.ml')).toBe(5);
    expect(count('geo.earth')).toBe(3);
    for (const topic of ['llm.architecture', 'llm.systems', 'llm.agents', 'ai4sci']) expect(count(topic)).toBeLessThanOrEqual(10);
    // Best first, and on a tie the newer item first.
    expect(cards.map((c) => c.order)).toEqual([...cards.map((c) => c.order)].sort((a, b) => b - a));
    const seismology = cards.filter((c) => c.topic === 'geo.seismology').map((c) => c.rowid);
    expect(seismology).toEqual([...seismology].sort((a, b) => b - a));
    // The deep read's week: every topic's best 2 (a 专业 topic's 3) first.
    const deep = researchCards(store, registry, weights, '2026-10-12', topics, { deep: true });
    expect(deep.filter((c) => c.topic === 'geo.seismology')).toHaveLength(3);
    expect(deep.filter((c) => c.topic === 'geo.earth')).toHaveLength(2);
  });
});

describe('a source health', () => {
  const source = registry.byId.get('gji');
  const row = (accepts: number[], overrides: Partial<SourceRow> = {}): SourceRow => ({ id: 'gji', state: 'ok', failures: 0, last_error: '', last_attempt_ms: NOW, last_success_ms: NOW, last_round: '', etag: null, last_modified: null, seen: '', accepts: JSON.stringify(accepts), last_item_title: '', last_item_ms: accepts[accepts.length - 1] ?? null, page: 0, first_ms: NOW - 50 * DAY, tries: '{}', ...overrides });
  it('is stale past 3 times its usual gap (at least 7 days; 30 days when sparse)', () => {
    if (source === undefined) throw new Error('no gji');
    const daily = Array.from({ length: 20 }, (_, i) => NOW - (30 - i) * DAY);
    // Last accepted 11 days ago, usual gap one day: stale (past 7 days).
    expect(health(source, row(daily), NOW).state).toBe('stale');
    expect(health(source, row(daily.map((ms) => ms + 6 * DAY)), NOW).state).toBe('ok');
    // Sparse: 3 items in 60 days, the last 20 days ago: not yet 30.
    expect(health(source, row([NOW - 50 * DAY, NOW - 35 * DAY, NOW - 20 * DAY]), NOW).state).toBe('ok');
    expect(health(source, row([NOW - 50 * DAY, NOW - 45 * DAY, NOW - 40 * DAY]), NOW).state).toBe('stale');
    expect(health(source, row(daily, { state: 'paused' }), NOW).state).toBe('paused');
    expect(health(source, undefined, NOW).state).toBe('new');
    expect(health(source, row(daily), NOW).usualGapMs).toBe(DAY);
  });
});
