/**
 * The daily pipeline in workerd (docs/design.md §4–§5, §12): a full day over several alarm slices with real
 * D1 and LabState storage, a fake AI binding and a fake arXiv; cold start (explore deck), seeds and a ranked
 * deck the next day, the neuron cap stopping mid-run and catching up the next UTC day, fetch failures and
 * 304s, and the shed guard with its bound.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AnnounceType } from '@ziyixi/proto/lab/ui/v1/paper_pb';
import { DeckKind } from '@ziyixi/proto/lab/ui/v1/deck_pb';
import { BuildPhase, Notice } from '@ziyixi/proto/lab/ui/v1/home_pb';
import { Seed_State } from '@ziyixi/proto/lab/ui/v1/library_pb';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { USER_AGENT } from '../../src/fetch-arxiv.ts';
import { dayItems, rssFeed } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

const DECK = 'decks/2026-09-30';

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

/** A fixed slot for tests that read no real-clock view. */
const T0 = Date.parse('2026-09-30T06:30:00Z');
const DAY = 86_400_000;
/**
 * The owner's views (status, today's notice, the 24 h counters, the neuron ledger of "today") read the real
 * clock, so tests that assert them run the pipeline at the real time; the deck id still comes from the feed.
 */
const now = (): number => Date.now();
// src/config.ts's helpers, restated: the runtime suite type-checks with Node's types, not the Worker's.
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
const iso = (at: number): string => new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const nextFetchSlot = (at: number, hour: number): number => {
  const slot = Date.parse(`${utcDay(at)}T00:00:00Z`) + hour * 3_600_000 + 30 * 60_000;
  return slot > at ? slot : slot + DAY;
};
const nextUtcDay = (at: number, minutes = 5): number => Date.parse(`${utcDay(at + DAY)}T00:00:00Z`) + minutes * 60_000;
/**
 * `at`, or later the same UTC day once today's fetch slot (06:30) has passed: a test that then jumps to
 * nextUtcDay() must not cross a slot, whatever time of day the suite runs (it failed between 00:00 and 06:30).
 */
const afterTodaysSlot = (at: number, hour = 6): number =>
  Math.max(at, Date.parse(`${utcDay(at)}T00:00:00Z`) + hour * 3_600_000 + 31 * 60_000);

describe('a day at cold start', () => {
  it('fetches once, embeds, builds an explore deck with 简介 and stays idle until the next slot', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')), etag: '"day1"' };
    const before = await h.api.getToday({ name: 'today' });
    expect(before.deck).toBeUndefined();
    expect(before.coldStart).toBe(true);

    const start = now();
    const end = await h.run(start);
    expect(end).toBeGreaterThan(start);
    // One feed request with the proper User-Agent; nothing else left the Worker.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url).toBe('https://rss.arxiv.org/rss/cs.IR+cs.CL+cs.LG');
    expect(h.requests[0]?.userAgent).toBe(USER_AGENT);

    const today = await h.api.getToday({ name: 'today' });
    expect(today.deck).toMatchObject({ deck: DECK, kind: DeckKind.EXPLORE, total: 20, decided: 0, finished: false });
    expect(today.building).toBeUndefined();
    expect(today.nextFetchTime === undefined ? undefined : iso(timestampMs(today.nextFetchTime))).toBe(iso(nextFetchSlot(end, 6)));

    const deck = await h.api.getDeck({ name: DECK });
    expect(deck.cards).toHaveLength(20);
    // Round-robin over the primary categories, `new` papers only.
    expect(deck.cards.slice(0, 3).map((c) => c.paper?.primaryCategory)).toEqual(['cs.IR', 'cs.CL', 'cs.LG']);
    expect(deck.cards.every((c) => c.paper?.announceType === AnnounceType.NEW)).toBe(true);
    expect(deck.cards.every((c) => c.brief === '本文提出一种合成的检索方法。作者在玩具数据集上评估。结果显示召回率有所提升。')).toBe(true);
    expect(deck.cards.every((c) => c.because === undefined)).toBe(true);
    expect(deck.cards[0]?.paper?.abstractUri).toMatch(/^https:\/\/arxiv\.org\/abs\/2609\.\d{5}$/);
    expect(deck.state).toMatchObject({ version: 0, nextPosition: 1, counts: { total: 20, decided: 0 } });

    const calls = await h.aiCalls();
    expect(calls.filter((c) => c.model === '@cf/baai/bge-m3').reduce((n, c) => n + c.count, 0)).toBe(40);
    expect(calls.filter((c) => c.model === '@cf/ibm-granite/granite-4.0-h-micro')).toHaveLength(20);
    const status = await h.api.getPipelineStatus({ name: 'pipelineStatus' });
    expect(status.ingestedLastDay).toBe(40);
    expect(status.neuronsToday).toBeGreaterThan(0);
    expect(status.neuronsToday).toBeLessThan(100);

    // The same slot again (a duplicate alarm) does nothing: no request, no new deck.
    await h.run(end + 60_000);
    expect(h.requests).toHaveLength(1);
    // The next day's slot sends the validators; an unchanged feed is a 304 and makes no deck.
    await h.run(nextFetchSlot(end, 6));
    expect(h.requests[1]?.ifNoneMatch).toBe('"day1"');
    expect((await h.sql<{ n: number }>('SELECT count(*) AS n FROM decks'))[0]?.n).toBe(1);
  });
});

