/**
 * The daily pipeline in workerd (docs/design.md §4–§5, §12): a full day over several alarm slices with real
 * D1 and LabState storage, a fake AI binding and a fake arXiv; cold start (explore deck), seeds and a ranked
 * deck the next day, the neuron cap stopping mid-run and catching up the next UTC day, fetch failures and
 * 304s, and the shed guard with its bound.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Deck, SeedsResponse, StatusResponse, TodayResponse } from '../../src/api-types.ts';
import { USER_AGENT } from '../../src/fetch-arxiv.ts';
import { dayItems, rssFeed } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const T0 = Date.parse('2026-09-30T06:30:00Z');
const DAY = 86_400_000;

describe('a day at cold start', () => {
  it('fetches once, embeds, builds an explore deck with 简介 and stays idle until the next slot', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')), etag: '"day1"' };
    const before = await h.get<TodayResponse>('/api/today');
    expect(before.deck).toBeNull();
    expect(before.cold_start).toBe(true);

    const end = await h.run(T0);
    expect(end).toBeGreaterThan(T0);
    // One feed request with the proper User-Agent; nothing else left the Worker.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url).toBe('https://rss.arxiv.org/rss/cs.IR+cs.CL+cs.LG');
    expect(h.requests[0]?.userAgent).toBe(USER_AGENT);

    const today = await h.get<TodayResponse>('/api/today');
    expect(today.deck).toMatchObject({ deck_id: '2026-09-30', kind: 'explore', total: 20, decided: 0, finished: false });
    expect(today.building).toBeNull();
    expect(today.next_run_at).toBe('2026-10-01T06:30:00Z');

    const deck = await h.get<Deck>('/api/decks/2026-09-30');
    expect(deck.cards).toHaveLength(20);
    // Round-robin over the primary categories, `new` papers only.
    expect(deck.cards.slice(0, 3).map((c) => c.paper.primary_category)).toEqual(['cs.IR', 'cs.CL', 'cs.LG']);
    expect(deck.cards.every((c) => c.paper.announce_type === 'new')).toBe(true);
    expect(deck.cards.every((c) => c.brief === '本文提出一种合成的检索方法。作者在玩具数据集上评估。结果显示召回率有所提升。')).toBe(true);
    expect(deck.cards.every((c) => c.because === null)).toBe(true);
    expect(deck.cards[0]?.paper.abs_url).toMatch(/^https:\/\/arxiv\.org\/abs\/2609\.\d{5}$/);
    expect(deck.state).toMatchObject({ version: 0, next_position: 1, counts: { total: 20, decided: 0 } });

    const calls = await h.aiCalls();
    expect(calls.filter((c) => c.model === '@cf/baai/bge-m3').reduce((n, c) => n + c.count, 0)).toBe(40);
    expect(calls.filter((c) => c.model === '@cf/ibm-granite/granite-4.0-h-micro')).toHaveLength(20);
    const status = await h.get<StatusResponse>('/api/status');
    expect(status.counters.ingested_24h).toBe(40);
    expect(status.counters.neurons_today).toBeGreaterThan(0);
    expect(status.counters.neurons_today).toBeLessThan(100);

    // The same slot again (a duplicate alarm) does nothing: no request, no new deck.
    await h.run(T0 + 60_000);
    expect(h.requests).toHaveLength(1);
    // The next day's slot sends the validators; an unchanged feed is a 304 and makes no deck.
    await h.run(T0 + DAY);
    expect(h.requests[1]?.ifNoneMatch).toBe('"day1"');
    expect((await h.sql<{ n: number }>('SELECT count(*) AS n FROM decks'))[0]?.n).toBe(1);
  });
});

describe('seeds and a ranked deck', () => {
  it('resolves seeds with one API request, then ranks the next day against them', async () => {
    h = await startHarness();
    h.arxiv.atom.set('2601.00042', { title: 'Retrieval seed', abstract: 'We improve search recall with retrieval.' });
    const added = await h.mutate<SeedsResponse>('POST', '/api/seeds', { op_id: op(), ids: ['https://arxiv.org/abs/2601.00042v2', '2601.99999', 'not an id'] });
    expect(added.status).toBe(200);
    expect(added.body.seeds.map((s) => [s.paper_id, s.state])).toEqual(
      expect.arrayContaining([
        ['arxiv:2601.00042', 'pending'],
        ['arxiv:2601.99999', 'pending'],
      ]),
    );
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    await h.run(T0);
    const seeds = await h.get<SeedsResponse>('/api/seeds');
    expect(Object.fromEntries(seeds.seeds.map((s) => [s.paper_id, s.state]))).toEqual({ 'arxiv:2601.00042': 'resolved', 'arxiv:2601.99999': 'not_found' });
    expect(seeds.seeds.find((s) => s.paper_id === 'arxiv:2601.00042')?.title).toBe('Retrieval seed');
    expect(h.requests.filter((r) => r.url.startsWith('https://export.arxiv.org/'))).toHaveLength(1);

    const deck = await h.get<Deck>('/api/decks/2026-09-30');
    expect(deck.kind).toBe('ranked');
    // Retrieval papers first, each explained by the seed.
    expect(deck.cards.slice(0, 5).every((c) => c.paper.title.startsWith('Dense retrieval'))).toBe(true);
    expect(deck.cards[0]?.because).toEqual({ id: 'arxiv:2601.00042', title: 'Retrieval seed' });
    const today = await h.get<TodayResponse>('/api/today');
    expect(today.cold_start).toBe(false);
  });
});

describe('the neuron cap', () => {
  it('stops AI work mid-run and catches up the next UTC day', async () => {
    // 40 texts ≈ 40 × 30 tokens × 1075 / 1e6 ≈ 1.3 neurons per embed batch; a 20-card 简介 set ≈ 20 × 3.7.
    h = await startHarness({ bindings: { LAB_DAILY_NEURONS: '20' } });
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    await h.run(T0);
    const today = await h.get<TodayResponse>('/api/today');
    // The deck is shown with the 简介 written so far; the rest fall back to the abstract.
    expect(today.deck?.deck_id).toBe('2026-09-30');
    expect(today.notice).toBe('cap_hit');
    let deck = await h.get<Deck>('/api/decks/2026-09-30');
    const written = deck.cards.filter((c) => c.brief !== null).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(20);
    const status = await h.get<StatusResponse>('/api/status');
    expect(status.counters.neurons_today).toBeLessThanOrEqual(20);
    const signals = (await h.ops('status')).ok as { signals: { code: string }[] };
    expect(signals.signals.map((s) => s.code)).toContain('neuron_cap_hit');

    // Next UTC day, before the next fetch slot: the missing 简介 are written.
    await h.run(Date.parse('2026-10-01T00:05:00Z'));
    deck = await h.get<Deck>('/api/decks/2026-09-30');
    expect(deck.cards.filter((c) => c.brief !== null).length).toBeGreaterThan(written);
    expect((await h.get<TodayResponse>('/api/today')).notice).toBeNull();
    expect(h.requests).toHaveLength(1);
  });

  it('treats the account allowance error as a stop for the day', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    await h.ai({ fail: 'allowance' });
    await h.run(T0);
    const today = await h.get<TodayResponse>('/api/today');
    expect(today.deck).toBeNull();
    expect(today.notice).toBe('cap_hit');
    expect(today.building).toMatchObject({ day: '2026-09-30', phase: 'cap_hit' });
    // One failed call, then no more AI calls today.
    expect((await h.aiCalls()).length).toBe(1);
    await h.ai({});
    await h.run(Date.parse('2026-10-01T00:05:00Z'));
    expect((await h.get<TodayResponse>('/api/today')).deck?.deck_id).toBe('2026-09-30');
  });
});

describe('fetch failures and the guard', () => {
  it('backs off after a failed fetch and never loops', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 503, body: '' };
    const { next } = await h.step(T0);
    expect(next).toBe(T0 + 5 * 60_000);
    expect((await h.get<TodayResponse>('/api/today')).building).toMatchObject({ phase: 'failed' });
    expect((await h.step(T0 + 5 * 60_000)).next).toBe(T0 + 5 * 60_000 + 30 * 60_000);
    // After the retries, the next day's slot.
    expect((await h.step(T0 + 36 * 60_000)).next).toBe(T0 + DAY);
    expect(h.requests).toHaveLength(3);
  });

  it('defers everything while shed, then catches up past the 48 h bound', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    const until = new Date(Date.now() + 30 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const guard = await h.ops('setGuard', { level: 'shed', reason: 'd1_reads_high', until });
    expect(guard.ok).toMatchObject({ level: 'shed', deferred: ['feed_fetch', 'embed', 'rank', 'brief', 'seed_resolve', 'retention'] });
    await h.step(Date.now());
    expect(h.requests).toHaveLength(0);
    expect((await h.get<TodayResponse>('/api/today')).notice).toBe('paused');
    // Two days later (no fetch for over 48 h since the object started): the pipeline runs despite the shed.
    await h.run(Date.now() + 49 * 3_600_000);
    expect(h.requests).toHaveLength(1);
    expect((await h.sql<{ n: number }>('SELECT count(*) AS n FROM decks WHERE ready_at IS NOT NULL'))[0]?.n).toBe(1);
    // Lifting the guard is immediate.
    expect((await h.ops('setGuard', { level: 'normal', reason: 'ok', until: null })).ok).toMatchObject({ level: 'normal', deferred: [] });
  });
});