describe('seeds and a ranked deck', () => {
  it('resolves seeds with one API request, then ranks the next day against them', async () => {
    h = await startHarness();
    h.arxiv.atom.set('2601.00042', { title: 'Retrieval seed', abstract: 'We improve search recall with retrieval.' });
    const added = await h.api.importSeeds({ inputs: ['https://arxiv.org/abs/2601.00042v2', '2601.99999', 'not an id'], requestId: op() });
    expect(added.seeds.map((s) => [s.paperId, s.state])).toEqual(
      expect.arrayContaining([
        ['arxiv:2601.00042', Seed_State.PENDING],
        ['arxiv:2601.99999', Seed_State.PENDING],
      ]),
    );
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    await h.run(T0);
    const seeds = await h.api.listSeeds({});
    expect(Object.fromEntries(seeds.seeds.map((s) => [s.paperId, s.state]))).toEqual({ 'arxiv:2601.00042': Seed_State.RESOLVED, 'arxiv:2601.99999': Seed_State.NOT_FOUND });
    expect(seeds.seeds.find((s) => s.paperId === 'arxiv:2601.00042')?.title).toBe('Retrieval seed');
    expect(h.requests.filter((r) => r.url.startsWith('https://export.arxiv.org/'))).toHaveLength(1);

    const deck = await h.api.getDeck({ name: DECK });
    expect(deck.kind).toBe(DeckKind.RANKED);
    // Retrieval papers first, each explained by the seed.
    expect(deck.cards.slice(0, 5).every((c) => c.paper?.title.startsWith('Dense retrieval'))).toBe(true);
    expect(deck.cards[0]?.because).toMatchObject({ paperId: 'arxiv:2601.00042', title: 'Retrieval seed' });
    const today = await h.api.getToday({ name: 'today' });
    expect(today.coldStart).toBe(false);
  });
});

describe('the neuron cap', () => {
  it('stops AI work mid-run and catches up the next UTC day', async () => {
    // 40 texts ≈ 40 × 30 tokens × 1075 / 1e6 ≈ 1.3 neurons per embed batch; a 20-card 简介 set ≈ 20 × 3.7.
    h = await startHarness({ bindings: { LAB_DAILY_NEURONS: '20' } });
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    const start = afterTodaysSlot(now());
    await h.run(start);
    const today = await h.api.getToday({ name: 'today' });
    // The deck is shown with the 简介 written so far; the rest fall back to the abstract.
    expect(today.deck?.deck).toBe(DECK);
    expect(today.notice).toBe(Notice.CAP_HIT);
    let deck = await h.api.getDeck({ name: DECK });
    const written = deck.cards.filter((c) => c.brief !== undefined).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(20);
    const status = await h.api.getPipelineStatus({ name: 'pipelineStatus' });
    expect(status.neuronsToday).toBeLessThanOrEqual(20);
    const signals = (await h.ops('status')).ok as { signals: { code: string }[] };
    expect(signals.signals.map((s) => s.code)).toContain('neuron_cap_hit');

    // Next UTC day, before the next fetch slot: the missing 简介 are written.
    await h.run(nextUtcDay(start));
    deck = await h.api.getDeck({ name: DECK });
    expect(deck.cards.filter((c) => c.brief !== undefined).length).toBeGreaterThan(written);
    // No new fetch before the slot; the ledger of the simulated day is its own (the notice follows the real clock).
    expect((await h.api.getToday({ name: 'today' })).deck?.deck).toBe(DECK);
    expect(h.requests).toHaveLength(1);
  });

  it('never lets a cap too small for a day hold back the next one', async () => {
    // One neuron does not pay for a single batch of 50 embeddings: nothing is embedded today.
    h = await startHarness({ bindings: { LAB_DAILY_NEURONS: '1' } });
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    const start = now();
    await h.run(start);
    expect((await h.api.getToday({ name: 'today' })).deck).toBeUndefined();
    // At the next fetch slot the day is ranked with what exists (no vectors: an explore deck), shown with the
    // abstract fallbacks, and the new day's fetch goes out.
    await h.run(nextFetchSlot(start, 6));
    const deck = await h.api.getDeck({ name: DECK });
    expect(deck.kind).toBe(DeckKind.EXPLORE);
    expect(deck.cards).toHaveLength(20);
    expect(deck.cards.every((c) => c.brief === undefined)).toBe(true);
    expect(h.requests).toHaveLength(2);
  });

  it('treats the account allowance error as a stop for the day', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 200, body: rssFeed(dayItems('2609')) };
    await h.ai({ fail: 'allowance' });
    const start = now();
    await h.run(start);
    const today = await h.api.getToday({ name: 'today' });
    expect(today.deck).toBeUndefined();
    expect(today.notice).toBe(Notice.CAP_HIT);
    expect(today.building).toMatchObject({ day: '2026-09-30', phase: BuildPhase.CAP_HIT });
    // One failed call, then no more AI calls today.
    expect((await h.aiCalls()).length).toBe(1);
    await h.ai({});
    await h.run(nextUtcDay(start));
    expect((await h.api.getToday({ name: 'today' })).deck?.deck).toBe(DECK);
  });
});

describe('fetch failures and the guard', () => {
  it('backs off after a failed fetch and never loops', async () => {
    h = await startHarness();
    h.arxiv.feed = { status: 503, body: '' };
    const { next } = await h.step(T0);
    expect(next).toBe(T0 + 5 * 60_000);
    expect((await h.api.getToday({ name: 'today' })).building).toMatchObject({ phase: BuildPhase.FAILED });
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
    expect((await h.api.getToday({ name: 'today' })).notice).toBe(Notice.PAUSED);
    // Two days later (no fetch for over 48 h since the object started): the pipeline runs despite the shed.
    await h.run(Date.now() + 49 * 3_600_000);
    expect(h.requests).toHaveLength(1);
    expect((await h.sql<{ n: number }>('SELECT count(*) AS n FROM decks WHERE ready_at IS NOT NULL'))[0]?.n).toBe(1);
    // Lifting the guard is immediate.
    expect((await h.ops('setGuard', { level: 'normal', reason: 'ok', until: null })).ok).toMatchObject({ level: 'normal', deferred: [] });
  });
});
